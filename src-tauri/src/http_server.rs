use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::{fmt, io};

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

use crate::lsp::{LspManager, LspServerStatus};
use crate::workspace::{
    create_workspace_file, create_workspace_folder, delete_workspace_file, read_workspace_file,
    rename_workspace_file, scan_workspace, search_workspace, write_workspace_file, FileEntry,
    SearchMatch,
};
use crate::AgentContext;

#[derive(Clone)]
pub struct HttpServerState {
    workspace_root: Arc<RwLock<PathBuf>>,
    agent_context: Arc<RwLock<AgentContext>>,
    lsp_manager: LspManager,
    frontend_dist: PathBuf,
    mcp_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpServerInfo {
    pub endpoint: String,
    pub codex_mcp_endpoint: String,
    pub codex_mcp_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexMcpStatus {
    endpoint: String,
    bearer_token: String,
}

#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteFileRequest {
    path: String,
    contents: String,
    expected_modified_ms: Option<u128>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteFileRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFolderRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameFileRequest {
    from_path: String,
    to_path: String,
}

pub async fn start_http_server(
    root_path: Arc<RwLock<PathBuf>>,
    agent_context: Arc<RwLock<AgentContext>>,
    lsp_manager: LspManager,
    frontend_dist: PathBuf,
    mcp_token: String,
    server_error: Arc<RwLock<Option<String>>>,
) -> Result<HttpServerInfo, std::io::Error> {
    let state = HttpServerState {
        workspace_root: root_path,
        agent_context,
        lsp_manager,
        frontend_dist,
        mcp_token: mcp_token.clone(),
    };
    let app = Router::new()
        .route("/api/workspace-root", get(workspace_root))
        .route("/api/files", get(files))
        .route("/api/search", get(search))
        .route(
            "/api/file",
            get(read_file)
                .delete(delete_file)
                .post(create_file)
                .patch(rename_file)
                .put(write_file)
                .options(cors_preflight),
        )
        .route(
            "/api/folder",
            post(create_folder).options(cors_preflight),
        )
        .route(
            "/api/agent-context",
            get(get_agent_context)
                .put(put_agent_context)
                .options(cors_preflight),
        )
        .route("/api/lsp", get(lsp_servers))
        .route("/api/codex-mcp", get(codex_mcp_status))
        .route("/mcp", post(codex_mcp).options(cors_preflight))
        .route("/", get(index))
        .route("/{*path}", get(static_file).options(cors_preflight))
        .with_state(state)
        .layer(middleware::from_fn(loopback_cors));

    let listener = bind_loopback().await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            *server_error.write().await = Some(error.to_string());
        }
    });

    Ok(HttpServerInfo {
        codex_mcp_endpoint: format!("{endpoint}/mcp"),
        endpoint,
        codex_mcp_token: mcp_token,
    })
}

async fn bind_loopback() -> Result<TcpListener, std::io::Error> {
    let preferred = SocketAddr::from((Ipv4Addr::LOCALHOST, 17877));
    match TcpListener::bind(preferred).await {
        Ok(listener) => Ok(listener),
        Err(preferred_error) => bind_fallback_loopback(preferred, preferred_error).await,
    }
}

async fn bind_fallback_loopback(
    preferred: SocketAddr,
    preferred_error: io::Error,
) -> Result<TcpListener, io::Error> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .map_err(|fallback_error| {
            io::Error::new(
                fallback_error.kind(),
                format!(
                    "failed to bind preferred loopback {preferred}: {preferred_error}; \
                     failed to bind fallback loopback: {fallback_error}"
                ),
            )
        })
}

async fn cors_preflight(headers: HeaderMap) -> Response {
    apply_loopback_cors(
        headers.get(header::ORIGIN),
        StatusCode::NO_CONTENT.into_response(),
    )
}

async fn loopback_cors(request: Request<axum::body::Body>, next: Next) -> Response {
    let origin = request.headers().get(header::ORIGIN).cloned();
    let response = next.run(request).await;
    apply_loopback_cors(origin.as_ref(), response)
}

fn apply_loopback_cors(origin: Option<&HeaderValue>, mut response: Response) -> Response {
    let Some(origin) = origin.and_then(allowed_loopback_origin) else {
        return response;
    };

    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, DELETE, PATCH, PUT, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    response
}

fn allowed_loopback_origin(origin: &HeaderValue) -> Option<HeaderValue> {
    let value = origin.to_str().ok()?;
    if !matches!(value.strip_prefix("http://"), Some(rest) if is_loopback_host_port(rest))
        && !matches!(value.strip_prefix("https://"), Some(rest) if is_loopback_host_port(rest))
    {
        return None;
    }

    HeaderValue::from_str(value).ok()
}

