use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::AgentContext;

#[derive(Clone)]
struct ClaudeBridgeState {
    workspace_root: Arc<RwLock<PathBuf>>,
    agent_context: Arc<RwLock<AgentContext>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeBridgeInfo {
    pub endpoint: String,
    pub lock_file: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ClaudeBridgeError {
    #[error("home directory is unavailable")]
    MissingHome,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Deserialize)]
struct JsonRpcMessage {
    id: Option<Value>,
    method: Option<String>,
    params: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LockFile {
    pid: u32,
    workspace_folders: Vec<String>,
    ide_name: String,
    transport: String,
    auth_token: String,
}

pub async fn start_claude_bridge(
    workspace_root: Arc<RwLock<PathBuf>>,
    agent_context: Arc<RwLock<AgentContext>>,
    bridge_error: Arc<RwLock<Option<String>>>,
) -> Result<ClaudeBridgeInfo, ClaudeBridgeError> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
    let port = listener.local_addr()?.port();
    let auth_token = Uuid::new_v4().to_string();
    let initial_root = workspace_root.read().await.clone();
    let lock_file = write_lock_file(port, &initial_root, &auth_token)?;
    let endpoint = format!("ws://127.0.0.1:{port}");
    let state = ClaudeBridgeState {
        workspace_root,
        agent_context,
    };

    let connection_error = bridge_error.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = accept_connections(listener, state, auth_token, connection_error).await
        {
            *bridge_error.write().await = Some(error);
        }
    });

    Ok(ClaudeBridgeInfo {
        endpoint,
        lock_file: lock_file.to_string_lossy().to_string(),
    })
}

pub fn update_lock_workspace(
    lock_file: &str,
    workspace_root: &Path,
) -> Result<(), ClaudeBridgeError> {
    let lock_path = PathBuf::from(lock_file);
    let contents = std::fs::read_to_string(&lock_path)?;
    let mut lock = serde_json::from_str::<LockFile>(&contents)?;
    lock.workspace_folders = vec![workspace_root.to_string_lossy().to_string()];
    std::fs::write(&lock_path, serde_json::to_vec_pretty(&lock)?)?;
    set_file_permissions(&lock_path)?;
    Ok(())
}

