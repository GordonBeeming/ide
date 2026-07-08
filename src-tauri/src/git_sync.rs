// Network Git operations (fetch/pull/push) shell out to the system `git` binary
// rather than gix. Transport, credential helpers, SSH agents, and any GitButler
// hooks all live in the user's real git; reimplementing that in gix would be a
// rabbit hole and would ignore the auth the user has already configured. The
// blocking process work is offloaded with `spawn_blocking`, mirroring
// git_commit::commit_files.
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};

use serde::Serialize;

use crate::workspace::{resolve_workspace_path, WorkspaceError};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
// Internally tagged so the frontend reads one `outcome` discriminant instead of
// serde's default externally-tagged wrapper object. Matches the camelCase shape
// the other git types serialize with.
#[serde(tag = "outcome", rename_all = "camelCase")]
pub(crate) enum GitSyncResult {
    /// Local and upstream already point at the same commit; nothing moved.
    UpToDate { branch: String },
    /// The sync moved commits in one or both directions. `pulled`/`pushed` are
    /// commit counts, purely informational for the UI.
    Synced {
        branch: String,
        pulled: usize,
        pushed: usize,
    },
    /// The branch has no tracking remote, so there is nothing to sync against.
    /// Surfaced as a result rather than an error because it is an ordinary
    /// state (a fresh local branch), not a failure to recover from.
    NoUpstream { branch: String },
    /// A pull left the worktree in a conflicted merge the user must resolve.
    /// `files` lists the unmerged paths so the UI can point at them.
    MergeConflict { branch: String, files: Vec<String> },
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum GitSyncError {
    #[error("workspace is not inside a Git repository")]
    NotARepo,
    #[error("git executable not found on PATH")]
    GitUnavailable,
    #[error("no merge is in progress")]
    NoMergeInProgress,
    #[error("{0} still contains conflict markers")]
    ConflictMarkers(String),
    #[error("resolve all conflicts before completing the merge")]
    UnresolvedConflicts,
    #[error("{0}")]
    Workspace(#[from] WorkspaceError),
    #[error("{0}")]
    Failed(String),
}

/// The commit that finished a merge, mirroring `GitCommitResult`'s shape.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitMergeCommit {
    pub sha: String,
    pub short_sha: String,
    pub branch: Option<String>,
}

pub(crate) async fn sync_workspace(workspace_root: &Path) -> Result<GitSyncResult, GitSyncError> {
    let workspace_root = workspace_root.to_path_buf();
    match tokio::task::spawn_blocking(move || sync_workspace_blocking(&workspace_root)).await {
        Ok(result) => result,
        Err(_) => Err(GitSyncError::Failed(
            "sync task failed to complete".to_string(),
        )),
    }
}

fn sync_workspace_blocking(workspace_root: &Path) -> Result<GitSyncResult, GitSyncError> {
    let program = resolve_git_program().ok_or(GitSyncError::GitUnavailable)?;
    let git = GitCli {
        program,
        workdir: workspace_root.to_path_buf(),
    };

    ensure_repo(&git)?;

    // `--abbrev-ref HEAD` is "HEAD" on a detached checkout; that flows through to
    // a NoUpstream result below (a detached HEAD has no tracking branch).
    let branch = git
        .run(&["rev-parse", "--abbrev-ref", "HEAD"])?
        .stdout
        .trim()
        .to_string();

    // A merge left half-finished before this sync ran (conflict markers still on
    // disk, or resolved-but-not-committed) must be reported instead of stacking
    // another fetch/pull on top of it.
    if let Some(git_dir) = git.absolute_git_dir()? {
        if git_dir.join("MERGE_HEAD").exists() {
            return Ok(GitSyncResult::MergeConflict {
                branch,
                files: git.conflicted_files()?,
            });
        }
    }

    // No configured tracking remote means there is nothing to fetch/push against.
    // The remote is read from branch config so the branch name may safely contain
    // slashes (splitting `@{upstream}` on `/` would not).
    let remote = git.branch_remote(&branch)?;
    let Some(remote) = remote else {
        return Ok(GitSyncResult::NoUpstream { branch });
    };
    // The tracking ref must also resolve; a configured remote with no matching
    // upstream ref (e.g. never pushed) is still "no upstream" for our purposes.
    if !git
        .run(&[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ])?
        .success
    {
        return Ok(GitSyncResult::NoUpstream { branch });
    }

    let fetch = git.run(&["fetch", &remote])?;
    if !fetch.success {
        return Err(GitSyncError::Failed(git_message(
            &fetch,
            "git fetch failed",
        )));
    }

    // Counts are taken after the fetch updated the tracking ref, so they reflect
    // the real divergence the pull/push are about to reconcile.
    let behind = git.rev_count("HEAD..@{upstream}")?;

    if behind > 0 {
        let pull = git.run(&["pull", "--no-edit"])?;
        if !pull.success {
            let conflicts = git.conflicted_files()?;
            let mid_merge = git
                .absolute_git_dir()?
                .map(|dir| dir.join("MERGE_HEAD").exists())
                .unwrap_or(false);
            if !conflicts.is_empty() || mid_merge {
                return Ok(GitSyncResult::MergeConflict {
                    branch,
                    files: conflicts,
                });
            }
            return Err(GitSyncError::Failed(git_message(&pull, "git pull failed")));
        }
    }

    // Recount ahead after the pull: a merge commit shifts the count, so this is
    // the number of commits the push actually sends.
    let ahead = git.rev_count("@{upstream}..HEAD")?;
    if ahead > 0 {
        let push = git.run(&["push"])?;
        if !push.success {
            return Err(GitSyncError::Failed(git_message(&push, "git push failed")));
        }
    }

    let pulled = behind;
    let pushed = ahead;
    if pulled == 0 && pushed == 0 {
        Ok(GitSyncResult::UpToDate { branch })
    } else {
        Ok(GitSyncResult::Synced {
            branch,
            pulled,
            pushed,
        })
    }
}

pub(crate) async fn stage_resolved(workspace_root: &Path, path: &str) -> Result<(), GitSyncError> {
    let workspace_root = workspace_root.to_path_buf();
    let path = path.to_string();
    match tokio::task::spawn_blocking(move || stage_resolved_blocking(&workspace_root, &path)).await
    {
        Ok(result) => result,
        Err(_) => Err(GitSyncError::Failed(
            "stage task failed to complete".to_string(),
        )),
    }
}

fn stage_resolved_blocking(workspace_root: &Path, path: &str) -> Result<(), GitSyncError> {
    let program = resolve_git_program().ok_or(GitSyncError::GitUnavailable)?;
    let git = GitCli {
        program,
        workdir: workspace_root.to_path_buf(),
    };
    ensure_repo(&git)?;

    let absolute = resolve_workspace_path(workspace_root, path)?;
    // Refuse to stage a file that still carries conflict markers — otherwise
    // `git add` would mark a still-conflicted file resolved and the markers would
    // land in the merge commit. Binary / non-UTF-8 content has no textual markers,
    // so it stages as-is (resolving a binary conflict means picking a side).
    match std::fs::read(&absolute) {
        Ok(bytes) => {
            if let Ok(text) = std::str::from_utf8(&bytes) {
                if has_conflict_markers(text) {
                    return Err(GitSyncError::ConflictMarkers(path.to_string()));
                }
            }
        }
        Err(error) => return Err(GitSyncError::Workspace(WorkspaceError::Io(error))),
    }

    let add = git.run(&["add", "--", path])?;
    if !add.success {
        return Err(GitSyncError::Failed(git_message(&add, "git add failed")));
    }
    Ok(())
}

pub(crate) async fn complete_merge(workspace_root: &Path) -> Result<GitMergeCommit, GitSyncError> {
    let workspace_root = workspace_root.to_path_buf();
    match tokio::task::spawn_blocking(move || complete_merge_blocking(&workspace_root)).await {
        Ok(result) => result,
        Err(_) => Err(GitSyncError::Failed(
            "merge task failed to complete".to_string(),
        )),
    }
}

fn complete_merge_blocking(workspace_root: &Path) -> Result<GitMergeCommit, GitSyncError> {
    let program = resolve_git_program().ok_or(GitSyncError::GitUnavailable)?;
    let git = GitCli {
        program,
        workdir: workspace_root.to_path_buf(),
    };
    ensure_repo(&git)?;

    let mid_merge = git
        .absolute_git_dir()?
        .map(|dir| dir.join("MERGE_HEAD").exists())
        .unwrap_or(false);
    if !mid_merge {
        return Err(GitSyncError::NoMergeInProgress);
    }
    if !git.conflicted_files()?.is_empty() {
        return Err(GitSyncError::UnresolvedConflicts);
    }

    // Belt-and-braces: a file staged outside the app (a terminal `git add` that
    // bypassed the marker check in stage_resolved) clears the unmerged-entry check
    // above yet can still carry markers. `git commit` would happily commit them, so
    // scan every staged file's content and refuse if any conflict marker remains.
    if let Some(path) = git.staged_file_with_conflict_markers()? {
        return Err(GitSyncError::ConflictMarkers(path));
    }

    // `--no-edit` keeps git's generated merge message; git commits both parents
    // (HEAD + MERGE_HEAD) and clears the merge state on success.
    let commit = git.run(&["commit", "--no-edit"])?;
    if !commit.success {
        return Err(GitSyncError::Failed(git_message(
            &commit,
            "git commit failed",
        )));
    }

    let sha = git.run(&["rev-parse", "HEAD"])?.stdout.trim().to_string();
    let short_sha = git
        .run(&["rev-parse", "--short", "HEAD"])?
        .stdout
        .trim()
        .to_string();
    let branch_output = git.run(&["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let branch = if branch_output.success {
        let name = branch_output.stdout.trim();
        (!name.is_empty()).then(|| name.to_string())
    } else {
        None
    };

    Ok(GitMergeCommit {
        sha,
        short_sha,
        branch,
    })
}

fn ensure_repo(git: &GitCli) -> Result<(), GitSyncError> {
    // git itself decides whether this directory is inside a work tree, so a
    // workspace opened on a repo subdirectory still resolves correctly.
    let inside = git.run(&["rev-parse", "--is-inside-work-tree"])?;
    if !inside.success || inside.stdout.trim() != "true" {
        return Err(GitSyncError::NotARepo);
    }
    Ok(())
}

// Standard git conflict markers: `<<<<<<<` (ours), `>>>>>>>` (theirs), and
// `|||||||` (the base, in diff3 style). The `=======` separator is deliberately
// not matched — it occurs often in ordinary text (underlines, rules) and the
// start/end markers are enough to prove a conflict is unresolved.
fn has_conflict_markers(contents: &str) -> bool {
    contents.lines().any(|line| {
        line.starts_with("<<<<<<<") || line.starts_with(">>>>>>>") || line.starts_with("|||||||")
    })
}

struct GitCli {
    program: OsString,
    workdir: PathBuf,
}

struct GitOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

impl GitCli {
    fn run(&self, args: &[&str]) -> Result<GitOutput, GitSyncError> {
        let output = StdCommand::new(&self.program)
            .args(args)
            .current_dir(&self.workdir)
            .output()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    GitSyncError::GitUnavailable
                } else {
                    GitSyncError::Failed(error.to_string())
                }
            })?;
        Ok(GitOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    fn absolute_git_dir(&self) -> Result<Option<PathBuf>, GitSyncError> {
        let output = self.run(&["rev-parse", "--absolute-git-dir"])?;
        if !output.success {
            return Ok(None);
        }
        let trimmed = output.stdout.trim();
        if trimmed.is_empty() {
            Ok(None)
        } else {
            Ok(Some(PathBuf::from(trimmed)))
        }
    }

    fn branch_remote(&self, branch: &str) -> Result<Option<String>, GitSyncError> {
        let key = format!("branch.{branch}.remote");
        let output = self.run(&["config", "--get", &key])?;
        if !output.success {
            return Ok(None);
        }
        let trimmed = output.stdout.trim();
        if trimmed.is_empty() {
            Ok(None)
        } else {
            Ok(Some(trimmed.to_string()))
        }
    }

    fn rev_count(&self, range: &str) -> Result<usize, GitSyncError> {
        let output = self.run(&["rev-list", "--count", range])?;
        if !output.success {
            return Err(GitSyncError::Failed(git_message(
                &output,
                "git rev-list failed",
            )));
        }
        output
            .stdout
            .trim()
            .parse::<usize>()
            .map_err(|error| GitSyncError::Failed(format!("unexpected rev-list output: {error}")))
    }

    fn conflicted_files(&self) -> Result<Vec<String>, GitSyncError> {
        let output = self.run(&["status", "--porcelain"])?;
        if !output.success {
            return Err(GitSyncError::Failed(git_message(
                &output,
                "git status failed",
            )));
        }
        let mut files = Vec::new();
        for line in output.stdout.lines() {
            // Porcelain v1 lines are `XY <path>`; the two status codes plus a
            // space are a fixed 3-char prefix.
            if line.len() < 4 {
                continue;
            }
            let code = &line[..2];
            if is_unmerged_code(code) {
                files.push(line[3..].to_string());
            }
        }
        Ok(files)
    }

    // Returns the first staged file (if any) whose content still contains conflict
    // markers. Paths come back relative to the repo root, so they're joined onto
    // `--show-toplevel` to read regardless of which subdirectory is the workspace.
    fn staged_file_with_conflict_markers(&self) -> Result<Option<String>, GitSyncError> {
        let toplevel = self.run(&["rev-parse", "--show-toplevel"])?;
        if !toplevel.success {
            return Err(GitSyncError::Failed(git_message(
                &toplevel,
                "git rev-parse failed",
            )));
        }
        let repo_root = PathBuf::from(toplevel.stdout.trim());

        // `-z` gives NUL-separated, unquoted paths so names with spaces or unusual
        // characters are read back exactly.
        let staged = self.run(&["diff", "--cached", "--name-only", "-z"])?;
        if !staged.success {
            return Err(GitSyncError::Failed(git_message(
                &staged,
                "git diff failed",
            )));
        }
        for rela in staged.stdout.split('\0').filter(|entry| !entry.is_empty()) {
            // A staged deletion has no file to read; skip anything unreadable or
            // non-UTF-8 (binary), which cannot carry textual markers anyway.
            if let Ok(bytes) = std::fs::read(repo_root.join(rela)) {
                if let Ok(text) = std::str::from_utf8(&bytes) {
                    if has_conflict_markers(text) {
                        return Ok(Some(rela.to_string()));
                    }
                }
            }
        }
        Ok(None)
    }
}

// The seven porcelain status pairs Git uses for unmerged (conflicted) entries.
fn is_unmerged_code(code: &str) -> bool {
    matches!(code, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU")
}

// Prefer git's own stderr (the actionable message) and fall back to a generic
// label only when it wrote nothing there.
fn git_message(output: &GitOutput, fallback: &str) -> String {
    let stderr = output.stderr.trim();
    if stderr.is_empty() {
        fallback.to_string()
    } else {
        stderr.to_string()
    }
}

fn resolve_git_program() -> Option<OsString> {
    // Prefer PATH resolution so the user's configured git (and its credential
    // helpers) win. Fall back to well-known install locations because a bundled
    // .app can launch with a minimal PATH that omits Homebrew and /usr paths.
    let candidates = [
        OsString::from("git"),
        OsString::from("/opt/homebrew/bin/git"),
        OsString::from("/usr/bin/git"),
        OsString::from("/usr/local/bin/git"),
    ];
    candidates
        .into_iter()
        .find(|candidate| git_version_ok(candidate))
}

fn git_version_ok(program: &OsStr) -> bool {
    StdCommand::new(program)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::fs;
    use std::process::Command as StdCommand;
    use tempfile::tempdir;

    #[tokio::test]
    async fn sync_reports_not_a_repo_for_plain_directory() {
        let dir = tempdir().unwrap();

        let result = sync_workspace(dir.path()).await;

        assert!(matches!(result, Err(GitSyncError::NotARepo)));
    }

    #[tokio::test]
    async fn sync_reports_no_upstream_for_untracked_branch() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("file.txt"), "one\n").unwrap();
        run_git(dir.path(), ["add", "."]);
        run_git(dir.path(), ["commit", "-m", "Initial commit"]);

        let result = sync_workspace(dir.path()).await.unwrap();

        assert_eq!(
            result,
            GitSyncResult::NoUpstream {
                branch: "main".to_string()
            }
        );
    }