fn is_loopback_host_port(value: &str) -> bool {
    let host = value.split_once(':').map_or(value, |(host, _)| host);
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

async fn workspace_root(State(state): State<HttpServerState>) -> Json<String> {
    Json(
        state
            .workspace_root
            .read()
            .await
            .to_string_lossy()
            .to_string(),
    )
}

async fn files(State(state): State<HttpServerState>) -> Result<Json<Vec<FileEntry>>, ApiError> {
    let workspace_root = state.workspace_root.read().await.clone();
    Ok(Json(scan_workspace(&workspace_root, 4_000)?))
}

async fn read_file(
    State(state): State<HttpServerState>,
    Query(query): Query<FileQuery>,
) -> Result<String, ApiError> {
    let workspace_root = state.workspace_root.read().await.clone();
    Ok(read_workspace_file(&workspace_root, &query.path)?)
}

async fn write_file(
    State(state): State<HttpServerState>,
    headers: HeaderMap,
    Json(request): Json<WriteFileRequest>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    let workspace_root = state.workspace_root.read().await.clone();
    write_workspace_file(
        &workspace_root,
        &request.path,
        &request.contents,
        request.expected_modified_ms,
    )?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_file(
    State(state): State<HttpServerState>,
    headers: HeaderMap,
    Json(request): Json<WriteFileRequest>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    let workspace_root = state.workspace_root.read().await.clone();
    create_workspace_file(&workspace_root, &request.path)?;
    Ok(StatusCode::CREATED)
}

async fn create_folder(
    State(state): State<HttpServerState>,
    headers: HeaderMap,
    Json(request): Json<CreateFolderRequest>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    let workspace_root = state.workspace_root.read().await.clone();
    create_workspace_folder(&workspace_root, &request.path)?;
    Ok(StatusCode::CREATED)
}

async fn rename_file(
    State(state): State<HttpServerState>,
    headers: HeaderMap,
    Json(request): Json<RenameFileRequest>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    let workspace_root = state.workspace_root.read().await.clone();
    rename_workspace_file(&workspace_root, &request.from_path, &request.to_path)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_file(
    State(state): State<HttpServerState>,
    headers: HeaderMap,
    Json(request): Json<DeleteFileRequest>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    let workspace_root = state.workspace_root.read().await.clone();
    delete_workspace_file(&workspace_root, &request.path)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    query: String,
}

async fn search(
    State(state): State<HttpServerState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<SearchMatch>>, ApiError> {
    let workspace_root = state.workspace_root.read().await.clone();
    Ok(Json(search_workspace(&workspace_root, &query.query, 200)?))
}

async fn get_agent_context(State(state): State<HttpServerState>) -> Json<AgentContext> {
    Json(state.agent_context.read().await.clone())
}

async fn put_agent_context(
    State(state): State<HttpServerState>,
    headers: HeaderMap,
    Json(context): Json<AgentContext>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    *state.agent_context.write().await = context;
    Ok(StatusCode::NO_CONTENT)
}

async fn lsp_servers(State(state): State<HttpServerState>) -> Json<Vec<LspServerStatus>> {
    Json(state.lsp_manager.statuses().await)
}

async fn codex_mcp_status(
    State(state): State<HttpServerState>,
    headers: HeaderMap,
) -> Json<CodexMcpStatus> {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("127.0.0.1:17877");

    Json(CodexMcpStatus {
        endpoint: format!("http://{host}/mcp"),
        bearer_token: state.mcp_token.clone(),
    })
}

#[derive(Debug, Deserialize)]
struct JsonRpcMessage {
    id: Option<Value>,
    method: Option<String>,
    params: Option<Value>,
}

async fn codex_mcp(
    State(state): State<HttpServerState>,
    headers: HeaderMap,
    Json(request): Json<JsonRpcMessage>,
) -> Response {
    if !is_authorized_bearer(&headers, &state.mcp_token) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let Some(id) = request.id.clone() else {
        return StatusCode::ACCEPTED.into_response();
    };

    Json(handle_mcp_request(&state, request, id).await).into_response()
}

async fn handle_mcp_request(state: &HttpServerState, request: JsonRpcMessage, id: Value) -> Value {
    match request.method.as_deref() {
        Some("initialize") => mcp_success_response(
            id,
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "Ide", "version": env!("CARGO_PKG_VERSION") }
            }),
        ),
        Some("ping") => mcp_success_response(id, json!({})),
        Some("tools/list") => mcp_success_response(id, json!({ "tools": mcp_tool_definitions() })),
        Some("tools/call") => handle_mcp_tool_call(state, id, request.params).await,
        Some("resources/list") => mcp_success_response(id, json!({ "resources": [] })),
        Some("prompts/list") => mcp_success_response(id, json!({ "prompts": [] })),
        Some(method) => mcp_error_response(id.into(), -32601, format!("Unknown method: {method}")),
        None => mcp_error_response(id.into(), -32600, "JSON-RPC method is required".to_string()),
    }
}

async fn handle_mcp_tool_call(state: &HttpServerState, id: Value, params: Option<Value>) -> Value {
    let Some(name) = params
        .as_ref()
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
    else {
        return mcp_error_response(id.into(), -32602, "tools/call requires a name".to_string());
    };

    let context = state.agent_context.read().await.clone();
    let workspace_root = state.workspace_root.read().await.clone();
    let result = match name {
        "get_current_selection" | "get_latest_selection" => {
            current_selection(&workspace_root, &context)
        }
        "get_open_editors" => open_editors(&workspace_root, &context),
        "get_workspace_folders" => workspace_folders(&workspace_root),
        "get_editor_context" => editor_context(&workspace_root, &context),
        "get_diagnostics" => diagnostics(&workspace_root, &context),
        _ => {
            return mcp_error_response(id.into(), -32601, format!("Unknown tool: {name}"));
        }
    };

    mcp_success_response(id, mcp_tool_response(result))
}

fn is_authorized_bearer(headers: &HeaderMap, expected_token: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token == expected_token)
}

