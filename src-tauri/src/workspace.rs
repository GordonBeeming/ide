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

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("path is outside the workspace")]
    OutsideWorkspace,
    #[error("path contains unsupported components")]
    InvalidPath,
    #[error("file is too large to open in the editor")]
    FileTooLarge,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("walk error: {0}")]
    Walk(#[from] ignore::Error),
}

const MAX_OPEN_BYTES: u64 = 5 * 1024 * 1024;

pub fn scan_workspace(root: &Path, max_entries: usize) -> Result<Vec<FileEntry>, WorkspaceError> {
    let mut entries = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".git"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | ".next"
                    | ".turbo"
                    | ".tauri"
            )
        })
        .build();

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
) -> Result<(), WorkspaceError> {
    let path = resolve_workspace_path(root, relative)?;
    fs::write(path, contents).map_err(WorkspaceError::from)
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
        write_workspace_file(dir.path(), "note.txt", "after").unwrap();
        let after = read_workspace_file(dir.path(), "note.txt").unwrap();

        assert_eq!(before, "before");
        assert_eq!(after, "after");
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
        let paths = entries.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>();

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
}
