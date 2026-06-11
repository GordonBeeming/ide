use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::{fmt, io};

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tower::Layer;

use crate::lsp::{LspManager, LspServerStatus};
use crate::workspace::{
    create_workspace_file, create_workspace_folder, delete_workspace_file, read_workspace_file,
    rename_workspace_file, scan_workspace_with_metadata, search_workspace_with_metadata,
    workspace_directory_entries, workspace_entry, workspace_file_entry, write_workspace_file,
    FileEntry, WorkspaceScan, WorkspaceSearch,
};
use crate::workspace_index::{advance_workspace_index, WorkspaceIndex, WorkspaceIndexAdvanceError};
use crate::{workspace_root_hash, AgentContext, WorkspaceSessionState};

#[derive(Clone)]
pub struct HttpServerState {
    workspace_root: Arc<RwLock<PathBuf>>,
    tree_scan_limit: Arc<std::sync::RwLock<usize>>,
    max_open_file_bytes: Arc<std::sync::RwLock<u64>>,
    workspace_search_result_limit: Arc<std::sync::RwLock<usize>>,
    workspace_search_max_file_bytes: Arc<std::sync::RwLock<u64>>,
    quick_open_result_limit: Arc<std::sync::RwLock<usize>>,
    background_index_batch_entries: Arc<std::sync::RwLock<usize>>,
    workspace_index: WorkspaceIndex,
    agent_context: Arc<RwLock<AgentContext>>,
    lsp_manager: LspManager,
    frontend_dist: PathBuf,
    mcp_token: String,
    window_sessions: Arc<std::sync::RwLock<HashMap<String, WorkspaceSessionState>>>,
}

/// The workspace a request resolves to, set by `resolve_workspace_middleware` and
/// read by every workspace-scoped handler. A `/{hash}/...` request resolves to the
/// matching open session; everything else falls back to the shared/default root, so
/// the no-hash API surface (dev on port 1420, `/mcp`, Codex) is unchanged.
#[derive(Clone)]
struct ResolvedWorkspace {
    workspace_root: Arc<RwLock<PathBuf>>,
    agent_context: Arc<RwLock<AgentContext>>,
    /// True when the request carried a `/{hash}` prefix that matched an open
    /// workspace. The `/` handler uses this to serve the SPA for `/{hash}/`
    /// (rewritten to `/`) versus the chooser landing page for a bare `/`.
    scoped: bool,
}

