mod claude_bridge;
mod http_server;
mod lsp;
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::RwLock;
use workspace::{
    create_workspace_file, create_workspace_folder, delete_workspace_file, read_workspace_file,
    rename_workspace_file, scan_workspace, search_workspace, write_workspace_file, WorkspaceError,
};

#[derive(Clone)]
struct AppState {
    workspace_root: Arc<RwLock<PathBuf>>,
    initial_file: Arc<RwLock<Option<String>>>,
    recent_items: Arc<std::sync::RwLock<RecentItems>>,
    recent_store_path: Arc<std::sync::RwLock<Option<PathBuf>>>,
    agent_context: Arc<RwLock<AgentContext>>,
    lsp_manager: lsp::LspManager,
    http_endpoint: Arc<RwLock<Option<String>>>,
    http_error: Arc<RwLock<Option<String>>>,
    codex_mcp: Arc<RwLock<Option<CodexMcpInfo>>>,
    claude_bridge: Arc<RwLock<Option<claude_bridge::ClaudeBridgeInfo>>>,
    claude_bridge_error: Arc<RwLock<Option<String>>>,
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
    last_opened: u128,
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
}

impl serde::Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[tauri::command]
async fn get_workspace_root(state: State<'_, AppState>) -> Result<String, CommandError> {
    Ok(state
        .workspace_root
        .read()
        .await
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
async fn get_initial_file(state: State<'_, AppState>) -> Result<Option<String>, CommandError> {
    Ok(state.initial_file.read().await.clone())
}

#[tauri::command]
async fn list_files(state: State<'_, AppState>) -> Result<Vec<workspace::FileEntry>, CommandError> {
    let workspace_root = state.workspace_root.read().await.clone();
    scan_workspace(&workspace_root, 4_000).map_err(CommandError::from)
}

#[tauri::command]
async fn read_file(state: State<'_, AppState>, path: String) -> Result<String, CommandError> {
    let workspace_root = state.workspace_root.read().await.clone();
    read_workspace_file(&workspace_root, &path).map_err(CommandError::from)
}

#[tauri::command]
async fn write_file(
    state: State<'_, AppState>,
    path: String,
    contents: String,
    expected_modified_ms: Option<u128>,
) -> Result<(), CommandError> {
    let workspace_root = state.workspace_root.read().await.clone();
    write_workspace_file(&workspace_root, &path, &contents, expected_modified_ms)
        .map_err(CommandError::from)
}

#[tauri::command]
async fn create_file(state: State<'_, AppState>, path: String) -> Result<(), CommandError> {
    let workspace_root = state.workspace_root.read().await.clone();
    create_workspace_file(&workspace_root, &path).map_err(CommandError::from)
}

#[tauri::command]
async fn create_folder(state: State<'_, AppState>, path: String) -> Result<(), CommandError> {
    let workspace_root = state.workspace_root.read().await.clone();
    create_workspace_folder(&workspace_root, &path).map_err(CommandError::from)
}

#[tauri::command]
async fn rename_file(
    state: State<'_, AppState>,
    from_path: String,
    to_path: String,
) -> Result<(), CommandError> {
    let workspace_root = state.workspace_root.read().await.clone();
    rename_workspace_file(&workspace_root, &from_path, &to_path).map_err(CommandError::from)
}

#[tauri::command]
async fn delete_file(state: State<'_, AppState>, path: String) -> Result<(), CommandError> {
    let workspace_root = state.workspace_root.read().await.clone();
    delete_workspace_file(&workspace_root, &path).map_err(CommandError::from)
}

#[tauri::command]
async fn search_files(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<workspace::SearchMatch>, CommandError> {
    let workspace_root = state.workspace_root.read().await.clone();
    search_workspace(&workspace_root, &query, 200).map_err(CommandError::from)
}

#[tauri::command]
async fn pick_workspace_folder(
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
    let root = set_workspace_root_path(&state, path).await?;
    persist_recent_items(&state)?;
    rebuild_app_menu(&app, &state)?;
    Ok(Some(root))
}

#[tauri::command]
async fn set_workspace_root(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, CommandError> {
    let root = set_workspace_root_path(&state, PathBuf::from(path)).await?;
    persist_recent_items(&state)?;
    rebuild_app_menu(&app, &state)?;
    Ok(root)
}

#[tauri::command]
async fn record_recent_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), CommandError> {
    let workspace_root = state.workspace_root.read().await.clone();
    record_recent_file_item(&state, &workspace_root, &path)?;
    persist_recent_items(&state)?;
    rebuild_app_menu(&app, &state)
}

#[tauri::command]
async fn update_agent_context(
    state: State<'_, AppState>,
    context: AgentContext,
) -> Result<(), CommandError> {
    *state.agent_context.write().await = context;
    Ok(())
}

#[tauri::command]
async fn get_agent_context(state: State<'_, AppState>) -> Result<AgentContext, CommandError> {
    Ok(state.agent_context.read().await.clone())
}

#[tauri::command]
async fn get_lsp_servers(
    state: State<'_, AppState>,
) -> Result<Vec<lsp::LspServerStatus>, CommandError> {
    Ok(state.lsp_manager.statuses().await)
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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    language: String,
) -> Result<lsp::LspStartResult, CommandError> {
    let workspace_root = state.workspace_root.read().await.clone();
    state
        .lsp_manager
        .start(app, &language, &workspace_root)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn send_lsp_message(
    state: State<'_, AppState>,
    language: String,
    message: String,
) -> Result<(), CommandError> {
    state
        .lsp_manager
        .send(&language, &message)
        .await
        .map_err(CommandError::from)
}

pub fn run() {
    let launch_target =
        resolve_launch_target().expect("failed to determine current workspace directory");
    let agent_context = Arc::new(RwLock::new(AgentContext::default()));
    let lsp_manager = lsp::LspManager::new();
    let http_endpoint = Arc::new(RwLock::new(None));
    let http_error = Arc::new(RwLock::new(None));
    let codex_mcp = Arc::new(RwLock::new(None));
    let claude_bridge = Arc::new(RwLock::new(None));
    let claude_bridge_error = Arc::new(RwLock::new(None));
    let app_state = AppState {
        workspace_root: Arc::new(RwLock::new(launch_target.workspace_root)),
        initial_file: Arc::new(RwLock::new(launch_target.initial_file)),
        recent_items: Arc::new(std::sync::RwLock::new(RecentItems::default())),
        recent_store_path: Arc::new(std::sync::RwLock::new(None)),
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
            *http_state
                .recent_items
                .write()
                .map_err(|_| std::io::Error::other("recent items lock poisoned"))? =
                load_recent_items(&recent_store_path)?;
            let initial_root = http_state.workspace_root.blocking_read().clone();
            record_recent_workspace_item(&http_state, &initial_root)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            persist_recent_items(&http_state)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            rebuild_app_menu(app.handle(), &http_state)
                .map_err(|error| std::io::Error::other(error.to_string()))?;

            let workspace_root = http_state.workspace_root.clone();
            let agent_context = http_state.agent_context.clone();
            let lsp_manager = http_state.lsp_manager.clone();
            let http_endpoint = http_state.http_endpoint.clone();
            let http_error = http_state.http_error.clone();
            let codex_mcp = http_state.codex_mcp.clone();
            let claude_bridge = http_state.claude_bridge.clone();
            let claude_bridge_error = http_state.claude_bridge_error.clone();
            let frontend_dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
            let mcp_token = uuid::Uuid::new_v4().to_string();
            tauri::async_runtime::spawn(async move {
                match http_server::start_http_server(
                    workspace_root,
                    agent_context,
                    lsp_manager,
                    frontend_dist,
                    mcp_token,
                    http_error.clone(),
                )
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
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            if id == "open_folder" {
                if let Some(path) = app.dialog().file().set_title("Open Folder").blocking_pick_folder() {
                    match path.into_path() {
                        Ok(path) => {
                            let _ = app.emit(
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
                    let _ = app.emit("menu://open-workspace", OpenWorkspaceRequest { path: item.path });
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
                    let _ = app.emit(
                        "menu://open-file",
                        OpenFileRequest {
                            workspace_root: item.workspace_root,
                            path: item.path,
                        },
                    );
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_workspace_root,
            get_initial_file,
            list_files,
            read_file,
            write_file,
            create_file,
            create_folder,
            rename_file,
            delete_file,
            search_files,
            pick_workspace_folder,
            set_workspace_root,
            record_recent_file,
            update_agent_context,
            get_agent_context,
            get_lsp_servers,
            get_http_endpoint,
            get_codex_mcp_status,
            get_claude_bridge_status,
            start_lsp,
            send_lsp_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}

async fn set_workspace_root_path(
    state: &State<'_, AppState>,
    path: PathBuf,
) -> Result<String, CommandError> {
    let canonical = path.canonicalize().map_err(WorkspaceError::from)?;
    if !canonical.is_dir() {
        return Err(CommandError::WorkspaceNotDirectory);
    }

    *state.workspace_root.write().await = canonical.clone();
    *state.agent_context.write().await = AgentContext::default();
    state.lsp_manager.stop_all().await;
    record_recent_workspace_item(state, &canonical)?;
    if let Some(bridge) = state.claude_bridge.read().await.clone() {
        claude_bridge::update_lock_workspace(&bridge.lock_file, &canonical)
            .map_err(|error| CommandError::ClaudeBridge(error.to_string()))?;
    }

    Ok(canonical.to_string_lossy().to_string())
}

fn rebuild_app_menu(app: &tauri::AppHandle, state: &AppState) -> Result<(), CommandError> {
    let recent_items = state
        .recent_items
        .read()
        .map_err(|_| CommandError::Recent("recent items lock poisoned".to_string()))?
        .clone();
    let open_folder = MenuItemBuilder::with_id("open_folder", "Open Folder...")
        .accelerator("CmdOrCtrl+O")
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

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_folder)
        .item(&recent_workspace_menu)
        .item(&recent_file_menu)
        .separator()
        .quit()
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
    let menu = MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
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
) -> Result<(), CommandError> {
    let item = RecentFile {
        workspace_root: workspace_root.to_string_lossy().to_string(),
        path: path.to_string(),
        name: path
            .split('/')
            .filter(|value| !value.is_empty())
            .last()
            .unwrap_or(path)
            .to_string(),
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

fn resolve_launch_target() -> Result<LaunchTarget, std::io::Error> {
    if let Some(path) = std::env::var_os("IDE_OPEN_PATH").filter(|value| !value.is_empty()) {
        return launch_target_for_path(PathBuf::from(path));
    }

    if let Some(path) = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| path.exists())
    {
        return launch_target_for_path(path);
    }

    let current_dir = std::env::current_dir()?;
    Ok(LaunchTarget {
        workspace_root: project_root_for_process_dir(&current_dir),
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
        record_recent_file_item(&state, &workspace_a, "src/main.ts").unwrap();
        record_recent_file_item(&state, &workspace_a, "README.md").unwrap();
        record_recent_file_item(&state, &workspace_a, "src/main.ts").unwrap();
        persist_recent_items(&state).unwrap();

        let loaded = load_recent_items(&recents_path).unwrap();
        assert_eq!(loaded.workspaces.len(), 2);
        assert_eq!(loaded.workspaces[0].path, workspace_a.to_string_lossy());
        assert_eq!(loaded.workspaces[1].path, workspace_b.to_string_lossy());
        assert_eq!(loaded.files.len(), 2);
        assert_eq!(loaded.files[0].path, "src/main.ts");
        assert_eq!(loaded.files[1].path, "README.md");
    }

    fn test_state(recents_path: PathBuf) -> AppState {
        AppState {
            workspace_root: Arc::new(RwLock::new(PathBuf::new())),
            initial_file: Arc::new(RwLock::new(None)),
            recent_items: Arc::new(std::sync::RwLock::new(RecentItems::default())),
            recent_store_path: Arc::new(std::sync::RwLock::new(Some(recents_path))),
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
