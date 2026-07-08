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
    // Symlink metadata so the tree can mark these entries and decide whether an
    // external target needs the trust prompt before it's followed.
    pub is_symlink: bool,
    pub is_external: bool,
    pub symlink_target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceScan {
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
    pub limit: usize,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearch {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub limit: usize,
    pub searched_files: usize,
    pub skipped_files: usize,
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
    #[error("path is not a directory")]
    NotADirectory,
    #[error("path is not a file or directory")]
    NotAnEntry,
    #[error("symbolic link points outside the workspace")]
    SymlinkOutsideWorkspace,
    #[error("file changed on disk since it was opened")]
    FileModifiedExternally,
    #[error("file is not valid UTF-8 text")]
    UnsupportedEncoding,
    #[error("search query is too long")]
    SearchQueryTooLong,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("walk error: {0}")]
    Walk(#[from] ignore::Error),
}

const MAX_SEARCH_QUERY_CHARS: usize = 128;

#[cfg(test)]
fn scan_workspace(
    root: &Path,
    max_entries: usize,
    show_dotfiles: bool,
    show_generated_internal: bool,
    show_gitignored_files: bool,
) -> Result<Vec<FileEntry>, WorkspaceError> {
    Ok(scan_workspace_with_metadata(
        root,
        max_entries,
        show_dotfiles,
        show_generated_internal,
        show_gitignored_files,
    )?
    .entries)
}

pub fn scan_workspace_with_metadata(
    root: &Path,
    max_entries: usize,
    show_dotfiles: bool,
    show_generated_internal: bool,
    show_gitignored_files: bool,
) -> Result<WorkspaceScan, WorkspaceError> {
    let canonical_root = root.canonicalize()?;
    let mut entries = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut max_depth = 1;

    loop {
        let previous_seen_count = seen_paths.len();
        let mut walker = workspace_walker(
            root,
            show_dotfiles,
            show_generated_internal,
            !show_gitignored_files,
        );
        walker.max_depth(Some(max_depth));

        for result in walker.build() {
            let entry = result?;
            if entry.path() == root {
                continue;
            }

            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| WorkspaceError::OutsideWorkspace)?;
            let relative_path = normalize_path(relative);
            if seen_paths.contains(&relative_path) {
                continue;
            }

            if entries.len() >= max_entries {
                sort_scan_entries(&mut entries);
                return Ok(WorkspaceScan {
                    entries,
                    truncated: true,
                    limit: max_entries,
                });
            }

            push_scan_entry(root, &canonical_root, &entry, &mut entries, &mut seen_paths)?;
        }

        if seen_paths.len() == previous_seen_count {
            break;
        }

        max_depth += 1;
    }

    sort_scan_entries(&mut entries);
    Ok(WorkspaceScan {
        entries,
        truncated: false,
        limit: max_entries,
    })
}

fn sort_scan_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        a.path
            .to_lowercase()
            .cmp(&b.path.to_lowercase())
            .then_with(|| a.path.cmp(&b.path))
    });
}

pub fn workspace_file_entry(root: &Path, relative: &str) -> Result<FileEntry, WorkspaceError> {
    workspace_entry(root, relative)
}

// Display-only metadata for a single entry. Resolves against the link itself
// (no trust gate — this is a stat, not a content read), so callers can show a
// symlink's marker and external state without prompting.
pub fn workspace_entry(root: &Path, relative: &str) -> Result<FileEntry, WorkspaceError> {
    let canonical_root = root.canonicalize()?;
    let abs = resolve_workspace_path(root, relative)?;
    let link_metadata = fs::symlink_metadata(&abs)?;
    file_entry_from_relative(Path::new(relative), &abs, &link_metadata, &canonical_root)
}

pub fn workspace_directory_entries(
    root: &Path,
    relative: &str,
    show_dotfiles: bool,
    show_generated_internal: bool,
    show_gitignored_files: bool,
    allow_external_symlinks: bool,
) -> Result<Vec<FileEntry>, WorkspaceError> {
    let canonical_root = root.canonicalize()?;
    let path = if relative.is_empty() {
        canonical_root.clone()
    } else {
        resolve_existing_workspace_dir_path_following(root, relative, allow_external_symlinks)?
    };

    // Children are keyed by their logical path under `relative` (the path the user
    // navigated), not the canonical target — so a symlinked directory's children
    // nest under the symlink in the tree instead of jumping to the real location.
    let base = relative.trim_end_matches('/');
    let mut entries = Vec::new();
    let mut walker = workspace_walker(
        &path,
        show_dotfiles,
        show_generated_internal,
        !show_gitignored_files,
    );
    walker.max_depth(Some(1));
    for result in walker.build() {
        let entry = result?;
        let child_path = entry.path();
        if child_path == path {
            continue;
        }

        let link_metadata = fs::symlink_metadata(child_path)?;
        let name = child_path
            .file_name()
            .ok_or(WorkspaceError::InvalidPath)?
            .to_string_lossy()
            .to_string();
        let child_relative = if base.is_empty() {
            PathBuf::from(&name)
        } else {
            PathBuf::from(format!("{base}/{name}"))
        };
        entries.push(file_entry_from_relative(
            &child_relative,
            child_path,
            &link_metadata,
            &canonical_root,
        )?);
    }

    sort_scan_entries(&mut entries);
    Ok(entries)
}