async fn accept_connections(
    listener: TcpListener,
    state: ClaudeBridgeState,
    auth_token: String,
    bridge_error: Arc<RwLock<Option<String>>>,
) -> Result<(), String> {
    loop {
        let (stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
        let connection_state = state.clone();
        let expected_token = auth_token.clone();
        let connection_error = bridge_error.clone();
        tauri::async_runtime::spawn(async move {
            let result = handle_connection(stream, connection_state, expected_token).await;
            if let Err(error) = result {
                if should_surface_connection_error(&error) {
                    *connection_error.write().await = Some(error);
                }
            }
        });
    }
}

fn should_surface_connection_error(error: &str) -> bool {
    !(error.contains("401 Unauthorized")
        || error.contains("Connection reset")
        || error.contains("connection reset")
        || error.contains("Protocol(ResetWithoutClosingHandshake)"))
}

async fn handle_connection(
    stream: TcpStream,
    state: ClaudeBridgeState,
    expected_token: String,
) -> Result<(), String> {
    // Tungstenite's handshake callback requires returning ErrorResponse by value.
    #[allow(clippy::result_large_err)]
    let websocket =
        tokio_tungstenite::accept_hdr_async(stream, |request: &Request, response: Response| {
            let is_authorized = request
                .headers()
                .get("x-claude-code-ide-authorization")
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value == expected_token);

            if is_authorized {
                Ok(response)
            } else {
                let mut unauthorized = ErrorResponse::new(Some("Unauthorized".to_string()));
                *unauthorized.status_mut() = StatusCode::UNAUTHORIZED;
                Err(unauthorized)
            }
        })
        .await
        .map_err(|error| error.to_string())?;

    let (mut writer, mut reader) = websocket.split();
    while let Some(message) = reader.next().await {
        let message = message.map_err(|error| error.to_string())?;
        if !message.is_text() {
            continue;
        }

        let request = match serde_json::from_str::<JsonRpcMessage>(message.to_text().unwrap_or(""))
        {
            Ok(request) => request,
            Err(error) => {
                writer
                    .send(Message::Text(
                        error_response(None, -32700, format!("Invalid JSON-RPC message: {error}"))
                            .into(),
                    ))
                    .await
                    .map_err(|send_error| send_error.to_string())?;
                continue;
            }
        };

        let Some(id) = request.id.clone() else {
            continue;
        };
        let response = handle_request(&state, request, id).await;
        writer
            .send(Message::Text(response.into()))
            .await
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

async fn handle_request(state: &ClaudeBridgeState, request: JsonRpcMessage, id: Value) -> String {
    match request.method.as_deref() {
        Some("initialize") => success_response(
            id,
            json!({
                "protocolVersion": "2025-03-26",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "Ide", "version": env!("CARGO_PKG_VERSION") }
            }),
        ),
        Some("ping") => success_response(id, json!({})),
        Some("tools/list") => success_response(id, json!({ "tools": tool_definitions() })),
        Some("tools/call") => handle_tool_call(state, id, request.params).await,
        Some("resources/list") => success_response(id, json!({ "resources": [] })),
        Some("prompts/list") => success_response(id, json!({ "prompts": [] })),
        Some(method) => error_response(id.into(), -32601, format!("Unknown method: {method}")),
        None => error_response(id.into(), -32600, "JSON-RPC method is required".to_string()),
    }
}

async fn handle_tool_call(state: &ClaudeBridgeState, id: Value, params: Option<Value>) -> String {
    let Some(name) = params
        .as_ref()
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
    else {
        return error_response(id.into(), -32602, "tools/call requires a name".to_string());
    };

    let context = state.agent_context.read().await.clone();
    let workspace_root = state.workspace_root.read().await.clone();
    let result = match name {
        "getCurrentSelection" | "getLatestSelection" => {
            current_selection(&workspace_root, &context)
        }
        "getOpenEditors" => open_editors(&workspace_root, &context),
        "getWorkspaceFolders" => workspace_folders(&workspace_root),
        "getDiagnostics" => diagnostics(&workspace_root, &context),
        _ => {
            return error_response(id.into(), -32601, format!("Unknown tool: {name}"));
        }
    };

    success_response(id, mcp_text_response(result.to_string()))
}

fn current_selection(workspace_root: &Path, context: &AgentContext) -> Value {
    let Some(selection) = context.selection.as_ref() else {
        return json!({ "success": false, "message": "No selection available" });
    };

    let file_path = absolute_path(workspace_root, &selection.file_path);
    json!({
        "success": true,
        "text": selection.text,
        "filePath": file_path,
        "fileUrl": file_url(&file_path),
        "selection": {
            "start": { "line": selection.start_line, "character": selection.start_column },
            "end": { "line": selection.end_line, "character": selection.end_column },
            "isEmpty": selection.text.is_empty()
        }
    })
}

fn open_editors(workspace_root: &Path, context: &AgentContext) -> Value {
    let tabs = context
        .open_files
        .iter()
        .map(|path| {
            let file_path = absolute_path(workspace_root, path);
            json!({
                "uri": file_url(&file_path),
                "isActive": context.active_file.as_deref() == Some(path.as_str()),
                "label": Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(path),
                "languageId": language_id(path),
                "isDirty": false
            })
        })
        .collect::<Vec<_>>();

    json!({ "tabs": tabs })
}

fn workspace_folders(workspace_root: &Path) -> Value {
    let root_path = workspace_root.to_string_lossy().to_string();
    let name = workspace_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace");

    json!({
        "success": true,
        "folders": [{
            "name": name,
            "uri": file_url(&root_path),
            "path": root_path
        }],
        "rootPath": root_path
    })
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "getCurrentSelection",
            "description": "Get the current text selection in the active editor.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "getLatestSelection",
            "description": "Get the most recent text selection recorded by the editor.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "getOpenEditors",
            "description": "Get the files currently open in editor tabs.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "getWorkspaceFolders",
            "description": "Get the workspace folders currently open in the IDE.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "getDiagnostics",
            "description": "Get language diagnostics known to the IDE.",
            "inputSchema": {
                "type": "object",
                "properties": { "uri": { "type": "string" } },
                "additionalProperties": false
            }
        }
    ])
}