fn require_bearer_auth(headers: &HeaderMap, expected_token: &str) -> Result<(), ApiError> {
    if is_authorized_bearer(headers, expected_token) {
        Ok(())
    } else {
        Err(ApiError::unauthorized("Unauthorized"))
    }
}

fn mcp_tool_definitions() -> Value {
    json!([
        {
            "name": "get_current_selection",
            "description": "Get the current text selection in the active editor.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "get_latest_selection",
            "description": "Get the most recent text selection recorded by the editor.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "get_open_editors",
            "description": "Get the files currently open in editor tabs.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "get_workspace_folders",
            "description": "Get the workspace folders currently open in the IDE.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "get_editor_context",
            "description": "Get the active file, open files, current selection, and workspace folder in one response.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "get_diagnostics",
            "description": "Get language diagnostics known to the IDE.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }
    ])
}

fn editor_context(workspace_root: &Path, context: &AgentContext) -> Value {
    json!({
        "workspace": workspace_folders(workspace_root),
        "openEditors": open_editors(workspace_root, context),
        "selection": current_selection(workspace_root, context),
        "activeFile": context.active_file.as_ref().map(|path| absolute_path(workspace_root, path)),
        "diagnostics": diagnostics(workspace_root, context)
    })
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
                "path": file_path,
                "isActive": context.active_file.as_deref() == Some(path.as_str()),
                "label": Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(path),
                "languageId": language_id(path)
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

fn mcp_tool_response(result: Value) -> Value {
    let text = serde_json::to_string_pretty(&result).unwrap_or_else(|error| {
        json!({ "error": format!("Unable to serialize tool result: {error}") }).to_string()
    });
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": result
    })
}

fn mcp_success_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn mcp_error_response(id: Option<Value>, code: i32, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

async fn index(State(state): State<HttpServerState>) -> Response {
    serve_static_path(&state.frontend_dist, "index.html").await
}

async fn static_file(
    State(state): State<HttpServerState>,
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Response {
    let requested = path.trim_start_matches('/');
    serve_static_path(&state.frontend_dist, requested).await
}

async fn serve_static_path(frontend_dist: &Path, requested: &str) -> Response {
    let path = static_asset_path(frontend_dist, requested);

    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let content_type = content_type_for(&path);
            ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Html(
            "<!doctype html><title>Ide</title><p>Build the web assets with <code>npm run build</code>, then reload.</p>",
        )
        .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Unable to read static asset {}: {error}", DisplayPath(&path)),
        )
            .into_response(),
    }
}

struct DisplayPath<'a>(&'a Path);

impl fmt::Display for DisplayPath<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = self
            .0
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("requested file");
        formatter.write_str(name)
    }
}

fn static_asset_path(frontend_dist: &Path, requested: &str) -> PathBuf {
    let requested_path = Path::new(requested);
    let requested_has_invalid_component = requested_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    });

    if requested.is_empty() || requested_has_invalid_component {
        return frontend_dist.join("index.html");
    }

    let candidate = frontend_dist.join(requested_path);
    if candidate.exists() && candidate.is_file() {
        candidate
    } else {
        frontend_dist.join("index.html")
    }
}

