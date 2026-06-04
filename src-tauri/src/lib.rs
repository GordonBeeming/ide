mod claude_bridge;
mod http_server;
mod lsp;
mod workspace;

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::RwLock;
use workspace::{
    read_workspace_file, scan_workspace, search_workspace, write_workspace_file, WorkspaceError,
};

#[derive(Clone)]
struct AppState {
    workspace_root: Arc<RwLock<PathBuf>>,
    agent_context: Arc<RwLock<AgentContext>>,
    lsp_manager: lsp::LspManager,
    http_endpoint: Arc<RwLock<Option<String>>>,
    http_error: Arc<RwLock<Option<String>>>,
    claude_bridge: Arc<RwLock<Option<claude_bridge::ClaudeBridgeInfo>>>,
    claude_bridge_error: Arc<RwLock<Option<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AgentContext {
    active_file: Option<String>,
    open_files: Vec<String>,
    selection: Option<EditorSelection>,
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
) -> Result<(), CommandError> {
    let workspace_root = state.workspace_root.read().await.clone();
    write_workspace_file(&workspace_root, &path, &contents).map_err(CommandError::from)
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
    set_workspace_root_path(&state, path).await.map(Some)
}

#[tauri::command]
async fn set_workspace_root(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, CommandError> {
    set_workspace_root_path(&state, PathBuf::from(path)).await
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
    let workspace_root =
        resolve_workspace_root().expect("failed to determine current workspace directory");
    let agent_context = Arc::new(RwLock::new(AgentContext::default()));
    let lsp_manager = lsp::LspManager::new();
    let http_endpoint = Arc::new(RwLock::new(None));
    let http_error = Arc::new(RwLock::new(None));
    let claude_bridge = Arc::new(RwLock::new(None));
    let claude_bridge_error = Arc::new(RwLock::new(None));
    let app_state = AppState {
        workspace_root: Arc::new(RwLock::new(workspace_root)),
        agent_context,
        lsp_manager,
        http_endpoint,
        http_error,
        claude_bridge,
        claude_bridge_error,
    };
    let http_state = app_state.clone();

    tauri::Builder::default()
        .manage(app_state)
        .setup(move |_app| {
            let workspace_root = http_state.workspace_root.clone();
            let agent_context = http_state.agent_context.clone();
            let lsp_manager = http_state.lsp_manager.clone();
            let http_endpoint = http_state.http_endpoint.clone();
            let http_error = http_state.http_error.clone();
            let claude_bridge = http_state.claude_bridge.clone();
            let claude_bridge_error = http_state.claude_bridge_error.clone();
            let frontend_dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
            tauri::async_runtime::spawn(async move {
                match http_server::start_http_server(
                    workspace_root,
                    agent_context,
                    lsp_manager,
                    frontend_dist,
                    http_error.clone(),
                )
                .await
                {
                    Ok(info) => {
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_workspace_root,
            list_files,
            read_file,
            write_file,
            search_files,
            pick_workspace_folder,
            set_workspace_root,
            update_agent_context,
            get_agent_context,
            get_lsp_servers,
            get_http_endpoint,
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
    if let Some(bridge) = state.claude_bridge.read().await.clone() {
        claude_bridge::update_lock_workspace(&bridge.lock_file, &canonical)
            .map_err(|error| CommandError::ClaudeBridge(error.to_string()))?;
    }

    Ok(canonical.to_string_lossy().to_string())
}

fn resolve_workspace_root() -> Result<PathBuf, std::io::Error> {
    let current_dir = std::env::current_dir()?;
    Ok(project_root_for_process_dir(&current_dir))
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
}