fn mcp_text_response(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn success_response(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error_response(id: Option<Value>, code: i32, message: String) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
    .to_string()
}

fn diagnostics(workspace_root: &Path, context: &AgentContext) -> Value {
    let items = context
        .diagnostics
        .iter()
        .map(|diagnostic| {
            let file_path = absolute_path(workspace_root, &diagnostic.file_path);
            json!({
                "filePath": file_path,
                "fileUrl": file_url(&file_path),
                "relativePath": diagnostic.file_path,
                "message": diagnostic.message,
                "severity": diagnostic.severity,
                "source": diagnostic.source,
                "code": diagnostic.code,
                "range": {
                    "start": {
                        "line": diagnostic.start_line,
                        "character": diagnostic.start_column
                    },
                    "end": {
                        "line": diagnostic.end_line,
                        "character": diagnostic.end_column
                    }
                }
            })
        })
        .collect::<Vec<_>>();

    json!({ "items": items })
}

fn write_lock_file(
    port: u16,
    workspace_root: &Path,
    auth_token: &str,
) -> Result<PathBuf, ClaudeBridgeError> {
    let lock_dir = claude_lock_dir()?;
    std::fs::create_dir_all(&lock_dir)?;
    set_dir_permissions(&lock_dir)?;

    let lock_path = lock_dir.join(format!("{port}.lock"));
    let lock = LockFile {
        pid: std::process::id(),
        workspace_folders: vec![workspace_root.to_string_lossy().to_string()],
        ide_name: "Ide".to_string(),
        transport: "ws".to_string(),
        auth_token: auth_token.to_string(),
    };
    std::fs::write(&lock_path, serde_json::to_vec_pretty(&lock)?)?;
    set_file_permissions(&lock_path)?;
    Ok(lock_path)
}

fn claude_lock_dir() -> Result<PathBuf, ClaudeBridgeError> {
    if let Ok(config_dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        return Ok(PathBuf::from(config_dir).join("ide"));
    }

    let home = std::env::var("HOME").map_err(|_| ClaudeBridgeError::MissingHome)?;
    Ok(PathBuf::from(home).join(".claude").join("ide"))
}

#[cfg(unix)]
fn set_dir_permissions(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_dir_permissions(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(unix)]
fn set_file_permissions(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_file_permissions(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

fn absolute_path(root: &Path, path: &str) -> String {
    let value = Path::new(path);
    if value.is_absolute() {
        path.to_string()
    } else {
        root.join(value).to_string_lossy().to_string()
    }
}

fn file_url(path: &str) -> String {
    format!("file://{}", path.replace(' ', "%20"))
}

fn language_id(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".rs") {
        "rust"
    } else if lower.ends_with(".ts") || lower.ends_with(".tsx") {
        "typescript"
    } else if lower.ends_with(".js") || lower.ends_with(".jsx") {
        "javascript"
    } else if lower.ends_with(".cs") {
        "csharp"
    } else if lower.ends_with(".json") {
        "json"
    } else if lower.ends_with(".css") {
        "css"
    } else if lower.ends_with(".html") {
        "html"
    } else {
        "plaintext"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn workspace_folders_returns_file_url_and_path() {
        let dir = tempdir().unwrap();

        let folders = workspace_folders(dir.path());

        assert_eq!(folders["success"], true);
        assert_eq!(
            folders["rootPath"],
            dir.path().to_string_lossy().to_string()
        );
    }

    #[test]
    fn open_editors_marks_active_tab() {
        let dir = tempdir().unwrap();
        let context = AgentContext {
            active_file: Some("src/main.rs".to_string()),
            open_files: vec!["README.md".to_string(), "src/main.rs".to_string()],
            selection: None,
            diagnostics: Vec::new(),
        };

        let editors = open_editors(dir.path(), &context);

        assert_eq!(editors["tabs"][0]["isActive"], false);
        assert_eq!(editors["tabs"][1]["isActive"], true);
        assert_eq!(editors["tabs"][1]["languageId"], "rust");
    }

    #[test]
    fn expected_client_connection_errors_do_not_mark_bridge_failed() {
        assert!(!should_surface_connection_error(
            "HTTP error: 401 Unauthorized"
        ));
        assert!(!should_surface_connection_error("Connection reset by peer"));
        assert!(should_surface_connection_error("listener failed"));
    }

    #[test]
    fn diagnostics_include_absolute_and_relative_paths() {
        let dir = tempdir().unwrap();
        let context = AgentContext {
            active_file: None,
            open_files: Vec::new(),
            selection: None,
            diagnostics: vec![crate::EditorDiagnostic {
                file_path: "src/main.rs".to_string(),
                message: "expected item".to_string(),
                severity: Some(1),
                source: Some("rust-analyzer".to_string()),
                code: Some("E0001".to_string()),
                start_line: 2,
                start_column: 3,
                end_line: 2,
                end_column: 8,
            }],
        };

        let result = diagnostics(dir.path(), &context);

        assert_eq!(result["items"][0]["relativePath"], "src/main.rs");
        assert_eq!(result["items"][0]["message"], "expected item");
        assert_eq!(result["items"][0]["range"]["start"]["line"], 2);
    }
}
