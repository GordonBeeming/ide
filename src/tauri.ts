import { invoke } from "@tauri-apps/api/core";

export interface FileEntry {
  path: string;
  name: string;
  parent?: string;
  isDir: boolean;
  depth: number;
  size: number;
  modifiedMs?: number;
}

export interface EditorSelection {
  filePath: string;
  text: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface AgentContext {
  activeFile?: string;
  openFiles: string[];
  selection?: EditorSelection;
}

export function getWorkspaceRoot() {
  return invoke<string>("get_workspace_root");
}

export function listFiles() {
  return invoke<FileEntry[]>("list_files");
}

export function readFile(path: string) {
  return invoke<string>("read_file", { path });
}

export function writeFile(path: string, contents: string) {
  return invoke<void>("write_file", { path, contents });
}

export function updateAgentContext(context: AgentContext) {
  return invoke<void>("update_agent_context", { context });
}
