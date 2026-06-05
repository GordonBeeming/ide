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
  diagnostics: EditorDiagnostic[];
}

export interface EditorDiagnostic {
  filePath: string;
  message: string;
  severity?: number;
  source?: string;
  code?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface LspServerStatus {
  language: string;
  displayName: string;
  command: string;
  args: string[];
  available: boolean;
  running: boolean;
  detail: string;
}

export interface LspStartResult {
  language: string;
  sessionId: string;
  running: boolean;
}

export interface ClaudeBridgeStatus {
  endpoint: string;
  lockFile: string;
}

export interface CodexMcpStatus {
  endpoint: string;
  bearerToken: string;
}

export interface SearchMatch {
  path: string;
  lineNumber: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export function isNativeTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getWorkspaceRoot() {
  return callApi<string>("get_workspace_root", "/api/workspace-root");
}

export function getInitialFile() {
  if (!isNativeTauri()) return Promise.resolve(undefined);
  return invoke<string | undefined>("get_initial_file");
}

export function setWorkspaceRootPath(path: string) {
  if (!isNativeTauri()) {
    return Promise.reject(new Error("Workspace switching is only available in the native Tauri app"));
  }
  return invoke<string>("set_workspace_root", { path });
}

export function recordRecentFile(path: string) {
  if (!isNativeTauri()) return Promise.resolve();
  return invoke<void>("record_recent_file", { path });
}

export function listFiles(showDotfiles = false, showGeneratedInternal = false) {
  const params = new URLSearchParams();
  if (showDotfiles) params.set("showDotfiles", "true");
  if (showGeneratedInternal) params.set("showGeneratedInternal", "true");
  const query = params.toString();
  const path = query ? `/api/files?${query}` : "/api/files";
  return callApi<FileEntry[]>("list_files", path, {
    invokeArgs: { showDotfiles, showGeneratedInternal },
  });
}

export function readFile(path: string) {
  return callApi<string>("read_file", `/api/file?path=${encodeURIComponent(path)}`, {
    method: "GET",
    invokeArgs: { path },
  });
}

export function writeFile(path: string, contents: string, expectedModifiedMs?: number) {
  return callApi<void>("write_file", "/api/file", {
    method: "PUT",
    body: { path, contents, expectedModifiedMs },
    invokeArgs: { path, contents, expectedModifiedMs },
  });
}

export function createFile(path: string) {
  return callApi<void>("create_file", "/api/file", {
    method: "POST",
    body: { path, contents: "" },
    invokeArgs: { path },
  });
}

export function createFolder(path: string) {
  return callApi<void>("create_folder", "/api/folder", {
    method: "POST",
    body: { path },
    invokeArgs: { path },
  });
}

export function renameFile(fromPath: string, toPath: string) {
  return callApi<void>("rename_file", "/api/file", {
    method: "PATCH",
    body: { fromPath, toPath },
    invokeArgs: { fromPath, toPath },
  });
}

export function deleteFile(path: string) {
  return callApi<void>("delete_file", "/api/file", {
    method: "DELETE",
    body: { path },
    invokeArgs: { path },
  });
}

export function searchFiles(query: string) {
  return callApi<SearchMatch[]>("search_files", `/api/search?query=${encodeURIComponent(query)}`, {
    method: "GET",
    invokeArgs: { query },
  });
}

export function pickWorkspaceFolder() {
  if (!isNativeTauri()) {
    return Promise.reject(new Error("Folder picker is only available in the native Tauri app"));
  }
  return invoke<string | undefined>("pick_workspace_folder");
}

export function updateAgentContext(context: AgentContext) {
  return callApi<void>("update_agent_context", "/api/agent-context", {
    method: "PUT",
    body: context,
    invokeArgs: { context },
  });
}

export function getLspServers() {
  return callApi<LspServerStatus[]>("get_lsp_servers", "/api/lsp");
}

export function getHttpEndpoint() {
  if (!isNativeTauri()) return Promise.resolve(window.location.origin);
  return invoke<string | undefined>("get_http_endpoint");
}

export function getClaudeBridgeStatus() {
  if (!isNativeTauri()) return Promise.resolve(undefined);
  return invoke<ClaudeBridgeStatus | undefined>("get_claude_bridge_status");
}

export function getCodexMcpStatus() {
  return callApi<CodexMcpStatus | undefined>("get_codex_mcp_status", "/api/codex-mcp");
}

export function startLsp(language: string) {
  if (!isNativeTauri()) {
    return Promise.reject(new Error("LSP bridge is only available in the native Tauri app"));
  }
  return invoke<LspStartResult>("start_lsp", { language });
}

export function sendLspMessage(language: string, message: string) {
  if (!isNativeTauri()) {
    return Promise.reject(new Error("LSP bridge is only available in the native Tauri app"));
  }
  return invoke<void>("send_lsp_message", { language, message });
}

interface ApiOptions {
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  body?: unknown;
  invokeArgs?: Record<string, unknown>;
}

let localBearerToken: Promise<string> | undefined;

async function callApi<T>(
  command: string,
  path: string,
  options: ApiOptions = {},
): Promise<T> {
  if (isNativeTauri()) {
    return invoke<T>(command, options.invokeArgs);
  }

  const headers = new Headers();
  if (options.body) {
    headers.set("Content-Type", "application/json");
  }
  if (
    options.method === "DELETE" ||
    options.method === "PATCH" ||
    options.method === "POST" ||
    options.method === "PUT"
  ) {
    headers.set("Authorization", `Bearer ${await localWriteToken()}`);
  }

  const response = await fetch(`${httpBase()}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  if (response.status === 204 || response.status === 201) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json() as Promise<T>;
  }

  return response.text() as Promise<T>;
}

function httpBase() {
  return apiBaseForLocation(window.location);
}

export function apiBaseForLocation(location: Pick<Location, "port">) {
  if (location.port === "1420") {
    return "http://127.0.0.1:17877";
  }
  return "";
}

async function localWriteToken() {
  localBearerToken ??= fetch(`${httpBase()}/api/codex-mcp`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(await response.text());
      }
      return response.json() as Promise<CodexMcpStatus>;
    })
    .then((status) => {
      if (!status?.bearerToken) {
        throw new Error("Local write token is unavailable");
      }
      return status.bearerToken;
    });

  return localBearerToken;
}
