import { invoke } from "@tauri-apps/api/core";
import {
  defaultDateTimeFormat,
  defaultRecentRelativeThreshold,
  type DateTimeFormatId,
  type RecentRelativeThresholdId,
} from "./dateTimeFormat";

export interface FileEntry {
  path: string;
  name: string;
  parent?: string;
  isDir: boolean;
  depth: number;
  size: number;
  modifiedMs?: number;
  isSymlink?: boolean;
  isExternal?: boolean;
  symlinkTarget?: string;
}

export interface FileListResult {
  entries: FileEntry[];
  truncated: boolean;
  limit: number;
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

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  limit: number;
  searchedFiles?: number;
  skippedFiles?: number;
}

export type GitAttributionStatus = "available" | "unsupported";

export interface GitCommitAction {
  provider: string;
  remoteName: string;
  label: string;
  url: string;
}

export interface GitCommitInfo {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail?: string;
  authoredAtSeconds?: number;
  summary: string;
  actions: GitCommitAction[];
}

export interface GitLineAttribution {
  lineNumber: number;
  commit: GitCommitInfo;
}

export interface GitAttribution {
  path: string;
  status: GitAttributionStatus;
  unsupportedReason?: string;
  file?: GitCommitInfo;
  lines: GitLineAttribution[];
  uncommittedLines?: number[];
}

export type GitStatusAvailability = "available" | "unsupported";

export type GitFileStatus = "added" | "modified" | "deleted";

export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatus {
  status: GitStatusAvailability;
  unsupportedReason?: string;
  branch?: string;
  headDetached: boolean;
  headUnborn: boolean;
  files: GitStatusEntry[];
}

export interface GitCommitResult {
  sha: string;
  shortSha: string;
  branch?: string;
  committedPaths: string[];
}

