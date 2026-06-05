import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronRight,
  Circle,
  Copy,
  FilePlus,
  FileCog,
  FolderOpen,
  FolderPlus,
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
  diagnosticSeverityLabel,
  sortDiagnostics,
} from "./diagnostics";
import { currentFileMatches } from "./currentFileSearch";
import { iconForFile } from "./fileTypes";
import { codexMcpConfigSnippet } from "./integrations";
import { appShellClass, sidebarToggleTitle } from "./layout";
import {
  clampQuickOpenSelection,
  moveQuickOpenSelection,
  quickOpenMatches,
} from "./quickOpen";
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
  listFiles,
  pickWorkspaceFolder,
  readFile,
  recordRecentFile,
  renameFile,
  searchFiles,
  setWorkspaceRootPath,
  updateAgentContext,
  updateUiState,
  writeFile,
  type PersistedUiSnapshot,
  type WorkspaceUiState,
} from "./tauri";
import {
  setLspDiagnosticsHandler,
  setLspErrorHandler,
  setLspRootUri,
  setLspStatusHandler,
} from "./lsp";
import {
  addPreviewTab,
  adjacentTabPath,
  dirtyTabSummary,
  nextActivePathAfterClose,
  pinTab,
  tabCloseRequiresConfirmation,
  updateTabContents,
  type EditorTab,
} from "./tabs";

const EditorPane = lazy(() => import("./EditorPane"));

interface TreeNode extends FileEntry {
  children: TreeNode[];
}

interface RevealTarget {
  path: string;
  lineNumber: number;
}

type SidebarSearchMode = "filter" | "content";

const skipOpenPattern = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|dll|exe|dylib)$/i;

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

