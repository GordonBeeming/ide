import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Circle,
  Copy,
  FileCog,
  FolderPlus,
  PanelLeftClose,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { iconForFile } from "./fileTypes";
import { codexMcpConfigSnippet } from "./integrations";
import { quickOpenMatches } from "./quickOpen";
import { destroyNativeWindow, onNativeWindowCloseRequested } from "./appWindow";
import {
  AgentContext,
  ClaudeBridgeStatus,
  CodexMcpStatus,
  EditorSelection,
  FileEntry,
  LspServerStatus,
  SearchMatch,
  getClaudeBridgeStatus,
  getCodexMcpStatus,
  getHttpEndpoint,
  getLspServers,
  getWorkspaceRoot,
  listFiles,
  pickWorkspaceFolder,
  readFile,
  searchFiles,
  updateAgentContext,
  writeFile,
} from "./tauri";
import { setLspErrorHandler, setLspRootUri } from "./lsp";
import {
  addPreviewTab,
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
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [revealTarget, setRevealTarget] = useState<RevealTarget>();
  const [openFiles, setOpenFiles] = useState<EditorTab[]>([]);
  const [filter, setFilter] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState("");
  const [pendingClosePath, setPendingClosePath] = useState<string>();
  const [pendingAppClose, setPendingAppClose] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("Ready");
  const [selection, setSelection] = useState<EditorSelection>();
  const [lspServers, setLspServers] = useState<LspServerStatus[]>([]);
  const [httpEndpoint, setHttpEndpoint] = useState<string>();
  const [codexMcp, setCodexMcp] = useState<CodexMcpStatus>();
  const [claudeBridge, setClaudeBridge] = useState<ClaudeBridgeStatus>();

  const activeFile = openFiles.find((file) => file.path === activePath);
  const pendingCloseFile = openFiles.find((file) => file.path === pendingClosePath);
  const dirtyFiles = openFiles.filter((file) => file.dirty);
  const cursorPosition = selection
    ? `${selection.startLine}:${selection.startColumn}`
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
  const codexMcpConfig = useMemo(
    () => (codexMcp ? codexMcpConfigSnippet(codexMcp) : ""),
    [codexMcp],
  );

  const refreshFiles = useCallback(async () => {
    const [root, entries] = await Promise.all([getWorkspaceRoot(), listFiles()]);
    setWorkspaceRoot(root);
    setLspRootUri(pathToFileUri(root));
    setFiles(entries);
    try {
      setLspServers(await getLspServers());
      setHttpEndpoint(await getHttpEndpoint());
      setCodexMcp(await getCodexMcpStatus());
      setClaudeBridge(await getClaudeBridgeStatus());
    } catch (reason) {
      setError(`Unable to load local integration status: ${String(reason)}`);
    }
  }, []);

  useEffect(() => {
    refreshFiles().catch((reason) => setError(String(reason)));
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
  }, []);

  useEffect(() => {
    const context: AgentContext = {
      activeFile: activePath,
      openFiles: openFiles.map((file) => file.path),
      selection,
    };
    updateAgentContext(context).catch((reason) => {
      setError(`Unable to update agent editor context: ${String(reason)}`);
    });
  }, [activePath, openFiles, selection]);

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
  }, []);

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

  const saveFile = useCallback(async (fileToSave: EditorTab) => {
    setError(undefined);
    setStatus(`Saving ${fileToSave.path}`);
    try {
      await writeFile(fileToSave.path, fileToSave.contents);
      setOpenFiles((current) =>
        current.map((file) =>
          file.path === fileToSave.path ? { ...file, dirty: false } : file,
        ),
      );
      await refreshFiles();
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
    for (const file of dirtyFiles) {
      const saved = await saveFile(file);
      if (!saved) return;
    }
    await closeApplication();
  }, [closeApplication, dirtyFiles, saveFile]);

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
      setFilter("");
      setContentQuery("");
      setSearchResults([]);
      await refreshFiles();
      setStatus(`Opened ${lastSegment(selected) || selected}`);
    } catch (reason) {
      setError(String(reason));
      setStatus("Open folder failed");
    }
  }, [openFiles, refreshFiles]);

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveActive();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setQuickOpenVisible(true);
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
  }, [closeQuickOpen, pendingAppClose, pendingClosePath, quickOpenVisible, saveActive]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__header">
          <div>
            <div className="eyebrow">Workspace</div>
            <strong>{lastSegment(workspaceRoot) || "Loading"}</strong>
          </div>
          <div className="sidebar__actions">
            <button className="icon-button" title="Open folder" onClick={openWorkspace}>
              <FolderPlus size={17} />
            </button>
            <button className="icon-button" title="Refresh files" onClick={refreshFiles}>
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
          {filteredTree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              selectedPath={selectedPath}
              onOpen={openPath}
              onSelect={setSelectedPath}
            />
          ))}
        </nav>

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
            <button className="icon-button" title="Save" onClick={saveActive}>
              <Save size={17} />
            </button>
            <button className="icon-button" title="Collapse sidebar">
              <PanelLeftClose size={17} />
            </button>
          </div>
        </header>

        <div className="editor-region">
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
                onChange={(event) => setQuickOpenQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && quickOpenResults[0]) {
                    event.preventDefault();
                    openQuickPath(quickOpenResults[0].path, false);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    closeQuickOpen();
                  }
                }}
                placeholder="Open file"
              />
            </label>
            <div className="quick-open__results">
              {quickOpenResults.map((file) => {
                const Icon = iconForFile(file.name, false);
                return (
                  <button
                    className="quick-open__result"
                    key={file.path}
                    onClick={() => openQuickPath(file.path, false)}
                    onDoubleClick={() => openQuickPath(file.path, true)}
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

function pathToFileUri(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${normalized.split("/").map(encodeURIComponent).join("/")}`;
}