export interface GitFileDiff {
  original: string;
  modified: string;
  status: GitFileStatus;
  isBinary: boolean;
  isTooLarge: boolean;
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

export type DiffViewMode = "inline" | "sideBySide";

export const defaultDiffViewMode: DiffViewMode = "inline";

export function sanitizeDiffViewMode(value: unknown): DiffViewMode {
  return value === "inline" || value === "sideBySide" ? value : defaultDiffViewMode;
}

export interface PersistedViewSettings {
  showDotfiles: boolean;
  showGeneratedInternal: boolean;
  showGitignoredFiles?: boolean;
  showDiagnosticsPanel?: boolean;
  trackActiveFile?: boolean;
  treeScanLimit?: number;
  maxOpenFileKb?: number;
  workspaceSearchResultLimit?: number;
  workspaceSearchMaxFileKb?: number;
  currentFileSearchResultLimit?: number;
  currentFileResultPreviewLimit?: number;
  quickOpenResultLimit?: number;
  backgroundIndexBatchEntries?: number;
  workspaceTitleMaxChars?: number;
  commandPaletteResultLimit?: number;
  editorFontSize?: number;
  appZoomPercent?: number;
  dateTimeFormat?: DateTimeFormatId;
  recentRelativeThreshold?: RecentRelativeThresholdId;
  diffViewMode?: DiffViewMode;
  // Persisted feature-flag overrides only; defaults live in src/featureFlags.ts.
  featureFlags?: Record<string, boolean>;
}

export interface WorkspaceUiState {
  expandedFolders: string[];
  openFiles: string[];
  activeFile?: string;
  selectedPath?: string;
  sidebarWidth?: number;
  commitMessageHeight?: number;
  trustExternalSymlinks?: boolean;
}

export interface PersistedUiSnapshot {
  view: PersistedViewSettings;
  workspace: WorkspaceUiState;
}

export interface SettingsLocations {
  settingsFile?: string;
  recentsFile?: string;
  workspaceIndexFile?: string;
}

export interface WorkspaceDisplayContext {
  appTitle: string;
  workspaceLabel: string;
  fullLabel: string;
  gitRoot?: string;
}

export interface AppInfo {
  name: string;
  version: string;
  description: string;
  authors: string[];
  repository: string;
}

export interface WorkspaceIndexStats {
  indexedEntries: number;
  indexedFiles: number;
  indexedFolders: number;
  loadedFolders: number;
  pendingFolders: number;
}

const defaultUiSnapshot: PersistedUiSnapshot = {
  view: {
    showDotfiles: false,
    showGeneratedInternal: false,
    showGitignoredFiles: false,
    showDiagnosticsPanel: false,
    trackActiveFile: true,
    treeScanLimit: 10000,
    maxOpenFileKb: 5120,
    workspaceSearchResultLimit: 200,
    workspaceSearchMaxFileKb: 1024,
    currentFileSearchResultLimit: 200,
    currentFileResultPreviewLimit: 12,
    quickOpenResultLimit: 12,
    backgroundIndexBatchEntries: 2000,
    workspaceTitleMaxChars: 50,
    commandPaletteResultLimit: 18,
    editorFontSize: 13,
    appZoomPercent: 100,
    dateTimeFormat: defaultDateTimeFormat,
    recentRelativeThreshold: defaultRecentRelativeThreshold,
    diffViewMode: defaultDiffViewMode,
    featureFlags: {},
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

export function getAppInfo() {
  if (!isNativeTauri()) {
    return Promise.resolve<AppInfo>({
      name: "ide",
      version: "dev",
      description: "A lean local IDE.",
      authors: ["Gordon Beeming"],
      repository: "https://github.com/gordonbeeming/ide",
    });
  }

  return invoke<AppInfo>("get_app_info");
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

export function getSettingsLocations() {
  if (!isNativeTauri()) {
    return Promise.resolve<SettingsLocations>({});
  }

  return invoke<SettingsLocations>("get_settings_locations");
}

export function getWorkspaceDisplayContext(titleMaxChars?: number) {
  const params = new URLSearchParams();
  if (titleMaxChars !== undefined) params.set("titleMaxChars", String(titleMaxChars));
  const path = params.toString()
    ? `/api/workspace-display?${params.toString()}`
    : "/api/workspace-display";
  return callApi<WorkspaceDisplayContext>("get_workspace_display_context", path, {
    invokeArgs: {
      ...(titleMaxChars === undefined ? {} : { titleMaxChars }),
    },
  });
}

export function getWorkspaceIndexStats() {
  return callApi<unknown>("get_workspace_index_stats", "/api/workspace-index").then(
    (value) => {
      const stats = normalizeWorkspaceIndexStats(value);
      if (!stats) {
        throw new Error("Workspace index stats response was not valid JSON");
      }
      return stats;
    },
  );
}

export function advanceWorkspaceIndex(
  entryLimit?: number,
  showDotfiles = false,
  showGeneratedInternal = false,
  showGitignoredFiles = false,
) {
  const params = new URLSearchParams();
  if (entryLimit !== undefined) params.set("entryLimit", String(entryLimit));
  if (showDotfiles) params.set("showDotfiles", "true");
  if (showGeneratedInternal) params.set("showGeneratedInternal", "true");
  if (showGitignoredFiles) params.set("showGitignoredFiles", "true");
  const path = params.toString()
    ? `/api/workspace-index/advance?${params.toString()}`
    : "/api/workspace-index/advance";
  return callApi<unknown>("advance_workspace_index", path, {
    method: "POST",
    invokeArgs: {
      ...(entryLimit === undefined ? {} : { entryLimit }),
      showDotfiles,
      showGeneratedInternal,
      showGitignoredFiles,
    },
  }).then((value) => {
    const stats = normalizeWorkspaceIndexStats(value);
    if (!stats) {
      throw new Error("Workspace index advance response was not valid JSON");
    }
    return stats;
  });
}

export function normalizeWorkspaceIndexStats(
  value: unknown,
): WorkspaceIndexStats | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const indexedEntries = numericStat(candidate.indexedEntries);
  const indexedFiles = numericStat(candidate.indexedFiles);
  const indexedFolders = numericStat(candidate.indexedFolders);
  const loadedFolders = numericStat(candidate.loadedFolders);
  const pendingFolders = numericStat(candidate.pendingFolders);
  if (
    indexedEntries === undefined ||
    indexedFiles === undefined ||
    indexedFolders === undefined ||
    loadedFolders === undefined ||
    pendingFolders === undefined
  ) {
    return undefined;
  }
  return {
    indexedEntries,
    indexedFiles,
    indexedFolders,
    loadedFolders,
    pendingFolders,
  };
}

function numericStat(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
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
  showGitignoredFiles = false,
) {
  const params = new URLSearchParams();
  if (showDotfiles) params.set("showDotfiles", "true");
  if (showGeneratedInternal) params.set("showGeneratedInternal", "true");
  if (showGitignoredFiles) params.set("showGitignoredFiles", "true");
  if (treeScanLimit !== undefined) params.set("treeScanLimit", String(treeScanLimit));
  const query = params.toString();
  const path = query ? `/api/files?${query}` : "/api/files";
  return callApi<unknown>("list_files", path, {
    invokeArgs: {
      showDotfiles,
      showGeneratedInternal,
      showGitignoredFiles,
      ...(treeScanLimit === undefined ? {} : { treeScanLimit }),
    },
  }).then((entries) => {
    const result = normalizeFileListResult(entries);
    if (!result) {
      throw new Error("Workspace file list response was not valid JSON");
    }
    return result;
  });
}

export function normalizeFileListResult(value: unknown): FileListResult | undefined {
  if (Array.isArray(value)) {
    return {
      entries: value as FileEntry[],
      truncated: false,
      limit: value.length,
    };
  }

  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { entries?: unknown }).entries)
  ) {
    const candidate = value as {
      entries: FileEntry[];
      truncated?: unknown;
      limit?: unknown;
    };
    return {
      entries: candidate.entries,
      truncated: candidate.truncated === true,
      limit: typeof candidate.limit === "number" ? candidate.limit : candidate.entries.length,
    };
  }

