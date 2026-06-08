use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

#[derive(Clone)]
pub struct LspManager {
    sessions: Arc<RwLock<HashMap<LspSessionKey, LspSession>>>,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn statuses(&self) -> Vec<LspServerStatus> {
        let sessions = self.sessions.read().await;
        server_configs()
            .iter()
            .map(|config| {
                let probe = probe_command(config);
                let running = sessions.keys().any(|key| key.language == config.language);
                LspServerStatus {
                    language: config.language.to_string(),
                    display_name: config.display_name.to_string(),
                    command: config.command.to_string(),
                    args: config.args.iter().map(|arg| arg.to_string()).collect(),
                    available: probe.available,
                    running,
                    detail: probe.detail,
                }
            })
            .collect()
    }

    pub async fn start(
        &self,
        app: AppHandle,
        language: &str,
        workspace_root: &Path,
    ) -> Result<LspStartResult, LspError> {
        let key = LspSessionKey::new(language, workspace_root);
        if let Some(existing) = self.sessions.read().await.get(&key) {
            return Ok(LspStartResult {
                language: language.to_string(),
                session_id: existing.session_id.clone(),
                running: true,
            });
        }

        let config = server_configs()
            .into_iter()
            .find(|item| item.language == language)
            .ok_or_else(|| LspError::UnsupportedLanguage(language.to_string()))?;
        let probe = probe_command(&config);
        if !probe.available {
            return Err(LspError::Unavailable(probe.detail));
        }

        let mut child = Command::new(config.command)
            .args(config.args)
            .current_dir(workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdin = child.stdin.take().ok_or(LspError::MissingPipe("stdin"))?;
        let stdout = child.stdout.take().ok_or(LspError::MissingPipe("stdout"))?;
        let stderr = child.stderr.take();
        let session_id = Uuid::new_v4().to_string();
        let session = LspSession {
            session_id: session_id.clone(),
            stdin: Arc::new(Mutex::new(stdin)),
        };

        self.sessions.write().await.insert(key.clone(), session);

        spawn_stdout_reader(
            app.clone(),
            language.to_string(),
            session_id.clone(),
            stdout,
        );
        if let Some(stderr) = stderr {
            spawn_stderr_reader(
                app.clone(),
                language.to_string(),
                session_id.clone(),
                stderr,
            );
        }
        spawn_exit_watcher(
            app,
            language.to_string(),
            session_id.clone(),
            child,
            self.sessions.clone(),
            key,
        );

        Ok(LspStartResult {
            language: language.to_string(),
            session_id,
            running: true,
        })
    }

    pub async fn send(
        &self,
        language: &str,
        workspace_root: &Path,
        message: &str,
    ) -> Result<(), LspError> {
        let key = LspSessionKey::new(language, workspace_root);
        let session = self
            .sessions
            .read()
            .await
            .get(&key)
            .cloned()
            .ok_or_else(|| LspError::NotRunning(language.to_string()))?;
        let payload = format!("Content-Length: {}\r\n\r\n{}", message.len(), message);
        session
            .stdin
            .lock()
            .await
            .write_all(payload.as_bytes())
            .await?;
        Ok(())
    }

    pub async fn stop_for_root(&self, workspace_root: &Path) {
        let root = workspace_root.to_path_buf();
        self.sessions
            .write()
            .await
            .retain(|key, _| key.workspace_root != root);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct LspSessionKey {
    language: String,
    workspace_root: PathBuf,
}

impl LspSessionKey {
    fn new(language: &str, workspace_root: &Path) -> Self {
        Self {
            language: language.to_string(),
            workspace_root: workspace_root.to_path_buf(),
        }
    }
}

#[derive(Clone)]
struct LspSession {
    session_id: String,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Debug, Clone)]
struct LspServerConfig {
    language: &'static str,
    display_name: &'static str,
    command: &'static str,
    args: &'static [&'static str],
    probe_args: &'static [&'static str],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub language: String,
    pub display_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub available: bool,
    pub running: bool,
    pub detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStartResult {
    pub language: String,
    pub session_id: String,
    pub running: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LspMessageEvent {
    language: String,
    session_id: String,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LspLogEvent {
    language: String,
    session_id: String,
    message: String,
}

#[derive(Debug, thiserror::Error)]
pub enum LspError {
    #[error("unsupported language server: {0}")]
    UnsupportedLanguage(String),
    #[error("language server is not available: {0}")]
    Unavailable(String),
    #[error("language server is not running: {0}")]
    NotRunning(String),
    #[error("language server did not provide {0}")]
    MissingPipe(&'static str),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

fn server_configs() -> Vec<LspServerConfig> {
    vec![
        LspServerConfig {
            language: "rust",
            display_name: "Rust",
            command: "rust-analyzer",
            args: &[],
            probe_args: &["--version"],
        },
        LspServerConfig {
            language: "typescript",
            display_name: "TypeScript / React",
            command: "typescript-language-server",
            args: &["--stdio"],
            probe_args: &["--version"],
        },
        LspServerConfig {
            language: "csharp",
            display_name: "C#",
            command: "omnisharp",
            args: &["--languageserver"],
            probe_args: &["--version"],
        },
    ]
}

struct ProbeResult {
    available: bool,
    detail: String,
}

fn probe_command(config: &LspServerConfig) -> ProbeResult {
    let Some(path) = find_on_path(config.command) else {
        return ProbeResult {
            available: false,
            detail: format!("{} was not found on PATH", config.command),
        };
    };

    let output = std::process::Command::new(&path)
        .args(config.probe_args)
        .output();

    match output {
        Ok(output) if output.status.success() => ProbeResult {
            available: true,
            detail: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        },
        Ok(output) => ProbeResult {
            available: false,
            detail: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        },
        Err(error) => ProbeResult {
            available: false,
            detail: error.to_string(),
        },
    }
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 && command_path.exists() {
        return Some(command_path.to_path_buf());
    }

    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(command))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    path.is_file()
        || path
            .extension()
            .and_then(|value| value.to_str())
            .map(|extension| extension.eq_ignore_ascii_case("exe"))
            .unwrap_or(false)
}

fn spawn_stdout_reader(
    app: AppHandle,
    language: String,
    session_id: String,
    stdout: tokio::process::ChildStdout,
) {
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_lsp_message(&mut reader).await {
                Ok(Some(message)) => {
                    let _ = app.emit(
                        "lsp://message",
                        LspMessageEvent {
                            language: language.clone(),
                            session_id: session_id.clone(),
                            message,
                        },
                    );
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = app.emit(
                        "lsp://log",
                        LspLogEvent {
                            language: language.clone(),
                            session_id: session_id.clone(),
                            message: error.to_string(),
                        },
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_reader(
    app: AppHandle,
    language: String,
    session_id: String,
    stderr: tokio::process::ChildStderr,
) {
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let message = line.trim();
                    if !message.is_empty() {
                        let _ = app.emit(
                            "lsp://log",
                            LspLogEvent {
                                language: language.clone(),
                                session_id: session_id.clone(),
                                message: message.to_string(),
                            },
                        );
                    }
                }
                Err(error) => {
                    let _ = app.emit(
                        "lsp://log",
                        LspLogEvent {
                            language: language.clone(),
                            session_id: session_id.clone(),
                            message: format!("language server stderr read failed: {error}"),
                        },
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_exit_watcher(
    app: AppHandle,
    language: String,
    session_id: String,
    mut child: Child,
    sessions: Arc<RwLock<HashMap<LspSessionKey, LspSession>>>,
    key: LspSessionKey,
) {
    tauri::async_runtime::spawn(async move {
        let message = match child.wait().await {
            Ok(status) => format!("language server exited with {status}"),
            Err(error) => format!("language server exit watch failed: {error}"),
        };
        remove_session_if_matches(&sessions, &key, &session_id).await;
        let _ = app.emit(
            "lsp://log",
            LspLogEvent {
                language,
                session_id,
                message,
            },
        );
    });
}

async fn read_lsp_message<R>(reader: &mut BufReader<R>) -> std::io::Result<Option<String>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut content_length = None;
    let mut line = Vec::new();

    loop {
        line.clear();
        let bytes = reader.read_until(b'\n', &mut line).await?;
        if bytes == 0 {
            return Ok(None);
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }

        let header = String::from_utf8_lossy(&line);
        if let Some(value) = header.strip_prefix("Content-Length:") {
            content_length = value.trim().parse::<usize>().ok();
        }
    }

    let Some(length) = content_length else {
        return Ok(None);
    };

    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    Ok(Some(String::from_utf8_lossy(&body).to_string()))
}

async fn remove_session_if_matches(
    sessions: &Arc<RwLock<HashMap<LspSessionKey, LspSession>>>,
    key: &LspSessionKey,
    session_id: &str,
) {
    let mut sessions = sessions.write().await;
    if should_remove_session(
        sessions.get(key).map(|session| session.session_id.as_str()),
        session_id,
    ) {
        sessions.remove(key);
    }
}

fn should_remove_session(existing_session_id: Option<&str>, session_id: &str) -> bool {
    existing_session_id.is_some_and(|existing| existing == session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn find_on_path_returns_none_for_missing_command() {
        assert!(find_on_path("ide-definitely-missing-command").is_none());
    }

    #[test]
    fn is_executable_accepts_regular_files() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("server");
        std::fs::write(&file, "").unwrap();

        assert!(is_executable(&file));
    }

    #[test]
    fn stale_session_removal_only_matches_current_session_id() {
        assert!(should_remove_session(Some("current"), "current"));
        assert!(!should_remove_session(Some("current"), "old"));
        assert!(!should_remove_session(None, "current"));
    }

    #[test]
    fn session_keys_include_workspace_root() {
        let root_a = PathBuf::from("/workspace-a");
        let root_b = PathBuf::from("/workspace-b");

        assert_ne!(
            LspSessionKey::new("typescript", &root_a),
            LspSessionKey::new("typescript", &root_b)
        );
    }
}
