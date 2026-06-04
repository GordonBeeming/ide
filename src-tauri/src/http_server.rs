use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

use crate::lsp::{LspManager, LspServerStatus};
use crate::workspace::{
    read_workspace_file, scan_workspace, search_workspace, write_workspace_file, FileEntry,
    SearchMatch,
};
use crate::AgentContext;

#[derive(Clone)]
pub struct HttpServerState {
    workspace_root: Arc<RwLock<PathBuf>>,
    agent_context: Arc<RwLock<AgentContext>>,
    lsp_manager: LspManager,
    frontend_dist: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpServerInfo {
    pub endpoint: String,
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
}

pub async fn start_http_server(
    root_path: Arc<RwLock<PathBuf>>,
    agent_context: Arc<RwLock<AgentContext>>,
    lsp_manager: LspManager,
    frontend_dist: PathBuf,
    server_error: Arc<RwLock<Option<String>>>,
) -> Result<HttpServerInfo, std::io::Error> {
    let state = HttpServerState {
        workspace_root: root_path,
        agent_context,
        lsp_manager,
        frontend_dist,
    };
    let app = Router::new()
        .route("/api/workspace-root", get(workspace_root))
        .route("/api/files", get(files))
        .route("/api/search", get(search))
        .route("/api/file", get(read_file).put(write_file))
        .route(
            "/api/agent-context",
            get(get_agent_context).put(put_agent_context),
        )
        .route("/api/lsp", get(lsp_servers))
        .route("/", get(index))
        .route("/{*path}", get(static_file))
        .with_state(state);

    let listener = bind_loopback().await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            *server_error.write().await = Some(error.to_string());
        }
    });

    Ok(HttpServerInfo { endpoint })
}

async fn bind_loopback() -> Result<TcpListener, std::io::Error> {
    let preferred = SocketAddr::from((Ipv4Addr::LOCALHOST, 17877));
    match TcpListener::bind(preferred).await {
        Ok(listener) => Ok(listener),
        Err(_) => TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await,
    }
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
    Json(request): Json<WriteFileRequest>,
) -> Result<StatusCode, ApiError> {
    let workspace_root = state.workspace_root.read().await.clone();
    write_workspace_file(&workspace_root, &request.path, &request.contents)?;
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
    Json(context): Json<AgentContext>,
) -> StatusCode {
    *state.agent_context.write().await = context;
    StatusCode::NO_CONTENT
}

async fn lsp_servers(State(state): State<HttpServerState>) -> Json<Vec<LspServerStatus>> {
    Json(state.lsp_manager.statuses().await)
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
        Err(_) => Html(
            "<!doctype html><title>Ide</title><p>Build the web assets with <code>npm run build</code>, then reload.</p>",
        )
        .into_response(),
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

#[derive(Debug)]
struct ApiError(String);

impl From<crate::workspace::WorkspaceError> for ApiError {
    fn from(value: crate::workspace::WorkspaceError) -> Self {
        Self(value.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (StatusCode::BAD_REQUEST, self.0).into_response()
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
}
