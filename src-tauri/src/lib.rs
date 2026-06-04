mod lsp;
mod workspace;

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::RwLock;
use workspace::{read_workspace_file, scan_workspace, write_workspace_file, WorkspaceError};

#[derive(Clone)]
struct AppState {
    workspace_root: PathBuf,
    agent_context: Arc<RwLock<AgentContext>>,
    lsp_manager: lsp::LspManager,
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
fn get_workspace_root(state: State<'_, AppState>) -> String {
    state.workspace_root.to_string_lossy().to_string()
}

#[tauri::command]
fn list_files(state: State<'_, AppState>) -> Result<Vec<workspace::FileEntry>, CommandError> {
    scan_workspace(&state.workspace_root, 4_000).map_err(CommandError::from)
}

#[tauri::command]
fn read_file(state: State<'_, AppState>, path: String) -> Result<String, CommandError> {
    read_workspace_file(&state.workspace_root, &path).map_err(CommandError::from)
}

#[tauri::command]
fn write_file(
    state: State<'_, AppState>,
    path: String,
    contents: String,
) -> Result<(), CommandError> {
    write_workspace_file(&state.workspace_root, &path, &contents).map_err(CommandError::from)
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
async fn start_lsp(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    language: String,
) -> Result<lsp::LspStartResult, CommandError> {
    state
        .lsp_manager
        .start(app, &language, &state.workspace_root)
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
    let workspace_root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let app_state = AppState {
        workspace_root,
        agent_context: Arc::new(RwLock::new(AgentContext::default())),
        lsp_manager: lsp::LspManager::new(),
    };

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_workspace_root,
            list_files,
            read_file,
            write_file,
            update_agent_context,
            get_agent_context,
            get_lsp_servers,
            start_lsp,
            send_lsp_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