  return undefined;
}

export function listDirectory(
  path: string,
  showDotfiles = false,
  showGeneratedInternal = false,
  showGitignoredFiles = false,
  allowExternalSymlinks = false,
) {
  const params = new URLSearchParams({ path });
  if (showDotfiles) params.set("showDotfiles", "true");
  if (showGeneratedInternal) params.set("showGeneratedInternal", "true");
  if (showGitignoredFiles) params.set("showGitignoredFiles", "true");
  return callApi<unknown>("list_directory", `/api/directory?${params.toString()}`, {
    invokeArgs: {
      path,
      showDotfiles,
      showGeneratedInternal,
      showGitignoredFiles,
      allowExternalSymlinks,
    },
  }).then((entries) => {
    if (!Array.isArray(entries)) {
      throw new Error("Workspace directory response was not valid JSON");
    }
    return entries as FileEntry[];
  });
}

export function readFile(
  path: string,
  maxOpenBytes?: number,
  allowExternalSymlinks = false,
) {
  const params = new URLSearchParams({ path });
  if (maxOpenBytes !== undefined) {
    params.set("maxOpenBytes", String(maxOpenBytes));
  }
  return callApi<string>("read_file", `/api/file?${params.toString()}`, {
    method: "GET",
    invokeArgs: {
      path,
      ...(maxOpenBytes === undefined ? {} : { maxOpenBytes }),
      allowExternalSymlinks,
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

export function getGitAttribution(path: string) {
  return callApi<unknown>(
    "get_git_attribution",
    `/api/git-attribution?path=${encodeURIComponent(path)}`,
    {
      method: "GET",
      invokeArgs: { path },
    },
  ).then((value) => {
    const normalized = normalizeGitAttribution(value);
    if (!normalized) {
      throw new Error("Git attribution response was not valid JSON");
    }
    return normalized;
  });
}

export function writeFile(
  path: string,
  contents: string,
  expectedModifiedMs?: number,
  allowExternalSymlinks = false,
) {
  return callApi<void>("write_file", "/api/file", {
    method: "PUT",
    body: { path, contents, expectedModifiedMs },
    invokeArgs: { path, contents, expectedModifiedMs, allowExternalSymlinks },
  });
}

export function getGitStatus() {
  return callApi<unknown>("get_git_status", "/api/git-status").then((value) => {
    const normalized = normalizeGitStatus(value);
    if (!normalized) {
      throw new Error("Git status response had an unexpected shape");
    }
    return normalized;
  });
}

export function commitGitChanges(message: string, paths: string[]) {
  return callApi<unknown>("git_commit", "/api/git-commit", {
    method: "POST",
    body: { message, paths },
    invokeArgs: { message, paths },
  }).then((value) => {
    const normalized = normalizeGitCommitResult(value);
    if (!normalized) {
      throw new Error("Git commit response had an unexpected shape");
    }
    return normalized;
  });
}

export function loadGitFileDiff(path: string, maxOpenBytes?: number) {
  const params = new URLSearchParams({ path });
  if (maxOpenBytes !== undefined) {
    params.set("maxOpenBytes", String(maxOpenBytes));
  }
  return callApi<unknown>("git_file_diff", `/api/git-file-diff?${params.toString()}`, {
    method: "GET",
    invokeArgs: {
      path,
      ...(maxOpenBytes === undefined ? {} : { maxOpenBytes }),
    },
  }).then((value) => {
    const normalized = normalizeGitFileDiff(value);
    if (!normalized) {
      throw new Error("Git file diff response had an unexpected shape");
    }
    return normalized;
  });
}

export function normalizeGitStatus(value: unknown): GitStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "available" && candidate.status !== "unsupported") {
    return undefined;
  }
  if (
    typeof candidate.headDetached !== "boolean" ||
    typeof candidate.headUnborn !== "boolean" ||
    !Array.isArray(candidate.files)
  ) {
    return undefined;
  }

  const files = candidate.files
    .map(normalizeGitStatusEntry)
    .filter((entry): entry is GitStatusEntry => Boolean(entry));
  if (files.length !== candidate.files.length) return undefined;

  return {
    status: candidate.status,
    unsupportedReason:
      typeof candidate.unsupportedReason === "string"
        ? candidate.unsupportedReason
        : undefined,
    branch: typeof candidate.branch === "string" ? candidate.branch : undefined,
    headDetached: candidate.headDetached,
    headUnborn: candidate.headUnborn,
    files,
  };
}

function isGitFileStatus(value: unknown): value is GitFileStatus {
  return value === "added" || value === "modified" || value === "deleted";
}

function normalizeGitStatusEntry(value: unknown): GitStatusEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.path !== "string" ||
    !isGitFileStatus(candidate.status) ||
    typeof candidate.staged !== "boolean" ||
    typeof candidate.unstaged !== "boolean"
  ) {
    return undefined;
  }
  return {
    path: candidate.path,
    status: candidate.status,
    staged: candidate.staged,
    unstaged: candidate.unstaged,
  };
}