fn content_type_for(path: &Path) -> HeaderValue {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
    {
        "css" => HeaderValue::from_static("text/css; charset=utf-8"),
        "html" => HeaderValue::from_static("text/html; charset=utf-8"),
        "js" => HeaderValue::from_static("text/javascript; charset=utf-8"),
        "json" => HeaderValue::from_static("application/json; charset=utf-8"),
        "png" => HeaderValue::from_static("image/png"),
        "svg" => HeaderValue::from_static("image/svg+xml"),
        _ => HeaderValue::from_static("application/octet-stream"),
    }
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

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }
}

impl From<crate::workspace::WorkspaceError> for ApiError {
    fn from(value: crate::workspace::WorkspaceError) -> Self {
        let status = match value {
            crate::workspace::WorkspaceError::FileModifiedExternally => StatusCode::CONFLICT,
            _ => StatusCode::BAD_REQUEST,
        };
        Self {
            status,
            message: value.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, self.message).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn static_asset_path_rejects_parent_traversal() {
        let dir = tempdir().unwrap();
        let selected = static_asset_path(dir.path(), "../secret.txt");

        assert_eq!(selected, dir.path().join("index.html"));
    }

    #[test]
    fn static_asset_path_returns_existing_files() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("app.js"), "").unwrap();

        let selected = static_asset_path(dir.path(), "app.js");