pub fn filter_visible_workspace_entries(
    root: &Path,
    entries: Vec<FileEntry>,
    show_dotfiles: bool,
    show_generated_internal: bool,
    show_gitignored_files: bool,
) -> Result<Vec<FileEntry>, WorkspaceError> {
    let entries = entries
        .into_iter()
        .filter(|entry| entry_passes_name_filters(entry, show_dotfiles, show_generated_internal))
        .collect::<Vec<_>>();

    if show_gitignored_files || entries.is_empty() {
        return Ok(entries);
    }

    let targets = entries
        .iter()
        .map(|entry| entry.path.clone())
        .collect::<HashSet<_>>();
    let max_depth = entries
        .iter()
        .map(|entry| Path::new(&entry.path).components().count())
        .max()
        .unwrap_or(1);
    let canonical_root = root.canonicalize()?;
    let mut visible_paths = HashSet::new();
    let mut walker = workspace_walker(
        &canonical_root,
        show_dotfiles,
        show_generated_internal,
        true,
    );
    walker.max_depth(Some(max_depth));

    for result in walker.build() {
        let entry = result?;
        let path = entry.path();
        if path == canonical_root {
            continue;
        }
        let relative = path
            .strip_prefix(&canonical_root)
            .map_err(|_| WorkspaceError::OutsideWorkspace)?;
        let relative_path = normalize_path(relative);
        if targets.contains(&relative_path) {
            visible_paths.insert(relative_path);
            if visible_paths.len() == targets.len() {
                break;
            }
        }
    }

    Ok(entries
        .into_iter()
        .filter(|entry| visible_paths.contains(&entry.path))
        .collect())
}

fn entry_passes_name_filters(
    entry: &FileEntry,
    show_dotfiles: bool,
    show_generated_internal: bool,
) -> bool {
    Path::new(&entry.path).components().all(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        if is_generated_name(name) {
            return show_generated_internal;
        }
        show_dotfiles || !is_dot_name(name)
    })
}

fn push_scan_entry(
    root: &Path,
    canonical_root: &Path,
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
    if !seen_paths.insert(relative_path) {
        return Ok(());
    }

    entries.push(file_entry_from_relative(
        relative,
        path,
        &metadata,
        canonical_root,
    )?);
    Ok(())
}

struct SymlinkFacts {
    is_dir: bool,
    size: u64,
    is_symlink: bool,
    is_external: bool,
    symlink_target: Option<String>,
    // Modified time of the thing the editor actually reads/writes — the link's
    // target for a symlink, the entry itself otherwise. The save conflict check
    // compares against the target's mtime, so an open + save round-trip has to
    // start from the same source or it falsely reports "changed on disk".
    modified_ms: Option<u128>,
}

fn metadata_modified_ms(metadata: &fs::Metadata) -> Option<u128> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
}

// Resolves the displayable facts for an entry. For a symlink it follows the link
// to report the target's type/size (so a linked dir shows as a folder) and flags
// whether the target escapes the workspace; a broken link is treated as external
// and non-directory. Following here is a stat only — content reads still require
// trust via the resolve_* gate.
fn symlink_facts(
    abs_path: &Path,
    link_metadata: &fs::Metadata,
    canonical_root: &Path,
) -> SymlinkFacts {
    if !link_metadata.file_type().is_symlink() {
        return SymlinkFacts {
            is_dir: link_metadata.is_dir(),
            size: link_metadata.len(),
            is_symlink: false,
            is_external: false,
            symlink_target: None,
            modified_ms: metadata_modified_ms(link_metadata),
        };
    }

    let symlink_target = fs::read_link(abs_path)
        .ok()
        .map(|target| target.to_string_lossy().to_string());

    match abs_path.canonicalize() {
        Ok(canonical) => {
            let target_metadata = fs::metadata(&canonical).ok();
            SymlinkFacts {
                is_dir: target_metadata
                    .as_ref()
                    .map(|m| m.is_dir())
                    .unwrap_or(false),
                size: target_metadata.as_ref().map(|m| m.len()).unwrap_or(0),
                is_symlink: true,
                is_external: !canonical.starts_with(canonical_root),
                symlink_target,
                modified_ms: target_metadata.as_ref().and_then(metadata_modified_ms),
            }
        }
        // Broken link (target missing or loop): show it, but never as a folder.
        Err(_) => SymlinkFacts {
            is_dir: false,
            size: 0,
            is_symlink: true,
            is_external: true,
            symlink_target,
            modified_ms: metadata_modified_ms(link_metadata),
        },
    }
}

fn file_entry_from_relative(
    relative: &Path,
    abs_path: &Path,
    link_metadata: &fs::Metadata,
    canonical_root: &Path,
) -> Result<FileEntry, WorkspaceError> {
    let relative_path = normalize_path(relative);
    let parent = relative
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .map(normalize_path);
    let depth = relative.components().count().saturating_sub(1);

    let name = relative
        .file_name()
        .ok_or(WorkspaceError::InvalidPath)?
        .to_string_lossy()
        .to_string();

    let facts = symlink_facts(abs_path, link_metadata, canonical_root);
    let modified_ms = facts.modified_ms;

    Ok(FileEntry {
        path: relative_path,
        name,
        parent,
        is_dir: facts.is_dir,
        depth,
        size: facts.size,
        modified_ms,
        is_symlink: facts.is_symlink,
        is_external: facts.is_external,
        symlink_target: facts.symlink_target,
    })
}

#[cfg(test)]
fn search_workspace(
    root: &Path,
    query: &str,
    max_results: usize,
    max_file_bytes: u64,
) -> Result<Vec<SearchMatch>, WorkspaceError> {
    Ok(search_workspace_with_metadata(root, query, max_results, max_file_bytes, false)?.matches)
}

