use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use ignore::{DirEntry, WalkBuilder};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub parent: Option<String>,
    pub is_dir: bool,
    pub depth: usize,
    pub size: u64,
    pub modified_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line_number: usize,
    pub line_text: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("path is outside the workspace")]
    OutsideWorkspace,
    #[error("path contains unsupported components")]
    InvalidPath,
    #[error("file is too large to open in the editor")]
    FileTooLarge,
    #[error("file already exists")]
    FileAlreadyExists,
    #[error("path is not a file")]
    NotAFile,
    #[error("path is not a file or directory")]
    NotAnEntry,
    #[error("symbolic links are not supported for editor file operations")]
    SymlinkUnsupported,
    #[error("file changed on disk since it was opened")]
    FileModifiedExternally,
    #[error("search query is too long")]
    SearchQueryTooLong,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("walk error: {0}")]
    Walk(#[from] ignore::Error),
}

const MAX_OPEN_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SEARCH_QUERY_CHARS: usize = 128;
const MAX_SEARCH_FILE_BYTES: u64 = 1_000_000;

pub fn scan_workspace(
    root: &Path,
    max_entries: usize,
    show_dotfiles: bool,
    show_generated_internal: bool,
) -> Result<Vec<FileEntry>, WorkspaceError> {
    let mut entries = Vec::new();
    let mut seen_paths = HashSet::new();

    let mut root_level_walker = workspace_walker(root, show_dotfiles, show_generated_internal);
    root_level_walker.max_depth(Some(1));
    for result in root_level_walker.build() {
        if entries.len() >= max_entries {
            break;
        }

        let entry = result?;
        push_scan_entry(root, &entry, &mut entries, &mut seen_paths)?;
    }

    let walker = workspace_walker(root, show_dotfiles, show_generated_internal).build();
    for result in walker {
        if entries.len() >= max_entries {
            break;
        }

        let entry = result?;
        push_scan_entry(root, &entry, &mut entries, &mut seen_paths)?;
    }

    entries.sort_by(|a, b| {
        a.path
            .to_lowercase()
            .cmp(&b.path.to_lowercase())
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(entries)
}

pub fn workspace_file_entry(root: &Path, relative: &str) -> Result<FileEntry, WorkspaceError> {
    let path = resolve_existing_workspace_file_path(root, relative)?;
    let metadata = fs::symlink_metadata(&path)?;
    let relative_path = Path::new(relative);
    file_entry_from_relative(relative_path, metadata)
}

fn push_scan_entry(
    root: &Path,
    entry: &DirEntry,
    entries: &mut Vec<FileEntry>,
    seen_paths: &mut HashSet<String>,
) -> Result<(), WorkspaceError> {
    let path = entry.path();
    if path == root {
        return Ok(());
    }

    let metadata = fs::symlink_metadata(path)?;

    let relative = path
        .strip_prefix(root)
        .map_err(|_| WorkspaceError::OutsideWorkspace)?;
    let relative_path = normalize_path(relative);
    if !seen_paths.insert(relative_path.clone()) {
        return Ok(());
    }

    entries.push(file_entry_from_relative(relative, metadata)?);
    Ok(())
}

fn file_entry_from_relative(
    relative: &Path,
    metadata: fs::Metadata,
) -> Result<FileEntry, WorkspaceError> {
    let relative_path = normalize_path(relative);
    let parent = relative
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .map(normalize_path);
    let depth = relative.components().count().saturating_sub(1);
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());

    let name = relative
        .file_name()
        .ok_or(WorkspaceError::InvalidPath)?
        .to_string_lossy()
        .to_string();

    Ok(FileEntry {
        path: relative_path,
        name,
        parent,
        is_dir: metadata.is_dir(),
        depth,
        size: metadata.len(),
        modified_ms,
    })
}

pub fn search_workspace(
    root: &Path,
    query: &str,
    max_results: usize,
) -> Result<Vec<SearchMatch>, WorkspaceError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if query.chars().count() > MAX_SEARCH_QUERY_CHARS {
        return Err(WorkspaceError::SearchQueryTooLong);
    }

    let normalized_query = query.to_lowercase();
    let mut matches = Vec::new();
    let walker = workspace_walker(root, false, false).build();

    for result in walker {
        if matches.len() >= max_results {
            break;
        }

        let entry = result?;
        let path = entry.path();
        if path == root {
            continue;
        }

        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() || metadata.len() > MAX_SEARCH_FILE_BYTES || is_known_binary_path(path)
        {
            continue;
        }

        let bytes = fs::read(path)?;
        if bytes.contains(&0) {
            continue;
        }

        let contents = String::from_utf8_lossy(&bytes);
        for (index, line) in contents.lines().enumerate() {
            if matches.len() >= max_results {
                break;
            }

            let Some(match_start) = case_insensitive_match_start_byte(line, &normalized_query)
            else {
                continue;
            };
            let match_start = utf16_offset_for_byte_index(line, match_start);
            let match_end = match_start + utf16_len(query);

            let relative = path
                .strip_prefix(root)
                .map_err(|_| WorkspaceError::OutsideWorkspace)?;
            matches.push(SearchMatch {
                path: normalize_path(relative),
                line_number: index + 1,
                line_text: line.trim_end().to_string(),
                match_start,
                match_end,
            });
        }
    }

    Ok(matches)
}

