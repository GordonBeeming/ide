import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  ChevronRight,
  Circle,
  Copy,
  ExternalLink,
  FileInput,
  Link2,
  FilePlus,
  FileCog,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  ListOrdered,
  ListFilter,
  Loader,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  Replace,
  RotateCcw,
  Save,
  SaveAll,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  diagnosticKey,
  diagnosticLocationLabel,
  diagnosticSeverityLabel,
  sortDiagnostics,
} from "./diagnostics";
import {
  dateTimeFormatOptions,
  defaultDateTimeFormat,
  defaultRecentRelativeThreshold,
  formatDateTime,
  formatDateTimeAbsolute,
  recentRelativeThresholdOptions,
  sanitizeDateTimeFormat,
  sanitizeRecentRelativeThreshold,
  type DateTimeFormatId,
  type RecentRelativeThresholdId,
} from "./dateTimeFormat";
import {
  currentFileMatches,
  currentFileResultWindow,
  nextCurrentFileMatchIndex,
} from "./currentFileSearch";
import { iconForFile, isKnownBinaryFile } from "./fileTypes";
import {
  type FeatureFlagOverrides,
  isFeatureEnabled,
  previewFeatureFlags,
  sanitizeFeatureFlagOverrides,
} from "./featureFlags";
import { codexMcpConfigSnippet } from "./integrations";
import {
  applyDocumentTheme,
  appShellClass,
  editorRegionClass,
  sidebarToggleTitle,
} from "./layout";
import {
  clampQuickOpenSelection,
  moveQuickOpenSelection,
  quickOpenMatches,
} from "./quickOpen";
import {
  clampCommandPaletteSelection,
  commandPaletteMatches,
  moveCommandPaletteSelection,
  type CommandPaletteEntry,
} from "./commandPalette";
import { destroyNativeWindow, onNativeWindowCloseRequested, setNativeWindowTitle } from "./appWindow";
import {
  AgentContext,
  AppInfo,
  ClaudeBridgeStatus,
  CodexMcpStatus,
  EditorDiagnostic,
  EditorSelection,
  FileEntry,
  LspServerStatus,
  SearchMatch,
  advanceWorkspaceIndex,
  commitGitChanges,
  createFile,
  createFolder,
  deleteFile,
  getClaudeBridgeStatus,
  getCodexMcpStatus,
  getGitAttribution,
  getGitStatus,
  getHttpEndpoint,
  getInitialFile,
  getAppInfo,
  getLspServers,
  getSettingsLocations,
  getUiState,
  getWorkspaceDisplayContext,
  getWorkspaceIndexStats,
  getWorkspaceRoot,
  isNativeTauri,
  listDirectory,
  listFiles,
  loadGitFileDiff,
  normalizeFileListResult,
  normalizeSearchResult,
  pickOpenFile,
  pickWorkspaceFolder,
  readFile,
  recordRecentFile,
  renameFile,
  sanitizeDiffViewMode,
  searchIndexedFiles,
  searchFiles,
  setWorkspaceRootPath,
  statFile,
  stageResolvedFile,
  syncGit,
  completeMerge,
  takeOpenedLaunchTargets,
  updateAgentContext,
  updateUiState,
  writeFile,
  defaultDiffViewMode,
  type DiffViewMode,
  type OpenLaunchRequest,
  type PersistedUiSnapshot,
  type SettingsLocations,
  type GitAttribution,
  type GitCommitInfo,
  type GitStatus,
  type GitStatusEntry,
  type GitSyncResult,
  type WorkspaceIndexStats,
  type WorkspaceDisplayContext,
  type WorkspaceUiState,
} from "./tauri";
import {
  setLspDiagnosticsHandler,
  setLspErrorHandler,
  setLspRootUri,
  setLspStatusHandler,
  workspacePathToFileUri,
} from "./lsp";
import { unlistenNativeCallbacks, type NativeUnlisten } from "./nativeEvents";
import { darkSchemeQuery, systemPrefersDark } from "./systemTheme";
import {
  addPreviewTab,
  adjacentTabPath,
  dirtyTabSummary,
  nextActivePathAfterClose,
  pinTab,
  tabCloseRequiresConfirmation,
  updateTabContents,
  type EditorTab,
  type EditorTabDiff,
} from "./tabs";
import {
  editorCommandLabel,
  type EditorCommandName,
  type EditorCommandRequest,
  type EditorReplacePayload,
} from "./editorCommands";
import { cursorStatus, type EditorCursor } from "./editorCursor";

const EditorPane = lazy(() => import("./EditorPane"));
const DiffPane = lazy(() => import("./DiffPane"));

const fallbackAppInfo: AppInfo = {
  name: "ide",
  version: "dev",
  description: "A lean local IDE.",
  authors: ["Gordon Beeming"],
  repository: "https://github.com/gordonbeeming/ide",
};

interface AppCommand extends CommandPaletteEntry {
  detail: string;
  enabled: boolean;
  run: () => void;
}

interface TreeNode extends FileEntry {
  children: TreeNode[];
}

interface RevealTarget {
  path: string;
  lineNumber: number;
  preserveFocus?: boolean;
  // Column offsets (0-based, within lineNumber) of a find match to select on reveal.
  matchStart?: number;
  matchEnd?: number;
}

interface PendingReloadRequest {
  path: string;
  reason: "manual" | "external";
  diskModifiedMs?: number;
}

interface OpenFailure {
  path: string;
  reason: string;
}

type SidebarPanelMode = "filter" | "content" | "commit";
type SettingsCategory =
  | "view"
  | "performance"
  | "search"
  | "preview"
  | "storage";

const settingsCategories: Array<{
  id: SettingsCategory;
  title: string;
  detail: string;
}> = [
  { id: "view", title: "View", detail: "Tree visibility" },
  { id: "performance", title: "Performance", detail: "Scan, file, and palette caps" },
  { id: "search", title: "Search", detail: "Search result and file caps" },
  { id: "preview", title: "Preview Features", detail: "Opt into in-progress features" },
  { id: "storage", title: "Storage", detail: "Settings and index files" },
];

type KeyBindingCategory = "File" | "Search" | "Navigate" | "View" | "Tabs" | "Tree" | "Dialogs";

interface KeyBindingInfo {
  category: KeyBindingCategory;
  command: string;
  shortcut: PlatformShortcut;
  when?: string;
}

interface PlatformShortcut {
  mac: string;
  other: string;
}

const keyBindings: KeyBindingInfo[] = [
  { category: "File", command: "New File", shortcut: { mac: "Ctrl+Alt+N", other: "Ctrl+Alt+Insert" } },
  { category: "File", command: "Save All", shortcut: { mac: "Cmd+S", other: "Ctrl+S" } },
  { category: "File", command: "Synchronize from Disk", shortcut: { mac: "Cmd+Alt+Y", other: "Ctrl+Alt+Y" } },
  { category: "File", command: "Rename Selected", shortcut: { mac: "Shift+F6", other: "Shift+F6" } },
  { category: "File", command: "Close Tab", shortcut: { mac: "Cmd+W", other: "Ctrl+F4" } },
  { category: "File", command: "Close All", shortcut: { mac: "Cmd+Shift+W", other: "Ctrl+Shift+F4" } },
  { category: "Search", command: "Command Palette", shortcut: { mac: "Cmd+Shift+A", other: "Ctrl+Shift+A" } },
  { category: "Search", command: "Go to File", shortcut: { mac: "Cmd+Shift+O", other: "Ctrl+Shift+N" } },
  { category: "Search", command: "Go to Line", shortcut: { mac: "Cmd+L", other: "Ctrl+G" } },
  { category: "Search", command: "Find in File", shortcut: { mac: "Cmd+F", other: "Ctrl+F" } },
  { category: "Search", command: "Find in Files", shortcut: { mac: "Cmd+Shift+F", other: "Ctrl+Shift+F" } },
  { category: "Navigate", command: "Go to Definition", shortcut: { mac: "Cmd+B", other: "Ctrl+B" } },
  { category: "Navigate", command: "Find References", shortcut: { mac: "Alt+F7", other: "Alt+F7" } },
  { category: "View", command: "Show Project", shortcut: { mac: "Cmd+1", other: "Alt+1" } },
  { category: "View", command: "Settings", shortcut: { mac: "Cmd+,", other: "Ctrl+Alt+S" } },
  { category: "View", command: "Zoom Editor In", shortcut: { mac: "Cmd+=", other: "Ctrl+=" } },
  { category: "View", command: "Zoom Editor Out", shortcut: { mac: "Cmd+-", other: "Ctrl+-" } },
  { category: "View", command: "Zoom App In", shortcut: { mac: "Cmd+Shift+=", other: "Ctrl+Shift+=" } },
  { category: "View", command: "Zoom App Out", shortcut: { mac: "Cmd+Shift+-", other: "Ctrl+Shift+-" } },
  { category: "Tabs", command: "Next tab", shortcut: { mac: "Cmd+Shift+]", other: "Alt+Right" } },
  { category: "Tabs", command: "Previous tab", shortcut: { mac: "Cmd+Shift+[", other: "Alt+Left" } },
  { category: "Tree", command: "Open selected file or toggle folder", shortcut: { mac: "Enter", other: "Enter" } },
  { category: "Tree", command: "Toggle selected folder", shortcut: { mac: "Space", other: "Space" } },
  { category: "Tree", command: "Expand selected folder", shortcut: { mac: "ArrowRight", other: "ArrowRight" } },
  { category: "Tree", command: "Collapse selected folder", shortcut: { mac: "ArrowLeft", other: "ArrowLeft" } },
  { category: "Dialogs", command: "Close active dialog or palette", shortcut: { mac: "Escape", other: "Escape" } },
  { category: "Dialogs", command: "Move selection", shortcut: { mac: "ArrowUp / ArrowDown", other: "ArrowUp / ArrowDown" }, when: "Quick open and command palette" },
  { category: "Dialogs", command: "Run selected item", shortcut: { mac: "Enter", other: "Enter" }, when: "Quick open and command palette" },
  { category: "Dialogs", command: "Next find result", shortcut: { mac: "Enter", other: "Enter" }, when: "Find in file" },
  { category: "Dialogs", command: "Previous find result", shortcut: { mac: "Shift+Enter", other: "Shift+Enter" }, when: "Find in file" },
];

const minTreeScanLimit = 500;
const maxTreeScanLimit = 100000;
const defaultTreeScanLimit = 10000;
const minMaxOpenFileKb = 64;
const maxMaxOpenFileKb = 65536;
const defaultMaxOpenFileKb = 5120;
const minWorkspaceSearchResultLimit = 25;
const maxWorkspaceSearchResultLimit = 5000;
const defaultWorkspaceSearchResultLimit = 200;
const minWorkspaceSearchMaxFileKb = 64;
const maxWorkspaceSearchMaxFileKb = 16384;
const defaultWorkspaceSearchMaxFileKb = 1024;
const minCurrentFileSearchResultLimit = 25;
const maxCurrentFileSearchResultLimit = 5000;
const defaultCurrentFileSearchResultLimit = 200;
const minCurrentFileResultPreviewLimit = 3;
const maxCurrentFileResultPreviewLimit = 100;
const defaultCurrentFileResultPreviewLimit = 12;
// Upper bound on matches a single Replace All rewrites — high enough to cover any
// realistic file, low enough to keep the array and the CodeMirror transaction sane.
const replaceAllMatchLimit = 100000;
const minQuickOpenResultLimit = 5;
const maxQuickOpenResultLimit = 100;
const defaultQuickOpenResultLimit = 12;
const openFileDiskCheckIntervalMs = 1500;
const minBackgroundIndexBatchEntries = 100;
const maxBackgroundIndexBatchEntries = 20000;
const defaultBackgroundIndexBatchEntries = 2000;
const minWorkspaceTitleMaxChars = 20;
const maxWorkspaceTitleMaxChars = 120;
const defaultWorkspaceTitleMaxChars = 50;
const minCommandPaletteResultLimit = 5;
const maxCommandPaletteResultLimit = 100;
const defaultCommandPaletteResultLimit = 18;
const minEditorFontSize = 1;
const defaultEditorFontSize = 13;
const editorFontSizeStep = 1;
const minAppZoomPercent = 10;
const defaultAppZoomPercent = 100;
const appZoomStepPercent = 10;
const minSidebarWidth = 180;
const maxSidebarWidth = 1040;
const defaultSidebarWidth = 288;
const sidebarWidthStep = 16;
const minCommitMessageHeight = 56;
const maxCommitMessageHeight = 600;
const defaultCommitMessageHeight = 112;
const commitMessageHeightStep = 16;

function sanitizeNumberLimit(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
) {
  if (!Number.isFinite(value)) return fallback;
  const finiteValue = value as number;
  return Math.min(max, Math.max(min, Math.trunc(finiteValue)));
}

function sanitizeNumberMinimum(value: number | undefined, min: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  const finiteValue = value as number;
  return Math.max(min, Math.trunc(finiteValue));
}

function sanitizeTreeScanLimit(value: number | undefined) {
  return sanitizeNumberLimit(
    value,
    minTreeScanLimit,
    maxTreeScanLimit,
    defaultTreeScanLimit,
  );
}

function fileEntryForDirectOpen(path: string): FileEntry {
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  return {
    path,
    name,
    isDir: false,
    depth: Math.max(0, path.split("/").length - 1),
    size: 0,
  };
}

function pathIsAtOrInside(path: string, candidateRoot: string) {
  return path === candidateRoot || path.startsWith(`${candidateRoot}/`);
}

function renamePathPrefix(path: string, fromPath: string, toPath: string) {
  if (path === fromPath) return toPath;
  return path.startsWith(`${fromPath}/`)
    ? `${toPath}${path.slice(fromPath.length)}`
    : path;
}

function documentLineCount(contents: string) {
  return Math.max(contents.split(/\r\n|\r|\n/).length, 1);
}