    #[tokio::test]
    async fn sync_reports_up_to_date_when_local_matches_remote() {
        let remote = tempdir().unwrap();
        init_bare_remote(remote.path());
        let work = tempdir().unwrap();
        clone_with_commit(remote.path(), work.path());

        let result = sync_workspace(work.path()).await.unwrap();

        assert_eq!(
            result,
            GitSyncResult::UpToDate {
                branch: "main".to_string()
            }
        );
    }

    #[tokio::test]
    async fn sync_pushes_local_commits_that_are_ahead() {
        let remote = tempdir().unwrap();
        init_bare_remote(remote.path());
        let work = tempdir().unwrap();
        clone_with_commit(remote.path(), work.path());

        fs::write(work.path().join("second.txt"), "local\n").unwrap();
        run_git(work.path(), ["add", "."]);
        run_git(work.path(), ["commit", "-m", "Local commit"]);

        let result = sync_workspace(work.path()).await.unwrap();

        assert_eq!(
            result,
            GitSyncResult::Synced {
                branch: "main".to_string(),
                pulled: 0,
                pushed: 1,
            }
        );
        // The remote now carries the pushed commit.
        assert_eq!(
            git_stdout(remote.path(), ["rev-list", "--count", "main"])
                .unwrap()
                .trim(),
            "2"
        );
    }

