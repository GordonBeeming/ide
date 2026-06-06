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

export interface OpenFileRequest {
  workspaceRoot: string;
  path: string;
  singleFile: boolean;
}

export type OpenLaunchRequest =
  | {
      type: "workspace";
      path: string;
    }
  | {
      type: "file";
      workspaceRoot: string;
      path: string;
      singleFile: boolean;
    };

export interface PersistedViewSettings {
  showDotfiles: boolean;
  showGeneratedInternal: boolean;
  treeScanLimit?: number;
  maxOpenFileKb?: number;
  workspaceSearchResultLimit?: number;
  workspaceSearchMaxFileKb?: number;
  currentFileSearchResultLimit?: number;
  currentFileResultPreviewLimit?: number;
  quickOpenResultLimit?: number;
  commandPaletteResultLimit?: number;
}

export interface WorkspaceUiState {
  expandedFolders: string[];
  openFiles: string[];
  activeFile?: string;
  selectedPath?: string;
}

export interface PersistedUiSnapshot {
  view: PersistedViewSettings;
  workspace: WorkspaceUiState;
}

const defaultUiSnapshot: PersistedUiSnapshot = {
  view: {
    showDotfiles: false,
    showGeneratedInternal: false,
    treeScanLimit: 4000,
    maxOpenFileKb: 5120,
    workspaceSearchResultLimit: 200,
    workspaceSearchMaxFileKb: 1024,
    currentFileSearchResultLimit: 200,
    currentFileResultPreviewLimit: 12,
    quickOpenResultLimit: 12,
    commandPaletteResultLimit: 18,
  },
  workspace: {
    expandedFolders: [],
    openFiles: [],
  },
};

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

export function takeOpenedLaunchTargets() {
  if (!isNativeTauri()) return Promise.resolve([]);
  return invoke<OpenLaunchRequest[]>("take_opened_launch_targets");
}

export function setWorkspaceRootPath(path: string) {
  if (!isNativeTauri()) {
    return Promise.reject(new Error("Workspace switching is only available in the native Tauri app"));
  }
  return invoke<string>("set_workspace_root", { path });
}

export function recordRecentFile(path: string, singleFile = false) {
  if (!isNativeTauri()) return Promise.resolve();
  return invoke<void>("record_recent_file", { path, singleFile });
}

export function getUiState() {
  if (!isNativeTauri()) return Promise.resolve(defaultUiSnapshot);
  return invoke<PersistedUiSnapshot>("get_ui_state");
}

export function updateUiState(
  view: PersistedViewSettings,
  workspace: WorkspaceUiState,
) {
  if (!isNativeTauri()) return Promise.resolve();
  return invoke<void>("update_ui_state", { view, workspace });
}

export function listFiles(
  showDotfiles = false,
  showGeneratedInternal = false,
  treeScanLimit?: number,
) {
  const params = new URLSearchParams();
  if (showDotfiles) params.set("showDotfiles", "true");
  if (showGeneratedInternal) params.set("showGeneratedInternal", "true");
  if (treeScanLimit !== undefined) params.set("treeScanLimit", String(treeScanLimit));
  const query = params.toString();
  const path = query ? `/api/files?${query}` : "/api/files";
  return callApi<unknown>("list_files", path, {
    invokeArgs: {
      showDotfiles,
      showGeneratedInternal,
      ...(treeScanLimit === undefined ? {} : { treeScanLimit }),
    },
  }).then((entries) => {
    if (!Array.isArray(entries)) {
      throw new Error("Workspace file list response was not valid JSON");
    }
    return entries as FileEntry[];
  });
}

export function listDirectory(
  path: string,
  showDotfiles = false,
  showGeneratedInternal = false,
) {
  const params = new URLSearchParams({ path });
  if (showDotfiles) params.set("showDotfiles", "true");
  if (showGeneratedInternal) params.set("showGeneratedInternal", "true");
  return callApi<unknown>("list_directory", `/api/directory?${params.toString()}`, {
    invokeArgs: { path, showDotfiles, showGeneratedInternal },
  }).then((entries) => {
    if (!Array.isArray(entries)) {
      throw new Error("Workspace directory response was not valid JSON");
    }
    return entries as FileEntry[];
  });
}

