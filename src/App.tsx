import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Circle,
  FileCog,
  FolderOpen,
  PanelLeftClose,
  Save,
  Search,
} from "lucide-react";
import { iconForFile } from "./fileTypes";
import {
  AgentContext,
  EditorSelection,
  FileEntry,
  getWorkspaceRoot,
  listFiles,
  readFile,
  updateAgentContext,
  writeFile,
} from "./tauri";

const EditorPane = lazy(() => import("./EditorPane"));

interface OpenFile {
  path: string;
  contents: string;
  dirty: boolean;
}

interface TreeNode extends FileEntry {
  children: TreeNode[];
}

const skipOpenPattern = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|dll|exe|dylib)$/i;

export default function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("Ready");
  const [selection, setSelection] = useState<EditorSelection>();

  const activeFile = openFiles.find((file) => file.path === activePath);
  const tree = useMemo(() => buildTree(files), [files]);
  const filteredTree = useMemo(
    () => filterTree(tree, filter.trim().toLowerCase()),
    [filter, tree],
  );

  const refreshFiles = useCallback(async () => {
    const [root, entries] = await Promise.all([getWorkspaceRoot(), listFiles()]);
    setWorkspaceRoot(root);
    setFiles(entries);
  }, []);

  useEffect(() => {
    refreshFiles().catch((reason) => setError(String(reason)));
  }, [refreshFiles]);

  useEffect(() => {
    const context: AgentContext = {
      activeFile: activePath,
      openFiles: openFiles.map((file) => file.path),
      selection,
    };
    updateAgentContext(context).catch(() => undefined);
  }, [activePath, openFiles, selection]);

  const openPath = useCallback(
    async (entry: FileEntry) => {
      if (entry.isDir || skipOpenPattern.test(entry.name)) return;

      setError(undefined);
      setStatus(`Opening ${entry.path}`);

      const existing = openFiles.find((file) => file.path === entry.path);
      if (existing) {
        setActivePath(existing.path);
        setStatus("Ready");
        return;
      }

      try {
        const contents = await readFile(entry.path);
        setOpenFiles((current) => [
          ...current,
          { path: entry.path, contents, dirty: false },
        ]);
        setActivePath(entry.path);
        setStatus("Ready");
      } catch (reason) {
        setError(String(reason));
        setStatus("Open failed");
      }
    },
    [openFiles],
  );

  const updateContents = useCallback((path: string, contents: string) => {
    setOpenFiles((current) =>
      current.map((file) =>
        file.path === path ? { ...file, contents, dirty: true } : file,
      ),
    );
  }, []);

  const saveActive = useCallback(async () => {
    if (!activeFile) return;
    setError(undefined);
    setStatus(`Saving ${activeFile.path}`);
    try {
      await writeFile(activeFile.path, activeFile.contents);
      setOpenFiles((current) =>
        current.map((file) =>
          file.path === activeFile.path ? { ...file, dirty: false } : file,
        ),
      );
      await refreshFiles();
      setStatus("Saved");
    } catch (reason) {
      setError(String(reason));
      setStatus("Save failed");
    }
  }, [activeFile, refreshFiles]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveActive();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveActive]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__header">
          <div>
            <div className="eyebrow">Workspace</div>
            <strong>{lastSegment(workspaceRoot) || "Loading"}</strong>
          </div>
          <button className="icon-button" title="Refresh files" onClick={refreshFiles}>
            <FolderOpen size={17} />
          </button>
        </div>

        <label className="search-box">
          <Search size={15} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter files"
          />
        </label>

        <nav className="file-tree" aria-label="Workspace files">
          {filteredTree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              activePath={activePath}
              onOpen={openPath}
            />
          ))}
        </nav>
      </aside>

      <section className="workbench">
        <header className="topbar">
          <div className="tab-strip">
            {openFiles.length === 0 ? (
              <span className="empty-tab">Open a file from the tree</span>
            ) : (
              openFiles.map((file) => (
                <button
                  className={`tab ${file.path === activePath ? "tab--active" : ""}`}
                  key={file.path}
                  onClick={() => setActivePath(file.path)}
                >
                  <FileCog size={15} />
                  <span>{file.path}</span>
                  {file.dirty ? <Circle className="dirty-dot" size={8} /> : null}
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
                onChange={updateContents}
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
          <span>{selection ? `${selection.startLine}:${selection.startColumn}` : ""}</span>
        </footer>
      </section>

      {error ? <div className="toast">{error}</div> : null}
    </main>
  );
}

function TreeItem({
  node,
  activePath,
  onOpen,
}: {
  node: TreeNode;
  activePath?: string;
  onOpen: (entry: FileEntry) => void;
}) {
  const [expanded, setExpanded] = useState(node.depth < 1);
  const Icon = iconForFile(node.name, node.isDir);
  const isActive = activePath === node.path;

  return (
    <div>
      <button
        className={`tree-row ${isActive ? "tree-row--active" : ""}`}
        style={{ paddingLeft: 8 + node.depth * 14 }}
        onClick={() => {
          if (node.isDir) {
            setExpanded((value) => !value);
          } else {
            onOpen(node);
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
              activePath={activePath}
              onOpen={onOpen}
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