    #[tokio::test]
    async fn sync_fast_forward_pulls_remote_commits_that_are_behind() {
        let remote = tempdir().unwrap();
        init_bare_remote(remote.path());
        let work = tempdir().unwrap();
        clone_with_commit(remote.path(), work.path());

        // A second clone advances the remote so `work` falls one commit behind.
        let other = tempdir().unwrap();
        clone_existing(remote.path(), other.path());
        fs::write(other.path().join("from-other.txt"), "remote\n").unwrap();
        run_git(other.path(), ["add", "."]);
        run_git(other.path(), ["commit", "-m", "Remote commit"]);
        run_git(other.path(), ["push"]);

        let result = sync_workspace(work.path()).await.unwrap();

        assert_eq!(
            result,
            GitSyncResult::Synced {
                branch: "main".to_string(),
                pulled: 1,
                pushed: 0,
            }
        );
        assert_eq!(
            git_stdout(work.path(), ["cat-file", "-e", "HEAD:from-other.txt"]).map(|_| ()),
            Ok(())
        );
    }

    #[tokio::test]
    async fn sync_reports_merge_conflict_on_divergent_change() {
        let (_remote, work, _other) = conflicted_workspace();

        let result = sync_workspace(work.path()).await.unwrap();

        match result {
            GitSyncResult::MergeConflict { branch, files } => {
                assert_eq!(branch, "main");
                assert_eq!(files, vec!["conflict.txt".to_string()]);
            }
            other => panic!("expected MergeConflict, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn conflict_surfaces_in_git_status_merge_fields() {
        let (_remote, work, _other) = conflicted_workspace();
        sync_workspace(work.path()).await.unwrap();

        let status = crate::git_commit::status_for_workspace(work.path()).await;

        assert!(status.merge_in_progress);
        assert_eq!(status.conflicted_files, vec!["conflict.txt".to_string()]);
    }

    #[tokio::test]
    async fn stage_resolved_refuses_a_file_with_conflict_markers() {
        let (_remote, work, _other) = conflicted_workspace();
        // The failed pull leaves conflict markers on disk; staging must refuse.
        sync_workspace(work.path()).await.unwrap();

        let error = stage_resolved(work.path(), "conflict.txt")
            .await
            .unwrap_err();

        assert!(matches!(error, GitSyncError::ConflictMarkers(path) if path == "conflict.txt"));
    }

    #[tokio::test]
    async fn stage_resolved_then_complete_merge_finishes_the_merge() {
        let (remote, work, _other) = conflicted_workspace();
        sync_workspace(work.path()).await.unwrap();

        // Resolve by removing the markers, then stage and complete the merge.
        fs::write(work.path().join("conflict.txt"), "resolved\n").unwrap();
        stage_resolved(work.path(), "conflict.txt").await.unwrap();

        let result = complete_merge(work.path()).await.unwrap();

        assert_eq!(result.branch, Some("main".to_string()));
        // The merge state is cleared and HEAD is a two-parent merge commit.
        assert!(!work.path().join(".git/MERGE_HEAD").exists());
        assert_eq!(
            git_stdout(work.path(), ["rev-list", "--count", "--merges", "HEAD"])
                .unwrap()
                .trim(),
            "1"
        );
        // The resolved content is what got committed.
        assert_eq!(
            git_stdout(work.path(), ["show", "HEAD:conflict.txt"]).unwrap(),
            "resolved\n"
        );
        drop(remote);
    }

    #[tokio::test]
    async fn complete_merge_errors_when_no_merge_in_progress() {
        let remote = tempdir().unwrap();
        init_bare_remote(remote.path());
        let work = tempdir().unwrap();
        clone_with_commit(remote.path(), work.path());

        let error = complete_merge(work.path()).await.unwrap_err();

        assert!(matches!(error, GitSyncError::NoMergeInProgress));
    }

    #[tokio::test]
    async fn complete_merge_errors_while_conflicts_remain_unresolved() {
        let (_remote, work, _other) = conflicted_workspace();
        sync_workspace(work.path()).await.unwrap();

        let error = complete_merge(work.path()).await.unwrap_err();

        assert!(matches!(error, GitSyncError::UnresolvedConflicts));
    }

    #[tokio::test]
    async fn complete_merge_refuses_a_terminal_staged_file_with_markers() {
        let (_remote, work, _other) = conflicted_workspace();
        sync_workspace(work.path()).await.unwrap();
        // A terminal `git add` marks the conflict resolved without removing the
        // markers, clearing the unmerged-entry gate but not the marker scan.
        run_git(work.path(), ["add", "conflict.txt"]);

        let error = complete_merge(work.path()).await.unwrap_err();

        assert!(matches!(error, GitSyncError::ConflictMarkers(path) if path == "conflict.txt"));
    }

    // Leaves `work` one local commit and one remote commit apart on `conflict.txt`,
    // so a pull produces an unresolved merge conflict on that file.
    fn conflicted_workspace() -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir) {
        let remote = tempdir().unwrap();
        init_bare_remote(remote.path());
        let work = tempdir().unwrap();
        clone_with_commit(remote.path(), work.path());
        fs::write(work.path().join("conflict.txt"), "base\n").unwrap();
        run_git(work.path(), ["add", "."]);
        run_git(work.path(), ["commit", "-m", "Add shared file"]);
        run_git(work.path(), ["push"]);

        let other = tempdir().unwrap();
        clone_existing(remote.path(), other.path());
        fs::write(other.path().join("conflict.txt"), "remote change\n").unwrap();
        run_git(other.path(), ["add", "."]);
        run_git(other.path(), ["commit", "-m", "Remote edit"]);
        run_git(other.path(), ["push"]);

        fs::write(work.path().join("conflict.txt"), "local change\n").unwrap();
        run_git(work.path(), ["add", "."]);
        run_git(work.path(), ["commit", "-m", "Local edit"]);

        (remote, work, other)
    }

    fn init_repo(cwd: &Path) {
        run_git(cwd, ["init", "-b", "main"]);
        configure_identity(cwd);
    }

    fn init_bare_remote(cwd: &Path) {
        run_git(cwd, ["init", "--bare", "-b", "main"]);
    }

    // Clones the remote, sets identity, and lands one commit so `main` exists on
    // both ends with an upstream tracking ref configured.
    fn clone_with_commit(remote: &Path, work: &Path) {
        clone_existing(remote, work);
        fs::write(work.join("first.txt"), "hello\n").unwrap();
        run_git(work, ["add", "."]);
        run_git(work, ["commit", "-m", "Initial commit"]);
        run_git(work, ["push", "-u", "origin", "main"]);
    }

    fn clone_existing(remote: &Path, work: &Path) {
        run_git(
            work.parent().unwrap(),
            ["clone", remote.to_str().unwrap(), work.to_str().unwrap()],
        );
        configure_identity(work);
    }

    // Local (repo-only) identity plus disabled signing so these tests never
    // depend on — or trip over — the host machine's global Git config.
    fn configure_identity(cwd: &Path) {
        run_git(cwd, ["config", "user.name", "Test User"]);
        run_git(cwd, ["config", "user.email", "test@example.com"]);
        run_git(cwd, ["config", "commit.gpgsign", "false"]);
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
        let output = StdCommand::new("git")
            .args(args)
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
