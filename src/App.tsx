import {
  type KeyboardEvent as ReactKeyboardEvent,
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
  ChevronRight,
  Circle,
  Copy,
  FileInput,
  FilePlus,
  FileCog,
  FolderOpen,
  FolderPlus,
  ListOrdered,
  ListFilter,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
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
  currentFileMatches,
  nextCurrentFileMatchIndex,
} from "./currentFileSearch";
import { iconForFile, isKnownBinaryFile } from "./fileTypes";
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
import { destroyNativeWindow, onNativeWindowCloseRequested } from "./appWindow";
import {
  AgentContext,
  ClaudeBridgeStatus,
  CodexMcpStatus,
  EditorDiagnostic,
  EditorSelection,
  FileEntry,
  LspServerStatus,
  SearchMatch,
  createFile,
  createFolder,
  deleteFile,
  getClaudeBridgeStatus,
  getCodexMcpStatus,
  getHttpEndpoint,
  getInitialFile,
  getLspServers,
  getUiState,
  getWorkspaceRoot,
  isNativeTauri,
  listDirectory,
  listFiles,
  pickOpenFile,
  pickWorkspaceFolder,
  readFile,
  recordRecentFile,
  renameFile,
  searchIndexedFiles,
  searchFiles,
  setWorkspaceRootPath,
  statFile,
  takeOpenedLaunchTargets,
  updateAgentContext,
  updateUiState,
  writeFile,
  type OpenLaunchRequest,
  type PersistedUiSnapshot,
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
  numberedTabPath,
  pinTab,
  tabCloseRequiresConfirmation,
  updateTabContents,
  type EditorTab,
} from "./tabs";
import {
  editorCommandLabel,
  type EditorCommandName,
  type EditorCommandRequest,
} from "./editorCommands";
import { cursorStatus, type EditorCursor } from "./editorCursor";

const EditorPane = lazy(() => import("./EditorPane"));

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
}

interface OpenFailure {
  path: string;
  reason: string;
}

type SidebarSearchMode = "filter" | "content";
type SettingsCategory = "view" | "indexing" | "search" | "interface";

const settingsCategories: Array<{
  id: SettingsCategory;
  title: string;
  detail: string;
}> = [
  { id: "view", title: "View", detail: "Tree visibility" },
  { id: "indexing", title: "Indexing", detail: "Scan and file size" },
  { id: "search", title: "Search", detail: "Result and file caps" },
  { id: "interface", title: "Interface", detail: "Palette result counts" },
];

