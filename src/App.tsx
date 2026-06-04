import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Circle,
  Copy,
  FilePlus,
  FileCog,
  FolderOpen,
  FolderPlus,
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
  getLspServers,
  getWorkspaceRoot,
  listFiles,
  pickWorkspaceFolder,
  readFile,
  renameFile,
  searchFiles,
  updateAgentContext,
  writeFile,
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

const skipOpenPattern = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|dll|exe|dylib)$/i;

export default function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceLoadFailed, setWorkspaceLoadFailed] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [revealTarget, setRevealTarget] = useState<RevealTarget>();
  const [openFiles, setOpenFiles] = useState<EditorTab[]>([]);
  const [filter, setFilter] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [currentFileQuery, setCurrentFileQuery] = useState("");
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
  const currentFindInputRef = useRef<HTMLInputElement | null>(null);

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
  const suggestedNewFilePath = useMemo(
    () => suggestNewFilePath(selectedPath, files),
    [files, selectedPath],
  );
  const suggestedNewFolderPath = useMemo(
    () => suggestNewFolderPath(selectedPath, files),
    [files, selectedPath],
  );

  const refreshFiles = useCallback(async () => {
    setWorkspaceLoading(true);
    try {
      const [root, entries] = await Promise.all([getWorkspaceRoot(), listFiles()]);
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
    refreshFiles().catch((reason) => {
      setError(String(reason));
      setStatus("Workspace load failed");
    });
  }, [refreshFiles]);

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

      setOpenFiles([]);
      setActivePath(undefined);
      setSelectedPath(undefined);
      setRevealTarget(undefined);
      setSelection(undefined);
      setDiagnosticsByPath({});
      setFilter("");
      setContentQuery("");
      setCurrentFileQuery("");
      setSearchResults([]);
      await refreshFiles();
      setStatus(`Opened ${lastSegment(selected) || selected}`);
    } catch (reason) {
      setError(String(reason));
      setStatus("Open folder failed");
    }
  }, [openFiles, refreshFiles]);

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
      if (!hasDirtyFiles) return;
      event.preventDefault();
      setPendingAppClose(true);
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
  }, [dirtyFiles.length]);

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
        currentFindInputRef.current?.focus();
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
    closeQuickOpen,
    closeNewFileDialog,
    closeNewFolderDialog,
    closeRenameDialog,
    activateAdjacentTab,
    cancelDeleteSelectedFile,
    cancelReloadActiveFile,
    newFileDialogOpen,
    newFolderDialogOpen,
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

        <label className="search-box">
          <Search size={15} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter files"
          />
        </label>

        <label className="search-box">
          <Search size={15} />
          <input
            value={contentQuery}
            onChange={(event) => setContentQuery(event.target.value)}
            placeholder="Search contents"
          />
        </label>

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
                node={node}
                selectedPath={selectedPath}
                onOpen={openPath}
                onSelect={setSelectedPath}
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

        <div className="lsp-panel">
          {httpEndpoint ? (
            <>
              <div className="eyebrow">Browser Endpoint</div>
              <div className="endpoint" title={httpEndpoint}>{httpEndpoint}</div>
            </>
          ) : null}
          {claudeBridge ? (
            <>
              <div className="eyebrow">Claude Bridge</div>
              <div className="endpoint" title={claudeBridge.lockFile}>
                {claudeBridge.endpoint}
              </div>
            </>
          ) : null}
          {codexMcp ? (
            <>
              <div className="eyebrow">Codex MCP</div>
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
          ) : null}
          <div className="eyebrow">Language Servers</div>
          {lspServers.map((server) => (
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
          ))}
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
            <label className="topbar-find">
              <Search size={14} />
              <input
                ref={currentFindInputRef}
                value={currentFileQuery}
                onChange={(event) => setCurrentFileQuery(event.target.value)}
                placeholder="Find in file"
                disabled={!activeFile}
              />
              <span>{activeFile && currentFileQuery.trim() ? currentFindResults.length : ""}</span>
            </label>
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
            <Suspense fallback={<div className="empty-state">Loading editor</div>}>
              <EditorPane
                contents={activeFile.contents}
                path={activeFile.path}
                revealLine={
                  revealTarget?.path === activeFile.path ? revealTarget.lineNumber : undefined
                }
                onChange={updateContents}
                onError={setError}
                onSelection={setSelection}
              />
            </Suspense>
          ) : (
            <div className="empty-state">
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
  node,
  selectedPath,
  onOpen,
  onSelect,
}: {
  node: TreeNode;
  selectedPath?: string;
  onOpen: (entry: FileEntry, pinned?: boolean) => void;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(node.depth < 1);
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
            setExpanded((value) => !value);
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
              node={child}
              selectedPath={selectedPath}
              onOpen={onOpen}
              onSelect={onSelect}
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