function positiveWholeNumber(value: string) {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// One-line summary of a non-conflict sync outcome for the commit panel's sync
// footer. The mergeConflict outcome renders its own file list, so it never
// reaches here.
function formatGitSyncResult(result: GitSyncResult): string {
  switch (result.outcome) {
    case "upToDate":
      return `${result.branch} is already up to date`;
    case "synced": {
      const parts: string[] = [];
      if (result.pulled > 0) parts.push(`pulled ${result.pulled}`);
      if (result.pushed > 0) parts.push(`pushed ${result.pushed}`);
      const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      return `Synced ${result.branch}${detail}`;
    }
    case "noUpstream":
      return `No upstream configured for ${result.branch}`;
    case "mergeConflict":
      return `Merge conflicts on ${result.branch}`;
  }
}

function emptyEditorStateForSelection(
  selectedEntry: FileEntry | undefined,
  openFailure: OpenFailure | undefined,
) {
  if (!selectedEntry || selectedEntry.isDir) {
    return {
      title: "No file selected",
      detail: undefined,
    };
  }

  if (isKnownBinaryFile(selectedEntry.name)) {
    return {
      title: "Non-text file selected",
      detail: `${selectedEntry.path} is selected but is not editable as text.`,
    };
  }

  if (openFailure?.path === selectedEntry.path) {
    const isEncodingError = openFailure.reason.includes("not valid UTF-8");
    return {
      title: isEncodingError ? "File is not valid text" : "File did not open",
      detail: openFailure.reason,
    };
  }

  return {
    title: "No file selected",
    detail: undefined,
  };
}

export default function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceLoadFailed, setWorkspaceLoadFailed] = useState(false);
  const [initialFile, setInitialFile] = useState<string>();
  const [launchTargetLoaded, setLaunchTargetLoaded] = useState(false);
  const [singleFileMode, setSingleFileMode] = useState(false);
  const [singleFilePath, setSingleFilePath] = useState<string>();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [workspaceScanTruncated, setWorkspaceScanTruncated] = useState(false);
  const [workspaceScanLimitHit, setWorkspaceScanLimitHit] = useState(defaultTreeScanLimit);
  const [loadedFolders, setLoadedFolders] = useState<Set<string>>(() => new Set());
  const loadingFoldersRef = useRef<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [revealTarget, setRevealTarget] = useState<RevealTarget>();
  const [openFiles, setOpenFiles] = useState<EditorTab[]>([]);
  const [filter, setFilter] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [currentFileQuery, setCurrentFileQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [replaceVisible, setReplaceVisible] = useState(false);
  const [activeSidebarSearch, setActiveSidebarSearch] =
    useState<SidebarPanelMode>();
  const [currentFindOpen, setCurrentFindOpen] = useState(false);
  const [currentFindIndex, setCurrentFindIndex] = useState(-1);
  const [editorCommand, setEditorCommand] = useState<EditorCommandRequest>();
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [searchResultsTruncated, setSearchResultsTruncated] = useState(false);
  const [searchResultLimitHit, setSearchResultLimitHit] = useState(
    defaultWorkspaceSearchResultLimit,
  );
  const [searchStats, setSearchStats] = useState<{
    searchedFiles?: number;
    skippedFiles?: number;
  }>({});
  const [searching, setSearching] = useState(false);
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState("");
  const [quickOpenIndex, setQuickOpenIndex] = useState(0);
  const [quickOpenIndexedResults, setQuickOpenIndexedResults] = useState<FileEntry[]>([]);
  const [quickOpenSearching, setQuickOpenSearching] = useState(false);
  const [commandPaletteVisible, setCommandPaletteVisible] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const [newFileDialogOpen, setNewFileDialogOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [newFolderPath, setNewFolderPath] = useState("");
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameFromPath, setRenameFromPath] = useState("");
  const [renameToPath, setRenameToPath] = useState("");
  const [goToLineDialogOpen, setGoToLineDialogOpen] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState("");
  const [pendingDeletePath, setPendingDeletePath] = useState<string>();
  const [pendingReloadRequest, setPendingReloadRequest] =
    useState<PendingReloadRequest>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(defaultSidebarWidth);
  const [commitMessageHeight, setCommitMessageHeight] = useState(defaultCommitMessageHeight);
  const [pendingClosePath, setPendingClosePath] = useState<string>();
  const [pendingCloseAll, setPendingCloseAll] = useState(false);
  const [pendingAppClose, setPendingAppClose] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [keyBindingsOpen, setKeyBindingsOpen] = useState(false);
  const [keyBindingsQuery, setKeyBindingsQuery] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo>(fallbackAppInfo);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("view");
  const [showDotfiles, setShowDotfiles] = useState(false);
  const [showGeneratedInternal, setShowGeneratedInternal] = useState(false);
  const [showGitignoredFiles, setShowGitignoredFiles] = useState(false);
  const [showDiagnosticsPanel, setShowDiagnosticsPanel] = useState(false);
  const [trackActiveFile, setTrackActiveFile] = useState(true);
  const [treeScanLimit, setTreeScanLimit] = useState(defaultTreeScanLimit);
  const [maxOpenFileKb, setMaxOpenFileKb] = useState(defaultMaxOpenFileKb);
  const [workspaceSearchResultLimit, setWorkspaceSearchResultLimit] = useState(
    defaultWorkspaceSearchResultLimit,
  );
  const [workspaceSearchMaxFileKb, setWorkspaceSearchMaxFileKb] = useState(
    defaultWorkspaceSearchMaxFileKb,
  );
  const [currentFileSearchResultLimit, setCurrentFileSearchResultLimit] = useState(
    defaultCurrentFileSearchResultLimit,
  );
  const [currentFileResultPreviewLimit, setCurrentFileResultPreviewLimit] = useState(
    defaultCurrentFileResultPreviewLimit,
  );
  const [quickOpenResultLimit, setQuickOpenResultLimit] = useState(
    defaultQuickOpenResultLimit,
  );
  const [backgroundIndexBatchEntries, setBackgroundIndexBatchEntries] = useState(
    defaultBackgroundIndexBatchEntries,
  );
  const [workspaceTitleMaxChars, setWorkspaceTitleMaxChars] = useState(
    defaultWorkspaceTitleMaxChars,
  );
  const [workspaceDisplayContext, setWorkspaceDisplayContext] =
    useState<WorkspaceDisplayContext>();
  const [commandPaletteResultLimit, setCommandPaletteResultLimit] = useState(
    defaultCommandPaletteResultLimit,
  );
  const [editorFontSize, setEditorFontSize] = useState(defaultEditorFontSize);
  const [appZoomPercent, setAppZoomPercent] = useState(defaultAppZoomPercent);
  const [dateTimeFormat, setDateTimeFormat] =
    useState<DateTimeFormatId>(defaultDateTimeFormat);
  const [recentRelativeThreshold, setRecentRelativeThreshold] =
    useState<RecentRelativeThresholdId>(defaultRecentRelativeThreshold);
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>(defaultDiffViewMode);
  const [featureFlags, setFeatureFlags] = useState<FeatureFlagOverrides>({});
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const [uiStateLoaded, setUiStateLoaded] = useState(false);
  const [workspaceUiRestored, setWorkspaceUiRestored] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  // Trust to follow symlinks whose target escapes the workspace. Session = this
  // run only ("Trust once"); workspace = persisted ("Trust for workspace").
  const [trustExternalSession, setTrustExternalSession] = useState(false);
  const [trustExternalWorkspace, setTrustExternalWorkspace] = useState(false);
  const [pendingSymlinkTrust, setPendingSymlinkTrust] =
    useState<{ entry: FileEntry; action: "open" | "expand" }>();
  const [openFailure, setOpenFailure] = useState<OpenFailure>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("Ready");
  const [selection, setSelection] = useState<EditorSelection>();
  const [cursor, setCursor] = useState<EditorCursor>();
  const [lspServers, setLspServers] = useState<LspServerStatus[]>([]);
  const [diagnosticsByPath, setDiagnosticsByPath] = useState<
    Record<string, EditorDiagnostic[]>
  >({});
  const [settingsLocations, setSettingsLocations] = useState<SettingsLocations>({});
  const [workspaceIndexStats, setWorkspaceIndexStats] = useState<WorkspaceIndexStats>();
  const [httpEndpoint, setHttpEndpoint] = useState<string>();
  const [codexMcp, setCodexMcp] = useState<CodexMcpStatus>();
  const [claudeBridge, setClaudeBridge] = useState<ClaudeBridgeStatus>();
  const [gitAttribution, setGitAttribution] = useState<GitAttribution>();
  const [gitCommitPopover, setGitCommitPopover] = useState<GitCommitInfo>();
  const [gitStatus, setGitStatus] = useState<GitStatus>();
  const [gitStatusError, setGitStatusError] = useState<string>();
  const [gitCommitSelectedPaths, setGitCommitSelectedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [gitCommitMessage, setGitCommitMessage] = useState("");
  const [gitCommitInFlight, setGitCommitInFlight] = useState(false);
  const [gitCommitError, setGitCommitError] = useState<string>();
  const [gitCommitSuccess, setGitCommitSuccess] = useState<string>();
  const [gitSyncInFlight, setGitSyncInFlight] = useState(false);
  const [gitSyncResult, setGitSyncResult] = useState<GitSyncResult>();
  const [gitSyncError, setGitSyncError] = useState<string>();
  const [gitMergeStagingPath, setGitMergeStagingPath] = useState<string>();
  const [gitMergeInFlight, setGitMergeInFlight] = useState(false);
  const [gitMergeError, setGitMergeError] = useState<string>();
  const [gitMergeSuccess, setGitMergeSuccess] = useState<string>();
  const gitStatusInitializedRef = useRef(false);
  const sidebarFilterInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarContentSearchInputRef = useRef<HTMLInputElement | null>(null);
  const currentFindInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const gitCommitPopoverCloseRef = useRef<HTMLButtonElement | null>(null);
  const initialFileOpenedRef = useRef(false);
  const openedLaunchTargetsDrainedRef = useRef(false);
  // Effective external-symlink trust, mirrored to a ref so the many file I/O
  // callbacks can read the current value without each depending on it.
  const allowExternalSymlinks = trustExternalSession || trustExternalWorkspace;
  const allowExternalSymlinksRef = useRef(allowExternalSymlinks);
  useEffect(() => {
    allowExternalSymlinksRef.current = allowExternalSymlinks;
  }, [allowExternalSymlinks]);
  const persistedWorkspaceRef = useRef<WorkspaceUiState>({
    expandedFolders: [],
    openFiles: [],
  });
  const persistedFilesRestoredRef = useRef(false);
  const skipNextUiStatePersistRef = useRef(false);
  const uiPersistTimerRef = useRef<number | undefined>(undefined);
  const editorCommandNonceRef = useRef(0);
  const openFilesRef = useRef<EditorTab[]>([]);
  const pendingReloadRequestRef = useRef<PendingReloadRequest | undefined>(undefined);
  const diskCheckInFlightRef = useRef<Set<string>>(new Set());
  const savingPathsRef = useRef<Set<string>>(new Set());
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | undefined>(
    undefined,
  );
  const commitMessageResizeRef = useRef<
    { startY: number; startHeight: number } | undefined
  >(undefined);

  const activeFile = openFiles.find((file) => file.path === activePath);
  const pendingCloseFile = openFiles.find((file) => file.path === pendingClosePath);
  const pendingDeleteFile = files.find((file) => file.path === pendingDeletePath);
  const pendingDeleteOpenFiles = pendingDeletePath
    ? openFiles.filter((file) => pathIsAtOrInside(file.path, pendingDeletePath))
    : [];
  const pendingReloadFile = openFiles.find(
    (file) => file.path === pendingReloadRequest?.path,
  );
  const dirtyFiles = openFiles.filter((file) => file.dirty);
  const activeFileIsDirty = Boolean(activeFile?.dirty);
  const hasDirtyFiles = dirtyFiles.length > 0;
  const activeSelection = selection?.filePath === activePath ? selection : undefined;
  const cursorPosition = cursorStatus(activePath, cursor, revealTarget);
  const gitAttributionEnabled = isFeatureEnabled("gitAttribution", featureFlags);
  const gitCommitEnabled = isFeatureEnabled("gitCommit", featureFlags);
  const gitSyncEnabled = isFeatureEnabled("gitSync", featureFlags);
  // Live merge state, read straight off the polled Git status so the conflict UI
  // updates on its own as the user resolves files (rather than freezing on the
  // one-shot sync result). Defaults tolerate an older status shape / test mock.
  const mergeInProgress = gitSyncEnabled && (gitStatus?.mergeInProgress ?? false);
  const conflictedFiles = gitStatus?.conflictedFiles ?? [];
  const activeGitAttribution =
    gitAttributionEnabled &&
    gitAttribution?.status === "available" &&
    gitAttribution.path === activePath
      ? gitAttribution
      : undefined;
  const activeGitFileCommit = activeGitAttribution?.file;
  const gitStatusTitle = activeGitFileCommit
    ? fullCommitDescription(activeGitFileCommit, dateTimeFormat, recentRelativeThreshold)
    : undefined;
  const sidebarFiles = useMemo(() => {
    if (!singleFileMode || !singleFilePath) return files;
    const entry =
      files.find((candidate) => candidate.path === singleFilePath) ??
      fileEntryForDirectOpen(singleFilePath);
    return [entry];
  }, [files, singleFileMode, singleFilePath]);
  const selectedEntry = selectedPath
    ? sidebarFiles.find((file) => file.path === selectedPath)
    : undefined;
  const renameSourceEntry = renameFromPath
    ? sidebarFiles.find((file) => file.path === renameFromPath)
    : undefined;
  const tree = useMemo(() => buildTree(sidebarFiles), [sidebarFiles]);
  const filteredTree = useMemo(
    () => filterTree(tree, filter.trim().toLowerCase()),
    [filter, tree],
  );
  const changedFiles =
    gitCommitEnabled && gitStatus?.status === "available" ? gitStatus.files : [];
  const changedFilePaths = useMemo(
    () => changedFiles.map((file) => file.path),
    [changedFiles],
  );
  // Badge/dot overlay for the main tree (Part 2) — undefined (not just empty)
  // when there's nothing to show, so `TreeItem` renders byte-for-byte as it
  // does today when the flag is off or status hasn't loaded.
  const fileStatusByPath = useMemo(() => {
    if (changedFiles.length === 0) return undefined;
    return new Map(changedFiles.map((file) => [file.path, file.status]));
  }, [changedFiles]);
  const changedFolderPaths = useMemo(() => {
    if (changedFiles.length === 0) return undefined;
    const folders = new Set<string>();
    for (const file of changedFiles) {
      const segments = file.path.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        folders.add(segments.slice(0, index).join("/"));
      }
    }
    return folders;
  }, [changedFiles]);
  // Commit mode reuses the same tree/TreeItem as normal browsing (Part 3),
  // filtered down to changed files plus their ancestor folders. Deleted
  // files don't exist in `sidebarFiles` (the workspace scan can't see them),
  // so they're injected as synthetic leaf entries before filtering.
  const changedFilesTree = useMemo(() => {
    if (changedFiles.length === 0) return [];
    const existingPaths = new Set(sidebarFiles.map((file) => file.path));
    const syntheticEntries = syntheticMissingFileEntries(changedFiles, existingPaths);
    const combinedEntries =
      syntheticEntries.length > 0 ? [...sidebarFiles, ...syntheticEntries] : sidebarFiles;
    const fullTree = buildTree(combinedEntries);
    return filterTreeToPaths(fullTree, new Set(changedFilePaths));
  }, [changedFiles, changedFilePaths, sidebarFiles]);
  const allChangedFilesSelected =
    changedFilePaths.length > 0 &&
    changedFilePaths.every((path) => gitCommitSelectedPaths.has(path));
  const quickOpenCandidates = useMemo(
    () => mergeFileEntries(sidebarFiles, quickOpenIndexedResults),
    [quickOpenIndexedResults, sidebarFiles],
  );
  const quickOpenResults = useMemo(
    () => quickOpenMatches(quickOpenCandidates, quickOpenQuery, quickOpenResultLimit),
    [quickOpenCandidates, quickOpenQuery, quickOpenResultLimit],
  );
  const currentFindResults = useMemo(
    () =>
      activeFile && !activeFile.diff
        ? currentFileMatches(
            activeFile.path,
            activeFile.contents,
            currentFileQuery,
            currentFileSearchResultLimit,
          )
        : [],
    [activeFile, currentFileQuery, currentFileSearchResultLimit],
  );
  const currentFindWindow = useMemo(
    () =>
      currentFileResultWindow(
        currentFindResults,
        currentFindIndex,
        currentFileResultPreviewLimit,
      ),
    [currentFindResults, currentFindIndex, currentFileResultPreviewLimit],
  );
  const diagnostics = useMemo(
    () => sortDiagnostics(Object.values(diagnosticsByPath).flat()),
    [diagnosticsByPath],
  );
  const codexMcpConfig = useMemo(
    () => (codexMcp ? codexMcpConfigSnippet(codexMcp) : ""),
    [codexMcp],
  );
  const repositoryLabel = useMemo(
    () => appInfo.repository.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    [appInfo.repository],
  );
  const keyBindingResults = useMemo(
    () => filterKeyBindings(keyBindings, keyBindingsQuery),
    [keyBindingsQuery],
  );
  const filterExpanded = activeSidebarSearch === "filter" || filter.trim().length > 0;
  // Gated on the flag so disabling `gitCommit` mid-session always drops the
  // app out of commit mode, even if `activeSidebarSearch` is still "commit"
  // from before the flag flipped off.
  const commitModeActive = gitCommitEnabled && activeSidebarSearch === "commit";
  const filterVisible = activeSidebarSearch !== "content" && !commitModeActive && filterExpanded;
  const contentSearchActive = activeSidebarSearch === "content";
  const contentSearchReady = contentQuery.trim().length >= 2;
  const contentSearchStatsText =
    searchStats.searchedFiles === undefined
      ? undefined
      : `${searchStats.searchedFiles.toLocaleString()} files searched${
          searchStats.skippedFiles ? `, ${searchStats.skippedFiles.toLocaleString()} skipped` : ""
        }`;
  // Diff tabs are read-only synthetic surfaces — find-in-file (like save and
  // the disk-state check) must no-op for them rather than searching/labeling
  // against the synthetic `diff://` path.
  const currentFindExpanded =
    Boolean(activeFile) &&
    !activeFile?.diff &&
    (currentFindOpen || currentFileQuery.trim().length > 0);
  const suggestedNewFilePath = useMemo(
    () => suggestNewFilePath(selectedPath, files),
    [files, selectedPath],
  );
  const suggestedNewFolderPath = useMemo(
    () => suggestNewFolderPath(selectedPath, files),
    [files, selectedPath],
  );
  const openFilePathSignature = useMemo(
    () => openFiles.map((file) => file.path).join("\0"),
    [openFiles],
  );
  const workspaceTitle = singleFileMode && singleFilePath
    ? lastSegment(singleFilePath)
    : workspaceDisplayContext?.workspaceLabel || lastSegment(workspaceRoot);
  const appTitle = singleFileMode && singleFilePath
    ? `ide - ${lastSegment(singleFilePath)}`
    : workspaceDisplayContext?.appTitle || (workspaceTitle ? `ide - ${workspaceTitle}` : "ide");
  const nativePickerAvailable = isNativeTauri();
  const emptyEditorState = emptyEditorStateForSelection(selectedEntry, openFailure);
  const modalUiOpen =
    quickOpenVisible ||
    commandPaletteVisible ||
    newFileDialogOpen ||
    newFolderDialogOpen ||
    renameDialogOpen ||
    goToLineDialogOpen ||
    pendingDeletePath !== undefined ||
    pendingSymlinkTrust !== undefined ||
    pendingReloadRequest !== undefined ||
    pendingCloseAll ||
    pendingAppClose ||
    integrationsOpen ||
    keyBindingsOpen ||
    aboutOpen ||
    settingsOpen ||
    pendingClosePath !== undefined;
  const modalUiOpenRef = useRef(false);

  useEffect(() => {
    modalUiOpenRef.current = modalUiOpen;
  }, [modalUiOpen]);

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  useEffect(() => {
    pendingReloadRequestRef.current = pendingReloadRequest;
  }, [pendingReloadRequest]);

  const runNativeMenuAction = useCallback((action: () => void) => {
    if (modalUiOpenRef.current) {
      setStatus("Close the active dialog first");
      return;
    }

    action();
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.(darkSchemeQuery);
    if (!media) return;

    const handleThemeChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };

    setPrefersDark(media.matches);
    media.addEventListener("change", handleThemeChange);
    return () => media.removeEventListener("change", handleThemeChange);
  }, []);

  useLayoutEffect(() => {
    applyDocumentTheme(prefersDark);
  }, [prefersDark]);

  useEffect(() => {
    if (activeSidebarSearch === "filter") {
      sidebarFilterInputRef.current?.focus();
    } else if (activeSidebarSearch === "content") {
      sidebarContentSearchInputRef.current?.focus();
    }
  }, [activeSidebarSearch]);

  useEffect(() => {
    if (currentFindExpanded) {
      currentFindInputRef.current?.focus();
    }
  }, [currentFindExpanded]);

  useEffect(() => {
    if (!activeFile) {
      setCurrentFindOpen(false);
    }
  }, [activeFile]);

  useEffect(() => {
    if (!gitAttributionEnabled || !activePath || !activeFile || activeFile.diff) {
      setGitAttribution(undefined);
      setGitCommitPopover(undefined);
      return;
    }

    let disposed = false;
    const requestedPath = activePath;
    setGitCommitPopover(undefined);
    getGitAttribution(requestedPath)
      .then((attribution) => {
        if (disposed || attribution.path !== requestedPath) return;
        setGitAttribution(attribution);
      })
      .catch((reason) => {
        if (!disposed) {
          setGitAttribution(undefined);
          setError(`Unable to load Git attribution: ${String(reason)}`);
        }
      });

    return () => {
      disposed = true;
    };
  }, [
    activeFile?.modifiedMs,
    activePath,
    gitAttributionEnabled,
  ]);

  useEffect(() => {
    if (gitCommitPopover) {
      gitCommitPopoverCloseRef.current?.focus();
    }
  }, [gitCommitPopover]);

  useEffect(() => {
    let disposed = false;

    getWorkspaceDisplayContext(workspaceTitleMaxChars)
      .then((context) => {
        if (!disposed) setWorkspaceDisplayContext(context);
      })
      .catch(() => {
        if (!disposed) setWorkspaceDisplayContext(undefined);
      });

    return () => {
      disposed = true;
    };
  }, [workspaceRoot, workspaceTitleMaxChars]);

  useEffect(() => {
    document.title = appTitle;
    setNativeWindowTitle(appTitle).catch(() => undefined);
  }, [appTitle]);

  useEffect(() => {
    let disposed = false;
    getAppInfo()
      .then((info) => {
        if (!disposed) setAppInfo(info);
      })
      .catch(() => {
        if (!disposed) setAppInfo(fallbackAppInfo);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    setCurrentFindIndex(-1);
  }, [activePath, currentFileQuery]);

  useEffect(() => {
    setCurrentFindIndex((current) => {
      if (currentFindResults.length === 0) return -1;
      return current >= currentFindResults.length ? currentFindResults.length - 1 : current;
    });
  }, [currentFindResults.length]);

  const applyPersistedUiSnapshot = useCallback((snapshot: PersistedUiSnapshot) => {
    persistedWorkspaceRef.current = snapshot.workspace;
    persistedFilesRestoredRef.current = false;
    skipNextUiStatePersistRef.current = false;
    setWorkspaceUiRestored(false);
    setShowDotfiles(snapshot.view.showDotfiles);
    setShowGeneratedInternal(snapshot.view.showGeneratedInternal);
    setShowGitignoredFiles(snapshot.view.showGitignoredFiles ?? false);
    setShowDiagnosticsPanel(Boolean(snapshot.view.showDiagnosticsPanel));
    setTrackActiveFile(snapshot.view.trackActiveFile ?? true);
    setTreeScanLimit(sanitizeTreeScanLimit(snapshot.view.treeScanLimit));
    setMaxOpenFileKb(
      sanitizeNumberLimit(
        snapshot.view.maxOpenFileKb,
        minMaxOpenFileKb,
        maxMaxOpenFileKb,
        defaultMaxOpenFileKb,
      ),
    );
    setWorkspaceSearchResultLimit(
      sanitizeNumberLimit(
        snapshot.view.workspaceSearchResultLimit,
        minWorkspaceSearchResultLimit,
        maxWorkspaceSearchResultLimit,
        defaultWorkspaceSearchResultLimit,
      ),
    );
    setWorkspaceSearchMaxFileKb(
      sanitizeNumberLimit(
        snapshot.view.workspaceSearchMaxFileKb,
        minWorkspaceSearchMaxFileKb,
        maxWorkspaceSearchMaxFileKb,
        defaultWorkspaceSearchMaxFileKb,
      ),
    );
    setCurrentFileSearchResultLimit(
      sanitizeNumberLimit(
        snapshot.view.currentFileSearchResultLimit,
        minCurrentFileSearchResultLimit,
        maxCurrentFileSearchResultLimit,
        defaultCurrentFileSearchResultLimit,
      ),
    );
    setCurrentFileResultPreviewLimit(
      sanitizeNumberLimit(
        snapshot.view.currentFileResultPreviewLimit,
        minCurrentFileResultPreviewLimit,
        maxCurrentFileResultPreviewLimit,
        defaultCurrentFileResultPreviewLimit,
      ),
    );
    setQuickOpenResultLimit(
      sanitizeNumberLimit(
        snapshot.view.quickOpenResultLimit,
        minQuickOpenResultLimit,
        maxQuickOpenResultLimit,
        defaultQuickOpenResultLimit,
      ),
    );
    setBackgroundIndexBatchEntries(
      sanitizeNumberLimit(
        snapshot.view.backgroundIndexBatchEntries,
        minBackgroundIndexBatchEntries,
        maxBackgroundIndexBatchEntries,
        defaultBackgroundIndexBatchEntries,
      ),
    );
    setCommandPaletteResultLimit(
      sanitizeNumberLimit(
        snapshot.view.commandPaletteResultLimit,
        minCommandPaletteResultLimit,
        maxCommandPaletteResultLimit,
        defaultCommandPaletteResultLimit,
      ),
    );
    setEditorFontSize(
      sanitizeNumberMinimum(
        snapshot.view.editorFontSize,
        minEditorFontSize,
        defaultEditorFontSize,
      ),
    );
    setAppZoomPercent(
      sanitizeNumberMinimum(
        snapshot.view.appZoomPercent,
        minAppZoomPercent,
        defaultAppZoomPercent,
      ),
    );
    setDateTimeFormat(sanitizeDateTimeFormat(snapshot.view.dateTimeFormat));
    setRecentRelativeThreshold(
      sanitizeRecentRelativeThreshold(snapshot.view.recentRelativeThreshold),
    );
    setDiffViewMode(sanitizeDiffViewMode(snapshot.view.diffViewMode));
    setFeatureFlags(sanitizeFeatureFlagOverrides(snapshot.view.featureFlags));
    setExpandedFolders(new Set(snapshot.workspace.expandedFolders));
    setTrustExternalWorkspace(Boolean(snapshot.workspace.trustExternalSymlinks));
    setSelectedPath(snapshot.workspace.selectedPath);
    setSidebarWidth(
      sanitizeNumberLimit(
        snapshot.workspace.sidebarWidth,
        minSidebarWidth,
        maxSidebarWidth,
        defaultSidebarWidth,
      ),
    );
    setCommitMessageHeight(
      sanitizeNumberLimit(
        snapshot.workspace.commitMessageHeight,
        minCommitMessageHeight,
        maxCommitMessageHeight,
        defaultCommitMessageHeight,
      ),
    );
  }, []);

  const loadPersistedUiState = useCallback(async () => {
    try {
      applyPersistedUiSnapshot(await getUiState());
    } catch (reason) {
      setError(`Unable to load saved UI state: ${String(reason)}`);
    } finally {
      setUiStateLoaded(true);
    }
  }, [applyPersistedUiSnapshot]);

  const loadFolderChildren = useCallback(
    async (path: string) => {
      if (
        singleFileMode ||
        loadedFolders.has(path) ||
        loadingFoldersRef.current.has(path)
      ) {
        return;
      }

      loadingFoldersRef.current.add(path);
      try {
        const entries = await listDirectory(
          path,
          showDotfiles,
          showGeneratedInternal,
          showGitignoredFiles,
          allowExternalSymlinksRef.current,
        );
        setFiles((current) => mergeFileEntries(current, entries));
        setLoadedFolders((current) => new Set(current).add(path));
      } catch (reason) {
        setError(`Unable to load folder ${path}: ${String(reason)}`);
        setStatus("Folder load failed");
      } finally {
        loadingFoldersRef.current.delete(path);
      }
    },
    [
      loadedFolders,
      showDotfiles,
      showGeneratedInternal,
      showGitignoredFiles,
      singleFileMode,
    ],
  );

  const toggleFolder = useCallback((path: string) => {
    // Expanding an external symlinked directory follows it outside the workspace;
    // require trust first.
    const entry = files.find((file) => file.path === path);
    if (entry?.isExternal && !allowExternalSymlinksRef.current) {
      setPendingSymlinkTrust({ entry, action: "expand" });
      return;
    }
    const shouldLoad = !expandedFolders.has(path);
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
    if (shouldLoad) {
      void loadFolderChildren(path);
    }
  }, [expandedFolders, files, loadFolderChildren]);

  const refreshIntegrationStatus = useCallback(async () => {
    try {
      setLspServers(await getLspServers());
      setHttpEndpoint(await getHttpEndpoint());
      setCodexMcp(await getCodexMcpStatus());
      setClaudeBridge(await getClaudeBridgeStatus());
    } catch (reason) {
      setError(`Unable to load local integration status: ${String(reason)}`);
    }
  }, []);

  // Fetches the latest diff for one open diff tab and returns the updated
  // payload, or undefined if the fetch failed or nothing actually changed —
  // callers skip the state update entirely in that case, so an unrelated
  // refresh never re-renders a diff tab that's still accurate. Shares the
  // disk-check in-flight guard with real files, keyed by the same tab path
  // (the synthetic `diff://<filePath>` key), so a slow fetch can't overlap
  // with itself from two triggers (background poll + focus, say).
  const fetchDiffTabUpdate = useCallback(
    async (tab: EditorTab): Promise<EditorTabDiff | undefined> => {
      const existing = tab.diff;
      if (!existing) return undefined;
      if (diskCheckInFlightRef.current.has(tab.path)) return undefined;

      diskCheckInFlightRef.current.add(tab.path);
      try {
        const diff = await loadGitFileDiff(existing.filePath, maxOpenFileKb * 1024);
        const changed =
          diff.original !== existing.original ||
          diff.modified !== existing.modified ||
          diff.status !== existing.status ||
          diff.isBinary !== existing.isBinary ||
          diff.isTooLarge !== existing.isTooLarge;
        return changed ? { filePath: existing.filePath, ...diff } : undefined;
      } catch {
        // A transient status-check failure shouldn't blank an open diff —
        // leave the tab showing its last known-good snapshot.
        return undefined;
      } finally {
        diskCheckInFlightRef.current.delete(tab.path);
      }
    },
    [maxOpenFileKb],
  );

  // Single-tab path used by checkOpenFileDiskState (background poll, focus,
  // tab activation) so an externally-changed file's diff reloads the same
  // way a real open file's contents do.
  const refreshOpenDiffTab = useCallback(
    async (path: string) => {
      const tab = openFilesRef.current.find((file) => file.path === path && file.diff);
      if (!tab) return;
      const update = await fetchDiffTabUpdate(tab);
      if (!update) return;
      setOpenFiles((current) =>
        current.map((file) =>
          file.path === path ? { ...file, contents: update.modified, diff: update } : file,
        ),
      );
    },
    [fetchDiffTabUpdate],
  );

  // Bulk path used after a Git status refresh (in-IDE save/create/rename/
  // delete, and post-commit) — every open diff tab is re-checked in
  // parallel, and the updates are applied in a single setOpenFiles call so
  // a tab whose diff didn't change keeps the exact same object reference
  // (no needless re-render).
  const refreshOpenDiffTabs = useCallback(async () => {
    const diffTabs = openFilesRef.current.filter((file) => file.diff);
    if (diffTabs.length === 0) return;

    const updates = new Map<string, EditorTabDiff>();
    await Promise.all(
      diffTabs.map(async (tab) => {
        const update = await fetchDiffTabUpdate(tab);
        if (update) updates.set(tab.path, update);
      }),
    );
    if (updates.size === 0) return;

    setOpenFiles((current) =>
      current.map((file) => {
        const update = updates.get(file.path);
        return update ? { ...file, contents: update.modified, diff: update } : file;
      }),
    );
  }, [fetchDiffTabUpdate]);

  // Declared ahead of `refreshFiles` so the workspace-scan callback (the
  // single choke point every save/create/rename/delete/refresh already
  // funnels through) can trigger it too, without a temporal-dead-zone issue.
  const refreshGitStatus = useCallback(async () => {
    if (!gitCommitEnabled) return;

    try {
      const status = await getGitStatus();
      setGitStatus(status);
      setGitStatusError(undefined);
      setGitCommitSelectedPaths((current) => {
        const validPaths = new Set(status.files.map((file) => file.path));
        if (!gitStatusInitializedRef.current) {
          gitStatusInitializedRef.current = true;
          return validPaths;
        }
        const next = new Set<string>();
        for (const path of current) {
          if (validPaths.has(path)) next.add(path);
        }
        return next;
      });
      // A fresh Git status means every in-IDE save/create/rename/delete (they
      // all funnel through refreshFiles → here) and every commit just landed,
      // so any open diff tab may now be stale — reload them too.
      void refreshOpenDiffTabs();
    } catch (reason) {
      setGitStatus(undefined);
      setGitStatusError(`Unable to load Git status: ${String(reason)}`);
    }
  }, [gitCommitEnabled, refreshOpenDiffTabs]);

  const refreshFiles = useCallback(async (options?: { singleFilePath?: string }) => {
    const effectiveSingleFilePath =
      options && "singleFilePath" in options ? options.singleFilePath : singleFilePath;
    const effectiveSingleFileMode =
      options && "singleFilePath" in options
        ? Boolean(options.singleFilePath)
        : singleFileMode;

    setWorkspaceLoading(true);
    try {
      const root = await getWorkspaceRoot();
      setWorkspaceRoot(root);
      setLspRootUri(workspacePathToFileUri(root));
      if (effectiveSingleFileMode && effectiveSingleFilePath) {
        const entry = await statFile(effectiveSingleFilePath);
        setFiles([entry]);
        setWorkspaceScanTruncated(false);
        setWorkspaceScanLimitHit(treeScanLimit);
        setLoadedFolders(new Set());
        loadingFoldersRef.current.clear();
        setWorkspaceLoadFailed(false);
        setWorkspaceUiRestored(true);
        await refreshIntegrationStatus();
        return [entry];
      }

      const scan = normalizeFileListResult(
        await listFiles(
          showDotfiles,
          showGeneratedInternal,
          treeScanLimit,
          showGitignoredFiles,
        ),
      );
      if (!scan) {
        throw new Error("Workspace file list response was not valid JSON");
      }
      const entries = scan.entries;
      setFiles(entries);
      setWorkspaceScanTruncated(scan.truncated);
      setWorkspaceScanLimitHit(scan.limit);
      setLoadedFolders(new Set());
      loadingFoldersRef.current.clear();
      setWorkspaceLoadFailed(false);
      await refreshIntegrationStatus();
      // This is the single choke point every workspace load/refresh and
      // save/create/rename/delete already funnels through, so hooking Git
      // status here (flag-gated inside refreshGitStatus) covers all of them
      // without each caller needing its own explicit call. Fire-and-forget:
      // the scan result below shouldn't wait on an extra round trip.
      void refreshGitStatus();
      return entries;
    } catch (reason) {
      setWorkspaceLoadFailed(true);
      throw reason;
    } finally {
      setWorkspaceLoading(false);
    }
  }, [
    refreshGitStatus,
    refreshIntegrationStatus,
    showDotfiles,
    showGeneratedInternal,
    showGitignoredFiles,
    singleFileMode,
    singleFilePath,
    treeScanLimit,
  ]);

  useEffect(() => {
    getInitialFile()
      .then((path) => {
        setInitialFile(path);
        if (path) {
          setSingleFileMode(true);
          setSingleFilePath(path);
        }
      })
      .catch((reason) => {
        setError(`Unable to read launch file: ${String(reason)}`);
      })
      .finally(() => {
        setLaunchTargetLoaded(true);
      });
  }, []);

  const refreshLspStatus = useCallback(async () => {
    try {
      setLspServers(await getLspServers());
    } catch (reason) {
      setError(`Unable to refresh language server status: ${String(reason)}`);
    }
  }, []);

  const refreshWorkspace = useCallback(async () => {
    setError(undefined);
    setStatus("Refreshing files");
    try {
      // `refreshFiles` itself refreshes Git status (flag-gated) on success, so
      // every save/create/rename/delete that already calls it gets fresh
      // status for free — this explicit refresh-button path is covered too.
      await refreshFiles();
      setStatus("Ready");
    } catch (reason) {
      setError(String(reason));
      setStatus("Workspace load failed");
    }
  }, [refreshFiles]);

  useEffect(() => {
    if (!commitModeActive) {
      gitStatusInitializedRef.current = false;
      return;
    }
    void refreshGitStatus();
  }, [commitModeActive, refreshGitStatus]);

  // Auto-expand the ancestor folders of every changed file on entering commit
  // mode, so the (now filtered, not force-expanded) shared tree shows them
  // without a manual expand. Only ever adds to `expandedFolders` — a manual
  // collapse afterward (in either mode) is never overridden, and it carries
  // over when leaving/re-entering commit mode since it's the same Set.
  useEffect(() => {
    if (!commitModeActive || changedFilePaths.length === 0) return;
    const ancestorPaths = new Set<string>();
    for (const path of changedFilePaths) {
      const segments = path.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        ancestorPaths.add(segments.slice(0, index).join("/"));
      }
    }
    if (ancestorPaths.size === 0) return;
    setExpandedFolders((current) => {
      let changed = false;
      const next = new Set(current);
      for (const path of ancestorPaths) {
        if (!next.has(path)) {
          next.add(path);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [commitModeActive, changedFilePaths]);

  // Success is transient — clear it after a few seconds (or immediately on the
  // next edit, via handleGitCommit) so the panel doesn't carry a stale line.
  useEffect(() => {
    if (!gitCommitSuccess) return;
    const timeoutId = window.setTimeout(() => setGitCommitSuccess(undefined), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [gitCommitSuccess]);

  // Sync notices are scoped to a commit-panel session; clear them on the way out
  // so reopening the panel doesn't show a stale "Synced"/conflict line.
  useEffect(() => {
    if (commitModeActive) return;
    setGitSyncResult(undefined);
    setGitSyncError(undefined);
    setGitMergeError(undefined);
    setGitMergeSuccess(undefined);
  }, [commitModeActive]);

  // Clear the "Completed merge" line after a beat, matching the commit-success
  // treatment — it's a transient confirmation, not persistent state.
  useEffect(() => {
    if (!gitMergeSuccess) return;
    const timeoutId = window.setTimeout(() => setGitMergeSuccess(undefined), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [gitMergeSuccess]);

  // Diff tabs are inspection surfaces scoped to commit mode — leaving it drops
  // every unpinned one so they don't accumulate; a double-clicked (pinned) tab
  // was a deliberate keep and survives.
  useEffect(() => {
    if (commitModeActive) return;
    setOpenFiles((current) => {
      const kept = current.filter((file) => !file.diff || file.pinned);
      if (kept.length === current.length) return current;
      setActivePath((currentActivePath) =>
        currentActivePath && kept.some((file) => file.path === currentActivePath)
          ? currentActivePath
          : kept.at(-1)?.path,
      );
      return kept;
    });
  }, [commitModeActive]);

  const toggleGitCommitSelection = useCallback((path: string) => {
    setGitCommitSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const selectAllChangedFiles = useCallback(() => {
    setGitCommitSelectedPaths(new Set(changedFilePaths));
  }, [changedFilePaths]);

  const deselectAllChangedFiles = useCallback(() => {
    setGitCommitSelectedPaths(new Set());
  }, []);

  // Bulk-selects/deselects a folder's whole leaf set for the tri-state folder
  // checkboxes — a single toggle affects every file beneath that folder node.
  const setGitCommitPathsSelected = useCallback((paths: string[], selected: boolean) => {
    setGitCommitSelectedPaths((current) => {
      const next = new Set(current);
      for (const path of paths) {
        if (selected) {
          next.add(path);
        } else {
          next.delete(path);
        }
      }
      return next;
    });
  }, []);

  const handleGitCommit = useCallback(async () => {
    const trimmedMessage = gitCommitMessage.trim();
    const selectedPaths = changedFilePaths.filter((path) => gitCommitSelectedPaths.has(path));
    if (!trimmedMessage || selectedPaths.length === 0 || gitCommitInFlight) return;

    setGitCommitInFlight(true);
    setGitCommitError(undefined);
    setGitCommitSuccess(undefined);
    try {
      const result = await commitGitChanges(trimmedMessage, selectedPaths);
      setGitCommitMessage("");
      setGitCommitSuccess(`Committed ${result.committedPaths.length} file(s) as ${result.shortSha}`);
      await refreshGitStatus();
    } catch (reason) {
      setGitCommitError(`Unable to commit: ${String(reason)}`);
    } finally {
      setGitCommitInFlight(false);
    }
  }, [
    changedFilePaths,
    gitCommitInFlight,
    gitCommitMessage,
    gitCommitSelectedPaths,
    refreshGitStatus,
  ]);

  const handleGitSync = useCallback(async () => {
    if (gitSyncInFlight) return;
    setGitSyncInFlight(true);
    setGitSyncError(undefined);
    setGitSyncResult(undefined);
    try {
      const result = await syncGit();
      setGitSyncResult(result);
      // A pull can add or change files, so refresh the changes list to match
      // what is now on disk.
      await refreshGitStatus();
    } catch (reason) {
      setGitSyncError(`Unable to sync: ${String(reason)}`);
    } finally {
      setGitSyncInFlight(false);
    }
  }, [gitSyncInFlight, refreshGitStatus]);

  const handleStageResolved = useCallback(
    async (path: string) => {
      if (gitMergeStagingPath) return;
      setGitMergeStagingPath(path);
      setGitMergeError(undefined);
      try {
        await stageResolvedFile(path);
        // The poll below also refreshes, but do it eagerly so the file drops
        // from the list the moment staging succeeds.
        await refreshGitStatus();
      } catch (reason) {
        setGitMergeError(`Unable to mark ${path} resolved: ${String(reason)}`);
      } finally {
        setGitMergeStagingPath(undefined);
      }
    },
    [gitMergeStagingPath, refreshGitStatus],
  );

  const handleCompleteMerge = useCallback(async () => {
    if (gitMergeInFlight) return;
    setGitMergeInFlight(true);
    setGitMergeError(undefined);
    setGitMergeSuccess(undefined);
    try {
      const result = await completeMerge();
      setGitMergeSuccess(`Completed merge as ${result.shortSha}`);
      await refreshGitStatus();
    } catch (reason) {
      setGitMergeError(`Unable to complete merge: ${String(reason)}`);
    } finally {
      setGitMergeInFlight(false);
    }
  }, [gitMergeInFlight, refreshGitStatus]);

  // While a merge is unfinished, actively re-poll Git status so the panel reflects
  // resolutions the user makes (in-app or in a terminal) without a manual refresh —
  // conflicted files drop out live, and the panel flips back to normal on its own
  // once MERGE_HEAD clears. Only runs while the merge state is actually showing.
  useEffect(() => {
    if (!commitModeActive || !mergeInProgress) return;
    const intervalId = window.setInterval(() => {
      void refreshGitStatus();
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [commitModeActive, mergeInProgress, refreshGitStatus]);

  const readOpenFileFromDisk = useCallback(async (path: string) => {
    const entry = await statFile(path);
    const contents = await readFile(
      path,
      maxOpenFileKb * 1024,
      allowExternalSymlinksRef.current,
    );
    return { contents, modifiedMs: entry.modifiedMs };
  }, [maxOpenFileKb]);

  const applyCleanDiskUpdate = useCallback(
    async (path: string, entry: FileEntry, statusText: string) => {
      const openFileBeforeRead = openFilesRef.current.find((file) => file.path === path);
      if (!openFileBeforeRead || openFileBeforeRead.dirty) return;

      const contents = await readFile(
        path,
        maxOpenFileKb * 1024,
        allowExternalSymlinksRef.current,
      );
      const openFileAfterRead = openFilesRef.current.find((file) => file.path === path);
      if (!openFileAfterRead || openFileAfterRead.dirty) return;

      setOpenFiles((current) =>
        current.map((file) =>
          file.path === path && !file.dirty
            ? {
                ...file,
                contents,
                dirty: false,
                modifiedMs: entry.modifiedMs,
              }
            : file,
        ),
      );
      setFiles((current) => mergeFileEntries(current, [entry]));
      setStatus(statusText);
    },
    [maxOpenFileKb],
  );

  const checkOpenFileDiskState = useCallback(
    async (path: string, source: "activate" | "background" | "focus") => {
      if (diskCheckInFlightRef.current.has(path)) return;
      if (savingPathsRef.current.has(path)) return;
      if (pendingReloadRequestRef.current) return;

      const openFile = openFilesRef.current.find((file) => file.path === path);
      if (!openFile) return;
      // Diff tabs are synthetic and read-only — there's no real file at this
      // path to stat, and none of the reload/dirty machinery below applies.
      // They still need to catch up to an externally-changed file though, so
      // the background poller / focus / tab-activation callers of this
      // function double as the diff tab's own reload trigger.
      if (openFile.diff) {
        await refreshOpenDiffTab(path);
        return;
      }

      diskCheckInFlightRef.current.add(path);
      try {
        const entry = await statFile(path);
        if (savingPathsRef.current.has(path)) return;

        const currentOpenFile = openFilesRef.current.find((file) => file.path === path);
        if (!currentOpenFile) return;
        if (entry.isDir || entry.modifiedMs === currentOpenFile.modifiedMs) return;

        setFiles((current) => mergeFileEntries(current, [entry]));
        if (currentOpenFile.dirty) {
          setPendingReloadRequest({
            path,
            reason: "external",
            diskModifiedMs: entry.modifiedMs,
          });
          setStatus(`${path} changed on disk`);
          return;
        }

        await applyCleanDiskUpdate(
          path,
          entry,
          source === "background" ? `Updated ${path} from disk` : `Reloaded ${path}`,
        );
      } catch (reason) {
        setError(`Unable to check ${path} for disk changes: ${String(reason)}`);
      } finally {
        diskCheckInFlightRef.current.delete(path);
      }
    },
    [applyCleanDiskUpdate, refreshOpenDiffTab],
  );

  const checkOpenFilesDiskState = useCallback(
    (source: "background" | "focus") => {
      for (const file of openFilesRef.current) {
        void checkOpenFileDiskState(file.path, source);
      }
    },
    [checkOpenFileDiskState],
  );

  const refreshWorkspaceIndexStats = useCallback(async () => {
    try {
      setWorkspaceIndexStats(await getWorkspaceIndexStats());
    } catch (reason) {
      setError(`Unable to load workspace index stats: ${String(reason)}`);
    }
  }, []);

  useEffect(() => {
    loadPersistedUiState();
  }, [loadPersistedUiState]);

  useEffect(() => {
    getSettingsLocations()
      .then(setSettingsLocations)
      .catch((reason) => {
        setError(`Unable to load settings storage paths: ${String(reason)}`);
      });
  }, []);

  useEffect(() => {
    if (settingsOpen && settingsCategory === "storage") {
      void refreshWorkspaceIndexStats();
    }
  }, [refreshWorkspaceIndexStats, settingsCategory, settingsOpen]);

  useEffect(() => {
    if (!uiStateLoaded || !launchTargetLoaded) return;
    refreshFiles().catch((reason) => {
      setError(String(reason));
      setStatus("Workspace load failed");
    });
  }, [launchTargetLoaded, refreshFiles, uiStateLoaded]);

  useEffect(() => {
    const handleFocus = () => checkOpenFilesDiskState("focus");
    const handleVisibilityChange = () => {
      if (!document.hidden) checkOpenFilesDiskState("focus");
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkOpenFilesDiskState]);

  useEffect(() => {
    if (openFiles.length === 0) return;

    const timer = window.setInterval(
      () => checkOpenFilesDiskState("background"),
      openFileDiskCheckIntervalMs,
    );
    return () => window.clearInterval(timer);
  }, [checkOpenFilesDiskState, openFiles.length, openFilePathSignature]);

  useEffect(() => {
    const query = contentQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearchResultsTruncated(false);
      setSearchStats({});
      setSearching(false);
      return;
    }

    setSearching(true);
    setSearchResults([]);
    setError(undefined);
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      const searchPromise = singleFileMode && singleFilePath
        ? readFile(
            singleFilePath,
            maxOpenFileKb * 1024,
            allowExternalSymlinksRef.current,
          ).then((contents) => {
            const limit = currentFileSearchResultLimit;
            const matches = currentFileMatches(
              singleFilePath,
              contents,
              query,
              limit + 1,
            );
            const truncated = matches.length > limit;
            return {
              matches: matches.slice(0, limit),
              truncated,
              limit,
              searchedFiles: 1,
              skippedFiles: 0,
            };
          })
        : searchFiles(
            query,
            workspaceSearchResultLimit,
            workspaceSearchMaxFileKb * 1024,
            showDotfiles,
          );

      searchPromise
        .then((result) => {
          if (cancelled) return;
          const normalized = normalizeSearchResult(result);
          if (!normalized) {
            throw new Error("Workspace search response was not valid JSON");
          }
          setSearchResults(normalized.matches);
          setSearchResultsTruncated(normalized.truncated);
          setSearchResultLimitHit(normalized.limit);
          setSearchStats({
            searchedFiles: normalized.searchedFiles,
            skippedFiles: normalized.skippedFiles,
          });
          setStatus(
            normalized.truncated
              ? `First ${normalized.matches.length} matches`
              : normalized.matches.length === 1
                ? "1 match"
                : `${normalized.matches.length} matches`,
          );
        })
        .catch((reason) => {
          if (cancelled) return;
          setError(`Search failed: ${String(reason)}`);
          setSearchResults([]);
          setSearchResultsTruncated(false);
          setSearchStats({});
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [
    contentQuery,
    currentFileSearchResultLimit,
    maxOpenFileKb,
    singleFileMode,
    singleFilePath,
    showDotfiles,
    workspaceSearchMaxFileKb,
    workspaceSearchResultLimit,
  ]);

  useEffect(() => {
    setLspErrorHandler(setError);
    setLspStatusHandler(refreshLspStatus);
    setLspDiagnosticsHandler((filePath, nextDiagnostics) => {
      setDiagnosticsByPath((current) => ({
        ...current,
        [filePath]: nextDiagnostics,
      }));
    });
  }, [refreshLspStatus]);

  useEffect(() => {
    // Diff tabs are a synthetic inspection surface, not a real open file — an
    // agent asking "what's open" shouldn't see the `diff://` pseudo-path.
    const realOpenFiles = openFiles.filter((file) => !file.diff);
    const context: AgentContext = {
      activeFile: realOpenFiles.some((file) => file.path === activePath)
        ? activePath
        : undefined,
      openFiles: realOpenFiles.map((file) => file.path),
      selection: activeSelection,
      diagnostics,
    };
    updateAgentContext(context).catch((reason) => {
      setError(`Unable to update agent editor context: ${String(reason)}`);
    });
  }, [activePath, activeSelection, diagnostics, openFiles]);

  const openPath = useCallback(
    async (
      entry: FileEntry,
      pinned = false,
      lineNumber?: number,
      recordAsSingleFile = singleFileMode,
    ) => {
      if (entry.isDir || trackActiveFile) {
        setSelectedPath(entry.path);
      }
      setOpenFailure(undefined);
      if (lineNumber) {
        setRevealTarget({ path: entry.path, lineNumber });
      } else {
        setRevealTarget(undefined);
      }

      if (entry.isDir) return;
      if (isKnownBinaryFile(entry.name)) {
        setActivePath(undefined);
        setStatus(`${entry.path} selected`);
        return;
      }

      setError(undefined);
      setStatus(`Opening ${entry.path}`);

      const existing = openFiles.find((file) => file.path === entry.path);
      if (existing) {
        if (pinned && !existing.pinned) {
          setOpenFiles((current) => pinTab(current, entry.path));
        }
        setActivePath(existing.path);
        void checkOpenFileDiskState(existing.path, "activate");
        recordRecentFile(existing.path, recordAsSingleFile).catch((reason) => {
          setError(`Unable to update recent files: ${String(reason)}`);
        });
        setStatus("Ready");
        return;
      }

      // Opening an external symlinked file reads outside the workspace; require trust.
      if (entry.isExternal && !allowExternalSymlinksRef.current) {
        setPendingSymlinkTrust({ entry, action: "open" });
        setStatus("Ready");
        return;
      }

      try {
        const diskFile = await readOpenFileFromDisk(entry.path);
        setOpenFiles((current) =>
          addPreviewTab(current, {
            path: entry.path,
            contents: diskFile.contents,
            dirty: false,
            modifiedMs: diskFile.modifiedMs,
            pinned,
          }),
        );
        setActivePath(entry.path);
        recordRecentFile(entry.path, recordAsSingleFile).catch((reason) => {
          setError(`Unable to update recent files: ${String(reason)}`);
        });
        setStatus("Ready");
      } catch (reason) {
        const message = String(reason);
        setOpenFailure({ path: entry.path, reason: message });
        setActivePath(undefined);
        setError(message);
        setStatus("Open failed");
      }
    },
    [
      checkOpenFileDiskState,
      openFiles,
      readOpenFileFromDisk,
      singleFileMode,
      trackActiveFile,
    ],
  );

  const confirmSymlinkTrust = useCallback(
    (scope: "once" | "workspace") => {
      const pending = pendingSymlinkTrust;
      if (!pending) return;
      // Apply to the ref immediately so the retried action sees the grant before
      // the state update has flushed.
      allowExternalSymlinksRef.current = true;
      if (scope === "workspace") {
        setTrustExternalWorkspace(true);
      } else {
        setTrustExternalSession(true);
      }
      setPendingSymlinkTrust(undefined);
      if (pending.action === "open") {
        void openPath(pending.entry);
      } else {
        toggleFolder(pending.entry.path);
      }
    },
    [openPath, pendingSymlinkTrust, toggleFolder],
  );

  const cancelSymlinkTrust = useCallback(() => {
    setPendingSymlinkTrust(undefined);
  }, []);

  useEffect(() => {
    // Diff tabs are a synthetic key with no corresponding workspace tree
    // node, so there's nothing real to select or expand toward.
    if (!trackActiveFile || !activePath || singleFileMode || activeFile?.diff) return;

    setSelectedPath(activePath);
    const parentPaths = parentFolderPaths(activePath);
    if (parentPaths.length === 0) return;

    setExpandedFolders((current) => {
      let changed = false;
      const next = new Set(current);
      for (const parentPath of parentPaths) {
        if (!next.has(parentPath)) {
          next.add(parentPath);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [activePath, singleFileMode, trackActiveFile]);

  const openPathByName = useCallback(
    async (path: string, pinned = false, lineNumber?: number) => {
      const entry =
        files.find((candidate) => candidate.path === path) ??
        quickOpenIndexedResults.find((candidate) => candidate.path === path) ??
        fileEntryForDirectOpen(path);
      await openPath(entry, pinned, lineNumber);
    },
    [files, openPath, quickOpenIndexedResults],
  );

  // Opens a read-only worktree-vs-HEAD diff under the synthetic `diff://`
  // key, as a preview (unpinned) tab — the same idiom as single-clicking a
  // tree file, so opening a second diff replaces the first unless pinned.
  const openDiffTab = useCallback(
    async (filePath: string) => {
      const key = `diff://${filePath}`;
      try {
        const diff = await loadGitFileDiff(filePath, maxOpenFileKb * 1024);
        setOpenFiles((current) =>
          addPreviewTab(current, {
            path: key,
            contents: diff.modified,
            dirty: false,
            pinned: false,
            diff: { filePath, ...diff },
          }),
        );
        setActivePath(key);
      } catch (reason) {
        setGitCommitError(`Unable to load diff for ${filePath}: ${String(reason)}`);
      }
    },
    [maxOpenFileKb],
  );

  useEffect(() => {
    if (initialFileOpenedRef.current || !initialFile || workspaceLoading) return;
    const entry =
      files.find((candidate) => candidate.path === initialFile) ??
      fileEntryForDirectOpen(initialFile);
    initialFileOpenedRef.current = true;
    openPath(entry, true, undefined, true);
  }, [files, initialFile, openPath, workspaceLoading]);

  useEffect(() => {
    if (
      !uiStateLoaded ||
      workspaceLoading ||
      singleFileMode ||
      workspaceLoadFailed ||
      persistedFilesRestoredRef.current
    ) {
      return;
    }

    persistedFilesRestoredRef.current = true;
    const workspaceState = persistedWorkspaceRef.current;
    const entriesByPath = new Map(files.map((entry) => [entry.path, entry]));
    const restorePaths = workspaceState.openFiles.filter((path) => {
      const entry = entriesByPath.get(path);
      return entry && !entry.isDir && !isKnownBinaryFile(entry.name);
    });

    if (restorePaths.length === 0) {
      setWorkspaceUiRestored(true);
      return;
    }

    let disposed = false;
    Promise.all(
      restorePaths.map(async (path) => {
        try {
          const diskFile = await readOpenFileFromDisk(path);
          return {
            tab: {
              path,
              contents: diskFile.contents,
              dirty: false,
              modifiedMs: diskFile.modifiedMs,
              pinned: true,
            },
          };
        } catch (reason) {
          return {
            failure: {
              path,
              reason: String(reason),
            },
          };
        }
      }),
    )
      .then((restoreResults) => {
        if (disposed) return;
        const restoredTabs: EditorTab[] = [];
        const failures: OpenFailure[] = [];
        for (const result of restoreResults) {
          if (result.tab) restoredTabs.push(result.tab);
          if (result.failure) failures.push(result.failure);
        }

        if (failures.length > 0) {
          skipNextUiStatePersistRef.current = true;
          setError(
            failures.length === 1
              ? `Unable to restore ${failures[0].path}: ${failures[0].reason}`
              : `Unable to restore ${failures.length} saved tabs: ${failures
                  .map((failure) => failure.path)
                  .join(", ")}`,
          );
        }

        if (restoredTabs.length === 0) {
          return;
        }

        const restoredPaths = new Set(restoredTabs.map((tab) => tab.path));
        setOpenFiles((current) => {
          const currentPaths = new Set(current.map((tab) => tab.path));
          return [
            ...current,
            ...restoredTabs.filter((tab) => !currentPaths.has(tab.path)),
          ];
        });
        if (workspaceState.activeFile && restoredPaths.has(workspaceState.activeFile)) {
          setActivePath(workspaceState.activeFile);
        } else {
          setActivePath(restoredTabs[0]?.path);
        }
        setStatus("Ready");
      })
      .catch((reason) => {
        if (!disposed) {
          setError(`Unable to restore saved tabs: ${String(reason)}`);
        }
      })
      .finally(() => {
        if (!disposed) setWorkspaceUiRestored(true);
      });

    return () => {
      disposed = true;
    };
  }, [
    files,
    readOpenFileFromDisk,
    singleFileMode,
    uiStateLoaded,
    workspaceLoadFailed,
    workspaceLoading,
  ]);

  useEffect(() => {
    if (!uiStateLoaded || !workspaceUiRestored) return;
    if (singleFileMode) return;
    if (skipNextUiStatePersistRef.current) {
      skipNextUiStatePersistRef.current = false;
      return;
    }

    window.clearTimeout(uiPersistTimerRef.current);
    uiPersistTimerRef.current = window.setTimeout(() => {
      updateUiState(
        {
          showDotfiles,
          showGeneratedInternal,
          showGitignoredFiles,
          showDiagnosticsPanel,
          trackActiveFile,
          treeScanLimit,
          maxOpenFileKb,
          workspaceSearchResultLimit,
          workspaceSearchMaxFileKb,
          currentFileSearchResultLimit,
          currentFileResultPreviewLimit,
          quickOpenResultLimit,
          backgroundIndexBatchEntries,
          commandPaletteResultLimit,
          editorFontSize,
          appZoomPercent,
          dateTimeFormat,
          recentRelativeThreshold,
          diffViewMode,
          featureFlags,
        },
        {
          expandedFolders: [...expandedFolders],
          // Diff tabs are synthetic (`diff://…`) and must not survive a
          // relaunch — persist only the real open-file paths.
          openFiles: openFiles.filter((file) => !file.diff).map((file) => file.path),
          activeFile: activeFile?.diff ? undefined : activePath,
          selectedPath,
          sidebarWidth,
          commitMessageHeight,
          trustExternalSymlinks: trustExternalWorkspace,
        },
      ).catch((reason) => {
        setError(`Unable to save UI state: ${String(reason)}`);
      });
    }, 250);

    return () => window.clearTimeout(uiPersistTimerRef.current);
  }, [
    activePath,
    expandedFolders,
    trustExternalWorkspace,
    openFilePathSignature,
    selectedPath,
    sidebarWidth,
    commitMessageHeight,
    showDotfiles,
    showGeneratedInternal,
    showGitignoredFiles,
    showDiagnosticsPanel,
    trackActiveFile,
    singleFileMode,
    treeScanLimit,
    maxOpenFileKb,
    workspaceSearchResultLimit,
    workspaceSearchMaxFileKb,
    currentFileSearchResultLimit,
    currentFileResultPreviewLimit,
    quickOpenResultLimit,
    backgroundIndexBatchEntries,
    commandPaletteResultLimit,
    editorFontSize,
    appZoomPercent,
    dateTimeFormat,
    recentRelativeThreshold,
    diffViewMode,
    featureFlags,
    uiStateLoaded,
    workspaceUiRestored,
  ]);

  useEffect(() => {
    if (singleFileMode || workspaceLoading || workspaceLoadFailed || files.length === 0) {
      return;
    }

    let disposed = false;
    let timer: number | undefined;

    const runBatch = async () => {
      try {
        const stats = await advanceWorkspaceIndex(
          backgroundIndexBatchEntries,
          showDotfiles,
          showGeneratedInternal,
          showGitignoredFiles,
        );
        if (disposed) return;

        setWorkspaceIndexStats(stats);
        if (stats.pendingFolders > 0) {
          timer = window.setTimeout(runBatch, 800);
        }
      } catch (reason) {
        if (!disposed) {
          setError(`Workspace background indexing failed: ${String(reason)}`);
        }
      }
    };

    timer = window.setTimeout(runBatch, 600);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [
    backgroundIndexBatchEntries,
    files.length,
    showDotfiles,
    showGeneratedInternal,
    showGitignoredFiles,
    singleFileMode,
    workspaceLoading,
    workspaceLoadFailed,
    workspaceRoot,
  ]);

  const closeQuickOpen = useCallback(() => {
    setQuickOpenVisible(false);
    setQuickOpenQuery("");
    setQuickOpenIndex(0);
    setQuickOpenIndexedResults([]);
    setQuickOpenSearching(false);
  }, []);

  useEffect(() => {
    if (!quickOpenVisible || singleFileMode) {
      setQuickOpenIndexedResults([]);
      setQuickOpenSearching(false);
      return;
    }

    let disposed = false;
    setQuickOpenSearching(true);
    const timeout = window.setTimeout(() => {
      searchIndexedFiles(
        quickOpenQuery,
        quickOpenResultLimit,
        showDotfiles,
        showGeneratedInternal,
        showGitignoredFiles,
      )
        .then((entries) => {
          if (disposed) return;
          setQuickOpenIndexedResults(entries);
        })
        .catch((reason) => {
          if (disposed) return;
          setQuickOpenIndexedResults([]);
          setError(`Indexed file search failed: ${String(reason)}`);
          setStatus("File search failed");
        })
        .finally(() => {
          if (!disposed) setQuickOpenSearching(false);
        });
    }, 120);

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
    };
  }, [
    quickOpenQuery,
    quickOpenResultLimit,
    quickOpenVisible,
    showDotfiles,
    showGeneratedInternal,
    showGitignoredFiles,
    singleFileMode,
  ]);

  const closeCommandPalette = useCallback(() => {
    setCommandPaletteVisible(false);
    setCommandPaletteQuery("");
    setCommandPaletteIndex(0);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => !current);
  }, []);

  const zoomEditor = useCallback((direction: 1 | -1) => {
    const next = sanitizeNumberMinimum(
      editorFontSize + direction * editorFontSizeStep,
      minEditorFontSize,
      defaultEditorFontSize,
    );
    setEditorFontSize(next);
    setStatus(`Editor font size ${next}px`);
  }, [editorFontSize]);

  const zoomApp = useCallback((direction: 1 | -1) => {
    const next = sanitizeNumberMinimum(
      appZoomPercent + direction * appZoomStepPercent,
      minAppZoomPercent,
      defaultAppZoomPercent,
    );
    setAppZoomPercent(next);
    setStatus(`App zoom ${next}%`);
  }, [appZoomPercent]);

  const setBoundedSidebarWidth = useCallback((value: number) => {
    setSidebarWidth(
      sanitizeNumberLimit(
        value,
        minSidebarWidth,
        maxSidebarWidth,
        defaultSidebarWidth,
      ),
    );
  }, []);

  const beginSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (sidebarCollapsed) return;
      event.preventDefault();
      sidebarResizeRef.current = {
        startX: event.clientX,
        startWidth: sidebarWidth,
      };
    },
    [sidebarCollapsed, sidebarWidth],
  );

  const handleSidebarResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      setBoundedSidebarWidth(sidebarWidth + direction * sidebarWidthStep);
    },
    [setBoundedSidebarWidth, sidebarWidth],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resize = sidebarResizeRef.current;
      if (!resize) return;
      const appZoom = appZoomPercent / 100;
      setBoundedSidebarWidth(resize.startWidth + (event.clientX - resize.startX) / appZoom);
    };
    const handlePointerUp = () => {
      sidebarResizeRef.current = undefined;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [appZoomPercent, setBoundedSidebarWidth]);

  const setBoundedCommitMessageHeight = useCallback((value: number) => {
    setCommitMessageHeight(
      sanitizeNumberLimit(
        value,
        minCommitMessageHeight,
        maxCommitMessageHeight,
        defaultCommitMessageHeight,
      ),
    );
  }, []);

  const beginCommitMessageResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      commitMessageResizeRef.current = {
        startY: event.clientY,
        startHeight: commitMessageHeight,
      };
    },
    [commitMessageHeight],
  );

  const handleCommitMessageResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? 1 : -1;
      setBoundedCommitMessageHeight(commitMessageHeight + direction * commitMessageHeightStep);
    },
    [commitMessageHeight, setBoundedCommitMessageHeight],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resize = commitMessageResizeRef.current;
      if (!resize) return;
      const appZoom = appZoomPercent / 100;
      // The handle sits above the textarea, so dragging it further up (a
      // smaller clientY) should grow the box, not shrink it.
      setBoundedCommitMessageHeight(
        resize.startHeight + (resize.startY - event.clientY) / appZoom,
      );
    };
    const handlePointerUp = () => {
      commitMessageResizeRef.current = undefined;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [appZoomPercent, setBoundedCommitMessageHeight]);

  const openNewFileDialog = useCallback(() => {
    setError(undefined);
    setNewFilePath(suggestedNewFilePath);
    setNewFileDialogOpen(true);
  }, [suggestedNewFilePath]);

  const closeNewFileDialog = useCallback(() => {
    setNewFileDialogOpen(false);
    setNewFilePath("");
  }, []);

  const openNewFolderDialog = useCallback(() => {
    setError(undefined);
    setNewFolderPath(suggestedNewFolderPath);
    setNewFolderDialogOpen(true);
  }, [suggestedNewFolderPath]);

  const closeNewFolderDialog = useCallback(() => {
    setNewFolderDialogOpen(false);
    setNewFolderPath("");
  }, []);

  const openRenameDialog = useCallback(() => {
    if (!selectedEntry) {
      setError("Select a file or folder to rename.");
      setStatus("Rename failed");
      return;
    }

    setError(undefined);
    setRenameFromPath(selectedEntry.path);
    setRenameToPath(selectedEntry.path);
    setRenameDialogOpen(true);
  }, [selectedEntry]);

  const closeRenameDialog = useCallback(() => {
    setRenameDialogOpen(false);
    setRenameFromPath("");
    setRenameToPath("");
  }, []);

  const requestDeleteSelectedFile = useCallback(() => {
    if (!selectedEntry) {
      setError("Select a file or folder to delete.");
      setStatus("Delete failed");
      return;
    }

    setError(undefined);
    setPendingDeletePath(selectedEntry.path);
  }, [selectedEntry]);

  useEffect(() => {
    setQuickOpenIndex((current) =>
      clampQuickOpenSelection(current, quickOpenResults.length),
    );
  }, [quickOpenResults.length]);

  const openQuickPath = useCallback(
    async (path: string, pinned = false) => {
      await openPathByName(path, pinned);
      closeQuickOpen();
    },
    [closeQuickOpen, openPathByName],
  );

  const updateContents = useCallback((path: string, contents: string) => {
    setOpenFiles((current) => updateTabContents(current, path, contents));
  }, []);

  const revealCurrentFileMatch = useCallback((match: SearchMatch, index?: number) => {
    if (index !== undefined) setCurrentFindIndex(index);
    setRevealTarget({
      path: match.path,
      lineNumber: match.lineNumber,
      matchStart: match.matchStart,
      matchEnd: match.matchEnd,
    });
    setStatus(`Found ${match.path}:${match.lineNumber}`);
  }, []);

  const revealCurrentFindMatch = useCallback(
    (direction: 1 | -1) => {
      if (!activeFile) {
        setStatus("Find in file requires an open file");
        return;
      }
      if (currentFindResults.length === 0) {
        setStatus("No matches in file");
        return;
      }

      const nextIndex = nextCurrentFileMatchIndex(
        currentFindIndex,
        direction,
        currentFindResults.length,
      );
      const match = currentFindResults[nextIndex];
      setCurrentFindIndex(nextIndex);
      setRevealTarget({
        path: match.path,
        lineNumber: match.lineNumber,
        preserveFocus: true,
        matchStart: match.matchStart,
        matchEnd: match.matchEnd,
      });
      setStatus(
        `Match ${nextIndex + 1} of ${currentFindResults.length} at ${match.path}:${match.lineNumber}`,
      );
    },
    [activeFile, currentFindIndex, currentFindResults],
  );

  const closeFile = useCallback((path: string) => {
    setOpenFiles((current) => {
      const remaining = current.filter((file) => file.path !== path);
      setActivePath((active) => nextActivePathAfterClose(current, active, path));
      return remaining;
    });
    setPendingClosePath((current) => (current === path ? undefined : current));
  }, []);

  const requestCloseFile = useCallback(
    (path: string) => {
      if (tabCloseRequiresConfirmation(openFiles, path)) {
        setPendingClosePath(path);
        return;
      }

      closeFile(path);
    },
    [closeFile, openFiles],
  );

  const requestCloseActiveFile = useCallback(() => {
    if (!activePath) return;
    requestCloseFile(activePath);
  }, [activePath, requestCloseFile]);

  const activateAdjacentTab = useCallback(
    (direction: 1 | -1) => {
      const nextPath = adjacentTabPath(openFiles, activePath, direction);
      setActivePath(nextPath);
      if (nextPath) {
        void checkOpenFileDiskState(nextPath, "activate");
      }
    },
    [activePath, checkOpenFileDiskState, openFiles],
  );

  const saveFile = useCallback(async (fileToSave: EditorTab) => {
    setError(undefined);
    setStatus(`Saving ${fileToSave.path}`);
    savingPathsRef.current.add(fileToSave.path);
    try {
      await writeFile(
        fileToSave.path,
        fileToSave.contents,
        fileToSave.modifiedMs,
        allowExternalSymlinksRef.current,
      );
      const savedEntry = await statFile(fileToSave.path);
      setOpenFiles((current) =>
        current.map((file) =>
          file.path === fileToSave.path && file.contents === fileToSave.contents
            ? { ...file, dirty: false, modifiedMs: savedEntry.modifiedMs }
            : file,
        ),
      );
      await refreshFiles();
      setStatus("Saved");
      return true;
    } catch (reason) {
      setError(String(reason));
      setStatus("Save failed");
      return false;
    } finally {
      savingPathsRef.current.delete(fileToSave.path);
    }
  }, [refreshFiles]);

  const saveActive = useCallback(async () => {
    if (!activeFile) return;
    if (!activeFile.dirty) {
      setStatus("No unsaved changes");
      return;
    }
    await saveFile(activeFile);
  }, [activeFile, saveFile]);

  const saveAll = useCallback(async () => {
    if (!hasDirtyFiles) {
      setStatus("No unsaved files");
      return true;
    }

    for (const file of dirtyFiles) {
      const saved = await saveFile(file);
      if (!saved) return false;
    }
    setStatus(`Saved ${dirtyTabSummary(dirtyFiles)}`);
    return true;
  }, [dirtyFiles, hasDirtyFiles, saveFile]);

  const closeAllFiles = useCallback(() => {
    setOpenFiles([]);
    setActivePath(undefined);
    setPendingClosePath(undefined);
    setPendingCloseAll(false);
    setRevealTarget(undefined);
    setSelection(undefined);
    setCurrentFileQuery("");
    setCurrentFindOpen(false);
    setStatus("Closed all files");
  }, []);

  const requestCloseAllFiles = useCallback(() => {
    if (openFiles.length === 0) return;
    if (openFiles.some((file) => file.dirty)) {
      setPendingCloseAll(true);
      return;
    }

    closeAllFiles();
  }, [closeAllFiles, openFiles]);

  const saveAllAndCloseFiles = useCallback(async () => {
    const saved = await saveAll();
    if (!saved) return;
    closeAllFiles();
  }, [closeAllFiles, saveAll]);

  const reloadFileFromDisk = useCallback(async (path: string) => {
    setError(undefined);
    setStatus(`Reloading ${path}`);
    try {
      const diskFile = await readOpenFileFromDisk(path);
      await refreshFiles();
      setOpenFiles((current) =>
        current.map((file) =>
          file.path === path
            ? {
                ...file,
                contents: diskFile.contents,
                dirty: false,
                modifiedMs: diskFile.modifiedMs,
              }
            : file,
        ),
      );
      setRevealTarget((current) => (current?.path === path ? undefined : current));
      setSelection((current) => (current?.filePath === path ? undefined : current));
      setPendingReloadRequest(undefined);
      setStatus(`Reloaded ${path}`);
      return true;
    } catch (reason) {
      setError(String(reason));
      setStatus("Reload failed");
      return false;
    }
  }, [readOpenFileFromDisk, refreshFiles]);

  const requestReloadActiveFile = useCallback(() => {
    if (!activeFile) {
      setStatus("Reload from disk requires an open file");
      return;
    }
    if (activeFile.dirty) {
      setPendingReloadRequest({ path: activeFile.path, reason: "manual" });
      return;
    }

    reloadFileFromDisk(activeFile.path);
  }, [activeFile, reloadFileFromDisk]);

  const requestEditorCommand = useCallback(
    (name: EditorCommandName, replace?: EditorReplacePayload) => {
      if (!activeFile) {
        setStatus(`${editorCommandLabel(name)} requires an open file`);
        return;
      }

      editorCommandNonceRef.current += 1;
      setEditorCommand({
        filePath: activeFile.path,
        name,
        nonce: editorCommandNonceRef.current,
        replace,
      });
    },
    [activeFile],
  );

  const replaceTargetsFrom = useCallback(
    (matches: SearchMatch[]): EditorReplacePayload => ({
      replacement: replaceQuery,
      targets: matches.map((match) => ({
        line: match.lineNumber,
        matchStart: match.matchStart,
        matchEnd: match.matchEnd,
      })),
    }),
    [replaceQuery],
  );

  const replaceCurrentMatch = useCallback(() => {
    if (!activeFile) {
      setStatus("Find in file requires an open file");
      return;
    }
    if (currentFindResults.length === 0) {
      setStatus("No matches to replace");
      return;
    }

    const targetIndex =
      currentFindIndex >= 0 && currentFindIndex < currentFindResults.length
        ? currentFindIndex
        : 0;
    requestEditorCommand(
      "replaceMatch",
      replaceTargetsFrom([currentFindResults[targetIndex]]),
    );
  }, [
    activeFile,
    currentFindIndex,
    currentFindResults,
    replaceTargetsFrom,
    requestEditorCommand,
  ]);

  const replaceAllMatches = useCallback(() => {
    if (!activeFile) {
      setStatus("Find in file requires an open file");
      return;
    }
    // The find preview caps results at currentFileSearchResultLimit; replacing
    // only that capped set would silently skip later matches in large files. So
    // recompute over the full file — but bound it so a pathological query (e.g. a
    // single character in a huge file) can't allocate an unbounded array and freeze
    // the editor on one giant transaction.
    const allMatches = currentFileMatches(
      activeFile.path,
      activeFile.contents,
      currentFileQuery,
      replaceAllMatchLimit,
    );
    if (allMatches.length === 0) {
      setStatus("No matches to replace");
      return;
    }

    requestEditorCommand("replaceAll", replaceTargetsFrom(allMatches));
    if (allMatches.length >= replaceAllMatchLimit) {
      setStatus(
        `Replaced the first ${replaceAllMatchLimit.toLocaleString()} matches — run Replace All again for the rest`,
      );
    }
  }, [activeFile, currentFileQuery, replaceTargetsFrom, requestEditorCommand]);

  const openReplaceInFile = useCallback(() => {
    if (!activeFile) {
      setStatus("Replace in file requires an open file");
      return;
    }
    setCurrentFindOpen(true);
    setReplaceVisible(true);
    // Defer focus until the replace input has mounted in the expanded overlay.
    requestAnimationFrame(() => replaceInputRef.current?.focus());
  }, [activeFile]);

  const openQuickOpen = useCallback(() => {
    setCommandPaletteVisible(false);
    setCommandPaletteQuery("");
    setCommandPaletteIndex(0);
    setQuickOpenVisible(true);
  }, []);

  const openCommandPalette = useCallback(() => {
    setQuickOpenVisible(false);
    setQuickOpenQuery("");
    setQuickOpenIndex(0);
    setCommandPaletteQuery("");
    setCommandPaletteIndex(0);
    setCommandPaletteVisible(true);
  }, []);

  const openCurrentFileFind = useCallback(() => {
    if (!activeFile || activeFile.diff) {
      setStatus("Find in file requires an open file");
      return;
    }

    setCurrentFindOpen(true);
  }, [activeFile]);

  const openGoToLineDialog = useCallback(() => {
    if (!activeFile || activeFile.diff) {
      setStatus("Go to line requires an open file");
      return;
    }

    setError(undefined);
    setCommandPaletteVisible(false);
    setCommandPaletteQuery("");
    setCommandPaletteIndex(0);
    setQuickOpenVisible(false);
    setQuickOpenQuery("");
    setQuickOpenIndex(0);
    setGoToLineValue(
      cursor?.filePath === activeFile.path ? String(cursor.line) : "",
    );
    setGoToLineDialogOpen(true);
  }, [activeFile, cursor]);

  const closeGoToLineDialog = useCallback(() => {
    setGoToLineDialogOpen(false);
    setGoToLineValue("");
  }, []);

  const goToLine = useCallback(() => {
    if (!activeFile || activeFile.diff) {
      closeGoToLineDialog();
      setStatus("Go to line requires an open file");
      return;
    }

    const requestedLine = positiveWholeNumber(goToLineValue);
    if (!requestedLine) {
      setError("Line number must be a positive whole number.");
      setStatus("Go to line failed");
      return;
    }

    const targetLine = Math.min(requestedLine, documentLineCount(activeFile.contents));
    setError(undefined);
    setRevealTarget({ path: activeFile.path, lineNumber: targetLine });
    setStatus(`Moved to ${activeFile.path}:${targetLine}`);
    closeGoToLineDialog();
  }, [activeFile, closeGoToLineDialog, goToLineValue]);

  const openWorkspaceSearch = useCallback(() => {
    setActiveSidebarSearch("content");
  }, []);

  const handleFilterSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape") return;

      event.preventDefault();
      event.stopPropagation();
      if (filter.length > 0) {
        setFilter("");
        return;
      }

      setActiveSidebarSearch((current) =>
        current === "filter" ? undefined : current,
      );
    },
    [filter],
  );

  const handleContentSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape") return;

      event.preventDefault();
      event.stopPropagation();
      if (contentQuery.length > 0) {
        setContentQuery("");
        setSearchResults([]);
        setSearching(false);
        return;
      }

      setActiveSidebarSearch((current) =>
        current === "content" ? undefined : current,
      );
    },
    [contentQuery],
  );

  const handleCurrentFindKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        revealCurrentFindMatch(event.shiftKey ? -1 : 1);
        return;
      }

      // Arrow up/down step through matches and select each in the editor while
      // focus stays in the find input, so you can bounce around the file.
      if (event.key === "ArrowDown") {
        event.preventDefault();
        revealCurrentFindMatch(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        revealCurrentFindMatch(-1);
        return;
      }

      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (currentFileQuery.length > 0) {
        setCurrentFileQuery("");
        setCurrentFindIndex(-1);
        return;
      }

      setReplaceVisible(false);
      setCurrentFindOpen(false);
    },
    [currentFileQuery, revealCurrentFindMatch],
  );

  const handleReplaceKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        // Cmd/Ctrl+Enter = Replace All (matches the button title); plain Enter =
        // replace current. Alt is deliberately excluded — Alt+Enter inserts a
        // newline on some layouts and shouldn't rewrite the whole file.
        if (event.metaKey || event.ctrlKey) {
          replaceAllMatches();
        } else {
          replaceCurrentMatch();
        }
        return;
      }

      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setReplaceVisible(false);
      currentFindInputRef.current?.focus();
    },
    [replaceAllMatches, replaceCurrentMatch],
  );

  const cancelReloadActiveFile = useCallback(() => {
    const request = pendingReloadRequestRef.current;
    if (request?.reason === "external") {
      setOpenFiles((current) =>
        current.map((file) =>
          file.path === request.path && file.dirty
            ? { ...file, modifiedMs: request.diskModifiedMs }
            : file,
        ),
      );
      setStatus(`Keeping editor changes for ${request.path}`);
    }
    setPendingReloadRequest(undefined);
  }, []);

  const copyText = useCallback(async (label: string, value: string) => {
    setError(undefined);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API is not available in this environment");
      }
      await navigator.clipboard.writeText(value);
      setStatus(`Copied ${label}`);
    } catch (reason) {
      setError(`Unable to copy ${label}: ${String(reason)}`);
      setStatus("Copy failed");
    }
  }, []);

  const saveAndClosePendingFile = useCallback(async () => {
    if (!pendingCloseFile) {
      setPendingClosePath(undefined);
      return;
    }

    const saved = await saveFile(pendingCloseFile);
    if (saved) closeFile(pendingCloseFile.path);
  }, [closeFile, pendingCloseFile, saveFile]);

  const closeApplication = useCallback(async () => {
    try {
      const closed = await destroyNativeWindow();
      if (!closed) {
        setPendingAppClose(false);
        setStatus("Ready");
      }
    } catch (reason) {
      setError(`Unable to close window: ${String(reason)}`);
      setStatus("Close failed");
    }
  }, []);

  const saveAllAndCloseApplication = useCallback(async () => {
    const saved = await saveAll();
    if (!saved) return;
    await closeApplication();
  }, [closeApplication, saveAll]);

  const clearWorkspaceUi = useCallback(() => {
    persistedWorkspaceRef.current = {
      expandedFolders: [],
      openFiles: [],
    };
    persistedFilesRestoredRef.current = false;
    setWorkspaceUiRestored(false);
    setOpenFiles([]);
    setActivePath(undefined);
    setSelectedPath(undefined);
    setExpandedFolders(new Set());
    setRevealTarget(undefined);
    setSelection(undefined);
    setDiagnosticsByPath({});
    setFilter("");
    setContentQuery("");
    setCurrentFileQuery("");
    setSearchResults([]);
  }, []);

  const openWorkspacePath = useCallback(
    async (path: string) => {
      if (openFiles.some((file) => file.dirty)) {
        setError("Save or close modified files before switching workspace.");
        return;
      }

      setError(undefined);
      setStatus("Opening folder");
      try {
        const selected = await setWorkspaceRootPath(path);
        setSingleFileMode(false);
        setSingleFilePath(undefined);
        setInitialFile(undefined);
        initialFileOpenedRef.current = false;
        clearWorkspaceUi();
        applyPersistedUiSnapshot(await getUiState());
        await refreshFiles({ singleFilePath: undefined });
        setStatus(`Opened ${lastSegment(selected) || selected}`);
      } catch (reason) {
        setError(String(reason));
        setStatus("Open folder failed");
      }
    },
    [applyPersistedUiSnapshot, clearWorkspaceUi, openFiles, refreshFiles],
  );

  const openFileFromWorkspace = useCallback(
    async (workspaceRootPath: string, path: string, singleFile = false) => {
      if (
        (singleFile || workspaceRootPath !== workspaceRoot) &&
        openFiles.some((file) => file.dirty)
      ) {
        setError("Save or close modified files before switching workspace.");
        return;
      }

      setError(undefined);
      setStatus(`Opening ${path}`);
      try {
        let entries = files;
        if (workspaceRootPath !== workspaceRoot) {
          const selected = await setWorkspaceRootPath(workspaceRootPath);
          setWorkspaceRoot(selected);
          setLspRootUri(workspacePathToFileUri(selected));
          clearWorkspaceUi();
          if (singleFile) {
            setSingleFileMode(true);
            setSingleFilePath(path);
            setInitialFile(path);
            initialFileOpenedRef.current = true;
            const entry = await statFile(path);
            setFiles([entry]);
            setOpenFiles([]);
            setActivePath(undefined);
            setSelectedPath(path);
            setWorkspaceLoadFailed(false);
            setWorkspaceUiRestored(true);
            entries = [entry];
          } else {
            setSingleFileMode(false);
            setSingleFilePath(undefined);
            setInitialFile(undefined);
            initialFileOpenedRef.current = false;
            const snapshot = await getUiState();
            if (!snapshot.workspace.openFiles.includes(path)) {
              snapshot.workspace.openFiles = [...snapshot.workspace.openFiles, path];
            }
            snapshot.workspace.activeFile = path;
            snapshot.workspace.selectedPath = path;
            applyPersistedUiSnapshot(snapshot);
            entries = await refreshFiles({ singleFilePath: undefined });
          }
        } else if (singleFile) {
          setSingleFileMode(true);
          setSingleFilePath(path);
          setInitialFile(path);
          initialFileOpenedRef.current = true;
          const entry = await statFile(path);
          setFiles([entry]);
          setOpenFiles([]);
          setActivePath(undefined);
          setSelectedPath(path);
          setWorkspaceLoadFailed(false);
          setWorkspaceUiRestored(true);
          entries = [entry];
        }

        const entry =
          entries.find((candidate) => candidate.path === path) ??
          fileEntryForDirectOpen(path);
        if (!entry || entry.isDir) {
          throw new Error(`File is not in the current workspace: ${path}`);
        }

        await openPath(entry, true, undefined, singleFile);
      } catch (reason) {
        setError(String(reason));
        setStatus("Open file failed");
      }
    },
    [
      applyPersistedUiSnapshot,
      clearWorkspaceUi,
      files,
      openFiles,
      openPath,
      refreshFiles,
      workspaceRoot,
    ],
  );

  const handleOpenLaunchRequest = useCallback(
    (request: OpenLaunchRequest) => {
      if (request.type === "workspace") {
        void openWorkspacePath(request.path);
        return;
      }

      void openFileFromWorkspace(
        request.workspaceRoot,
        request.path,
        request.singleFile,
      );
    },
    [openFileFromWorkspace, openWorkspacePath],
  );

  useEffect(() => {
    if (!isNativeTauri()) return;

    let disposed = false;
    let unlistenCallbacks: NativeUnlisten[] = [];
    const reportUnlistenError = (message: string) => {
      console.warn(message);
    };
    Promise.all([
      listen<{ path: string }>("menu://open-workspace", (event) => {
        runNativeMenuAction(() => {
          handleOpenLaunchRequest({
            type: "workspace",
            path: event.payload.path,
          });
        });
      }),
      listen<{ workspaceRoot: string; path: string; singleFile?: boolean }>("menu://open-file", (event) => {
        runNativeMenuAction(() => {
          handleOpenLaunchRequest({
            type: "file",
            workspaceRoot: event.payload.workspaceRoot,
            path: event.payload.path,
            singleFile: Boolean(event.payload.singleFile),
          });
        });
      }),
      listen("menu://close-tab", () => {
        runNativeMenuAction(requestCloseActiveFile);
      }),
      listen("menu://close-all", () => {
        runNativeMenuAction(requestCloseAllFiles);
      }),
      listen("menu://new-file", () => {
        runNativeMenuAction(openNewFileDialog);
      }),
      listen("menu://new-folder", () => {
        runNativeMenuAction(openNewFolderDialog);
      }),
      listen("menu://save-file", () => {
        runNativeMenuAction(() => void saveActive());
      }),
      listen("menu://save-all", () => {
        runNativeMenuAction(() => void saveAll());
      }),
      listen("menu://reload-file", () => {
        runNativeMenuAction(requestReloadActiveFile);
      }),
      listen("menu://rename-selected", () => {
        runNativeMenuAction(openRenameDialog);
      }),
      listen("menu://delete-selected", () => {
        runNativeMenuAction(requestDeleteSelectedFile);
      }),
      listen("menu://go-to-definition", () => {
        runNativeMenuAction(() => requestEditorCommand("goToDefinition"));
      }),
      listen("menu://find-references", () => {
        runNativeMenuAction(() => requestEditorCommand("findReferences"));
      }),
      listen("menu://command-palette", () => {
        runNativeMenuAction(openCommandPalette);
      }),
      listen("menu://quick-open", () => {
        runNativeMenuAction(openQuickOpen);
      }),
      listen("menu://go-to-line", () => {
        runNativeMenuAction(openGoToLineDialog);
      }),
      listen("menu://find-in-file", () => {
        runNativeMenuAction(openCurrentFileFind);
      }),
      listen("menu://find-in-files", () => {
        runNativeMenuAction(openWorkspaceSearch);
      }),
      listen<string>("app://error", (event) => {
        setError(event.payload);
      }),
      listen("menu://show-integrations", () => {
        runNativeMenuAction(() => setIntegrationsOpen(true));
      }),
      listen("menu://show-key-bindings", () => {
        runNativeMenuAction(() => setKeyBindingsOpen(true));
      }),
      listen("menu://show-about", () => {
        runNativeMenuAction(() => setAboutOpen(true));
      }),
      listen("menu://show-settings", () => {
        runNativeMenuAction(() => setSettingsOpen(true));
      }),
    ])
      .then((callbacks) => {
        if (disposed) {
          unlistenNativeCallbacks(callbacks, reportUnlistenError);
          return;
        }
        unlistenCallbacks = callbacks;
        if (openedLaunchTargetsDrainedRef.current) return undefined;
        openedLaunchTargetsDrainedRef.current = true;
        return takeOpenedLaunchTargets().then((requests) => {
          if (disposed) return;
          requests.forEach(handleOpenLaunchRequest);
        });
      })
      .catch((reason) => {
        if (!disposed) {
          setError(`Unable to register native app menu handlers: ${String(reason)}`);
        }
      });

    return () => {
      disposed = true;
      unlistenNativeCallbacks(unlistenCallbacks, reportUnlistenError);
    };
  }, [
    handleOpenLaunchRequest,
    openFileFromWorkspace,
    openNewFileDialog,
    openNewFolderDialog,
    openCommandPalette,
    openCurrentFileFind,
    openGoToLineDialog,
    openQuickOpen,
    openRenameDialog,
    openWorkspaceSearch,
    openWorkspacePath,
    requestCloseActiveFile,
    requestCloseAllFiles,
    requestDeleteSelectedFile,
    requestEditorCommand,
    requestReloadActiveFile,
    runNativeMenuAction,
    saveActive,
    saveAll,
  ]);

  const openWorkspace = useCallback(async () => {
    if (openFiles.some((file) => file.dirty)) {
      setError("Save or close modified files before switching workspace.");
      return;
    }

    setError(undefined);
    setStatus("Opening folder");
    try {
      const selected = await pickWorkspaceFolder();
      if (!selected) {
        setStatus("Ready");
        return;
      }

      clearWorkspaceUi();
      applyPersistedUiSnapshot(await getUiState());
      await refreshFiles();
      setStatus(`Opened ${lastSegment(selected) || selected}`);
    } catch (reason) {
      setError(String(reason));
      setStatus("Open folder failed");
    }
  }, [applyPersistedUiSnapshot, clearWorkspaceUi, openFiles, refreshFiles]);

  const openFileFromDialog = useCallback(async () => {
    if (openFiles.some((file) => file.dirty)) {
      setError("Save or close modified files before opening another file.");
      return;
    }

    setError(undefined);
    setStatus("Opening file");
    try {
      const selected = await pickOpenFile();
      if (!selected) {
        setStatus("Ready");
        return;
      }

      await openFileFromWorkspace(
        selected.workspaceRoot,
        selected.path,
        selected.singleFile,
      );
    } catch (reason) {
      setError(String(reason));
      setStatus("Open file failed");
    }
  }, [openFileFromWorkspace, openFiles]);

  const commandPaletteCommands = useMemo<AppCommand[]>(
    () => [
      {
        id: "quick_open",
        title: "Go to File",
        detail: "Open a workspace file by path",
        keywords: ["quick open", "open file", "search files"],
        enabled: true,
        run: openQuickOpen,
      },
      {
        id: "find_in_files",
        title: "Find in Files",
        detail: "Search text across the current workspace",
        keywords: ["workspace search", "content search", "grep"],
        enabled: true,
        run: openWorkspaceSearch,
      },
      {
        id: "find_in_file",
        title: "Find in File",
        detail: "Search inside the active file",
        keywords: ["current file search"],
        enabled: Boolean(activeFile) && !activeFile?.diff,
        run: openCurrentFileFind,
      },
      {
        id: "go_to_line",
        title: "Go to Line",
        detail:
          activeFile && !activeFile.diff
            ? `Jump within ${activeFile.path}`
            : "Jump within the active file",
        keywords: ["line number", "jump"],
        enabled: Boolean(activeFile) && !activeFile?.diff,
        run: openGoToLineDialog,
      },
      {
        id: "new_file",
        title: "New File",
        detail: "Create a file in the selected folder",
        keywords: ["create file"],
        enabled: true,
        run: openNewFileDialog,
      },
      {
        id: "new_folder",
        title: "New Folder",
        detail: "Create a folder in the selected folder",
        keywords: ["create folder", "directory"],
        enabled: true,
        run: openNewFolderDialog,
      },
      {
        id: "open_folder",
        title: "Open Folder",
        detail: "Switch to another workspace folder",
        keywords: ["workspace"],
        enabled: nativePickerAvailable,
        run: () => {
          void openWorkspace();
        },
      },
      {
        id: "open_file",
        title: "Open File",
        detail: "Open a file with the native picker",
        keywords: ["file picker"],
        enabled: nativePickerAvailable,
        run: () => {
          void openFileFromDialog();
        },
      },
      {
        id: "save_file",
        title: "Save",
        detail:
          activeFile && !activeFile.diff ? `Save ${activeFile.path}` : "Save the active file",
        keywords: ["write file"],
        enabled: Boolean(activeFile) && !activeFile?.diff,
        run: () => {
          void saveActive();
        },
      },
      {
        id: "save_all",
        title: "Save All",
        detail: "Save all modified files",
        keywords: ["write all files"],
        enabled: hasDirtyFiles,
        run: () => {
          void saveAll();
        },
      },
      {
        id: "reload_file",
        title: "Reload from Disk",
        detail: "Refresh the active file from disk",
        keywords: ["revert", "refresh"],
        enabled: Boolean(activeFile),
        run: requestReloadActiveFile,
      },
      {
        id: "rename_selected",
        title: "Rename Selected",
        detail: selectedEntry
          ? `Rename ${selectedEntry.path}`
          : "Rename the selected file or folder",
        keywords: ["move"],
        enabled: Boolean(selectedEntry),
        run: openRenameDialog,
      },
      {
        id: "delete_selected",
        title: "Delete Selected",
        detail: selectedEntry
          ? `Delete ${selectedEntry.path}`
          : "Delete the selected file or folder",
        keywords: ["remove"],
        enabled: Boolean(selectedEntry),
        run: requestDeleteSelectedFile,
      },
      {
        id: "close_tab",
        title: "Close Tab",
        detail: "Close the active editor tab",
        keywords: ["close file"],
        enabled: Boolean(activeFile),
        run: requestCloseActiveFile,
      },
      {
        id: "close_all",
        title: "Close All",
        detail: "Close all editor tabs",
        keywords: ["close files"],
        enabled: openFiles.length > 0,
        run: requestCloseAllFiles,
      },
      {
        id: "go_to_definition",
        title: "Go to Definition",
        detail: "Ask the active language server for a definition jump",
        keywords: ["lsp", "definition"],
        enabled: Boolean(activeFile),
        run: () => requestEditorCommand("goToDefinition"),
      },
      {
        id: "find_references",
        title: "Find References",
        detail: "Ask the active language server for references",
        keywords: ["lsp", "references"],
        enabled: Boolean(activeFile),
        run: () => requestEditorCommand("findReferences"),
      },
      {
        id: "toggle_sidebar",
        title: sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar",
        detail: "Toggle the file tree",
        keywords: ["view", "files"],
        enabled: true,
        run: toggleSidebar,
      },
      {
        id: "zoom_editor_in",
        title: "Zoom Editor In",
        detail: `Set editor font size to ${editorFontSize + editorFontSizeStep}px`,
        keywords: ["font", "code", "increase"],
        enabled: true,
        run: () => zoomEditor(1),
      },
      {
        id: "zoom_editor_out",
        title: "Zoom Editor Out",
        detail: `Set editor font size to ${Math.max(minEditorFontSize, editorFontSize - editorFontSizeStep)}px`,
        keywords: ["font", "code", "decrease"],
        enabled: true,
        run: () => zoomEditor(-1),
      },
      {
        id: "zoom_app_in",
        title: "Zoom App In",
        detail: `Set app zoom to ${appZoomPercent + appZoomStepPercent}%`,
        keywords: ["view", "ui", "increase"],
        enabled: true,
        run: () => zoomApp(1),
      },
      {
        id: "zoom_app_out",
        title: "Zoom App Out",
        detail: `Set app zoom to ${Math.max(minAppZoomPercent, appZoomPercent - appZoomStepPercent)}%`,
        keywords: ["view", "ui", "decrease"],
        enabled: true,
        run: () => zoomApp(-1),
      },
      {
        id: "show_integrations",
        title: "Show Integrations",
        detail: "Show browser, Claude, Codex, and LSP integration details",
        keywords: ["mcp", "claude", "codex", "lsp"],
        enabled: true,
        run: () => setIntegrationsOpen(true),
      },
      {
        id: "show_key_bindings",
        title: "Key Bindings",
        detail: "Show supported keyboard shortcuts",
        keywords: ["shortcuts", "hotkeys", "keyboard"],
        enabled: true,
        run: () => setKeyBindingsOpen(true),
      },
      {
        id: "show_about",
        title: "About ide",
        detail: "Show app version and project details",
        keywords: ["version", "release", "about"],
        enabled: true,
        run: () => setAboutOpen(true),
      },
      {
        id: "show_settings",
        title: "Settings",
        detail: "Adjust workspace view and scan limits",
        keywords: ["preferences", "dotfiles", "gitignored files", "generated folders", "limit"],
        enabled: true,
        run: () => setSettingsOpen(true),
      },
    ],
    [
      activeFile,
      hasDirtyFiles,
      openCurrentFileFind,
      openGoToLineDialog,
      openNewFileDialog,
      openNewFolderDialog,
      openFileFromDialog,
      openQuickOpen,
      openRenameDialog,
      openWorkspace,
      openWorkspaceSearch,
      openFiles.length,
      requestCloseActiveFile,
      requestCloseAllFiles,
      requestDeleteSelectedFile,
      requestEditorCommand,
      requestReloadActiveFile,
      saveActive,
      saveAll,
      selectedEntry,
      sidebarCollapsed,
      toggleSidebar,
      editorFontSize,
      appZoomPercent,
      zoomEditor,
      zoomApp,
    ],
  );
  const commandPaletteResults = useMemo(
    () =>
      commandPaletteMatches(
        commandPaletteCommands,
        commandPaletteQuery,
        commandPaletteResultLimit,
      ),
    [commandPaletteCommands, commandPaletteQuery, commandPaletteResultLimit],
  );
  const runCommandPaletteCommand = useCallback(
    (command: AppCommand) => {
      if (!command.enabled) {
        setStatus(`${command.title} is unavailable`);
        return;
      }

      closeCommandPalette();
      command.run();
    },
    [closeCommandPalette],
  );

  useEffect(() => {
    setCommandPaletteIndex((current) =>
      clampCommandPaletteSelection(current, commandPaletteResults.length),
    );
  }, [commandPaletteResults.length]);

  const createNewFile = useCallback(async () => {
    const path = newFilePath.trim();
    if (!path) {
      setError("New file path is required.");
      return;
    }

    setError(undefined);
    setStatus(`Creating ${path}`);
    try {
      await createFile(path, allowExternalSymlinksRef.current);
      const refreshedEntries = await refreshFiles();
      const modifiedMs = refreshedEntries.find((entry) => entry.path === path)?.modifiedMs;
      setOpenFiles((current) =>
        addPreviewTab(current, {
          path,
          contents: "",
          dirty: false,
          modifiedMs,
          pinned: true,
        }),
      );
      setActivePath(path);
      setSelectedPath(path);
      setRevealTarget(undefined);
      setSelection(undefined);
      closeNewFileDialog();
      setStatus(`Created ${path}`);
    } catch (reason) {
      setError(String(reason));
      setStatus("Create file failed");
    }
  }, [closeNewFileDialog, newFilePath, refreshFiles]);

  const createNewFolder = useCallback(async () => {
    const path = newFolderPath.trim();
    if (!path) {
      setError("New folder path is required.");
      return;
    }

    setError(undefined);
    setStatus(`Creating ${path}`);
    try {
      await createFolder(path, allowExternalSymlinksRef.current);
      setSelectedPath(path);
      closeNewFolderDialog();
      await refreshFiles();
      setStatus(`Created folder ${path}`);
    } catch (reason) {
      setError(String(reason));
      setStatus("Create folder failed");
    }
  }, [closeNewFolderDialog, newFolderPath, refreshFiles]);

  const renameSelectedEntry = useCallback(async () => {
    const fromPath = renameFromPath.trim();
    const toPath = renameToPath.trim();
    if (!fromPath || !toPath) {
      setError("Rename paths are required.");
      return;
    }
    if (fromPath === toPath) {
      closeRenameDialog();
      setStatus("Ready");
      return;
    }

    setError(undefined);
    setStatus(`Renaming ${fromPath}`);
    try {
      await renameFile(fromPath, toPath, allowExternalSymlinksRef.current);
      const refreshedEntries = await refreshFiles();
      const modifiedMs = refreshedEntries.find((entry) => entry.path === toPath)?.modifiedMs;
      setOpenFiles((current) =>
        current.map((file) =>
          pathIsAtOrInside(file.path, fromPath)
            ? {
                ...file,
                path: renamePathPrefix(file.path, fromPath, toPath),
                modifiedMs: file.path === fromPath ? modifiedMs : file.modifiedMs,
              }
            : file,
        ),
      );
      setActivePath((current) =>
        current && pathIsAtOrInside(current, fromPath)
          ? renamePathPrefix(current, fromPath, toPath)
          : current,
      );
      setSelectedPath((current) =>
        current && pathIsAtOrInside(current, fromPath)
          ? renamePathPrefix(current, fromPath, toPath)
          : toPath,
      );
      setExpandedFolders((current) => {
        const next = new Set<string>();
        for (const path of current) {
          next.add(
            pathIsAtOrInside(path, fromPath)
              ? renamePathPrefix(path, fromPath, toPath)
              : path,
          );
        }
        return next;
      });
      setRevealTarget((current) =>
        current && pathIsAtOrInside(current.path, fromPath)
          ? { ...current, path: renamePathPrefix(current.path, fromPath, toPath) }
          : current,
      );
      setSelection((current) =>
        current && pathIsAtOrInside(current.filePath, fromPath)
          ? { ...current, filePath: renamePathPrefix(current.filePath, fromPath, toPath) }
          : current,
      );
      setDiagnosticsByPath((current) => {
        const next: Record<string, EditorDiagnostic[]> = {};
        for (const [path, diagnostics] of Object.entries(current)) {
          const nextPath = pathIsAtOrInside(path, fromPath)
            ? renamePathPrefix(path, fromPath, toPath)
            : path;
          next[nextPath] = diagnostics.map((diagnostic) => ({
            ...diagnostic,
            filePath: pathIsAtOrInside(diagnostic.filePath, fromPath)
              ? renamePathPrefix(diagnostic.filePath, fromPath, toPath)
              : diagnostic.filePath,
          }));
        }
        return next;
      });
      closeRenameDialog();
      setStatus(`Renamed ${fromPath} to ${toPath}`);
    } catch (reason) {
      setError(String(reason));
      setStatus("Rename failed");
    }
  }, [closeRenameDialog, refreshFiles, renameFromPath, renameToPath]);

  const deleteSelectedEntry = useCallback(async () => {
    if (!pendingDeletePath) return;

    setError(undefined);
    setStatus(`Deleting ${pendingDeletePath}`);
    try {
      await deleteFile(pendingDeletePath);
      setOpenFiles((current) => current.filter((file) => !pathIsAtOrInside(file.path, pendingDeletePath)));
      setActivePath((current) => {
        if (!current || !pathIsAtOrInside(current, pendingDeletePath)) return current;
        return openFiles.find((file) => !pathIsAtOrInside(file.path, pendingDeletePath))?.path;
      });
      setSelectedPath(undefined);
      setRevealTarget((current) =>
        current && pathIsAtOrInside(current.path, pendingDeletePath) ? undefined : current,
      );
      setSelection((current) =>
        current && pathIsAtOrInside(current.filePath, pendingDeletePath) ? undefined : current,
      );
      setDiagnosticsByPath((current) => {
        const next: Record<string, EditorDiagnostic[]> = {};
        for (const [path, diagnostics] of Object.entries(current)) {
          if (!pathIsAtOrInside(path, pendingDeletePath)) {
            next[path] = diagnostics;
          }
        }
        return next;
      });
      setExpandedFolders((current) => {
        const next = new Set<string>();
        for (const path of current) {
          if (!pathIsAtOrInside(path, pendingDeletePath)) next.add(path);
        }
        return next;
      });
      setPendingDeletePath(undefined);
      await refreshFiles();
      setStatus(`Deleted ${pendingDeletePath}`);
    } catch (reason) {
      setError(String(reason));
      setStatus("Delete failed");
    }
  }, [openFiles, pendingDeletePath, refreshFiles]);

  const cancelDeleteSelectedFile = useCallback(() => {
    setPendingDeletePath(undefined);
  }, []);

  useEffect(() => {
    const hasDirtyFiles = dirtyFiles.length > 0;
    const handler = (event: BeforeUnloadEvent) => {
      if (!hasDirtyFiles) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyFiles.length]);

  useEffect(() => {
    const hasDirtyFiles = dirtyFiles.length > 0;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    onNativeWindowCloseRequested((event) => {
      event.preventDefault();
      if (hasDirtyFiles) {
        setPendingAppClose(true);
        return;
      }

      closeApplication();
    })
      .then((listener) => {
        if (disposed) {
          listener?.();
        } else {
          unlisten = listener;
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setError(`Unable to register close protection: ${String(reason)}`);
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [closeApplication, dirtyFiles.length]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (event.key === "Escape" && newFileDialogOpen) {
        event.preventDefault();
        closeNewFileDialog();
        return;
      }
      if (event.key === "Escape" && newFolderDialogOpen) {
        event.preventDefault();
        closeNewFolderDialog();
        return;
      }
      if (event.key === "Escape" && renameDialogOpen) {
        event.preventDefault();
        closeRenameDialog();
        return;
      }
      if (event.key === "Escape" && goToLineDialogOpen) {
        event.preventDefault();
        closeGoToLineDialog();
        return;
      }
      if (event.key === "Escape" && gitCommitPopover) {
        event.preventDefault();
        setGitCommitPopover(undefined);
        return;
      }
      if (event.key === "Escape" && pendingDeletePath) {
        event.preventDefault();
        cancelDeleteSelectedFile();
        return;
      }
      if (event.key === "Escape" && pendingSymlinkTrust) {
        event.preventDefault();
        cancelSymlinkTrust();
        return;
      }
      if (event.key === "Escape" && pendingReloadRequest) {
        event.preventDefault();
        cancelReloadActiveFile();
        return;
      }
      if (event.key === "Escape" && pendingCloseAll) {
        event.preventDefault();
        setPendingCloseAll(false);
        return;
      }
      if (event.key === "Escape" && pendingAppClose) {
        event.preventDefault();
        setPendingAppClose(false);
        return;
      }
      if (event.key === "Escape" && integrationsOpen) {
        event.preventDefault();
        setIntegrationsOpen(false);
        return;
      }
      if (event.key === "Escape" && keyBindingsOpen) {
        event.preventDefault();
        setKeyBindingsOpen(false);
        return;
      }
      if (event.key === "Escape" && aboutOpen) {
        event.preventDefault();
        setAboutOpen(false);
        return;
      }
      if (event.key === "Escape" && settingsOpen) {
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }
      if (event.key === "Escape" && pendingClosePath) {
        event.preventDefault();
        setPendingClosePath(undefined);
        return;
      }
      if (event.key === "Escape" && quickOpenVisible) {
        event.preventDefault();
        closeQuickOpen();
        return;
      }
      if (event.key === "Escape" && commandPaletteVisible) {
        event.preventDefault();
        closeCommandPalette();
        return;
      }

      if (modalUiOpen && isGlobalIdeShortcut(event)) {
        event.preventDefault();
        return;
      }

      if (isIntellijShortcut(event, "saveAll")) {
        event.preventDefault();
        saveAll();
      } else if (isIntellijShortcut(event, "synchronizeFromDisk")) {
        event.preventDefault();
        requestReloadActiveFile();
      } else if (isIntellijShortcut(event, "closeAll")) {
        event.preventDefault();
        requestCloseAllFiles();
      } else if (isIntellijShortcut(event, "closeTab")) {
        event.preventDefault();
        requestCloseActiveFile();
      } else if (isIntellijShortcut(event, "showProject")) {
        event.preventDefault();
        toggleSidebar();
      } else if (isIntellijShortcut(event, "zoomEditorIn")) {
        event.preventDefault();
        zoomEditor(1);
      } else if (isIntellijShortcut(event, "zoomEditorOut")) {
        event.preventDefault();
        zoomEditor(-1);
      } else if (isIntellijShortcut(event, "zoomAppIn")) {
        event.preventDefault();
        zoomApp(1);
      } else if (isIntellijShortcut(event, "zoomAppOut")) {
        event.preventDefault();
        zoomApp(-1);
      } else if (isIntellijShortcut(event, "newFile")) {
        event.preventDefault();
        openNewFileDialog();
      } else if (isIntellijShortcut(event, "rename")) {
        event.preventDefault();
        openRenameDialog();
      } else if (isIntellijShortcut(event, "previousTab")) {
        event.preventDefault();
        activateAdjacentTab(-1);
      } else if (isIntellijShortcut(event, "nextTab")) {
        event.preventDefault();
        activateAdjacentTab(1);
      } else if (isIntellijShortcut(event, "commandPalette")) {
        event.preventDefault();
        openCommandPalette();
      } else if (isIntellijShortcut(event, "goToFile")) {
        event.preventDefault();
        openQuickOpen();
      } else if (isIntellijShortcut(event, "goToLine")) {
        event.preventDefault();
        openGoToLineDialog();
      } else if (isIntellijShortcut(event, "findInFiles")) {
        event.preventDefault();
        openWorkspaceSearch();
      } else if (isIntellijShortcut(event, "findInFile")) {
        event.preventDefault();
        openCurrentFileFind();
      } else if (isIntellijShortcut(event, "findInFileReplace")) {
        // preventDefault stops the webview from treating Cmd/Ctrl+R as a reload.
        event.preventDefault();
        openReplaceInFile();
      } else if (isIntellijShortcut(event, "goToDefinition")) {
        event.preventDefault();
        requestEditorCommand("goToDefinition");
      } else if (isIntellijShortcut(event, "findReferences")) {
        event.preventDefault();
        requestEditorCommand("findReferences");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeFile,
    closeQuickOpen,
    closeCommandPalette,
    closeGoToLineDialog,
    closeNewFileDialog,
    closeNewFolderDialog,
    closeRenameDialog,
    activateAdjacentTab,
    cancelDeleteSelectedFile,
    cancelSymlinkTrust,
    pendingSymlinkTrust,
    cancelReloadActiveFile,
    newFileDialogOpen,
    newFolderDialogOpen,
    integrationsOpen,
    keyBindingsOpen,
    aboutOpen,
    settingsOpen,
    goToLineDialogOpen,
    gitCommitPopover,
    modalUiOpen,
    nativePickerAvailable,
    commandPaletteVisible,
    openRenameDialog,
    openNewFileDialog,
    openCommandPalette,
    openCurrentFileFind,
    openReplaceInFile,
    openGoToLineDialog,
    openQuickOpen,
    openWorkspaceSearch,
    openFiles,
    pendingAppClose,
    pendingCloseAll,
    pendingClosePath,
    pendingDeletePath,
    pendingReloadRequest,
    quickOpenVisible,
    renameDialogOpen,
    requestCloseActiveFile,
    requestCloseAllFiles,
    requestEditorCommand,
    requestReloadActiveFile,
    saveAll,
    toggleSidebar,
    zoomEditor,
    zoomApp,
  ]);

  const SidebarIcon = sidebarCollapsed ? PanelLeftOpen : PanelLeftClose;
  const appShellStyle = {
    "--app-zoom": String(appZoomPercent / 100),
    "--app-zoom-inverse": String(100 / appZoomPercent),
    "--editor-font-size": `${editorFontSize}px`,
    "--sidebar-width": `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <main
      className={appShellClass(sidebarCollapsed)}
      data-ide-theme={prefersDark ? "dark" : "light"}
      style={appShellStyle}
    >
      <aside className="sidebar" aria-hidden={sidebarCollapsed}>
        <div className="sidebar__header" title={appTitle}>
          <div className="sidebar__actions">
            <button
              className="icon-button"
              title="Open folder"
              onClick={openWorkspace}
              disabled={!nativePickerAvailable}
            >
              <FolderOpen size={17} />
            </button>
            <button
              className="icon-button"
              title="Open file"
              onClick={openFileFromDialog}
              disabled={!nativePickerAvailable}
            >
              <FileInput size={17} />
            </button>
            <button className="icon-button" title="New file" onClick={openNewFileDialog}>
              <FilePlus size={17} />
            </button>
            <button className="icon-button" title="New folder" onClick={openNewFolderDialog}>
              <FolderPlus size={17} />
            </button>
            <button className="icon-button" title="Rename selected item" onClick={openRenameDialog}>
              <Pencil size={16} />
            </button>
            <button className="icon-button" title="Delete selected item" onClick={requestDeleteSelectedFile}>
              <Trash2 size={16} />
            </button>
            <button className="icon-button" title="Refresh files" onClick={refreshWorkspace}>
              <RefreshCw size={16} />
            </button>
          </div>
        </div>

        <div className="search-tools" aria-label="Workspace search controls">
          <button
            className={[
              "icon-button",
              filterExpanded ? "icon-button--active" : "",
            ].join(" ")}
            title="Filter files"
            aria-label="Filter files"
            // Keep the focused input from blurring on mousedown: its empty-query
            // onBlur would clear the mode first, making this click's toggle
            // reopen the panel it was meant to close.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() =>
              setActiveSidebarSearch((current) => (current === "filter" ? undefined : "filter"))
            }
          >
            <ListFilter size={16} />
          </button>
          <button
            className={[
              "icon-button",
              contentSearchActive ? "icon-button--active" : "",
            ].join(" ")}
            title="Search contents"
            aria-label="Search contents"
            // Same blur-race guard as the filter toggle above.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() =>
              setActiveSidebarSearch((current) => (current === "content" ? undefined : "content"))
            }
          >
            <Search size={16} />
          </button>
          {gitCommitEnabled ? (
            <button
              className={[
                "icon-button",
                commitModeActive ? "icon-button--active" : "",
              ].join(" ")}
              title="Commit changes"
              aria-label="Commit changes"
              onClick={() =>
                setActiveSidebarSearch((current) => (current === "commit" ? undefined : "commit"))
              }
            >
              <GitCommitHorizontal size={16} />
            </button>
          ) : null}
        </div>

        {filterVisible ? (
          <label className="search-box">
            <ListFilter size={15} />
            <input
              ref={sidebarFilterInputRef}
              value={filter}
              onBlur={() => {
                if (!filter.trim()) {
                  setActiveSidebarSearch((current) =>
                    current === "filter" ? undefined : current,
                  );
                }
              }}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={handleFilterSearchKeyDown}
              placeholder="Filter files"
            />
          </label>
        ) : null}

        {contentSearchActive ? (
          <label className="search-box">
            <Search size={15} />
            <input
              ref={sidebarContentSearchInputRef}
              value={contentQuery}
              onBlur={() => {
                if (!contentQuery.trim()) {
                  setActiveSidebarSearch((current) =>
                    current === "content" ? undefined : current,
                  );
                }
              }}
              onChange={(event) => setContentQuery(event.target.value)}
              onKeyDown={handleContentSearchKeyDown}
              placeholder="Search contents"
            />
          </label>
        ) : null}

        {contentSearchActive ? (
          <div
            className="search-results search-results--sidebar"
            aria-label="Content search results"
          >
            <div className="search-results__header">
              <span>{searching ? "Searching" : "Results"}</span>
              <span>
                {contentSearchStatsText
                  ? `${searchResults.length} / ${contentSearchStatsText}`
                  : searchResults.length}
              </span>
            </div>
            {searchResultsTruncated ? (
              <div className="search-results__notice" role="status">
                <TriangleAlert size={14} />
                <span>
                  Showing the first {searchResultLimitHit.toLocaleString()} matches.
                  Raise the result cap in Settings to search further.
                </span>
                <button
                  className="command-button command-button--quiet"
                  onClick={() => {
                    setSettingsCategory("search");
                    setSettingsOpen(true);
                  }}
                >
                  Settings
                </button>
              </div>
            ) : null}
            {contentSearchReady
              ? searchResults.map((result) => (
                  <button
                    className="search-result"
                    key={`${result.path}:${result.lineNumber}:${result.matchStart}`}
                    onClick={() => openPathByName(result.path, false, result.lineNumber)}
                    onDoubleClick={() => openPathByName(result.path, true, result.lineNumber)}
                  >
                    <span className="search-result__path">
                      {result.path}:{result.lineNumber}
                    </span>
                    <span className="search-result__line">{result.lineText}</span>
                  </button>
                ))
              : null}
            {!searching && searchResults.length === 0 ? (
              <div className="search-results__empty">
                {contentSearchReady ? "No matches" : "Type at least 2 characters"}
              </div>
            ) : null}
          </div>
        ) : null}

        {commitModeActive ? (
          <div className="commit-panel" aria-label="Git commit panel">
            <div className="commit-panel__body">
            {gitStatusError || gitStatus?.status === "unsupported" ? (
              <div className="commit-panel__state" role="status">
                <GitBranch size={22} />
                <span>{gitStatusError ?? gitStatus?.unsupportedReason}</span>
              </div>
            ) : !gitStatus ? (
              <div className="commit-panel__state" role="status">
                <Loader size={22} />
                <span>Loading Git status…</span>
              </div>
            ) : changedFilePaths.length === 0 ? (
              <div className="commit-panel__state" role="status">
                <Check size={22} />
                <span>No changes</span>
              </div>
            ) : (
              <>
                <div className="commit-panel__header">
                  <TriStateCheckbox
                    state={
                      gitCommitSelectedPaths.size === 0
                        ? "none"
                        : allChangedFilesSelected
                          ? "all"
                          : "some"
                    }
                    onToggle={
                      allChangedFilesSelected ? deselectAllChangedFiles : selectAllChangedFiles
                    }
                    ariaLabel={allChangedFilesSelected ? "Deselect all changes" : "Select all changes"}
                  />
                  <span className="commit-panel__title">Changes</span>
                  <span className="commit-panel__count">
                    {gitCommitSelectedPaths.size} / {changedFilePaths.length}
                  </span>
                </div>
                <div className="commit-panel__tree" role="tree" aria-label="Changed files">
                  {changedFilesTree.map((node) => (
                    <TreeItem
                      key={node.path}
                      expandedFolders={expandedFolders}
                      forceExpanded={false}
                      node={node}
                      selectedPath={selectedPath}
                      onOpen={(entry) => void openDiffTab(entry.path)}
                      onSelect={setSelectedPath}
                      onToggleFolder={toggleFolder}
                      fileStatusByPath={fileStatusByPath}
                      changedFolderPaths={changedFolderPaths}
                      selection={{
                        selectedPaths: gitCommitSelectedPaths,
                        onToggleFile: toggleGitCommitSelection,
                        onSetFolderSelected: setGitCommitPathsSelected,
                      }}
                    />
                  ))}
                </div>
                <div className="commit-panel__footer">
                  <div
                    className="commit-message-resizer"
                    role="separator"
                    tabIndex={0}
                    aria-label="Resize commit message"
                    aria-orientation="horizontal"
                    aria-valuemin={minCommitMessageHeight}
                    aria-valuemax={maxCommitMessageHeight}
                    aria-valuenow={commitMessageHeight}
                    onKeyDown={handleCommitMessageResizeKeyDown}
                    onPointerDown={beginCommitMessageResize}
                  />
                  <textarea
                    className="commit-panel__message"
                    style={{ height: commitMessageHeight }}
                    placeholder="Commit message"
                    value={gitCommitMessage}
                    onChange={(event) => setGitCommitMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void handleGitCommit();
                      }
                    }}
                  />
                  <button
                    className="command-button command-button--primary commit-panel__commit"
                    disabled={
                      !gitCommitMessage.trim() ||
                      gitCommitSelectedPaths.size === 0 ||
                      gitCommitInFlight
                    }
                    onClick={handleGitCommit}
                  >
                    {gitCommitInFlight
                      ? "Committing…"
                      : gitCommitSelectedPaths.size > 0
                        ? `Commit ${gitCommitSelectedPaths.size} file${gitCommitSelectedPaths.size === 1 ? "" : "s"}`
                        : "Commit"}
                  </button>
                  {gitCommitError ? (
                    <div className="commit-panel__notice commit-panel__notice--error" role="alert">
                      {gitCommitError}
                    </div>
                  ) : null}
                  {gitCommitSuccess ? (
                    <div className="commit-panel__notice commit-panel__notice--success" role="status">
                      {gitCommitSuccess}
                    </div>
                  ) : null}
                </div>
              </>
            )}
            </div>
            {gitSyncEnabled ? (
              <div className="commit-panel__sync">
                <div className="commit-panel__sync-row">
                  <span
                    className="commit-panel__sync-branch"
                    title={gitStatus?.branch ?? gitSyncResult?.branch}
                  >
                    <GitBranch size={14} />
                    <span className="commit-panel__sync-branch-name">
                      {gitStatus?.branch ?? gitSyncResult?.branch ?? "No branch"}
                    </span>
                  </span>
                  <button
                    className="command-button commit-panel__sync-button"
                    disabled={
                      gitSyncInFlight || gitStatus?.status !== "available" || mergeInProgress
                    }
                    onClick={handleGitSync}
                  >
                    <RefreshCw
                      size={14}
                      className={gitSyncInFlight ? "commit-panel__sync-spin" : undefined}
                    />
                    {gitSyncInFlight ? "Syncing…" : "Sync"}
                  </button>
                </div>
                {mergeInProgress ? (
                  <div className="commit-panel__merge" role="group" aria-label="Resolve merge">
                    <span className="commit-panel__sync-conflict-title">
                      {conflictedFiles.length > 0
                        ? "Merge conflicts — resolve each file, then complete the merge:"
                        : "All conflicts resolved — complete the merge to finish."}
                    </span>
                    {conflictedFiles.length > 0 ? (
                      <ul className="commit-panel__merge-files">
                        {conflictedFiles.map((file) => (
                          <li key={file} className="commit-panel__merge-file">
                            <button
                              type="button"
                              className="commit-panel__merge-file-open"
                              title={`Open ${file}`}
                              onClick={() => void openDiffTab(file)}
                            >
                              {file}
                            </button>
                            <button
                              type="button"
                              className="command-button command-button--quiet commit-panel__merge-resolve"
                              disabled={gitMergeStagingPath !== undefined}
                              onClick={() => void handleStageResolved(file)}
                            >
                              {gitMergeStagingPath === file ? "Marking…" : "Mark resolved"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="commit-panel__merge-tip">
                      Stuck? You can always ask your agent to fix this for you.
                    </p>
                    <button
                      className="command-button command-button--primary commit-panel__merge-complete"
                      disabled={conflictedFiles.length > 0 || gitMergeInFlight}
                      onClick={handleCompleteMerge}
                    >
                      {gitMergeInFlight ? "Completing…" : "Complete merge"}
                    </button>
                    {gitMergeError ? (
                      <div
                        className="commit-panel__notice commit-panel__notice--error"
                        role="alert"
                      >
                        {gitMergeError}
                      </div>
                    ) : null}
                  </div>
                ) : gitSyncError ? (
                  <div
                    className="commit-panel__notice commit-panel__notice--error"
                    role="alert"
                  >
                    {gitSyncError}
                  </div>
                ) : gitMergeSuccess ? (
                  <div
                    className="commit-panel__notice commit-panel__notice--success"
                    role="status"
                  >
                    {gitMergeSuccess}
                  </div>
                ) : gitSyncResult ? (
                  <div
                    className="commit-panel__notice commit-panel__notice--success"
                    role="status"
                  >
                    {formatGitSyncResult(gitSyncResult)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {!contentSearchActive && !commitModeActive ? (
          <nav className="file-tree" role="tree" aria-label="Workspace files">
            {workspaceLoading && files.length === 0 ? (
              <div className="tree-empty" role="status">Loading workspace</div>
            ) : workspaceLoadFailed && files.length === 0 ? (
              <div className="tree-empty tree-empty--error" role="status">
                <span>Workspace load failed</span>
                <button className="command-button command-button--quiet" onClick={refreshWorkspace}>
                  Retry
                </button>
              </div>
            ) : filteredTree.length === 0 ? (
              <div className="tree-empty" role="status">
                {filter.trim() ? "No matching files" : "Empty workspace"}
              </div>
            ) : (
              filteredTree.map((node) => (
                <TreeItem
                  key={node.path}
                  expandedFolders={expandedFolders}
                  forceExpanded={Boolean(filter.trim())}
                  node={node}
                  selectedPath={selectedPath}
                  onOpen={openPath}
                  onSelect={setSelectedPath}
                  onToggleFolder={toggleFolder}
                  fileStatusByPath={fileStatusByPath}
                  changedFolderPaths={changedFolderPaths}
                />
              ))
            )}
          </nav>
        ) : null}

        {workspaceScanTruncated && !singleFileMode ? (
          <div className="sidebar-scan-status" role="status">
            <button
              className="sidebar-scan-status__button"
              title={`Initial scan reached ${workspaceScanLimitHit.toLocaleString()} entries. Expand folders to load more, or open Performance settings.`}
              aria-label={`Initial scan reached ${workspaceScanLimitHit.toLocaleString()} entries. Open Performance settings.`}
              onClick={() => {
                setSettingsCategory("performance");
                setSettingsOpen(true);
              }}
            >
              <TriangleAlert size={14} />
              <span>{workspaceScanLimitHit.toLocaleString()}</span>
            </button>
          </div>
        ) : null}

        {showDiagnosticsPanel ? (
          <div className="diagnostics-panel" aria-label="Diagnostics">
            <div className="diagnostics-panel__header">
              <span>Diagnostics</span>
              <span>{diagnostics.length}</span>
            </div>
            {diagnostics.length === 0 ? (
              <div className="diagnostics-panel__empty">No diagnostics</div>
            ) : (
              diagnostics.map((diagnostic) => (
                <button
                  className="diagnostic-row"
                  key={diagnosticKey(diagnostic)}
                  aria-label={`${diagnosticSeverityLabel(diagnostic.severity)} at ${diagnosticLocationLabel(diagnostic)}: ${diagnostic.message}`}
                  title={`${diagnosticLocationLabel(diagnostic)} ${diagnostic.message}`}
                  onClick={() =>
                    openPathByName(diagnostic.filePath, false, diagnostic.startLine)
                  }
                  onDoubleClick={() =>
                    openPathByName(diagnostic.filePath, true, diagnostic.startLine)
                  }
                >
                  <TriangleAlert size={14} />
                  <span className="diagnostic-row__main">
                    <span className="diagnostic-row__path">
                      {diagnosticLocationLabel(diagnostic)}
                    </span>
                    <span className="diagnostic-row__message">{diagnostic.message}</span>
                  </span>
                  <span className="diagnostic-row__severity">
                    {diagnosticSeverityLabel(diagnostic.severity)}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}

        <div
          className="sidebar-resizer"
          role="separator"
          tabIndex={sidebarCollapsed ? -1 : 0}
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={minSidebarWidth}
          aria-valuemax={maxSidebarWidth}
          aria-valuenow={sidebarWidth}
          aria-disabled={sidebarCollapsed}
          onKeyDown={handleSidebarResizeKeyDown}
          onPointerDown={beginSidebarResize}
        />
      </aside>

      <section className="workbench">
        <header className="topbar">
          <div className="tab-strip">
            {openFiles.length === 0 ? (
              <span className="empty-tab">Open a file from the tree</span>
            ) : (
              openFiles.map((file) => (
                <button
                  className={[
                    "tab",
                    file.path === activePath ? "tab--active" : "",
                    file.pinned ? "" : "tab--temp",
                    file.diff ? "tab--diff" : "",
                  ].join(" ")}
                  key={file.path}
                  onClick={() => {
                    setActivePath(file.path);
                    void checkOpenFileDiskState(file.path, "activate");
                  }}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    event.stopPropagation();
                    requestCloseFile(file.path);
                  }}
                  onDoubleClick={() =>
                    setOpenFiles((current) =>
                      pinTab(current, file.path),
                    )
                  }
                >
                  {file.diff ? <GitCompareArrows size={15} /> : <FileCog size={15} />}
                  <span>{file.diff ? `${file.diff.filePath} (Working Tree)` : file.path}</span>
                  {!file.diff && file.dirty ? <Circle className="dirty-dot" size={8} /> : null}
                  <span
                    className="tab__close"
                    role="button"
                    tabIndex={0}
                    title="Close"
                    onClick={(event) => {
                      event.stopPropagation();
                      requestCloseFile(file.path);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        requestCloseFile(file.path);
                      }
                    }}
                  >
                    <X size={13} />
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="topbar__actions">
            {currentFindExpanded ? (
              <div className="topbar-find-group">
                <label className="topbar-find">
                  <Search size={14} />
                  <input
                    ref={currentFindInputRef}
                    value={currentFileQuery}
                    onBlur={(event) => {
                      // Keep the overlay open when focus moves to the replace
                      // toggle or replace input — only auto-close when focus
                      // leaves the whole find/replace group with an empty query.
                      const group = event.currentTarget.closest(".topbar-find-group");
                      if (
                        group &&
                        event.relatedTarget instanceof Node &&
                        group.contains(event.relatedTarget)
                      ) {
                        return;
                      }
                      if (!currentFileQuery.trim()) {
                        setCurrentFindOpen(false);
                        setReplaceVisible(false);
                      }
                    }}
                    onChange={(event) => setCurrentFileQuery(event.target.value)}
                    onKeyDown={handleCurrentFindKeyDown}
                    placeholder="Find in file"
                  />
                  <span>
                    {activeFile && currentFileQuery.trim() ? currentFindResults.length : ""}
                  </span>
                  <button
                    type="button"
                    className="topbar-find__toggle"
                    title={replaceVisible ? "Hide replace" : "Replace"}
                    aria-label={replaceVisible ? "Hide replace" : "Replace"}
                    aria-pressed={replaceVisible}
                    onClick={() => {
                      const next = !replaceVisible;
                      setReplaceVisible(next);
                      if (next) {
                        requestAnimationFrame(() => replaceInputRef.current?.focus());
                      }
                    }}
                  >
                    <Replace size={14} />
                  </button>
                </label>
                {replaceVisible ? (
                  <label className="topbar-find topbar-find--replace">
                    <Replace size={14} />
                    <input
                      ref={replaceInputRef}
                      value={replaceQuery}
                      onChange={(event) => setReplaceQuery(event.target.value)}
                      onKeyDown={handleReplaceKeyDown}
                      placeholder="Replace with"
                    />
                    <button
                      type="button"
                      className="topbar-find__action"
                      title="Replace current match (Enter)"
                      disabled={!activeFile || currentFindResults.length === 0}
                      onClick={replaceCurrentMatch}
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      className="topbar-find__action"
                      title="Replace all matches (⌘/Ctrl+Enter)"
                      disabled={!activeFile || currentFindResults.length === 0}
                      onClick={replaceAllMatches}
                    >
                      All
                    </button>
                  </label>
                ) : null}
              </div>
            ) : (
              <button
                className="icon-button"
                title="Find in file"
                aria-label="Find in file"
                disabled={!activeFile}
                onClick={() => setCurrentFindOpen(true)}
              >
                <Search size={17} />
              </button>
            )}
            <button
              className="icon-button"
              title="Save"
              onClick={saveActive}
              disabled={!activeFileIsDirty}
            >
              <Save size={17} />
            </button>
            <button
              className="icon-button"
              title="Save all"
              onClick={saveAll}
              disabled={!hasDirtyFiles}
            >
              <SaveAll size={17} />
            </button>
            <button
              className="icon-button"
              title="Reload from disk"
              onClick={requestReloadActiveFile}
              disabled={!activeFile}
            >
              <RotateCcw size={16} />
            </button>
            <button
              className="icon-button"
              title={sidebarToggleTitle(sidebarCollapsed)}
              onClick={toggleSidebar}
            >
              <SidebarIcon size={17} />
            </button>
          </div>
        </header>

        <div className={editorRegionClass()}>
          {activeFile && !activeFile.diff && currentFileQuery.trim() ? (
            <div className="current-find-results" aria-label="Current file search results">
              <div className="current-find-results__header">
                <span>Find in {activeFile.path}</span>
                <span>{currentFindResults.length}</span>
              </div>
              {currentFindWindow.items.map((result, offset) => {
                const index = currentFindWindow.startIndex + offset;
                return (
                  <button
                    className={[
                      "current-find-result",
                      index === currentFindIndex ? "current-find-result--active" : "",
                    ].join(" ")}
                    key={`${index}:${result.lineNumber}:${result.matchStart}:${result.matchEnd}`}
                    onClick={() => revealCurrentFileMatch(result, index)}
                  >
                    <span className="current-find-result__path">
                      line {result.lineNumber}
                    </span>
                    <span className="current-find-result__line">{result.lineText}</span>
                  </button>
                );
              })}
              {currentFindResults.length === 0 ? (
                <div className="current-find-results__empty">No matches</div>
              ) : null}
            </div>
          ) : null}
          {activeFile?.diff ? (
            <Suspense fallback={<div className="empty-state editor-loading-state">Loading diff</div>}>
              <DiffPane
                key={activeFile.path}
                filePath={activeFile.diff.filePath}
                original={activeFile.diff.original}
                modified={activeFile.diff.modified}
                isBinary={activeFile.diff.isBinary}
                isTooLarge={activeFile.diff.isTooLarge}
                prefersDark={prefersDark}
                viewMode={diffViewMode}
                onViewModeChange={setDiffViewMode}
                commitModeActive={commitModeActive}
              />
            </Suspense>
          ) : activeFile ? (
            <Suspense fallback={<div className="empty-state editor-loading-state">Loading editor</div>}>
              <EditorPane
                contents={activeFile.contents}
                dateTimeFormat={dateTimeFormat}
                editorCommand={editorCommand}
                gitAttribution={activeGitAttribution}
                isDirty={activeFile.dirty}
                path={activeFile.path}
                prefersDark={prefersDark}
                recentRelativeThreshold={recentRelativeThreshold}
                revealLine={
                  revealTarget?.path === activeFile.path ? revealTarget.lineNumber : undefined
                }
                revealMatchStart={
                  revealTarget?.path === activeFile.path ? revealTarget.matchStart : undefined
                }
                revealMatchEnd={
                  revealTarget?.path === activeFile.path ? revealTarget.matchEnd : undefined
                }
                focusOnReveal={
                  revealTarget?.path === activeFile.path
                    ? !revealTarget.preserveFocus
                    : undefined
                }
                onChange={updateContents}
                onCursor={setCursor}
                onError={setError}
                onGitCommitClick={setGitCommitPopover}
                onNotice={setStatus}
                onSelection={setSelection}
              />
            </Suspense>
          ) : (
            <div className="empty-state editor-empty-state">
              <FileCog size={30} />
              <strong>{emptyEditorState.title}</strong>
              {emptyEditorState.detail ? (
                <span className="empty-state__detail">{emptyEditorState.detail}</span>
              ) : null}
            </div>
          )}
        </div>

        <footer className="statusbar">
          <span className="statusbar__state">{status}</span>
          <span className="statusbar__path">
            {activeFile?.diff
              ? `${activeFile.diff.filePath} (Working Tree)`
              : activePath ?? workspaceRoot}
          </span>
          {activeGitFileCommit ? (
            <button
              className="statusbar__git-attribution"
              onClick={() => setGitCommitPopover(activeGitFileCommit)}
              title={gitStatusTitle}
              type="button"
            >
              <span className="statusbar__git-label">Last commit</span>
              <strong>{activeGitFileCommit.authorName}</strong>
              <span className="statusbar__git-date">
                {commitTimeLabel(
                  activeGitFileCommit,
                  dateTimeFormat,
                  recentRelativeThreshold,
                )}
              </span>
              <span className="statusbar__git-summary">
                {activeGitFileCommit.summary}
              </span>
            </button>
          ) : null}
          <span className="statusbar__cursor">{cursorPosition}</span>
        </footer>
      </section>

      {gitCommitPopover ? (
        <div
          aria-label="Git commit details"
          className="git-commit-popover"
          role="dialog"
        >
          <div className="git-commit-popover__header">
            <span>{gitCommitPopover.shortSha}</span>
            <button
              aria-label="Close Git commit details"
              className="icon-button"
              onClick={() => setGitCommitPopover(undefined)}
              ref={gitCommitPopoverCloseRef}
              type="button"
            >
              <X size={14} />
            </button>
          </div>
          <strong>{gitCommitPopover.summary}</strong>
          <dl>
            <div>
              <dt>Author</dt>
              <dd>{gitCommitPopover.authorName}</dd>
            </div>
            <div>
              <dt>Committed</dt>
              <dd>
                {commitDateLabel(
                  gitCommitPopover,
                  dateTimeFormat,
                  recentRelativeThreshold,
                )}
              </dd>
            </div>
          </dl>
          {gitCommitPopover.actions.length ? (
            <div className="git-commit-popover__actions">
              {gitCommitPopover.actions.map((action) => (
                <button
                  className="command-button"
                  key={`${action.remoteName}:${action.url}`}
                  onClick={() => window.open(action.url, "_blank", "noopener,noreferrer")}
                  type="button"
                >
                  <ExternalLink size={14} />
                  <span>{action.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {quickOpenVisible ? (
        <div className="quick-open" role="dialog" aria-label="Quick open">
          <div className="quick-open__panel">
            <label className="quick-open__input">
              <Search size={16} />
              <input
                autoFocus
                value={quickOpenQuery}
                onChange={(event) => {
                  setQuickOpenQuery(event.target.value);
                  setQuickOpenIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setQuickOpenIndex((current) =>
                      moveQuickOpenSelection(current, 1, quickOpenResults.length),
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setQuickOpenIndex((current) =>
                      moveQuickOpenSelection(current, -1, quickOpenResults.length),
                    );
                  } else if (event.key === "Enter" && quickOpenResults[quickOpenIndex]) {
                    event.preventDefault();
                    openQuickPath(quickOpenResults[quickOpenIndex].path, false);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    closeQuickOpen();
                  }
                }}
                placeholder="Open file"
              />
            </label>
            <div className="quick-open__results">
              {quickOpenResults.map((file, index) => {
                const Icon = iconForFile(file.name, false);
                return (
                  <button
                    className={[
                      "quick-open__result",
                      index === quickOpenIndex ? "quick-open__result--active" : "",
                    ].join(" ")}
                    key={file.path}
                    onClick={() => openQuickPath(file.path, false)}
                    onDoubleClick={() => openQuickPath(file.path, true)}
                    onMouseEnter={() => setQuickOpenIndex(index)}
                  >
                    <Icon size={15} />
                    <span>{file.path}</span>
                  </button>
                );
              })}
              {quickOpenResults.length === 0 ? (
                <div className="quick-open__empty">
                  {quickOpenSearching ? "Searching files" : "No matching files"}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {commandPaletteVisible ? (
        <div className="quick-open command-palette" role="dialog" aria-label="Command palette">
          <div className="quick-open__panel">
            <label className="quick-open__input">
              <Search size={16} />
              <input
                autoFocus
                value={commandPaletteQuery}
                onChange={(event) => {
                  setCommandPaletteQuery(event.target.value);
                  setCommandPaletteIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setCommandPaletteIndex((current) =>
                      moveCommandPaletteSelection(
                        current,
                        1,
                        commandPaletteResults.length,
                      ),
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setCommandPaletteIndex((current) =>
                      moveCommandPaletteSelection(
                        current,
                        -1,
                        commandPaletteResults.length,
                      ),
                    );
                  } else if (
                    event.key === "Enter" &&
                    commandPaletteResults[commandPaletteIndex]
                  ) {
                    event.preventDefault();
                    runCommandPaletteCommand(commandPaletteResults[commandPaletteIndex]);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    closeCommandPalette();
                  }
                }}
                placeholder="Run command"
              />
            </label>
            <div className="quick-open__results">
              {commandPaletteResults.map((command, index) => (
                <button
                  className={[
                    "quick-open__result",
                    "command-palette__result",
                    index === commandPaletteIndex ? "quick-open__result--active" : "",
                    !command.enabled ? "quick-open__result--disabled" : "",
                  ].join(" ")}
                  key={command.id}
                  disabled={!command.enabled}
                  onClick={() => runCommandPaletteCommand(command)}
                  onMouseEnter={() => setCommandPaletteIndex(index)}
                >
                  <Circle size={8} />
                  <span className="command-palette__text">
                    <strong>{command.title}</strong>
                    <small>{command.detail}</small>
                  </span>
                </button>
              ))}
              {commandPaletteResults.length === 0 ? (
                <div className="quick-open__empty">No matching commands</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {integrationsOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog integration-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="integrations-title"
          >
            <div>
              <div className="eyebrow">Local Tools</div>
              <h2 id="integrations-title">Integrations</h2>
            </div>

            <div className="integration-dialog__grid">
              <section className="integration-section" aria-label="Browser endpoint">
                <div className="eyebrow">Browser Endpoint</div>
                <div className="integration-row">
                  <div className="endpoint" title={httpEndpoint ?? "Endpoint unavailable"}>
                    {httpEndpoint ?? "Not available"}
                  </div>
                  <button
                    aria-label="Copy browser endpoint"
                    className="tiny-icon-button"
                    disabled={!httpEndpoint}
                    onClick={() => httpEndpoint && copyText("browser endpoint", httpEndpoint)}
                    title="Copy browser endpoint"
                    type="button"
                  >
                    <Copy size={13} />
                  </button>
                </div>
              </section>

              <section className="integration-section" aria-label="Claude bridge">
                <div className="eyebrow">Claude Bridge</div>
                <div className="integration-row">
                  <div className="endpoint" title={claudeBridge?.lockFile ?? "Bridge unavailable"}>
                    {claudeBridge?.endpoint ?? "Not available"}
                  </div>
                  <button
                    aria-label="Copy Claude bridge endpoint"
                    className="tiny-icon-button"
                    disabled={!claudeBridge?.endpoint}
                    onClick={() =>
                      claudeBridge?.endpoint &&
                      copyText("Claude bridge endpoint", claudeBridge.endpoint)
                    }
                    title="Copy Claude bridge endpoint"
                    type="button"
                  >
                    <Copy size={13} />
                  </button>
                </div>
              </section>

              <section className="integration-section" aria-label="Codex MCP">
                <div className="eyebrow">Codex MCP</div>
                {codexMcp ? (
                  <>
                    <div className="integration-command" title="Open the Codex config file">
                      <code>ide ~/.codex/config.toml</code>
                    </div>
                    <div className="snippet-row">
                      <pre>{codexMcpConfig}</pre>
                      <button
                        aria-label="Copy Codex MCP config"
                        className="tiny-icon-button"
                        title="Copy Codex MCP config"
                        type="button"
                        onClick={() => copyText("Codex MCP config", codexMcpConfig)}
                      >
                        <Copy size={13} />
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="endpoint">Not available</div>
                )}
              </section>

              <section className="integration-section" aria-label="Language servers">
                <div className="eyebrow">Language Servers</div>
                {lspServers.length > 0 ? (
                  lspServers.map((server) => (
                    <div className="lsp-row" key={server.language} title={server.detail}>
                      <span
                        className={
                          server.running
                            ? "lsp-dot lsp-dot--running"
                            : server.available
                              ? "lsp-dot lsp-dot--ready"
                              : "lsp-dot"
                        }
                      />
                      <span>{server.displayName}</span>
                    </div>
                  ))
                ) : (
                  <div className="endpoint">No language servers registered</div>
                )}
              </section>
            </div>

            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--primary"
                type="button"
                onClick={() => setIntegrationsOpen(false)}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {aboutOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog about-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
          >
            <button
              aria-label="Close"
              className="tiny-icon-button about-dialog__close"
              onClick={() => setAboutOpen(false)}
              title="Close"
              type="button"
            >
              <X size={14} />
            </button>
            <img
              alt=""
              className="about-dialog__icon"
              src="/icon-128.png"
              width={96}
              height={96}
            />
            <div className="about-dialog__body">
              <div>
                <h2 id="about-title">{appInfo.name}</h2>
                <div className="about-dialog__version">Version {appInfo.version}</div>
              </div>
              <p>{appInfo.description}</p>
              <a
                className="about-dialog__link"
                href={appInfo.repository}
                rel="noreferrer"
                target="_blank"
              >
                {repositoryLabel}
                <ExternalLink size={13} />
              </a>
              <div className="about-dialog__meta">
                {appInfo.authors.join(", ") || "Gordon Beeming"}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {keyBindingsOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog keybindings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="keybindings-title"
          >
            <div>
              <div className="eyebrow">View</div>
              <h2 id="keybindings-title">Key Bindings</h2>
            </div>
            <label className="keybindings-search">
              <Search size={15} aria-hidden="true" />
              <input
                autoFocus
                aria-label="Search key bindings"
                placeholder="Search key bindings"
                value={keyBindingsQuery}
                onChange={(event) => setKeyBindingsQuery(event.target.value)}
              />
            </label>
            <div className="keybindings-list" aria-label="Supported key bindings">
              {keyBindingResults.length === 0 ? (
                <div className="keybindings-empty">No matching key bindings</div>
              ) : (
                keyBindingResults.map((binding) => (
                  <div
                    className="keybinding-row"
                    key={`${binding.category}:${binding.command}:${binding.shortcut.mac}:${binding.shortcut.other}`}
                  >
                    <span className="keybinding-row__command">
                      <span>{binding.command}</span>
                      <small>{binding.when ?? binding.category}</small>
                    </span>
                    <kbd>{currentPlatformShortcut(binding.shortcut)}</kbd>
                  </div>
                ))
              )}
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--primary"
                type="button"
                onClick={() => setKeyBindingsOpen(false)}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div>
              <div className="eyebrow">Preferences</div>
              <h2 id="settings-title">Settings</h2>
              <div className="settings-layout">
                <div className="settings-tabs" role="tablist" aria-label="Settings categories">
                  {settingsCategories.map((category) => (
                    <button
                      key={category.id}
                      className={[
                        "settings-tab",
                        settingsCategory === category.id ? "settings-tab--active" : "",
                      ].join(" ")}
                      type="button"
                      role="tab"
                      aria-selected={settingsCategory === category.id}
                      aria-controls={`settings-panel-${category.id}`}
                      id={`settings-tab-${category.id}`}
                      onClick={() => setSettingsCategory(category.id)}
                    >
                      <span>{category.title}</span>
                      <small>{category.detail}</small>
                    </button>
                  ))}
                </div>

                <div className="settings-panel">
                  {settingsCategory === "view" ? (
                    <section
                      className="settings-section"
                      aria-label="Workspace view"
                      role="tabpanel"
                      id="settings-panel-view"
                      aria-labelledby="settings-tab-view"
                    >
                      <div className="settings-section__title">Workspace View</div>
                      <label className="settings-row">
                        <input
                          type="checkbox"
                          checked={showDotfiles}
                          onChange={(event) => {
                            setShowDotfiles(event.target.checked);
                            setStatus(event.target.checked ? "Showing dotfiles" : "Hiding dotfiles");
                          }}
                        />
                        <span>Show dotfiles and dot folders</span>
                      </label>
                      <label className="settings-row">
                        <input
                          type="checkbox"
                          checked={showGeneratedInternal}
                          onChange={(event) => {
                            setShowGeneratedInternal(event.target.checked);
                            setStatus(
                              event.target.checked
                                ? "Showing generated/internal folders"
                                : "Hiding generated/internal folders",
                            );
                          }}
                        />
                        <span>Show generated and internal folders</span>
                      </label>
                      <label className="settings-row">
                        <input
                          type="checkbox"
                          checked={showGitignoredFiles}
                          onChange={(event) => {
                            setShowGitignoredFiles(event.target.checked);
                            setStatus(
                              event.target.checked
                                ? "Showing gitignored files"
                                : "Hiding gitignored files",
                            );
                          }}
                        />
                        <span>Show gitignored files</span>
                      </label>
                      <label className="settings-row">
                        <input
                          type="checkbox"
                          checked={showDiagnosticsPanel}
                          onChange={(event) => {
                            setShowDiagnosticsPanel(event.target.checked);
                            setStatus(
                              event.target.checked
                                ? "Showing diagnostics panel"
                                : "Hiding diagnostics panel",
                            );
                          }}
                        />
                        <span>Show diagnostics panel</span>
                      </label>
                      <label className="settings-row">
                        <input
                          type="checkbox"
                          checked={trackActiveFile}
                          onChange={(event) => {
                            setTrackActiveFile(event.target.checked);
                            setStatus(
                              event.target.checked
                                ? "Tracking active file in tree"
                                : "Stopped tracking active file in tree",
                            );
                          }}
                        />
                        <span>Track active file</span>
                      </label>
                      <label className="settings-row settings-row--stacked">
                        <span>Date and time format</span>
                        <select
                          aria-label="Date and time format"
                          value={dateTimeFormat}
                          onChange={(event) => {
                            const nextFormat = sanitizeDateTimeFormat(event.target.value);
                            setDateTimeFormat(nextFormat);
                            setStatus("Updated date and time format");
                          }}
                        >
                          {dateTimeFormatOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label} - {option.sample}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="settings-row settings-row--stacked">
                        <span>Show recent dates as relative</span>
                        <select
                          aria-label="Show recent dates as relative"
                          value={recentRelativeThreshold}
                          onChange={(event) => {
                            const nextThreshold = sanitizeRecentRelativeThreshold(
                              event.target.value,
                            );
                            setRecentRelativeThreshold(nextThreshold);
                            setStatus("Updated recent date display");
                          }}
                        >
                          {recentRelativeThresholdOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </section>
                  ) : null}

                  {settingsCategory === "performance" ? (
                    <section
                      className="settings-section"
                      aria-label="Performance limits"
                      role="tabpanel"
                      id="settings-panel-performance"
                      aria-labelledby="settings-tab-performance"
                    >
                      <div className="settings-section__title">Performance Limits</div>
                      <label className="dialog-field">
                        <span>Initial tree scan entries</span>
                        <input
                          inputMode="numeric"
                          min={minTreeScanLimit}
                          max={maxTreeScanLimit}
                          step={500}
                          type="number"
                          value={treeScanLimit}
                          onChange={(event) => {
                            const next = sanitizeTreeScanLimit(Number(event.target.value));
                            setTreeScanLimit(next);
                            setStatus(`Tree scan limit set to ${next}`);
                          }}
                        />
                      </label>
                      <label className="dialog-field">
                        <span>Background index batch entries</span>
                        <input
                          inputMode="numeric"
                          min={minBackgroundIndexBatchEntries}
                          max={maxBackgroundIndexBatchEntries}
                          step={100}
                          type="number"
                          value={backgroundIndexBatchEntries}
                          onChange={(event) => {
                            const next = sanitizeNumberLimit(
                              Number(event.target.value),
                              minBackgroundIndexBatchEntries,
                              maxBackgroundIndexBatchEntries,
                              defaultBackgroundIndexBatchEntries,
                            );
                            setBackgroundIndexBatchEntries(next);
                            setStatus(`Background index batch set to ${next}`);
                          }}
                        />
                      </label>
                      <label className="dialog-field">
                        <span>Max editable file KB</span>
                        <input
                          inputMode="numeric"
                          min={minMaxOpenFileKb}
                          max={maxMaxOpenFileKb}
                          step={64}
                          type="number"
                          value={maxOpenFileKb}
                          onChange={(event) => {
                            const next = sanitizeNumberLimit(
                              Number(event.target.value),
                              minMaxOpenFileKb,
                              maxMaxOpenFileKb,
                              defaultMaxOpenFileKb,
                            );
                            setMaxOpenFileKb(next);
                            setStatus(`Editable file limit set to ${next} KB`);
                          }}
                        />
                      </label>
                      <label className="dialog-field">
                        <span>Quick open results</span>
                        <input
                          inputMode="numeric"
                          min={minQuickOpenResultLimit}
                          max={maxQuickOpenResultLimit}
                          step={1}
                          type="number"
                          value={quickOpenResultLimit}
                          onChange={(event) => {
                            const next = sanitizeNumberLimit(
                              Number(event.target.value),
                              minQuickOpenResultLimit,
                              maxQuickOpenResultLimit,
                              defaultQuickOpenResultLimit,
                            );
                            setQuickOpenResultLimit(next);
                            setStatus(`Quick open result limit set to ${next}`);
                          }}
                        />
                      </label>
                      <label className="dialog-field">
                        <span>Command palette results</span>
                        <input
                          inputMode="numeric"
                          min={minCommandPaletteResultLimit}
                          max={maxCommandPaletteResultLimit}
                          step={1}
                          type="number"
                          value={commandPaletteResultLimit}
                          onChange={(event) => {
                            const next = sanitizeNumberLimit(
                              Number(event.target.value),
                              minCommandPaletteResultLimit,
                              maxCommandPaletteResultLimit,
                              defaultCommandPaletteResultLimit,
                            );
                            setCommandPaletteResultLimit(next);
                            setStatus(`Command palette result limit set to ${next}`);
                          }}
                        />
                      </label>
                    </section>
                  ) : null}

                  {settingsCategory === "search" ? (
                    <section
                      className="settings-section"
                      aria-label="Search limits"
                      role="tabpanel"
                      id="settings-panel-search"
                      aria-labelledby="settings-tab-search"
                    >
                      <div className="settings-section__title">Search Limits</div>
                      <label className="dialog-field">
                        <span>Workspace search results</span>
                        <input
                          inputMode="numeric"
                          min={minWorkspaceSearchResultLimit}
                          max={maxWorkspaceSearchResultLimit}
                          step={25}
                          type="number"
                          value={workspaceSearchResultLimit}
                          onChange={(event) => {
                            const next = sanitizeNumberLimit(
                              Number(event.target.value),
                              minWorkspaceSearchResultLimit,
                              maxWorkspaceSearchResultLimit,
                              defaultWorkspaceSearchResultLimit,
                            );
                            setWorkspaceSearchResultLimit(next);
                            setStatus(`Workspace search result limit set to ${next}`);
                          }}
                        />
                      </label>
                      <label className="dialog-field">
                        <span>Workspace search file KB</span>
                        <input
                          inputMode="numeric"
                          min={minWorkspaceSearchMaxFileKb}
                          max={maxWorkspaceSearchMaxFileKb}
                          step={64}
                          type="number"
                          value={workspaceSearchMaxFileKb}
                          onChange={(event) => {
                            const next = sanitizeNumberLimit(
                              Number(event.target.value),
                              minWorkspaceSearchMaxFileKb,
                              maxWorkspaceSearchMaxFileKb,
                              defaultWorkspaceSearchMaxFileKb,
                            );
                            setWorkspaceSearchMaxFileKb(next);
                            setStatus(`Workspace search file limit set to ${next} KB`);
                          }}
                        />
                      </label>
                      <label className="dialog-field">
                        <span>Current-file search results</span>
                        <input
                          inputMode="numeric"
                          min={minCurrentFileSearchResultLimit}
                          max={maxCurrentFileSearchResultLimit}
                          step={25}
                          type="number"
                          value={currentFileSearchResultLimit}
                          onChange={(event) => {
                            const next = sanitizeNumberLimit(
                              Number(event.target.value),
                              minCurrentFileSearchResultLimit,
                              maxCurrentFileSearchResultLimit,
                              defaultCurrentFileSearchResultLimit,
                            );
                            setCurrentFileSearchResultLimit(next);
                            setStatus(`Current-file search result limit set to ${next}`);
                          }}
                        />
                      </label>
                      <label className="dialog-field">
                        <span>Current-file result rows</span>
                        <input
                          inputMode="numeric"
                          min={minCurrentFileResultPreviewLimit}
                          max={maxCurrentFileResultPreviewLimit}
                          step={1}
                          type="number"
                          value={currentFileResultPreviewLimit}
                          onChange={(event) => {
                            const next = sanitizeNumberLimit(
                              Number(event.target.value),
                              minCurrentFileResultPreviewLimit,
                              maxCurrentFileResultPreviewLimit,
                              defaultCurrentFileResultPreviewLimit,
                            );
                            setCurrentFileResultPreviewLimit(next);
                            setStatus(`Current-file result rows set to ${next}`);
                          }}
                        />
                      </label>
                    </section>
                  ) : null}

                  {settingsCategory === "preview" ? (
                    <section
                      className="settings-section"
                      aria-label="Preview features"
                      role="tabpanel"
                      id="settings-panel-preview"
                      aria-labelledby="settings-tab-preview"
                    >
                      <div className="settings-section__title">Preview Features</div>
                      <p className="settings-note">
                        In-progress features you can opt into. They may change or be
                        removed, and stable ones graduate into a normal setting.
                      </p>
                      {previewFeatureFlags().map((flag) => {
                        const enabled = isFeatureEnabled(flag.id, featureFlags);
                        return (
                          <label className="settings-row settings-flag" key={flag.id}>
                            <input
                              type="checkbox"
                              aria-label={flag.label}
                              checked={enabled}
                              onChange={(event) => {
                                const next = event.target.checked;
                                setFeatureFlags((prev) => ({
                                  ...prev,
                                  [flag.id]: next,
                                }));
                                setStatus(
                                  next
                                    ? `Enabled preview feature: ${flag.label}`
                                    : `Disabled preview feature: ${flag.label}`,
                                );
                              }}
                            />
                            <span className="settings-flag__text">
                              <span className="settings-flag__label">{flag.label}</span>
                              <span className="settings-flag__desc">
                                {flag.description}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </section>
                  ) : null}

                  {settingsCategory === "storage" ? (
                    <section
                      className="settings-section"
                      aria-label="Settings storage"
                      role="tabpanel"
                      id="settings-panel-storage"
                      aria-labelledby="settings-tab-storage"
                    >
                      <div className="settings-section__title">Storage</div>
                      <p className="settings-note">
                        Settings and recents are stored in the operating system app-data
                        directory. The workspace index is app-local cache data and can be
                        rebuilt.
                      </p>
                      <div className="settings-path-list">
                        <div className="settings-path-row">
                          <span>Settings file</span>
                          <code>{settingsLocations.settingsFile ?? "Native app data path unavailable"}</code>
                          {settingsLocations.settingsFile ? (
                            <button
                              className="command-button command-button--icon"
                              type="button"
                              aria-label="Copy settings file path"
                              title="Copy settings file path"
                              onClick={() =>
                                void copyText("settings file path", settingsLocations.settingsFile!)
                              }
                            >
                              <Copy size={15} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                        <div className="settings-path-row">
                          <span>Recent files</span>
                          <code>{settingsLocations.recentsFile ?? "Native app data path unavailable"}</code>
                          {settingsLocations.recentsFile ? (
                            <button
                              className="command-button command-button--icon"
                              type="button"
                              aria-label="Copy recents file path"
                              title="Copy recents file path"
                              onClick={() =>
                                void copyText("recents file path", settingsLocations.recentsFile!)
                              }
                            >
                              <Copy size={15} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                        <div className="settings-path-row">
                          <span>Workspace index</span>
                          <code>{settingsLocations.workspaceIndexFile ?? "Native app-local data path unavailable"}</code>
                          {settingsLocations.workspaceIndexFile ? (
                            <button
                              className="command-button command-button--icon"
                              type="button"
                              aria-label="Copy workspace index path"
                              title="Copy workspace index path"
                              onClick={() =>
                                void copyText(
                                  "workspace index path",
                                  settingsLocations.workspaceIndexFile!,
                                )
                              }
                            >
                              <Copy size={15} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div className="settings-section__title">Workspace Index</div>
                      {workspaceIndexStats ? (
                        <div className="settings-stats-grid" aria-label="Workspace index coverage">
                          <div className="settings-stat">
                            <span>Indexed files</span>
                            <strong>{workspaceIndexStats.indexedFiles.toLocaleString()}</strong>
                          </div>
                          <div className="settings-stat">
                            <span>Indexed folders</span>
                            <strong>{workspaceIndexStats.indexedFolders.toLocaleString()}</strong>
                          </div>
                          <div className="settings-stat">
                            <span>Loaded folders</span>
                            <strong>{workspaceIndexStats.loadedFolders.toLocaleString()}</strong>
                          </div>
                          <div className="settings-stat">
                            <span>Pending folders</span>
                            <strong>{workspaceIndexStats.pendingFolders.toLocaleString()}</strong>
                          </div>
                          <div className="settings-stat settings-stat--wide">
                            <span>Indexed entries</span>
                            <strong>{workspaceIndexStats.indexedEntries.toLocaleString()}</strong>
                          </div>
                        </div>
                      ) : (
                        <p className="settings-note">Workspace index stats have not loaded yet.</p>
                      )}
                    </section>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--primary"
                type="button"
                onClick={() => setSettingsOpen(false)}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {goToLineDialogOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="go-to-line-title"
            onSubmit={(event) => {
              event.preventDefault();
              goToLine();
            }}
          >
            <div>
              <div className="eyebrow">Navigate</div>
              <h2 id="go-to-line-title">Go to line</h2>
              <p>{activeFile?.path}</p>
              <label className="dialog-field">
                <span>Line number</span>
                <input
                  autoFocus
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={goToLineValue}
                  onChange={(event) => setGoToLineValue(event.target.value)}
                  placeholder="42"
                />
              </label>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--quiet"
                type="button"
                onClick={closeGoToLineDialog}
              >
                Cancel
              </button>
              <button className="command-button command-button--primary" type="submit">
                <ListOrdered size={15} />
                Go
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {newFileDialogOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-file-title"
            onSubmit={(event) => {
              event.preventDefault();
              createNewFile();
            }}
          >
            <div>
              <div className="eyebrow">Workspace</div>
              <h2 id="new-file-title">New file</h2>
              <label className="dialog-field">
                <span>Path</span>
                <input
                  autoFocus
                  value={newFilePath}
                  onChange={(event) => setNewFilePath(event.target.value)}
                  placeholder="src/new-file.ts"
                />
              </label>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--quiet"
                type="button"
                onClick={closeNewFileDialog}
              >
                Cancel
              </button>
              <button className="command-button command-button--primary" type="submit">
                <FilePlus size={15} />
                Create
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {newFolderDialogOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-folder-title"
            onSubmit={(event) => {
              event.preventDefault();
              createNewFolder();
            }}
          >
            <div>
              <div className="eyebrow">Workspace</div>
              <h2 id="new-folder-title">New folder</h2>
              <label className="dialog-field">
                <span>Path</span>
                <input
                  autoFocus
                  value={newFolderPath}
                  onChange={(event) => setNewFolderPath(event.target.value)}
                  placeholder="src/features"
                />
              </label>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--quiet"
                type="button"
                onClick={closeNewFolderDialog}
              >
                Cancel
              </button>
              <button className="command-button command-button--primary" type="submit">
                <FolderPlus size={15} />
                Create
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {renameDialogOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-file-title"
            onSubmit={(event) => {
              event.preventDefault();
              renameSelectedEntry();
            }}
          >
            <div>
              <div className="eyebrow">Workspace</div>
              <h2 id="rename-file-title">
                Rename {renameSourceEntry?.isDir ? "folder" : "file"}
              </h2>
              <p>{renameFromPath}</p>
              <label className="dialog-field">
                <span>New path</span>
                <input
                  autoFocus
                  value={renameToPath}
                  onChange={(event) => setRenameToPath(event.target.value)}
                  placeholder="src/renamed-file.ts"
                />
              </label>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--quiet"
                type="button"
                onClick={closeRenameDialog}
              >
                Cancel
              </button>
              <button className="command-button command-button--primary" type="submit">
                <Pencil size={15} />
                Rename
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {pendingDeleteFile ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-file-title"
          >
            <div>
              <div className="eyebrow">Workspace</div>
              <h2 id="delete-file-title">
                Delete {pendingDeleteFile.isDir ? "folder" : "file"}?
              </h2>
              <p>
                {pendingDeleteFile.path} will be permanently removed from the workspace.
                {pendingDeleteFile.isDir
                  ? " Any files inside this folder will also be removed."
                  : ""}
                {pendingDeleteOpenFiles.some((file) => file.dirty)
                  ? " This selection also has unsaved editor changes."
                  : ""}
              </p>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--quiet"
                onClick={cancelDeleteSelectedFile}
              >
                Cancel
              </button>
              <button
                className="command-button command-button--danger"
                onClick={deleteSelectedEntry}
              >
                <Trash2 size={15} />
                Delete
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingSymlinkTrust ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="symlink-trust-title"
          >
            <div>
              <div className="eyebrow">External symbolic link</div>
              <h2 id="symlink-trust-title">Follow link outside the workspace?</h2>
              <p>
                <code>{pendingSymlinkTrust.entry.path}</code> points to{" "}
                <code>{pendingSymlinkTrust.entry.symlinkTarget ?? "an external location"}</code>,
                which is outside this workspace. Following it lets the editor{" "}
                {pendingSymlinkTrust.action === "open" ? "read and edit" : "browse"} files
                outside the folder you opened.
              </p>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--quiet"
                onClick={cancelSymlinkTrust}
              >
                Cancel
              </button>
              <button
                className="command-button command-button--quiet"
                onClick={() => confirmSymlinkTrust("once")}
              >
                Trust once
              </button>
              <button
                className="command-button"
                onClick={() => confirmSymlinkTrust("workspace")}
              >
                Trust for workspace
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingCloseFile ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="dirty-close-title"
          >
            <div>
              <div className="eyebrow">Unsaved changes</div>
              <h2 id="dirty-close-title">Close modified file?</h2>
              <p>
                {pendingCloseFile.path} has edits that have not been saved.
              </p>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--quiet"
                onClick={() => setPendingClosePath(undefined)}
              >
                Cancel
              </button>
              <button
                className="command-button command-button--danger"
                onClick={() => closeFile(pendingCloseFile.path)}
              >
                <Trash2 size={15} />
                Discard
              </button>
              <button
                className="command-button command-button--primary"
                onClick={saveAndClosePendingFile}
              >
                <Save size={15} />
                Save
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingCloseAll ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="dirty-close-all-title"
          >
            <div>
              <div className="eyebrow">Unsaved changes</div>
              <h2 id="dirty-close-all-title">Close all files?</h2>
              <p>
                {dirtyFiles.length === 1
                  ? `${dirtyFiles[0].path} has edits that have not been saved.`
                  : `${dirtyFiles.length} files have edits that have not been saved.`}
              </p>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--quiet"
                onClick={() => setPendingCloseAll(false)}
              >
                Cancel
              </button>
              <button
                className="command-button command-button--danger"
                onClick={closeAllFiles}
              >
                <Trash2 size={15} />
                Discard
              </button>
              <button
                className="command-button command-button--primary"
                onClick={saveAllAndCloseFiles}
              >
                <Save size={15} />
                Save All
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingReloadFile ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reload-file-title"
          >
            <div>
              <div className="eyebrow">
                {pendingReloadRequest?.reason === "external"
                  ? "File changed on disk"
                  : "Unsaved changes"}
              </div>
              <h2 id="reload-file-title">Reload file from disk?</h2>
              <p>
                {pendingReloadRequest?.reason === "external"
                  ? `${pendingReloadFile.path} has unsaved edits, and the file changed on disk. Reloading will discard your editor changes. Keeping them lets your next save overwrite the disk version.`
                  : `${pendingReloadFile.path} has edits that will be discarded and replaced with the current disk contents.`}
              </p>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--quiet"
                onClick={cancelReloadActiveFile}
              >
                {pendingReloadRequest?.reason === "external" ? "Keep Mine" : "Cancel"}
              </button>
              <button
                className="command-button command-button--danger"
                onClick={() => reloadFileFromDisk(pendingReloadFile.path)}
              >
                <RotateCcw size={15} />
                Reload
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingAppClose ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="app-close-title"
          >
            <div>
              <div className="eyebrow">Unsaved changes</div>
              <h2 id="app-close-title">Close ide?</h2>
              <p>
                {dirtyFiles.length === 1
                  ? `${dirtyFiles[0].path} has edits that have not been saved.`
                  : `${dirtyFiles.length} files have edits that have not been saved.`}
              </p>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--quiet"
                onClick={() => setPendingAppClose(false)}
              >
                Cancel
              </button>
              <button
                className="command-button command-button--danger"
                onClick={closeApplication}
              >
                <Trash2 size={15} />
                Discard
              </button>
              <button
                className="command-button command-button--primary"
                onClick={saveAllAndCloseApplication}
              >
                <Save size={15} />
                Save All
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {error ? (
        <div className="toast" role="alert">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
    </main>
  );
}

interface TreeItemSelection {
  selectedPaths: Set<string>;
  onToggleFile: (path: string) => void;
  onSetFolderSelected: (paths: string[], selected: boolean) => void;
}

function TreeItem({
  expandedFolders,
  forceExpanded,
  node,
  selectedPath,
  onOpen,
  onSelect,
  onToggleFolder,
  fileStatusByPath,
  changedFolderPaths,
  selection,
}: {
  expandedFolders: Set<string>;
  forceExpanded: boolean;
  node: TreeNode;
  selectedPath?: string;
  onOpen: (entry: FileEntry, pinned?: boolean) => void;
  onSelect: (path: string) => void;
  onToggleFolder: (path: string) => void;
  // Git status overlay (Part 2) — present in both normal browsing and commit
  // mode. `undefined` (not empty) when there's nothing to show, so the row
  // renders exactly as it does today with the flag off.
  fileStatusByPath?: Map<string, GitStatusEntry["status"]>;
  changedFolderPaths?: Set<string>;
  // Presence alone means "commit/selection mode" — adds the leading checkbox
  // column and is the only thing that changes between browsing and committing;
  // expand/collapse, and everything else, stays identical in both.
  selection?: TreeItemSelection;
}) {
  const expanded = forceExpanded || expandedFolders.has(node.path);
  const Icon = iconForFile(node.name, node.isDir);
  const isActive = selectedPath === node.path;
  const fileStatus = !node.isDir ? fileStatusByPath?.get(node.path) : undefined;
  const isDeleted = fileStatus === "deleted";
  const hasChangedDescendant = node.isDir && Boolean(changedFolderPaths?.has(node.path));
  // Depends on `node` and a plain boolean, not the `selection` object itself —
  // `selection.selectedPaths` gets a new identity on every checkbox toggle,
  // and a node's leaf set never changes just because the selection did, so
  // keying on `selection` would recompute (and re-walk the whole subtree)
  // on every toggle instead of only when the tree itself changes.
  const hasSelection = Boolean(selection);
  const leafPaths = useMemo(
    () => (node.isDir && hasSelection ? collectTreeLeafPaths(node) : undefined),
    [node, hasSelection],
  );
  const folderSelectionState =
    leafPaths && selection ? treeSelectionState(leafPaths, selection.selectedPaths) : undefined;
  const showTrailing = node.isSymlink || Boolean(fileStatus) || hasChangedDescendant;
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const activatesRow =
      event.key === "Enter" || event.key === " " || event.key === "Spacebar";

    if (activatesRow) {
      event.preventDefault();
      onSelect(node.path);
      if (node.isDir) {
        onToggleFolder(node.path);
      } else {
        onOpen(node, false);
      }
      return;
    }

    if (!node.isDir) return;

    if (event.key === "ArrowRight") {
      event.preventDefault();
      onSelect(node.path);
      if (!expanded) {
        onToggleFolder(node.path);
      }
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onSelect(node.path);
      if (expanded) {
        onToggleFolder(node.path);
      }
    }
  };

  return (
    <div>
      <div className="tree-row-line" style={{ paddingLeft: 8 + node.depth * 14 }}>
        {selection ? (
          node.isDir ? (
            <TriStateCheckbox
              state={folderSelectionState ?? "none"}
              onToggle={() =>
                selection.onSetFolderSelected(leafPaths ?? [], folderSelectionState !== "all")
              }
              ariaLabel={`${folderSelectionState === "all" ? "Deselect" : "Select"} folder ${node.path}`}
            />
          ) : (
            <input
              type="checkbox"
              className="tree-row__check"
              checked={selection.selectedPaths.has(node.path)}
              onChange={() => selection.onToggleFile(node.path)}
              aria-label={`${selection.selectedPaths.has(node.path) ? "Deselect" : "Select"} ${node.path}`}
            />
          )
        ) : null}
        <button
          className={[
            "tree-row",
            isActive ? "tree-row--active" : "",
            isDeleted ? "tree-row--deleted" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="treeitem"
          aria-expanded={node.isDir ? expanded : undefined}
          aria-level={node.depth + 1}
          aria-selected={isActive}
          onClick={() => {
            onSelect(node.path);
            if (node.isDir) {
              onToggleFolder(node.path);
            } else {
              onOpen(node, false);
            }
          }}
          onDoubleClick={() => {
            if (!node.isDir) {
              onOpen(node, true);
            }
          }}
          onKeyDown={handleKeyDown}
        >
          {node.isDir ? (
            <ChevronRight
              className={expanded ? "chevron chevron--open" : "chevron"}
              size={14}
            />
          ) : (
            <span className="tree-row__spacer" />
          )}
          <Icon className="tree-row__icon" size={15} />
          <span className="tree-row__name">{node.name}</span>
          {showTrailing ? (
            <span className="tree-row__trailing">
              {node.isSymlink ? (
                node.isExternal ? (
                  <ExternalLink
                    className="tree-row__symlink tree-row__symlink--external"
                    size={12}
                    aria-label="External symbolic link"
                    data-testid="tree-symlink-external"
                  />
                ) : (
                  <Link2
                    className="tree-row__symlink"
                    size={12}
                    aria-label="Symbolic link"
                    data-testid="tree-symlink"
                  />
                )
              ) : null}
              {fileStatus ? (
                <span
                  className={`tree-row__status tree-row__status--${fileStatus}`}
                  aria-hidden="true"
                >
                  {gitFileStatusLabel(fileStatus)}
                </span>
              ) : null}
              {hasChangedDescendant ? (
                <span className="tree-row__status-dot" aria-hidden="true" />
              ) : null}
            </span>
          ) : null}
        </button>
      </div>
      {node.isDir && expanded
        ? node.children.map((child) => (
            <TreeItem
              key={child.path}
              expandedFolders={expandedFolders}
              forceExpanded={forceExpanded}
              node={child}
              selectedPath={selectedPath}
              onOpen={onOpen}
              onSelect={onSelect}
              onToggleFolder={onToggleFolder}
              fileStatusByPath={fileStatusByPath}
              changedFolderPaths={changedFolderPaths}
              selection={selection}
            />
          ))
        : null}
    </div>
  );
}

function buildTree(entries: FileEntry[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const entry of entries) {
    nodes.set(entry.path, { ...entry, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parent && nodes.has(node.parent)) {
      nodes.get(node.parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (items: TreeNode[]) => {
    items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    items.forEach((item) => sortNodes(item.children));
  };
  sortNodes(roots);
  return roots;
}

function gitFileStatusLabel(status: GitStatusEntry["status"]): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}

// All file (leaf) paths beneath a node — folders drive selection of their
// descendants via these, since a folder itself is never in the selected set.
function collectTreeLeafPaths(node: TreeNode): string[] {
  return node.isDir ? node.children.flatMap(collectTreeLeafPaths) : [node.path];
}

type TreeSelectionState = "none" | "some" | "all";

function treeSelectionState(paths: string[], selected: Set<string>): TreeSelectionState {
  let selectedCount = 0;
  for (const path of paths) {
    if (selected.has(path)) selectedCount += 1;
  }
  if (selectedCount === 0) return "none";
  return selectedCount === paths.length ? "all" : "some";
}

// `indeterminate` is a DOM-only property React can't set from JSX, so it's
// applied imperatively whenever the tri-state changes.
function TriStateCheckbox({
  state,
  onToggle,
  ariaLabel,
}: {
  state: TreeSelectionState;
  onToggle: () => void;
  ariaLabel: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={inputRef}
      type="checkbox"
      className="tree-row__check"
      checked={state === "all"}
      aria-checked={state === "some" ? "mixed" : state === "all"}
      onChange={onToggle}
      aria-label={ariaLabel}
    />
  );
}

// Builds stub FileEntry rows for changed paths the workspace scan doesn't
// have — always true for deletions (the file is gone from disk), and
// possible for anything else too (a lazily-loaded folder that hasn't been
// scanned yet, a file created outside the IDE since the last scan). Covering
// every status, not just deleted, keeps a changed file from silently
// vanishing from the commit-mode tree just because the scan hasn't caught up.
function syntheticMissingFileEntries(
  changedFiles: GitStatusEntry[],
  existingPaths: Set<string>,
): FileEntry[] {
  return changedFiles
    .filter((file) => !existingPaths.has(file.path))
    .map((file) => {
      const segments = file.path.split("/");
      const parent = segments.length > 1 ? segments.slice(0, -1).join("/") : undefined;
      return {
        path: file.path,
        name: segments[segments.length - 1],
        parent,
        isDir: false,
        depth: segments.length - 1,
        size: 0,
      };
    });
}

// Prunes a tree down to the file nodes whose path is in `paths`, plus their
// ancestor folders — the commit panel's "changed files + the folders that
// contain them" view over the exact same tree the workspace browser renders.
function filterTreeToPaths(nodes: TreeNode[], paths: Set<string>): TreeNode[] {
  return nodes
    .map((node) => {
      const children = filterTreeToPaths(node.children, paths);
      if ((!node.isDir && paths.has(node.path)) || children.length > 0) {
        return { ...node, children };
      }
      return undefined;
    })
    .filter((node): node is TreeNode => Boolean(node));
}

function mergeFileEntries(current: FileEntry[], nextEntries: FileEntry[]) {
  const entriesByPath = new Map(current.map((entry) => [entry.path, entry]));
  for (const entry of nextEntries) {
    entriesByPath.set(entry.path, entry);
  }
  return [...entriesByPath.values()];
}

function filterTree(nodes: TreeNode[], filter: string): TreeNode[] {
  if (!filter) return nodes;
  return nodes
    .map((node) => {
      const children = filterTree(node.children, filter);
      if (node.path.toLowerCase().includes(filter) || children.length > 0) {
        return { ...node, children };
      }
      return undefined;
    })
    .filter((node): node is TreeNode => Boolean(node));
}

function lastSegment(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

type ShortcutAction =
  | "commandPalette"
  | "goToFile"
  | "goToLine"
  | "findInFile"
  | "findInFiles"
  | "findInFileReplace"
  | "goToDefinition"
  | "findReferences"
  | "saveAll"
  | "synchronizeFromDisk"
  | "newFile"
  | "rename"
  | "closeTab"
  | "closeAll"
  | "showProject"
  | "zoomEditorIn"
  | "zoomEditorOut"
  | "zoomAppIn"
  | "zoomAppOut"
  | "nextTab"
  | "previousTab";

interface ShortcutPattern {
  key: string | string[];
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

const intellijShortcuts: Record<ShortcutAction, { mac: ShortcutPattern; other: ShortcutPattern }> = {
  commandPalette: {
    mac: { key: "a", meta: true, shift: true },
    other: { key: "a", ctrl: true, shift: true },
  },
  goToFile: {
    mac: { key: "o", meta: true, shift: true },
    other: { key: "n", ctrl: true, shift: true },
  },
  goToLine: {
    mac: { key: "l", meta: true },
    other: { key: "g", ctrl: true },
  },
  findInFile: {
    mac: { key: "f", meta: true },
    other: { key: "f", ctrl: true },
  },
  findInFiles: {
    mac: { key: "f", meta: true, shift: true },
    other: { key: "f", ctrl: true, shift: true },
  },
  findInFileReplace: {
    mac: { key: "r", meta: true },
    other: { key: "r", ctrl: true },
  },
  goToDefinition: {
    mac: { key: "b", meta: true },
    other: { key: "b", ctrl: true },
  },
  findReferences: {
    mac: { key: "F7", alt: true },
    other: { key: "F7", alt: true },
  },
  saveAll: {
    mac: { key: "s", meta: true },
    other: { key: "s", ctrl: true },
  },
  synchronizeFromDisk: {
    mac: { key: "y", meta: true, alt: true },
    other: { key: "y", ctrl: true, alt: true },
  },
  newFile: {
    mac: { key: "n", ctrl: true, alt: true },
    other: { key: "Insert", ctrl: true, alt: true },
  },
  rename: {
    mac: { key: "F6", shift: true },
    other: { key: "F6", shift: true },
  },
  closeTab: {
    mac: { key: "w", meta: true },
    other: { key: "F4", ctrl: true },
  },
  closeAll: {
    mac: { key: "w", meta: true, shift: true },
    other: { key: "F4", ctrl: true, shift: true },
  },
  showProject: {
    mac: { key: "1", meta: true },
    other: { key: "1", alt: true },
  },
  zoomEditorIn: {
    mac: { key: "=", meta: true },
    other: { key: "=", ctrl: true },
  },
  zoomEditorOut: {
    mac: { key: "-", meta: true },
    other: { key: "-", ctrl: true },
  },
  zoomAppIn: {
    mac: { key: ["=", "+"], meta: true, shift: true },
    other: { key: ["=", "+"], ctrl: true, shift: true },
  },
  zoomAppOut: {
    mac: { key: ["-", "_"], meta: true, shift: true },
    other: { key: ["-", "_"], ctrl: true, shift: true },
  },
  nextTab: {
    mac: { key: ["]", "}"], meta: true, shift: true },
    other: { key: "ArrowRight", alt: true },
  },
  previousTab: {
    mac: { key: ["[", "{"], meta: true, shift: true },
    other: { key: "ArrowLeft", alt: true },
  },
};

function currentPlatformShortcut(shortcut: PlatformShortcut) {
  return isMacPlatform() ? shortcut.mac : shortcut.other;
}

function commitTimeLabel(
  commit: GitCommitInfo,
  dateTimeFormat: DateTimeFormatId,
  recentRelativeThreshold: RecentRelativeThresholdId,
) {
  if (commit.authoredAtSeconds === undefined) return "";
  return formatDateTime(
    commit.authoredAtSeconds * 1000,
    dateTimeFormat,
    recentRelativeThreshold,
  );
}

function commitDateLabel(
  commit: GitCommitInfo,
  dateTimeFormat: DateTimeFormatId,
  recentRelativeThreshold: RecentRelativeThresholdId,
) {
  if (commit.authoredAtSeconds === undefined) return "Unknown";
  return formatDateTime(
    commit.authoredAtSeconds * 1000,
    dateTimeFormat,
    recentRelativeThreshold,
  );
}

function fullCommitDescription(
  commit: GitCommitInfo,
  dateTimeFormat: DateTimeFormatId,
  recentRelativeThreshold: RecentRelativeThresholdId,
) {
  const time = commitTimeLabel(commit, dateTimeFormat, recentRelativeThreshold);
  const date = formatDateTimeAbsolute(
    commit.authoredAtSeconds === undefined
      ? undefined
      : commit.authoredAtSeconds * 1000,
  );
  return [
    `${commit.authorName}${time ? `, ${time}` : ""}`,
    commit.shortSha,
    date,
    commit.summary,
  ]
    .filter(Boolean)
    .join(" - ");
}

function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  const userAgent = navigator.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform) || /macintosh|mac os x/i.test(userAgent);
}

function isIntellijShortcut(event: KeyboardEvent, action: ShortcutAction) {
  const platformShortcut = intellijShortcuts[action];
  return matchesShortcut(event, isMacPlatform() ? platformShortcut.mac : platformShortcut.other);
}

function matchesShortcut(event: KeyboardEvent, pattern: ShortcutPattern) {
  const keys = Array.isArray(pattern.key) ? pattern.key : [pattern.key];
  const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const expectedKeys = keys.map((key) => (key.length === 1 ? key.toLowerCase() : key));
  let keyMatches = expectedKeys.includes(eventKey);

  if (!keyMatches && event.altKey && isMacPlatform()) {
    keyMatches = keys.some(
      (key) => /^[a-z]$/i.test(key) && event.code === `Key${key.toUpperCase()}`,
    );
  }

  return (
    keyMatches &&
    event.metaKey === Boolean(pattern.meta) &&
    event.ctrlKey === Boolean(pattern.ctrl) &&
    event.altKey === Boolean(pattern.alt) &&
    event.shiftKey === Boolean(pattern.shift)
  );
}

function isGlobalIdeShortcut(event: KeyboardEvent) {
  return (Object.keys(intellijShortcuts) as ShortcutAction[]).some((action) =>
    isIntellijShortcut(event, action),
  );
}

function filterKeyBindings(bindings: KeyBindingInfo[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return bindings;
  return bindings.filter((binding) =>
    [
      binding.category,
      binding.command,
      binding.shortcut.mac,
      binding.shortcut.other,
      binding.when ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalized),
  );
}

function parentFolderPaths(path: string) {
  const segments = path.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    parents.push(segments.slice(0, index).join("/"));
  }
  return parents;
}

function suggestNewFilePath(selectedPath: string | undefined, files: FileEntry[]) {
  const selected = selectedPath
    ? files.find((file) => file.path === selectedPath)
    : undefined;
  const prefix = selected?.isDir
    ? selected.path
    : selected?.parent
      ? selected.parent
      : "";
  const existing = new Set(files.map((file) => file.path));

  for (let index = 0; index < 100; index += 1) {
    const name = index === 0 ? "untitled.txt" : `untitled-${index}.txt`;
    const candidate = prefix ? `${prefix}/${name}` : name;
    if (!existing.has(candidate)) return candidate;
  }

  return prefix ? `${prefix}/untitled.txt` : "untitled.txt";
}

function suggestNewFolderPath(selectedPath: string | undefined, files: FileEntry[]) {
  const selected = selectedPath
    ? files.find((file) => file.path === selectedPath)
    : undefined;
  const prefix = selected?.isDir
    ? selected.path
    : selected?.parent
      ? selected.parent
      : "";
  const existing = new Set(files.map((file) => file.path));

  for (let index = 0; index < 100; index += 1) {
    const name = index === 0 ? "new-folder" : `new-folder-${index}`;
    const candidate = prefix ? `${prefix}/${name}` : name;
    if (!existing.has(candidate)) return candidate;
  }

  return prefix ? `${prefix}/new-folder` : "new-folder";
}