pub fn read_workspace_file(root: &Path, relative: &str) -> Result<String, WorkspaceError> {
    let path = resolve_existing_workspace_file_path(root, relative)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() > MAX_OPEN_BYTES {
        return Err(WorkspaceError::FileTooLarge);
    }

    fs::read_to_string(path).map_err(WorkspaceError::from)
}

pub fn write_workspace_file(
    root: &Path,
    relative: &str,
    contents: &str,
    expected_modified_ms: Option<u128>,
) -> Result<(), WorkspaceError> {
    let path = resolve_existing_workspace_file_path(root, relative)?;
    if let Some(expected_modified_ms) = expected_modified_ms {
        let current_modified_ms = fs::metadata(&path)?
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .ok_or(WorkspaceError::FileModifiedExternally)?;
        if current_modified_ms != expected_modified_ms {
            return Err(WorkspaceError::FileModifiedExternally);
        }
    }

    fs::write(path, contents).map_err(WorkspaceError::from)
}

pub fn create_workspace_file(root: &Path, relative: &str) -> Result<(), WorkspaceError> {
    let path = resolve_new_workspace_file_path(root, relative)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path);

    match file {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(WorkspaceError::FileAlreadyExists)
        }
        Err(error) => Err(WorkspaceError::Io(error)),
    }
}

pub fn create_workspace_folder(root: &Path, relative: &str) -> Result<(), WorkspaceError> {
    let path = resolve_new_workspace_entry_path(root, relative)?;
    match fs::create_dir_all(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(WorkspaceError::FileAlreadyExists)
        }
        Err(error) => Err(WorkspaceError::Io(error)),
    }
}

pub fn rename_workspace_file(root: &Path, from: &str, to: &str) -> Result<(), WorkspaceError> {
    let from_path = resolve_existing_workspace_entry_path(root, from)?;
    let to_path = resolve_workspace_path(root, to)?;
    if to_path.exists() {
        return Err(WorkspaceError::FileAlreadyExists);
    }

    fs::rename(from_path, to_path).map_err(WorkspaceError::from)
}

pub fn delete_workspace_file(root: &Path, relative: &str) -> Result<(), WorkspaceError> {
    let path = resolve_existing_workspace_entry_path(root, relative)?;

    if path.is_dir() {
        fs::remove_dir_all(path).map_err(WorkspaceError::from)
    } else {
        fs::remove_file(path).map_err(WorkspaceError::from)
    }
}

fn workspace_walker(
    root: &Path,
    show_dotfiles: bool,
    show_generated_internal: bool,
) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .filter_entry(move |entry| {
            if is_generated_name(entry.file_name()) {
                return show_generated_internal;
            }
            show_dotfiles || !is_dot_name(entry.file_name())
        });
    builder
}

