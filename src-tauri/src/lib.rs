mod claude_bridge;
mod http_server;
mod lsp;
mod workspace;
mod workspace_index;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::RwLock;
use workspace::{
    create_workspace_file, create_workspace_folder, delete_workspace_file, read_workspace_file,
    rename_workspace_file, scan_workspace_with_metadata, search_workspace_with_metadata,
    workspace_directory_entries, workspace_entry, workspace_file_entry, write_workspace_file,
    WorkspaceError,
};

#[derive(Clone)]
struct AppState {
    workspace_root: Arc<RwLock<PathBuf>>,
    initial_file: Arc<RwLock<Option<String>>>,
    window_sessions: Arc<std::sync::RwLock<HashMap<String, WorkspaceSessionState>>>,
    pending_open_requests: Arc<std::sync::RwLock<Vec<OpenLaunchRequest>>>,
    recent_items: Arc<std::sync::RwLock<RecentItems>>,
    recent_store_path: Arc<std::sync::RwLock<Option<PathBuf>>>,
    ui_state: Arc<std::sync::RwLock<AppUiState>>,
    ui_state_store_path: Arc<std::sync::RwLock<Option<PathBuf>>>,
    tree_scan_limit: Arc<std::sync::RwLock<usize>>,
    max_open_file_bytes: Arc<std::sync::RwLock<u64>>,
    workspace_search_result_limit: Arc<std::sync::RwLock<usize>>,
    workspace_search_max_file_bytes: Arc<std::sync::RwLock<u64>>,
    quick_open_result_limit: Arc<std::sync::RwLock<usize>>,
    background_index_batch_entries: Arc<std::sync::RwLock<usize>>,
    workspace_index: workspace_index::WorkspaceIndex,
    agent_context: Arc<RwLock<AgentContext>>,
    lsp_manager: lsp::LspManager,
    http_endpoint: Arc<RwLock<Option<String>>>,
    http_error: Arc<RwLock<Option<String>>>,
    codex_mcp: Arc<RwLock<Option<CodexMcpInfo>>>,
    claude_bridge: Arc<RwLock<Option<claude_bridge::ClaudeBridgeInfo>>>,
    claude_bridge_error: Arc<RwLock<Option<String>>>,
}

