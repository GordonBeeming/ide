// Git attribution should use embedded gitoxide/gix APIs. Keep direct `git`
// commands out of this service unless gix does not cover the required behavior.
use std::collections::{HashMap, HashSet};
use std::path::Path;

use gix::bstr::{BStr, BString, ByteSlice};
use serde::Serialize;

use crate::workspace::{resolve_existing_workspace_file_path, WorkspaceError};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitAttribution {
    pub path: String,
    pub status: GitAttributionStatus,
    pub unsupported_reason: Option<String>,
    pub file: Option<GitCommitInfo>,
    pub lines: Vec<GitLineAttribution>,
    pub uncommitted_lines: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GitAttributionStatus {
    Available,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitLineAttribution {
    pub line_number: usize,
    pub commit: GitCommitInfo,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub author_name: String,
    pub author_email: Option<String>,
    pub authored_at_seconds: Option<i64>,
    pub summary: String,
    pub body: Option<String>,
    pub actions: Vec<GitCommitAction>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitAction {
    pub provider: String,
    pub remote_name: String,
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteTemplate {
    provider: String,
    remote_name: String,
    base_url: String,
}

pub(crate) async fn attribution_for_file(workspace_root: &Path, relative: &str) -> GitAttribution {
    // Never follow a symlink that escapes the workspace here — attribution must
    // not become a way to read external files without the trust gate. In-workspace
    // symlinks still resolve (allow_external = false still follows within root);
    // a symlink pointing outside the repo has no meaningful git blame anyway.
    let file_path = match resolve_existing_workspace_file_path(workspace_root, relative, false) {
        Ok(path) => path,
        Err(error) => return unsupported(relative, workspace_error_reason(error)),
    };

    let Some(file_parent) = file_path.parent() else {
        return unsupported(relative, "File has no parent directory");
    };

    let current_contents = tokio::fs::read(&file_path).await.ok();

    let repo = match gix::discover(file_parent) {
        Ok(repo) => repo,
        Err(_) => return unsupported(relative, "File is not inside a Git repository"),
    };

    let Some(repo_root) = repo.workdir() else {
        return unsupported(relative, "Bare Git repositories are not supported");
    };
    let repo_root = repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf());
    let repo_relative_path = match file_path.strip_prefix(&repo_root) {
        Ok(path) => normalize_path(path),
        Err(_) => return unsupported(relative, "File is outside the Git repository root"),
    };
    let repo_relative_bstr = BString::from(repo_relative_path.as_str());

    if !is_tracked(&repo, repo_relative_bstr.as_bstr()) {
        return unsupported(relative, "File is not tracked by Git");
    }

    let head_commit = match repo.head_commit() {
        Ok(commit) => commit,
        Err(_) => return unsupported(relative, "File has no local commit history"),
    };
    let remote_templates = remote_templates(&repo);

    let blame = match repo.blame_file(
        repo_relative_bstr.as_bstr(),
        head_commit.id,
        Default::default(),
    ) {
        Ok(blame) => blame,
        Err(_) => return unsupported(relative, "Git line attribution failed"),
    };

    let mut lines = match blame_lines(&repo, &blame, &remote_templates) {
        Ok(lines) => lines,
        Err(_) => return unsupported(relative, "Git line attribution failed"),
    };
    let latest_commit =
        match latest_file_commit(&repo, &head_commit, &repo_relative_path, &remote_templates) {
            Some(commit) => commit,
            None => match commit_info_from_commit(&head_commit, &remote_templates) {
                Ok(commit) => commit,
                Err(_) => return unsupported(relative, "Git commit history failed"),
            },
        };
    let uncommitted_lines = match (
        head_file_contents(&head_commit, &repo_relative_path),
        current_contents,
    ) {
        (Ok(head_contents), Some(current_contents)) => {
            let (line_map, uncommitted_lines) =
                current_line_map_and_uncommitted_lines(&head_contents, &current_contents);
            if let Some(line_map) = line_map.as_ref() {
                lines = map_lines_to_current_worktree(&lines, line_map);
            }
            uncommitted_lines
        }
        _ => Vec::new(),
    };

    GitAttribution {
        path: relative.to_string(),
        status: GitAttributionStatus::Available,
        unsupported_reason: None,
        file: Some(latest_commit),
        lines,
        uncommitted_lines,
    }
}

fn is_tracked(repo: &gix::Repository, repo_relative_path: &BStr) -> bool {
    let Ok(index) = repo.open_index() else {
        return false;
    };

    index
        .entry_index_by_path_and_stage(repo_relative_path, gix::index::entry::Stage::Unconflicted)
        .is_some()
}

fn blame_lines(
    repo: &gix::Repository,
    blame: &gix::blame::Outcome,
    remotes: &[RemoteTemplate],
) -> Result<Vec<GitLineAttribution>, ()> {
    let mut commits_by_id = HashMap::<gix::ObjectId, GitCommitInfo>::new();
    let mut lines = Vec::new();

    for entry in &blame.entries {
        let commit = match commits_by_id.entry(entry.commit_id) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(vacant) => {
                let commit = repo
                    .find_commit(entry.commit_id)
                    .map_err(|_| ())
                    .and_then(|commit| commit_info_from_commit(&commit, remotes))?;
                vacant.insert(commit)
            }
        };

        for line_number in entry.range_in_blamed_file() {
            lines.push(GitLineAttribution {
                line_number: line_number + 1,
                commit: commit.clone(),
            });
        }
    }

    lines.sort_by_key(|line| line.line_number);
    Ok(lines)
}

fn latest_file_commit(
    repo: &gix::Repository,
    head_commit: &gix::Commit<'_>,
    repo_relative_path: &str,
    remotes: &[RemoteTemplate],
) -> Option<GitCommitInfo> {
    let mut walk = head_commit.ancestors().all().ok()?;
    while let Some(Ok(info)) = walk.next() {
        let commit = repo.find_commit(info.id).ok()?;
        let current_blob = blob_id_for_path(&commit, repo_relative_path).ok()?;
        if current_blob.is_none() {
            continue;
        }

        let changed_from_parent = if info.parent_ids.is_empty() {
            true
        } else {
            info.parent_ids.iter().any(|parent_id| {
                repo.find_commit(parent_id.to_owned())
                    .ok()
                    .and_then(|parent| blob_id_for_path(&parent, repo_relative_path).ok().flatten())
                    != current_blob
            })
        };
        if changed_from_parent {
            return commit_info_from_commit(&commit, remotes).ok();
        }
    }

    None
}

fn blob_id_for_path(
    commit: &gix::Commit<'_>,
    repo_relative_path: &str,
) -> Result<Option<gix::ObjectId>, ()> {
    let tree = commit.tree().map_err(|_| ())?;
    tree.lookup_entry_by_path(repo_relative_path)
        .map_err(|_| ())
        .map(|entry| entry.map(|entry| entry.object_id()))
}

fn current_line_map_and_uncommitted_lines(
    head_contents: &[u8],
    current_contents: &[u8],
) -> (Option<HashMap<usize, usize>>, Vec<usize>) {
    let head_lines = document_lines(head_contents);
    let current_lines = document_lines(current_contents);
    if head_lines == current_lines {
        return (None, Vec::new());
    }

    let mapped_lines = current_to_original_line_map(&head_lines, &current_lines);
    let uncommitted_lines = (1..=current_lines.len())
        .filter(|line_number| !mapped_lines.contains_key(line_number))
        .collect();
    (Some(mapped_lines), uncommitted_lines)
}

fn head_file_contents(
    head_commit: &gix::Commit<'_>,
    repo_relative_path: &str,
) -> Result<Vec<u8>, ()> {
    let tree = head_commit.tree().map_err(|_| ())?;
    let entry = tree
        .lookup_entry_by_path(repo_relative_path)
        .map_err(|_| ())?
        .ok_or(())?;
    let blob = entry
        .object()
        .map_err(|_| ())?
        .try_into_blob()
        .map_err(|_| ())?;
    Ok(blob.data.clone())
}

fn map_lines_to_current_worktree(
    lines: &[GitLineAttribution],
    current_to_original_line_map: &HashMap<usize, usize>,
) -> Vec<GitLineAttribution> {
    let original_to_current_line = current_to_original_line_map
        .iter()
        .map(|(current, original)| (*original, *current))
        .collect::<HashMap<_, _>>();

    lines
        .iter()
        .filter_map(|line| {
            original_to_current_line
                .get(&line.line_number)
                .map(|current_line_number| GitLineAttribution {
                    line_number: *current_line_number,
                    commit: line.commit.clone(),
                })
        })
        .collect()
}

fn document_lines(contents: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(contents)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(ToString::to_string)
        .collect()
}

fn current_to_original_line_map(
    original_lines: &[String],
    current_lines: &[String],
) -> HashMap<usize, usize> {
    let mut line_map = HashMap::new();
    let mut prefix_length = 0;
    while prefix_length < original_lines.len()
        && prefix_length < current_lines.len()
        && original_lines[prefix_length] == current_lines[prefix_length]
    {
        line_map.insert(prefix_length + 1, prefix_length + 1);
        prefix_length += 1;
    }

    let mut suffix_length = 0;
    while suffix_length < original_lines.len() - prefix_length
        && suffix_length < current_lines.len() - prefix_length
        && original_lines[original_lines.len() - 1 - suffix_length]
            == current_lines[current_lines.len() - 1 - suffix_length]
    {
        line_map.insert(
            current_lines.len() - suffix_length,
            original_lines.len() - suffix_length,
        );
        suffix_length += 1;
    }

    let original_start = prefix_length;
    let original_end = original_lines.len() - suffix_length;
    let current_start = prefix_length;
    let current_end = current_lines.len() - suffix_length;
    let original_middle = &original_lines[original_start..original_end];
    let current_middle = &current_lines[current_start..current_end];

    let matrix_size = (original_middle.len() + 1) * (current_middle.len() + 1);
    if matrix_size > 250_000 {
        for index in 0..original_middle.len().min(current_middle.len()) {
            if original_middle[index] == current_middle[index] {
                line_map.insert(current_start + index + 1, original_start + index + 1);
            }
        }
        return line_map;
    }

    let width = current_middle.len() + 1;
    let mut lengths = vec![0usize; (original_middle.len() + 1) * width];
    for original_index in (0..original_middle.len()).rev() {
        for current_index in (0..current_middle.len()).rev() {
            lengths[original_index * width + current_index] =
                if original_middle[original_index] == current_middle[current_index] {
                    lengths[(original_index + 1) * width + current_index + 1] + 1
                } else {
                    lengths[(original_index + 1) * width + current_index]
                        .max(lengths[original_index * width + current_index + 1])
                };
        }
    }

    let mut original_index = 0;
    let mut current_index = 0;
    while original_index < original_middle.len() && current_index < current_middle.len() {
        if original_middle[original_index] == current_middle[current_index] {
            line_map.insert(
                current_start + current_index + 1,
                original_start + original_index + 1,
            );
            original_index += 1;
            current_index += 1;
        } else if lengths[(original_index + 1) * width + current_index]
            >= lengths[original_index * width + current_index + 1]
        {
            original_index += 1;
        } else {
            current_index += 1;
        }
    }

    line_map
}

fn commit_info_from_commit(
    commit: &gix::Commit<'_>,
    remotes: &[RemoteTemplate],
) -> Result<GitCommitInfo, ()> {
    let sha = commit.id.to_string();
    let short_sha = commit
        .short_id()
        .map(|prefix| prefix.to_string())
        .unwrap_or_else(|_| sha.chars().take(8).collect());
    let author = commit.author().map_err(|_| ())?;

    let message = commit.message_raw_sloppy();
    Ok(commit_info(
        sha,
        short_sha,
        lossless_string(author.name),
        normalize_email(&lossless_string(author.email)),
        Some(author.seconds()),
        first_message_line(message),
        first_message_body(message),
        remotes,
    ))
}

#[allow(clippy::too_many_arguments)]
fn commit_info(
    sha: String,
    short_sha: String,
    author_name: String,
    author_email: Option<String>,
    authored_at_seconds: Option<i64>,
    summary: String,
    body: Option<String>,
    remotes: &[RemoteTemplate],
) -> GitCommitInfo {
    let actions = remotes
        .iter()
        .map(|remote| GitCommitAction {
            provider: remote.provider.clone(),
            remote_name: remote.remote_name.clone(),
            label: format!("Open in {}", remote.provider),
            url: format!("{}/commit/{}", remote.base_url, sha),
        })
        .collect();

    GitCommitInfo {
        sha,
        short_sha,
        author_name,
        author_email,
        authored_at_seconds,
        summary,
        body,
        actions,
    }
}

fn remote_templates(repo: &gix::Repository) -> Vec<RemoteTemplate> {
    let mut seen = HashSet::new();
    let mut templates = Vec::new();

    for remote_name in repo.remote_names() {
        let remote_name = remote_name.to_string();
        let Ok(remote) = repo.find_remote(remote_name.as_bytes().as_bstr()) else {
            continue;
        };
        let Some(remote_url) = remote.url(gix::remote::Direction::Fetch) else {
            continue;
        };
        let remote_url = remote_url.to_bstring().to_str_lossy().into_owned();
        let Some(template) = github_remote_template(&remote_name, &remote_url) else {
            continue;
        };
        if seen.insert((template.remote_name.clone(), template.base_url.clone())) {
            templates.push(template);
        }
    }

    templates.sort_by(|a, b| {
        a.remote_name
            .cmp(&b.remote_name)
            .then_with(|| a.base_url.cmp(&b.base_url))
    });
    templates
}

fn github_remote_template(remote_name: &str, remote_url: &str) -> Option<RemoteTemplate> {
    let repo_path = remote_url
        .strip_prefix("git@github.com:")
        .or_else(|| remote_url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| remote_url.strip_prefix("https://github.com/"))
        .or_else(|| remote_url.strip_prefix("http://github.com/"))?;

    let repo_path = repo_path.trim_end_matches(".git").trim_end_matches('/');
    let mut parts = repo_path.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    Some(RemoteTemplate {
        provider: "GitHub".to_string(),
        remote_name: remote_name.to_string(),
        base_url: format!("https://github.com/{owner}/{repo}"),
    })
}

fn lossless_string(value: &BStr) -> String {
    value.to_str_lossy().trim().to_string()
}

fn first_message_line(message: &BStr) -> String {
    message
        .to_str_lossy()
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn first_message_body(message: &BStr) -> Option<String> {
    let text = message.to_str_lossy();
    let body = text.lines().skip(1).collect::<Vec<_>>().join("\n");
    let trimmed = body.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_email(email: &str) -> Option<String> {
    let trimmed = email.trim().trim_start_matches('<').trim_end_matches('>');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn unsupported(path: &str, reason: impl Into<String>) -> GitAttribution {
    GitAttribution {
        path: path.to_string(),
        status: GitAttributionStatus::Unsupported,
        unsupported_reason: Some(reason.into()),
        file: None,
        lines: Vec::new(),
        uncommitted_lines: Vec::new(),
    }
}

fn workspace_error_reason(error: WorkspaceError) -> String {
    match error {
        WorkspaceError::NotAFile => "Path is not a file".to_string(),
        WorkspaceError::OutsideWorkspace => "File is outside the workspace".to_string(),
        WorkspaceError::InvalidPath => "File path is not supported".to_string(),
        WorkspaceError::SymlinkOutsideWorkspace => {
            "Symbolic link points outside the workspace".to_string()
        }
        WorkspaceError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            "File does not exist".to_string()
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::fs;
    use std::process::Command as StdCommand;
    use tempfile::tempdir;

    #[test]
    fn parses_common_github_remote_shapes() {
        let remotes = [
            ("origin", "git@github.com:GordonBeeming/ide.git"),
            ("upstream", "https://github.com/GordonBeeming/ide"),
            ("fork", "ssh://git@github.com/GordonBeeming/ide.git"),
        ]
        .into_iter()
        .map(|(name, url)| github_remote_template(name, url).unwrap())
        .collect::<Vec<_>>();

        assert_eq!(
            remotes
                .iter()
                .map(|remote| remote.base_url.as_str())
                .collect::<Vec<_>>(),
            vec![
                "https://github.com/GordonBeeming/ide",
                "https://github.com/GordonBeeming/ide",
                "https://github.com/GordonBeeming/ide",
            ],
        );
        assert!(github_remote_template("origin", "git@gitlab.com:org/repo.git").is_none());
    }

    #[tokio::test]
    async fn returns_local_file_and_line_attribution() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        run_git(
            dir.path(),
            [
                "remote",
                "add",
                "origin",
                "git@github.com:GordonBeeming/ide.git",
            ],
        );
        fs::write(dir.path().join("README.md"), "first\nsecond\n").unwrap();
        commit_all(dir.path(), "Add readme", "1700000000 +0000");

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        assert_eq!(attribution.status, GitAttributionStatus::Available);
        assert_eq!(attribution.file.as_ref().unwrap().summary, "Add readme");
        assert_eq!(attribution.file.as_ref().unwrap().body, None);
        assert_eq!(attribution.lines.len(), 2);
        assert_eq!(attribution.lines[0].line_number, 1);
        assert_eq!(attribution.lines[0].commit.author_name, "Gordon Beeming");
        assert_eq!(
            attribution.file.as_ref().unwrap().actions[0].label,
            "Open in GitHub"
        );
    }

    #[tokio::test]
    async fn splits_multiline_commit_message_into_summary_and_body() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("README.md"), "first\n").unwrap();
        commit_all(
            dir.path(),
            "Add readme\n\nExplains the project.\nSecond body line.",
            "1700000000 +0000",
        );

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        let file = attribution.file.as_ref().unwrap();
        assert_eq!(file.summary, "Add readme");
        assert_eq!(
            file.body.as_deref(),
            Some("Explains the project.\nSecond body line.")
        );
    }

    #[tokio::test]
    async fn returns_newest_blamed_commit_as_file_summary() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("README.md"), "first\nsecond\n").unwrap();
        commit_all(dir.path(), "Add readme", "1700000000 +0000");
        fs::write(dir.path().join("README.md"), "first\nupdated\n").unwrap();
        commit_all(dir.path(), "Update second line", "1700000100 +0000");

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        assert_eq!(attribution.status, GitAttributionStatus::Available);
        assert_eq!(
            attribution.file.as_ref().unwrap().summary,
            "Update second line"
        );
        assert_eq!(attribution.lines[0].commit.summary, "Add readme");
        assert_eq!(attribution.lines[1].commit.summary, "Update second line");
    }

    #[tokio::test]
    async fn returns_newest_path_commit_when_no_line_is_blamed_to_it() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("README.md"), "first\nsecond\n").unwrap();
        commit_all(dir.path(), "Add readme", "1700000000 +0000");
        fs::write(dir.path().join("README.md"), "first\n").unwrap();
        commit_all(dir.path(), "Delete second line", "1700000100 +0000");

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        assert_eq!(attribution.status, GitAttributionStatus::Available);
        assert_eq!(
            attribution.file.as_ref().unwrap().summary,
            "Delete second line"
        );
        assert_eq!(attribution.lines[0].commit.summary, "Add readme");
    }

    #[tokio::test]
    async fn returns_path_commit_for_empty_tracked_file() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("README.md"), "").unwrap();
        commit_all(dir.path(), "Add empty readme", "1700000000 +0000");

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        assert_eq!(attribution.status, GitAttributionStatus::Available);
        assert_eq!(
            attribution.file.as_ref().unwrap().summary,
            "Add empty readme"
        );
        assert!(attribution.lines.is_empty());
    }

    #[tokio::test]
    async fn marks_saved_modified_lines_as_uncommitted() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("README.md"), "first\nsecond\n").unwrap();
        commit_all(dir.path(), "Add readme", "1700000000 +0000");
        fs::write(dir.path().join("README.md"), "first\nchanged\n").unwrap();

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        assert_eq!(attribution.status, GitAttributionStatus::Available);
        assert_eq!(attribution.uncommitted_lines, vec![2]);
    }

    #[tokio::test]
    async fn ignores_line_ending_checkout_differences_for_uncommitted_lines() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("README.md"), "first\nsecond\n").unwrap();
        commit_all(dir.path(), "Add readme", "1700000000 +0000");
        fs::write(dir.path().join("README.md"), "first\r\nsecond\r\n").unwrap();

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        assert_eq!(attribution.status, GitAttributionStatus::Available);
        assert!(attribution.uncommitted_lines.is_empty());
    }

    #[tokio::test]
    async fn marks_saved_inserted_lines_as_uncommitted() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("README.md"), "first\nsecond\n").unwrap();
        commit_all(dir.path(), "Add readme", "1700000000 +0000");
        fs::write(dir.path().join("README.md"), "first\n\nsecond\n").unwrap();

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        assert_eq!(attribution.status, GitAttributionStatus::Available);
        assert_eq!(attribution.uncommitted_lines, vec![2]);
        assert_eq!(
            attribution
                .lines
                .iter()
                .map(|line| line.line_number)
                .collect::<Vec<_>>(),
            vec![1, 3],
        );
    }

    #[tokio::test]
    async fn returns_unsupported_for_untracked_files() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("README.md"), "first\n").unwrap();

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        assert_eq!(attribution.status, GitAttributionStatus::Unsupported);
        assert_eq!(
            attribution.unsupported_reason.as_deref(),
            Some("File is not tracked by Git"),
        );
    }

    fn init_repo(cwd: &Path) {
        run_git(cwd, ["init"]);
        run_git(cwd, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    }

    fn commit_all(cwd: &Path, message: &'static str, date: &'static str) {
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
                ("GIT_AUTHOR_NAME", "Gordon Beeming"),
                ("GIT_AUTHOR_EMAIL", "gordon@example.com"),
                ("GIT_AUTHOR_DATE", date),
                ("GIT_COMMITTER_NAME", "Gordon Beeming"),
                ("GIT_COMMITTER_EMAIL", "gordon@example.com"),
                ("GIT_COMMITTER_DATE", date),
            ],
        )
        .expect("commit-tree should succeed");
        run_git(cwd, ["update-ref", "refs/heads/main", commit.trim()]);
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