export function normalizeGitFileDiff(value: unknown): GitFileDiff | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.original !== "string" ||
    typeof candidate.modified !== "string" ||
    !isGitFileStatus(candidate.status) ||
    typeof candidate.isBinary !== "boolean" ||
    typeof candidate.isTooLarge !== "boolean"
  ) {
    return undefined;
  }
  return {
    original: candidate.original,
    modified: candidate.modified,
    status: candidate.status,
    isBinary: candidate.isBinary,
    isTooLarge: candidate.isTooLarge,
  };
}

export function normalizeGitCommitResult(value: unknown): GitCommitResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sha !== "string" ||
    typeof candidate.shortSha !== "string" ||
    !Array.isArray(candidate.committedPaths) ||
    !candidate.committedPaths.every((path): path is string => typeof path === "string")
  ) {
    return undefined;
  }
  return {
    sha: candidate.sha,
    shortSha: candidate.shortSha,
    branch: typeof candidate.branch === "string" ? candidate.branch : undefined,
    committedPaths: candidate.committedPaths,
  };
}

export function normalizeGitAttribution(value: unknown): GitAttribution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.path !== "string") return undefined;
  if (candidate.status !== "available" && candidate.status !== "unsupported") {
    return undefined;
  }
  if (!Array.isArray(candidate.lines)) return undefined;

  const lines = candidate.lines
    .map(normalizeGitLineAttribution)
    .filter((line): line is GitLineAttribution => Boolean(line));
  if (lines.length !== candidate.lines.length) return undefined;
  const uncommittedLines =
    candidate.uncommittedLines === undefined
      ? []
      : normalizeGitLineNumbers(candidate.uncommittedLines);
  if (!uncommittedLines) return undefined;

  const file =
    candidate.file === undefined || candidate.file === null
      ? undefined
      : normalizeGitCommitInfo(candidate.file);
  if (candidate.file !== undefined && candidate.file !== null && !file) {
    return undefined;
  }

  return {
    path: candidate.path,
    status: candidate.status,
    unsupportedReason:
      typeof candidate.unsupportedReason === "string"
        ? candidate.unsupportedReason
        : undefined,
    file,
    lines,
    uncommittedLines,
  };
}

function normalizeGitLineNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lineNumbers = value.filter(
    (lineNumber): lineNumber is number =>
      Number.isInteger(lineNumber) && lineNumber >= 1,
  );
  return lineNumbers.length === value.length ? lineNumbers : undefined;
}

function normalizeGitLineAttribution(value: unknown): GitLineAttribution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.lineNumber) || (candidate.lineNumber as number) < 1) {
    return undefined;
  }
  const commit = normalizeGitCommitInfo(candidate.commit);
  if (!commit) return undefined;
  return {
    lineNumber: candidate.lineNumber as number,
    commit,
  };
}

function normalizeGitCommitInfo(value: unknown): GitCommitInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sha !== "string" ||
    typeof candidate.shortSha !== "string" ||
    typeof candidate.authorName !== "string" ||
    typeof candidate.summary !== "string" ||
    !Array.isArray(candidate.actions)
  ) {
    return undefined;
  }
  if (
    candidate.authoredAtSeconds !== undefined &&
    candidate.authoredAtSeconds !== null &&
    typeof candidate.authoredAtSeconds !== "number"
  ) {
    return undefined;
  }

  const actions = candidate.actions
    .map(normalizeGitCommitAction)
    .filter((action): action is GitCommitAction => Boolean(action));
  if (actions.length !== candidate.actions.length) return undefined;

  return {
    sha: candidate.sha,
    shortSha: candidate.shortSha,
    authorName: candidate.authorName,
    authorEmail:
      typeof candidate.authorEmail === "string" ? candidate.authorEmail : undefined,
    authoredAtSeconds:
      typeof candidate.authoredAtSeconds === "number"
        ? candidate.authoredAtSeconds
        : undefined,
    summary: candidate.summary,
    actions,
  };
}