const minTreeScanLimit = 500;
const maxTreeScanLimit = 100000;
const defaultTreeScanLimit = 4000;
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
const minQuickOpenResultLimit = 5;
const maxQuickOpenResultLimit = 100;
const defaultQuickOpenResultLimit = 12;
const minCommandPaletteResultLimit = 5;
const maxCommandPaletteResultLimit = 100;
const defaultCommandPaletteResultLimit = 18;

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
  const [loadedFolders, setLoadedFolders] = useState<Set<string>>(() => new Set());
  const loadingFoldersRef = useRef<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [revealTarget, setRevealTarget] = useState<RevealTarget>();
  const [openFiles, setOpenFiles] = useState<EditorTab[]>([]);
  const [filter, setFilter] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [currentFileQuery, setCurrentFileQuery] = useState("");
  const [activeSidebarSearch, setActiveSidebarSearch] =
    useState<SidebarSearchMode>();
  const [currentFindOpen, setCurrentFindOpen] = useState(false);
  const [currentFindIndex, setCurrentFindIndex] = useState(-1);
  const [editorCommand, setEditorCommand] = useState<EditorCommandRequest>();
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
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
  const [pendingReloadPath, setPendingReloadPath] = useState<string>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pendingClosePath, setPendingClosePath] = useState<string>();
  const [pendingCloseAll, setPendingCloseAll] = useState(false);
  const [pendingAppClose, setPendingAppClose] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("view");
  const [showDotfiles, setShowDotfiles] = useState(false);
  const [showGeneratedInternal, setShowGeneratedInternal] = useState(false);
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
  const [commandPaletteResultLimit, setCommandPaletteResultLimit] = useState(
    defaultCommandPaletteResultLimit,
  );
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const [uiStateLoaded, setUiStateLoaded] = useState(false);
  const [workspaceUiRestored, setWorkspaceUiRestored] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [openFailure, setOpenFailure] = useState<OpenFailure>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("Ready");
  const [selection, setSelection] = useState<EditorSelection>();
  const [cursor, setCursor] = useState<EditorCursor>();
  const [lspServers, setLspServers] = useState<LspServerStatus[]>([]);
  const [diagnosticsByPath, setDiagnosticsByPath] = useState<
    Record<string, EditorDiagnostic[]>
  >({});
  const [httpEndpoint, setHttpEndpoint] = useState<string>();
  const [codexMcp, setCodexMcp] = useState<CodexMcpStatus>();
  const [claudeBridge, setClaudeBridge] = useState<ClaudeBridgeStatus>();
  const sidebarFilterInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarContentSearchInputRef = useRef<HTMLInputElement | null>(null);
  const currentFindInputRef = useRef<HTMLInputElement | null>(null);
  const initialFileOpenedRef = useRef(false);
  const openedLaunchTargetsDrainedRef = useRef(false);
  const persistedWorkspaceRef = useRef<WorkspaceUiState>({
    expandedFolders: [],
    openFiles: [],
  });
  const persistedFilesRestoredRef = useRef(false);
  const skipNextUiStatePersistRef = useRef(false);
  const uiPersistTimerRef = useRef<number | undefined>(undefined);
  const editorCommandNonceRef = useRef(0);

  const activeFile = openFiles.find((file) => file.path === activePath);
  const pendingCloseFile = openFiles.find((file) => file.path === pendingClosePath);
  const pendingDeleteFile = files.find((file) => file.path === pendingDeletePath);
  const pendingDeleteOpenFiles = pendingDeletePath
    ? openFiles.filter((file) => pathIsAtOrInside(file.path, pendingDeletePath))
    : [];
  const pendingReloadFile = openFiles.find((file) => file.path === pendingReloadPath);
  const dirtyFiles = openFiles.filter((file) => file.dirty);
  const activeFileIsDirty = Boolean(activeFile?.dirty);
  const hasDirtyFiles = dirtyFiles.length > 0;
  const activeSelection = selection?.filePath === activePath ? selection : undefined;
  const cursorPosition = cursorStatus(activePath, cursor, revealTarget);
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
      activeFile
        ? currentFileMatches(
            activeFile.path,
            activeFile.contents,
            currentFileQuery,
            currentFileSearchResultLimit,
          )
        : [],
    [activeFile, currentFileQuery, currentFileSearchResultLimit],
  );
  const diagnostics = useMemo(
    () => sortDiagnostics(Object.values(diagnosticsByPath).flat()),
    [diagnosticsByPath],
  );
  const codexMcpConfig = useMemo(
    () => (codexMcp ? codexMcpConfigSnippet(codexMcp) : ""),
    [codexMcp],
  );
  const filterExpanded = activeSidebarSearch === "filter" || filter.trim().length > 0;
  const contentSearchExpanded =
    activeSidebarSearch === "content" || contentQuery.trim().length > 0;
  const currentFindExpanded =
    Boolean(activeFile) && (currentFindOpen || currentFileQuery.trim().length > 0);
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
    : lastSegment(workspaceRoot);
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
    pendingReloadPath !== undefined ||
    pendingCloseAll ||
    pendingAppClose ||
    integrationsOpen ||
    settingsOpen ||
    pendingClosePath !== undefined;
  const modalUiOpenRef = useRef(false);

  useEffect(() => {
    modalUiOpenRef.current = modalUiOpen;
  }, [modalUiOpen]);

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
    setCommandPaletteResultLimit(
      sanitizeNumberLimit(
        snapshot.view.commandPaletteResultLimit,
        minCommandPaletteResultLimit,
        maxCommandPaletteResultLimit,
        defaultCommandPaletteResultLimit,
      ),
    );
    setExpandedFolders(new Set(snapshot.workspace.expandedFolders));
    setSelectedPath(snapshot.workspace.selectedPath);
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
        const entries = await listDirectory(path, showDotfiles, showGeneratedInternal);
        setFiles((current) => mergeFileEntries(current, entries));
        setLoadedFolders((current) => new Set(current).add(path));
      } catch (reason) {
        setError(`Unable to load folder ${path}: ${String(reason)}`);
        setStatus("Folder load failed");
      } finally {
        loadingFoldersRef.current.delete(path);
      }
    },
    [loadedFolders, showDotfiles, showGeneratedInternal, singleFileMode],
  );

  const toggleFolder = useCallback((path: string) => {
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
  }, [expandedFolders, loadFolderChildren]);

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
        setLoadedFolders(new Set());
        loadingFoldersRef.current.clear();
        setWorkspaceLoadFailed(false);
        setWorkspaceUiRestored(true);
        await refreshIntegrationStatus();
        return [entry];
      }

      const entries = await listFiles(showDotfiles, showGeneratedInternal, treeScanLimit);
      setFiles(entries);
      setLoadedFolders(new Set());
      loadingFoldersRef.current.clear();
      setWorkspaceLoadFailed(false);
      await refreshIntegrationStatus();
      return entries;
    } catch (reason) {
      setWorkspaceLoadFailed(true);
      throw reason;
    } finally {
      setWorkspaceLoading(false);
    }
  }, [
    refreshIntegrationStatus,
    showDotfiles,
    showGeneratedInternal,
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
      await refreshFiles();
      setStatus("Ready");
    } catch (reason) {
      setError(String(reason));
      setStatus("Workspace load failed");
    }
  }, [refreshFiles]);

  useEffect(() => {
    loadPersistedUiState();
  }, [loadPersistedUiState]);

  useEffect(() => {
    if (!uiStateLoaded || !launchTargetLoaded) return;
    refreshFiles().catch((reason) => {
      setError(String(reason));
      setStatus("Workspace load failed");
    });
  }, [launchTargetLoaded, refreshFiles, uiStateLoaded]);

  useEffect(() => {
    const query = contentQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    setSearchResults([]);
    setError(undefined);
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      const searchPromise = singleFileMode && singleFilePath
        ? readFile(singleFilePath, maxOpenFileKb * 1024).then((contents) =>
            currentFileMatches(
              singleFilePath,
              contents,
              query,
              currentFileSearchResultLimit,
            ),
          )
        : searchFiles(
            query,
            workspaceSearchResultLimit,
            workspaceSearchMaxFileKb * 1024,
          );

      searchPromise
        .then((results) => {
          if (cancelled) return;
          setSearchResults(results);
          setStatus(results.length === 1 ? "1 match" : `${results.length} matches`);
        })
        .catch((reason) => {
          if (cancelled) return;
          setError(`Search failed: ${String(reason)}`);
          setSearchResults([]);
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
    const context: AgentContext = {
      activeFile: activePath,
      openFiles: openFiles.map((file) => file.path),
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
      setSelectedPath(entry.path);
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
        recordRecentFile(existing.path, recordAsSingleFile).catch((reason) => {
          setError(`Unable to update recent files: ${String(reason)}`);
        });
        setStatus("Ready");
        return;
      }

      try {
        const contents = await readFile(entry.path, maxOpenFileKb * 1024);
        setOpenFiles((current) =>
          addPreviewTab(current, {
            path: entry.path,
            contents,
            dirty: false,
            modifiedMs: entry.modifiedMs,
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
    [maxOpenFileKb, openFiles, singleFileMode],
  );

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
        const entry = entriesByPath.get(path)!;
        try {
          return {
            tab: {
              path,
              contents: await readFile(path, maxOpenFileKb * 1024),
              dirty: false,
              modifiedMs: entry.modifiedMs,
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
    maxOpenFileKb,
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
          treeScanLimit,
          maxOpenFileKb,
          workspaceSearchResultLimit,
          workspaceSearchMaxFileKb,
          currentFileSearchResultLimit,
          currentFileResultPreviewLimit,
          quickOpenResultLimit,
          commandPaletteResultLimit,
        },
        {
          expandedFolders: [...expandedFolders],
          openFiles: openFiles.map((file) => file.path),
          activeFile: activePath,
          selectedPath,
        },
      ).catch((reason) => {
        setError(`Unable to save UI state: ${String(reason)}`);
      });
    }, 250);

    return () => window.clearTimeout(uiPersistTimerRef.current);
  }, [
    activePath,
    expandedFolders,
    openFilePathSignature,
    selectedPath,
    showDotfiles,
    showGeneratedInternal,
    singleFileMode,
    treeScanLimit,
    maxOpenFileKb,
    workspaceSearchResultLimit,
    workspaceSearchMaxFileKb,
    currentFileSearchResultLimit,
    currentFileResultPreviewLimit,
    quickOpenResultLimit,
    commandPaletteResultLimit,
    uiStateLoaded,
    workspaceUiRestored,
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
    setRevealTarget({ path: match.path, lineNumber: match.lineNumber });
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
      setActivePath((current) => adjacentTabPath(openFiles, current, direction));
    },
    [openFiles],
  );

  const saveFile = useCallback(async (fileToSave: EditorTab) => {
    setError(undefined);
    setStatus(`Saving ${fileToSave.path}`);
    try {
      await writeFile(fileToSave.path, fileToSave.contents, fileToSave.modifiedMs);
      const refreshedEntries = await refreshFiles();
      const modifiedMs = refreshedEntries.find(
        (entry) => entry.path === fileToSave.path,
      )?.modifiedMs;
      setOpenFiles((current) =>
        current.map((file) =>
          file.path === fileToSave.path && file.contents === fileToSave.contents
            ? { ...file, dirty: false, modifiedMs }
            : file,
        ),
      );
      setStatus("Saved");
      return true;
    } catch (reason) {
      setError(String(reason));
      setStatus("Save failed");
      return false;
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
      const contents = await readFile(path, maxOpenFileKb * 1024);
      const refreshedEntries = await refreshFiles();
      const modifiedMs = refreshedEntries.find((entry) => entry.path === path)?.modifiedMs;
      setOpenFiles((current) =>
        current.map((file) =>
          file.path === path
            ? {
                ...file,
                contents,
                dirty: false,
                modifiedMs,
              }
            : file,
        ),
      );
      setRevealTarget((current) => (current?.path === path ? undefined : current));
      setSelection((current) => (current?.filePath === path ? undefined : current));
      setPendingReloadPath(undefined);
      setStatus(`Reloaded ${path}`);
      return true;
    } catch (reason) {
      setError(String(reason));
      setStatus("Reload failed");
      return false;
    }
  }, [refreshFiles]);

  const requestReloadActiveFile = useCallback(() => {
    if (!activeFile) {
      setStatus("Reload from disk requires an open file");
      return;
    }
    if (activeFile.dirty) {
      setPendingReloadPath(activeFile.path);
      return;
    }

    reloadFileFromDisk(activeFile.path);
  }, [activeFile, reloadFileFromDisk]);

  const requestEditorCommand = useCallback(
    (name: EditorCommandName) => {
      if (!activeFile) {
        setStatus(`${editorCommandLabel(name)} requires an open file`);
        return;
      }

      editorCommandNonceRef.current += 1;
      setEditorCommand({
        filePath: activeFile.path,
        name,
        nonce: editorCommandNonceRef.current,
      });
    },
    [activeFile],
  );

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
    if (!activeFile) {
      setStatus("Find in file requires an open file");
      return;
    }

    setCurrentFindOpen(true);
  }, [activeFile]);

  const openGoToLineDialog = useCallback(() => {
    if (!activeFile) {
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
    if (!activeFile) {
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

      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (currentFileQuery.length > 0) {
        setCurrentFileQuery("");
        setCurrentFindIndex(-1);
        return;
      }

      setCurrentFindOpen(false);
    },
    [currentFileQuery, revealCurrentFindMatch],
  );

  const cancelReloadActiveFile = useCallback(() => {
    setPendingReloadPath(undefined);
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
        enabled: Boolean(activeFile),
        run: openCurrentFileFind,
      },
      {
        id: "go_to_line",
        title: "Go to Line",
        detail: activeFile ? `Jump within ${activeFile.path}` : "Jump within the active file",
        keywords: ["line number", "jump"],
        enabled: Boolean(activeFile),
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
        detail: activeFile ? `Save ${activeFile.path}` : "Save the active file",
        keywords: ["write file"],
        enabled: Boolean(activeFile),
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
        id: "show_integrations",
        title: "Show Integrations",
        detail: "Show browser, Claude, Codex, and LSP integration details",
        keywords: ["mcp", "claude", "codex", "lsp"],
        enabled: true,
        run: () => setIntegrationsOpen(true),
      },
      {
        id: "show_settings",
        title: "Settings",
        detail: "Adjust workspace view and scan limits",
        keywords: ["preferences", "dotfiles", "generated folders", "limit"],
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
      await createFile(path);
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
      await createFolder(path);
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
      await renameFile(fromPath, toPath);
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
      if (event.key === "Escape" && pendingDeletePath) {
        event.preventDefault();
        cancelDeleteSelectedFile();
        return;
      }
      if (event.key === "Escape" && pendingReloadPath) {
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

      const numberedPath =
        (event.metaKey || event.ctrlKey) && !event.shiftKey
          ? numberedTabPath(openFiles, event.key)
          : undefined;
      if (
        numberedPath
      ) {
        event.preventDefault();
        setActivePath(numberedPath);
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        saveAll();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveActive();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        requestReloadActiveFile();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "w"
      ) {
        event.preventDefault();
        requestCloseAllFiles();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
        event.preventDefault();
        requestCloseActiveFile();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        openNewFolderDialog();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        openNewFileDialog();
      } else if (
        nativePickerAvailable &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        void openWorkspace();
      } else if (
        nativePickerAvailable &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        void openFileFromDialog();
      } else if (event.key === "F2") {
        event.preventDefault();
        openRenameDialog();
      } else if (event.ctrlKey && event.shiftKey && event.key === "Tab") {
        event.preventDefault();
        activateAdjacentTab(-1);
      } else if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        activateAdjacentTab(1);
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        openCommandPalette();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        openQuickOpen();
      } else if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        openGoToLineDialog();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        openWorkspaceSearch();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openCurrentFileFind();
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
    cancelReloadActiveFile,
    newFileDialogOpen,
    newFolderDialogOpen,
    integrationsOpen,
    settingsOpen,
    goToLineDialogOpen,
    modalUiOpen,
    nativePickerAvailable,
    commandPaletteVisible,
    openRenameDialog,
    openNewFolderDialog,
    openNewFileDialog,
    openFileFromDialog,
    openWorkspace,
    openCommandPalette,
    openCurrentFileFind,
    openGoToLineDialog,
    openQuickOpen,
    openWorkspaceSearch,
    openFiles,
    pendingAppClose,
    pendingCloseAll,
    pendingClosePath,
    pendingDeletePath,
    pendingReloadPath,
    quickOpenVisible,
    renameDialogOpen,
    requestCloseActiveFile,
    requestCloseAllFiles,
    requestReloadActiveFile,
    saveActive,
    saveAll,
    toggleSidebar,
  ]);

  const SidebarIcon = sidebarCollapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <main
      className={appShellClass(sidebarCollapsed)}
      data-ide-theme={prefersDark ? "dark" : "light"}
    >
      <aside className="sidebar" aria-hidden={sidebarCollapsed}>
        <div className="sidebar__header">
          <div className="sidebar__title">
            <div className="eyebrow">Workspace</div>
            <strong>
              {workspaceTitle ||
                (workspaceLoadFailed ? "Workspace unavailable" : "Loading")}
            </strong>
          </div>
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
            onClick={() => setActiveSidebarSearch("filter")}
          >
            <ListFilter size={16} />
          </button>
          <button
            className={[
              "icon-button",
              contentSearchExpanded ? "icon-button--active" : "",
            ].join(" ")}
            title="Search contents"
            aria-label="Search contents"
            onClick={() => setActiveSidebarSearch("content")}
          >
            <Search size={16} />
          </button>
        </div>

        {filterExpanded ? (
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

        {contentSearchExpanded ? (
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

        {contentQuery.trim().length >= 2 ? (
          <div className="search-results" aria-label="Content search results">
            <div className="search-results__header">
              <span>{searching ? "Searching" : "Results"}</span>
              <span>{searchResults.length}</span>
            </div>
            {searchResults.map((result) => (
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
            ))}
            {!searching && searchResults.length === 0 ? (
              <div className="search-results__empty">No matches</div>
            ) : null}
          </div>
        ) : null}

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
              />
            ))
          )}
        </nav>

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
                  ].join(" ")}
                  key={file.path}
                  onClick={() => setActivePath(file.path)}
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
                  <FileCog size={15} />
                  <span>{file.path}</span>
                  {file.dirty ? <Circle className="dirty-dot" size={8} /> : null}
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
              <label className="topbar-find">
                <Search size={14} />
                <input
                  ref={currentFindInputRef}
                  value={currentFileQuery}
                  onBlur={() => {
                    if (!currentFileQuery.trim()) {
                      setCurrentFindOpen(false);
                    }
                  }}
                  onChange={(event) => setCurrentFileQuery(event.target.value)}
                  onKeyDown={handleCurrentFindKeyDown}
                  placeholder="Find in file"
                />
                <span>
                  {activeFile && currentFileQuery.trim() ? currentFindResults.length : ""}
                </span>
              </label>
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
          {activeFile && currentFileQuery.trim() ? (
            <div className="current-find-results" aria-label="Current file search results">
              <div className="current-find-results__header">
                <span>Find in {activeFile.path}</span>
                <span>{currentFindResults.length}</span>
              </div>
              {currentFindResults.slice(0, currentFileResultPreviewLimit).map((result, index) => (
                <button
                  className={[
                    "current-find-result",
                    index === currentFindIndex ? "current-find-result--active" : "",
                  ].join(" ")}
                  key={`${result.lineNumber}:${result.matchStart}:${result.matchEnd}`}
                  onClick={() => revealCurrentFileMatch(result, index)}
                >
                  <span className="current-find-result__path">
                    line {result.lineNumber}
                  </span>
                  <span className="current-find-result__line">{result.lineText}</span>
                </button>
              ))}
              {currentFindResults.length === 0 ? (
                <div className="current-find-results__empty">No matches</div>
              ) : null}
            </div>
          ) : null}
          {activeFile ? (
            <Suspense fallback={<div className="empty-state editor-loading-state">Loading editor</div>}>
              <EditorPane
                contents={activeFile.contents}
                editorCommand={editorCommand}
                path={activeFile.path}
                prefersDark={prefersDark}
                revealLine={
                  revealTarget?.path === activeFile.path ? revealTarget.lineNumber : undefined
                }
                focusOnReveal={
                  revealTarget?.path === activeFile.path
                    ? !revealTarget.preserveFocus
                    : undefined
                }
                onChange={updateContents}
                onCursor={setCursor}
                onError={setError}
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
          <span>{status}</span>
          <span>{activePath ?? workspaceRoot}</span>
          <span>{cursorPosition}</span>
        </footer>
      </section>

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
                <div className="endpoint" title={httpEndpoint ?? "Endpoint unavailable"}>
                  {httpEndpoint ?? "Not available"}
                </div>
              </section>

              <section className="integration-section" aria-label="Claude bridge">
                <div className="eyebrow">Claude Bridge</div>
                <div className="endpoint" title={claudeBridge?.lockFile ?? "Bridge unavailable"}>
                  {claudeBridge?.endpoint ?? "Not available"}
                </div>
              </section>

              <section className="integration-section" aria-label="Codex MCP">
                <div className="eyebrow">Codex MCP</div>
                {codexMcp ? (
                  <>
                    <div className="integration-row">
                      <div className="endpoint" title="Use this endpoint with the bearer token from the native app session">
                        {codexMcp.endpoint}
                      </div>
                      <button
                        className="tiny-icon-button"
                        title="Copy Codex MCP endpoint"
                        onClick={() => copyText("Codex MCP endpoint", codexMcp.endpoint)}
                      >
                        <Copy size={13} />
                      </button>
                    </div>
                    <div className="integration-row">
                      <div className="endpoint" title={codexMcp.bearerToken}>
                        token: {codexMcp.bearerToken}
                      </div>
                      <button
                        className="tiny-icon-button"
                        title="Copy Codex MCP token"
                        onClick={() => copyText("Codex MCP token", codexMcp.bearerToken)}
                      >
                        <Copy size={13} />
                      </button>
                    </div>
                    <div className="snippet-row">
                      <pre>{codexMcpConfig}</pre>
                      <button
                        className="tiny-icon-button"
                        title="Copy Codex MCP config"
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
                    </section>
                  ) : null}

                  {settingsCategory === "indexing" ? (
                    <section
                      className="settings-section"
                      aria-label="Workspace indexing"
                      role="tabpanel"
                      id="settings-panel-indexing"
                      aria-labelledby="settings-tab-indexing"
                    >
                      <div className="settings-section__title">Workspace Indexing</div>
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

                  {settingsCategory === "interface" ? (
                    <section
                      className="settings-section"
                      aria-label="Interface limits"
                      role="tabpanel"
                      id="settings-panel-interface"
                      aria-labelledby="settings-tab-interface"
                    >
                      <div className="settings-section__title">Interface Limits</div>
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
              <div className="eyebrow">Unsaved changes</div>
              <h2 id="reload-file-title">Reload file from disk?</h2>
              <p>
                {pendingReloadFile.path} has edits that will be discarded and replaced
                with the current disk contents.
              </p>
            </div>
            <div className="confirm-dialog__actions">
              <button
                className="command-button command-button--quiet"
                onClick={cancelReloadActiveFile}
              >
                Cancel
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
              <h2 id="app-close-title">Close IDE?</h2>
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

      {error ? <div className="toast">{error}</div> : null}
    </main>
  );
}

function TreeItem({
  expandedFolders,
  forceExpanded,
  node,
  selectedPath,
  onOpen,
  onSelect,
  onToggleFolder,
}: {
  expandedFolders: Set<string>;
  forceExpanded: boolean;
  node: TreeNode;
  selectedPath?: string;
  onOpen: (entry: FileEntry, pinned?: boolean) => void;
  onSelect: (path: string) => void;
  onToggleFolder: (path: string) => void;
}) {
  const expanded = forceExpanded || expandedFolders.has(node.path);
  const Icon = iconForFile(node.name, node.isDir);
  const isActive = selectedPath === node.path;
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
      <button
        className={`tree-row ${isActive ? "tree-row--active" : ""}`}
        role="treeitem"
        aria-expanded={node.isDir ? expanded : undefined}
        aria-level={node.depth + 1}
        aria-selected={isActive}
        style={{ paddingLeft: 8 + node.depth * 14 }}
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
        <Icon size={15} />
        <span>{node.name}</span>
      </button>
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

function isGlobalIdeShortcut(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  if (event.key === "F2") return true;
  if (event.ctrlKey && event.key === "Tab") return true;
  if (event.ctrlKey && !event.metaKey && key === "g") return true;
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (!event.shiftKey && /^[1-9]$/.test(event.key)) return true;
  return ["s", "r", "w", "b", "n", "o", "p", "f"].includes(key);
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