export default function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceLoadFailed, setWorkspaceLoadFailed] = useState(false);
  const [initialFile, setInitialFile] = useState<string>();
  const [files, setFiles] = useState<FileEntry[]>([]);
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
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState("");
  const [quickOpenIndex, setQuickOpenIndex] = useState(0);
  const [newFileDialogOpen, setNewFileDialogOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [newFolderPath, setNewFolderPath] = useState("");
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameFromPath, setRenameFromPath] = useState("");
  const [renameToPath, setRenameToPath] = useState("");
  const [pendingDeletePath, setPendingDeletePath] = useState<string>();
  const [pendingReloadPath, setPendingReloadPath] = useState<string>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pendingClosePath, setPendingClosePath] = useState<string>();
  const [pendingAppClose, setPendingAppClose] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [showDotfiles, setShowDotfiles] = useState(false);
  const [showGeneratedInternal, setShowGeneratedInternal] = useState(false);
  const [uiStateLoaded, setUiStateLoaded] = useState(false);
  const [workspaceUiRestored, setWorkspaceUiRestored] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("Ready");
  const [selection, setSelection] = useState<EditorSelection>();
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
  const persistedWorkspaceRef = useRef<WorkspaceUiState>({
    expandedFolders: [],
    openFiles: [],
  });
  const persistedFilesRestoredRef = useRef(false);
  const uiPersistTimerRef = useRef<number | undefined>(undefined);

  const activeFile = openFiles.find((file) => file.path === activePath);
  const pendingCloseFile = openFiles.find((file) => file.path === pendingClosePath);
  const pendingDeleteFile = files.find((file) => file.path === pendingDeletePath);
  const pendingDeleteOpenFile = openFiles.find((file) => file.path === pendingDeletePath);
  const pendingReloadFile = openFiles.find((file) => file.path === pendingReloadPath);
  const dirtyFiles = openFiles.filter((file) => file.dirty);
  const selectedEntry = selectedPath
    ? files.find((file) => file.path === selectedPath)
    : undefined;
  const activeSelection = selection?.filePath === activePath ? selection : undefined;
  const cursorPosition = activeSelection
    ? `${activeSelection.startLine}:${activeSelection.startColumn}`
    : revealTarget && revealTarget.path === activePath
      ? `${revealTarget.lineNumber}:1`
      : "";
  const tree = useMemo(() => buildTree(files), [files]);
  const filteredTree = useMemo(
    () => filterTree(tree, filter.trim().toLowerCase()),
    [filter, tree],
  );
  const quickOpenResults = useMemo(
    () => quickOpenMatches(files, quickOpenQuery, 12),
    [files, quickOpenQuery],
  );
  const currentFindResults = useMemo(
    () =>
      activeFile
        ? currentFileMatches(activeFile.path, activeFile.contents, currentFileQuery)
        : [],
    [activeFile, currentFileQuery],
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

  const applyPersistedUiSnapshot = useCallback((snapshot: PersistedUiSnapshot) => {
    persistedWorkspaceRef.current = snapshot.workspace;
    persistedFilesRestoredRef.current = false;
    setWorkspaceUiRestored(false);
    setShowDotfiles(snapshot.view.showDotfiles);
    setShowGeneratedInternal(snapshot.view.showGeneratedInternal);
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

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const refreshFiles = useCallback(async () => {
    setWorkspaceLoading(true);
    try {
      const [root, entries] = await Promise.all([
        getWorkspaceRoot(),
        listFiles(showDotfiles, showGeneratedInternal),
      ]);
      setWorkspaceRoot(root);
      setLspRootUri(pathToFileUri(root));
      setFiles(entries);
      setWorkspaceLoadFailed(false);
      try {
        setLspServers(await getLspServers());
        setHttpEndpoint(await getHttpEndpoint());
        setCodexMcp(await getCodexMcpStatus());
        setClaudeBridge(await getClaudeBridgeStatus());
      } catch (reason) {
        setError(`Unable to load local integration status: ${String(reason)}`);
      }
      return entries;
    } catch (reason) {
      setWorkspaceLoadFailed(true);
      throw reason;
    } finally {
      setWorkspaceLoading(false);
    }
  }, [showDotfiles, showGeneratedInternal]);

  useEffect(() => {
    getInitialFile()
      .then(setInitialFile)
      .catch((reason) => {
        setError(`Unable to read launch file: ${String(reason)}`);
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
    if (!uiStateLoaded) return;
    refreshFiles().catch((reason) => {
      setError(String(reason));
      setStatus("Workspace load failed");
    });
  }, [refreshFiles, uiStateLoaded]);

  useEffect(() => {
    const query = contentQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      searchFiles(query)
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
  }, [contentQuery]);

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
    async (entry: FileEntry, pinned = false, lineNumber?: number) => {
      setSelectedPath(entry.path);
      if (lineNumber) {
        setRevealTarget({ path: entry.path, lineNumber });
      } else {
        setRevealTarget(undefined);
      }

      if (entry.isDir || skipOpenPattern.test(entry.name)) return;

      setError(undefined);
      setStatus(`Opening ${entry.path}`);

      const existing = openFiles.find((file) => file.path === entry.path);
      if (existing) {
        if (pinned && !existing.pinned) {
          setOpenFiles((current) => pinTab(current, entry.path));
        }
        setActivePath(existing.path);
        recordRecentFile(existing.path).catch((reason) => {
          setError(`Unable to update recent files: ${String(reason)}`);
        });
        setStatus("Ready");
        return;
      }

      try {
        const contents = await readFile(entry.path);
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
        recordRecentFile(entry.path).catch((reason) => {
          setError(`Unable to update recent files: ${String(reason)}`);
        });
        setStatus("Ready");
      } catch (reason) {
        setError(String(reason));
        setStatus("Open failed");
      }
    },
    [openFiles],
  );

  const openPathByName = useCallback(
    async (path: string, pinned = false, lineNumber?: number) => {
      const entry = files.find((candidate) => candidate.path === path);
      if (!entry) {
        setError(`File is not in the current workspace: ${path}`);
        return;
      }
      await openPath(entry, pinned, lineNumber);
    },
    [files, openPath],
  );

  useEffect(() => {
    if (initialFileOpenedRef.current || !initialFile || workspaceLoading) return;
    const entry =
      files.find((candidate) => candidate.path === initialFile) ??
      fileEntryForDirectOpen(initialFile);
    initialFileOpenedRef.current = true;
    openPath(entry, true);
  }, [files, initialFile, openPath, workspaceLoading]);

  useEffect(() => {
    if (
      !uiStateLoaded ||
      workspaceLoading ||
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
      return entry && !entry.isDir && !skipOpenPattern.test(entry.name);
    });

    if (restorePaths.length === 0) {
      setWorkspaceUiRestored(true);
      return;
    }

    let disposed = false;
    Promise.all(
      restorePaths.map(async (path) => {
        const entry = entriesByPath.get(path)!;
        return {
          path,
          contents: await readFile(path),
          dirty: false,
          modifiedMs: entry.modifiedMs,
          pinned: true,
        };
      }),
    )
      .then((restoredTabs) => {
        if (disposed) return;
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
    uiStateLoaded,
    workspaceLoadFailed,
    workspaceLoading,
  ]);

  useEffect(() => {
    if (!uiStateLoaded || !workspaceUiRestored) return;

    window.clearTimeout(uiPersistTimerRef.current);
    uiPersistTimerRef.current = window.setTimeout(() => {
      updateUiState(
        {
          showDotfiles,
          showGeneratedInternal,
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
    uiStateLoaded,
    workspaceUiRestored,
  ]);

  const closeQuickOpen = useCallback(() => {
    setQuickOpenVisible(false);
    setQuickOpenQuery("");
    setQuickOpenIndex(0);
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
    if (!selectedEntry || selectedEntry.isDir) {
      setError("Select a file to rename.");
      setStatus("Rename file failed");
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
    if (!selectedEntry || selectedEntry.isDir) {
      setError("Select a file to delete.");
      setStatus("Delete file failed");
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

  const revealCurrentFileMatch = useCallback((match: SearchMatch) => {
    setRevealTarget({ path: match.path, lineNumber: match.lineNumber });
    setStatus(`Found ${match.path}:${match.lineNumber}`);
  }, []);

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
    await saveFile(activeFile);
  }, [activeFile, saveFile]);

  const saveAll = useCallback(async () => {
    if (dirtyFiles.length === 0) {
      setStatus("No unsaved files");
      return true;
    }

    for (const file of dirtyFiles) {
      const saved = await saveFile(file);
      if (!saved) return false;
    }
    setStatus(`Saved ${dirtyTabSummary(dirtyFiles)}`);
    return true;
  }, [dirtyFiles, saveFile]);

  const reloadFileFromDisk = useCallback(async (path: string) => {
    setError(undefined);
    setStatus(`Reloading ${path}`);
    try {
      const contents = await readFile(path);
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
    if (!activeFile) return;
    if (activeFile.dirty) {
      setPendingReloadPath(activeFile.path);
      return;
    }

    reloadFileFromDisk(activeFile.path);
  }, [activeFile, reloadFileFromDisk]);

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
        clearWorkspaceUi();
        applyPersistedUiSnapshot(await getUiState());
        await refreshFiles();
        setStatus(`Opened ${lastSegment(selected) || selected}`);
      } catch (reason) {
        setError(String(reason));
        setStatus("Open folder failed");
      }
    },
    [applyPersistedUiSnapshot, clearWorkspaceUi, openFiles, refreshFiles],
  );

  const openFileFromWorkspace = useCallback(
    async (workspaceRootPath: string, path: string) => {
      if (workspaceRootPath !== workspaceRoot && openFiles.some((file) => file.dirty)) {
        setError("Save or close modified files before switching workspace.");
        return;
      }

      setError(undefined);
      setStatus(`Opening ${path}`);
      try {
        let entries = files;
        if (workspaceRootPath !== workspaceRoot) {
          await setWorkspaceRootPath(workspaceRootPath);
          clearWorkspaceUi();
          const snapshot = await getUiState();
          if (!snapshot.workspace.openFiles.includes(path)) {
            snapshot.workspace.openFiles = [...snapshot.workspace.openFiles, path];
          }
          snapshot.workspace.activeFile = path;
          snapshot.workspace.selectedPath = path;
          applyPersistedUiSnapshot(snapshot);
          entries = await refreshFiles();
        }

        const entry =
          entries.find((candidate) => candidate.path === path) ??
          fileEntryForDirectOpen(path);
        if (!entry || entry.isDir) {
          throw new Error(`Recent file is not in the current workspace: ${path}`);
        }

        await openPath(entry, true);
      } catch (reason) {
        setError(String(reason));
        setStatus("Open recent file failed");
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

  useEffect(() => {
    if (!isNativeTauri()) return;

    let disposed = false;
    let unlistenCallbacks: Array<() => void> = [];
    Promise.all([
      listen<{ path: string }>("menu://open-workspace", (event) => {
        void openWorkspacePath(event.payload.path);
      }),
      listen<{ workspaceRoot: string; path: string }>("menu://open-file", (event) => {
        void openFileFromWorkspace(event.payload.workspaceRoot, event.payload.path);
      }),
      listen<string>("app://error", (event) => {
        setError(event.payload);
      }),
      listen("menu://show-integrations", () => {
        setIntegrationsOpen(true);
      }),
      listen("menu://toggle-dotfiles", () => {
        setShowDotfiles((current) => {
          const next = !current;
          setStatus(next ? "Showing dotfiles" : "Hiding dotfiles");
          return next;
        });
      }),
      listen("menu://toggle-generated-internal", () => {
        setShowGeneratedInternal((current) => {
          const next = !current;
          setStatus(
            next
              ? "Showing generated/internal folders"
              : "Hiding generated/internal folders",
          );
          return next;
        });
      }),
    ])
      .then((callbacks) => {
        if (disposed) {
          callbacks.forEach((unlisten) => unlisten());
          return;
        }
        unlistenCallbacks = callbacks;
      })
      .catch((reason) => {
        if (!disposed) {
          setError(`Unable to register native app menu handlers: ${String(reason)}`);
        }
      });

    return () => {
      disposed = true;
      unlistenCallbacks.forEach((unlisten) => unlisten());
    };
  }, [openFileFromWorkspace, openWorkspacePath]);

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

  const renameSelectedFile = useCallback(async () => {
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
          file.path === fromPath ? { ...file, path: toPath, modifiedMs } : file,
        ),
      );
      setActivePath((current) => (current === fromPath ? toPath : current));
      setSelectedPath(toPath);
      setRevealTarget((current) =>
        current?.path === fromPath ? { ...current, path: toPath } : current,
      );
      setSelection((current) =>
        current?.filePath === fromPath ? { ...current, filePath: toPath } : current,
      );
      setDiagnosticsByPath((current) => {
        if (!current[fromPath]) return current;
        const { [fromPath]: renamedDiagnostics, ...rest } = current;
        return {
          ...rest,
          [toPath]: renamedDiagnostics.map((diagnostic) => ({
            ...diagnostic,
            filePath: toPath,
          })),
        };
      });
      closeRenameDialog();
      setStatus(`Renamed ${fromPath} to ${toPath}`);
    } catch (reason) {
      setError(String(reason));
      setStatus("Rename file failed");
    }
  }, [closeRenameDialog, refreshFiles, renameFromPath, renameToPath]);

  const deleteSelectedFile = useCallback(async () => {
    if (!pendingDeletePath) return;

    setError(undefined);
    setStatus(`Deleting ${pendingDeletePath}`);
    try {
      await deleteFile(pendingDeletePath);
      closeFile(pendingDeletePath);
      setSelectedPath(undefined);
      setRevealTarget((current) =>
        current?.path === pendingDeletePath ? undefined : current,
      );
      setSelection((current) =>
        current?.filePath === pendingDeletePath ? undefined : current,
      );
      setDiagnosticsByPath((current) => {
        if (!current[pendingDeletePath]) return current;
        const { [pendingDeletePath]: _removed, ...rest } = current;
        return rest;
      });
      setPendingDeletePath(undefined);
      await refreshFiles();
      setStatus(`Deleted ${pendingDeletePath}`);
    } catch (reason) {
      setError(String(reason));
      setStatus("Delete file failed");
    }
  }, [closeFile, pendingDeletePath, refreshFiles]);

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
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        saveAll();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveActive();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
        event.preventDefault();
        requestCloseActiveFile();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        openNewFileDialog();
      } else if (event.key === "F2") {
        event.preventDefault();
        openRenameDialog();
      } else if (event.ctrlKey && event.shiftKey && event.key === "Tab") {
        event.preventDefault();
        activateAdjacentTab(-1);
      } else if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        activateAdjacentTab(1);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setQuickOpenVisible(true);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (activeFile) {
          setCurrentFindOpen(true);
        }
      } else if (event.key === "Escape" && newFileDialogOpen) {
        event.preventDefault();
        closeNewFileDialog();
      } else if (event.key === "Escape" && newFolderDialogOpen) {
        event.preventDefault();
        closeNewFolderDialog();
      } else if (event.key === "Escape" && renameDialogOpen) {
        event.preventDefault();
        closeRenameDialog();
      } else if (event.key === "Escape" && pendingDeletePath) {
        event.preventDefault();
        cancelDeleteSelectedFile();
      } else if (event.key === "Escape" && pendingReloadPath) {
        event.preventDefault();
        cancelReloadActiveFile();
      } else if (event.key === "Escape" && pendingAppClose) {
        event.preventDefault();
        setPendingAppClose(false);
      } else if (event.key === "Escape" && integrationsOpen) {
        event.preventDefault();
        setIntegrationsOpen(false);
      } else if (event.key === "Escape" && pendingClosePath) {
        event.preventDefault();
        setPendingClosePath(undefined);
      } else if (event.key === "Escape" && quickOpenVisible) {
        event.preventDefault();
        closeQuickOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeFile,
    closeQuickOpen,
    closeNewFileDialog,
    closeNewFolderDialog,
    closeRenameDialog,
    activateAdjacentTab,
    cancelDeleteSelectedFile,
    cancelReloadActiveFile,
    newFileDialogOpen,
    newFolderDialogOpen,
    integrationsOpen,
    openRenameDialog,
    openNewFolderDialog,
    openNewFileDialog,
    pendingAppClose,
    pendingClosePath,
    pendingDeletePath,
    pendingReloadPath,
    quickOpenVisible,
    renameDialogOpen,
    requestCloseActiveFile,
    requestReloadActiveFile,
    saveActive,
    saveAll,
    toggleSidebar,
  ]);

  const SidebarIcon = sidebarCollapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <main className={appShellClass(sidebarCollapsed)}>
      <aside className="sidebar" aria-hidden={sidebarCollapsed}>
        <div className="sidebar__header">
          <div>
            <div className="eyebrow">Workspace</div>
            <strong>
              {lastSegment(workspaceRoot) ||
                (workspaceLoadFailed ? "Workspace unavailable" : "Loading")}
            </strong>
          </div>
          <div className="sidebar__actions">
            <button className="icon-button" title="Open folder" onClick={openWorkspace}>
              <FolderOpen size={17} />
            </button>
            <button className="icon-button" title="New file" onClick={openNewFileDialog}>
              <FilePlus size={17} />
            </button>
            <button className="icon-button" title="New folder" onClick={openNewFolderDialog}>
              <FolderPlus size={17} />
            </button>
            <button className="icon-button" title="Rename file" onClick={openRenameDialog}>
              <Pencil size={16} />
            </button>
            <button className="icon-button" title="Delete file" onClick={requestDeleteSelectedFile}>
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

        <nav className="file-tree" aria-label="Workspace files">
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
                    {diagnostic.filePath}:{diagnostic.startLine}
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
            <button className="icon-button" title="Save" onClick={saveActive}>
              <Save size={17} />
            </button>
            <button className="icon-button" title="Save all" onClick={saveAll}>
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

        <div className="editor-region">
          {activeFile && currentFileQuery.trim() ? (
            <div className="current-find-results" aria-label="Current file search results">
              <div className="current-find-results__header">
                <span>Find in {activeFile.path}</span>
                <span>{currentFindResults.length}</span>
              </div>
              {currentFindResults.slice(0, 12).map((result) => (
                <button
                  className="current-find-result"
                  key={`${result.lineNumber}:${result.matchStart}:${result.matchEnd}`}
                  onClick={() => revealCurrentFileMatch(result)}
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
                path={activeFile.path}
                revealLine={
                  revealTarget?.path === activeFile.path ? revealTarget.lineNumber : undefined
                }
                onChange={updateContents}
                onError={setError}
                onNotice={setStatus}
                onSelection={setSelection}
              />
            </Suspense>
          ) : (
            <div className="empty-state editor-empty-state">
              <FileCog size={30} />
              <strong>No file selected</strong>
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
                <div className="quick-open__empty">No matching files</div>
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
              renameSelectedFile();
            }}
          >
            <div>
              <div className="eyebrow">Workspace</div>
              <h2 id="rename-file-title">Rename file</h2>
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
              <h2 id="delete-file-title">Delete file?</h2>
              <p>
                {pendingDeleteFile.path} will be permanently removed from the workspace.
                {pendingDeleteOpenFile?.dirty
                  ? " This file also has unsaved editor changes."
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
                onClick={deleteSelectedFile}
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

  return (
    <div>
      <button
        className={`tree-row ${isActive ? "tree-row--active" : ""}`}
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

function pathToFileUri(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${normalized.split("/").map(encodeURIComponent).join("/")}`;
}