#[derive(Clone)]
struct WorkspaceSessionState {
    workspace_root: Arc<RwLock<PathBuf>>,
    initial_file: Arc<RwLock<Option<String>>>,
    agent_context: Arc<RwLock<AgentContext>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AgentContext {
    active_file: Option<String>,
    open_files: Vec<String>,
    selection: Option<EditorSelection>,
    #[serde(default)]
    diagnostics: Vec<EditorDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorSelection {
    file_path: String,
    text: String,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorDiagnostic {
    file_path: String,
    message: String,
    severity: Option<u32>,
    source: Option<String>,
    code: Option<String>,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexMcpInfo {
    endpoint: String,
    bearer_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsLocations {
    settings_file: Option<String>,
    recents_file: Option<String>,
    workspace_index_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDisplayContext {
    app_title: String,
    workspace_label: String,
    full_label: String,
    git_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RecentItems {
    workspaces: Vec<RecentWorkspace>,
    files: Vec<RecentFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentWorkspace {
    path: String,
    name: String,
    last_opened: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentFile {
    workspace_root: String,
    path: String,
    name: String,
    #[serde(default)]
    single_file: bool,
    last_opened: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppUiState {
    view: PersistedViewSettings,
    workspaces: Vec<PersistedWorkspaceUiState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedViewSettings {
    show_dotfiles: bool,
    show_generated_internal: bool,
    #[serde(default = "default_tree_scan_limit")]
    tree_scan_limit: usize,
    #[serde(default = "default_max_open_file_kb")]
    max_open_file_kb: u64,
    #[serde(default = "default_workspace_search_result_limit")]
    workspace_search_result_limit: usize,
    #[serde(default = "default_workspace_search_max_file_kb")]
    workspace_search_max_file_kb: u64,
    #[serde(default = "default_current_file_search_result_limit")]
    current_file_search_result_limit: usize,
    #[serde(default = "default_current_file_result_preview_limit")]
    current_file_result_preview_limit: usize,
    #[serde(default = "default_quick_open_result_limit")]
    quick_open_result_limit: usize,
    #[serde(default = "default_background_index_batch_entries")]
    background_index_batch_entries: usize,
    #[serde(default = "default_workspace_title_max_chars")]
    workspace_title_max_chars: usize,
    #[serde(default = "default_command_palette_result_limit")]
    command_palette_result_limit: usize,
}

impl Default for PersistedViewSettings {
    fn default() -> Self {
        Self {
            show_dotfiles: false,
            show_generated_internal: false,
            tree_scan_limit: default_tree_scan_limit(),
            max_open_file_kb: default_max_open_file_kb(),
            workspace_search_result_limit: default_workspace_search_result_limit(),
            workspace_search_max_file_kb: default_workspace_search_max_file_kb(),
            current_file_search_result_limit: default_current_file_search_result_limit(),
            current_file_result_preview_limit: default_current_file_result_preview_limit(),
            quick_open_result_limit: default_quick_open_result_limit(),
            background_index_batch_entries: default_background_index_batch_entries(),
            workspace_title_max_chars: default_workspace_title_max_chars(),
            command_palette_result_limit: default_command_palette_result_limit(),
        }
    }
}

const MIN_TREE_SCAN_LIMIT: usize = 500;
const DEFAULT_TREE_SCAN_LIMIT: usize = 10_000;
const MAX_TREE_SCAN_LIMIT: usize = 100_000;
const MIN_MAX_OPEN_FILE_KB: u64 = 64;
const DEFAULT_MAX_OPEN_FILE_KB: u64 = 5_120;
const MAX_MAX_OPEN_FILE_KB: u64 = 65_536;
const MIN_WORKSPACE_SEARCH_RESULT_LIMIT: usize = 25;
const DEFAULT_WORKSPACE_SEARCH_RESULT_LIMIT: usize = 200;
const MAX_WORKSPACE_SEARCH_RESULT_LIMIT: usize = 5_000;
const MIN_WORKSPACE_SEARCH_MAX_FILE_KB: u64 = 64;
const DEFAULT_WORKSPACE_SEARCH_MAX_FILE_KB: u64 = 1_024;
const MAX_WORKSPACE_SEARCH_MAX_FILE_KB: u64 = 16_384;
const MIN_CURRENT_FILE_SEARCH_RESULT_LIMIT: usize = 25;
const DEFAULT_CURRENT_FILE_SEARCH_RESULT_LIMIT: usize = 200;
const MAX_CURRENT_FILE_SEARCH_RESULT_LIMIT: usize = 5_000;
const MIN_CURRENT_FILE_RESULT_PREVIEW_LIMIT: usize = 3;
const DEFAULT_CURRENT_FILE_RESULT_PREVIEW_LIMIT: usize = 12;
const MAX_CURRENT_FILE_RESULT_PREVIEW_LIMIT: usize = 100;
const MIN_QUICK_OPEN_RESULT_LIMIT: usize = 5;
const DEFAULT_QUICK_OPEN_RESULT_LIMIT: usize = 12;
const MAX_QUICK_OPEN_RESULT_LIMIT: usize = 100;
const MIN_BACKGROUND_INDEX_BATCH_ENTRIES: usize = 100;
const DEFAULT_BACKGROUND_INDEX_BATCH_ENTRIES: usize = 2_000;
const MAX_BACKGROUND_INDEX_BATCH_ENTRIES: usize = 20_000;
const MIN_WORKSPACE_TITLE_MAX_CHARS: usize = 20;
const DEFAULT_WORKSPACE_TITLE_MAX_CHARS: usize = 50;
const MAX_WORKSPACE_TITLE_MAX_CHARS: usize = 120;
const MIN_COMMAND_PALETTE_RESULT_LIMIT: usize = 5;
const DEFAULT_COMMAND_PALETTE_RESULT_LIMIT: usize = 18;
const MAX_COMMAND_PALETTE_RESULT_LIMIT: usize = 100;

fn default_tree_scan_limit() -> usize {
    DEFAULT_TREE_SCAN_LIMIT
}

fn default_max_open_file_kb() -> u64 {
    DEFAULT_MAX_OPEN_FILE_KB
}

fn default_workspace_search_result_limit() -> usize {
    DEFAULT_WORKSPACE_SEARCH_RESULT_LIMIT
}

fn default_workspace_search_max_file_kb() -> u64 {
    DEFAULT_WORKSPACE_SEARCH_MAX_FILE_KB
}

fn default_current_file_search_result_limit() -> usize {
    DEFAULT_CURRENT_FILE_SEARCH_RESULT_LIMIT
}

fn default_current_file_result_preview_limit() -> usize {
    DEFAULT_CURRENT_FILE_RESULT_PREVIEW_LIMIT
}

fn default_quick_open_result_limit() -> usize {
    DEFAULT_QUICK_OPEN_RESULT_LIMIT
}

fn default_background_index_batch_entries() -> usize {
    DEFAULT_BACKGROUND_INDEX_BATCH_ENTRIES
}

fn default_workspace_title_max_chars() -> usize {
    DEFAULT_WORKSPACE_TITLE_MAX_CHARS
}

fn default_command_palette_result_limit() -> usize {
    DEFAULT_COMMAND_PALETTE_RESULT_LIMIT
}

fn sanitize_view_settings(mut settings: PersistedViewSettings) -> PersistedViewSettings {
    settings.tree_scan_limit = settings
        .tree_scan_limit
        .clamp(MIN_TREE_SCAN_LIMIT, MAX_TREE_SCAN_LIMIT);
    settings.max_open_file_kb = settings
        .max_open_file_kb
        .clamp(MIN_MAX_OPEN_FILE_KB, MAX_MAX_OPEN_FILE_KB);
    settings.workspace_search_result_limit = settings.workspace_search_result_limit.clamp(
        MIN_WORKSPACE_SEARCH_RESULT_LIMIT,
        MAX_WORKSPACE_SEARCH_RESULT_LIMIT,
    );
    settings.workspace_search_max_file_kb = settings.workspace_search_max_file_kb.clamp(
        MIN_WORKSPACE_SEARCH_MAX_FILE_KB,
        MAX_WORKSPACE_SEARCH_MAX_FILE_KB,
    );
    settings.current_file_search_result_limit = settings.current_file_search_result_limit.clamp(
        MIN_CURRENT_FILE_SEARCH_RESULT_LIMIT,
        MAX_CURRENT_FILE_SEARCH_RESULT_LIMIT,
    );
    settings.current_file_result_preview_limit = settings.current_file_result_preview_limit.clamp(
        MIN_CURRENT_FILE_RESULT_PREVIEW_LIMIT,
        MAX_CURRENT_FILE_RESULT_PREVIEW_LIMIT,
    );
    settings.quick_open_result_limit = settings
        .quick_open_result_limit
        .clamp(MIN_QUICK_OPEN_RESULT_LIMIT, MAX_QUICK_OPEN_RESULT_LIMIT);
    settings.background_index_batch_entries = settings.background_index_batch_entries.clamp(
        MIN_BACKGROUND_INDEX_BATCH_ENTRIES,
        MAX_BACKGROUND_INDEX_BATCH_ENTRIES,
    );
    settings.workspace_title_max_chars = settings
        .workspace_title_max_chars
        .clamp(MIN_WORKSPACE_TITLE_MAX_CHARS, MAX_WORKSPACE_TITLE_MAX_CHARS);
    settings.command_palette_result_limit = settings.command_palette_result_limit.clamp(
        MIN_COMMAND_PALETTE_RESULT_LIMIT,
        MAX_COMMAND_PALETTE_RESULT_LIMIT,
    );
    settings
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedWorkspaceUiState {
    workspace_root: String,
    expanded_folders: Vec<String>,
    open_files: Vec<String>,
    active_file: Option<String>,
    selected_path: Option<String>,
    updated_at: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspaceUiStatePayload {
    expanded_folders: Vec<String>,
    open_files: Vec<String>,
    active_file: Option<String>,
    selected_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedUiSnapshot {
    view: PersistedViewSettings,
    workspace: WorkspaceUiStatePayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceRequest {
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenFileRequest {
    workspace_root: String,
    path: String,
    single_file: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum OpenLaunchRequest {
    Workspace {
        path: String,
    },
    File {
        workspace_root: String,
        path: String,
        single_file: bool,
    },
}

#[derive(Debug, thiserror::Error)]
enum CommandError {
    #[error("{0}")]
    Workspace(#[from] WorkspaceError),
    #[error("{0}")]
    Lsp(#[from] lsp::LspError),
    #[error("local HTTP server failed: {0}")]
    HttpServer(String),
    #[error("Claude IDE bridge failed: {0}")]
    ClaudeBridge(String),
    #[error("selected workspace path is not a directory")]
    WorkspaceNotDirectory,
    #[error("dialog error: {0}")]
    Dialog(String),
    #[error("recent item storage failed: {0}")]
    Recent(String),
    #[error("ui state storage failed: {0}")]
    UiState(String),
    #[error("workspace index failed: {0}")]
    WorkspaceIndex(#[from] workspace_index::WorkspaceIndexError),
    #[error("workspace index failed: {0}")]
    WorkspaceIndexAdvance(#[from] workspace_index::WorkspaceIndexAdvanceError),
}

impl serde::Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

fn default_workspace_session(state: &AppState) -> WorkspaceSessionState {
    WorkspaceSessionState {
        workspace_root: state.workspace_root.clone(),
        initial_file: state.initial_file.clone(),
        agent_context: state.agent_context.clone(),
    }
}

fn window_session_for_label(state: &AppState, label: &str) -> WorkspaceSessionState {
    state
        .window_sessions
        .read()
        .ok()
        .and_then(|sessions| sessions.get(label).cloned())
        .unwrap_or_else(|| default_workspace_session(state))
}

fn registered_window_session_for_label(
    state: &AppState,
    label: &str,
) -> Option<WorkspaceSessionState> {
    state
        .window_sessions
        .read()
        .ok()
        .and_then(|sessions| sessions.get(label).cloned())
}

fn register_window_session(state: &AppState, label: &str, target: LaunchTarget) {
    if let Ok(mut sessions) = state.window_sessions.write() {
        if label == "main" {
            sessions.insert(label.to_string(), default_workspace_session(state));
            return;
        }
        sessions.insert(
            label.to_string(),
            WorkspaceSessionState {
                workspace_root: Arc::new(RwLock::new(target.workspace_root)),
                initial_file: Arc::new(RwLock::new(target.initial_file)),
                agent_context: Arc::new(RwLock::new(AgentContext::default())),
            },
        );
    }
}

fn remove_window_session(state: &AppState, label: &str) {
    if label == "main" {
        return;
    }
    if let Ok(mut sessions) = state.window_sessions.write() {
        sessions.remove(label);
    }
}

async fn workspace_root_for_window(state: &AppState, window: &tauri::Window) -> PathBuf {
    window_session_for_label(state, window.label())
        .workspace_root
        .read()
        .await
        .clone()
}

async fn workspace_root_string_for_window(state: &AppState, window: &tauri::Window) -> String {
    workspace_root_for_window(state, window)
        .await
        .to_string_lossy()
        .to_string()
}

async fn workspace_root_is_used_by_any_session(state: &AppState, workspace_root: &Path) -> bool {
    let sessions = state
        .window_sessions
        .read()
        .ok()
        .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for session in sessions {
        if *session.workspace_root.read().await == workspace_root {
            return true;
        }
    }
    false
}

async fn agent_context_for_window(
    state: &AppState,
    window: &tauri::Window,
) -> Arc<RwLock<AgentContext>> {
    window_session_for_label(state, window.label()).agent_context
}

#[tauri::command]
async fn get_workspace_root(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    Ok(workspace_root_string_for_window(&state, &window).await)
}

#[tauri::command]
async fn get_initial_file(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    Ok(window_session_for_label(&state, window.label())
        .initial_file
        .read()
        .await
        .clone())
}

#[tauri::command]
async fn take_opened_launch_targets(
    state: State<'_, AppState>,
) -> Result<Vec<OpenLaunchRequest>, CommandError> {
    let mut pending = state
        .pending_open_requests
        .write()
        .map_err(|_| CommandError::Recent("open request lock poisoned".to_string()))?;
    Ok(std::mem::take(&mut *pending))
}

#[tauri::command]
async fn list_files(
    window: tauri::Window,
    state: State<'_, AppState>,
    show_dotfiles: bool,
    show_generated_internal: bool,
    tree_scan_limit: Option<usize>,
) -> Result<workspace::WorkspaceScan, CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    let tree_scan_limit = tree_scan_limit.unwrap_or_else(|| {
        state
            .tree_scan_limit
            .read()
            .map(|limit| *limit)
            .unwrap_or_else(|_| default_tree_scan_limit())
    });
    let tree_scan_limit = tree_scan_limit.clamp(MIN_TREE_SCAN_LIMIT, MAX_TREE_SCAN_LIMIT);
    let scan = scan_workspace_with_metadata(
        &workspace_root,
        tree_scan_limit,
        show_dotfiles,
        show_generated_internal,
    )
    .map_err(CommandError::from)?;
    state.workspace_index.reconcile_scanned_entries(
        &workspace_root,
        &scan.entries,
        !scan.truncated,
    )?;
    Ok(scan)
}

#[tauri::command]
async fn list_directory(
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
    show_dotfiles: bool,
    show_generated_internal: bool,
) -> Result<Vec<workspace::FileEntry>, CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    let entries = workspace_directory_entries(
        &workspace_root,
        &path,
        show_dotfiles,
        show_generated_internal,
    )
    .map_err(CommandError::from)?;
    state
        .workspace_index
        .replace_directory_entries(&workspace_root, &path, &entries)?;
    Ok(entries)
}

#[tauri::command]
async fn search_indexed_files(
    window: tauri::Window,
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    show_dotfiles: bool,
    show_generated_internal: bool,
) -> Result<Vec<workspace::FileEntry>, CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    let limit = limit
        .unwrap_or_else(default_quick_open_result_limit)
        .clamp(MIN_QUICK_OPEN_RESULT_LIMIT, MAX_QUICK_OPEN_RESULT_LIMIT);
    let expansion_limit = state
        .tree_scan_limit
        .read()
        .map(|limit| *limit)
        .unwrap_or_else(|_| default_tree_scan_limit())
        .clamp(MIN_TREE_SCAN_LIMIT, MAX_TREE_SCAN_LIMIT);
    search_indexed_files_with_expansion(
        &state.workspace_index,
        &workspace_root,
        &query,
        limit,
        expansion_limit,
        show_dotfiles,
        show_generated_internal,
    )
}

fn search_indexed_files_with_expansion(
    index: &workspace_index::WorkspaceIndex,
    root: &Path,
    query: &str,
    limit: usize,
    expansion_limit: usize,
    show_dotfiles: bool,
    show_generated_internal: bool,
) -> Result<Vec<workspace::FileEntry>, CommandError> {
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
            Err(error) => return Err(CommandError::from(error)),
        };
        remaining_entries = remaining_entries.saturating_sub(entries.len().max(1));
        index.replace_directory_entries(root, &directory, &entries)?;
        results = index.search_files(root, query, limit)?;
    }

    Ok(results)
}

fn stale_indexed_directory_error(error: &WorkspaceError) -> bool {
    matches!(error, WorkspaceError::NotADirectory)
        || matches!(error, WorkspaceError::Io(io_error) if io_error.kind() == std::io::ErrorKind::NotFound)
}

fn refresh_indexed_entry(
    index: &workspace_index::WorkspaceIndex,
    root: &Path,
    relative: &str,
) -> Result<(), CommandError> {
    let entry = workspace_entry(root, relative)?;
    index.upsert_entries(root, &[entry])?;
    Ok(())
}

#[tauri::command]
async fn read_file(
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
    max_open_bytes: Option<u64>,
) -> Result<String, CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    let max_open_bytes = max_open_bytes
        .unwrap_or_else(|| {
            state
                .max_open_file_bytes
                .read()
                .map(|limit| *limit)
                .unwrap_or_else(|_| default_max_open_file_kb().saturating_mul(1024))
        })
        .clamp(
            MIN_MAX_OPEN_FILE_KB.saturating_mul(1024),
            MAX_MAX_OPEN_FILE_KB.saturating_mul(1024),
        );
    read_workspace_file(&workspace_root, &path, max_open_bytes).map_err(CommandError::from)
}

#[tauri::command]
async fn stat_file(
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<workspace::FileEntry, CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    workspace_file_entry(&workspace_root, &path).map_err(CommandError::from)
}

#[tauri::command]
async fn write_file(
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
    contents: String,
    expected_modified_ms: Option<u128>,
) -> Result<(), CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    write_workspace_file(&workspace_root, &path, &contents, expected_modified_ms)
        .map_err(CommandError::from)?;
    refresh_indexed_entry(&state.workspace_index, &workspace_root, &path)?;
    Ok(())
}

#[tauri::command]
async fn create_file(
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    create_workspace_file(&workspace_root, &path).map_err(CommandError::from)?;
    refresh_indexed_entry(&state.workspace_index, &workspace_root, &path)?;
    Ok(())
}

#[tauri::command]
async fn create_folder(
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    create_workspace_folder(&workspace_root, &path).map_err(CommandError::from)?;
    refresh_indexed_entry(&state.workspace_index, &workspace_root, &path)?;
    Ok(())
}

#[tauri::command]
async fn rename_file(
    window: tauri::Window,
    state: State<'_, AppState>,
    from_path: String,
    to_path: String,
) -> Result<(), CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    rename_workspace_file(&workspace_root, &from_path, &to_path).map_err(CommandError::from)?;
    state
        .workspace_index
        .remove_path(&workspace_root, &from_path)?;
    refresh_indexed_entry(&state.workspace_index, &workspace_root, &to_path)?;
    Ok(())
}

#[tauri::command]
async fn delete_file(
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    delete_workspace_file(&workspace_root, &path).map_err(CommandError::from)?;
    state.workspace_index.remove_path(&workspace_root, &path)?;
    Ok(())
}

#[tauri::command]
async fn search_files(
    window: tauri::Window,
    state: State<'_, AppState>,
    query: String,
    max_results: Option<usize>,
    max_file_bytes: Option<u64>,
    show_dotfiles: Option<bool>,
) -> Result<workspace::WorkspaceSearch, CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    let max_results = max_results
        .unwrap_or_else(|| {
            state
                .workspace_search_result_limit
                .read()
                .map(|limit| *limit)
                .unwrap_or_else(|_| default_workspace_search_result_limit())
        })
        .clamp(
            MIN_WORKSPACE_SEARCH_RESULT_LIMIT,
            MAX_WORKSPACE_SEARCH_RESULT_LIMIT,
        );
    let max_file_bytes = max_file_bytes
        .unwrap_or_else(|| {
            state
                .workspace_search_max_file_bytes
                .read()
                .map(|limit| *limit)
                .unwrap_or_else(|_| default_workspace_search_max_file_kb().saturating_mul(1024))
        })
        .clamp(
            MIN_WORKSPACE_SEARCH_MAX_FILE_KB.saturating_mul(1024),
            MAX_WORKSPACE_SEARCH_MAX_FILE_KB.saturating_mul(1024),
        );
    search_workspace_with_metadata(
        &workspace_root,
        &query,
        max_results,
        max_file_bytes,
        show_dotfiles.unwrap_or(false),
    )
    .map_err(CommandError::from)
}

#[tauri::command]
async fn pick_workspace_folder(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Open Folder")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };

    let path = path
        .into_path()
        .map_err(|error| CommandError::Dialog(error.to_string()))?;
    let root = set_workspace_root_path(&state, Some(window.label()), path).await?;
    persist_recent_items(&state)?;
    rebuild_app_menu(&app, &state)?;
    Ok(Some(root))
}

#[tauri::command]
async fn pick_open_file(app: tauri::AppHandle) -> Result<Option<OpenFileRequest>, CommandError> {
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Open File")
        .blocking_pick_file()
    else {
        return Ok(None);
    };

    let path = path
        .into_path()
        .map_err(|error| CommandError::Dialog(error.to_string()))?;
    let target =
        launch_target_for_path(path).map_err(|error| CommandError::Dialog(error.to_string()))?;
    open_file_request_for_launch_target(target)
        .ok_or_else(|| CommandError::Dialog("selected path is not a file".to_string()))
        .map(Some)
}

#[tauri::command]
async fn set_workspace_root(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, CommandError> {
    let root = set_workspace_root_path(&state, Some(window.label()), PathBuf::from(path)).await?;
    persist_recent_items(&state)?;
    rebuild_app_menu(&app, &state)?;
    Ok(root)
}

#[tauri::command]
async fn record_recent_file(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    single_file: bool,
) -> Result<(), CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    record_recent_file_item(&state, &workspace_root, &path, single_file)?;
    persist_recent_items(&state)?;
    rebuild_app_menu(&app, &state)
}

#[tauri::command]
async fn get_ui_state(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<PersistedUiSnapshot, CommandError> {
    let workspace_root = workspace_root_string_for_window(&state, &window).await;
    workspace_ui_snapshot_for_root(&state, &workspace_root)
}

#[tauri::command]
fn get_settings_locations(state: State<'_, AppState>) -> Result<SettingsLocations, CommandError> {
    settings_locations_for_state(&state)
}

#[tauri::command]
async fn get_workspace_display_context(
    window: tauri::Window,
    state: State<'_, AppState>,
    title_max_chars: Option<usize>,
) -> Result<WorkspaceDisplayContext, CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    Ok(workspace_display_context(
        &workspace_root,
        title_max_chars.unwrap_or_else(default_workspace_title_max_chars),
    ))
}

#[tauri::command]
async fn get_workspace_index_stats(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<workspace_index::WorkspaceIndexStats, CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    workspace_index_stats_for_root(&state.workspace_index, &workspace_root)
}

fn workspace_index_stats_for_root(
    index: &workspace_index::WorkspaceIndex,
    workspace_root: &Path,
) -> Result<workspace_index::WorkspaceIndexStats, CommandError> {
    index
        .stats_for_root(workspace_root)
        .map_err(CommandError::WorkspaceIndex)
}

fn settings_locations_for_state(state: &AppState) -> Result<SettingsLocations, CommandError> {
    let settings_file = state
        .ui_state_store_path
        .read()
        .map_err(|_| CommandError::UiState("ui state store lock poisoned".to_string()))?
        .as_ref()
        .map(|path| path_to_string(path));
    let recents_file = state
        .recent_store_path
        .read()
        .map_err(|_| CommandError::Recent("recent store lock poisoned".to_string()))?
        .as_ref()
        .map(|path| path_to_string(path));
    let workspace_index_file = state
        .workspace_index
        .database_path()
        .map_err(CommandError::WorkspaceIndex)?
        .as_ref()
        .map(|path| path_to_string(path));

    Ok(SettingsLocations {
        settings_file,
        recents_file,
        workspace_index_file,
    })
}

#[tauri::command]
async fn update_ui_state(
    window: tauri::Window,
    state: State<'_, AppState>,
    view: PersistedViewSettings,
    workspace: WorkspaceUiStatePayload,
) -> Result<(), CommandError> {
    let workspace_root = workspace_root_string_for_window(&state, &window).await;
    let mut workspace = sanitize_workspace_ui_state(workspace);
    let mut ui_state = state
        .ui_state
        .write()
        .map_err(|_| CommandError::UiState("ui state lock poisoned".to_string()))?;
    let view = sanitize_view_settings(view);
    *state
        .tree_scan_limit
        .write()
        .map_err(|_| CommandError::UiState("tree scan limit lock poisoned".to_string()))? =
        view.tree_scan_limit;
    *state
        .max_open_file_bytes
        .write()
        .map_err(|_| CommandError::UiState("open file limit lock poisoned".to_string()))? =
        view.max_open_file_kb.saturating_mul(1024);
    *state.workspace_search_result_limit.write().map_err(|_| {
        CommandError::UiState("workspace search result limit lock poisoned".to_string())
    })? = view.workspace_search_result_limit;
    *state.workspace_search_max_file_bytes.write().map_err(|_| {
        CommandError::UiState("workspace search file limit lock poisoned".to_string())
    })? = view.workspace_search_max_file_kb.saturating_mul(1024);
    *state.quick_open_result_limit.write().map_err(|_| {
        CommandError::UiState("quick-open result limit lock poisoned".to_string())
    })? = view.quick_open_result_limit;
    *state
        .background_index_batch_entries
        .write()
        .map_err(|_| CommandError::UiState("background index batch lock poisoned".to_string()))? =
        view.background_index_batch_entries;
    ui_state.view = view;
    let persisted = PersistedWorkspaceUiState {
        workspace_root: workspace_root.clone(),
        expanded_folders: std::mem::take(&mut workspace.expanded_folders),
        open_files: std::mem::take(&mut workspace.open_files),
        active_file: workspace.active_file.take(),
        selected_path: workspace.selected_path.take(),
        updated_at: now_ms(),
    };
    ui_state
        .workspaces
        .retain(|workspace| workspace.workspace_root != workspace_root);
    ui_state.workspaces.insert(0, persisted);
    ui_state.workspaces.truncate(24);
    drop(ui_state);
    persist_ui_state(&state)
}

#[tauri::command]
async fn advance_workspace_index(
    window: tauri::Window,
    state: State<'_, AppState>,
    entry_limit: Option<usize>,
    show_dotfiles: bool,
    show_generated_internal: bool,
) -> Result<workspace_index::WorkspaceIndexStats, CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    let entry_limit = entry_limit
        .unwrap_or_else(|| {
            state
                .background_index_batch_entries
                .read()
                .map(|limit| *limit)
                .unwrap_or_else(|_| default_background_index_batch_entries())
        })
        .clamp(
            MIN_BACKGROUND_INDEX_BATCH_ENTRIES,
            MAX_BACKGROUND_INDEX_BATCH_ENTRIES,
        );

    workspace_index::advance_workspace_index(
        &state.workspace_index,
        &workspace_root,
        entry_limit,
        show_dotfiles,
        show_generated_internal,
    )
    .map_err(CommandError::from)
}

#[tauri::command]
async fn update_agent_context(
    window: tauri::Window,
    state: State<'_, AppState>,
    context: AgentContext,
) -> Result<(), CommandError> {
    let agent_context = agent_context_for_window(&state, &window).await;
    *agent_context.write().await = context;
    Ok(())
}

#[tauri::command]
async fn get_agent_context(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<AgentContext, CommandError> {
    let agent_context = agent_context_for_window(&state, &window).await;
    let context = agent_context.read().await.clone();
    Ok(context)
}

#[tauri::command]
async fn get_lsp_servers(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<lsp::LspServerStatus>, CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    Ok(state.lsp_manager.statuses(&workspace_root).await)
}

#[tauri::command]
async fn get_http_endpoint(state: State<'_, AppState>) -> Result<Option<String>, CommandError> {
    if let Some(error) = state.http_error.read().await.clone() {
        return Err(CommandError::HttpServer(error));
    }
    Ok(state.http_endpoint.read().await.clone())
}

#[tauri::command]
async fn get_codex_mcp_status(
    state: State<'_, AppState>,
) -> Result<Option<CodexMcpInfo>, CommandError> {
    if let Some(error) = state.http_error.read().await.clone() {
        return Err(CommandError::HttpServer(error));
    }
    Ok(state.codex_mcp.read().await.clone())
}

#[tauri::command]
async fn get_claude_bridge_status(
    state: State<'_, AppState>,
) -> Result<Option<claude_bridge::ClaudeBridgeInfo>, CommandError> {
    if let Some(error) = state.claude_bridge_error.read().await.clone() {
        return Err(CommandError::ClaudeBridge(error));
    }
    Ok(state.claude_bridge.read().await.clone())
}

#[tauri::command]
async fn start_lsp(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    language: String,
) -> Result<lsp::LspStartResult, CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    state
        .lsp_manager
        .start(app, &language, &workspace_root)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn send_lsp_message(
    window: tauri::Window,
    state: State<'_, AppState>,
    language: String,
    message: String,
) -> Result<(), CommandError> {
    let workspace_root = workspace_root_for_window(&state, &window).await;
    state
        .lsp_manager
        .send(&language, &workspace_root, &message)
        .await
        .map_err(CommandError::from)
}

pub fn run() {
    let explicit_launch_target =
        resolve_explicit_launch_target().expect("failed to determine requested launch target");
    let initial_launch_target = explicit_launch_target.clone().unwrap_or_else(|| {
        fallback_launch_target_from_process_dir()
            .expect("failed to determine current workspace directory")
    });
    let agent_context = Arc::new(RwLock::new(AgentContext::default()));
    let lsp_manager = lsp::LspManager::new();
    let http_endpoint = Arc::new(RwLock::new(None));
    let http_error = Arc::new(RwLock::new(None));
    let codex_mcp = Arc::new(RwLock::new(None));
    let claude_bridge = Arc::new(RwLock::new(None));
    let claude_bridge_error = Arc::new(RwLock::new(None));
    let app_state = AppState {
        workspace_root: Arc::new(RwLock::new(initial_launch_target.workspace_root)),
        initial_file: Arc::new(RwLock::new(initial_launch_target.initial_file)),
        window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
        pending_open_requests: Arc::new(std::sync::RwLock::new(Vec::new())),
        recent_items: Arc::new(std::sync::RwLock::new(RecentItems::default())),
        recent_store_path: Arc::new(std::sync::RwLock::new(None)),
        ui_state: Arc::new(std::sync::RwLock::new(AppUiState::default())),
        ui_state_store_path: Arc::new(std::sync::RwLock::new(None)),
        tree_scan_limit: Arc::new(std::sync::RwLock::new(default_tree_scan_limit())),
        max_open_file_bytes: Arc::new(std::sync::RwLock::new(
            default_max_open_file_kb().saturating_mul(1024),
        )),
        workspace_search_result_limit: Arc::new(std::sync::RwLock::new(
            default_workspace_search_result_limit(),
        )),
        workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(
            default_workspace_search_max_file_kb().saturating_mul(1024),
        )),
        quick_open_result_limit: Arc::new(
            std::sync::RwLock::new(default_quick_open_result_limit()),
        ),
        background_index_batch_entries: Arc::new(std::sync::RwLock::new(
            default_background_index_batch_entries(),
        )),
        workspace_index: workspace_index::WorkspaceIndex::new(),
        agent_context,
        lsp_manager,
        http_endpoint,
        http_error,
        codex_mcp,
        claude_bridge,
        claude_bridge_error,
    };
    let http_state = app_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            match explicit_launch_target_from_args(&args) {
                Ok(Some(target)) => {
                    if let Err(error) = open_launch_target_window(app, target) {
                        let _ = app.emit("app://error", error.to_string());
                    }
                }
                Ok(None) => focus_first_window(app),
                Err(error) => {
                    let _ = app.emit("app://error", error.to_string());
                    focus_first_window(app);
                }
            }
        }))
        .manage(app_state)
        .setup(move |app| {
            let recent_store_path = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?
                .join("recents.json");
            if let Some(parent) = recent_store_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            *http_state
                .recent_store_path
                .write()
                .map_err(|_| std::io::Error::other("recent store lock poisoned"))? =
                Some(recent_store_path.clone());
            let loaded_recent_items = load_recent_items(&recent_store_path)?;
            *http_state
                .recent_items
                .write()
                .map_err(|_| std::io::Error::other("recent items lock poisoned"))? =
                loaded_recent_items.clone();
            let ui_state_store_path = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?
                .join("ui-state.json");
            *http_state
                .ui_state_store_path
                .write()
                .map_err(|_| std::io::Error::other("ui state store lock poisoned"))? =
                Some(ui_state_store_path.clone());
            let loaded_ui_state = load_ui_state(&ui_state_store_path)?;
            let launch_target = explicit_launch_target
                .clone()
                .or_else(|| {
                    launch_target_from_saved_context(&loaded_recent_items, &loaded_ui_state)
                })
                .or_else(|| fallback_launch_target_from_process_dir().ok())
                .ok_or_else(|| {
                    std::io::Error::other("failed to determine current workspace directory")
                })?;
            *http_state.workspace_root.blocking_write() = launch_target.workspace_root;
            *http_state.initial_file.blocking_write() = launch_target.initial_file;
            register_window_session(
                &http_state,
                "main",
                LaunchTarget {
                    workspace_root: http_state.workspace_root.blocking_read().clone(),
                    initial_file: http_state.initial_file.blocking_read().clone(),
                },
            );
            *http_state
                .tree_scan_limit
                .write()
                .map_err(|_| std::io::Error::other("tree scan limit lock poisoned"))? =
                loaded_ui_state.view.tree_scan_limit;
            *http_state
                .max_open_file_bytes
                .write()
                .map_err(|_| std::io::Error::other("open file limit lock poisoned"))? =
                loaded_ui_state.view.max_open_file_kb.saturating_mul(1024);
            *http_state
                .workspace_search_result_limit
                .write()
                .map_err(|_| {
                    std::io::Error::other("workspace search result limit lock poisoned")
                })? = loaded_ui_state.view.workspace_search_result_limit;
            *http_state
                .workspace_search_max_file_bytes
                .write()
                .map_err(|_| {
                    std::io::Error::other("workspace search file limit lock poisoned")
                })? = loaded_ui_state
                .view
                .workspace_search_max_file_kb
                .saturating_mul(1024);
            *http_state
                .quick_open_result_limit
                .write()
                .map_err(|_| std::io::Error::other("quick-open limit lock poisoned"))? =
                loaded_ui_state.view.quick_open_result_limit;
            *http_state
                .background_index_batch_entries
                .write()
                .map_err(|_| std::io::Error::other("background index batch lock poisoned"))? =
                loaded_ui_state.view.background_index_batch_entries;
            *http_state
                .ui_state
                .write()
                .map_err(|_| std::io::Error::other("ui state lock poisoned"))? = loaded_ui_state;
            let workspace_index_path = app
                .path()
                .app_local_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?
                .join("workspace-index.sqlite");
            http_state
                .workspace_index
                .set_database_path(workspace_index_path)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let initial_root = http_state.workspace_root.blocking_read().clone();
            record_recent_workspace_item(&http_state, &initial_root)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            persist_recent_items(&http_state)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            rebuild_app_menu(app.handle(), &http_state)
                .map_err(|error| std::io::Error::other(error.to_string()))?;

            let workspace_root = http_state.workspace_root.clone();
            let tree_scan_limit = http_state.tree_scan_limit.clone();
            let max_open_file_bytes = http_state.max_open_file_bytes.clone();
            let workspace_search_result_limit = http_state.workspace_search_result_limit.clone();
            let workspace_search_max_file_bytes =
                http_state.workspace_search_max_file_bytes.clone();
            let quick_open_result_limit = http_state.quick_open_result_limit.clone();
            let background_index_batch_entries = http_state.background_index_batch_entries.clone();
            let workspace_index = http_state.workspace_index.clone();
            let agent_context = http_state.agent_context.clone();
            let lsp_manager = http_state.lsp_manager.clone();
            let http_endpoint = http_state.http_endpoint.clone();
            let http_error = http_state.http_error.clone();
            let codex_mcp = http_state.codex_mcp.clone();
            let claude_bridge = http_state.claude_bridge.clone();
            let claude_bridge_error = http_state.claude_bridge_error.clone();
            let frontend_dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
            let mcp_token = uuid::Uuid::new_v4().to_string();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match http_server::start_http_server(http_server::HttpServerConfig {
                    root_path: workspace_root,
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
                    server_error: http_error.clone(),
                })
                .await
                {
                    Ok(info) => {
                        *codex_mcp.write().await = Some(CodexMcpInfo {
                            endpoint: info.codex_mcp_endpoint,
                            bearer_token: info.codex_mcp_token,
                        });
                        *http_endpoint.write().await = Some(info.endpoint);
                    }
                    Err(error) => {
                        *http_error.write().await = Some(error.to_string());
                    }
                }
            });
            let workspace_root = http_state.workspace_root.clone();
            let agent_context = http_state.agent_context.clone();
            tauri::async_runtime::spawn(async move {
                match claude_bridge::start_claude_bridge(
                    workspace_root,
                    agent_context,
                    claude_bridge_error.clone(),
                )
                .await
                {
                    Ok(info) => {
                        *claude_bridge.write().await = Some(info);
                    }
                    Err(error) => {
                        *claude_bridge_error.write().await = Some(error.to_string());
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<AppState>();
                remove_window_session(&state, window.label());
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            if id == "open_folder" {
                if let Some(path) = app
                    .dialog()
                    .file()
                    .set_title("Open Folder")
                    .blocking_pick_folder()
                {
                    match path.into_path() {
                        Ok(path) => {
                            emit_to_active_window(
                                app,
                                "menu://open-workspace",
                                OpenWorkspaceRequest {
                                    path: path.to_string_lossy().to_string(),
                                },
                            );
                        }
                        Err(error) => {
                            let _ = app.emit("app://error", error.to_string());
                        }
                    }
                }
                return;
            }

            if id == "open_file" {
                if let Some(path) = app
                    .dialog()
                    .file()
                    .set_title("Open File")
                    .blocking_pick_file()
                {
                    match path
                        .into_path()
                        .map_err(|error| error.to_string())
                        .and_then(|path| {
                            launch_target_for_path(path).map_err(|error| error.to_string())
                        }) {
                        Ok(target) => {
                            if let Some(request) =
                                open_file_request_for_launch_target(target.clone())
                            {
                                emit_to_active_window(app, "menu://open-file", request);
                            } else {
                                emit_to_active_window(
                                    app,
                                    "menu://open-workspace",
                                    OpenWorkspaceRequest {
                                        path: target.workspace_root.to_string_lossy().to_string(),
                                    },
                                );
                            }
                        }
                        Err(error) => {
                            let _ = app.emit("app://error", error);
                        }
                    }
                }
                return;
            }

            if id == "new_file" {
                emit_to_active_window(app, "menu://new-file", ());
                return;
            }

            if id == "new_folder" {
                emit_to_active_window(app, "menu://new-folder", ());
                return;
            }

            if id == "save_file" {
                emit_to_active_window(app, "menu://save-file", ());
                return;
            }

            if id == "save_all" {
                emit_to_active_window(app, "menu://save-all", ());
                return;
            }

            if id == "reload_file" {
                emit_to_active_window(app, "menu://reload-file", ());
                return;
            }

            if id == "rename_selected" {
                emit_to_active_window(app, "menu://rename-selected", ());
                return;
            }

            if id == "delete_selected" {
                emit_to_active_window(app, "menu://delete-selected", ());
                return;
            }

            if id == "close_tab" {
                emit_to_active_window(app, "menu://close-tab", ());
                return;
            }

            if id == "close_all" {
                emit_to_active_window(app, "menu://close-all", ());
                return;
            }

            if id == "go_to_definition" {
                emit_to_active_window(app, "menu://go-to-definition", ());
                return;
            }

            if id == "find_references" {
                emit_to_active_window(app, "menu://find-references", ());
                return;
            }

            if id == "command_palette" {
                emit_to_active_window(app, "menu://command-palette", ());
                return;
            }

            if id == "quick_open" {
                emit_to_active_window(app, "menu://quick-open", ());
                return;
            }

            if id == "go_to_line" {
                emit_to_active_window(app, "menu://go-to-line", ());
                return;
            }

            if id == "find_in_file" {
                emit_to_active_window(app, "menu://find-in-file", ());
                return;
            }

            if id == "find_in_files" {
                emit_to_active_window(app, "menu://find-in-files", ());
                return;
            }

            if let Some(index) = id.strip_prefix("recent_workspace:") {
                let Ok(index) = index.parse::<usize>() else {
                    return;
                };
                let state = app.state::<AppState>();
                let item = state
                    .recent_items
                    .read()
                    .ok()
                    .and_then(|items| items.workspaces.get(index).cloned());
                if let Some(item) = item {
                    emit_to_active_window(
                        app,
                        "menu://open-workspace",
                        OpenWorkspaceRequest { path: item.path },
                    );
                }
                return;
            }

            if let Some(index) = id.strip_prefix("recent_file:") {
                let Ok(index) = index.parse::<usize>() else {
                    return;
                };
                let state = app.state::<AppState>();
                let item = state
                    .recent_items
                    .read()
                    .ok()
                    .and_then(|items| items.files.get(index).cloned());
                if let Some(item) = item {
                    emit_to_active_window(
                        app,
                        "menu://open-file",
                        OpenFileRequest {
                            workspace_root: item.workspace_root,
                            path: item.path,
                            single_file: item.single_file,
                        },
                    );
                }
                return;
            }

            if id == "show_integrations" {
                emit_to_active_window(app, "menu://show-integrations", ());
                return;
            }

            if id == "show_settings" {
                emit_to_active_window(app, "menu://show-settings", ());
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_workspace_root,
            get_initial_file,
            take_opened_launch_targets,
            list_files,
            list_directory,
            search_indexed_files,
            read_file,
            stat_file,
            write_file,
            create_file,
            create_folder,
            rename_file,
            delete_file,
            search_files,
            pick_workspace_folder,
            pick_open_file,
            set_workspace_root,
            record_recent_file,
            get_ui_state,
            get_settings_locations,
            get_workspace_display_context,
            get_workspace_index_stats,
            advance_workspace_index,
            update_ui_state,
            update_agent_context,
            get_agent_context,
            get_lsp_servers,
            get_http_endpoint,
            get_codex_mcp_status,
            get_claude_bridge_status,
            start_lsp,
            send_lsp_message
        ])
        .build(tauri::generate_context!())
        .expect("error while building application")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = event {
                let requests = open_launch_requests_for_urls(urls);
                if requests.is_empty() {
                    return;
                }

                let state = app.state::<AppState>();
                if let Ok(mut pending) = state.pending_open_requests.write() {
                    pending.extend(requests.clone());
                } else {
                    let _ = app.emit("app://error", "Unable to store opened file request");
                }

                for request in requests {
                    open_launch_request_window(app, request);
                }
            }
        });
}

async fn set_workspace_root_path(
    state: &State<'_, AppState>,
    window_label: Option<&str>,
    path: PathBuf,
) -> Result<String, CommandError> {
    let canonical = path.canonicalize().map_err(WorkspaceError::from)?;
    if !canonical.is_dir() {
        return Err(CommandError::WorkspaceNotDirectory);
    }

    let updates_shared_workspace = window_label.is_none() || window_label == Some("main");
    let registered_session =
        window_label.and_then(|label| registered_window_session_for_label(state, label));
    let previous_workspace_root = if let Some(session) = registered_session.as_ref() {
        Some(session.workspace_root.read().await.clone())
    } else if updates_shared_workspace {
        Some(state.workspace_root.read().await.clone())
    } else {
        None
    };
    if !updates_shared_workspace {
        if let Some(session) = registered_session.as_ref() {
            *session.workspace_root.write().await = canonical.clone();
            *session.initial_file.write().await = None;
            *session.agent_context.write().await = AgentContext::default();
        };
    }
    if updates_shared_workspace {
        *state.workspace_root.write().await = canonical.clone();
        *state.initial_file.write().await = None;
        *state.agent_context.write().await = AgentContext::default();
    }
    if let Some(previous_workspace_root) = previous_workspace_root {
        if previous_workspace_root != canonical
            && !workspace_root_is_used_by_any_session(state, &previous_workspace_root).await
        {
            state
                .lsp_manager
                .stop_for_root(&previous_workspace_root)
                .await;
        }
    }
    record_recent_workspace_item(state, &canonical)?;
    if updates_shared_workspace {
        if let Some(bridge) = state.claude_bridge.read().await.clone() {
            claude_bridge::update_lock_workspace(&bridge.lock_file, &canonical)
                .map_err(|error| CommandError::ClaudeBridge(error.to_string()))?;
        }
    }

    Ok(canonical.to_string_lossy().to_string())
}

fn rebuild_app_menu(app: &tauri::AppHandle, state: &AppState) -> Result<(), CommandError> {
    let recent_items = state
        .recent_items
        .read()
        .map_err(|_| CommandError::Recent("recent items lock poisoned".to_string()))?
        .clone();
    let open_file = MenuItemBuilder::with_id("open_file", "Open File...")
        .accelerator("CmdOrCtrl+O")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let open_folder = MenuItemBuilder::with_id("open_folder", "Open Folder...")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let new_file = MenuItemBuilder::with_id("new_file", "New File")
        .accelerator("CmdOrCtrl+N")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let new_folder = MenuItemBuilder::with_id("new_folder", "New Folder")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let save_file = MenuItemBuilder::with_id("save_file", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let save_all = MenuItemBuilder::with_id("save_all", "Save All")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let reload_file = MenuItemBuilder::with_id("reload_file", "Reload from Disk")
        .accelerator("CmdOrCtrl+R")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let rename_selected = MenuItemBuilder::with_id("rename_selected", "Rename Selected")
        .accelerator("F2")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let delete_selected = MenuItemBuilder::with_id("delete_selected", "Delete Selected")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let close_tab = MenuItemBuilder::with_id("close_tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let close_all = MenuItemBuilder::with_id("close_all", "Close All")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;

    let mut recent_workspace_menu = SubmenuBuilder::new(app, "Recent Folders");
    if recent_items.workspaces.is_empty() {
        let empty = MenuItemBuilder::with_id("recent_workspace_empty", "No Recent Folders")
            .enabled(false)
            .build(app)
            .map_err(|error| CommandError::Recent(error.to_string()))?;
        recent_workspace_menu = recent_workspace_menu.item(&empty);
    } else {
        for (index, workspace) in recent_items.workspaces.iter().enumerate() {
            let item = MenuItemBuilder::with_id(
                format!("recent_workspace:{index}"),
                format!("{} ({})", workspace.name, workspace.path),
            )
            .build(app)
            .map_err(|error| CommandError::Recent(error.to_string()))?;
            recent_workspace_menu = recent_workspace_menu.item(&item);
        }
    }
    let recent_workspace_menu = recent_workspace_menu
        .build()
        .map_err(|error| CommandError::Recent(error.to_string()))?;

    let mut recent_file_menu = SubmenuBuilder::new(app, "Recent Files");
    if recent_items.files.is_empty() {
        let empty = MenuItemBuilder::with_id("recent_file_empty", "No Recent Files")
            .enabled(false)
            .build(app)
            .map_err(|error| CommandError::Recent(error.to_string()))?;
        recent_file_menu = recent_file_menu.item(&empty);
    } else {
        for (index, file) in recent_items.files.iter().enumerate() {
            let item = MenuItemBuilder::with_id(
                format!("recent_file:{index}"),
                format!("{} ({})", file.name, file.workspace_root),
            )
            .build(app)
            .map_err(|error| CommandError::Recent(error.to_string()))?;
            recent_file_menu = recent_file_menu.item(&item);
        }
    }
    let recent_file_menu = recent_file_menu
        .build()
        .map_err(|error| CommandError::Recent(error.to_string()))?;

    let file_menu_builder = SubmenuBuilder::new(app, "File")
        .item(&new_file)
        .item(&new_folder)
        .separator()
        .item(&open_file)
        .item(&open_folder)
        .item(&recent_workspace_menu)
        .item(&recent_file_menu)
        .separator()
        .item(&save_file)
        .item(&save_all)
        .item(&reload_file)
        .separator()
        .item(&rename_selected)
        .item(&delete_selected)
        .separator()
        .item(&close_tab)
        .item(&close_all);
    #[cfg(not(target_os = "macos"))]
    let file_menu_builder = file_menu_builder.separator().quit();
    let file_menu = file_menu_builder
        .build()
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let show_integrations = MenuItemBuilder::with_id("show_integrations", "Integrations...")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let settings = MenuItemBuilder::with_id("show_settings", "Settings...")
        .accelerator("CmdOrCtrl+,")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    #[cfg(target_os = "macos")]
    let app_menu = {
        let pkg_info = app.package_info();
        let about_metadata = AboutMetadata {
            name: Some(pkg_info.name.clone()),
            version: Some(pkg_info.version.to_string()),
            copyright: app.config().bundle.copyright.clone(),
            authors: app
                .config()
                .bundle
                .publisher
                .clone()
                .map(|publisher| vec![publisher]),
            ..Default::default()
        };
        SubmenuBuilder::new(app, pkg_info.name.clone())
            .about(Some(about_metadata))
            .separator()
            .item(&settings)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .separator()
            .quit()
            .build()
            .map_err(|error| CommandError::Recent(error.to_string()))?
    };
    #[cfg(target_os = "macos")]
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&show_integrations)
        .build()
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    #[cfg(not(target_os = "macos"))]
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&show_integrations)
        .item(&settings)
        .build()
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .build()
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let go_to_definition = MenuItemBuilder::with_id("go_to_definition", "Go to Definition")
        .accelerator("F12")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let find_references = MenuItemBuilder::with_id("find_references", "Find References")
        .accelerator("Shift+F12")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let navigate_menu = SubmenuBuilder::new(app, "Navigate")
        .item(&go_to_definition)
        .item(&find_references)
        .build()
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let command_palette = MenuItemBuilder::with_id("command_palette", "Command Palette...")
        .accelerator("CmdOrCtrl+Shift+P")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let quick_open = MenuItemBuilder::with_id("quick_open", "Go to File...")
        .accelerator("CmdOrCtrl+P")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let go_to_line = MenuItemBuilder::with_id("go_to_line", "Go to Line...")
        .accelerator("Ctrl+G")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let find_in_file = MenuItemBuilder::with_id("find_in_file", "Find in File")
        .accelerator("CmdOrCtrl+F")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let find_in_files = MenuItemBuilder::with_id("find_in_files", "Find in Files")
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let search_menu = SubmenuBuilder::new(app, "Search")
        .item(&command_palette)
        .separator()
        .item(&quick_open)
        .item(&go_to_line)
        .item(&find_in_file)
        .item(&find_in_files)
        .build()
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    let menu_builder = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let menu_builder = menu_builder.item(&app_menu);
    let menu = menu_builder
        .item(&file_menu)
        .item(&edit_menu)
        .item(&search_menu)
        .item(&navigate_menu)
        .item(&view_menu)
        .build()
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    app.set_menu(menu)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    Ok(())
}

fn record_recent_workspace_item(state: &AppState, root: &Path) -> Result<(), CommandError> {
    let path = root.to_string_lossy().to_string();
    let item = RecentWorkspace {
        name: last_segment(root).unwrap_or_else(|| path.clone()),
        path: path.clone(),
        last_opened: now_ms(),
    };
    let mut items = state
        .recent_items
        .write()
        .map_err(|_| CommandError::Recent("recent items lock poisoned".to_string()))?;
    items.workspaces.retain(|workspace| workspace.path != path);
    items.workspaces.insert(0, item);
    items.workspaces.truncate(8);
    Ok(())
}

fn record_recent_file_item(
    state: &AppState,
    workspace_root: &Path,
    path: &str,
    single_file: bool,
) -> Result<(), CommandError> {
    let item = RecentFile {
        workspace_root: workspace_root.to_string_lossy().to_string(),
        path: path.to_string(),
        name: path
            .split('/')
            .rfind(|value| !value.is_empty())
            .unwrap_or(path)
            .to_string(),
        single_file,
        last_opened: now_ms(),
    };
    let mut items = state
        .recent_items
        .write()
        .map_err(|_| CommandError::Recent("recent items lock poisoned".to_string()))?;
    items
        .files
        .retain(|file| file.workspace_root != item.workspace_root || file.path != item.path);
    items.files.insert(0, item);
    items.files.truncate(8);
    Ok(())
}

fn persist_recent_items(state: &AppState) -> Result<(), CommandError> {
    let path = state
        .recent_store_path
        .read()
        .map_err(|_| CommandError::Recent("recent store lock poisoned".to_string()))?
        .clone()
        .ok_or_else(|| CommandError::Recent("recent store path is unavailable".to_string()))?;
    let items = state
        .recent_items
        .read()
        .map_err(|_| CommandError::Recent("recent items lock poisoned".to_string()))?
        .clone();
    let contents = serde_json::to_string_pretty(&items)
        .map_err(|error| CommandError::Recent(error.to_string()))?;
    std::fs::write(path, contents).map_err(|error| CommandError::Recent(error.to_string()))
}

fn load_recent_items(path: &Path) -> Result<RecentItems, std::io::Error> {
    if !path.exists() {
        return Ok(RecentItems::default());
    }

    let contents = std::fs::read_to_string(path)?;
    serde_json::from_str(&contents).map_err(std::io::Error::other)
}

fn workspace_ui_snapshot_for_root(
    state: &AppState,
    workspace_root: &str,
) -> Result<PersistedUiSnapshot, CommandError> {
    let ui_state = state
        .ui_state
        .read()
        .map_err(|_| CommandError::UiState("ui state lock poisoned".to_string()))?;
    let view = sanitize_view_settings(ui_state.view.clone());
    let workspace = ui_state
        .workspaces
        .iter()
        .find(|workspace| workspace.workspace_root == workspace_root)
        .map(|workspace| WorkspaceUiStatePayload {
            expanded_folders: workspace.expanded_folders.clone(),
            open_files: workspace.open_files.clone(),
            active_file: workspace.active_file.clone(),
            selected_path: workspace.selected_path.clone(),
        })
        .unwrap_or_default();
    Ok(PersistedUiSnapshot { view, workspace })
}

fn sanitize_workspace_ui_state(state: WorkspaceUiStatePayload) -> WorkspaceUiStatePayload {
    let mut expanded_folders = state
        .expanded_folders
        .into_iter()
        .filter(|path| is_safe_relative_path(path))
        .collect::<Vec<_>>();
    expanded_folders.sort();
    expanded_folders.dedup();

    let mut open_files = state
        .open_files
        .into_iter()
        .filter(|path| is_safe_relative_path(path))
        .collect::<Vec<_>>();
    open_files.dedup();
    open_files.truncate(32);

    let active_file = state
        .active_file
        .filter(|path| is_safe_relative_path(path) && open_files.contains(path));
    let selected_path = state
        .selected_path
        .filter(|path| is_safe_relative_path(path));

    WorkspaceUiStatePayload {
        expanded_folders,
        open_files,
        active_file,
        selected_path,
    }
}

fn is_safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn persist_ui_state(state: &AppState) -> Result<(), CommandError> {
    let path = state
        .ui_state_store_path
        .read()
        .map_err(|_| CommandError::UiState("ui state store lock poisoned".to_string()))?
        .clone()
        .ok_or_else(|| CommandError::UiState("ui state store path is unavailable".to_string()))?;
    let state = state
        .ui_state
        .read()
        .map_err(|_| CommandError::UiState("ui state lock poisoned".to_string()))?
        .clone();
    let contents = serde_json::to_string_pretty(&state)
        .map_err(|error| CommandError::UiState(error.to_string()))?;
    std::fs::write(path, contents).map_err(|error| CommandError::UiState(error.to_string()))
}

fn load_ui_state(path: &Path) -> Result<AppUiState, std::io::Error> {
    if !path.exists() {
        return Ok(AppUiState::default());
    }

    let contents = std::fs::read_to_string(path)?;
    let mut state: AppUiState = serde_json::from_str(&contents).map_err(std::io::Error::other)?;
    state.view = sanitize_view_settings(state.view);
    Ok(state)
}

pub(crate) fn workspace_display_context(
    workspace_root: &Path,
    title_max_chars: usize,
) -> WorkspaceDisplayContext {
    let title_max_chars =
        title_max_chars.clamp(MIN_WORKSPACE_TITLE_MAX_CHARS, MAX_WORKSPACE_TITLE_MAX_CHARS);
    let canonical_root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let git_root = nearest_git_root(&canonical_root);
    let full_label = git_root
        .as_ref()
        .map(|root| git_relative_label(root, &canonical_root))
        .unwrap_or_else(|| {
            canonical_root
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| canonical_root.to_string_lossy().to_string())
        });
    let workspace_label = abbreviate_workspace_label(&full_label, title_max_chars);

    WorkspaceDisplayContext {
        app_title: format!("ide - {workspace_label}"),
        workspace_label,
        full_label,
        git_root: git_root.map(|path| path_to_string(&path)),
    }
}

fn nearest_git_root(path: &Path) -> Option<PathBuf> {
    let mut current = if path.is_file() {
        path.parent()?.to_path_buf()
    } else {
        path.to_path_buf()
    };

    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn git_relative_label(git_root: &Path, workspace_root: &Path) -> String {
    let root_name = git_root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("workspace")
        .to_string();
    let relative = workspace_root
        .strip_prefix(git_root)
        .ok()
        .map(normalize_display_path)
        .filter(|path| !path.is_empty());

    relative
        .map(|path| format!("{root_name}/{path}"))
        .unwrap_or(root_name)
}

fn normalize_display_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn abbreviate_workspace_label(label: &str, max_chars: usize) -> String {
    if label.chars().count() <= max_chars {
        return label.to_string();
    }

    let segments = label.split('/').collect::<Vec<_>>();
    if segments.len() < 3 {
        return truncate_label_end(label, max_chars);
    }

    let repo = segments[0];
    let current = segments[segments.len() - 1];
    let parent = segments[segments.len() - 2];
    let with_parent = format!("{repo}/.../{parent}/{current}");
    if with_parent.chars().count() <= max_chars {
        return with_parent;
    }

    let without_parent = format!("{repo}/.../{current}");
    if without_parent.chars().count() <= max_chars {
        return without_parent;
    }

    truncate_label_end(&without_parent, max_chars)
}

fn truncate_label_end(label: &str, max_chars: usize) -> String {
    if label.chars().count() <= max_chars {
        return label.to_string();
    }
    if max_chars <= 3 {
        return ".".repeat(max_chars);
    }
    let keep = max_chars.saturating_sub(3);
    format!("{}...", label.chars().take(keep).collect::<String>())
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn last_segment(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchTarget {
    workspace_root: PathBuf,
    initial_file: Option<String>,
}

fn resolve_explicit_launch_target() -> Result<Option<LaunchTarget>, std::io::Error> {
    if let Some(path) = std::env::var_os("IDE_OPEN_PATH").filter(|value| !value.is_empty()) {
        return launch_target_for_path(PathBuf::from(path)).map(Some);
    }

    if let Some(path) = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| path.exists())
    {
        return launch_target_for_path(path).map(Some);
    }

    Ok(None)
}

fn fallback_launch_target_from_process_dir() -> Result<LaunchTarget, std::io::Error> {
    let current_dir = std::env::current_dir()?;
    let workspace_root = project_root_for_process_dir(&current_dir);
    let workspace_root = if workspace_root.parent().is_none() {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .unwrap_or(workspace_root)
    } else {
        workspace_root
    };

    Ok(LaunchTarget {
        workspace_root,
        initial_file: None,
    })
}

fn launch_target_from_saved_context(
    recent_items: &RecentItems,
    ui_state: &AppUiState,
) -> Option<LaunchTarget> {
    recent_items
        .workspaces
        .iter()
        .find_map(|workspace| launch_target_for_saved_workspace(&workspace.path))
        .or_else(|| {
            let mut workspaces = ui_state.workspaces.iter().collect::<Vec<_>>();
            workspaces.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            workspaces
                .into_iter()
                .find_map(|workspace| launch_target_for_saved_workspace(&workspace.workspace_root))
        })
}

fn launch_target_for_saved_workspace(path: &str) -> Option<LaunchTarget> {
    let path = PathBuf::from(path);
    let canonical = path.canonicalize().ok()?;
    if !canonical.is_dir() || canonical.parent().is_none() {
        return None;
    }

    Some(LaunchTarget {
        workspace_root: canonical,
        initial_file: None,
    })
}

fn launch_target_for_path(path: PathBuf) -> Result<LaunchTarget, std::io::Error> {
    let canonical = path.canonicalize()?;
    if canonical.is_dir() {
        return Ok(LaunchTarget {
            workspace_root: canonical,
            initial_file: None,
        });
    }

    let workspace_root = canonical
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| canonical.clone());
    let initial_file = canonical
        .strip_prefix(&workspace_root)
        .ok()
        .and_then(|path| path.to_str())
        .map(|path| path.replace('\\', "/"));

    Ok(LaunchTarget {
        workspace_root,
        initial_file,
    })
}

fn open_file_request_for_launch_target(target: LaunchTarget) -> Option<OpenFileRequest> {
    target.initial_file.map(|path| OpenFileRequest {
        workspace_root: target.workspace_root.to_string_lossy().to_string(),
        path,
        single_file: true,
    })
}

fn open_launch_request_for_path(path: PathBuf) -> Result<OpenLaunchRequest, std::io::Error> {
    let target = launch_target_for_path(path)?;
    if let Some(request) = open_file_request_for_launch_target(target.clone()) {
        return Ok(OpenLaunchRequest::File {
            workspace_root: request.workspace_root,
            path: request.path,
            single_file: request.single_file,
        });
    }

    Ok(OpenLaunchRequest::Workspace {
        path: target.workspace_root.to_string_lossy().to_string(),
    })
}

fn open_launch_requests_for_urls(urls: Vec<tauri::Url>) -> Vec<OpenLaunchRequest> {
    urls.into_iter()
        .filter_map(|url| {
            let path = url.to_file_path().ok()?;
            open_launch_request_for_path(path).ok()
        })
        .collect()
}

fn focus_window(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn active_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().into_values().next())
}

fn emit_to_active_window<S>(app: &tauri::AppHandle, event: &str, payload: S)
where
    S: serde::Serialize + Clone,
{
    if let Some(window) = active_window(app) {
        let _ = window.emit(event, payload);
    } else {
        let _ = app.emit(event, payload);
    }
}

fn focus_first_window(app: &tauri::AppHandle) {
    if let Some(window) = active_window(app) {
        focus_window(&window);
    }
}

fn launch_target_window_label(target: &LaunchTarget) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    target.workspace_root.to_string_lossy().hash(&mut hasher);
    target.initial_file.hash(&mut hasher);
    format!("workspace-{:x}", hasher.finish())
}

fn open_launch_target_window(
    app: &tauri::AppHandle,
    target: LaunchTarget,
) -> Result<(), tauri::Error> {
    let label = launch_target_window_label(&target);
    if let Some(window) = app.get_webview_window(&label) {
        focus_window(&window);
        return Ok(());
    }

    let state = app.state::<AppState>();
    register_window_session(&state, &label, target);
    let window = match tauri::WebviewWindowBuilder::new(
        app,
        label.clone(),
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("ide")
    .inner_size(1440.0, 960.0)
    .min_inner_size(960.0, 640.0)
    .build()
    {
        Ok(window) => window,
        Err(error) => {
            remove_window_session(&state, &label);
            return Err(error);
        }
    };
    focus_window(&window);
    Ok(())
}

fn open_launch_request_window(app: &tauri::AppHandle, request: OpenLaunchRequest) {
    let target = match request {
        OpenLaunchRequest::Workspace { path } => LaunchTarget {
            workspace_root: PathBuf::from(path),
            initial_file: None,
        },
        OpenLaunchRequest::File {
            workspace_root,
            path,
            single_file: _,
        } => LaunchTarget {
            workspace_root: PathBuf::from(workspace_root),
            initial_file: Some(path),
        },
    };
    if let Err(error) = open_launch_target_window(app, target) {
        let _ = app.emit("app://error", error.to_string());
    }
}

fn explicit_launch_target_from_args(
    args: &[String],
) -> Result<Option<LaunchTarget>, std::io::Error> {
    let current_exe = std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok());
    launch_target_from_args(args, current_exe.as_deref())
}

fn launch_target_from_args(
    args: &[String],
    current_exe: Option<&Path>,
) -> Result<Option<LaunchTarget>, std::io::Error> {
    args.iter()
        .map(PathBuf::from)
        .filter(|path| {
            !current_exe.is_some_and(|exe| path.canonicalize().ok().as_deref() == Some(exe))
        })
        .find(|path| path.exists())
        .map(launch_target_for_path)
        .transpose()
}

fn project_root_for_process_dir(process_dir: &std::path::Path) -> PathBuf {
    if process_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "src-tauri")
    {
        if let Some(parent) = process_dir.parent() {
            if parent.join("package.json").is_file() && parent.join("src-tauri").is_dir() {
                return parent.to_path_buf();
            }
        }
    }

    process_dir.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn project_root_for_process_dir_climbs_from_tauri_source_dir() {
        let dir = tempdir().unwrap();
        let tauri_dir = dir.path().join("src-tauri");
        std::fs::create_dir(&tauri_dir).unwrap();
        std::fs::write(dir.path().join("package.json"), "{}").unwrap();

        let root = project_root_for_process_dir(&tauri_dir);

        assert_eq!(root, dir.path());
    }

    #[test]
    fn project_root_for_process_dir_keeps_regular_workspace_dir() {
        let dir = tempdir().unwrap();

        let root = project_root_for_process_dir(dir.path());

        assert_eq!(root, dir.path());
    }

    #[test]
    fn launch_target_for_folder_uses_folder_as_workspace() {
        let dir = tempdir().unwrap();
        let canonical_dir = dir.path().canonicalize().unwrap();

        let target = launch_target_for_path(dir.path().to_path_buf()).unwrap();

        assert_eq!(
            target,
            LaunchTarget {
                workspace_root: canonical_dir,
                initial_file: None,
            }
        );
    }

    #[test]
    fn launch_target_for_file_uses_parent_workspace_and_initial_file() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("notes.md");
        std::fs::write(&file_path, "# Notes").unwrap();
        let canonical_dir = dir.path().canonicalize().unwrap();

        let target = launch_target_for_path(file_path).unwrap();

        assert_eq!(
            target,
            LaunchTarget {
                workspace_root: canonical_dir,
                initial_file: Some("notes.md".to_string()),
            }
        );
    }

    #[test]
    fn open_launch_request_for_folder_opens_workspace() {
        let dir = tempdir().unwrap();
        let canonical_dir = dir.path().canonicalize().unwrap();

        let request = open_launch_request_for_path(dir.path().to_path_buf()).unwrap();

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "type": "workspace",
                "path": canonical_dir.to_string_lossy(),
            })
        );
    }

    #[test]
    fn open_launch_request_for_file_opens_single_file_session() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("notes.md");
        std::fs::write(&file_path, "# Notes").unwrap();
        let canonical_dir = dir.path().canonicalize().unwrap();

        let request = open_launch_request_for_path(file_path).unwrap();

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "type": "file",
                "workspaceRoot": canonical_dir.to_string_lossy(),
                "path": "notes.md",
                "singleFile": true,
            })
        );
    }

    #[test]
    fn open_launch_requests_ignore_non_file_urls() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("notes.md");
        std::fs::write(&file_path, "# Notes").unwrap();
        let file_url = tauri::Url::from_file_path(file_path).unwrap();
        let web_url = tauri::Url::parse("https://example.com/notes.md").unwrap();

        let requests = open_launch_requests_for_urls(vec![web_url, file_url]);

        assert_eq!(requests.len(), 1);
        assert!(matches!(requests[0], OpenLaunchRequest::File { .. }));
    }

    #[test]
    fn launch_target_from_args_accepts_target_without_executable_arg() {
        let dir = tempdir().unwrap();
        let canonical_dir = dir.path().canonicalize().unwrap();
        let args = vec![dir.path().to_string_lossy().to_string()];

        let target = launch_target_from_args(&args, None).unwrap();

        assert_eq!(
            target,
            Some(LaunchTarget {
                workspace_root: canonical_dir,
                initial_file: None,
            })
        );
    }

    #[test]
    fn launch_target_from_args_ignores_executable_arg_when_present() {
        let dir = tempdir().unwrap();
        let fake_exe = dir.path().join("ide-bin");
        let workspace = dir.path().join("workspace");
        std::fs::write(&fake_exe, "").unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let canonical_workspace = workspace.canonicalize().unwrap();
        let canonical_exe = fake_exe.canonicalize().unwrap();
        let args = vec![
            fake_exe.to_string_lossy().to_string(),
            workspace.to_string_lossy().to_string(),
        ];

        let target = launch_target_from_args(&args, Some(&canonical_exe)).unwrap();

        assert_eq!(
            target,
            Some(LaunchTarget {
                workspace_root: canonical_workspace,
                initial_file: None,
            })
        );
    }

    #[test]
    fn saved_launch_context_uses_most_recent_existing_workspace() {
        let dir = tempdir().unwrap();
        let workspace_a = dir.path().join("workspace-a");
        let workspace_b = dir.path().join("workspace-b");
        std::fs::create_dir(&workspace_a).unwrap();
        std::fs::create_dir(&workspace_b).unwrap();
        let recent_items = RecentItems {
            workspaces: vec![
                RecentWorkspace {
                    path: "/missing".to_string(),
                    name: "missing".to_string(),
                    last_opened: 3,
                },
                RecentWorkspace {
                    path: workspace_b.to_string_lossy().to_string(),
                    name: "workspace-b".to_string(),
                    last_opened: 2,
                },
                RecentWorkspace {
                    path: workspace_a.to_string_lossy().to_string(),
                    name: "workspace-a".to_string(),
                    last_opened: 1,
                },
            ],
            files: Vec::new(),
        };

        let target = launch_target_from_saved_context(&recent_items, &AppUiState::default())
            .expect("expected saved launch target");

        assert_eq!(
            target,
            LaunchTarget {
                workspace_root: workspace_b.canonicalize().unwrap(),
                initial_file: None,
            }
        );
    }

    #[test]
    fn saved_launch_context_falls_back_to_latest_ui_workspace() {
        let dir = tempdir().unwrap();
        let older = dir.path().join("older");
        let newer = dir.path().join("newer");
        std::fs::create_dir(&older).unwrap();
        std::fs::create_dir(&newer).unwrap();
        let ui_state = AppUiState {
            view: PersistedViewSettings::default(),
            workspaces: vec![
                PersistedWorkspaceUiState {
                    workspace_root: older.to_string_lossy().to_string(),
                    expanded_folders: Vec::new(),
                    open_files: Vec::new(),
                    active_file: None,
                    selected_path: None,
                    updated_at: 1,
                },
                PersistedWorkspaceUiState {
                    workspace_root: newer.to_string_lossy().to_string(),
                    expanded_folders: Vec::new(),
                    open_files: Vec::new(),
                    active_file: None,
                    selected_path: None,
                    updated_at: 2,
                },
            ],
        };

        let target = launch_target_from_saved_context(&RecentItems::default(), &ui_state)
            .expect("expected saved launch target");

        assert_eq!(
            target,
            LaunchTarget {
                workspace_root: newer.canonicalize().unwrap(),
                initial_file: None,
            }
        );
    }

    #[test]
    fn saved_launch_context_ignores_drive_root() {
        let recent_items = RecentItems {
            workspaces: vec![RecentWorkspace {
                path: Path::new(std::path::MAIN_SEPARATOR_STR)
                    .to_string_lossy()
                    .to_string(),
                name: "root".to_string(),
                last_opened: 1,
            }],
            files: Vec::new(),
        };

        let target = launch_target_from_saved_context(&recent_items, &AppUiState::default());

        assert_eq!(target, None);
    }

    #[test]
    fn recent_items_are_deduplicated_ordered_and_persisted() {
        let dir = tempdir().unwrap();
        let recents_path = dir.path().join("recents.json");
        let workspace_a = dir.path().join("workspace-a");
        let workspace_b = dir.path().join("workspace-b");
        std::fs::create_dir(&workspace_a).unwrap();
        std::fs::create_dir(&workspace_b).unwrap();
        let state = test_state(recents_path.clone());

        record_recent_workspace_item(&state, &workspace_a).unwrap();
        record_recent_workspace_item(&state, &workspace_b).unwrap();
        record_recent_workspace_item(&state, &workspace_a).unwrap();
        record_recent_file_item(&state, &workspace_a, "src/main.ts", true).unwrap();
        record_recent_file_item(&state, &workspace_a, "README.md", false).unwrap();
        record_recent_file_item(&state, &workspace_a, "src/main.ts", true).unwrap();
        persist_recent_items(&state).unwrap();

        let loaded = load_recent_items(&recents_path).unwrap();
        assert_eq!(loaded.workspaces.len(), 2);
        assert_eq!(loaded.workspaces[0].path, workspace_a.to_string_lossy());
        assert_eq!(loaded.workspaces[1].path, workspace_b.to_string_lossy());
        assert_eq!(loaded.files.len(), 2);
        assert_eq!(loaded.files[0].path, "src/main.ts");
        assert!(loaded.files[0].single_file);
        assert_eq!(loaded.files[1].path, "README.md");
        assert!(!loaded.files[1].single_file);
    }

    #[test]
    fn ui_state_is_sanitized_deduplicated_and_persisted() {
        let dir = tempdir().unwrap();
        let recents_path = dir.path().join("recents.json");
        let ui_state_path = dir.path().join("ui-state.json");
        let state = test_state(recents_path);
        *state.ui_state_store_path.write().unwrap() = Some(ui_state_path.clone());

        let workspace = sanitize_workspace_ui_state(WorkspaceUiStatePayload {
            expanded_folders: vec![
                "src".to_string(),
                "../secret".to_string(),
                "src".to_string(),
                "/tmp".to_string(),
            ],
            open_files: vec![
                "README.md".to_string(),
                "../secret".to_string(),
                "README.md".to_string(),
                "src/App.tsx".to_string(),
            ],
            active_file: Some("src/App.tsx".to_string()),
            selected_path: Some("/tmp".to_string()),
        });

        assert_eq!(workspace.expanded_folders, vec!["src".to_string()]);
        assert_eq!(
            workspace.open_files,
            vec!["README.md".to_string(), "src/App.tsx".to_string()]
        );
        assert_eq!(workspace.active_file, Some("src/App.tsx".to_string()));
        assert_eq!(workspace.selected_path, None);

        *state.ui_state.write().unwrap() = AppUiState {
            view: PersistedViewSettings {
                show_dotfiles: true,
                show_generated_internal: true,
                tree_scan_limit: 12_000,
                max_open_file_kb: 8_192,
                workspace_search_result_limit: 750,
                workspace_search_max_file_kb: 2_048,
                current_file_search_result_limit: 350,
                current_file_result_preview_limit: 16,
                quick_open_result_limit: 24,
                background_index_batch_entries: 3_000,
                workspace_title_max_chars: 50,
                command_palette_result_limit: 32,
            },
            workspaces: vec![PersistedWorkspaceUiState {
                workspace_root: "/workspace".to_string(),
                expanded_folders: workspace.expanded_folders,
                open_files: workspace.open_files,
                active_file: workspace.active_file,
                selected_path: workspace.selected_path,
                updated_at: 123,
            }],
        };
        persist_ui_state(&state).unwrap();

        let loaded = load_ui_state(&ui_state_path).unwrap();
        assert!(loaded.view.show_dotfiles);
        assert!(loaded.view.show_generated_internal);
        assert_eq!(loaded.view.max_open_file_kb, 8_192);
        assert_eq!(loaded.view.workspace_search_result_limit, 750);
        assert_eq!(loaded.view.workspace_search_max_file_kb, 2_048);
        assert_eq!(loaded.view.current_file_search_result_limit, 350);
        assert_eq!(loaded.view.current_file_result_preview_limit, 16);
        assert_eq!(loaded.view.quick_open_result_limit, 24);
        assert_eq!(loaded.view.command_palette_result_limit, 32);
        assert_eq!(loaded.workspaces.len(), 1);

        *state.ui_state.write().unwrap() = loaded;
        let snapshot = workspace_ui_snapshot_for_root(&state, "/workspace").unwrap();
        assert_eq!(snapshot.workspace.expanded_folders, vec!["src".to_string()]);
        assert_eq!(
            snapshot.workspace.open_files,
            vec!["README.md".to_string(), "src/App.tsx".to_string()]
        );
        assert_eq!(
            snapshot.workspace.active_file,
            Some("src/App.tsx".to_string())
        );
    }

    #[test]
    fn settings_locations_report_user_state_and_cache_paths() {
        let dir = tempdir().unwrap();
        let recents_path = dir.path().join("recents.json");
        let ui_state_path = dir.path().join("ui-state.json");
        let workspace_index_path = dir.path().join("workspace-index.sqlite");
        let state = test_state(recents_path.clone());
        *state.ui_state_store_path.write().unwrap() = Some(ui_state_path.clone());
        state
            .workspace_index
            .set_database_path(workspace_index_path.clone())
            .unwrap();

        let locations = settings_locations_for_state(&state).unwrap();

        assert_eq!(
            locations.settings_file,
            Some(path_to_string(&ui_state_path))
        );
        assert_eq!(locations.recents_file, Some(path_to_string(&recents_path)));
        assert_eq!(
            locations.workspace_index_file,
            Some(path_to_string(&workspace_index_path))
        );
    }

    #[test]
    fn workspace_index_stats_report_current_root_coverage() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path().join("recents.json"));
        state
            .workspace_index
            .set_database_path(dir.path().join("workspace-index.sqlite"))
            .unwrap();
        state
            .workspace_index
            .replace_directory_entries(
                dir.path(),
                "",
                &[
                    test_entry("src", None, true),
                    test_entry("README.md", None, false),
                ],
            )
            .unwrap();

        let stats = workspace_index_stats_for_root(&state.workspace_index, dir.path()).unwrap();

        assert_eq!(stats.indexed_entries, 2);
        assert_eq!(stats.indexed_files, 1);
        assert_eq!(stats.indexed_folders, 1);
        assert_eq!(stats.loaded_folders, 1);
        assert_eq!(stats.pending_folders, 1);
    }

    #[test]
    fn indexed_file_search_discards_stale_expansion_directories() {
        let dir = tempdir().unwrap();
        let index = workspace_index::WorkspaceIndex::new();
        index
            .set_database_path(dir.path().join("workspace-index.sqlite"))
            .unwrap();
        index
            .replace_root_entries(dir.path(), &[test_entry("missing", None, true)])
            .unwrap();
        index
            .replace_directory_entries(dir.path(), "", &[test_entry("missing", None, true)])
            .unwrap();

        let results =
            search_indexed_files_with_expansion(&index, dir.path(), "needle", 10, 20, false, false)
                .unwrap();

        assert!(results.is_empty());
        assert!(index.entries_for_root(dir.path()).unwrap().is_empty());
    }

    fn test_entry(path: &str, parent: Option<&str>, is_dir: bool) -> workspace::FileEntry {
        workspace::FileEntry {
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

    fn test_state(recents_path: PathBuf) -> AppState {
        let ui_state_path = recents_path.with_file_name("ui-state.json");
        AppState {
            workspace_root: Arc::new(RwLock::new(PathBuf::new())),
            initial_file: Arc::new(RwLock::new(None)),
            window_sessions: Arc::new(std::sync::RwLock::new(HashMap::new())),
            pending_open_requests: Arc::new(std::sync::RwLock::new(Vec::new())),
            recent_items: Arc::new(std::sync::RwLock::new(RecentItems::default())),
            recent_store_path: Arc::new(std::sync::RwLock::new(Some(recents_path))),
            ui_state: Arc::new(std::sync::RwLock::new(AppUiState::default())),
            ui_state_store_path: Arc::new(std::sync::RwLock::new(Some(ui_state_path))),
            tree_scan_limit: Arc::new(std::sync::RwLock::new(default_tree_scan_limit())),
            max_open_file_bytes: Arc::new(std::sync::RwLock::new(
                default_max_open_file_kb().saturating_mul(1024),
            )),
            workspace_search_result_limit: Arc::new(std::sync::RwLock::new(
                default_workspace_search_result_limit(),
            )),
            workspace_search_max_file_bytes: Arc::new(std::sync::RwLock::new(
                default_workspace_search_max_file_kb().saturating_mul(1024),
            )),
            quick_open_result_limit: Arc::new(std::sync::RwLock::new(
                default_quick_open_result_limit(),
            )),
            background_index_batch_entries: Arc::new(std::sync::RwLock::new(
                default_background_index_batch_entries(),
            )),
            workspace_index: workspace_index::WorkspaceIndex::new(),
            agent_context: Arc::new(RwLock::new(AgentContext::default())),
            lsp_manager: lsp::LspManager::new(),
            http_endpoint: Arc::new(RwLock::new(None)),
            http_error: Arc::new(RwLock::new(None)),
            codex_mcp: Arc::new(RwLock::new(None)),
            claude_bridge: Arc::new(RwLock::new(None)),
            claude_bridge_error: Arc::new(RwLock::new(None)),
        }
    }
}