pub struct HttpServerConfig {
    pub root_path: Arc<RwLock<PathBuf>>,
    pub tree_scan_limit: Arc<std::sync::RwLock<usize>>,
    pub max_open_file_bytes: Arc<std::sync::RwLock<u64>>,
    pub workspace_search_result_limit: Arc<std::sync::RwLock<usize>>,
    pub workspace_search_max_file_bytes: Arc<std::sync::RwLock<u64>>,
    pub quick_open_result_limit: Arc<std::sync::RwLock<usize>>,
    pub background_index_batch_entries: Arc<std::sync::RwLock<usize>>,
    pub workspace_index: WorkspaceIndex,
    pub agent_context: Arc<RwLock<AgentContext>>,
    pub lsp_manager: LspManager,
    pub frontend_dist: PathBuf,
    pub mcp_token: String,
    pub app_handle: tauri::AppHandle,
    pub server_error: Arc<RwLock<Option<String>>>,
    pub window_sessions: Arc<std::sync::RwLock<HashMap<String, WorkspaceSessionState>>>,
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
#[serde(rename_all = "camelCase")]
struct FileQuery {
    path: String,
    max_open_bytes: Option<u64>,
    show_dotfiles: Option<bool>,
    show_generated_internal: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesQuery {
    show_dotfiles: Option<bool>,
    show_generated_internal: Option<bool>,
    tree_scan_limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDisplayQuery {
    title_max_chars: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexedFilesQuery {
    query: Option<String>,
    limit: Option<usize>,
    show_dotfiles: Option<bool>,
    show_generated_internal: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdvanceWorkspaceIndexQuery {
    entry_limit: Option<usize>,
    show_dotfiles: Option<bool>,
    show_generated_internal: Option<bool>,
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
struct OpenPathRequest {
    path: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceEvent {
    path: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OpenFileEvent {
    workspace_root: String,
    path: String,
    single_file: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum OpenPathEvent {
    Workspace(OpenWorkspaceEvent),
    File(OpenFileEvent),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameFileRequest {
    from_path: String,
    to_path: String,
}

pub async fn start_http_server(config: HttpServerConfig) -> Result<HttpServerInfo, std::io::Error> {
    let HttpServerConfig {
        root_path,
        tree_scan_limit,
        max_open_file_bytes,
        workspace_search_result_limit,
        workspace_search_max_file_bytes,
        quick_open_result_limit,
        background_index_batch_entries,
        workspace_index,
        agent_context,
        lsp_manager,
        frontend_dist,
        mcp_token,
        app_handle,
        server_error,
        window_sessions,
    } = config;
    let state = HttpServerState {
        workspace_root: root_path,
        tree_scan_limit,
        max_open_file_bytes,
        workspace_search_result_limit,
        workspace_search_max_file_bytes,
        quick_open_result_limit,
        background_index_batch_entries,
        workspace_index,
        agent_context,
        lsp_manager,
        frontend_dist,
        mcp_token: mcp_token.clone(),
        window_sessions,
    };
    let resolve_state = state.clone();
    let open_path_app = app_handle.clone();
    let open_path_token = mcp_token.clone();
    let app = Router::new()
        .route("/api/workspace-root", get(workspace_root))
        .route("/api/workspace-display", get(workspace_display))
        .route("/api/files", get(files))
        .route("/api/file-search", get(indexed_files))
        .route("/api/workspace-index", get(workspace_index_stats))
        .route(
            "/api/workspace-index/advance",
            post(advance_workspace_index_route).options(cors_preflight),
        )
        .route("/api/directory", get(directory))
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
        .route("/api/file-metadata", get(stat_file))
        .route("/api/folder", post(create_folder).options(cors_preflight))
        .route(
            "/api/open-path",
            post(
                move |headers: HeaderMap, Json(request): Json<OpenPathRequest>| {
                    let app = open_path_app.clone();
                    let token = open_path_token.clone();
                    async move { open_path(app, token, headers, request).await }
                },
            )
            .options(cors_preflight),
        )
        .route(
            "/api/agent-context",
            get(get_agent_context)
                .put(put_agent_context)
                .options(cors_preflight),
        )
        .route("/api/lsp", get(lsp_servers))
        .route("/api/codex-mcp", get(codex_mcp_status))
        .route("/api/workspaces", get(workspaces))
        .route("/mcp", post(codex_mcp).options(cors_preflight))
        .route("/", get(index))
        .route("/{*path}", get(static_file).options(cors_preflight))
        .with_state(state)
        .layer(middleware::from_fn(loopback_cors));

    // The workspace resolver rewrites the request URI (stripping a `/{hash}` prefix),
    // so it has to run BEFORE routing. `Router::layer` runs after a route is matched
    // (the same gotcha as tower-http's NormalizePath), so wrap the whole router from
    // the outside instead and serve the wrapped service.
    let app =
        middleware::from_fn_with_state(resolve_state, resolve_workspace_middleware).layer(app);

    let listener = bind_loopback().await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    tauri::async_runtime::spawn(async move {
        let make_service = axum::ServiceExt::<Request<axum::body::Body>>::into_make_service(app);
        if let Err(error) = axum::serve(listener, make_service).await {
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

/// Splits a leading path segment (the candidate workspace hash) off the request
/// path, returning that segment plus the remainder (without a leading slash). The
/// remainder is borrowed from the input — the caller formats `/{rest}` only when it
/// actually rewrites, so unscoped requests (the common case) allocate nothing. A
/// bare `/` yields two empty strings.
fn split_workspace_prefix(path: &str) -> (&str, &str) {
    let trimmed = path.strip_prefix('/').unwrap_or(path);
    match trimmed.split_once('/') {
        Some((first, rest)) => (first, rest),
        None => (trimmed, ""),
    }
}

/// Whether a path segment is shaped like a `workspace_root_hash` token: 1–16
/// lowercase hex digits. Real top-level routes (`api`, `assets`, `mcp`) and static
/// filenames (which carry a `.`) never match, so this distinguishes a workspace
/// prefix from an ordinary path without consulting the session list.
fn looks_like_workspace_hash(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 16
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

async fn resolve_workspace_by_hash(
    sessions: &Arc<std::sync::RwLock<HashMap<String, WorkspaceSessionState>>>,
    hash: &str,
) -> Option<ResolvedWorkspace> {
    // Snapshot the Arcs under the sync lock, then read each root on the async side,
    // mirroring `workspace_root_is_used_by_any_session` in lib.rs.
    let snapshot: Vec<WorkspaceSessionState> = sessions.read().ok()?.values().cloned().collect();
    for session in snapshot {
        let root = session.workspace_root.read().await.clone();
        if workspace_root_hash(&root) == hash {
            return Some(ResolvedWorkspace {
                workspace_root: session.workspace_root.clone(),
                agent_context: session.agent_context.clone(),
                scoped: true,
            });
        }
    }
    None
}

fn rewrite_request_path(request: &mut Request<axum::body::Body>, new_path: &str) {
    let path_and_query = match request.uri().query() {
        Some(query) => format!("{new_path}?{query}"),
        None => new_path.to_string(),
    };
    if let Ok(uri) = path_and_query.parse::<Uri>() {
        *request.uri_mut() = uri;
    }
}

/// Resolves a leading `/{hash}` path segment to an open workspace, rewriting the URI
/// to drop the prefix and stashing the resolved root + agent context as a request
/// extension. Runs before route matching so the existing `/api/...` and `/` routes
/// see the stripped path. Requests without a hash-shaped prefix get the
/// shared/default workspace, leaving the no-hash API surface unchanged.
///
/// A hash-shaped prefix is stripped even when it doesn't match an open workspace, so
/// a stale `/{hash}/` bookmark falls back to the shared root (and the chooser for
/// `/`) instead of leaking SPA HTML out of `/{hash}/api/...` paths.
async fn resolve_workspace_middleware(
    State(state): State<HttpServerState>,
    mut request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let default = ResolvedWorkspace {
        workspace_root: state.workspace_root.clone(),
        agent_context: state.agent_context.clone(),
        scoped: false,
    };
    // Borrow the path and only allocate when there's a hash-shaped prefix to strip —
    // the owned `candidate`/rewritten path are needed because the URI mutation and the
    // `.await` below outlive the borrow. Unscoped requests (the hot path) allocate nothing.
    let rewrite = {
        let (candidate, rest) = split_workspace_prefix(request.uri().path());
        looks_like_workspace_hash(candidate).then(|| (candidate.to_string(), format!("/{rest}")))
    };
    let resolved = match rewrite {
        // Strip the hash-shaped prefix regardless of whether it resolves; an unknown
        // token falls back to the shared root rather than serving HTML from an API path.
        Some((candidate, rewritten)) => {
            rewrite_request_path(&mut request, &rewritten);
            resolve_workspace_by_hash(&state.window_sessions, &candidate)
                .await
                .unwrap_or(default)
        }
        None => default,
    };
    request.extensions_mut().insert(resolved);
    next.run(request).await
}

async fn workspace_root(Extension(resolved): Extension<ResolvedWorkspace>) -> Json<String> {
    Json(
        resolved
            .workspace_root
            .read()
            .await
            .to_string_lossy()
            .to_string(),
    )
}

async fn workspace_display(
    Extension(resolved): Extension<ResolvedWorkspace>,
    Query(query): Query<WorkspaceDisplayQuery>,
) -> Json<crate::WorkspaceDisplayContext> {
    let workspace_root = resolved.workspace_root.read().await.clone();
    Json(crate::workspace_display_context(
        &workspace_root,
        query.title_max_chars.unwrap_or(50).clamp(20, 120),
    ))
}

async fn files(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    Query(query): Query<FilesQuery>,
) -> Result<Json<WorkspaceScan>, ApiError> {
    let workspace_root = resolved.workspace_root.read().await.clone();
    let tree_scan_limit = query
        .tree_scan_limit
        .unwrap_or_else(|| {
            state
                .tree_scan_limit
                .read()
                .map(|limit| *limit)
                .unwrap_or(10_000)
        })
        .clamp(500, 100_000);
    let scan = scan_workspace_with_metadata(
        &workspace_root,
        tree_scan_limit,
        query.show_dotfiles.unwrap_or(false),
        query.show_generated_internal.unwrap_or(false),
    )?;
    state.workspace_index.reconcile_scanned_entries(
        &workspace_root,
        &scan.entries,
        !scan.truncated,
    )?;
    Ok(Json(scan))
}

async fn indexed_files(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    Query(query): Query<IndexedFilesQuery>,
) -> Result<Json<Vec<FileEntry>>, ApiError> {
    let workspace_root = resolved.workspace_root.read().await.clone();
    let limit = query
        .limit
        .unwrap_or_else(|| {
            state
                .quick_open_result_limit
                .read()
                .map(|limit| *limit)
                .unwrap_or(12)
        })
        .clamp(5, 100);
    let expansion_limit = state
        .tree_scan_limit
        .read()
        .map(|limit| *limit)
        .unwrap_or(10_000)
        .clamp(500, 100_000);
    Ok(Json(search_indexed_files_with_expansion(
        &state.workspace_index,
        &workspace_root,
        query.query.as_deref().unwrap_or(""),
        limit,
        expansion_limit,
        query.show_dotfiles.unwrap_or(false),
        query.show_generated_internal.unwrap_or(false),
    )?))
}

async fn workspace_index_stats(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
) -> Result<Json<crate::workspace_index::WorkspaceIndexStats>, ApiError> {
    let workspace_root = resolved.workspace_root.read().await.clone();
    Ok(Json(state.workspace_index.stats_for_root(&workspace_root)?))
}

async fn advance_workspace_index_route(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    Query(query): Query<AdvanceWorkspaceIndexQuery>,
) -> Result<Json<crate::workspace_index::WorkspaceIndexStats>, ApiError> {
    let workspace_root = resolved.workspace_root.read().await.clone();
    let entry_limit = query
        .entry_limit
        .unwrap_or_else(|| {
            state
                .background_index_batch_entries
                .read()
                .map(|limit| *limit)
                .unwrap_or(2_000)
        })
        .clamp(100, 20_000);
    Ok(Json(advance_workspace_index(
        &state.workspace_index,
        &workspace_root,
        entry_limit,
        query.show_dotfiles.unwrap_or(false),
        query.show_generated_internal.unwrap_or(false),
    )?))
}

fn search_indexed_files_with_expansion(
    index: &WorkspaceIndex,
    root: &Path,
    query: &str,
    limit: usize,
    expansion_limit: usize,
    show_dotfiles: bool,
    show_generated_internal: bool,
) -> Result<Vec<FileEntry>, ApiError> {
    let mut results = index.search_files(root, query, limit)?;
    if query.trim().is_empty() || results.len() >= limit {
        return Ok(results);
    }

    let mut remaining_entries = expansion_limit;
    while results.len() < limit && remaining_entries > 0 {
        let Some(directory) = index
            .next_unindexed_directories(root, 1)?
            .into_iter()
            .next()
        else {
            break;
        };
        let entries = match workspace_directory_entries(
            root,
            &directory,
            show_dotfiles,
            show_generated_internal,
        ) {
            Ok(entries) => entries,
            Err(error) if !directory.is_empty() && stale_indexed_directory_error(&error) => {
                index.remove_path(root, &directory)?;
                remaining_entries = remaining_entries.saturating_sub(1);
                results = index.search_files(root, query, limit)?;
                continue;
            }
            Err(error) => return Err(ApiError::from(error)),
        };
        remaining_entries = remaining_entries.saturating_sub(entries.len().max(1));
        index.replace_directory_entries(root, &directory, &entries)?;
        results = index.search_files(root, query, limit)?;
    }

    Ok(results)
}

fn stale_indexed_directory_error(error: &crate::workspace::WorkspaceError) -> bool {
    matches!(error, crate::workspace::WorkspaceError::NotADirectory)
        || matches!(error, crate::workspace::WorkspaceError::Io(io_error) if io_error.kind() == std::io::ErrorKind::NotFound)
}

async fn directory(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    Query(query): Query<FileQuery>,
) -> Result<Json<Vec<FileEntry>>, ApiError> {
    let workspace_root = resolved.workspace_root.read().await.clone();
    let entries = workspace_directory_entries(
        &workspace_root,
        &query.path,
        query.show_dotfiles.unwrap_or(false),
        query.show_generated_internal.unwrap_or(false),
    )?;
    state
        .workspace_index
        .replace_directory_entries(&workspace_root, &query.path, &entries)?;
    Ok(Json(entries))
}

async fn read_file(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    Query(query): Query<FileQuery>,
) -> Result<String, ApiError> {
    let workspace_root = resolved.workspace_root.read().await.clone();
    let max_open_bytes = query
        .max_open_bytes
        .unwrap_or_else(|| {
            state
                .max_open_file_bytes
                .read()
                .map(|limit| *limit)
                .unwrap_or(5_120 * 1024)
        })
        .clamp(64 * 1024, 65_536 * 1024);
    Ok(read_workspace_file(
        &workspace_root,
        &query.path,
        max_open_bytes,
    )?)
}

async fn stat_file(
    Extension(resolved): Extension<ResolvedWorkspace>,
    Query(query): Query<FileQuery>,
) -> Result<Json<FileEntry>, ApiError> {
    let workspace_root = resolved.workspace_root.read().await.clone();
    Ok(Json(workspace_file_entry(&workspace_root, &query.path)?))
}

async fn write_file(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    headers: HeaderMap,
    Json(request): Json<WriteFileRequest>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    let workspace_root = resolved.workspace_root.read().await.clone();
    write_workspace_file(
        &workspace_root,
        &request.path,
        &request.contents,
        request.expected_modified_ms,
    )?;
    refresh_indexed_entry(&state.workspace_index, &workspace_root, &request.path)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_file(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    headers: HeaderMap,
    Json(request): Json<WriteFileRequest>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    let workspace_root = resolved.workspace_root.read().await.clone();
    create_workspace_file(&workspace_root, &request.path)?;
    refresh_indexed_entry(&state.workspace_index, &workspace_root, &request.path)?;
    Ok(StatusCode::CREATED)
}

async fn create_folder(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    headers: HeaderMap,
    Json(request): Json<CreateFolderRequest>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    let workspace_root = resolved.workspace_root.read().await.clone();
    create_workspace_folder(&workspace_root, &request.path)?;
    refresh_indexed_entry(&state.workspace_index, &workspace_root, &request.path)?;
    Ok(StatusCode::CREATED)
}

fn refresh_indexed_entry(
    index: &WorkspaceIndex,
    root: &Path,
    relative: &str,
) -> Result<(), ApiError> {
    let entry = workspace_entry(root, relative)?;
    index.upsert_entries(root, &[entry])?;
    Ok(())
}

async fn open_path(
    app: tauri::AppHandle,
    expected_token: String,
    headers: HeaderMap,
    request: OpenPathRequest,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &expected_token)?;
    match open_path_event_for_path(PathBuf::from(request.path))
        .map_err(|error| ApiError::bad_request(error.to_string()))?
    {
        OpenPathEvent::Workspace(event) => app
            .emit("menu://open-workspace", event)
            .map_err(|error| ApiError::internal(error.to_string()))?,
        OpenPathEvent::File(event) => app
            .emit("menu://open-file", event)
            .map_err(|error| ApiError::internal(error.to_string()))?,
    }
    Ok(StatusCode::ACCEPTED)
}

fn open_path_event_for_path(path: PathBuf) -> Result<OpenPathEvent, std::io::Error> {
    let canonical = path.canonicalize()?;
    if canonical.is_dir() {
        return Ok(OpenPathEvent::Workspace(OpenWorkspaceEvent {
            path: canonical.to_string_lossy().to_string(),
        }));
    }

    let workspace_root = canonical
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| canonical.clone());
    let relative_path = canonical
        .strip_prefix(&workspace_root)
        .ok()
        .and_then(|path| path.to_str())
        .map(|path| path.replace('\\', "/"))
        .ok_or_else(|| io::Error::other("selected file path is invalid"))?;

    Ok(OpenPathEvent::File(OpenFileEvent {
        workspace_root: workspace_root.to_string_lossy().to_string(),
        path: relative_path,
        single_file: true,
    }))
}

async fn rename_file(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    headers: HeaderMap,
    Json(request): Json<RenameFileRequest>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    let workspace_root = resolved.workspace_root.read().await.clone();
    rename_workspace_file(&workspace_root, &request.from_path, &request.to_path)?;
    state
        .workspace_index
        .remove_path(&workspace_root, &request.from_path)?;
    refresh_indexed_entry(&state.workspace_index, &workspace_root, &request.to_path)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_file(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    headers: HeaderMap,
    Json(request): Json<DeleteFileRequest>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    let workspace_root = resolved.workspace_root.read().await.clone();
    delete_workspace_file(&workspace_root, &request.path)?;
    state
        .workspace_index
        .remove_path(&workspace_root, &request.path)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    query: String,
    max_results: Option<usize>,
    max_file_bytes: Option<u64>,
    show_dotfiles: Option<bool>,
}

async fn search(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<WorkspaceSearch>, ApiError> {
    let workspace_root = resolved.workspace_root.read().await.clone();
    let max_results = query
        .max_results
        .unwrap_or_else(|| {
            state
                .workspace_search_result_limit
                .read()
                .map(|limit| *limit)
                .unwrap_or(200)
        })
        .clamp(25, 5_000);
    let max_file_bytes = query
        .max_file_bytes
        .unwrap_or_else(|| {
            state
                .workspace_search_max_file_bytes
                .read()
                .map(|limit| *limit)
                .unwrap_or(1_024 * 1_024)
        })
        .clamp(64 * 1024, 16_384 * 1024);
    Ok(Json(search_workspace_with_metadata(
        &workspace_root,
        &query.query,
        max_results,
        max_file_bytes,
        query.show_dotfiles.unwrap_or(false),
    )?))
}

async fn get_agent_context(
    Extension(resolved): Extension<ResolvedWorkspace>,
) -> Json<AgentContext> {
    Json(resolved.agent_context.read().await.clone())
}

async fn put_agent_context(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
    headers: HeaderMap,
    Json(context): Json<AgentContext>,
) -> Result<StatusCode, ApiError> {
    require_bearer_auth(&headers, &state.mcp_token)?;
    *resolved.agent_context.write().await = context;
    Ok(StatusCode::NO_CONTENT)
}

async fn lsp_servers(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
) -> Json<Vec<LspServerStatus>> {
    let workspace_root = resolved.workspace_root.read().await.clone();
    Json(state.lsp_manager.statuses(&workspace_root).await)
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
                "serverInfo": { "name": "ide", "version": env!("CARGO_PKG_VERSION") }
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSummary {
    hash: String,
    path: String,
    name: String,
}

/// One summary per distinct open workspace folder (deduped by hash, sorted by name).
async fn workspace_summaries(
    sessions: &Arc<std::sync::RwLock<HashMap<String, WorkspaceSessionState>>>,
) -> Vec<WorkspaceSummary> {
    let snapshot: Vec<WorkspaceSessionState> = sessions
        .read()
        .ok()
        .map(|sessions| sessions.values().cloned().collect())
        .unwrap_or_default();
    let mut summaries: Vec<WorkspaceSummary> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for session in snapshot {
        let root = session.workspace_root.read().await.clone();
        let hash = workspace_root_hash(&root);
        if !seen.insert(hash.clone()) {
            continue;
        }
        let name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workspace")
            .to_string();
        summaries.push(WorkspaceSummary {
            hash,
            path: root.to_string_lossy().to_string(),
            name,
        });
    }
    summaries.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    summaries
}

async fn workspaces(State(state): State<HttpServerState>) -> Json<Vec<WorkspaceSummary>> {
    Json(workspace_summaries(&state.window_sessions).await)
}

async fn index(
    State(state): State<HttpServerState>,
    Extension(resolved): Extension<ResolvedWorkspace>,
) -> Response {
    // A matched `/{hash}` prefix was rewritten to `/`; serve the SPA for that
    // workspace. A bare `/` lists the open workspaces instead.
    if resolved.scoped {
        return serve_static_path(&state.frontend_dist, "index.html").await;
    }
    render_workspace_chooser(&workspace_summaries(&state.window_sessions).await).into_response()
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn render_workspace_chooser(summaries: &[WorkspaceSummary]) -> Html<String> {
    // A lone workspace doesn't need a chooser — bounce straight into the editor so
    // the common single-window case behaves like it always has.
    if let [only] = summaries {
        return Html(format!(
            "<!doctype html><meta charset=\"utf-8\">\
             <meta http-equiv=\"refresh\" content=\"0; url=/{hash}/\">\
             <title>ide</title>\
             <p>Opening <a href=\"/{hash}/\">{name}</a>…</p>",
            hash = escape_html(&only.hash),
            name = escape_html(&only.name),
        ));
    }

    let body = if summaries.is_empty() {
        "<p class=\"empty\">No workspaces are open.</p>".to_string()
    } else {
        let items = summaries
            .iter()
            .map(|summary| {
                format!(
                    "<li><a href=\"/{hash}/\"><span class=\"name\">{name}</span>\
                     <span class=\"path\">{path}</span></a></li>",
                    hash = escape_html(&summary.hash),
                    name = escape_html(&summary.name),
                    path = escape_html(&summary.path),
                )
            })
            .collect::<String>();
        format!("<ul class=\"workspaces\">{items}</ul>")
    };

    Html(format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>ide — open workspaces</title>\
         <style>\
         :root{{color-scheme:dark}}\
         body{{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;\
         justify-content:center;gap:1.5rem;background:#11131a;color:#e6e8ef;\
         font:16px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}}\
         h1{{margin:0;font-size:1.1rem;font-weight:600;color:#aab1c5;letter-spacing:.02em}}\
         ul.workspaces{{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;\
         gap:.5rem;width:min(92vw,640px)}}\
         a{{display:flex;flex-direction:column;gap:.15rem;padding:.85rem 1rem;border-radius:10px;\
         background:#1b1e29;border:1px solid #272b3a;text-decoration:none;color:inherit;\
         transition:border-color .12s,background .12s}}\
         a:hover{{background:#212536;border-color:#3a4060}}\
         .name{{font-weight:600}}\
         .path{{font-size:.82rem;color:#8b93a7;word-break:break-all}}\
         .empty{{color:#8b93a7}}\
         </style></head><body>\
         <h1>Open workspaces</h1>{body}</body></html>"
    ))
}

async fn static_file(
    State(state): State<HttpServerState>,
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Response {
    let requested = path.trim_start_matches('/');
    serve_static_path(&state.frontend_dist, requested).await
}

async fn serve_static_path(frontend_dist: &Path, requested: &str) -> Response {
    let target = static_asset_path(frontend_dist, requested);

    let path = match target {
        StaticAssetTarget::File(path) | StaticAssetTarget::SpaIndex(path) => path,
        StaticAssetTarget::MissingAsset(path) => {
            return (
                StatusCode::NOT_FOUND,
                format!("Static asset not found: {}", DisplayPath(&path)),
            )
                .into_response();
        }
    };

    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let content_type = content_type_for(&path);
            ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Html(
            "<!doctype html><title>ide</title><p>Build the web assets with <code>npm run build</code>, then reload.</p>",
        )
        .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Unable to read static asset {}: {error}", DisplayPath(&path)),
        )
            .into_response(),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum StaticAssetTarget {
    File(PathBuf),
    SpaIndex(PathBuf),
    MissingAsset(PathBuf),
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

fn static_asset_path(frontend_dist: &Path, requested: &str) -> StaticAssetTarget {
    let requested_path = Path::new(requested);
    let requested_has_invalid_component = requested_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    });

    if requested.is_empty() || requested_has_invalid_component {
        return StaticAssetTarget::SpaIndex(frontend_dist.join("index.html"));
    }

    let candidate = frontend_dist.join(requested_path);
    if candidate.exists() && candidate.is_file() {
        StaticAssetTarget::File(candidate)
    } else if is_static_asset_request(requested_path) {
        StaticAssetTarget::MissingAsset(candidate)
    } else {
        StaticAssetTarget::SpaIndex(frontend_dist.join("index.html"))
    }
}

fn is_static_asset_request(path: &Path) -> bool {
    path.components()
        .next()
        .is_some_and(|component| component.as_os_str() == "assets")
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
        "woff2" => HeaderValue::from_static("font/woff2"),
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

    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
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

impl From<crate::workspace_index::WorkspaceIndexError> for ApiError {
    fn from(value: crate::workspace_index::WorkspaceIndexError) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: value.to_string(),
        }
    }
}

impl From<WorkspaceIndexAdvanceError> for ApiError {
    fn from(value: WorkspaceIndexAdvanceError) -> Self {
        match value {
            WorkspaceIndexAdvanceError::Index(error) => ApiError::from(error),
            WorkspaceIndexAdvanceError::Workspace(error) => ApiError::from(error),
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

    fn test_workspace_index(root: &Path) -> WorkspaceIndex {
        let index = WorkspaceIndex::new();
        index
            .set_database_path(root.join("workspace-index.sqlite"))
            .unwrap();
        index
    }

    /// The unscoped extension the middleware would insert for a no-hash request,
    /// pointing at the state's shared root — what handler unit tests exercise.
    fn default_resolved(state: &HttpServerState) -> Extension<ResolvedWorkspace> {
        Extension(ResolvedWorkspace {
            workspace_root: state.workspace_root.clone(),
            agent_context: state.agent_context.clone(),
            scoped: false,
        })
    }

    fn test_file_entry(path: &str, parent: Option<&str>, is_dir: bool) -> FileEntry {
        FileEntry {
            path: path.to_string(),
            name: Path::new(path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            parent: parent.map(ToString::to_string),
            is_dir,
            depth: path.matches('/').count(),
            size: 0,
            modified_ms: Some(1),
        }
    }

    #[test]
    fn hosted_indexed_file_search_discards_stale_expansion_directories() {
        let dir = tempdir().unwrap();
        let index = test_workspace_index(dir.path());
        index
            .replace_root_entries(dir.path(), &[test_file_entry("missing", None, true)])
            .unwrap();
        index
            .replace_directory_entries(dir.path(), "", &[test_file_entry("missing", None, true)])
            .unwrap();

        let results =
            search_indexed_files_with_expansion(&index, dir.path(), "needle", 10, 20, false, false)
                .unwrap();

        assert!(results.is_empty());
        assert!(index.entries_for_root(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn static_asset_path_rejects_parent_traversal() {
        let dir = tempdir().unwrap();
        let selected = static_asset_path(dir.path(), "../secret.txt");

        assert_eq!(
            selected,
            StaticAssetTarget::SpaIndex(dir.path().join("index.html"))
        );
    }

    #[test]
    fn static_asset_path_returns_existing_files() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("app.js"), "").unwrap();

        let selected = static_asset_path(dir.path(), "app.js");

        assert_eq!(selected, StaticAssetTarget::File(dir.path().join("app.js")));
    }

    #[test]
    fn static_asset_path_returns_spa_index_for_client_routes() {
        let dir = tempdir().unwrap();
        let selected = static_asset_path(dir.path(), "workspace/src/main.rs");

        assert_eq!(
            selected,
            StaticAssetTarget::SpaIndex(dir.path().join("index.html"))
        );
    }

    #[test]
    fn static_asset_path_returns_missing_asset_for_asset_routes() {
        let dir = tempdir().unwrap();
        let selected = static_asset_path(dir.path(), "assets/index-stale.js");

        assert_eq!(
            selected,
            StaticAssetTarget::MissingAsset(dir.path().join("assets/index-stale.js"))
        );
    }

    #[test]
    fn content_type_includes_fonts_for_packaged_assets() {
        assert_eq!(
            content_type_for(Path::new("file-icons.woff2")),
            HeaderValue::from_static("font/woff2")
        );
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

    #[test]
    fn open_path_event_maps_folders_and_files_to_frontend_events() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let src = workspace.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let file = src.join("main.rs");
        std::fs::write(&file, "fn main() {}").unwrap();
        let canonical_workspace = workspace.canonicalize().unwrap();

        assert_eq!(
            open_path_event_for_path(workspace.clone()).unwrap(),
            OpenPathEvent::Workspace(OpenWorkspaceEvent {
                path: canonical_workspace.to_string_lossy().to_string()
            })
        );
        assert_eq!(
            open_path_event_for_path(file).unwrap(),
            OpenPathEvent::File(OpenFileEvent {
                workspace_root: src.canonicalize().unwrap().to_string_lossy().to_string(),
                path: "main.rs".to_string(),
                single_file: true
            })
        );
    }

    #[tokio::test]
    async fn write_file_requires_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("note.txt");
        std::fs::write(&file_path, "before").unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };

        let result = write_file(
            State(state.clone()),
            default_resolved(&state),
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
    async fn advance_workspace_index_indexes_pending_directories_in_batches() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src").join("main.rs"), "fn main() {}").unwrap();
        let index = test_workspace_index(dir.path());
        index
            .replace_root_entries(dir.path(), &[test_file_entry("src", None, true)])
            .unwrap();
        index
            .replace_directory_entries(dir.path(), "", &[test_file_entry("src", None, true)])
            .unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: index,
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };

        let Json(stats) = advance_workspace_index_route(
            State(state.clone()),
            default_resolved(&state),
            Query(AdvanceWorkspaceIndexQuery {
                entry_limit: Some(100),
                show_dotfiles: Some(false),
                show_generated_internal: Some(false),
            }),
        )
        .await
        .unwrap();

        assert_eq!(stats.pending_folders, 0);
        assert_eq!(stats.indexed_files, 1);
    }

    #[tokio::test]
    async fn write_file_accepts_matching_bearer_token() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("note.txt");
        std::fs::write(&file_path, "before").unwrap();
        let state = HttpServerState {
            workspace_root: Arc::new(RwLock::new(dir.path().to_path_buf())),
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = write_file(
            State(state.clone()),
            default_resolved(&state),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = write_file(
            State(state.clone()),
            default_resolved(&state),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };

        let result = create_file(
            State(state.clone()),
            default_resolved(&state),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = create_file(
            State(state.clone()),
            default_resolved(&state),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };

        let result = create_folder(
            State(state.clone()),
            default_resolved(&state),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = create_folder(
            State(state.clone()),
            default_resolved(&state),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };

        let result = rename_file(
            State(state.clone()),
            default_resolved(&state),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = rename_file(
            State(state.clone()),
            default_resolved(&state),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };

        let result = delete_file(
            State(state.clone()),
            default_resolved(&state),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token"),
        );

        let result = delete_file(
            State(state.clone()),
            default_resolved(&state),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext {
                active_file: Some("before.rs".to_string()),
                open_files: Vec::new(),
                selection: None,
                diagnostics: Vec::new(),
            })),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        };

        let result = put_agent_context(
            State(state.clone()),
            default_resolved(&state),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
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
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(dir.path()),
            agent_context: Arc::new(RwLock::new(AgentContext {
                active_file: Some("src/main.rs".to_string()),
                open_files: vec!["src/main.rs".to_string()],
                selection: None,
                diagnostics: Vec::new(),
            })),
            lsp_manager: LspManager::new(),
            frontend_dist: dir.path().to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
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

    fn test_session(root: &Path) -> WorkspaceSessionState {
        WorkspaceSessionState {
            workspace_root: Arc::new(RwLock::new(root.to_path_buf())),
            initial_file: Arc::new(RwLock::new(None)),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
        }
    }

    #[test]
    fn split_workspace_prefix_peels_the_first_segment() {
        assert_eq!(
            split_workspace_prefix("/abc123/api/file"),
            ("abc123", "api/file")
        );
        assert_eq!(split_workspace_prefix("/abc123/"), ("abc123", ""));
        assert_eq!(split_workspace_prefix("/abc123"), ("abc123", ""));
        // A bare root has no candidate segment.
        assert_eq!(split_workspace_prefix("/"), ("", ""));
        // Plain API calls keep their path; "api" simply won't resolve to a workspace.
        assert_eq!(split_workspace_prefix("/api/files"), ("api", "files"));
    }

    #[test]
    fn looks_like_workspace_hash_matches_only_hex_tokens() {
        assert!(looks_like_workspace_hash("beb036bfb04ac22b"));
        assert!(looks_like_workspace_hash("0"));
        // Real top-level routes and static filenames must not be mistaken for hashes.
        assert!(!looks_like_workspace_hash("api"));
        assert!(!looks_like_workspace_hash("assets"));
        assert!(!looks_like_workspace_hash("mcp"));
        assert!(!looks_like_workspace_hash("index.html"));
        assert!(!looks_like_workspace_hash(""));
        // Hash tokens are u64 hex — never longer than 16 chars.
        assert!(!looks_like_workspace_hash("00000000000000000"));
    }

    #[test]
    fn rewrite_request_path_drops_prefix_and_keeps_query() {
        let mut request = Request::builder()
            .uri("/abc123/api/file?path=src/main.rs")
            .body(axum::body::Body::empty())
            .unwrap();

        rewrite_request_path(&mut request, "/api/file");

        assert_eq!(request.uri().path(), "/api/file");
        assert_eq!(request.uri().query(), Some("path=src/main.rs"));
    }

    #[tokio::test]
    async fn resolve_workspace_by_hash_matches_the_open_session() {
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let mut sessions = HashMap::new();
        sessions.insert("main".to_string(), test_session(first.path()));
        sessions.insert("workspace-1".to_string(), test_session(second.path()));
        let sessions = Arc::new(std::sync::RwLock::new(sessions));

        let hash = workspace_root_hash(second.path());
        let resolved = resolve_workspace_by_hash(&sessions, &hash)
            .await
            .expect("known hash resolves");
        assert!(resolved.scoped);
        assert_eq!(
            *resolved.workspace_root.read().await,
            second.path().to_path_buf()
        );

        assert!(resolve_workspace_by_hash(&sessions, "deadbeef")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn workspace_summaries_dedupe_by_hash() {
        let dir = tempdir().unwrap();
        let mut sessions = HashMap::new();
        // Two windows on the same folder collapse to one chooser entry.
        sessions.insert("main".to_string(), test_session(dir.path()));
        sessions.insert("workspace-1".to_string(), test_session(dir.path()));
        let sessions = Arc::new(std::sync::RwLock::new(sessions));

        let summaries = workspace_summaries(&sessions).await;

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].hash, workspace_root_hash(dir.path()));
    }

    #[test]
    fn render_workspace_chooser_redirects_for_a_single_workspace() {
        let summaries = vec![WorkspaceSummary {
            hash: "abc123".to_string(),
            path: "/tmp/project".to_string(),
            name: "project".to_string(),
        }];

        let Html(body) = render_workspace_chooser(&summaries);

        assert!(body.contains("http-equiv=\"refresh\""));
        assert!(body.contains("url=/abc123/"));
    }

    #[test]
    fn render_workspace_chooser_lists_every_workspace_when_many() {
        let summaries = vec![
            WorkspaceSummary {
                hash: "abc123".to_string(),
                path: "/tmp/alpha".to_string(),
                name: "alpha".to_string(),
            },
            WorkspaceSummary {
                hash: "def456".to_string(),
                path: "/tmp/beta".to_string(),
                name: "beta".to_string(),
            },
        ];

        let Html(body) = render_workspace_chooser(&summaries);

        assert!(!body.contains("http-equiv=\"refresh\""));
        assert!(body.contains("href=\"/abc123/\""));
        assert!(body.contains("href=\"/def456/\""));
    }

    fn routing_test_state(
        shared_root: &Path,
        frontend_dist: &Path,
        sessions: HashMap<String, WorkspaceSessionState>,
    ) -> HttpServerState {
        HttpServerState {
            workspace_root: Arc::new(RwLock::new(shared_root.to_path_buf())),
            tree_scan_limit: Arc::new(std::sync::RwLock::new(10_000)),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(5_120 * 1024)),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(200)),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(1_024 * 1_024)),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(12)),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(2_000)),
            workspace_index: test_workspace_index(shared_root),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: LspManager::new(),
            frontend_dist: frontend_dist.to_path_buf(),
            mcp_token: "token".to_string(),
            window_sessions: Arc::new(std::sync::RwLock::new(sessions)),
        }
    }

    async fn response_text(response: Response) -> (StatusCode, String) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    // Exercises the real layer → URI rewrite → route → handler chain that makes
    // `/{hash}/...` resolve to the right open workspace in a browser.
    #[tokio::test]
    async fn hash_prefixed_requests_route_to_their_workspace() {
        use tower::ServiceExt;

        let shared = tempdir().unwrap();
        let dir_a = tempdir().unwrap();
        let dir_b = tempdir().unwrap();
        let frontend = tempdir().unwrap();
        std::fs::write(frontend.path().join("index.html"), "SPA_MARKER").unwrap();

        let mut sessions = HashMap::new();
        sessions.insert("main".to_string(), test_session(dir_a.path()));
        sessions.insert("workspace-1".to_string(), test_session(dir_b.path()));
        let state = routing_test_state(shared.path(), frontend.path(), sessions);

        let inner = Router::new()
            .route("/api/workspace-root", get(workspace_root))
            .route("/api/workspaces", get(workspaces))
            .route("/", get(index))
            .route("/{*path}", get(static_file))
            .with_state(state.clone());
        // Wrap from the outside, exactly like start_http_server, so the resolver runs
        // before routing.
        let router = middleware::from_fn_with_state(state.clone(), resolve_workspace_middleware)
            .layer(inner);

        let hash_a = workspace_root_hash(dir_a.path());
        let hash_b = workspace_root_hash(dir_b.path());

        let request = |uri: &str| {
            Request::builder()
                .uri(uri)
                .body(axum::body::Body::empty())
                .unwrap()
        };

        // No prefix → the shared/default root.
        let (_, body) = response_text(
            router
                .clone()
                .oneshot(request("/api/workspace-root"))
                .await
                .unwrap(),
        )
        .await;
        assert!(body.contains(&shared.path().to_string_lossy().to_string()));

        // `/{hash}` prefix → that workspace's root, not the first/shared one.
        let (_, body) = response_text(
            router
                .clone()
                .oneshot(request(&format!("/{hash_b}/api/workspace-root")))
                .await
                .unwrap(),
        )
        .await;
        assert!(body.contains(&dir_b.path().to_string_lossy().to_string()));
        assert!(!body.contains(&shared.path().to_string_lossy().to_string()));

        // `/{hash}/` serves the SPA for that workspace (rewritten to `/`, scoped).
        let (status, body) = response_text(
            router
                .clone()
                .oneshot(request(&format!("/{hash_a}/")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "SPA_MARKER");

        // Bare `/` with two open workspaces lists them instead of redirecting.
        let (_, body) = response_text(router.clone().oneshot(request("/")).await.unwrap()).await;
        assert!(body.contains("Open workspaces"));
        assert!(body.contains(&format!("/{hash_a}/")));
        assert!(body.contains(&format!("/{hash_b}/")));

        // A stale/unknown but hash-shaped prefix is stripped and falls back to the
        // shared root — an API path returns JSON, never SPA HTML.
        let (status, body) = response_text(
            router
                .clone()
                .oneshot(request("/deadbeef/api/workspace-root"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains(&shared.path().to_string_lossy().to_string()));
        assert!(!body.contains("SPA_MARKER"));

        // And an unknown `/{hash}/` lands on the chooser, not a dead SPA shell.
        let (_, body) =
            response_text(router.clone().oneshot(request("/deadbeef/")).await.unwrap()).await;
        assert!(body.contains("Open workspaces"));
    }

    #[test]
    fn render_workspace_chooser_escapes_workspace_names() {
        let summaries = vec![
            WorkspaceSummary {
                hash: "a".to_string(),
                path: "/tmp/<one>".to_string(),
                name: "<script>".to_string(),
            },
            WorkspaceSummary {
                hash: "b".to_string(),
                path: "/tmp/two".to_string(),
                name: "two".to_string(),
            },
        ];

        let Html(body) = render_workspace_chooser(&summaries);

        assert!(!body.contains("<script>"));
        assert!(body.contains("&lt;script&gt;"));
    }
}