fn is_dot_name(name: &OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

fn is_generated_name(name: &OsStr) -> bool {
    matches!(
        name.to_string_lossy().as_ref(),
        ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".turbo" | ".tauri"
    )
}

fn is_known_binary_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some(
            "7z" | "aac"
                | "aiff"
                | "app"
                | "avi"
                | "bin"
                | "bmp"
                | "bz2"
                | "class"
                | "dmg"
                | "dll"
                | "dylib"
                | "eot"
                | "exe"
                | "flac"
                | "gif"
                | "gz"
                | "heic"
                | "icns"
                | "ico"
                | "iso"
                | "jar"
                | "jpeg"
                | "jpg"
                | "mov"
                | "mp3"
                | "mp4"
                | "ogg"
                | "otf"
                | "pdf"
                | "png"
                | "rar"
                | "so"
                | "sqlite"
                | "sqlite3"
                | "tar"
                | "tgz"
                | "tiff"
                | "ttf"
                | "wasm"
                | "wav"
                | "webm"
                | "webp"
                | "woff"
                | "woff2"
                | "xz"
                | "zip"
        )
    )
}

fn utf16_offset_for_byte_index(value: &str, byte_index: usize) -> usize {
    value
        .char_indices()
        .take_while(|(index, _)| *index < byte_index)
        .map(|(_, character)| character.len_utf16())
        .sum()
}

fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

fn case_insensitive_match_start_byte(line: &str, normalized_query: &str) -> Option<usize> {
    if normalized_query.is_empty() {
        return Some(0);
    }

    for byte_start in line
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(line.len()))
    {
        if line[byte_start..]
            .to_lowercase()
            .starts_with(normalized_query)
        {
            return Some(byte_start);
        }
    }

    None
}

fn resolve_workspace_path(root: &Path, relative: &str) -> Result<PathBuf, WorkspaceError> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute() {
        return Err(WorkspaceError::OutsideWorkspace);
    }

    if relative_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    }) {
        return Err(WorkspaceError::InvalidPath);
    }

    let root = root.canonicalize()?;
    let candidate = root.join(relative_path);
    let parent = candidate
        .parent()
        .ok_or(WorkspaceError::InvalidPath)?
        .canonicalize()?;

    if !parent.starts_with(&root) {
        return Err(WorkspaceError::OutsideWorkspace);
    }

    Ok(candidate)
}

fn resolve_new_workspace_file_path(root: &Path, relative: &str) -> Result<PathBuf, WorkspaceError> {
    resolve_new_workspace_entry_path(root, relative)
}

fn resolve_new_workspace_entry_path(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, WorkspaceError> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute() {
        return Err(WorkspaceError::OutsideWorkspace);
    }

    if relative_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    }) {
        return Err(WorkspaceError::InvalidPath);
    }

    if relative_path.file_name().is_none() {
        return Err(WorkspaceError::InvalidPath);
    }

    let root = root.canonicalize()?;
    let candidate = root.join(relative_path);
    let parent = candidate.parent().ok_or(WorkspaceError::InvalidPath)?;
    let existing_ancestor = nearest_existing_ancestor(parent)?;
    let ancestor_metadata = fs::symlink_metadata(&existing_ancestor)?;
    if ancestor_metadata.file_type().is_symlink() {
        return Err(WorkspaceError::SymlinkUnsupported);
    }
    if !ancestor_metadata.is_dir() {
        return Err(WorkspaceError::NotAnEntry);
    }
    let canonical_ancestor = existing_ancestor.canonicalize()?;
    if !canonical_ancestor.starts_with(&root) {
        return Err(WorkspaceError::OutsideWorkspace);
    }

    if candidate.exists() {
        return Err(WorkspaceError::FileAlreadyExists);
    }

    Ok(candidate)
}

fn nearest_existing_ancestor(path: &Path) -> Result<PathBuf, WorkspaceError> {
    let mut current = path;
    loop {
        if current.exists() {
            return Ok(current.to_path_buf());
        }
        current = current.parent().ok_or(WorkspaceError::InvalidPath)?;
    }
}