function normalizeGitCommitAction(value: unknown): GitCommitAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.provider !== "string" ||
    typeof candidate.remoteName !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.url !== "string"
  ) {
    return undefined;
  }
  return {
    provider: candidate.provider,
    remoteName: candidate.remoteName,
    label: candidate.label,
    url: candidate.url,
  };
}

export function createFile(path: string, allowExternalSymlinks = false) {
  return callApi<void>("create_file", "/api/file", {
    method: "POST",
    body: { path, contents: "" },
    invokeArgs: { path, allowExternalSymlinks },
  });
}

export function createFolder(path: string, allowExternalSymlinks = false) {
  return callApi<void>("create_folder", "/api/folder", {
    method: "POST",
    body: { path },
    invokeArgs: { path, allowExternalSymlinks },
  });
}

export function renameFile(
  fromPath: string,
  toPath: string,
  allowExternalSymlinks = false,
) {
  return callApi<void>("rename_file", "/api/file", {
    method: "PATCH",
    body: { fromPath, toPath },
    invokeArgs: { fromPath, toPath, allowExternalSymlinks },
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
  showDotfiles?: boolean,
) {
  const params = new URLSearchParams({ query });
  if (maxResults !== undefined) params.set("maxResults", String(maxResults));
  if (maxFileBytes !== undefined) params.set("maxFileBytes", String(maxFileBytes));
  if (showDotfiles !== undefined) params.set("showDotfiles", String(showDotfiles));
  return callApi<unknown>("search_files", `/api/search?${params.toString()}`, {
    method: "GET",
    invokeArgs: {
      query,
      ...(maxResults === undefined ? {} : { maxResults }),
      ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
      ...(showDotfiles === undefined ? {} : { showDotfiles }),
    },
  }).then((result) => {
    const normalized = normalizeSearchResult(result);
    if (!normalized) {
      throw new Error("Workspace search response was not valid JSON");
    }
    return normalized;
  });
}

export function normalizeSearchResult(value: unknown): SearchResult | undefined {
  if (Array.isArray(value)) {
    return {
      matches: value as SearchMatch[],
      truncated: false,
      limit: value.length,
      searchedFiles: undefined,
      skippedFiles: undefined,
    };
  }

  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { matches?: unknown }).matches)
  ) {
    const candidate = value as {
      matches: SearchMatch[];
      truncated?: unknown;
      limit?: unknown;
      searchedFiles?: unknown;
      skippedFiles?: unknown;
    };
    return {
      matches: candidate.matches,
      truncated: candidate.truncated === true,
      limit: typeof candidate.limit === "number" ? candidate.limit : candidate.matches.length,
      searchedFiles:
        typeof candidate.searchedFiles === "number" ? candidate.searchedFiles : undefined,
      skippedFiles:
        typeof candidate.skippedFiles === "number" ? candidate.skippedFiles : undefined,
    };
  }

  return undefined;
}

export function searchIndexedFiles(
  query: string,
  limit?: number,
  showDotfiles = false,
  showGeneratedInternal = false,
  showGitignoredFiles = false,
) {
  const params = new URLSearchParams();
  const trimmedQuery = query.trim();
  if (trimmedQuery) params.set("query", trimmedQuery);
  if (limit !== undefined) params.set("limit", String(limit));
  if (showDotfiles) params.set("showDotfiles", "true");
  if (showGeneratedInternal) params.set("showGeneratedInternal", "true");
  if (showGitignoredFiles) params.set("showGitignoredFiles", "true");
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
      showGitignoredFiles,
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

  return fetch(`${httpBase()}${workspacePathPrefix(window.location)}${path}`, {
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

// When the IDE is served over HTTP at `/{hash}/`, every API call has to carry that
// same prefix so the server can route it to the right open workspace. The Vite dev
// server (port 1420) proxies to a single shared workspace and has no hash, so it
// returns "". The native Tauri app never reaches this path (it uses invoke()).
export function workspacePathPrefix(
  location: Pick<Location, "pathname" | "port">,
): string {
  if (location.port === "1420") {
    return "";
  }
  const segment = location.pathname.split("/").find((part) => part.length > 0);
  return segment ? `/${segment}` : "";
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
