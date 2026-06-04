use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;
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

pub fn scan_workspace(root: &Path, max_entries: usize) -> Result<Vec<FileEntry>, WorkspaceError> {
    let mut entries = Vec::new();
    let walker = workspace_walker(root).build();

    for result in walker {
        if entries.len() >= max_entries {
            break;
        }

        let entry = result?;
        let path = entry.path();
        if path == root {
            continue;
        }

        let metadata = entry.metadata()?;

        let relative = path
            .strip_prefix(root)
            .map_err(|_| WorkspaceError::OutsideWorkspace)?;
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

        entries.push(FileEntry {
            path: relative_path,
            name: entry.file_name().to_string_lossy().to_string(),
            parent,
            is_dir: metadata.is_dir(),
            depth,
            size: metadata.len(),
            modified_ms,
        });
    }

    entries.sort_by(|a, b| {
        a.path
            .to_lowercase()
            .cmp(&b.path.to_lowercase())
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(entries)
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
    let walker = workspace_walker(root).build();

    for result in walker {
        if matches.len() >= max_results {
            break;
        }

        let entry = result?;
        let path = entry.path();
        if path == root {
            continue;
        }

        let metadata = entry.metadata()?;
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

            let lower_line = line.to_lowercase();
            let Some(match_start) = lower_line.find(&normalized_query) else {
                continue;
            };

            let relative = path
                .strip_prefix(root)
                .map_err(|_| WorkspaceError::OutsideWorkspace)?;
            matches.push(SearchMatch {
                path: normalize_path(relative),
                line_number: index + 1,
                line_text: line.trim_end().to_string(),
                match_start,
                match_end: match_start + query.len(),
            });
        }
    }

    Ok(matches)
}

pub fn read_workspace_file(root: &Path, relative: &str) -> Result<String, WorkspaceError> {
    let path = resolve_workspace_path(root, relative)?;
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
    let path = resolve_workspace_path(root, relative)?;
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
    let path = resolve_workspace_path(root, relative)?;
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
    let path = resolve_workspace_path(root, relative)?;
    match fs::create_dir(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(WorkspaceError::FileAlreadyExists)
        }
        Err(error) => Err(WorkspaceError::Io(error)),
    }
}

pub fn rename_workspace_file(
    root: &Path,
    from: &str,
    to: &str,
) -> Result<(), WorkspaceError> {
    let from_path = resolve_workspace_path(root, from)?;
    let to_path = resolve_workspace_path(root, to)?;
    if !from_path.metadata()?.is_file() {
        return Err(WorkspaceError::NotAFile);
    }
    if to_path.exists() {
        return Err(WorkspaceError::FileAlreadyExists);
    }

    fs::rename(from_path, to_path).map_err(WorkspaceError::from)
}

pub fn delete_workspace_file(root: &Path, relative: &str) -> Result<(), WorkspaceError> {
    let path = resolve_workspace_path(root, relative)?;
    if !path.metadata()?.is_file() {
        return Err(WorkspaceError::NotAFile);
    }

    fs::remove_file(path).map_err(WorkspaceError::from)
}

fn workspace_walker(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .filter_entry(|entry| !is_generated_name(entry.file_name()));
    builder
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
            "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "ico"
                | "pdf"
                | "zip"
                | "gz"
                | "dll"
                | "exe"
                | "dylib"
                | "so"
                | "wasm"
        )
    )
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
        let result = write_workspace_file(
            dir.path(),
            "note.txt",
            "after",
            Some(stale_modified_ms),
        );

        assert!(matches!(result, Err(WorkspaceError::FileModifiedExternally)));
        assert_eq!(fs::read_to_string(path).unwrap(), "outside change");
    }

    #[test]
    fn create_workspace_file_creates_empty_file_inside_root() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();

        create_workspace_file(dir.path(), "src/new.rs").unwrap();

        assert_eq!(fs::read_to_string(dir.path().join("src/new.rs")).unwrap(), "");
    }

    #[test]
    fn create_workspace_file_rejects_existing_files() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "before").unwrap();

        let result = create_workspace_file(dir.path(), "note.txt");

        assert!(matches!(result, Err(WorkspaceError::FileAlreadyExists)));
        assert_eq!(fs::read_to_string(dir.path().join("note.txt")).unwrap(), "before");
    }

    #[test]
    fn create_workspace_file_rejects_parent_traversal() {
        let dir = tempdir().unwrap();

        let result = create_workspace_file(dir.path(), "../secret.txt");

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
    }

    #[test]
    fn create_workspace_folder_creates_directory_inside_root() {
        let dir = tempdir().unwrap();

        create_workspace_folder(dir.path(), "src").unwrap();

        assert!(dir.path().join("src").is_dir());
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
        assert_eq!(fs::read_to_string(dir.path().join("note.txt")).unwrap(), "contents");
        assert_eq!(fs::read_to_string(dir.path().join("existing.txt")).unwrap(), "other");
    }

    #[test]
    fn rename_workspace_file_rejects_directory_sources() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();

        let result = rename_workspace_file(dir.path(), "src", "renamed");

        assert!(matches!(result, Err(WorkspaceError::NotAFile)));
    }

    #[test]
    fn rename_workspace_file_rejects_parent_traversal() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();

        let result = rename_workspace_file(dir.path(), "note.txt", "../secret.txt");

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
        assert!(dir.path().join("note.txt").exists());
    }

    #[test]
    fn delete_workspace_file_removes_file_inside_root() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();

        delete_workspace_file(dir.path(), "note.txt").unwrap();

        assert!(!dir.path().join("note.txt").exists());
    }

    #[test]
    fn delete_workspace_file_rejects_directory_sources() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();

        let result = delete_workspace_file(dir.path(), "src");

        assert!(matches!(result, Err(WorkspaceError::NotAFile)));
        assert!(dir.path().join("src").is_dir());
    }

    #[test]
    fn delete_workspace_file_rejects_parent_traversal() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();

        let result = delete_workspace_file(dir.path(), "../secret.txt");

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
        assert!(dir.path().join("note.txt").exists());
    }

    #[test]
    fn scan_workspace_skips_generated_and_git_directories() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join(".git/config"), "").unwrap();
        fs::write(dir.path().join("node_modules/pkg/index.js"), "").unwrap();
        fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();

        let entries = scan_workspace(dir.path(), 100).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"src"));
        assert!(paths.contains(&"src/main.rs"));
        assert!(!paths.iter().any(|path| path.starts_with(".git")));
        assert!(!paths.iter().any(|path| path.starts_with("node_modules")));
    }

    #[test]
    fn scan_workspace_respects_entry_limit() {
        let dir = tempdir().unwrap();
        for index in 0..10 {
            fs::write(dir.path().join(format!("{index}.txt")), "").unwrap();
        }

        let entries = scan_workspace(dir.path(), 3).unwrap();

        assert_eq!(entries.len(), 3);
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
    fn search_workspace_skips_generated_directories_and_binary_files() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::write(dir.path().join("node_modules/pkg/index.js"), "needle").unwrap();
        fs::write(dir.path().join("image.png"), b"needle\0binary").unwrap();
        fs::write(dir.path().join("README.md"), "needle").unwrap();

        let results = search_workspace(dir.path(), "needle", 10).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "README.md");
    }

    #[test]
    fn search_workspace_rejects_long_queries() {
        let dir = tempdir().unwrap();
        let query = "a".repeat(MAX_SEARCH_QUERY_CHARS + 1);

        let result = search_workspace(dir.path(), &query, 10);

        assert!(matches!(result, Err(WorkspaceError::SearchQueryTooLong)));
    }
}
