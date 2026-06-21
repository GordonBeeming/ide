// Git attribution should use embedded gitoxide/gix APIs. Keep direct `git`
// commands out of this service unless gix does not cover the required behavior.
use std::collections::{HashMap, HashSet};
use std::fs;
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
    let file_path = match resolve_existing_workspace_file_path(workspace_root, relative) {
        Ok(path) => path,
        Err(error) => return unsupported(relative, workspace_error_reason(error)),
    };

    let Some(file_parent) = file_path.parent() else {
        return unsupported(relative, "File has no parent directory");
    };

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

    let lines = match blame_lines(&repo, &blame, &remote_templates) {
        Ok(lines) => lines,
        Err(_) => return unsupported(relative, "Git line attribution failed"),
    };
    let uncommitted_lines =
        uncommitted_line_numbers(&repo, &head_commit, &file_path, &repo_relative_path);

    let latest_commit = match latest_file_commit(&lines) {
        Some(commit) => commit,
        None => match commit_info_from_commit(&head_commit, &remote_templates) {
            Ok(commit) => commit,
            Err(_) => return unsupported(relative, "Git commit history failed"),
        },
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
        let commit = if let Some(commit) = commits_by_id.get(&entry.commit_id) {
            commit.clone()
        } else {
            let commit = repo
                .find_commit(entry.commit_id)
                .map_err(|_| ())
                .and_then(|commit| commit_info_from_commit(&commit, remotes))?;
            commits_by_id.insert(entry.commit_id, commit.clone());
            commit
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

fn latest_file_commit(lines: &[GitLineAttribution]) -> Option<GitCommitInfo> {
    lines
        .iter()
        .map(|line| line.commit.clone())
        .max_by_key(|commit| commit.authored_at_seconds.unwrap_or(i64::MIN))
}

fn uncommitted_line_numbers(
    repo: &gix::Repository,
    head_commit: &gix::Commit<'_>,
    file_path: &Path,
    repo_relative_path: &str,
) -> Vec<usize> {
    let Ok(head_contents) = head_file_contents(repo, head_commit, repo_relative_path) else {
        return Vec::new();
    };
    let Ok(current_contents) = fs::read(file_path) else {
        return Vec::new();
    };
    if head_contents == current_contents {
        return Vec::new();
    }

    let head_text = String::from_utf8_lossy(&head_contents);
    let current_text = String::from_utf8_lossy(&current_contents);
    let head_lines = document_lines(&head_text);
    let current_lines = document_lines(&current_text);
    let mapped_lines = current_to_original_line_map(&head_lines, &current_lines);

    (1..=current_lines.len())
        .filter(|line_number| !mapped_lines.contains_key(line_number))
        .collect()
}

fn head_file_contents(
    _repo: &gix::Repository,
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

fn document_lines(contents: &str) -> Vec<&str> {
    contents.split('\n').collect()
}

fn current_to_original_line_map(
    original_lines: &[&str],
    current_lines: &[&str],
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

    let mut lengths = vec![vec![0usize; current_middle.len() + 1]; original_middle.len() + 1];
    for original_index in (0..original_middle.len()).rev() {
        for current_index in (0..current_middle.len()).rev() {
            lengths[original_index][current_index] =
                if original_middle[original_index] == current_middle[current_index] {
                    lengths[original_index + 1][current_index + 1] + 1
                } else {
                    lengths[original_index + 1][current_index]
                        .max(lengths[original_index][current_index + 1])
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
        } else if lengths[original_index + 1][current_index]
            >= lengths[original_index][current_index + 1]
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

    Ok(commit_info(
        sha,
        short_sha,
        lossless_string(author.name),
        normalize_email(&lossless_string(author.email)),
        Some(author.seconds()),
        first_message_line(commit.message_raw_sloppy()),
        remotes,
    ))
}

fn commit_info(
    sha: String,
    short_sha: String,
    author_name: String,
    author_email: Option<String>,
    authored_at_seconds: Option<i64>,
    summary: String,
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
        WorkspaceError::SymlinkUnsupported => "Symbolic links are not supported".to_string(),
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
        assert_eq!(attribution.lines.len(), 2);
        assert_eq!(attribution.lines[0].line_number, 1);
        assert_eq!(attribution.lines[0].commit.author_name, "Gordon Beeming");
        assert_eq!(
            attribution.file.as_ref().unwrap().actions[0].label,
            "Open in GitHub"
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
    async fn marks_saved_inserted_lines_as_uncommitted() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("README.md"), "first\nsecond\n").unwrap();
        commit_all(dir.path(), "Add readme", "1700000000 +0000");
        fs::write(dir.path().join("README.md"), "first\n\nsecond\n").unwrap();

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        assert_eq!(attribution.status, GitAttributionStatus::Available);
        assert_eq!(attribution.uncommitted_lines, vec![2]);
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