export function readFile(path: string, maxOpenBytes?: number) {
  const params = new URLSearchParams({ path });
  if (maxOpenBytes !== undefined) {
    params.set("maxOpenBytes", String(maxOpenBytes));
  }
  return callApi<string>("read_file", `/api/file?${params.toString()}`, {
    method: "GET",
    invokeArgs: {
      path,
      ...(maxOpenBytes === undefined ? {} : { maxOpenBytes }),
    },
  });
}

export function statFile(path: string) {
  return callApi<FileEntry>(
    "stat_file",
    `/api/file-metadata?path=${encodeURIComponent(path)}`,
    {
      method: "GET",
      invokeArgs: { path },
    },
  );
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

export function searchFiles(
  query: string,
  maxResults?: number,
  maxFileBytes?: number,
) {
  const params = new URLSearchParams({ query });
  if (maxResults !== undefined) params.set("maxResults", String(maxResults));
  if (maxFileBytes !== undefined) params.set("maxFileBytes", String(maxFileBytes));
  return callApi<SearchMatch[]>("search_files", `/api/search?${params.toString()}`, {
    method: "GET",
    invokeArgs: {
      query,
      ...(maxResults === undefined ? {} : { maxResults }),
      ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    },
  });
}

export function searchIndexedFiles(
  query: string,
  limit?: number,
  showDotfiles = false,
  showGeneratedInternal = false,
) {
  const params = new URLSearchParams();
  const trimmedQuery = query.trim();
  if (trimmedQuery) params.set("query", trimmedQuery);
  if (limit !== undefined) params.set("limit", String(limit));
  if (showDotfiles) params.set("showDotfiles", "true");
  if (showGeneratedInternal) params.set("showGeneratedInternal", "true");
  const requestPath = params.toString()
    ? `/api/file-search?${params.toString()}`
    : "/api/file-search";
  return callApi<unknown>("search_indexed_files", requestPath, {
    method: "GET",
    invokeArgs: {
      query,
      ...(limit === undefined ? {} : { limit }),
      showDotfiles,
      showGeneratedInternal,
    },
  }).then((entries) => {
    if (!Array.isArray(entries)) {
      throw new Error("Indexed file search response was not valid JSON");
    }
    return entries as FileEntry[];
  });
}

export function pickWorkspaceFolder() {
  if (!isNativeTauri()) {
    return Promise.reject(new Error("Folder picker is only available in the native Tauri app"));
  }
  return invoke<string | undefined>("pick_workspace_folder");
}

export function pickOpenFile() {
  if (!isNativeTauri()) {
    return Promise.reject(new Error("File picker is only available in the native Tauri app"));
  }
  return invoke<OpenFileRequest | undefined>("pick_open_file");
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
  return callApi<unknown>("get_codex_mcp_status", "/api/codex-mcp").then((status) => {
    if (
      status &&
      typeof status === "object" &&
      "endpoint" in status &&
      "bearerToken" in status &&
      typeof status.endpoint === "string" &&
      typeof status.bearerToken === "string"
    ) {
      return status as CodexMcpStatus;
    }
    return undefined;
  });
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

  const authenticatedWrite = isAuthenticatedWrite(options.method);
  const response = await fetchHostedApi(path, options, authenticatedWrite);
  if (authenticatedWrite && (response.status === 401 || response.status === 403)) {
    localBearerToken = undefined;
    return readApiResponse<T>(
      await fetchHostedApi(path, options, true),
    );
  }

  return readApiResponse<T>(response);
}

async function fetchHostedApi(
  path: string,
  options: ApiOptions,
  authenticatedWrite: boolean,
) {
  const headers = new Headers();
  if (options.body) {
    headers.set("Content-Type", "application/json");
  }
  if (authenticatedWrite) {
    headers.set("Authorization", `Bearer ${await localWriteToken()}`);
  }

  return fetch(`${httpBase()}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function readApiResponse<T>(response: Response): Promise<T> {

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

function isAuthenticatedWrite(method: ApiOptions["method"]) {
  return method === "DELETE" || method === "PATCH" || method === "POST" || method === "PUT";
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