pub fn search_workspace_with_metadata(
    root: &Path,
    query: &str,
    max_results: usize,
    max_file_bytes: u64,
    show_dotfiles: bool,
) -> Result<WorkspaceSearch, WorkspaceError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(WorkspaceSearch {
            matches: Vec::new(),
            truncated: false,
            limit: max_results,
            searched_files: 0,
            skipped_files: 0,
        });
    }
    if query.chars().count() > MAX_SEARCH_QUERY_CHARS {
        return Err(WorkspaceError::SearchQueryTooLong);
    }
    if max_results == 0 {
        return Ok(WorkspaceSearch {
            matches: Vec::new(),
            truncated: false,
            limit: max_results,
            searched_files: 0,
            skipped_files: 0,
        });
    }

    let normalized_query = query.to_lowercase();
    let mut matches = Vec::new();
    let mut searched_files = 0;
    let mut skipped_files = 0;
    let collection_limit = max_results.saturating_add(1);

    let walker = workspace_walker(root, show_dotfiles, false, true);
    for result in walker.build() {
        if matches.len() >= collection_limit {
            break;
        }

        let entry = result?;
        let path = entry.path();
        if path == root {
            continue;
        }

        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            skipped_files += 1;
            continue;
        }
        if metadata.is_dir() {
            continue;
        }
        if metadata.len() > max_file_bytes || is_known_binary_path(path) {
            skipped_files += 1;
            continue;
        }

        let bytes = fs::read(path)?;
        if bytes.contains(&0) {
            skipped_files += 1;
            continue;
        }

        let Ok(contents) = std::str::from_utf8(&bytes) else {
            skipped_files += 1;
            continue;
        };
        let relative = path
            .strip_prefix(root)
            .map_err(|_| WorkspaceError::OutsideWorkspace)?;
        let relative_path = normalize_path(relative);

        searched_files += 1;
        'line_matches: for (index, line) in contents.lines().enumerate() {
            if matches.len() >= collection_limit {
                break;
            }

            let line_text = line.trim_end().to_string();

            for (match_start, match_end) in
                case_insensitive_match_byte_ranges(line, &normalized_query)
            {
                if matches.len() >= collection_limit {
                    break 'line_matches;
                }

                matches.push(SearchMatch {
                    path: relative_path.clone(),
                    line_number: index + 1,
                    line_text: line_text.clone(),
                    match_start: utf16_offset_for_byte_index(line, match_start),
                    match_end: utf16_offset_for_byte_index(line, match_end),
                });
            }
        }
    }

    let truncated = matches.len() > max_results;
    matches.truncate(max_results);
    Ok(WorkspaceSearch {
        matches,
        truncated,
        limit: max_results,
        searched_files,
        skipped_files,
    })
}

pub fn read_workspace_file(
    root: &Path,
    relative: &str,
    max_open_bytes: u64,
    allow_external_symlinks: bool,
) -> Result<String, WorkspaceError> {
    let path = resolve_existing_workspace_file_path(root, relative, allow_external_symlinks)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() > max_open_bytes {
        return Err(WorkspaceError::FileTooLarge);
    }

    fs::read_to_string(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::InvalidData => WorkspaceError::UnsupportedEncoding,
        _ => WorkspaceError::Io(error),
    })
}