fn resolve_existing_workspace_file_path(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, WorkspaceError> {
    let path = resolve_workspace_path(root, relative)?;
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() {
        return Err(WorkspaceError::SymlinkUnsupported);
    }
    if !metadata.is_file() {
        return Err(WorkspaceError::NotAFile);
    }

    let root = root.canonicalize()?;
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(&root) {
        return Err(WorkspaceError::OutsideWorkspace);
    }

    Ok(canonical)
}

fn resolve_existing_workspace_entry_path(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, WorkspaceError> {
    let path = resolve_workspace_path(root, relative)?;
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() {
        return Err(WorkspaceError::SymlinkUnsupported);
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(WorkspaceError::NotAnEntry);
    }

    let root = root.canonicalize()?;
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(&root) {
        return Err(WorkspaceError::OutsideWorkspace);
    }

    Ok(canonical)
}

fn normalize_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    #[test]
    fn read_workspace_file_rejects_parent_traversal() {
        let dir = tempdir().unwrap();
        let result = read_workspace_file(dir.path(), "../secret.txt");

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
    }

    #[test]
    fn read_workspace_file_rejects_absolute_paths() {
        let dir = tempdir().unwrap();
        let result = read_workspace_file(dir.path(), "/etc/hosts");

        assert!(matches!(result, Err(WorkspaceError::OutsideWorkspace)));
    }

    #[test]
    fn read_and_write_workspace_file_stays_inside_root() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "before").unwrap();

        let before = read_workspace_file(dir.path(), "note.txt").unwrap();
        write_workspace_file(dir.path(), "note.txt", "after", None).unwrap();
        let after = read_workspace_file(dir.path(), "note.txt").unwrap();

        assert_eq!(before, "before");
        assert_eq!(after, "after");
    }

    #[cfg(unix)]
    #[test]
    fn read_workspace_file_rejects_symlink_sources() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            dir.path().join("linked.txt"),
        )
        .unwrap();

        let result = read_workspace_file(dir.path(), "linked.txt");

        assert!(matches!(result, Err(WorkspaceError::SymlinkUnsupported)));
    }

    #[cfg(unix)]
    #[test]
    fn write_workspace_file_rejects_symlink_sources() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let secret_path = outside.path().join("secret.txt");
        fs::write(&secret_path, "secret").unwrap();
        symlink(&secret_path, dir.path().join("linked.txt")).unwrap();

        let result = write_workspace_file(dir.path(), "linked.txt", "changed", None);

        assert!(matches!(result, Err(WorkspaceError::SymlinkUnsupported)));
        assert_eq!(fs::read_to_string(secret_path).unwrap(), "secret");
    }

    #[test]
    fn write_workspace_file_rejects_stale_modified_timestamps() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.txt");
        fs::write(&path, "before").unwrap();
        let modified_ms = fs::metadata(&path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();

        fs::write(&path, "outside change").unwrap();
        let stale_modified_ms = modified_ms.saturating_sub(1);
        let result = write_workspace_file(dir.path(), "note.txt", "after", Some(stale_modified_ms));

        assert!(matches!(
            result,
            Err(WorkspaceError::FileModifiedExternally)
        ));
        assert_eq!(fs::read_to_string(path).unwrap(), "outside change");
    }

    #[test]
    fn create_workspace_file_creates_empty_file_inside_root() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();

        create_workspace_file(dir.path(), "src/new.rs").unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("src/new.rs")).unwrap(),
            ""
        );
    }

    #[test]
    fn create_workspace_file_creates_missing_parent_directories() {
        let dir = tempdir().unwrap();

        create_workspace_file(dir.path(), "src/features/new.tsx").unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("src/features/new.tsx")).unwrap(),
            ""
        );
    }

    #[test]
    fn create_workspace_file_rejects_existing_files() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "before").unwrap();

        let result = create_workspace_file(dir.path(), "note.txt");

        assert!(matches!(result, Err(WorkspaceError::FileAlreadyExists)));
        assert_eq!(
            fs::read_to_string(dir.path().join("note.txt")).unwrap(),
            "before"
        );
    }

    #[test]
    fn create_workspace_file_rejects_parent_traversal() {
        let dir = tempdir().unwrap();

        let result = create_workspace_file(dir.path(), "../secret.txt");

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
    }

    #[cfg(unix)]
    #[test]
    fn create_workspace_file_rejects_symlink_parent_sources() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        symlink(outside.path(), dir.path().join("linked")).unwrap();

        let result = create_workspace_file(dir.path(), "linked/new.txt");

        assert!(matches!(result, Err(WorkspaceError::SymlinkUnsupported)));
        assert!(!outside.path().join("new.txt").exists());
    }

    #[test]
    fn create_workspace_folder_creates_directory_inside_root() {
        let dir = tempdir().unwrap();

        create_workspace_folder(dir.path(), "src").unwrap();

        assert!(dir.path().join("src").is_dir());
    }

    #[test]
    fn create_workspace_folder_creates_missing_parent_directories() {
        let dir = tempdir().unwrap();

        create_workspace_folder(dir.path(), "src/features/editor").unwrap();

        assert!(dir.path().join("src/features/editor").is_dir());
    }

    #[test]
    fn create_workspace_folder_rejects_existing_directories() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();

        let result = create_workspace_folder(dir.path(), "src");

        assert!(matches!(result, Err(WorkspaceError::FileAlreadyExists)));
        assert!(dir.path().join("src").is_dir());
    }

    #[test]
    fn create_workspace_folder_rejects_parent_traversal() {
        let dir = tempdir().unwrap();

        let result = create_workspace_folder(dir.path(), "../outside");

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
    }

    #[cfg(unix)]
    #[test]
    fn create_workspace_folder_rejects_symlink_parent_sources() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        symlink(outside.path(), dir.path().join("linked")).unwrap();

        let result = create_workspace_folder(dir.path(), "linked/new-folder");

        assert!(matches!(result, Err(WorkspaceError::SymlinkUnsupported)));
        assert!(!outside.path().join("new-folder").exists());
    }

    #[test]
    fn rename_workspace_file_moves_file_inside_root() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();

        rename_workspace_file(dir.path(), "note.txt", "src/renamed.txt").unwrap();

        assert!(!dir.path().join("note.txt").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("src/renamed.txt")).unwrap(),
            "contents"
        );
    }

    #[test]
    fn rename_workspace_file_rejects_existing_destination() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();
        fs::write(dir.path().join("existing.txt"), "other").unwrap();

        let result = rename_workspace_file(dir.path(), "note.txt", "existing.txt");

        assert!(matches!(result, Err(WorkspaceError::FileAlreadyExists)));
        assert_eq!(
            fs::read_to_string(dir.path().join("note.txt")).unwrap(),
            "contents"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("existing.txt")).unwrap(),
            "other"
        );
    }

    #[test]
    fn rename_workspace_file_moves_directory_inside_root() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src/nested")).unwrap();
        fs::write(dir.path().join("src/nested/file.txt"), "contents").unwrap();

        rename_workspace_file(dir.path(), "src", "renamed").unwrap();

        assert!(!dir.path().join("src").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("renamed/nested/file.txt")).unwrap(),
            "contents"
        );
    }

    #[test]
    fn rename_workspace_file_rejects_parent_traversal() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();

        let result = rename_workspace_file(dir.path(), "note.txt", "../secret.txt");

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
        assert!(dir.path().join("note.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rename_workspace_file_rejects_symlink_sources() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let secret_path = outside.path().join("secret.txt");
        let linked_path = dir.path().join("linked.txt");
        fs::write(&secret_path, "secret").unwrap();
        symlink(&secret_path, &linked_path).unwrap();

        let result = rename_workspace_file(dir.path(), "linked.txt", "renamed.txt");

        assert!(matches!(result, Err(WorkspaceError::SymlinkUnsupported)));
        assert!(fs::symlink_metadata(linked_path).is_ok());
        assert_eq!(fs::read_to_string(secret_path).unwrap(), "secret");
        assert!(!dir.path().join("renamed.txt").exists());
    }

    #[test]
    fn delete_workspace_file_removes_file_inside_root() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();

        delete_workspace_file(dir.path(), "note.txt").unwrap();

        assert!(!dir.path().join("note.txt").exists());
    }

    #[test]
    fn delete_workspace_file_removes_directory_inside_root() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src/nested")).unwrap();
        fs::write(dir.path().join("src/nested/file.txt"), "contents").unwrap();

        delete_workspace_file(dir.path(), "src").unwrap();

        assert!(!dir.path().join("src").exists());
    }

    #[test]
    fn delete_workspace_file_rejects_parent_traversal() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();

        let result = delete_workspace_file(dir.path(), "../secret.txt");

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
        assert!(dir.path().join("note.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn delete_workspace_file_rejects_symlink_sources() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let secret_path = outside.path().join("secret.txt");
        let linked_path = dir.path().join("linked.txt");
        fs::write(&secret_path, "secret").unwrap();
        symlink(&secret_path, &linked_path).unwrap();

        let result = delete_workspace_file(dir.path(), "linked.txt");

        assert!(matches!(result, Err(WorkspaceError::SymlinkUnsupported)));
        assert!(fs::symlink_metadata(linked_path).is_ok());
        assert_eq!(fs::read_to_string(secret_path).unwrap(), "secret");
    }

    #[test]
    fn scan_workspace_skips_generated_and_git_directories() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join(".git/config"), "").unwrap();
        fs::write(dir.path().join(".github/workflows/test.yml"), "").unwrap();
        fs::write(dir.path().join(".gitignore"), "").unwrap();
        fs::write(dir.path().join("node_modules/pkg/index.js"), "").unwrap();
        fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();

        let entries = scan_workspace(dir.path(), 100, false, false).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"src"));
        assert!(paths.contains(&"src/main.rs"));
        assert!(!paths.iter().any(|path| path.starts_with(".git")));
        assert!(!paths.iter().any(|path| path.starts_with(".github")));
        assert!(!paths.iter().any(|path| path == &".gitignore"));
        assert!(!paths.iter().any(|path| path.starts_with("node_modules")));
    }

    #[test]
    fn scan_workspace_can_include_dotfiles_without_generated_directories() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
        fs::create_dir_all(dir.path().join(".vscode")).unwrap();
        fs::write(dir.path().join(".git/config"), "").unwrap();
        fs::write(dir.path().join(".github/workflows/test.yml"), "").unwrap();
        fs::write(dir.path().join(".vscode/settings.json"), "{}").unwrap();
        fs::write(dir.path().join(".gitignore"), "").unwrap();

        let entries = scan_workspace(dir.path(), 100, true, false).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&".github"));
        assert!(paths.contains(&".github/workflows"));
        assert!(paths.contains(&".github/workflows/test.yml"));
        assert!(paths.contains(&".vscode"));
        assert!(paths.contains(&".vscode/settings.json"));
        assert!(paths.contains(&".gitignore"));
        assert!(!paths
            .iter()
            .any(|path| *path == ".git" || path.starts_with(".git/")));
    }

    #[test]
    fn scan_workspace_can_include_generated_directories_without_dotfiles() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".git/objects")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.path().join("target/debug")).unwrap();
        fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
        fs::write(dir.path().join(".git/config"), "").unwrap();
        fs::write(dir.path().join("node_modules/pkg/index.js"), "").unwrap();
        fs::write(dir.path().join("target/debug/app"), "").unwrap();
        fs::write(dir.path().join(".github/workflows/test.yml"), "").unwrap();
        fs::write(dir.path().join(".gitignore"), "").unwrap();

        let entries = scan_workspace(dir.path(), 100, false, true).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&".git"));
        assert!(paths.contains(&".git/config"));
        assert!(paths.contains(&"node_modules"));
        assert!(paths.contains(&"node_modules/pkg/index.js"));
        assert!(paths.contains(&"target"));
        assert!(paths.contains(&"target/debug/app"));
        assert!(!paths.contains(&".github"));
        assert!(!paths.contains(&".gitignore"));
    }

    #[test]
    fn scan_workspace_respects_entry_limit() {
        let dir = tempdir().unwrap();
        for index in 0..10 {
            fs::write(dir.path().join(format!("{index}.txt")), "").unwrap();
        }

        let entries = scan_workspace(dir.path(), 3, false, false).unwrap();

        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn scan_workspace_prioritizes_top_level_entries_before_deep_children() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("artifacts/deep")).unwrap();
        fs::create_dir_all(dir.path().join("docs")).unwrap();
        fs::write(dir.path().join("LICENSE"), "").unwrap();
        fs::write(dir.path().join("README.md"), "").unwrap();
        for index in 0..20 {
            fs::write(
                dir.path().join(format!("artifacts/deep/{index:02}.txt")),
                "",
            )
            .unwrap();
        }

        let entries = scan_workspace(dir.path(), 5, false, false).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"artifacts"));
        assert!(paths.contains(&"docs"));
        assert!(paths.contains(&"LICENSE"));
        assert!(paths.contains(&"README.md"));
    }

    #[test]
    fn search_workspace_finds_case_insensitive_line_matches() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(
            dir.path().join("src/main.rs"),
            "fn main() {\n    println!(\"Needle\");\n}\n",
        )
        .unwrap();

        let results = search_workspace(dir.path(), "needle", 10).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "src/main.rs");
        assert_eq!(results[0].line_number, 2);
    }

    #[test]
    fn search_workspace_returns_browser_string_offsets_for_unicode_lines() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "éé 😀 Needle\n").unwrap();

        let results = search_workspace(dir.path(), "needle", 10).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].line_text, "éé 😀 Needle");
        assert_eq!(results[0].match_start, 6);
        assert_eq!(results[0].match_end, 12);
    }

    #[test]
    fn search_workspace_offsets_survive_case_expanding_unicode_before_match() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "İ prefix Needle\n").unwrap();

        let results = search_workspace(dir.path(), "needle", 10).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].line_text, "İ prefix Needle");
        assert_eq!(results[0].match_start, 9);
        assert_eq!(results[0].match_end, 15);
    }

    #[test]
    fn workspace_file_entry_returns_single_file_metadata() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("main.rs"), "fn main() {}").unwrap();

        let entry = workspace_file_entry(dir.path(), "src/main.rs").unwrap();

        assert_eq!(entry.path, "src/main.rs");
        assert_eq!(entry.name, "main.rs");
        assert_eq!(entry.parent.as_deref(), Some("src"));
        assert!(!entry.is_dir);
        assert_eq!(entry.depth, 1);
        assert!(entry.modified_ms.is_some());
    }

    #[test]
    fn search_workspace_skips_generated_directories_and_binary_files() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::write(dir.path().join("node_modules/pkg/index.js"), "needle").unwrap();
        fs::write(dir.path().join("image.png"), b"needle\0binary").unwrap();
        fs::write(dir.path().join("demo.mp4"), "needle").unwrap();
        fs::write(dir.path().join("font.woff2"), "needle").unwrap();
        fs::write(dir.path().join("README.md"), "needle").unwrap();

        let results = search_workspace(dir.path(), "needle", 10).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "README.md");
    }

    #[cfg(unix)]
    #[test]
    fn search_workspace_skips_symlink_sources() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "needle").unwrap();
        fs::write(dir.path().join("inside.txt"), "needle").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            dir.path().join("linked.txt"),
        )
        .unwrap();

        let results = search_workspace(dir.path(), "needle", 10).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "inside.txt");
    }

    #[test]
    fn search_workspace_rejects_long_queries() {
        let dir = tempdir().unwrap();
        let query = "a".repeat(MAX_SEARCH_QUERY_CHARS + 1);

        let result = search_workspace(dir.path(), &query, 10);

        assert!(matches!(result, Err(WorkspaceError::SearchQueryTooLong)));
    }
}