        assert_eq!(selected, dir.path().join("app.js"));
    }

    #[test]
    fn mcp_auth_accepts_only_matching_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer expected"),
        );

        assert!(is_authorized_bearer(&headers, "expected"));
        assert!(!is_authorized_bearer(&headers, "other"));
        assert!(!is_authorized_bearer(&HeaderMap::new(), "expected"));
    }

    #[tokio::test]
    async fn write_file_requires_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("note.txt");
        std::fs::write(&file_path, "before").unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };

        let result = write_file(
            State(state),
            HeaderMap::new(),
            Json(WriteFileRequest {
                path: "note.txt".to_string(),
                contents: "after".to_string(),
                expected_modified_ms: None,
            }),
        )
        .await;

        let response = result.unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(std::fs::read_to_string(file_path).unwrap(), "before");
    }

    #[tokio::test]
    async fn write_file_accepts_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("note.txt");
        std::fs::write(&file_path, "before").unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = write_file(
            State(state),
            headers,
            Json(WriteFileRequest {
                path: "note.txt".to_string(),
                contents: "after".to_string(),
                expected_modified_ms: None,
            }),
        )
        .await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
        assert_eq!(std::fs::read_to_string(file_path).unwrap(), "after");
    }

    #[tokio::test]
    async fn write_file_returns_conflict_for_stale_modified_timestamps() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("note.txt");
        std::fs::write(&file_path, "before").unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = write_file(
            State(state),
            headers,
            Json(WriteFileRequest {
                path: "note.txt".to_string(),
                contents: "after".to_string(),
                expected_modified_ms: Some(1),
            }),
        )
        .await;

        let response = result.unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(std::fs::read_to_string(file_path).unwrap(), "before");
    }

    #[tokio::test]
    async fn create_file_requires_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("note.txt");
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };

        let result = create_file(
            State(state),
            HeaderMap::new(),
            Json(WriteFileRequest {
                path: "note.txt".to_string(),
                contents: String::new(),
                expected_modified_ms: None,
            }),
        )
        .await;

        let response = result.unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!file_path.exists());
    }

    #[tokio::test]
    async fn create_file_accepts_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("note.txt");
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = create_file(
            State(state),
            headers,
            Json(WriteFileRequest {
                path: "note.txt".to_string(),
                contents: String::new(),
                expected_modified_ms: None,
            }),
        )
        .await;

        assert_eq!(result.unwrap(), StatusCode::CREATED);
        assert_eq!(std::fs::read_to_string(file_path).unwrap(), "");
    }

    #[tokio::test]
    async fn create_folder_requires_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let folder_path = dir.path().join("src");
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };

        let result = create_folder(
            State(state),
            HeaderMap::new(),
            Json(CreateFolderRequest {
                path: "src".to_string(),
            }),
        )
        .await;

        let response = result.unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!folder_path.exists());
    }

    #[tokio::test]
    async fn create_folder_accepts_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let folder_path = dir.path().join("src");
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = create_folder(
            State(state),
            headers,
            Json(CreateFolderRequest {
                path: "src".to_string(),
            }),
        )
        .await;

        assert_eq!(result.unwrap(), StatusCode::CREATED);
        assert!(folder_path.is_dir());
    }

    #[tokio::test]
    async fn rename_file_requires_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let from_path = dir.path().join("note.txt");
        let to_path = dir.path().join("renamed.txt");
        std::fs::write(&from_path, "before").unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };

        let result = rename_file(
            State(state),
            HeaderMap::new(),
            Json(RenameFileRequest {
                from_path: "note.txt".to_string(),
                to_path: "renamed.txt".to_string(),
            }),
        )
        .await;

        let response = result.unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(from_path.exists());
        assert!(!to_path.exists());
    }

    #[tokio::test]
    async fn rename_file_accepts_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let from_path = dir.path().join("note.txt");
        let to_path = dir.path().join("renamed.txt");
        std::fs::write(&from_path, "before").unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = rename_file(
            State(state),
            headers,
            Json(RenameFileRequest {
                from_path: "note.txt".to_string(),
                to_path: "renamed.txt".to_string(),
            }),
        )
        .await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
        assert!(!from_path.exists());
        assert_eq!(std::fs::read_to_string(to_path).unwrap(), "before");
    }

    #[tokio::test]
    async fn delete_file_requires_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("note.txt");
        std::fs::write(&file_path, "before").unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };

        let result = delete_file(
            State(state),
            HeaderMap::new(),
            Json(DeleteFileRequest {
                path: "note.txt".to_string(),
            }),
        )
        .await;

        let response = result.unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(std::fs::read_to_string(file_path).unwrap(), "before");
    }

    #[tokio::test]
    async fn delete_file_accepts_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("note.txt");
        std::fs::write(&file_path, "before").unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = delete_file(
            State(state),
            headers,
            Json(DeleteFileRequest {
                path: "note.txt".to_string(),
            }),
        )
        .await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
        assert!(!file_path.exists());
    }

    #[tokio::test]
    async fn put_agent_context_requires_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext {
                active_file: Some("before.rs".to_string()),
                open_files: Vec::new(),
                selection: None,
                diagnostics: Vec::new(),
            })),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };

        let result = put_agent_context(
            State(state.clone()),
            HeaderMap::new(),
            Json(AgentContext {
                active_file: Some("after.rs".to_string()),
                open_files: Vec::new(),
                selection: None,
                diagnostics: Vec::new(),
            }),
        )
        .await;

        let response = result.unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            state.agent_context.read().await.active_file.as_deref(),
            Some("before.rs")
        );
    }

    #[test]
    fn loopback_cors_allows_only_local_origins() {
        assert_eq!(
            allowed_loopback_origin(&HeaderValue::from_static("http://127.0.0.1:1420")),
            Some(HeaderValue::from_static("http://127.0.0.1:1420"))
        );
        assert_eq!(
            allowed_loopback_origin(&HeaderValue::from_static("http://localhost:1420")),
            Some(HeaderValue::from_static("http://localhost:1420"))
        );
        assert!(
            allowed_loopback_origin(&HeaderValue::from_static("https://example.com")).is_none()
        );
    }

    #[test]
    fn loopback_cors_sets_preflight_headers_for_allowed_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:1420"),
        );

        let response = apply_loopback_cors(
            headers.get(header::ORIGIN),
            StatusCode::NO_CONTENT.into_response(),
        );

        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("http://127.0.0.1:1420"))
        );
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_HEADERS),
            Some(&HeaderValue::from_static("authorization, content-type"))
        );
    }

    #[tokio::test]
    async fn mcp_tools_list_returns_read_only_editor_tools() {
        let dir = tempdir().unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };

        let response = handle_mcp_request(
            &state,
            JsonRpcMessage {
                id: Some(json!(1)),
                method: Some("tools/list".to_string()),
                params: None,
            },
            json!(1),
        )
        .await;

        assert_eq!(
            response["result"]["tools"][0]["name"],
            "get_current_selection"
        );
        assert_eq!(response["result"]["tools"][4]["name"], "get_editor_context");
        assert_eq!(response["result"]["tools"][5]["name"], "get_diagnostics");
    }

    #[tokio::test]
    async fn mcp_editor_context_includes_active_file() {
        let dir = tempdir().unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            agent_context: Arc::new(RwLock::new(AgentContext {
                active_file: Some("src/main.rs".to_string()),
                open_files: vec!["src/main.rs".to_string()],
                selection: None,
                diagnostics: Vec::new(),
            })),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
        };

        let response = handle_mcp_tool_call(
            &state,
            json!(2),
            Some(json!({ "name": "get_editor_context", "arguments": {} })),
        )
        .await;

        assert_eq!(
            response["result"]["structuredContent"]["openEditors"]["tabs"][0]["isActive"],
            true
        );
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