pub fn write_workspace_file(
    root: &Path,
    relative: &str,
    contents: &str,
    expected_modified_ms: Option<u128>,
    allow_external_symlinks: bool,
) -> Result<(), WorkspaceError> {
    let path = resolve_existing_workspace_file_path(root, relative, allow_external_symlinks)?;
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

pub fn create_workspace_file(
    root: &Path,
    relative: &str,
    allow_external_symlinks: bool,
) -> Result<(), WorkspaceError> {
    let path = resolve_new_workspace_file_path(root, relative, allow_external_symlinks)?;
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

pub fn create_workspace_folder(
    root: &Path,
    relative: &str,
    allow_external_symlinks: bool,
) -> Result<(), WorkspaceError> {
    let path = resolve_new_workspace_entry_path(root, relative, allow_external_symlinks)?;
    match fs::create_dir_all(path) {
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
    allow_external_symlinks: bool,
) -> Result<(), WorkspaceError> {
    let from_path = resolve_existing_workspace_entry_path(root, from, allow_external_symlinks)?;
    let to_path = resolve_new_workspace_entry_path(root, to, allow_external_symlinks)?;
    if let Some(parent) = to_path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::rename(from_path, to_path).map_err(WorkspaceError::from)
}

pub fn delete_workspace_file(root: &Path, relative: &str) -> Result<(), WorkspaceError> {
    // Deleting only ever removes a link or an in-workspace entry, so external
    // traversal is never needed here.
    let path = resolve_existing_workspace_entry_path(root, relative, false)?;

    // A symlink resolves to the link itself; remove just the link so the target
    // (a real file or directory, possibly outside the workspace) is left intact.
    let link_metadata = fs::symlink_metadata(&path)?;
    if link_metadata.file_type().is_symlink() {
        return fs::remove_file(path).map_err(WorkspaceError::from);
    }

    if link_metadata.is_dir() {
        fs::remove_dir_all(path).map_err(WorkspaceError::from)
    } else {
        fs::remove_file(path).map_err(WorkspaceError::from)
    }
}

fn workspace_walker(
    root: &Path,
    show_dotfiles: bool,
    show_generated_internal: bool,
    respect_ignore_files: bool,
) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(respect_ignore_files)
        .git_exclude(respect_ignore_files)
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

fn case_insensitive_match_byte_ranges(line: &str, normalized_query: &str) -> Vec<(usize, usize)> {
    if normalized_query.is_empty() {
        return vec![(0, 0)];
    }

    line.char_indices()
        .map(|(index, _)| index)
        .filter_map(|byte_start| {
            case_insensitive_match_end_byte(line, byte_start, normalized_query)
                .map(|byte_end| (byte_start, byte_end))
        })
        .collect()
}

fn case_insensitive_match_end_byte(
    line: &str,
    byte_start: usize,
    normalized_query: &str,
) -> Option<usize> {
    let mut lowered = String::new();

    for (offset, character) in line[byte_start..].char_indices() {
        lowered.extend(character.to_lowercase());
        let byte_end = byte_start + offset + character.len_utf8();

        if lowered.starts_with(normalized_query) {
            return Some(byte_end);
        }
        if !normalized_query.starts_with(&lowered) {
            return None;
        }
    }

    lowered.starts_with(normalized_query).then_some(line.len())
}

pub(crate) fn resolve_workspace_path(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, WorkspaceError> {
    resolve_workspace_path_inner(root, relative, false)
}

// Resolves a workspace-relative path to an absolute candidate (without following
// the final component). The candidate's parent must canonicalize within the
// workspace root unless `allow_external` is set — that flag is the user's granted
// trust, letting a path traverse a symlink whose target escapes the workspace.
fn resolve_workspace_path_inner(
    root: &Path,
    relative: &str,
    allow_external: bool,
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

    let root = root.canonicalize()?;
    let candidate = root.join(relative_path);
    let parent = candidate.parent().ok_or(WorkspaceError::InvalidPath)?;
    // The parent directory may not exist — e.g. committing or diffing a file whose
    // entire containing directory was deleted. Resolve the nearest existing ancestor
    // so path resolution succeeds; the deletion itself is handled by the caller. When
    // the parent does exist this returns it unchanged, so the symlink-escape guard
    // below still canonicalizes the real directory a write would traverse.
    let existing_ancestor = nearest_existing_ancestor(parent)?.canonicalize()?;

    if !existing_ancestor.starts_with(&root) && !allow_external {
        return Err(WorkspaceError::SymlinkOutsideWorkspace);
    }

    Ok(candidate)
}

fn resolve_new_workspace_file_path(
    root: &Path,
    relative: &str,
    allow_external: bool,
) -> Result<PathBuf, WorkspaceError> {
    resolve_new_workspace_entry_path(root, relative, allow_external)
}

fn resolve_new_workspace_entry_path(
    root: &Path,
    relative: &str,
    allow_external: bool,
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
    // Follow the nearest existing ancestor (it may be a symlinked dir) and require
    // the resolved target to stay within the workspace unless trust was granted.
    let canonical_ancestor = existing_ancestor.canonicalize()?;
    if !fs::metadata(&canonical_ancestor)?.is_dir() {
        return Err(WorkspaceError::NotAnEntry);
    }
    if !canonical_ancestor.starts_with(&root) && !allow_external {
        return Err(WorkspaceError::SymlinkOutsideWorkspace);
    }

    if candidate.exists() {
        return Err(WorkspaceError::FileAlreadyExists);
    }

    Ok(candidate)
}

fn nearest_existing_ancestor(path: &Path) -> Result<PathBuf, WorkspaceError> {
    let mut current = path;
    loop {
        // symlink_metadata (lstat) reports the dirent itself, not its target, so a
        // dangling symlink counts as "existing" here and gets returned rather than
        // skipped. Path::exists() follows the link and would report a dangling
        // symlink as absent, walking past it to a higher ancestor and letting the
        // caller's canonicalize() pass on a parent that never sees the symlink —
        // opening a TOCTOU window where the link resolves outside the workspace
        // once its target shows up. Returning the symlink itself instead forces the
        // caller's canonicalize() to follow (and fail closed on) the same entry.
        if current.symlink_metadata().is_ok() {
            return Ok(current.to_path_buf());
        }
        current = current.parent().ok_or(WorkspaceError::InvalidPath)?;
    }
}

pub(crate) fn resolve_existing_workspace_file_path(
    root: &Path,
    relative: &str,
    allow_external: bool,
) -> Result<PathBuf, WorkspaceError> {
    let path = resolve_workspace_path_inner(root, relative, allow_external)?;
    let root = root.canonicalize()?;
    // Follow the link to its target; the target must stay within the workspace
    // unless trust was granted. Read/write then operate on the real file.
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(&root) && !allow_external {
        return Err(WorkspaceError::SymlinkOutsideWorkspace);
    }
    if !fs::metadata(&canonical)?.is_file() {
        return Err(WorkspaceError::NotAFile);
    }

    Ok(canonical)
}

// Follows a (possibly symlinked) directory to its target for listing. The target
// must stay within the workspace unless trust was granted.
fn resolve_existing_workspace_dir_path_following(
    root: &Path,
    relative: &str,
    allow_external: bool,
) -> Result<PathBuf, WorkspaceError> {
    let path = resolve_workspace_path_inner(root, relative, allow_external)?;
    let root = root.canonicalize()?;
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(&root) && !allow_external {
        return Err(WorkspaceError::SymlinkOutsideWorkspace);
    }
    if !fs::metadata(&canonical)?.is_dir() {
        return Err(WorkspaceError::NotADirectory);
    }

    Ok(canonical)
}

// Resolves the source of a rename/delete. A symlink resolves to the link itself
// (so the operation moves/removes the link, never its target); its location is
// already verified within the workspace by resolve_workspace_path. `allow_external`
// permits an entry that lives inside a trusted external symlinked directory, so
// rename can follow the same trust grant that create/write already honour.
fn resolve_existing_workspace_entry_path(
    root: &Path,
    relative: &str,
    allow_external: bool,
) -> Result<PathBuf, WorkspaceError> {
    let path = resolve_workspace_path_inner(root, relative, allow_external)?;
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() {
        return Ok(path);
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(WorkspaceError::NotAnEntry);
    }

    let root = root.canonicalize()?;
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(&root) && !allow_external {
        return Err(WorkspaceError::OutsideWorkspace);
    }

    Ok(canonical)
}

pub(crate) fn normalize_path(path: &Path) -> String {
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
        let result = read_workspace_file(dir.path(), "../secret.txt", 1024, false);

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
    }

    #[test]
    fn read_workspace_file_rejects_absolute_paths() {
        let dir = tempdir().unwrap();
        let result = read_workspace_file(dir.path(), "/etc/hosts", 1024, false);

        assert!(matches!(result, Err(WorkspaceError::OutsideWorkspace)));
    }

    #[test]
    fn read_and_write_workspace_file_stays_inside_root() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "before").unwrap();

        let before = read_workspace_file(dir.path(), "note.txt", 1024, false).unwrap();
        write_workspace_file(dir.path(), "note.txt", "after", None, false).unwrap();
        let after = read_workspace_file(dir.path(), "note.txt", 1024, false).unwrap();

        assert_eq!(before, "before");
        assert_eq!(after, "after");
    }

    #[test]
    fn read_workspace_file_rejects_invalid_utf8_text() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("invalid.txt"), b"valid prefix \xFF").unwrap();

        let result = read_workspace_file(dir.path(), "invalid.txt", 1024, false);

        assert!(matches!(result, Err(WorkspaceError::UnsupportedEncoding)));
    }

    #[test]
    fn read_workspace_file_respects_configured_size_limit() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("large.txt"), "123456").unwrap();

        let result = read_workspace_file(dir.path(), "large.txt", 5, false);

        assert!(matches!(result, Err(WorkspaceError::FileTooLarge)));
        assert_eq!(
            read_workspace_file(dir.path(), "large.txt", 6, false).unwrap(),
            "123456"
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_workspace_file_rejects_external_symlink_without_trust() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            dir.path().join("linked.txt"),
        )
        .unwrap();

        // Untrusted external symlink is refused...
        let result = read_workspace_file(dir.path(), "linked.txt", 1024, false);
        assert!(matches!(
            result,
            Err(WorkspaceError::SymlinkOutsideWorkspace)
        ));

        // ...but reads through once the user grants trust.
        assert_eq!(
            read_workspace_file(dir.path(), "linked.txt", 1024, true).unwrap(),
            "secret"
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_workspace_file_follows_in_workspace_symlink() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        fs::write(dir.path().join("real/note.txt"), "inside").unwrap();
        symlink(
            dir.path().join("real/note.txt"),
            dir.path().join("link.txt"),
        )
        .unwrap();

        // In-workspace target needs no trust.
        assert_eq!(
            read_workspace_file(dir.path(), "link.txt", 1024, false).unwrap(),
            "inside"
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_workspace_file_fails_closed_on_dangling_symlink_parent() {
        let dir = tempdir().unwrap();
        // A dangling symlink still "exists" as a dirent (symlink_metadata finds it),
        // so nearest_existing_ancestor must return it rather than walk past it to a
        // higher, real ancestor. If it walked past, the escape guard would validate
        // an unrelated real directory and let the request through; the caller's
        // later canonicalize() of the dangling link then fails closed instead of
        // silently resolving once/if the link's target starts to exist.
        symlink(dir.path().join("nowhere"), dir.path().join("dangling_link")).unwrap();

        let result = read_workspace_file(dir.path(), "dangling_link/child.txt", 1024, false);
        assert!(matches!(result, Err(WorkspaceError::Io(_))));
    }

    #[cfg(unix)]
    #[test]
    fn write_workspace_file_rejects_external_symlink_without_trust() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let secret_path = outside.path().join("secret.txt");
        fs::write(&secret_path, "secret").unwrap();
        symlink(&secret_path, dir.path().join("linked.txt")).unwrap();

        let result = write_workspace_file(dir.path(), "linked.txt", "changed", None, false);
        assert!(matches!(
            result,
            Err(WorkspaceError::SymlinkOutsideWorkspace)
        ));
        assert_eq!(fs::read_to_string(&secret_path).unwrap(), "secret");

        // With trust, the write edits through the link to the real target.
        write_workspace_file(dir.path(), "linked.txt", "changed", None, true).unwrap();
        assert_eq!(fs::read_to_string(&secret_path).unwrap(), "changed");
    }

    #[cfg(unix)]
    #[test]
    fn write_workspace_file_follows_in_workspace_symlink() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        let target = dir.path().join("real/note.txt");
        fs::write(&target, "before").unwrap();
        symlink(&target, dir.path().join("link.txt")).unwrap();

        write_workspace_file(dir.path(), "link.txt", "after", None, false).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "after");
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
            false,
        );

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

        create_workspace_file(dir.path(), "src/new.rs", false).unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("src/new.rs")).unwrap(),
            ""
        );
    }

    #[test]
    fn create_workspace_file_creates_missing_parent_directories() {
        let dir = tempdir().unwrap();

        create_workspace_file(dir.path(), "src/features/new.tsx", false).unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("src/features/new.tsx")).unwrap(),
            ""
        );
    }

    #[test]
    fn create_workspace_file_rejects_existing_files() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "before").unwrap();

        let result = create_workspace_file(dir.path(), "note.txt", false);

        assert!(matches!(result, Err(WorkspaceError::FileAlreadyExists)));
        assert_eq!(
            fs::read_to_string(dir.path().join("note.txt")).unwrap(),
            "before"
        );
    }

    #[test]
    fn create_workspace_file_rejects_parent_traversal() {
        let dir = tempdir().unwrap();

        let result = create_workspace_file(dir.path(), "../secret.txt", false);

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
    }

    #[cfg(unix)]
    #[test]
    fn create_workspace_file_rejects_symlink_parent_sources() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        symlink(outside.path(), dir.path().join("linked")).unwrap();

        let result = create_workspace_file(dir.path(), "linked/new.txt", false);

        assert!(matches!(
            result,
            Err(WorkspaceError::SymlinkOutsideWorkspace)
        ));
        assert!(!outside.path().join("new.txt").exists());
    }

    #[test]
    fn create_workspace_folder_creates_directory_inside_root() {
        let dir = tempdir().unwrap();

        create_workspace_folder(dir.path(), "src", false).unwrap();

        assert!(dir.path().join("src").is_dir());
    }

    #[test]
    fn create_workspace_folder_creates_missing_parent_directories() {
        let dir = tempdir().unwrap();

        create_workspace_folder(dir.path(), "src/features/editor", false).unwrap();

        assert!(dir.path().join("src/features/editor").is_dir());
    }

    #[test]
    fn create_workspace_folder_rejects_existing_directories() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();

        let result = create_workspace_folder(dir.path(), "src", false);

        assert!(matches!(result, Err(WorkspaceError::FileAlreadyExists)));
        assert!(dir.path().join("src").is_dir());
    }

    #[test]
    fn create_workspace_folder_rejects_parent_traversal() {
        let dir = tempdir().unwrap();

        let result = create_workspace_folder(dir.path(), "../outside", false);

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
    }

    #[cfg(unix)]
    #[test]
    fn create_workspace_folder_rejects_symlink_parent_sources() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        symlink(outside.path(), dir.path().join("linked")).unwrap();

        let result = create_workspace_folder(dir.path(), "linked/new-folder", false);

        assert!(matches!(
            result,
            Err(WorkspaceError::SymlinkOutsideWorkspace)
        ));
        assert!(!outside.path().join("new-folder").exists());
    }

    #[test]
    fn rename_workspace_file_moves_file_inside_root() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();

        rename_workspace_file(dir.path(), "note.txt", "src/renamed.txt", false).unwrap();

        assert!(!dir.path().join("note.txt").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("src/renamed.txt")).unwrap(),
            "contents"
        );
    }

    #[test]
    fn rename_workspace_file_creates_missing_destination_parent_directories() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();

        rename_workspace_file(dir.path(), "note.txt", "src/features/renamed.txt", false).unwrap();

        assert!(!dir.path().join("note.txt").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("src/features/renamed.txt")).unwrap(),
            "contents"
        );
    }

    #[test]
    fn rename_workspace_file_rejects_existing_destination() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();
        fs::write(dir.path().join("existing.txt"), "other").unwrap();

        let result = rename_workspace_file(dir.path(), "note.txt", "existing.txt", false);

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

        rename_workspace_file(dir.path(), "src", "renamed", false).unwrap();

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

        let result = rename_workspace_file(dir.path(), "note.txt", "../secret.txt", false);

        assert!(matches!(result, Err(WorkspaceError::InvalidPath)));
        assert!(dir.path().join("note.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rename_workspace_file_renames_the_symlink_not_its_target() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let secret_path = outside.path().join("secret.txt");
        let linked_path = dir.path().join("linked.txt");
        fs::write(&secret_path, "secret").unwrap();
        symlink(&secret_path, &linked_path).unwrap();

        rename_workspace_file(dir.path(), "linked.txt", "renamed.txt", false).unwrap();

        // The link moved; the external target is untouched and not relocated.
        assert!(fs::symlink_metadata(&linked_path).is_err());
        let renamed = dir.path().join("renamed.txt");
        assert!(fs::symlink_metadata(&renamed)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(secret_path).unwrap(), "secret");
    }

    #[cfg(unix)]
    #[test]
    fn rename_workspace_file_rejects_symlink_parent_destinations() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "contents").unwrap();
        symlink(outside.path(), dir.path().join("linked")).unwrap();

        let result = rename_workspace_file(dir.path(), "note.txt", "linked/renamed.txt", false);

        assert!(matches!(
            result,
            Err(WorkspaceError::SymlinkOutsideWorkspace)
        ));
        assert_eq!(
            fs::read_to_string(dir.path().join("note.txt")).unwrap(),
            "contents"
        );
        assert!(!outside.path().join("renamed.txt").exists());
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
    fn delete_workspace_file_removes_the_symlink_not_its_target() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let secret_path = outside.path().join("secret.txt");
        let linked_path = dir.path().join("linked.txt");
        fs::write(&secret_path, "secret").unwrap();
        symlink(&secret_path, &linked_path).unwrap();

        delete_workspace_file(dir.path(), "linked.txt").unwrap();

        // Only the link is removed; the external target survives.
        assert!(fs::symlink_metadata(linked_path).is_err());
        assert_eq!(fs::read_to_string(secret_path).unwrap(), "secret");
    }

    #[cfg(unix)]
    #[test]
    fn delete_workspace_dir_symlink_removes_only_the_link() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("keep.txt"), "keep").unwrap();
        symlink(outside.path(), dir.path().join("linked")).unwrap();

        delete_workspace_file(dir.path(), "linked").unwrap();

        assert!(fs::symlink_metadata(dir.path().join("linked")).is_err());
        // The real directory and its contents are left intact.
        assert_eq!(
            fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
            "keep"
        );
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

        let entries = scan_workspace(dir.path(), 100, false, false, true).unwrap();
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

        let entries = scan_workspace(dir.path(), 100, true, false, true).unwrap();
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

        let entries = scan_workspace(dir.path(), 100, false, true, true).unwrap();
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
    fn scan_workspace_includes_gitignored_files() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(dir.path().join("ignored.txt"), "").unwrap();
        fs::write(dir.path().join("visible.txt"), "").unwrap();

        let entries = scan_workspace(dir.path(), 100, false, false, true).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"ignored.txt"));
        assert!(paths.contains(&"visible.txt"));
        assert!(!paths.contains(&".gitignore"));
    }

    #[test]
    fn scan_workspace_can_hide_gitignored_files() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(dir.path().join("ignored.txt"), "").unwrap();
        fs::write(dir.path().join("visible.txt"), "").unwrap();

        let entries = scan_workspace(dir.path(), 100, false, false, false).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(!paths.contains(&"ignored.txt"));
        assert!(paths.contains(&"visible.txt"));
    }

    #[test]
    fn scan_workspace_returns_all_scoped_entries() {
        let dir = tempdir().unwrap();
        for index in 0..10 {
            fs::write(dir.path().join(format!("{index}.txt")), "").unwrap();
        }

        let entries = scan_workspace(dir.path(), 100, false, false, true).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(entries.len(), 10);
        for index in 0..10 {
            let expected = format!("{index}.txt");
            assert!(paths.contains(&expected.as_str()));
        }
    }

    #[test]
    fn scan_workspace_spends_entry_limit_by_layer() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a/one")).unwrap();
        fs::create_dir_all(dir.path().join("b/two")).unwrap();
        fs::write(dir.path().join("a/one/deep.txt"), "").unwrap();
        fs::write(dir.path().join("b/two/deep.txt"), "").unwrap();
        fs::write(dir.path().join("c.txt"), "").unwrap();

        let entries = scan_workspace(dir.path(), 5, false, false, true).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(entries.len(), 5);
        assert!(paths.contains(&"a"));
        assert!(paths.contains(&"b"));
        assert!(paths.contains(&"c.txt"));
        assert!(paths.contains(&"a/one"));
        assert!(paths.contains(&"b/two"));
        assert!(!paths.contains(&"a/one/deep.txt"));
        assert!(!paths.contains(&"b/two/deep.txt"));
    }

    #[test]
    fn scan_workspace_reports_when_entry_limit_truncates_results() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "").unwrap();
        fs::write(dir.path().join("b.txt"), "").unwrap();
        fs::write(dir.path().join("c.txt"), "").unwrap();

        let scan = scan_workspace_with_metadata(dir.path(), 2, false, false, true).unwrap();

        assert_eq!(scan.entries.len(), 2);
        assert_eq!(scan.limit, 2);
        assert!(scan.truncated);
    }

    #[test]
    fn scan_workspace_does_not_report_truncation_when_limit_exactly_fits() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "").unwrap();
        fs::write(dir.path().join("b.txt"), "").unwrap();

        let scan = scan_workspace_with_metadata(dir.path(), 2, false, false, true).unwrap();

        assert_eq!(scan.entries.len(), 2);
        assert_eq!(scan.limit, 2);
        assert!(!scan.truncated);
    }

    #[test]
    fn workspace_directory_entries_returns_direct_children_with_filters() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::create_dir_all(dir.path().join("src/.cache")).unwrap();
        fs::create_dir_all(dir.path().join("src/node_modules/pkg")).unwrap();
        fs::write(dir.path().join(".gitignore"), "src/ignored.txt\n").unwrap();
        fs::write(dir.path().join("src/ignored.txt"), "").unwrap();
        fs::write(dir.path().join("src/main.rs"), "").unwrap();
        fs::write(dir.path().join("src/.env"), "").unwrap();
        fs::write(dir.path().join("src/node_modules/pkg/index.js"), "").unwrap();

        let entries =
            workspace_directory_entries(dir.path(), "src", false, false, true, false).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"src/ignored.txt"));
        assert!(paths.contains(&"src/main.rs"));
        assert!(!paths.contains(&"src/.cache"));
        assert!(!paths.contains(&"src/.env"));
        assert!(!paths.contains(&"src/node_modules"));

        let entries =
            workspace_directory_entries(dir.path(), "src", true, true, true, false).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"src/.cache"));
        assert!(paths.contains(&"src/.env"));
        assert!(paths.contains(&"src/node_modules"));
        assert!(!paths.contains(&"src/node_modules/pkg"));
    }

    #[test]
    fn workspace_directory_entries_accepts_workspace_root() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("README.md"), "").unwrap();

        let entries =
            workspace_directory_entries(dir.path(), "", false, false, true, false).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"src"));
        assert!(paths.contains(&"README.md"));
    }

    #[cfg(unix)]
    #[test]
    fn workspace_directory_entries_lists_symlinked_dir_children_under_logical_path() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        fs::write(dir.path().join("real/inner.txt"), "x").unwrap();
        symlink(dir.path().join("real"), dir.path().join("link")).unwrap();

        let entries =
            workspace_directory_entries(dir.path(), "link", false, false, true, false).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        // Children nest under the symlink the user navigated, not the real target.
        assert!(paths.contains(&"link/inner.txt"));
        assert!(!paths.contains(&"real/inner.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn file_entry_reports_symlink_facts() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        symlink(dir.path().join("real"), dir.path().join("inside_dir_link")).unwrap();
        fs::write(dir.path().join("file.txt"), "x").unwrap();
        symlink(
            dir.path().join("file.txt"),
            dir.path().join("inside_file_link"),
        )
        .unwrap();
        symlink(outside.path(), dir.path().join("external_link")).unwrap();

        let entries =
            workspace_directory_entries(dir.path(), "", false, false, true, false).unwrap();
        let by_name = |name: &str| {
            entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap_or_else(|| panic!("missing entry {name}"))
                .clone()
        };

        let dir_link = by_name("inside_dir_link");
        assert!(dir_link.is_symlink && dir_link.is_dir && !dir_link.is_external);

        let file_link = by_name("inside_file_link");
        assert!(file_link.is_symlink && !file_link.is_dir && !file_link.is_external);

        let external = by_name("external_link");
        assert!(external.is_symlink && external.is_external);

        let plain = by_name("file.txt");
        assert!(!plain.is_symlink && !plain.is_external);
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

        let results = search_workspace(dir.path(), "needle", 10, 1_000_000).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "src/main.rs");
        assert_eq!(results[0].line_number, 2);
    }

    #[test]
    fn search_workspace_returns_browser_string_offsets_for_unicode_lines() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "éé 😀 Needle\n").unwrap();

        let results = search_workspace(dir.path(), "needle", 10, 1_000_000).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].line_text, "éé 😀 Needle");
        assert_eq!(results[0].match_start, 6);
        assert_eq!(results[0].match_end, 12);
    }

    #[test]
    fn search_workspace_offsets_survive_case_expanding_unicode_before_match() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "İ prefix Needle\n").unwrap();

        let results = search_workspace(dir.path(), "needle", 10, 1_000_000).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].line_text, "İ prefix Needle");
        assert_eq!(results[0].match_start, 9);
        assert_eq!(results[0].match_end, 15);
    }

    #[test]
    fn search_workspace_returns_each_match_on_the_same_line() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "Needle then needle again\n").unwrap();

        let results = search_workspace(dir.path(), "needle", 10, 1_000_000).unwrap();

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].path, "README.md");
        assert_eq!(results[0].line_number, 1);
        assert_eq!(results[0].match_start, 0);
        assert_eq!(results[0].match_end, 6);
        assert_eq!(results[1].path, "README.md");
        assert_eq!(results[1].line_number, 1);
        assert_eq!(results[1].match_start, 12);
        assert_eq!(results[1].match_end, 18);
    }

    #[test]
    fn search_workspace_stops_at_max_results_with_same_line_matches() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "needle needle needle\n").unwrap();

        let results = search_workspace(dir.path(), "needle", 2, 1_000_000).unwrap();

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].match_start, 0);
        assert_eq!(results[1].match_start, 7);
    }

    #[test]
    fn search_workspace_reports_when_result_limit_truncates_matches() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "needle needle needle\n").unwrap();

        let search =
            search_workspace_with_metadata(dir.path(), "needle", 2, 1_000_000, false).unwrap();

        assert_eq!(search.matches.len(), 2);
        assert_eq!(search.limit, 2);
        assert!(search.truncated);
    }

    #[test]
    fn search_workspace_does_not_report_truncation_when_limit_exactly_fits() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "needle needle\n").unwrap();

        let search =
            search_workspace_with_metadata(dir.path(), "needle", 2, 1_000_000, false).unwrap();

        assert_eq!(search.matches.len(), 2);
        assert_eq!(search.limit, 2);
        assert!(!search.truncated);
    }

    #[test]
    fn search_workspace_reports_searched_and_skipped_file_counts() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "hit").unwrap();
        fs::write(dir.path().join("large.txt"), "needle").unwrap();
        fs::write(dir.path().join("image.png"), "needle").unwrap();
        fs::write(dir.path().join("binary.txt"), b"n\0").unwrap();

        let search = search_workspace_with_metadata(dir.path(), "hit", 10, 4, false).unwrap();

        assert_eq!(search.matches.len(), 1);
        assert_eq!(search.matches[0].path, "README.md");
        assert_eq!(search.searched_files, 1);
        assert_eq!(search.skipped_files, 3);
    }

    #[test]
    fn search_workspace_honors_dotfile_visibility_scope() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".env"), "needle").unwrap();
        fs::write(dir.path().join("README.md"), "needle").unwrap();

        let hidden =
            search_workspace_with_metadata(dir.path(), "needle", 10, 1_000_000, false).unwrap();
        let visible =
            search_workspace_with_metadata(dir.path(), "needle", 10, 1_000_000, true).unwrap();

        assert_eq!(hidden.matches.len(), 1);
        assert_eq!(hidden.matches[0].path, "README.md");
        assert_eq!(visible.matches.len(), 2);
        assert!(visible.matches.iter().any(|match_| match_.path == ".env"));
    }

    #[test]
    fn search_workspace_respects_gitignore_rules() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(dir.path().join("ignored.txt"), "needle").unwrap();
        fs::write(dir.path().join("README.md"), "needle").unwrap();

        let search =
            search_workspace_with_metadata(dir.path(), "needle", 10, 1_000_000, false).unwrap();

        assert_eq!(search.matches.len(), 1);
        assert_eq!(search.matches[0].path, "README.md");
    }

    #[test]
    fn search_workspace_spends_result_limit_by_layer() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a/inner")).unwrap();
        fs::write(dir.path().join("a/inner/deep.txt"), "needle").unwrap();
        fs::write(dir.path().join("z-root.txt"), "needle").unwrap();

        let results = search_workspace(dir.path(), "needle", 1, 1_000_000).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "z-root.txt");
    }

    #[test]
    fn search_workspace_accepts_zero_result_limit() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "needle").unwrap();

        let results = search_workspace(dir.path(), "needle", 0, 1_000_000).unwrap();

        assert!(results.is_empty());
    }

    #[test]
    fn search_workspace_uses_original_unicode_match_width() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "İ and i\n").unwrap();

        let results = search_workspace(dir.path(), "i", 10, 1_000_000).unwrap();

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].match_start, 0);
        assert_eq!(results[0].match_end, 1);
        assert_eq!(results[1].match_start, 6);
        assert_eq!(results[1].match_end, 7);
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
    fn workspace_entry_returns_folder_metadata() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();

        let entry = workspace_entry(dir.path(), "src").unwrap();

        assert_eq!(entry.path, "src");
        assert_eq!(entry.name, "src");
        assert!(entry.is_dir);
        assert_eq!(entry.depth, 0);
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

        let results = search_workspace(dir.path(), "needle", 10, 1_000_000).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "README.md");
    }

    #[test]
    fn search_workspace_respects_max_file_bytes() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("large.txt"), "prefix needle suffix").unwrap();
        fs::write(dir.path().join("small.txt"), "needle").unwrap();

        let results = search_workspace(dir.path(), "needle", 10, 8).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "small.txt");
    }

    #[test]
    fn search_workspace_skips_invalid_utf8_text_files() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("invalid.txt"), b"needle \xFF").unwrap();
        fs::write(dir.path().join("README.md"), "needle").unwrap();

        let results = search_workspace(dir.path(), "needle", 10, 1_000_000).unwrap();

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

        let results = search_workspace(dir.path(), "needle", 10, 1_000_000).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "inside.txt");
    }

    #[test]
    fn search_workspace_rejects_long_queries() {
        let dir = tempdir().unwrap();
        let query = "a".repeat(MAX_SEARCH_QUERY_CHARS + 1);

        let result = search_workspace(dir.path(), &query, 10, 1_000_000);

        assert!(matches!(result, Err(WorkspaceError::SearchQueryTooLong)));
    }
}
