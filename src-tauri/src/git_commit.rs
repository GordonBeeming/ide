// Git status and commit support should use embedded gitoxide/gix APIs. Keep
// direct `git` commands out of this service unless gix does not cover the
// required behavior.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use gix::bstr::{BStr, BString, ByteSlice};
use gix::object::tree::EntryKind;
use gix::status::plumbing::index_as_worktree::{
    Change as WorktreeChange, EntryStatus as WorktreeEntryStatus,
};
use serde::Serialize;

use crate::workspace::{normalize_path, resolve_workspace_path, WorkspaceError};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStatus {
    pub status: GitStatusAvailability,
    pub unsupported_reason: Option<String>,
    pub branch: Option<String>,
    pub head_detached: bool,
    pub head_unborn: bool,
    pub files: Vec<GitStatusEntry>,
    // True while a merge is unfinished (MERGE_HEAD present). Polling this lets the
    // UI drive the conflict-resolution flow live instead of stranding the user in
    // a one-shot result.
    pub merge_in_progress: bool,
    // Workspace-relative paths with unmerged index entries (conflict stages).
    // Empties as the user stages resolutions, which is what re-enables completing
    // the merge.
    pub conflicted_files: Vec<String>,
    // Commits HEAD is ahead of / behind its configured upstream. `None` when there
    // is no upstream, or HEAD is detached/unborn. `behind` reflects the remote as
    // of the last fetch (the standard Git behaviour) — a Sync fetches first, so the
    // status re-poll right after it shows the up-to-date counts.
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GitStatusAvailability {
    Available,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStatusEntry {
    pub path: String,
    pub status: GitFileStatus,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GitFileStatus {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitResult {
    pub sha: String,
    pub short_sha: String,
    pub branch: Option<String>,
    pub committed_paths: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum GitCommitError {
    #[error("workspace is not inside a Git repository")]
    NotARepo,
    #[error("commit message cannot be empty")]
    EmptyMessage,
    #[error("select at least one file to commit")]
    EmptySelection,
    #[error("selected files have no changes to commit")]
    NoChanges,
    #[error("set user.name and user.email in your Git config")]
    AuthorUnset,
    #[error("{0} is a directory, not a file")]
    PathIsDirectory(String),
    #[error("{0}")]
    Workspace(#[from] WorkspaceError),
    #[error("{0}")]
    Git(String),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitFileDiff {
    pub original: String,
    pub modified: String,
    pub status: GitFileStatus,
    pub is_binary: bool,
    pub is_too_large: bool,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum GitFileDiffError {
    #[error("workspace is not inside a Git repository")]
    NotARepo,
    #[error("{0} is a directory, not a file")]
    PathIsDirectory(String),
    #[error("path is not present in HEAD or on disk")]
    NotFound,
    #[error("{0}")]
    Workspace(#[from] WorkspaceError),
    #[error("{0}")]
    Git(String),
}

pub(crate) async fn status_for_workspace(workspace_root: &Path) -> GitStatus {
    let workspace_root = workspace_root.to_path_buf();
    tokio::task::spawn_blocking(move || status_for_workspace_blocking(&workspace_root))
        .await
        .unwrap_or_else(|_| unsupported_status("Git status task failed to complete"))
}

fn status_for_workspace_blocking(workspace_root: &Path) -> GitStatus {
    let repo = match gix::discover(workspace_root) {
        Ok(repo) => repo,
        Err(_) => return unsupported_status("Workspace is not inside a Git repository"),
    };
    let Some(repo_workdir) = repo.workdir() else {
        return unsupported_status("Bare Git repositories are not supported");
    };
    let repo_workdir = repo_workdir
        .canonicalize()
        .unwrap_or_else(|_| repo_workdir.to_path_buf());
    let canonical_workspace_root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let prefix = workspace_prefix(&repo_workdir, &canonical_workspace_root);

    let head = match repo.head() {
        Ok(head) => head,
        Err(_) => return unsupported_status("Unable to read repository HEAD"),
    };
    let head_unborn = head.is_unborn();
    let head_detached = head.is_detached();
    let branch = head.referent_name().map(|name| name.shorten().to_string());

    let patterns: Vec<BString> = match &prefix {
        Some(prefix) => vec![BString::from(prefix.as_str())],
        None => Vec::new(),
    };

    let platform = match repo.status(gix::progress::Discard) {
        Ok(platform) => platform,
        Err(error) => return unsupported_status(format!("Git status failed: {error}")),
    };
    let platform = platform
        .untracked_files(gix::status::UntrackedFiles::Files)
        .tree_index_track_renames(gix::status::tree_index::TrackRenames::Disabled)
        .index_worktree_rewrites(None::<gix::diff::Rewrites>);

    let iter = match platform.into_iter(patterns) {
        Ok(iter) => iter,
        Err(error) => return unsupported_status(format!("Git status failed: {error}")),
    };

    let mut entries: HashMap<String, GitStatusEntry> = HashMap::new();
    for item in iter {
        // A single failed item (e.g. a transient IO error) shouldn't blank out the
        // whole status — skip it and keep folding the rest.
        let Ok(item) = item else { continue };
        match item {
            gix::status::Item::TreeIndex(change) => {
                fold_tree_index_change(&mut entries, &change, prefix.as_deref());
            }
            gix::status::Item::IndexWorktree(item) => {
                fold_index_worktree_item(&mut entries, item, prefix.as_deref());
            }
        }
    }

    let mut files: Vec<GitStatusEntry> = entries.into_values().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let merge_in_progress = repo.git_dir().join("MERGE_HEAD").exists();
    let conflicted_files = collect_conflicted_files(&repo, prefix.as_deref());
    let (ahead, behind) = match ahead_behind(&repo, &head) {
        Some((ahead, behind)) => (Some(ahead), Some(behind)),
        None => (None, None),
    };

    GitStatus {
        status: GitStatusAvailability::Available,
        unsupported_reason: None,
        branch,
        head_detached,
        head_unborn,
        files,
        merge_in_progress,
        conflicted_files,
        ahead,
        behind,
    }
}

// Ahead/behind commit counts of HEAD versus its configured upstream tracking ref.
// `behind` is measured against the remote-tracking ref as it stood at the last
// fetch — the same thing `git status` reports — so a Sync (which fetches first)
// followed by the status re-poll surfaces the current numbers.
fn ahead_behind(repo: &gix::Repository, head: &gix::Head<'_>) -> Option<(usize, usize)> {
    // A detached or unborn HEAD has no branch whose upstream we could compare to.
    let ref_name = head.referent_name()?;
    let head_id = head.id()?.detach();

    let tracking =
        match repo.branch_remote_tracking_ref_name(ref_name, gix::remote::Direction::Fetch)? {
            Ok(name) => name.into_owned(),
            Err(_) => return None,
        };
    let upstream_id = repo
        .find_reference(tracking.as_ref())
        .ok()?
        .peel_to_id()
        .ok()?
        .detach();

    // Each walk paints the hidden tip's ancestry as unwanted, so the count is
    // exactly the commits on one side of the merge base. A per-commit walk
    // error (a missing or corrupt object partway through the history) must
    // fail the whole count rather than being silently dropped — filtering
    // those out would undercount and report a plausible-looking but wrong
    // divergence instead of admitting the count is unknown.
    let ahead = repo
        .rev_walk([head_id])
        .with_hidden([upstream_id])
        .all()
        .ok()?
        .try_fold(0usize, |count, info| info.map(|_| count + 1))
        .ok()?;
    let behind = repo
        .rev_walk([upstream_id])
        .with_hidden([head_id])
        .all()
        .ok()?
        .try_fold(0usize, |count, info| info.map(|_| count + 1))
        .ok()?;

    Some((ahead, behind))
}

// Unmerged index entries carry a non-zero conflict stage (base/ours/theirs). A
// path can appear at several stages, so a BTreeSet both dedups and sorts it.
fn collect_conflicted_files(repo: &gix::Repository, prefix: Option<&str>) -> Vec<String> {
    let Ok(index) = repo.open_index() else {
        return Vec::new();
    };
    let mut seen = std::collections::BTreeSet::new();
    for entry in index.entries() {
        if entry.stage() == gix::index::entry::Stage::Unconflicted {
            continue;
        }
        // A conflict outside this workspace's subdirectory has no
        // workspace-relative path, so it's dropped here rather than exposed as
        // a repo-relative one `stage_resolved` (workspace-scoped, rejects
        // `..`) couldn't actually act on. Tracked in #50 to surface that state
        // honestly (e.g. a count) instead of silently.
        if let Some(path) = workspace_relative_path(prefix, entry.path(&index)) {
            seen.insert(path);
        }
    }
    seen.into_iter().collect()
}

fn workspace_prefix(repo_workdir: &Path, workspace_root: &Path) -> Option<String> {
    if workspace_root == repo_workdir {
        return None;
    }
    let relative = workspace_root.strip_prefix(repo_workdir).ok()?;
    if relative.as_os_str().is_empty() {
        None
    } else {
        Some(normalize_path(relative))
    }
}

fn workspace_relative_path(prefix: Option<&str>, repo_relative: &BStr) -> Option<String> {
    let repo_relative = repo_relative.to_str_lossy();
    match prefix {
        None => Some(repo_relative.into_owned()),
        Some(prefix) => repo_relative
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('/'))
            .map(str::to_string),
    }
}

fn fold_tree_index_change(
    entries: &mut HashMap<String, GitStatusEntry>,
    change: &gix::diff::index::Change,
    prefix: Option<&str>,
) {
    let (location, status) = match change {
        gix::diff::index::ChangeRef::Addition { location, .. } => (location, GitFileStatus::Added),
        gix::diff::index::ChangeRef::Deletion { location, .. } => {
            (location, GitFileStatus::Deleted)
        }
        gix::diff::index::ChangeRef::Modification { location, .. } => {
            (location, GitFileStatus::Modified)
        }
        // Rename tracking is disabled for this platform, so this should not occur.
        gix::diff::index::ChangeRef::Rewrite { .. } => return,
    };
    if let Some(path) = workspace_relative_path(prefix, location.as_ref()) {
        merge_entry(entries, path, status, true, false);
    }
}

fn fold_index_worktree_item(
    entries: &mut HashMap<String, GitStatusEntry>,
    item: gix::status::index_worktree::Item,
    prefix: Option<&str>,
) {
    match item {
        gix::status::index_worktree::Item::Modification {
            rela_path, status, ..
        } => {
            fold_worktree_entry_status(entries, rela_path.as_bstr(), &status, prefix);
        }
        gix::status::index_worktree::Item::DirectoryContents { entry, .. } => {
            // Submodules and plain directories are out of scope for v1; only
            // individual untracked files/symlinks are surfaced as additions.
            let is_trackable_file = matches!(
                entry.disk_kind,
                Some(gix::dir::entry::Kind::File) | Some(gix::dir::entry::Kind::Symlink)
            );
            if entry.status == gix::dir::entry::Status::Untracked && is_trackable_file {
                if let Some(path) = workspace_relative_path(prefix, entry.rela_path.as_bstr()) {
                    merge_entry(entries, path, GitFileStatus::Added, false, true);
                }
            }
        }
        // Rename/copy tracking is disabled, so this should not occur; skip defensively.
        gix::status::index_worktree::Item::Rewrite { .. } => {}
    }
}

fn fold_worktree_entry_status(
    entries: &mut HashMap<String, GitStatusEntry>,
    rela_path: &BStr,
    status: &WorktreeEntryStatus<(), gix::submodule::Status>,
    prefix: Option<&str>,
) {
    let file_status = match status {
        WorktreeEntryStatus::Change(WorktreeChange::Removed) => GitFileStatus::Deleted,
        WorktreeEntryStatus::Change(
            WorktreeChange::Type { .. } | WorktreeChange::Modification { .. },
        ) => GitFileStatus::Modified,
        WorktreeEntryStatus::IntentToAdd => GitFileStatus::Added,
        // Submodules are out of scope for v1; conflicts and stat-only refreshes
        // carry nothing that needs to be shown as a change to commit.
        WorktreeEntryStatus::Change(WorktreeChange::SubmoduleModification(_))
        | WorktreeEntryStatus::NeedsUpdate(_)
        | WorktreeEntryStatus::Conflict { .. } => return,
    };
    if let Some(path) = workspace_relative_path(prefix, rela_path) {
        merge_entry(entries, path, file_status, false, true);
    }
}

fn merge_entry(
    entries: &mut HashMap<String, GitStatusEntry>,
    path: String,
    status: GitFileStatus,
    staged: bool,
    unstaged: bool,
) {
    entries
        .entry(path.clone())
        .and_modify(|entry| {
            entry.status = merge_status(entry.status, status);
            entry.staged = entry.staged || staged;
            entry.unstaged = entry.unstaged || unstaged;
        })
        .or_insert(GitStatusEntry {
            path,
            status,
            staged,
            unstaged,
        });
}

// Precedence when both status halves touch the same path: a worktree deletion
// always wins (the file is gone regardless of what the index says), then an
// addition (untracked/staged-new beats a mere content modification).
fn merge_status(existing: GitFileStatus, incoming: GitFileStatus) -> GitFileStatus {
    fn priority(status: GitFileStatus) -> u8 {
        match status {
            GitFileStatus::Deleted => 2,
            GitFileStatus::Added => 1,
            GitFileStatus::Modified => 0,
        }
    }
    if priority(incoming) > priority(existing) {
        incoming
    } else {
        existing
    }
}

fn unsupported_status(reason: impl Into<String>) -> GitStatus {
    GitStatus {
        status: GitStatusAvailability::Unsupported,
        unsupported_reason: Some(reason.into()),
        branch: None,
        head_detached: false,
        head_unborn: false,
        files: Vec::new(),
        merge_in_progress: false,
        conflicted_files: Vec::new(),
        ahead: None,
        behind: None,
    }
}

// Commits run heavy tree/index work in `spawn_blocking` and serialize behind
// this lock so two concurrent commits can't interleave index writes.
static COMMIT_LOCK: Mutex<()> = Mutex::new(());

pub(crate) async fn commit_files(
    workspace_root: &Path,
    message: &str,
    paths: &[String],
) -> Result<GitCommitResult, GitCommitError> {
    let workspace_root = workspace_root.to_path_buf();
    let message = message.to_string();
    let paths = paths.to_vec();
    match tokio::task::spawn_blocking(move || {
        commit_files_blocking(&workspace_root, &message, &paths)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(GitCommitError::Git(
            "commit task failed to complete".to_string(),
        )),
    }
}

fn commit_files_blocking(
    workspace_root: &Path,
    message: &str,
    paths: &[String],
) -> Result<GitCommitResult, GitCommitError> {
    let repo = gix::discover(workspace_root).map_err(|_| GitCommitError::NotARepo)?;
    commit_files_in_repo(&repo, workspace_root, message, paths)
}

// A seam so tests can drive the commit logic against a repository opened with
// `gix::open::Options::isolated()` (e.g. to exercise the missing-author path
// without racing real global Git config through env vars).
fn commit_files_in_repo(
    repo: &gix::Repository,
    workspace_root: &Path,
    message: &str,
    paths: &[String],
) -> Result<GitCommitResult, GitCommitError> {
    let _guard = COMMIT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let message = message.trim();
    if message.is_empty() {
        return Err(GitCommitError::EmptyMessage);
    }
    if paths.is_empty() {
        return Err(GitCommitError::EmptySelection);
    }

    let repo_workdir = repo.workdir().ok_or(GitCommitError::NotARepo)?;
    let repo_workdir = repo_workdir
        .canonicalize()
        .map_err(|error| GitCommitError::Workspace(WorkspaceError::Io(error)))?;

    // Pre-check identity so a misconfigured repo gets one friendly error instead
    // of gix's internal `commit::Error::AuthorMissing`/`CommitterMissing`.
    let author_configured = matches!(repo.author(), Some(Ok(_)));
    let committer_configured = matches!(repo.committer(), Some(Ok(_)));
    if !author_configured || !committer_configured {
        return Err(GitCommitError::AuthorUnset);
    }

    let head = repo
        .head()
        .map_err(|error| GitCommitError::Git(error.to_string()))?;
    let (parents, base_tree) = if head.is_unborn() {
        (Vec::new(), gix::ObjectId::empty_tree(repo.object_hash()))
    } else {
        let head_commit = repo
            .head_commit()
            .map_err(|error| GitCommitError::Git(error.to_string()))?;
        let tree_id = head_commit
            .tree_id()
            .map_err(|error| GitCommitError::Git(error.to_string()))?
            .detach();
        (vec![head_commit.id], tree_id)
    };
    // Detached HEAD has no symbolic referent, so this is naturally `None` there —
    // `repo.commit("HEAD", ...)` still advances HEAD directly in that case.
    let branch = head.referent_name().map(|name| name.shorten().to_string());

    let mut editor = repo
        .edit_tree(base_tree)
        .map_err(|error| GitCommitError::Git(error.to_string()))?;

    let mut pending_updates = Vec::with_capacity(paths.len());
    for relative in paths {
        let absolute = resolve_workspace_path(workspace_root, relative)?;
        let repo_relative_path = absolute
            .strip_prefix(&repo_workdir)
            .map_err(|_| GitCommitError::Workspace(WorkspaceError::OutsideWorkspace))?;
        let repo_relative = BString::from(normalize_path(repo_relative_path));

        match fs::symlink_metadata(&absolute) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                editor
                    .remove(&repo_relative)
                    .map_err(|error| GitCommitError::Git(error.to_string()))?;
                pending_updates.push(PendingIndexUpdate {
                    repo_relative,
                    absolute_path: absolute,
                    write: None,
                });
            }
            Err(error) => return Err(GitCommitError::Workspace(WorkspaceError::Io(error))),
            Ok(metadata) if metadata.is_dir() => {
                return Err(GitCommitError::PathIsDirectory(relative.clone()));
            }
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let target = symlink_target_bytes(&absolute).map_err(WorkspaceError::Io)?;
                let blob_id = repo
                    .write_blob(target)
                    .map_err(|error| GitCommitError::Git(error.to_string()))?
                    .detach();
                editor
                    .upsert(&repo_relative, EntryKind::Link, blob_id)
                    .map_err(|error| GitCommitError::Git(error.to_string()))?;
                pending_updates.push(PendingIndexUpdate {
                    repo_relative,
                    absolute_path: absolute,
                    write: Some((blob_id, gix::index::entry::Mode::SYMLINK)),
                });
            }
            Ok(metadata) => {
                let contents = fs::read(&absolute).map_err(WorkspaceError::Io)?;
                let blob_id = repo
                    .write_blob(&contents)
                    .map_err(|error| GitCommitError::Git(error.to_string()))?
                    .detach();
                let executable = is_executable_file(&metadata);
                let kind = if executable {
                    EntryKind::BlobExecutable
                } else {
                    EntryKind::Blob
                };
                editor
                    .upsert(&repo_relative, kind, blob_id)
                    .map_err(|error| GitCommitError::Git(error.to_string()))?;
                let mode = if executable {
                    gix::index::entry::Mode::FILE_EXECUTABLE
                } else {
                    gix::index::entry::Mode::FILE
                };
                pending_updates.push(PendingIndexUpdate {
                    repo_relative,
                    absolute_path: absolute,
                    write: Some((blob_id, mode)),
                });
            }
        }
    }

    let new_tree = editor
        .write()
        .map_err(|error| GitCommitError::Git(error.to_string()))?;
    // Applies on an unborn HEAD too: selecting only paths that don't exist
    // (already deleted, or never created) edits nothing, so the tree stays
    // the empty tree and this would otherwise create an empty initial commit.
    if new_tree.detach() == base_tree {
        return Err(GitCommitError::NoChanges);
    }

    let commit_id = repo
        .commit("HEAD", message, new_tree.detach(), parents)
        .map_err(|error| GitCommitError::Git(error.to_string()))?;
    let sha = commit_id.to_string();
    let short_sha = commit_id.shorten_or_id().to_string();

    reconcile_index(repo, &pending_updates)?;

    let mut committed_paths = paths.to_vec();
    committed_paths.sort();

    Ok(GitCommitResult {
        sha,
        short_sha,
        branch,
        committed_paths,
    })
}

struct PendingIndexUpdate {
    repo_relative: BString,
    absolute_path: PathBuf,
    // `None` for a deletion; `Some((blob, mode))` for anything written to the tree.
    write: Option<(gix::ObjectId, gix::index::entry::Mode)>,
}

// Updates/removes/inserts index entries for exactly the committed paths, then
// writes the index back — this is what stops a terminal `git status` from
// showing phantom staged changes after the commit. Unselected paths are never
// touched, so other in-flight dirty/staged work survives untouched.
fn reconcile_index(
    repo: &gix::Repository,
    updates: &[PendingIndexUpdate],
) -> Result<(), GitCommitError> {
    let mut index = match repo.open_index() {
        Ok(index) => index,
        Err(gix::worktree::open_index::Error::IndexFile(gix::index::file::init::Error::Io(
            io_error,
        ))) if io_error.kind() == std::io::ErrorKind::NotFound => gix::index::File::from_state(
            gix::index::State::new(repo.object_hash()),
            repo.index_path(),
        ),
        Err(error) => return Err(GitCommitError::Git(error.to_string())),
    };

    let mut needs_sort = false;
    for update in updates {
        let Some((blob_id, mode)) = update.write else {
            let target = update.repo_relative.clone();
            index.remove_entries(|_, path, _| path == target.as_bstr());
            continue;
        };

        let fs_metadata = gix::index::fs::Metadata::from_path_no_follow(&update.absolute_path)
            .map_err(|error| GitCommitError::Workspace(WorkspaceError::Io(error)))?;
        let stat = gix::index::entry::Stat::from_fs(&fs_metadata)
            .map_err(|error| GitCommitError::Git(error.to_string()))?;

        if let Some(existing) = index.entry_index_by_path_and_stage(
            update.repo_relative.as_bstr(),
            gix::index::entry::Stage::Unconflicted,
        ) {
            let entry = &mut index.entries_mut()[existing];
            entry.id = blob_id;
            entry.stat = stat;
            entry.mode = mode;
        } else {
            index.dangerously_push_entry(
                stat,
                blob_id,
                gix::index::entry::Flags::empty(),
                mode,
                update.repo_relative.as_bstr(),
            );
            needs_sort = true;
        }
    }

    if needs_sort {
        index.sort_entries();
    }
    index
        .verify_entries()
        .map_err(|error| GitCommitError::Git(error.to_string()))?;
    index
        .write(gix::index::write::Options::default())
        .map_err(|error| GitCommitError::Git(error.to_string()))?;
    Ok(())
}

#[cfg(unix)]
fn is_executable_file(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable_file(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn symlink_target_bytes(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::os::unix::ffi::OsStrExt;
    Ok(fs::read_link(path)?.as_os_str().as_bytes().to_vec())
}

#[cfg(not(unix))]
fn symlink_target_bytes(path: &Path) -> std::io::Result<Vec<u8>> {
    Ok(fs::read_link(path)?
        .to_string_lossy()
        .into_owned()
        .into_bytes())
}

/// A worktree-vs-HEAD diff for one path, read-only. `max_bytes` is the app's
/// existing large-file cap (the same one `read_file` enforces), passed in by
/// the caller rather than hardcoded here.
pub(crate) async fn file_diff(
    workspace_root: &Path,
    relative: &str,
    max_bytes: u64,
) -> Result<GitFileDiff, GitFileDiffError> {
    let workspace_root = workspace_root.to_path_buf();
    let relative = relative.to_string();
    match tokio::task::spawn_blocking(move || {
        file_diff_blocking(&workspace_root, &relative, max_bytes)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(GitFileDiffError::Git(
            "diff task failed to complete".to_string(),
        )),
    }
}

fn file_diff_blocking(
    workspace_root: &Path,
    relative: &str,
    max_bytes: u64,
) -> Result<GitFileDiff, GitFileDiffError> {
    let repo = gix::discover(workspace_root).map_err(|_| GitFileDiffError::NotARepo)?;
    let repo_workdir = repo.workdir().ok_or(GitFileDiffError::NotARepo)?;
    let repo_workdir = repo_workdir
        .canonicalize()
        .map_err(|error| GitFileDiffError::Workspace(WorkspaceError::Io(error)))?;

    let absolute = resolve_workspace_path(workspace_root, relative)?;
    let repo_relative_path = absolute
        .strip_prefix(&repo_workdir)
        .map_err(|_| GitFileDiffError::Workspace(WorkspaceError::OutsideWorkspace))?;
    let repo_relative = normalize_path(repo_relative_path);

    // Unborn HEAD (nothing committed yet) means every tracked-looking path is
    // effectively absent from HEAD, same as any other untracked/new file.
    let head_side = match repo.head_commit() {
        Ok(head_commit) => head_diff_side(&repo, &head_commit, &repo_relative, max_bytes)?,
        Err(_) => DiffSide::Absent,
    };

    // `fs::symlink_metadata` does not follow symlinks, so a symlink's own
    // target (read via `symlink_target_bytes`, matching Git's blob storage
    // for links) is compared against HEAD rather than the target file's
    // content — otherwise an unchanged symlink diffs as modified, and a
    // broken symlink's `NotFound` is misread as a deletion.
    let disk_side = match fs::symlink_metadata(&absolute) {
        Ok(metadata) if metadata.is_dir() => {
            return Err(GitFileDiffError::PathIsDirectory(relative.to_string()));
        }
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let target = symlink_target_bytes(&absolute).map_err(WorkspaceError::Io)?;
            DiffSide::Present {
                size: target.len() as u64,
                bytes: Some(target),
            }
        }
        // Stat the size before reading so a multi-GB changed file never gets
        // pulled fully into memory just to learn it's over `max_bytes` — the
        // bytes are only read when they'll actually be used for a diff.
        Ok(metadata) => {
            let size = metadata.len();
            let bytes = if size > max_bytes {
                None
            } else {
                Some(fs::read(&absolute).map_err(WorkspaceError::Io)?)
            };
            DiffSide::Present { size, bytes }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DiffSide::Absent,
        Err(error) => return Err(GitFileDiffError::Workspace(WorkspaceError::Io(error))),
    };

    let status = match (&head_side, &disk_side) {
        (DiffSide::Absent, DiffSide::Absent) => return Err(GitFileDiffError::NotFound),
        (DiffSide::Absent, DiffSide::Present { .. }) => GitFileStatus::Added,
        (DiffSide::Present { .. }, DiffSide::Absent) => GitFileStatus::Deleted,
        (DiffSide::Present { .. }, DiffSide::Present { .. }) => GitFileStatus::Modified,
    };

    let is_too_large = head_side.size() > max_bytes || disk_side.size() > max_bytes;

    let (original, modified, is_binary) = if is_too_large {
        (String::new(), String::new(), false)
    } else {
        let original_text = String::from_utf8(head_side.into_bytes().unwrap_or_default());
        let modified_text = String::from_utf8(disk_side.into_bytes().unwrap_or_default());
        let is_binary = original_text.is_err() || modified_text.is_err();
        if is_binary {
            (String::new(), String::new(), true)
        } else {
            (
                original_text.unwrap_or_default(),
                modified_text.unwrap_or_default(),
                false,
            )
        }
    };

    Ok(GitFileDiff {
        original,
        modified,
        status,
        is_binary,
        is_too_large,
    })
}

// One side of a worktree-vs-HEAD diff. Size is always known cheaply (a tree
// entry's header, or the file's stat); `bytes` is only populated when it fits
// `max_bytes`, so a huge tracked or untracked file never gets fully decoded
// or read just to determine it's too large to diff.
enum DiffSide {
    Absent,
    Present { size: u64, bytes: Option<Vec<u8>> },
}

impl DiffSide {
    fn size(&self) -> u64 {
        match self {
            DiffSide::Absent => 0,
            DiffSide::Present { size, .. } => *size,
        }
    }

    fn into_bytes(self) -> Option<Vec<u8>> {
        match self {
            DiffSide::Absent => None,
            DiffSide::Present { bytes, .. } => bytes,
        }
    }
}

fn head_diff_side(
    repo: &gix::Repository,
    head_commit: &gix::Commit<'_>,
    repo_relative_path: &str,
    max_bytes: u64,
) -> Result<DiffSide, GitFileDiffError> {
    let tree = head_commit
        .tree()
        .map_err(|error| GitFileDiffError::Git(error.to_string()))?;
    let Some(entry) = tree
        .lookup_entry_by_path(repo_relative_path)
        .map_err(|error| GitFileDiffError::Git(error.to_string()))?
    else {
        return Ok(DiffSide::Absent);
    };
    // `find_header` reads the object's size from its (loose or packed) header
    // without inflating the blob content, so the too-large check below never
    // pays for decoding a blob it's about to discard.
    let size = repo
        .find_header(entry.object_id())
        .map_err(|error| GitFileDiffError::Git(error.to_string()))?
        .size();
    let bytes = if size > max_bytes {
        None
    } else {
        let object = entry
            .object()
            .map_err(|error| GitFileDiffError::Git(error.to_string()))?;
        let blob = object
            .try_into_blob()
            .map_err(|error| GitFileDiffError::Git(error.to_string()))?;
        Some(blob.data.clone())
    };
    Ok(DiffSide::Present { size, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::process::Command as StdCommand;
    use tempfile::tempdir;

    #[tokio::test]
    async fn status_reports_not_a_repo_for_plain_directory() {
        let dir = tempdir().unwrap();

        let status = status_for_workspace(dir.path()).await;

        assert_eq!(status.status, GitStatusAvailability::Unsupported);
        assert!(status.files.is_empty());
    }

    #[tokio::test]
    async fn status_lists_untracked_modified_deleted_and_staged() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("committed.txt"), "one\n").unwrap();
        fs::write(dir.path().join("to-delete.txt"), "two\n").unwrap();
        commit_all(dir.path(), "Initial commit");

        fs::write(dir.path().join("committed.txt"), "one changed\n").unwrap();
        fs::remove_file(dir.path().join("to-delete.txt")).unwrap();
        fs::write(dir.path().join("untracked.txt"), "new\n").unwrap();
        run_git(dir.path(), ["add", "committed.txt"]);

        let status = status_for_workspace(dir.path()).await;

        assert_eq!(status.status, GitStatusAvailability::Available);
        let by_path: HashMap<_, _> = status
            .files
            .iter()
            .map(|entry| (entry.path.clone(), entry.clone()))
            .collect();

        let committed = by_path.get("committed.txt").unwrap();
        assert_eq!(committed.status, GitFileStatus::Modified);
        assert!(committed.staged);

        let deleted = by_path.get("to-delete.txt").unwrap();
        assert_eq!(deleted.status, GitFileStatus::Deleted);
        assert!(deleted.unstaged);

        let untracked = by_path.get("untracked.txt").unwrap();
        assert_eq!(untracked.status, GitFileStatus::Added);
        assert!(untracked.unstaged);
    }

    #[tokio::test]
    async fn status_respects_gitignore() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        commit_all(dir.path(), "Add gitignore");
        fs::write(dir.path().join("ignored.txt"), "secret\n").unwrap();

        let status = status_for_workspace(dir.path()).await;

        assert!(!status.files.iter().any(|entry| entry.path == "ignored.txt"));
    }

    #[tokio::test]
    async fn status_scopes_to_workspace_subdirectory() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/inside.txt"), "one\n").unwrap();
        fs::write(dir.path().join("outside.txt"), "two\n").unwrap();
        commit_all(dir.path(), "Initial commit");
        fs::write(dir.path().join("sub/inside.txt"), "one changed\n").unwrap();
        fs::write(dir.path().join("outside.txt"), "two changed\n").unwrap();

        let status = status_for_workspace(&dir.path().join("sub")).await;

        assert_eq!(status.status, GitStatusAvailability::Available);
        let paths: Vec<_> = status
            .files
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(paths, vec!["inside.txt"]);
    }

    #[tokio::test]
    async fn conflicted_files_are_scoped_to_the_workspace_subdirectory() {
        // `sync_workspace`/`complete_merge` (git_sync.rs) operate on the whole
        // repo, not just this workspace's subdirectory, so a conflict can land
        // on a file outside `sub/`. `conflicted_files` still scopes to the
        // workspace here, the same as the ordinary (non-conflict) file list —
        // `stage_resolved` resolves paths relative to `workspace_root` and
        // rejects `..`, so a repo-relative path for `outside.txt` would be
        // unusable, not just imprecise. `merge_in_progress` still flips true,
        // so the merge state itself isn't hidden — only the specific file.
        // Surfacing this conflict honestly (e.g. a count of conflicts outside
        // the workspace) is tracked in #50.
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        // `git merge` checks committer identity up front even for a merge that
        // ends in conflict (it never actually commits), so this needs identity
        // configured despite `commit_all` above not requiring it.
        configure_identity(dir.path());
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/inside.txt"), "one\n").unwrap();
        fs::write(dir.path().join("outside.txt"), "base\n").unwrap();
        commit_all(dir.path(), "Initial commit");

        run_git(dir.path(), ["checkout", "-b", "other"]);
        fs::write(dir.path().join("outside.txt"), "other change\n").unwrap();
        commit_all(dir.path(), "Other change");

        run_git(dir.path(), ["checkout", "main"]);
        fs::write(dir.path().join("outside.txt"), "main change\n").unwrap();
        commit_all(dir.path(), "Main change");

        let _ = git_stdout(dir.path(), ["merge", "other", "--no-edit"]);

        let status = status_for_workspace(&dir.path().join("sub")).await;

        assert!(status.merge_in_progress);
        assert_eq!(status.conflicted_files, Vec::<String>::new());
    }

    #[tokio::test]
    async fn status_reports_unborn_head_with_untracked_files() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();

        let status = status_for_workspace(dir.path()).await;

        assert_eq!(status.status, GitStatusAvailability::Available);
        assert!(status.head_unborn);
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "new.txt");
        assert_eq!(status.files[0].status, GitFileStatus::Added);
    }

    #[tokio::test]
    async fn commit_modified_file_advances_head_and_cleans_status() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());
        fs::write(dir.path().join("file.txt"), "before\n").unwrap();
        commit_all(dir.path(), "Initial commit");
        fs::write(dir.path().join("file.txt"), "after\n").unwrap();

        let result = commit_files(dir.path(), "Update file", &["file.txt".to_string()])
            .await
            .unwrap();

        assert!(result.branch.is_some());
        assert_eq!(
            git_stdout(dir.path(), ["show", "HEAD:file.txt"]).unwrap(),
            "after\n"
        );
        assert_eq!(
            git_stdout(dir.path(), ["log", "-1", "--pretty=%s"])
                .unwrap()
                .trim(),
            "Update file"
        );
        assert_eq!(
            git_stdout(dir.path(), ["status", "--porcelain"]).unwrap(),
            ""
        );
    }

    #[tokio::test]
    async fn commit_new_file_in_subdirectory() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());
        commit_all(dir.path(), "Initial commit");
        fs::create_dir(dir.path().join("nested")).unwrap();
        fs::write(dir.path().join("nested/new.txt"), "hello\n").unwrap();

        commit_files(
            dir.path(),
            "Add nested file",
            &["nested/new.txt".to_string()],
        )
        .await
        .unwrap();

        assert_eq!(
            git_stdout(dir.path(), ["show", "HEAD:nested/new.txt"]).unwrap(),
            "hello\n"
        );
        assert_eq!(
            git_stdout(dir.path(), ["status", "--porcelain"]).unwrap(),
            ""
        );
    }

    #[tokio::test]
    async fn commit_deleted_file() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());
        fs::write(dir.path().join("gone.txt"), "bye\n").unwrap();
        commit_all(dir.path(), "Initial commit");
        fs::remove_file(dir.path().join("gone.txt")).unwrap();

        commit_files(dir.path(), "Delete file", &["gone.txt".to_string()])
            .await
            .unwrap();

        assert!(git_stdout(dir.path(), ["show", "HEAD:gone.txt"]).is_err());
        assert_eq!(
            git_stdout(dir.path(), ["status", "--porcelain"]).unwrap(),
            ""
        );
    }

    #[tokio::test]
    async fn commit_deleted_file_whose_parent_dir_is_gone() {
        // Deleting a whole directory (e.g. `.config/opencode`) removes the parent of
        // every file under it, so path resolution must not require the parent to exist.
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());
        fs::create_dir(dir.path().join("nested")).unwrap();
        fs::write(dir.path().join("nested/gone.txt"), "bye\n").unwrap();
        commit_all(dir.path(), "Initial commit");
        fs::remove_dir_all(dir.path().join("nested")).unwrap();

        commit_files(
            dir.path(),
            "Delete nested",
            &["nested/gone.txt".to_string()],
        )
        .await
        .unwrap();

        assert!(git_stdout(dir.path(), ["show", "HEAD:nested/gone.txt"]).is_err());
        assert_eq!(
            git_stdout(dir.path(), ["status", "--porcelain"]).unwrap(),
            ""
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn commit_preserves_executable_bit() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());
        commit_all(dir.path(), "Initial commit");
        let script_path = dir.path().join("run.sh");
        fs::write(&script_path, "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755)).unwrap();

        commit_files(dir.path(), "Add script", &["run.sh".to_string()])
            .await
            .unwrap();

        let ls_tree = git_stdout(dir.path(), ["ls-tree", "HEAD", "run.sh"]).unwrap();
        assert!(ls_tree.starts_with("100755"), "unexpected mode: {ls_tree}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn commit_preserves_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());
        commit_all(dir.path(), "Initial commit");
        symlink("target.txt", dir.path().join("link.txt")).unwrap();

        commit_files(dir.path(), "Add symlink", &["link.txt".to_string()])
            .await
            .unwrap();

        let ls_tree = git_stdout(dir.path(), ["ls-tree", "HEAD", "link.txt"]).unwrap();
        assert!(ls_tree.starts_with("120000"), "unexpected mode: {ls_tree}");
        assert_eq!(
            git_stdout(dir.path(), ["show", "HEAD:link.txt"]).unwrap(),
            "target.txt"
        );
    }

    #[tokio::test]
    async fn commit_creates_initial_commit_on_unborn_head() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());
        fs::write(dir.path().join("first.txt"), "hello\n").unwrap();

        let result = commit_files(dir.path(), "Initial commit", &["first.txt".to_string()])
            .await
            .unwrap();

        assert!(result.branch.is_some());
        assert_eq!(
            git_stdout(dir.path(), ["rev-list", "--count", "HEAD"])
                .unwrap()
                .trim(),
            "1"
        );
    }

    #[tokio::test]
    async fn commit_rejects_no_changes_on_unborn_head() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());

        // Selecting a path that was never created edits nothing on an unborn
        // HEAD (the tree stays the empty tree), so this must reject with
        // NoChanges rather than creating an empty initial commit.
        let error = commit_files(dir.path(), "Initial commit", &["missing.txt".to_string()])
            .await
            .unwrap_err();

        assert!(matches!(error, GitCommitError::NoChanges));
        // HEAD is still unborn — no commit was created.
        assert!(git_stdout(dir.path(), ["rev-parse", "--verify", "HEAD"]).is_err());
    }

    #[tokio::test]
    async fn commit_on_detached_head_advances_head_only() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());
        fs::write(dir.path().join("file.txt"), "one\n").unwrap();
        commit_all(dir.path(), "Initial commit");
        let head_sha = git_stdout(dir.path(), ["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        run_git(dir.path(), ["checkout", "--detach", &head_sha]);
        fs::write(dir.path().join("file.txt"), "two\n").unwrap();

        let result = commit_files(dir.path(), "Detached commit", &["file.txt".to_string()])
            .await
            .unwrap();

        assert_eq!(result.branch, None);
        // The branch ref must not have moved; only the detached HEAD did.
        let main_sha = git_stdout(dir.path(), ["rev-parse", "refs/heads/main"]).unwrap();
        assert_eq!(main_sha.trim(), head_sha);
        let head_after = git_stdout(dir.path(), ["rev-parse", "HEAD"]).unwrap();
        assert_ne!(head_after.trim(), head_sha);
    }

    #[tokio::test]
    async fn commit_leaves_unselected_dirty_files_untouched() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());
        fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        fs::write(dir.path().join("b.txt"), "b\n").unwrap();
        commit_all(dir.path(), "Initial commit");
        fs::write(dir.path().join("a.txt"), "a changed\n").unwrap();
        fs::write(dir.path().join("b.txt"), "b changed\n").unwrap();

        commit_files(dir.path(), "Update a only", &["a.txt".to_string()])
            .await
            .unwrap();

        let porcelain = git_stdout(dir.path(), ["status", "--porcelain"]).unwrap();
        assert_eq!(porcelain.trim(), "M b.txt");
        assert_eq!(
            git_stdout(dir.path(), ["show", "HEAD:b.txt"]).unwrap(),
            "b\n"
        );
    }

    #[tokio::test]
    async fn commit_rejects_empty_message_and_empty_selection() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());
        fs::write(dir.path().join("a.txt"), "a\n").unwrap();

        let empty_message = commit_files(dir.path(), "   ", &["a.txt".to_string()]).await;
        assert!(matches!(empty_message, Err(GitCommitError::EmptyMessage)));

        let empty_selection = commit_files(dir.path(), "message", &[]).await;
        assert!(matches!(
            empty_selection,
            Err(GitCommitError::EmptySelection)
        ));
    }

    #[tokio::test]
    async fn commit_rejects_path_traversal() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());

        let result = commit_files(dir.path(), "message", &["../outside.txt".to_string()]).await;

        assert!(matches!(
            result,
            Err(GitCommitError::Workspace(WorkspaceError::InvalidPath))
        ));
    }

    #[tokio::test]
    async fn commit_rejects_missing_author() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("a.txt"), "a\n").unwrap();

        // Isolated: ignores system/global config and env vars, so this repo's
        // unset local identity is what gets exercised — no env-var races.
        let repo = gix::open_opts(dir.path(), gix::open::Options::isolated()).unwrap();
        let result = commit_files_in_repo(&repo, dir.path(), "message", &["a.txt".to_string()]);

        assert!(matches!(result, Err(GitCommitError::AuthorUnset)));
    }

    #[tokio::test]
    async fn commit_workspace_subdir_maps_paths_to_repo_relative() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        configure_identity(dir.path());
        fs::create_dir(dir.path().join("sub")).unwrap();
        commit_all(dir.path(), "Initial commit");
        fs::write(dir.path().join("sub/file.txt"), "hello\n").unwrap();

        commit_files(
            &dir.path().join("sub"),
            "Add file",
            &["file.txt".to_string()],
        )
        .await
        .unwrap();

        assert_eq!(
            git_stdout(dir.path(), ["show", "HEAD:sub/file.txt"]).unwrap(),
            "hello\n"
        );
    }

    const TEST_MAX_BYTES: u64 = 1024 * 1024;

    #[tokio::test]
    async fn file_diff_reports_modified_file() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("file.txt"), "before\n").unwrap();
        commit_all(dir.path(), "Initial commit");
        fs::write(dir.path().join("file.txt"), "after\n").unwrap();

        let diff = file_diff(dir.path(), "file.txt", TEST_MAX_BYTES)
            .await
            .unwrap();

        assert_eq!(diff.status, GitFileStatus::Modified);
        assert_eq!(diff.original, "before\n");
        assert_eq!(diff.modified, "after\n");
        assert!(!diff.is_binary);
        assert!(!diff.is_too_large);
    }

    #[tokio::test]
    async fn file_diff_reports_added_file() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        commit_all(dir.path(), "Initial commit");
        fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();

        let diff = file_diff(dir.path(), "new.txt", TEST_MAX_BYTES)
            .await
            .unwrap();

        assert_eq!(diff.status, GitFileStatus::Added);
        assert_eq!(diff.original, "");
        assert_eq!(diff.modified, "fresh\n");
    }

    #[tokio::test]
    async fn file_diff_reports_deleted_file() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("gone.txt"), "bye\n").unwrap();
        commit_all(dir.path(), "Initial commit");
        fs::remove_file(dir.path().join("gone.txt")).unwrap();

        let diff = file_diff(dir.path(), "gone.txt", TEST_MAX_BYTES)
            .await
            .unwrap();

        assert_eq!(diff.status, GitFileStatus::Deleted);
        assert_eq!(diff.original, "bye\n");
        assert_eq!(diff.modified, "");
    }

    #[tokio::test]
    async fn file_diff_flags_binary_content() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("image.bin"), [0u8, 159, 146, 150]).unwrap();
        commit_all(dir.path(), "Initial commit");
        fs::write(dir.path().join("image.bin"), [0u8, 159, 146, 151]).unwrap();

        let diff = file_diff(dir.path(), "image.bin", TEST_MAX_BYTES)
            .await
            .unwrap();

        assert!(diff.is_binary);
        assert_eq!(diff.original, "");
        assert_eq!(diff.modified, "");
    }

    #[tokio::test]
    async fn file_diff_flags_too_large_content() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("big.txt"), "before\n").unwrap();
        commit_all(dir.path(), "Initial commit");
        fs::write(dir.path().join("big.txt"), "a".repeat(64)).unwrap();

        let diff = file_diff(dir.path(), "big.txt", 32).await.unwrap();

        assert!(diff.is_too_large);
        assert_eq!(diff.original, "");
        assert_eq!(diff.modified, "");
    }

    #[tokio::test]
    async fn file_diff_rejects_path_absent_from_head_and_disk() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        commit_all(dir.path(), "Initial commit");

        let result = file_diff(dir.path(), "never-existed.txt", TEST_MAX_BYTES).await;

        assert!(matches!(result, Err(GitFileDiffError::NotFound)));
    }

    fn init_repo(cwd: &Path) {
        run_git(cwd, ["init"]);
        run_git(cwd, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    }

    // Sets a local (repo-only) identity so `commit_files` (which reads the
    // repo's normal, non-isolated config) finds an author/committer regardless
    // of what the host machine or CI runner has configured globally.
    fn configure_identity(cwd: &Path) {
        run_git(cwd, ["config", "user.name", "Test User"]);
        run_git(cwd, ["config", "user.email", "test@example.com"]);
    }

    // Builds setup commits via plumbing (write-tree/commit-tree/update-ref) so
    // these never touch commit signing or depend on repo-local identity config —
    // same approach as git_attribution.rs's harness.
    fn commit_all(cwd: &Path, message: &'static str) {
        run_git(cwd, ["add", "."]);
        let tree = git_stdout(cwd, ["write-tree"]).expect("write-tree should succeed");
        let parent = git_stdout(cwd, ["rev-parse", "--verify", "HEAD"]).ok();
        let mut args = vec!["commit-tree", tree.trim()];
        if let Some(parent) = parent.as_ref() {
            args.extend(["-p", parent.trim()]);
        }
        args.extend(["-m", message]);
        let commit = git_stdout_with_env(
            cwd,
            args,
            [
                ("GIT_AUTHOR_NAME", "Test User"),
                ("GIT_AUTHOR_EMAIL", "test@example.com"),
                ("GIT_AUTHOR_DATE", "1700000000 +0000"),
                ("GIT_COMMITTER_NAME", "Test User"),
                ("GIT_COMMITTER_EMAIL", "test@example.com"),
                ("GIT_COMMITTER_DATE", "1700000000 +0000"),
            ],
        )
        .expect("commit-tree should succeed");
        let branch =
            git_stdout(cwd, ["symbolic-ref", "HEAD"]).expect("symbolic-ref should succeed");
        run_git(cwd, ["update-ref", branch.trim(), commit.trim()]);
    }

    fn run_git<I, S>(cwd: &Path, args: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        git_stdout(cwd, args).expect("git should succeed");
    }

    fn git_stdout<I, S>(cwd: &Path, args: I) -> Result<String, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        git_stdout_with_env(cwd, args, std::iter::empty::<(&str, &str)>())
    }

    fn git_stdout_with_env<I, S, E>(cwd: &Path, args: I, envs: E) -> Result<String, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
        E: IntoIterator<Item = (&'static str, &'static str)>,
    {
        let output = StdCommand::new("git")
            .args(args)
            .envs(envs)
            .current_dir(cwd)
            .output()
            .unwrap();
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }
}
