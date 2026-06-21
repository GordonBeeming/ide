// This shell-backed module is a compatibility fallback, not the preferred Git
// integration path. Prefer gitoxide/gix for Git operations as APIs are adopted
// in this app, and keep direct `git` command usage limited to behavior that is
// not yet covered well enough by the embedded library path.
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;

use serde::Serialize;
use tokio::process::Command;

use crate::workspace::{resolve_existing_workspace_file_path, WorkspaceError};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitAttribution {
    pub path: String,
    pub status: GitAttributionStatus,
    pub unsupported_reason: Option<String>,
    pub file: Option<GitCommitInfo>,
    pub lines: Vec<GitLineAttribution>,
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

#[derive(Debug)]
struct GitCommandError {
    status: Option<ExitStatus>,
    stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteTemplate {
    provider: String,
    remote_name: String,
    base_url: String,
}

#[derive(Debug, Clone, Default)]
struct BlameLine {
    line_number: usize,
    sha: String,
    author_name: String,
    author_email: Option<String>,
    authored_at_seconds: Option<i64>,
    summary: String,
}

pub(crate) async fn attribution_for_file(workspace_root: &Path, relative: &str) -> GitAttribution {
    let file_path = match resolve_existing_workspace_file_path(workspace_root, relative) {
        Ok(path) => path,
        Err(error) => return unsupported(relative, workspace_error_reason(error)),
    };

    let Some(file_parent) = file_path.parent() else {
        return unsupported(relative, "File has no parent directory");
    };

    let repo_root = match git_output(file_parent, ["rev-parse", "--show-toplevel"]).await {
        Ok(root) => PathBuf::from(root.trim()),
        Err(error) if error.status.is_none() => {
            return unsupported(relative, "Git command is unavailable")
        }
        Err(_) => return unsupported(relative, "File is not inside a Git repository"),
    };

    let repo_root = repo_root
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf());
    let repo_relative_path = match file_path.strip_prefix(&repo_root) {
        Ok(path) => normalize_path(path),
        Err(_) => return unsupported(relative, "File is outside the Git repository root"),
    };

    if let Err(error) = git_output(
        &repo_root,
        ["ls-files", "--error-unmatch", "--", &repo_relative_path],
    )
    .await
    {
        if error.status.is_none() {
            return unsupported(relative, "Git command is unavailable");
        }
        return unsupported(relative, "File is not tracked by Git");
    }

    let remote_templates = match remote_templates(&repo_root).await {
        Ok(remotes) => remotes,
        Err(error) if error.status.is_none() => {
            return unsupported(relative, "Git command is unavailable")
        }
        Err(_) => Vec::new(),
    };

    let latest_commit =
        match latest_file_commit(&repo_root, &repo_relative_path, &remote_templates).await {
            Ok(Some(commit)) => commit,
            Ok(None) => return unsupported(relative, "File has no local commit history"),
            Err(error) if error.status.is_none() => {
                return unsupported(relative, "Git command is unavailable")
            }
            Err(error) => {
                return unsupported(relative, command_failure_reason("commit history", &error))
            }
        };

    let lines = match blame_lines(&repo_root, &repo_relative_path, &remote_templates).await {
        Ok(lines) => lines,
        Err(error) if error.status.is_none() => {
            return unsupported(relative, "Git command is unavailable")
        }
        Err(error) => {
            return unsupported(relative, command_failure_reason("line attribution", &error))
        }
    };

    GitAttribution {
        path: relative.to_string(),
        status: GitAttributionStatus::Available,
        unsupported_reason: None,
        file: Some(latest_commit),
        lines,
    }
}

fn unsupported(path: &str, reason: impl Into<String>) -> GitAttribution {
    GitAttribution {
        path: path.to_string(),
        status: GitAttributionStatus::Unsupported,
        unsupported_reason: Some(reason.into()),
        file: None,
        lines: Vec::new(),
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

async fn latest_file_commit(
    repo_root: &Path,
    path: &str,
    remotes: &[RemoteTemplate],
) -> Result<Option<GitCommitInfo>, GitCommandError> {
    let output = git_output(
        repo_root,
        [
            "log",
            "-1",
            "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s",
            "--",
            path,
        ],
    )
    .await?;
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(parse_commit_record(trimmed, remotes))
}

async fn blame_lines(
    repo_root: &Path,
    path: &str,
    remotes: &[RemoteTemplate],
) -> Result<Vec<GitLineAttribution>, GitCommandError> {
    let output = git_output(repo_root, ["blame", "--line-porcelain", "--", path]).await?;
    Ok(parse_blame_porcelain(&output, remotes))
}

fn parse_commit_record(record: &str, remotes: &[RemoteTemplate]) -> Option<GitCommitInfo> {
    let mut parts = record.splitn(6, '\x1f');
    let sha = parts.next()?.to_string();
    let short_sha = parts.next()?.to_string();
    let author_name = parts.next()?.to_string();
    let author_email = normalize_email(parts.next()?);
    let authored_at_seconds = parts.next()?.parse::<i64>().ok();
    let summary = parts.next().unwrap_or("").to_string();
    Some(commit_info(
        sha,
        short_sha,
        author_name,
        author_email,
        authored_at_seconds,
        summary,
        remotes,
    ))
}

fn parse_blame_porcelain(output: &str, remotes: &[RemoteTemplate]) -> Vec<GitLineAttribution> {
    let mut lines = Vec::new();
    let mut metadata_by_sha = HashMap::<String, BlameLine>::new();
    let mut current = BlameLine::default();

    for raw_line in output.lines() {
        if let Some(content) = raw_line.strip_prefix('\t') {
            if current.line_number == 0 {
                current = BlameLine::default();
                continue;
            }

            let metadata = blame_metadata(&mut metadata_by_sha, &current);
            let summary = if is_zero_sha(&current.sha) && metadata.summary.is_empty() {
                "Uncommitted change".to_string()
            } else {
                metadata.summary.clone()
            };
            let short_sha = if is_zero_sha(&current.sha) {
                "working tree".to_string()
            } else {
                current.sha.chars().take(8).collect()
            };
            let commit = commit_info(
                current.sha.clone(),
                short_sha,
                if metadata.author_name.is_empty() {
                    "Not committed yet".to_string()
                } else {
                    metadata.author_name.clone()
                },
                metadata.author_email,
                metadata.authored_at_seconds,
                if summary.is_empty() {
                    content.trim().to_string()
                } else {
                    summary
                },
                remotes,
            );
            lines.push(GitLineAttribution {
                line_number: current.line_number,
                commit,
            });
            current = BlameLine::default();
            continue;
        }

        let mut parts = raw_line.split_whitespace();
        let first = parts.next().unwrap_or_default();
        if is_git_sha(first) {
            current.sha = first.to_string();
            let _original_line = parts.next();
            current.line_number = parts
                .next()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or_default();
            continue;
        }

        if let Some(author) = raw_line.strip_prefix("author ") {
            current.author_name = author.to_string();
        } else if let Some(email) = raw_line.strip_prefix("author-mail ") {
            current.author_email = normalize_email(email);
        } else if let Some(time) = raw_line.strip_prefix("author-time ") {
            current.authored_at_seconds = time.parse::<i64>().ok();
        } else if let Some(summary) = raw_line.strip_prefix("summary ") {
            current.summary = summary.to_string();
        }
    }

    lines
}

fn blame_metadata(
    metadata_by_sha: &mut HashMap<String, BlameLine>,
    current: &BlameLine,
) -> BlameLine {
    if current.sha.is_empty() {
        return current.clone();
    }

    let cached = metadata_by_sha.entry(current.sha.clone()).or_default();
    if !current.author_name.is_empty() {
        cached.author_name = current.author_name.clone();
    }
    if current.author_email.is_some() {
        cached.author_email = current.author_email.clone();
    }
    if current.authored_at_seconds.is_some() {
        cached.authored_at_seconds = current.authored_at_seconds;
    }
    if !current.summary.is_empty() {
        cached.summary = current.summary.clone();
    }
    cached.clone()
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
    let actions = if is_zero_sha(&sha) {
        Vec::new()
    } else {
        remotes
            .iter()
            .map(|remote| GitCommitAction {
                provider: remote.provider.clone(),
                remote_name: remote.remote_name.clone(),
                label: format!("Open in {}", remote.provider),
                url: format!("{}/commit/{}", remote.base_url, sha),
            })
            .collect()
    };

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

async fn remote_templates(repo_root: &Path) -> Result<Vec<RemoteTemplate>, GitCommandError> {
    let output = git_output(repo_root, ["remote", "-v"]).await?;
    let mut seen = HashSet::new();
    let mut templates = Vec::new();

    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let Some(remote_name) = parts.next() else {
            continue;
        };
        let Some(remote_url) = parts.next() else {
            continue;
        };
        let direction = parts.next().unwrap_or_default();
        if direction != "(fetch)" {
            continue;
        }
        let Some(template) = github_remote_template(remote_name, remote_url) else {
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
    Ok(templates)
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

async fn git_output<I, S>(cwd: &Path, args: I) -> Result<String, GitCommandError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|error| GitCommandError {
            status: None,
            stderr: error.to_string(),
        })?;

    if !output.status.success() {
        return Err(GitCommandError {
            status: Some(output.status),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn command_failure_reason(operation: &str, error: &GitCommandError) -> String {
    if error.stderr.is_empty() {
        format!("Git {operation} failed")
    } else {
        format!("Git {operation} failed: {}", error.stderr)
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

fn is_git_sha(value: &str) -> bool {
    value.len() >= 40 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn is_zero_sha(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|character| character == '0')
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

    #[test]
    fn parses_blame_porcelain_lines() {
        let remotes = vec![RemoteTemplate {
            provider: "GitHub".to_string(),
            remote_name: "origin".to_string(),
            base_url: "https://github.com/GordonBeeming/ide".to_string(),
        }];
        let output = "\
abc123456789abcdef123456789abcdef1234567 1 1 1
author Gordon Beeming
author-mail <gordon@example.com>
author-time 1700000000
summary Add app shell
\tfirst line
0000000000000000000000000000000000000000 2 2 1
author Not Committed Yet
author-mail <>
author-time 0
summary
\tsecond line
";

        let lines = parse_blame_porcelain(output, &remotes);

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].line_number, 1);
        assert_eq!(lines[0].commit.author_name, "Gordon Beeming");
        assert_eq!(lines[0].commit.summary, "Add app shell");
        assert_eq!(
            lines[0].commit.actions[0].url,
            "https://github.com/GordonBeeming/ide/commit/abc123456789abcdef123456789abcdef1234567"
        );
        assert_eq!(lines[1].line_number, 2);
        assert_eq!(lines[1].commit.short_sha, "working tree");
        assert!(lines[1].commit.actions.is_empty());
    }

    #[test]
    fn reuses_cached_blame_metadata_for_repeated_commits() {
        let remotes = Vec::new();
        let output = "\
abc123456789abcdef123456789abcdef1234567 1 1 1
author Gordon Beeming
author-mail <gordon@example.com>
author-time 1700000000
summary Add app shell
\tfirst line
abc123456789abcdef123456789abcdef1234567 2 2 1
\tsecond line
";

        let lines = parse_blame_porcelain(output, &remotes);

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].line_number, 2);
        assert_eq!(lines[1].commit.author_name, "Gordon Beeming");
        assert_eq!(
            lines[1].commit.author_email.as_deref(),
            Some("gordon@example.com")
        );
        assert_eq!(lines[1].commit.authored_at_seconds, Some(1_700_000_000));
        assert_eq!(lines[1].commit.summary, "Add app shell");
    }

    #[test]
    fn skips_blame_lines_with_malformed_headers() {
        let remotes = Vec::new();
        let output = "\
not-a-header
\tignored line
abc123456789abcdef123456789abcdef1234567 1 4 1
author Gordon Beeming
summary Add app shell
\tvalid line
";

        let lines = parse_blame_porcelain(output, &remotes);

        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].line_number, 4);
        assert_eq!(lines[0].commit.summary, "Add app shell");
    }

    #[tokio::test]
    async fn returns_local_file_and_line_attribution() {
        let dir = tempdir().unwrap();
        run_git(dir.path(), ["init"]);
        run_git(dir.path(), ["symbolic-ref", "HEAD", "refs/heads/main"]);
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
        run_git(dir.path(), ["add", "README.md"]);
        let tree = git_stdout(dir.path(), ["write-tree"]);
        let commit = git_stdout_with_env(
            dir.path(),
            ["commit-tree", tree.trim(), "-m", "Add readme"],
            [
                ("GIT_AUTHOR_NAME", "Gordon Beeming"),
                ("GIT_AUTHOR_EMAIL", "gordon@example.com"),
                ("GIT_AUTHOR_DATE", "1700000000 +0000"),
                ("GIT_COMMITTER_NAME", "Gordon Beeming"),
                ("GIT_COMMITTER_EMAIL", "gordon@example.com"),
                ("GIT_COMMITTER_DATE", "1700000000 +0000"),
            ],
        );
        run_git(dir.path(), ["update-ref", "refs/heads/main", commit.trim()]);

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        assert_eq!(attribution.status, GitAttributionStatus::Available);
        assert_eq!(attribution.file.as_ref().unwrap().summary, "Add readme");
        assert_eq!(attribution.lines.len(), 2);
        assert_eq!(attribution.lines[0].commit.author_name, "Gordon Beeming");
        assert_eq!(
            attribution.file.as_ref().unwrap().actions[0].label,
            "Open in GitHub"
        );
    }

    #[tokio::test]
    async fn returns_unsupported_for_untracked_files() {
        let dir = tempdir().unwrap();
        run_git(dir.path(), ["init"]);
        fs::write(dir.path().join("README.md"), "first\n").unwrap();

        let attribution = attribution_for_file(dir.path(), "README.md").await;

        assert_eq!(attribution.status, GitAttributionStatus::Unsupported);
        assert_eq!(
            attribution.unsupported_reason.as_deref(),
            Some("File is not tracked by Git"),
        );
    }

    fn run_git<I, S>(cwd: &Path, args: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = StdCommand::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_stdout<I, S>(cwd: &Path, args: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        git_stdout_with_env(cwd, args, std::iter::empty::<(&str, &str)>())
    }

    fn git_stdout_with_env<I, S, E>(cwd: &Path, args: I, envs: E) -> String
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
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    }
}
