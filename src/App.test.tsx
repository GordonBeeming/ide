import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { EditorCommandRequest } from "./editorCommands";
import type { EditorCursor } from "./editorCursor";
import type { EditorDiagnostic, EditorSelection, FileEntry } from "./tauri";

const files: FileEntry[] = [
  {
    path: "src",
    name: "src",
    isDir: true,
    depth: 0,
    size: 0,
  },
  {
    path: "src/App.tsx",
    name: "App.tsx",
    parent: "src",
    isDir: false,
    depth: 1,
    size: 12,
    modifiedMs: 202,
  },
  {
    path: "README.md",
    name: "README.md",
    isDir: false,
    depth: 0,
    size: 20,
    modifiedMs: 101,
  },
  {
    path: "image.png",
    name: "image.png",
    isDir: false,
    depth: 0,
    size: 10,
  },
  {
    path: "video.mp4",
    name: "video.mp4",
    isDir: false,
    depth: 0,
    size: 10,
  },
  {
    path: "font.woff2",
    name: "font.woff2",
    isDir: false,
    depth: 0,
    size: 10,
  },
];

const tauriMocks = vi.hoisted(() => ({
  getWorkspaceRoot: vi.fn(),
  getInitialFile: vi.fn(),
  getAppInfo: vi.fn(),
  takeOpenedLaunchTargets: vi.fn(),
  listFiles: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  statFile: vi.fn(),
  recordRecentFile: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
  createFolder: vi.fn(),
  renameFile: vi.fn(),
  deleteFile: vi.fn(),
  searchFiles: vi.fn(),
  searchIndexedFiles: vi.fn(),
  pickOpenFile: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  setWorkspaceRootPath: vi.fn(),
  getUiState: vi.fn(),
  getSettingsLocations: vi.fn(),
  getWorkspaceDisplayContext: vi.fn(),
  getWorkspaceIndexStats: vi.fn(),
  advanceWorkspaceIndex: vi.fn(),
  updateUiState: vi.fn(),
  updateAgentContext: vi.fn(),
  getLspServers: vi.fn(),
  getHttpEndpoint: vi.fn(),
  getClaudeBridgeStatus: vi.fn(),
  getCodexMcpStatus: vi.fn(),
  getGitAttribution: vi.fn(),
  getGitStatus: vi.fn(),
  commitGitChanges: vi.fn(),
  fetchGit: vi.fn(),
  loadGitFileDiff: vi.fn(),
}));

const appWindowMocks = vi.hoisted(() => ({
  closeHandler: undefined as ((event: { preventDefault: () => void }) => void) | undefined,
  destroyNativeWindow: vi.fn(),
  onNativeWindowCloseRequested: vi.fn(),
  setNativeWindowTitle: vi.fn(),
  unlisten: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

const lspMocks = vi.hoisted(() => ({
  diagnosticsHandler: undefined as
    | ((filePath: string, diagnostics: EditorDiagnostic[]) => void)
    | undefined,
  setLspDiagnosticsHandler: vi.fn(),
  setLspErrorHandler: vi.fn(),
  setLspRootUri: vi.fn(),
  setLspStatusHandler: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMocks.listen,
}));

vi.mock("./tauri", async () => {
  const actual = await vi.importActual<typeof import("./tauri")>("./tauri");
  return {
    ...actual,
    getWorkspaceRoot: tauriMocks.getWorkspaceRoot,
    getInitialFile: tauriMocks.getInitialFile,
    getAppInfo: tauriMocks.getAppInfo,
    takeOpenedLaunchTargets: tauriMocks.takeOpenedLaunchTargets,
    listFiles: tauriMocks.listFiles,
    listDirectory: tauriMocks.listDirectory,
    readFile: tauriMocks.readFile,
    statFile: tauriMocks.statFile,
    recordRecentFile: tauriMocks.recordRecentFile,
    writeFile: tauriMocks.writeFile,
    createFile: tauriMocks.createFile,
    createFolder: tauriMocks.createFolder,
    renameFile: tauriMocks.renameFile,
    deleteFile: tauriMocks.deleteFile,
    searchFiles: tauriMocks.searchFiles,
    searchIndexedFiles: tauriMocks.searchIndexedFiles,
    pickOpenFile: tauriMocks.pickOpenFile,
    pickWorkspaceFolder: tauriMocks.pickWorkspaceFolder,
    setWorkspaceRootPath: tauriMocks.setWorkspaceRootPath,
    getUiState: tauriMocks.getUiState,
    getSettingsLocations: tauriMocks.getSettingsLocations,
    getWorkspaceDisplayContext: tauriMocks.getWorkspaceDisplayContext,
    getWorkspaceIndexStats: tauriMocks.getWorkspaceIndexStats,
    advanceWorkspaceIndex: tauriMocks.advanceWorkspaceIndex,
    updateUiState: tauriMocks.updateUiState,
    updateAgentContext: tauriMocks.updateAgentContext,
    getLspServers: tauriMocks.getLspServers,
    getHttpEndpoint: tauriMocks.getHttpEndpoint,
    getClaudeBridgeStatus: tauriMocks.getClaudeBridgeStatus,
    getCodexMcpStatus: tauriMocks.getCodexMcpStatus,
    getGitAttribution: tauriMocks.getGitAttribution,
    getGitStatus: tauriMocks.getGitStatus,
    commitGitChanges: tauriMocks.commitGitChanges,
    fetchGit: tauriMocks.fetchGit,
    loadGitFileDiff: tauriMocks.loadGitFileDiff,
  };
});

vi.mock("./lsp", () => ({
  setLspDiagnosticsHandler: lspMocks.setLspDiagnosticsHandler,
  setLspErrorHandler: lspMocks.setLspErrorHandler,
  setLspRootUri: lspMocks.setLspRootUri,
  setLspStatusHandler: lspMocks.setLspStatusHandler,
  workspacePathToFileUri: (path: string) => `file://${path}`,
}));

vi.mock("./appWindow", () => ({
  destroyNativeWindow: appWindowMocks.destroyNativeWindow,
  onNativeWindowCloseRequested: appWindowMocks.onNativeWindowCloseRequested,
  setNativeWindowTitle: appWindowMocks.setNativeWindowTitle,
}));

vi.mock("./EditorPane", () => ({
  default: ({
    contents,
    dateTimeFormat,
    editorCommand,
    gitAttribution,
    onChange,
    onCursor,
    onGitCommitClick,
    onSelection,
    path,
    revealLine,
  }: {
    contents: string;
    dateTimeFormat?: import("./dateTimeFormat").DateTimeFormatId;
    editorCommand?: EditorCommandRequest;
    gitAttribution?: import("./tauri").GitAttribution;
    onChange: (path: string, contents: string) => void;
    onCursor?: (cursor: EditorCursor | undefined) => void;
    onGitCommitClick?: (commit: import("./tauri").GitCommitInfo) => void;
    onSelection: (selection: EditorSelection | undefined) => void;
    path: string;
    revealLine?: number;
  }) => (
    <div>
      <textarea
        aria-label={`Editor ${path}`}
        value={contents}
        onChange={(event) => onChange(path, event.target.value)}
        onFocus={() => onCursor?.({ filePath: path, line: 1, column: 1 })}
        onSelect={() =>
          onSelection({
            filePath: path,
            text: "selected text",
            startLine: 2,
            startColumn: 3,
            endLine: 2,
            endColumn: 16,
          })
        }
      />
      {gitAttribution?.lines[0] ? (
        <button onClick={() => onGitCommitClick?.(gitAttribution.lines[0].commit)}>
          {dateTimeFormat} - {gitAttribution.lines[0].commit.authorName} - {gitAttribution.lines[0].commit.summary}
        </button>
      ) : null}
      {editorCommand ? (
        <span data-testid="editor-command">
          {editorCommand.name}:{editorCommand.nonce}
        </span>
      ) : null}
      {revealLine ? <span>Reveal line {revealLine}</span> : null}
    </div>
  ),
}));

vi.mock("./DiffPane", () => ({
  default: ({
    filePath,
    original,
    modified,
    isBinary,
    isTooLarge,
    viewMode,
    onViewModeChange,
  }: {
    filePath: string;
    original: string;
    modified: string;
    isBinary: boolean;
    isTooLarge: boolean;
    viewMode: "inline" | "sideBySide";
    onViewModeChange: (mode: "inline" | "sideBySide") => void;
  }) => (
    <div aria-label={`Diff ${filePath}`}>
      <span>view mode: {viewMode}</span>
      <button onClick={() => onViewModeChange("inline")}>Inline diff</button>
      <button onClick={() => onViewModeChange("sideBySide")}>Side-by-side diff</button>
      {isBinary ? (
        <span>Binary diff</span>
      ) : isTooLarge ? (
        <span>Diff too large</span>
      ) : (
        <>
          <span>original: {original}</span>
          <span>modified: {modified}</span>
        </>
      )}
    </div>
  ),
}));

describe("App shell interactions", () => {
  beforeEach(() => {
    for (const mock of Object.values(tauriMocks)) {
      mock.mockReset();
    }
    appWindowMocks.closeHandler = undefined;
    appWindowMocks.destroyNativeWindow.mockReset();
    appWindowMocks.destroyNativeWindow.mockResolvedValue(false);
    appWindowMocks.onNativeWindowCloseRequested.mockReset();
    appWindowMocks.onNativeWindowCloseRequested.mockImplementation(async (handler) => {
      appWindowMocks.closeHandler = handler;
      return appWindowMocks.unlisten;
    });
    appWindowMocks.setNativeWindowTitle.mockReset();
    appWindowMocks.setNativeWindowTitle.mockResolvedValue(false);
    appWindowMocks.unlisten.mockReset();
    eventMocks.listeners.clear();
    eventMocks.listen.mockReset();
    eventMocks.listen.mockImplementation(async (eventName, handler) => {
      eventMocks.listeners.set(eventName, handler);
      return eventMocks.unlisten;
    });
    eventMocks.unlisten.mockReset();
    lspMocks.diagnosticsHandler = undefined;
    lspMocks.setLspDiagnosticsHandler.mockReset();
    lspMocks.setLspDiagnosticsHandler.mockImplementation((handler) => {
      lspMocks.diagnosticsHandler = handler;
    });
    lspMocks.setLspErrorHandler.mockReset();
    lspMocks.setLspRootUri.mockReset();
    lspMocks.setLspStatusHandler.mockReset();
    tauriMocks.getWorkspaceRoot.mockResolvedValue("/workspace");
    tauriMocks.getInitialFile.mockResolvedValue(undefined);
    tauriMocks.getAppInfo.mockResolvedValue({
      name: "ide",
      version: "0.1.0",
      description: "A lean local IDE.",
      authors: ["Gordon Beeming"],
      repository: "https://github.com/gordonbeeming/ide",
    });
    tauriMocks.takeOpenedLaunchTargets.mockResolvedValue([]);
    tauriMocks.listFiles.mockResolvedValue(files);
    tauriMocks.listDirectory.mockImplementation(async (path: string) =>
      files.filter((entry) => entry.parent === path),
    );
    tauriMocks.statFile.mockImplementation(async (path: string) => {
      const entry = files.find((candidate) => candidate.path === path);
      if (entry) return entry;
      return {
        path,
        name: path.split("/").at(-1) ?? path,
        isDir: false,
        depth: path.split("/").length - 1,
        size: 0,
        modifiedMs: 0,
      };
    });
    tauriMocks.recordRecentFile.mockResolvedValue(undefined);
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") return "readme";
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });
    tauriMocks.writeFile.mockResolvedValue(undefined);
    tauriMocks.createFile.mockResolvedValue(undefined);
    tauriMocks.createFolder.mockResolvedValue(undefined);
    tauriMocks.renameFile.mockResolvedValue(undefined);
    tauriMocks.deleteFile.mockResolvedValue(undefined);
    tauriMocks.searchFiles.mockResolvedValue([]);
    tauriMocks.searchIndexedFiles.mockResolvedValue([]);
    tauriMocks.pickOpenFile.mockResolvedValue(undefined);
    tauriMocks.setWorkspaceRootPath.mockResolvedValue("/workspace");
    tauriMocks.getUiState.mockResolvedValue({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
        showDiagnosticsPanel: false,
      },
      workspace: {
        expandedFolders: [],
        openFiles: [],
      },
    });
    tauriMocks.getSettingsLocations.mockResolvedValue({
      settingsFile: "/Users/gordon/Library/Application Support/com.gordonbeeming.ide/ui-state.json",
      recentsFile: "/Users/gordon/Library/Application Support/com.gordonbeeming.ide/recents.json",
      workspaceIndexFile: "/Users/gordon/Library/Application Support/com.gordonbeeming.ide/workspace-index.sqlite",
    });
    tauriMocks.getWorkspaceDisplayContext.mockResolvedValue({
      appTitle: "ide - workspace",
      workspaceLabel: "workspace",
      fullLabel: "workspace",
    });
    tauriMocks.getWorkspaceIndexStats.mockResolvedValue({
      indexedEntries: 12,
      indexedFiles: 7,
      indexedFolders: 5,
      loadedFolders: 3,
      pendingFolders: 2,
    });
    tauriMocks.advanceWorkspaceIndex.mockResolvedValue({
      indexedEntries: 12,
      indexedFiles: 7,
      indexedFolders: 5,
      loadedFolders: 3,
      pendingFolders: 0,
    });
    tauriMocks.updateUiState.mockResolvedValue(undefined);
    tauriMocks.fetchGit.mockResolvedValue(undefined);
    tauriMocks.updateAgentContext.mockResolvedValue(undefined);
    tauriMocks.getLspServers.mockResolvedValue([]);
    tauriMocks.getHttpEndpoint.mockResolvedValue("http://127.0.0.1:1420");
    tauriMocks.getClaudeBridgeStatus.mockResolvedValue(undefined);
    tauriMocks.getCodexMcpStatus.mockResolvedValue(undefined);
    tauriMocks.getGitAttribution.mockResolvedValue({
      path: "README.md",
      status: "unsupported",
      unsupportedReason: "File is not tracked by Git",
      lines: [],
    });
    tauriMocks.getGitStatus.mockResolvedValue({
      status: "available",
      branch: "main",
      headDetached: false,
      headUnborn: false,
      files: [
        { path: "README.md", status: "modified", staged: false, unstaged: true },
        { path: "src/App.tsx", status: "modified", staged: true, unstaged: false },
      ],
    });
    tauriMocks.commitGitChanges.mockResolvedValue({
      sha: "abc123456789",
      shortSha: "abc1234",
      branch: "main",
      committedPaths: ["README.md"],
    });
    tauriMocks.loadGitFileDiff.mockResolvedValue({
      original: "before\n",
      modified: "after\n",
      status: "modified",
      isBinary: false,
      isTooLarge: false,
    });
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows a loading workspace state before the initial scan completes", () => {
    tauriMocks.getWorkspaceRoot.mockReturnValue(new Promise(() => undefined));
    tauriMocks.listFiles.mockReturnValue(new Promise(() => undefined));

    render(<App />);

    expect(screen.getByText("Loading workspace")).toBeInTheDocument();
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  });

  it("uses workspace display context for the native title and compact sidebar header", async () => {
    tauriMocks.getWorkspaceDisplayContext.mockResolvedValue({
      appTitle: "ide - sample-repo/packages/editor",
      workspaceLabel: "sample-repo/packages/editor",
      fullLabel: "sample-repo/packages/editor",
      gitRoot: "/workspace",
    });

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() =>
      expect(appWindowMocks.setNativeWindowTitle).toHaveBeenLastCalledWith(
        "ide - sample-repo/packages/editor",
      ),
    );
    await waitFor(() => expect(document.title).toBe("ide - sample-repo/packages/editor"));
    expect(screen.queryByText("sample-repo/packages/editor")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  });

  it("surfaces workspace load failures and retries the scan", async () => {
    tauriMocks.listFiles
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValueOnce(files);

    render(<App />);

    await waitFor(() =>
      expect(screen.getAllByText("Workspace load failed").length).toBeGreaterThan(0),
    );
    expect(screen.getByText("Error: scan failed")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Retry"));

    expect(await treeButton("README.md")).toBeInTheDocument();
    expect(tauriMocks.listFiles).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("shows an empty workspace state after a successful empty scan", async () => {
    tauriMocks.listFiles.mockResolvedValueOnce([]);

    render(<App />);

    expect(await screen.findByText("Empty workspace")).toBeInTheDocument();
    expect(screen.queryByText("Workspace load failed")).not.toBeInTheDocument();
  });

  it("surfaces bounded initial scans as a compact sidebar status and opens performance settings", async () => {
    tauriMocks.listFiles.mockResolvedValueOnce({
      entries: files,
      truncated: true,
      limit: 3,
    });

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    expect(screen.queryByText(/Initial scan reached 3 entries/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Initial scan reached 3 entries. Open Performance settings.",
      }),
    );

    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Performance/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("Initial tree scan entries")).toBeInTheDocument();
  });

  it("advances workspace indexing in background batches after initial load", async () => {
    tauriMocks.advanceWorkspaceIndex
      .mockResolvedValueOnce({
        indexedEntries: 20,
        indexedFiles: 12,
        indexedFolders: 8,
        loadedFolders: 4,
        pendingFolders: 1,
      })
      .mockResolvedValueOnce({
        indexedEntries: 30,
        indexedFiles: 20,
        indexedFolders: 10,
        loadedFolders: 5,
        pendingFolders: 0,
      });

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(
      () =>
        expect(tauriMocks.advanceWorkspaceIndex).toHaveBeenCalledWith(
          2000,
          false,
          false,
          false,
        ),
      { timeout: 1500 },
    );
    await waitFor(
      () => expect(tauriMocks.advanceWorkspaceIndex).toHaveBeenCalledTimes(2),
      { timeout: 2500 },
    );
  });

  it("keeps the empty editor pane on the active light theme", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-ide-theme", "light");
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-ide-theme", "light");
    expect(screen.getByText("No file selected").closest(".editor-region")).toHaveClass("editor-region");
    expect(screen.getByText("No file selected").closest(".editor-region")).not.toHaveClass(
      "editor-region--dark",
    );
  });

  it("keeps the empty editor pane on the active dark theme", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-ide-theme", "dark");
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-ide-theme", "dark");
    expect(screen.getByText("No file selected").closest(".editor-region")).toHaveClass("editor-region");
    expect(screen.getByText("No file selected").closest(".editor-region")).not.toHaveClass(
      "editor-region--light",
    );
  });

  it("opens a launched file even when the workspace scan omitted it", async () => {
    tauriMocks.getInitialFile.mockResolvedValueOnce("LICENSE");
    tauriMocks.statFile.mockResolvedValueOnce({
      path: "LICENSE",
      name: "LICENSE",
      isDir: false,
      depth: 0,
      size: 12,
      modifiedMs: 404,
    });
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "LICENSE") return "license body";
      if (path === "README.md") return "readme";
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });

    render(<App />);

    expect(await screen.findByLabelText("Editor LICENSE")).toHaveValue("license body");
    expect(tauriMocks.recordRecentFile).toHaveBeenCalledWith("LICENSE", true);
    expect(await treeButton("LICENSE")).toBeInTheDocument();
    expect(screen.queryByText("src")).not.toBeInTheDocument();
    expect(tauriMocks.listFiles).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/Launch file is not in the current workspace/),
    ).not.toBeInTheDocument();
  });

  it("opens Finder file handoffs as single-file sessions", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.statFile.mockResolvedValueOnce({
      path: "notes.md",
      name: "notes.md",
      isDir: false,
      depth: 0,
      size: 11,
      modifiedMs: 505,
    });
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "notes.md") return "# Notes";
      if (path === "README.md") return "readme";
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() =>
      expect(eventMocks.listeners.has("menu://open-file")).toBe(true),
    );

    eventMocks.listeners.get("menu://open-file")?.({
      payload: {
        workspaceRoot: "/Users/gordonbeeming/Developer",
        path: "notes.md",
        singleFile: true,
      },
    });

    expect(await screen.findByLabelText("Editor notes.md")).toHaveValue("# Notes");
    expect(tauriMocks.recordRecentFile).toHaveBeenCalledWith("notes.md", true);
    expect(await treeButton("notes.md")).toBeInTheDocument();
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
    expect(tauriMocks.setWorkspaceRootPath).toHaveBeenCalledWith(
      "/Users/gordonbeeming/Developer",
    );
  });

  it("opens pending OS file association requests after native listeners register", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.takeOpenedLaunchTargets.mockResolvedValueOnce([
      {
        type: "file",
        workspaceRoot: "/Users/gordonbeeming/Developer",
        path: "notes.md",
        singleFile: true,
      },
    ]);
    tauriMocks.statFile.mockResolvedValueOnce({
      path: "notes.md",
      name: "notes.md",
      isDir: false,
      depth: 0,
      size: 11,
      modifiedMs: 505,
    });
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "notes.md") return "# Notes";
      if (path === "README.md") return "readme";
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });

    render(<App />);

    expect(await screen.findByLabelText("Editor notes.md")).toHaveValue("# Notes");
    expect(tauriMocks.takeOpenedLaunchTargets).toHaveBeenCalledTimes(1);
    expect(tauriMocks.setWorkspaceRootPath).toHaveBeenCalledWith(
      "/Users/gordonbeeming/Developer",
    );
    expect(tauriMocks.recordRecentFile).toHaveBeenCalledWith("notes.md", true);
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
  });

  it("keeps first-level folders collapsed until the user opens them", async () => {
    render(<App />);

    expect(await treeButton("src")).toBeInTheDocument();
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();

    fireEvent.click(await treeButton("src"));

    expect(await treeButton("App.tsx")).toBeInTheDocument();
  });

  it("opens files from the tree with Enter as preview tabs", async () => {
    render(<App />);

    const readmeRow = await treeButton("README.md");
    fireEvent.keyDown(readmeRow, { key: "Enter" });

    expect(readmeRow).toHaveClass("tree-row--active");
    const tab = await findTab("README.md");
    expect(tab).toHaveClass("tab--temp");
    expect(await screen.findByLabelText("Editor README.md")).toHaveValue("readme");
  });

  it("toggles folders from the tree with keyboard commands", async () => {
    render(<App />);

    const tree = await screen.findByLabelText("Workspace files");
    const srcRow = await treeButton("src");
    expect(within(tree).queryByText("App.tsx")).not.toBeInTheDocument();

    fireEvent.keyDown(srcRow, { key: "ArrowRight" });

    expect(srcRow).toHaveClass("tree-row--active");
    expect(await treeButton("App.tsx")).toBeInTheDocument();

    fireEvent.keyDown(srcRow, { key: "ArrowLeft" });

    await waitFor(() =>
      expect(within(tree).queryByText("App.tsx")).not.toBeInTheDocument(),
    );

    fireEvent.keyDown(srcRow, { key: " " });

    expect(await treeButton("App.tsx")).toBeInTheDocument();
  });

  it("loads folder children on demand when expanding a partially indexed folder", async () => {
    tauriMocks.listFiles.mockResolvedValueOnce([
      {
        path: "src",
        name: "src",
        isDir: true,
        depth: 0,
        size: 0,
      },
    ]);
    tauriMocks.listDirectory.mockResolvedValueOnce([
      {
        path: "src/App.tsx",
        name: "App.tsx",
        parent: "src",
        isDir: false,
        depth: 1,
        size: 12,
        modifiedMs: 202,
      },
    ]);

    render(<App />);

    fireEvent.click(await treeButton("src"));

    expect(tauriMocks.listDirectory).toHaveBeenCalledWith("src", false, false, false, false);
    expect(await treeButton("App.tsx")).toBeInTheDocument();
  });

  it("does not duplicate an in-flight folder child load when re-expanding a folder", async () => {
    let resolveDirectory: (entries: FileEntry[]) => void = () => undefined;
    const directoryPromise = new Promise<FileEntry[]>((resolve) => {
      resolveDirectory = resolve;
    });

    tauriMocks.listFiles.mockResolvedValueOnce([
      {
        path: "src",
        name: "src",
        isDir: true,
        depth: 0,
        size: 0,
      },
    ]);
    tauriMocks.listDirectory.mockReturnValueOnce(directoryPromise);

    render(<App />);

    const srcRow = await treeButton("src");
    fireEvent.click(srcRow);
    await waitFor(() => expect(srcRow).toHaveAttribute("aria-expanded", "true"));

    fireEvent.click(srcRow);
    await waitFor(() => expect(srcRow).toHaveAttribute("aria-expanded", "false"));

    fireEvent.click(srcRow);
    await waitFor(() => expect(srcRow).toHaveAttribute("aria-expanded", "true"));
    expect(tauriMocks.listDirectory).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDirectory([
        {
          path: "src/App.tsx",
          name: "App.tsx",
          parent: "src",
          isDir: false,
          depth: 1,
          size: 12,
          modifiedMs: 202,
        },
      ]);
    });

    expect(await treeButton("App.tsx")).toBeInTheDocument();
  });

  it("exposes file tree selection and folder expansion state", async () => {
    render(<App />);

    const tree = await screen.findByRole("tree", { name: "Workspace files" });
    const srcRow = await within(tree).findByRole("treeitem", { name: "src" });
    expect(srcRow).toHaveAttribute("aria-expanded", "false");
    expect(srcRow).toHaveAttribute("aria-level", "1");
    expect(srcRow).toHaveAttribute("aria-selected", "false");

    fireEvent.click(srcRow);

    expect(srcRow).toHaveAttribute("aria-expanded", "true");
    expect(srcRow).toHaveAttribute("aria-selected", "true");
    const appRow = await within(tree).findByRole("treeitem", { name: "App.tsx" });
    expect(appRow).toHaveAttribute("aria-level", "2");
    expect(appRow).toHaveAttribute("aria-selected", "false");

    fireEvent.click(appRow);

    expect(appRow).toHaveAttribute("aria-selected", "true");
  });

  it("restores saved view settings, expanded folders, and open files", async () => {
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: true,
        showGeneratedInternal: true,
        showDiagnosticsPanel: true,
        treeScanLimit: 12000,
      },
      workspace: {
        expandedFolders: ["src"],
        openFiles: ["src/App.tsx"],
        activeFile: "src/App.tsx",
        selectedPath: "src/App.tsx",
      },
    });

    render(<App />);

    await waitFor(() =>
      expect(tauriMocks.listFiles).toHaveBeenCalledWith(true, true, 12000, false),
    );
    expect(await treeButton("App.tsx")).toHaveClass("tree-row--active");
    const tab = await findTab("src/App.tsx");
    expect(tab).not.toHaveClass("tab--temp");
    expect(await screen.findByLabelText("Editor src/App.tsx")).toHaveValue(
      "export function App() {}",
    );
  });

  it("restores readable saved tabs when another saved tab fails", async () => {
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
      },
      workspace: {
        expandedFolders: ["src"],
        openFiles: ["README.md", "src/App.tsx"],
        activeFile: "src/App.tsx",
        selectedPath: "src/App.tsx",
      },
    });
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") throw new Error("readme went away");
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });

    render(<App />);

    expect(await screen.findByLabelText("Editor src/App.tsx")).toHaveValue(
      "export function App() {}",
    );
    expect(await findTab("src/App.tsx")).not.toHaveClass("tab--temp");
    expect(screen.queryByRole("tab", { name: /README\.md/ })).not.toBeInTheDocument();
    expect(
      screen.getByText("Unable to restore README.md: Error: readme went away"),
    ).toBeInTheDocument();
  });

  it("does not overwrite saved tabs immediately after a restore failure", async () => {
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
      },
      workspace: {
        expandedFolders: ["src"],
        openFiles: ["README.md", "src/App.tsx"],
        activeFile: "src/App.tsx",
        selectedPath: "src/App.tsx",
      },
    });
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") throw new Error("temporary read failure");
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });

    render(<App />);

    expect(await screen.findByLabelText("Editor src/App.tsx")).toHaveValue(
      "export function App() {}",
    );
    expect(
      screen.getByText("Unable to restore README.md: Error: temporary read failure"),
    ).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });

    expect(tauriMocks.updateUiState).not.toHaveBeenCalled();

    fireEvent.click(await treeButton("src"));

    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenCalledWith(
        expect.objectContaining({
          showDotfiles: false,
          showGeneratedInternal: false,
          showDiagnosticsPanel: false,
          treeScanLimit: 10000,
          maxOpenFileKb: 5120,
          workspaceSearchResultLimit: 200,
          workspaceSearchMaxFileKb: 1024,
          currentFileSearchResultLimit: 200,
          currentFileResultPreviewLimit: 12,
          quickOpenResultLimit: 12,
          backgroundIndexBatchEntries: 2000,
          commandPaletteResultLimit: 18,
        }),
        expect.objectContaining({
          expandedFolders: [],
          openFiles: ["src/App.tsx"],
          activeFile: "src/App.tsx",
          selectedPath: "src",
        }),
      ),
    );
  });

  it("groups settings into selectable categories", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();

    expect(screen.getByRole("tab", { name: /View/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("Show dotfiles and dot folders")).toBeInTheDocument();
    expect(screen.getByLabelText("Show diagnostics panel")).toBeInTheDocument();
    expect(screen.queryByLabelText("Initial tree scan entries")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Date and time format")).toBeInTheDocument();
    expect(screen.getByLabelText("Show recent dates as relative")).toBeInTheDocument();

    selectSettingsTab("Performance");

    expect(screen.getByLabelText("Initial tree scan entries")).toBeInTheDocument();
    expect(screen.queryByLabelText("Show dotfiles and dot folders")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Date and time format")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Show recent dates as relative")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Show diagnostics panel")).not.toBeInTheDocument();
  });

  it("persists the selected date and time display settings", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();

    fireEvent.change(screen.getByLabelText("Date and time format"), {
      target: { value: "yyyyMmDdHhMm" },
    });

    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          dateTimeFormat: "yyyyMmDdHhMm",
        }),
        expect.anything(),
      ),
    );

    fireEvent.change(screen.getByLabelText("Show recent dates as relative"), {
      target: { value: "twoDays" },
    });

    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          dateTimeFormat: "yyyyMmDdHhMm",
          recentRelativeThreshold: "twoDays",
        }),
        expect.anything(),
      ),
    );
  });

  it("persists the auto-fetch cadence and clamps 0 to disabled", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    selectSettingsTab("Performance");

    fireEvent.change(
      screen.getByLabelText("Auto-fetch from remote (seconds, 0 to turn off)"),
      { target: { value: "0" } },
    );

    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        expect.objectContaining({ autoFetchSeconds: 0 }),
        expect.anything(),
      ),
    );
  });

  it("auto-fetches on the configured interval and not when disabled", async () => {
    vi.useFakeTimers();
    try {
      tauriMocks.getUiState.mockResolvedValue({
        view: { showDotfiles: false, showGeneratedInternal: false, autoFetchSeconds: 15 },
        workspace: { expandedFolders: [], openFiles: [] },
      });
      // An upstream must exist (ahead/behind defined) or auto-fetch correctly
      // skips as "no upstream".
      tauriMocks.getGitStatus.mockResolvedValue({
        status: "available",
        branch: "main",
        headDetached: false,
        headUnborn: false,
        files: [],
        mergeInProgress: false,
        conflictedFiles: [],
        ahead: 0,
        behind: 0,
      });

      render(<App />);
      // Let the async mount (workspace root, files, ui-state) settle so the
      // auto-fetch effect installs its interval, before the interval could fire.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(tauriMocks.fetchGit).not.toHaveBeenCalled();

      // A full cadence later, it fires exactly once.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(tauriMocks.fetchGit).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("still auto-fetches on a detached HEAD, where ahead/behind are also null", async () => {
    vi.useFakeTimers();
    try {
      tauriMocks.getUiState.mockResolvedValue({
        view: { showDotfiles: false, showGeneratedInternal: false, autoFetchSeconds: 15 },
        workspace: { expandedFolders: [], openFiles: [] },
      });
      // A detached HEAD has no branch to compare against, so the backend
      // reports ahead/behind as null the same way it does for a genuine
      // no-upstream branch — the guard must not conflate the two and
      // wrongly suppress fetching just because nothing is checked out.
      tauriMocks.getGitStatus.mockResolvedValue({
        status: "available",
        branch: undefined,
        headDetached: true,
        headUnborn: false,
        files: [],
        mergeInProgress: false,
        conflictedFiles: [],
        ahead: null,
        behind: null,
      });

      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(tauriMocks.fetchGit).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(tauriMocks.fetchGit).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not auto-fetch when the cadence is disabled", async () => {
    vi.useFakeTimers();
    try {
      tauriMocks.getUiState.mockResolvedValue({
        view: { showDotfiles: false, showGeneratedInternal: false, autoFetchSeconds: 0 },
        workspace: { expandedFolders: [], openFiles: [] },
      });

      render(<App />);
      // Settle the mount (workspace open) so the guard, not a missing mount, is
      // what keeps the timer from installing.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      // Well past any plausible interval — a disabled cadence installs no timer.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120000);
      });
      expect(tauriMocks.fetchGit).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("shows preview feature flags and persists a toggle", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    selectSettingsTab("Preview Features");

    const toggle = await screen.findByLabelText("Git attribution");
    expect(toggle).not.toBeChecked();
    // Internal-only flags must never surface here.
    expect(screen.queryByLabelText("Show dotfiles and dot folders")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          featureFlags: expect.objectContaining({ gitAttribution: true }),
        }),
        expect.anything(),
      ),
    );
  });

  it("restores a persisted preview flag override", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
        featureFlags: { gitAttribution: true, retiredFlag: true },
      },
      workspace: { expandedFolders: [], openFiles: [] },
    });

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    selectSettingsTab("Preview Features");

    expect(await screen.findByLabelText("Git attribution")).toBeChecked();
  });

  it("does not request Git attribution while the preview flag is disabled", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    fireEvent.doubleClick(await treeButton("README.md"));

    await screen.findByLabelText("Editor README.md");
    expect(tauriMocks.getGitAttribution).not.toHaveBeenCalled();
  });

  it("shows last commit attribution in the status bar when enabled", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
        featureFlags: { gitAttribution: true },
      },
      workspace: {
        expandedFolders: [],
        openFiles: ["README.md"],
        activeFile: "README.md",
      },
    });
    tauriMocks.getGitAttribution.mockResolvedValueOnce({
      path: "README.md",
      status: "available",
      file: {
        sha: "abc123456789",
        shortSha: "abc12345",
        authorName: "Gordon Beeming",
        authoredAtSeconds: Math.floor(Date.now() / 1000) - 3600,
        summary: "Add readme",
        actions: [
          {
            provider: "GitHub",
            remoteName: "origin",
            label: "Open in GitHub",
            url: "https://github.com/GordonBeeming/ide/commit/abc123456789",
          },
        ],
      },
      lines: [
        {
          lineNumber: 1,
          commit: {
            sha: "abc123456789",
            shortSha: "abc12345",
            authorName: "Gordon Beeming",
            authoredAtSeconds: Math.floor(Date.now() / 1000) - 3600,
            summary: "Add readme",
            actions: [],
          },
        },
      ],
    });

    render(<App />);

    expect(await screen.findByText("Last commit")).toBeInTheDocument();
    expect(screen.getByText("Gordon Beeming")).toBeInTheDocument();
    expect(screen.getByText("Add readme")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Last commit"));

    const dialog = await screen.findByRole("dialog", { name: "Git commit details" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("abc12345")).toBeInTheDocument();
    expect(screen.getByText("Open in GitHub")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Close Git commit details" }),
    ).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Git commit details" }))
      .not.toBeInTheDocument();
  });

  it("keeps last commit attribution visible while the active file is dirty", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
        featureFlags: { gitAttribution: true },
      },
      workspace: {
        expandedFolders: [],
        openFiles: ["README.md"],
        activeFile: "README.md",
      },
    });
    tauriMocks.getGitAttribution.mockResolvedValueOnce({
      path: "README.md",
      status: "available",
      file: {
        sha: "abc123456789",
        shortSha: "abc12345",
        authorName: "Gordon Beeming",
        authoredAtSeconds: Math.floor(Date.now() / 1000) - 3600,
        summary: "Add readme",
        actions: [],
      },
      lines: [
        {
          lineNumber: 1,
          commit: {
            sha: "abc123456789",
            shortSha: "abc12345",
            authorName: "Gordon Beeming",
            authoredAtSeconds: Math.floor(Date.now() / 1000) - 3600,
            summary: "Add readme",
            actions: [],
          },
        },
      ],
    });

    render(<App />);

    expect(await screen.findByText("Last commit")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Editor README.md"), {
      target: { value: "dirty readme" },
    });

    expect(screen.getByText("Last commit")).toBeInTheDocument();
    expect(screen.getByText("Gordon Beeming")).toBeInTheDocument();
    expect(screen.getByText("Add readme")).toBeInTheDocument();
    expect(tauriMocks.getGitAttribution).toHaveBeenCalledTimes(1);
  });

  it("clears an open Git commit popover when switching files", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
        featureFlags: { gitAttribution: true },
      },
      workspace: {
        expandedFolders: ["src"],
        openFiles: ["README.md", "src/App.tsx"],
        activeFile: "README.md",
      },
    });
    tauriMocks.getGitAttribution
      .mockResolvedValueOnce({
        path: "README.md",
        status: "available",
        file: {
          sha: "abc123456789",
          shortSha: "abc12345",
          authorName: "Gordon Beeming",
          authoredAtSeconds: Math.floor(Date.now() / 1000) - 3600,
          summary: "Add readme",
          actions: [],
        },
        lines: [],
      })
      .mockResolvedValueOnce({
        path: "src/App.tsx",
        status: "unsupported",
        unsupportedReason: "File is not tracked by Git",
        lines: [],
      });

    render(<App />);

    fireEvent.click(await screen.findByText("Last commit"));
    expect(await screen.findByRole("dialog", { name: "Git commit details" })).toBeInTheDocument();

    fireEvent.click(await treeButton("App.tsx"));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Git commit details" }))
        .not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(tauriMocks.getGitAttribution).toHaveBeenCalledWith("src/App.tsx"),
    );
  });

  it("shows OS storage paths from Settings", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    selectSettingsTab("Storage");

    expect(screen.getByText("Settings file")).toBeInTheDocument();
    expect(
      screen.getByText(
        "/Users/gordon/Library/Application Support/com.gordonbeeming.ide/ui-state.json",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "/Users/gordon/Library/Application Support/com.gordonbeeming.ide/recents.json",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "/Users/gordon/Library/Application Support/com.gordonbeeming.ide/workspace-index.sqlite",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy settings file path" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Workspace index coverage")).toBeInTheDocument();
    expect(screen.getByText("Indexed files")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Pending folders")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(tauriMocks.getWorkspaceIndexStats).toHaveBeenCalledTimes(1);
  });

  it("reloads the tree with dotfiles when changed from Settings", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.listFiles
      .mockResolvedValueOnce(files)
      .mockResolvedValueOnce([
        ...files,
        {
          path: ".gitignore",
          name: ".gitignore",
          isDir: false,
          depth: 0,
          size: 8,
          modifiedMs: 303,
        },
      ]);

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    fireEvent.click(await screen.findByLabelText("Show dotfiles and dot folders"));

    await waitFor(() =>
      expect(tauriMocks.listFiles).toHaveBeenLastCalledWith(true, false, 10000, false),
    );
    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          showDotfiles: true,
          showGeneratedInternal: false,
          treeScanLimit: 10000,
          backgroundIndexBatchEntries: 2000,
        }),
        expect.any(Object),
      ),
    );
    expect(await treeButton(".gitignore")).toBeInTheDocument();
  });

  it("reloads the tree with generated folders when changed from Settings", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.listFiles
      .mockResolvedValueOnce(files)
      .mockResolvedValueOnce([
        ...files,
        {
          path: "node_modules",
          name: "node_modules",
          isDir: true,
          depth: 0,
          size: 0,
        },
      ]);

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    fireEvent.click(await screen.findByLabelText("Show generated and internal folders"));

    await waitFor(() =>
      expect(tauriMocks.listFiles).toHaveBeenLastCalledWith(false, true, 10000, false),
    );
    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          showDotfiles: false,
          showGeneratedInternal: true,
          treeScanLimit: 10000,
          backgroundIndexBatchEntries: 2000,
        }),
        expect.any(Object),
      ),
    );
    expect(await treeButton("node_modules")).toBeInTheDocument();
  });

  it("reloads the tree when gitignored files are shown from Settings", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const configFile = {
      path: "config.json",
      name: "config.json",
      parent: undefined,
      isDir: false,
      depth: 0,
      size: 2,
      modifiedMs: 404,
    };
    tauriMocks.listFiles
      .mockResolvedValueOnce(files)
      .mockResolvedValueOnce([...files, configFile]);

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    fireEvent.click(await screen.findByLabelText("Show gitignored files"));

    await waitFor(() =>
      expect(tauriMocks.listFiles).toHaveBeenLastCalledWith(false, false, 10000, true),
    );
    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          showDotfiles: false,
          showGeneratedInternal: false,
          showGitignoredFiles: true,
          treeScanLimit: 10000,
        }),
        expect.any(Object),
      ),
    );
    expect(await treeButton("config.json")).toBeInTheDocument();
  });

  it("applies the tree scan limit from Settings", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.listFiles.mockResolvedValue(files);

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    selectSettingsTab("Performance");

    fireEvent.change(await screen.findByLabelText("Initial tree scan entries"), {
      target: { value: "8000" },
    });

    await waitFor(() =>
      expect(tauriMocks.listFiles).toHaveBeenLastCalledWith(false, false, 8000, false),
    );
    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          showDotfiles: false,
          showGeneratedInternal: false,
          treeScanLimit: 8000,
        }),
        expect.any(Object),
      ),
    );
  });

  it("applies workspace search limits from Settings", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.searchFiles.mockResolvedValueOnce([]);

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    selectSettingsTab("Search");

    fireEvent.change(await screen.findByLabelText("Workspace search results"), {
      target: { value: "500" },
    });
    fireEvent.change(await screen.findByLabelText("Workspace search file KB"), {
      target: { value: "512" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.change(await openContentSearch(), {
      target: { value: "needle" },
    });

    await waitFor(() =>
      expect(tauriMocks.searchFiles).toHaveBeenCalledWith("needle", 500, 512 * 1024, false),
    );
    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspaceSearchResultLimit: 500,
          workspaceSearchMaxFileKb: 512,
        }),
        expect.any(Object),
      ),
    );
  });

  it("applies dotfile visibility to workspace content search scope", async () => {
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: true,
        showGeneratedInternal: false,
      },
      workspace: {
        expandedFolders: [],
        openFiles: [],
      },
    });
    tauriMocks.searchFiles.mockResolvedValueOnce([]);
    render(<App />);

    fireEvent.change(await openContentSearch(), {
      target: { value: "needle" },
    });

    await waitFor(() =>
      expect(tauriMocks.searchFiles).toHaveBeenCalledWith("needle", 200, 1024 * 1024, true),
    );
  });

  it("applies the editable file size limit from Settings", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    selectSettingsTab("Performance");

    fireEvent.change(await screen.findByLabelText("Max editable file KB"), {
      target: { value: "2048" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(await treeButton("README.md"));

    await waitFor(() =>
      expect(tauriMocks.readFile).toHaveBeenCalledWith("README.md", 2048 * 1024, false),
    );
    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          maxOpenFileKb: 2048,
        }),
        expect.any(Object),
      ),
    );
  });

  it("applies the current-file result row limit from Settings", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") {
        return "needle one\nneedle two\nneedle three\nneedle four";
      }
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    selectSettingsTab("Search");

    fireEvent.change(await screen.findByLabelText("Current-file result rows"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await openCurrentFileFind(), {
      target: { value: "needle" },
    });

    const results = screen.getByLabelText("Current file search results");
    expect(results).toHaveTextContent("4");
    expect(within(results).getByText("line 1")).toBeInTheDocument();
    expect(within(results).getByText("line 3")).toBeInTheDocument();
    expect(within(results).queryByText("line 4")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          currentFileResultPreviewLimit: 3,
        }),
        expect.any(Object),
      ),
    );
  });

  it("closes the native window immediately when there are no unsaved files", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() => expect(appWindowMocks.closeHandler).toBeDefined());

    const preventDefault = vi.fn();
    appWindowMocks.closeHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(appWindowMocks.destroyNativeWindow).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByText("Close ide?")).not.toBeInTheDocument();
  });

  it("prompts before native window close when there are unsaved files", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });
    await waitFor(() => expect(appWindowMocks.closeHandler).toBeDefined());

    const preventDefault = vi.fn();
    appWindowMocks.closeHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Close ide?")).toBeInTheDocument();
    expect(appWindowMocks.destroyNativeWindow).not.toHaveBeenCalled();
  });

  it.each(["image.png", "video.mp4", "font.woff2"])(
    "selects non-text %s files in the tree without opening an editor tab",
    async (fileName) => {
      render(<App />);

      const fileRow = await treeButton(fileName);
      fireEvent.click(fileRow);

      expect(fileRow).toHaveClass("tree-row--active");
      expect(tauriMocks.readFile).not.toHaveBeenCalled();
      expect(
        screen.getByText("Non-text file selected").closest(".editor-empty-state"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(`${fileName} is selected but is not editable as text.`),
      ).toBeInTheDocument();
      expect(screen.getByText(`${fileName} selected`)).toBeInTheDocument();
      expect(screen.getByText("Open a file from the tree")).toBeInTheDocument();
    },
  );

  it("shows a non-text selection instead of leaving the previous editor visible", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    const readmeTab = await findTab("README.md");
    expect(await screen.findByLabelText("Editor README.md")).toHaveValue("readme");

    const imageRow = await treeButton("image.png");
    fireEvent.click(imageRow);

    expect(imageRow).toHaveClass("tree-row--active");
    expect(readmeTab).not.toHaveClass("tab--active");
    expect(tabButton("README.md")).toBeInTheDocument();
    expect(screen.queryByLabelText("Editor README.md")).not.toBeInTheDocument();
    expect(screen.getByText("Non-text file selected")).toBeInTheDocument();
    expect(screen.getByText("image.png selected")).toBeInTheDocument();
  });

  it("keeps invalid UTF-8 files selected while explaining why they did not open", async () => {
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") throw new Error("file is not valid UTF-8 text");
      return "";
    });

    render(<App />);

    const readmeRow = await treeButton("README.md");
    fireEvent.click(readmeRow);

    expect(readmeRow).toHaveClass("tree-row--active");
    expect(await screen.findByText("File is not valid text")).toBeInTheDocument();
    expect(screen.getAllByText("Error: file is not valid UTF-8 text")).toHaveLength(2);
    expect(screen.getByText("Open failed")).toBeInTheDocument();
    expect(screen.queryByLabelText("Editor README.md")).not.toBeInTheDocument();
  });

  it("shows a failed-open selection instead of leaving the previous editor visible", async () => {
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") return "readme";
      if (path === "src/App.tsx") throw new Error("file is not valid UTF-8 text");
      return "";
    });

    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    expect(await screen.findByLabelText("Editor README.md")).toHaveValue("readme");
    fireEvent.click(await treeButton("src"));

    const appRow = await treeButton("App.tsx");
    fireEvent.click(appRow);

    expect(await screen.findByText("File is not valid text")).toBeInTheDocument();
    expect(appRow).toHaveClass("tree-row--active");
    expect(tabButton("README.md")).toBeInTheDocument();
    await waitFor(() =>
      expect(tabButton("README.md")).not.toHaveClass("tab--active"),
    );
    expect(screen.queryByLabelText("Editor README.md")).not.toBeInTheDocument();
    expect(screen.getByText("Open failed")).toBeInTheDocument();
  });

  it("keeps integration details out of the default sidebar layout", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    expect(screen.queryByText("Browser Endpoint")).not.toBeInTheDocument();
    expect(screen.queryByText("Claude Bridge")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex MCP")).not.toBeInTheDocument();
    expect(screen.queryByText("Language Servers")).not.toBeInTheDocument();
  });

  it("shows copy actions for integration endpoints and config values", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.getClaudeBridgeStatus.mockResolvedValueOnce({
      endpoint: "ws://127.0.0.1:53126",
      lockFile: "/Users/gordon/.claude/ide/ide.lock",
    });
    tauriMocks.getCodexMcpStatus.mockResolvedValueOnce({
      endpoint: "http://127.0.0.1:1420/mcp",
      bearerToken: "session-token",
    });
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() =>
      expect(eventMocks.listeners.has("menu://show-integrations")).toBe(true),
    );

    act(() => {
      eventMocks.listeners.get("menu://show-integrations")?.({ payload: undefined });
    });

    expect(screen.getByRole("dialog", { name: "Integrations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy browser endpoint" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy Claude bridge endpoint" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ide ~/.codex/config.toml")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copy Codex MCP endpoint" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Codex MCP token" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Codex MCP config" })).toBeInTheDocument();
  });

  it("shows searchable key bindings from the native View menu", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() =>
      expect(eventMocks.listeners.has("menu://show-key-bindings")).toBe(true),
    );

    act(() => {
      eventMocks.listeners.get("menu://show-key-bindings")?.({ payload: undefined });
    });

    expect(screen.getByRole("dialog", { name: "Key Bindings" })).toBeInTheDocument();
    expect(screen.getByText("Save All")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+S")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search key bindings"), {
      target: { value: "definition" },
    });

    expect(screen.getByText("Go to Definition")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+B")).toBeInTheDocument();
    expect(screen.queryByText("Save All")).not.toBeInTheDocument();
  });

  it("shows app details from the native About menu", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.getAppInfo.mockResolvedValueOnce({
      name: "ide Test",
      version: "9.8.7",
      description: "Metadata-backed app details.",
      authors: ["Gordon Beeming"],
      repository: "https://example.com/ide-test/",
    });
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() =>
      expect(eventMocks.listeners.has("menu://show-about")).toBe(true),
    );

    act(() => {
      eventMocks.listeners.get("menu://show-about")?.({ payload: undefined });
    });

    const dialog = screen.getByRole("dialog", { name: "ide Test" });
    expect(dialog).toHaveTextContent("Version 9.8.7");
    expect(dialog).toHaveTextContent("Metadata-backed app details.");
    expect(
      within(dialog).getByRole("link", { name: /example.com\/ide-test/i }),
    ).toHaveAttribute("href", "https://example.com/ide-test/");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "ide Test" })).not.toBeInTheDocument();
  });

  it("closes filter and search via their icons without the blur race reopening them", async () => {
    render(<App />);
    await treeButton("README.md");
    // In a real browser, mousedown on the icon blurs the focused empty input,
    // whose onBlur clears the mode before the click toggles — reopening the
    // panel it was meant to close. The guard is preventDefault on the icons'
    // mousedown, which keeps the input focused through the click so onBlur
    // never pre-clears the mode. jsdom can't replay that race (it doesn't
    // move focus on mousedown), and dispatching ANY synthetic mousedown here
    // corrupts selection bookkeeping for later editor-selection tests — so
    // this test pins the user-visible contract only: the icon click closes
    // the focused panel and it stays closed.
    for (const title of ["Filter files", "Search contents"]) {
      fireEvent.click(screen.getByTitle(title));
      const input = await screen.findByPlaceholderText(title);
      expect(input).toHaveFocus();

      fireEvent.click(screen.getByTitle(title));
      await waitFor(() =>
        expect(screen.queryByPlaceholderText(title)).not.toBeInTheDocument(),
      );
      expect(await treeButton("README.md")).toBeInTheDocument();
    }
  });

  it("keeps search fields collapsed until the search controls are used", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Filter files")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search contents")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Find in file")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Filter files"));
    const filterInput = await screen.findByPlaceholderText("Filter files");
    expect(filterInput).toHaveFocus();
    fireEvent.change(filterInput, { target: { value: "App" } });
    expect(await treeButton("App.tsx")).toBeInTheDocument();
    fireEvent.keyDown(filterInput, { key: "Escape" });
    await waitFor(() => expect(filterInput).toHaveValue(""));
    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.keyDown(filterInput, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Filter files")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTitle("Search contents"));
    const contentInput = await screen.findByPlaceholderText("Search contents");
    expect(contentInput).toHaveFocus();
    fireEvent.change(contentInput, { target: { value: "readme" } });
    fireEvent.keyDown(contentInput, { key: "Escape" });
    await waitFor(() => expect(contentInput).toHaveValue(""));
    fireEvent.keyDown(contentInput, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search contents")).not.toBeInTheDocument(),
    );

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.click(screen.getByTitle("Find in file"));
    const findInput = await screen.findByPlaceholderText("Find in file");
    expect(findInput).toHaveFocus();
    fireEvent.change(findInput, { target: { value: "read" } });
    fireEvent.keyDown(findInput, { key: "Escape" });
    await waitFor(() => expect(findInput).toHaveValue(""));
    fireEvent.keyDown(findInput, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Find in file")).not.toBeInTheDocument(),
    );
  });

  it("drives find and replace in the active file from the keyboard", async () => {
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") return "needle one\nsecond needle\nthird needle";
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");

    // Cmd/Ctrl+F opens the app's Find in File even while the editor has focus,
    // rather than CodeMirror's own search panel.
    const editor = await screen.findByLabelText("Editor README.md");
    fireEvent.keyDown(editor, { key: "f", ctrlKey: true });
    const findInput = await screen.findByPlaceholderText("Find in file");
    fireEvent.change(findInput, { target: { value: "needle" } });

    // Arrow keys step through matches and reveal each one in the editor.
    fireEvent.keyDown(findInput, { key: "ArrowDown" });
    expect(await screen.findByText("Reveal line 1")).toBeInTheDocument();
    fireEvent.keyDown(findInput, { key: "ArrowDown" });
    expect(await screen.findByText("Reveal line 2")).toBeInTheDocument();
    fireEvent.keyDown(findInput, { key: "ArrowUp" });
    expect(await screen.findByText("Reveal line 1")).toBeInTheDocument();

    // Cmd/Ctrl+R reveals the replace field; Replace All emits the editor command.
    fireEvent.keyDown(findInput, { key: "r", ctrlKey: true });
    const replaceInput = await screen.findByPlaceholderText("Replace with");
    fireEvent.change(replaceInput, { target: { value: "pin" } });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(await screen.findByTestId("editor-command")).toHaveTextContent(
      /replaceAll:/,
    );
  });

  it("marks an external symlink and prompts for trust before following it", async () => {
    tauriMocks.listFiles.mockResolvedValue([
      ...files,
      {
        path: "ext-link",
        name: "ext-link",
        isDir: false,
        depth: 0,
        size: 0,
        isSymlink: true,
        isExternal: true,
        symlinkTarget: "/outside/secret.txt",
      },
    ]);
    tauriMocks.readFile.mockImplementation(
      async (path: string, _maxBytes?: number, allowExternal?: boolean) => {
        if (path === "ext-link") {
          if (!allowExternal) {
            throw new Error("symbolic link points outside the workspace");
          }
          return "external contents";
        }
        if (path === "README.md") return "readme";
        return "";
      },
    );
    render(<App />);

    const link = await treeButton("ext-link");
    // The external symlink is visually marked.
    expect(within(link).getByTestId("tree-symlink-external")).toBeInTheDocument();

    // Opening it surfaces the trust prompt naming the target, not the file.
    fireEvent.click(link);
    const dialog = await screen.findByRole("alertdialog", {
      name: "Follow link outside the workspace?",
    });
    expect(within(dialog).getByText("/outside/secret.txt")).toBeInTheDocument();
    expect(screen.queryByLabelText("Editor ext-link")).not.toBeInTheDocument();

    // Trust once follows the link for the session.
    fireEvent.click(within(dialog).getByRole("button", { name: "Trust once" }));
    expect(await screen.findByLabelText("Editor ext-link")).toHaveValue(
      "external contents",
    );
    await waitFor(() =>
      expect(tauriMocks.readFile).toHaveBeenCalledWith(
        "ext-link",
        expect.any(Number),
        true,
      ),
    );
  });

  it("keeps file filtering and content search as separate sidebar modes", async () => {
    tauriMocks.searchFiles.mockResolvedValueOnce([
      {
        path: "src/App.tsx",
        lineNumber: 4,
        lineText: "const needle = true;",
        matchStart: 6,
        matchEnd: 12,
      },
    ]);
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Filter files"));
    const filterInput = await screen.findByPlaceholderText("Filter files");
    fireEvent.change(filterInput, { target: { value: "App" } });
    expect(await treeButton("App.tsx")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Search contents"));
    expect(screen.queryByPlaceholderText("Filter files")).not.toBeInTheDocument();
    const contentInput = await screen.findByPlaceholderText("Search contents");
    fireEvent.change(contentInput, { target: { value: "needle" } });
    expect(await screen.findByText("src/App.tsx:4")).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace files")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Search contents"));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search contents")).not.toBeInTheDocument(),
    );
    expect(await screen.findByLabelText("Workspace files")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Search contents"));
    expect(await screen.findByPlaceholderText("Search contents")).toHaveValue("needle");
    expect(screen.queryByPlaceholderText("Filter files")).not.toBeInTheDocument();
    expect(await screen.findByText("src/App.tsx:4")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Filter files"));
    expect(await screen.findByPlaceholderText("Filter files")).toHaveValue("App");
    expect(screen.queryByPlaceholderText("Search contents")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Workspace files")).toBeInTheDocument();
  });

  it("opens quick open and search fields from the native Search menu", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() => expect(eventMocks.listeners.has("menu://quick-open")).toBe(true));
    await waitFor(() =>
      expect(eventMocks.listeners.has("menu://find-in-files")).toBe(true),
    );

    act(() => {
      eventMocks.listeners.get("menu://quick-open")?.({ payload: undefined });
    });
    expect(screen.getByRole("dialog", { name: "Quick open" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText("Open file"), { key: "Escape" });

    act(() => {
      eventMocks.listeners.get("menu://find-in-files")?.({ payload: undefined });
    });
    expect(await screen.findByPlaceholderText("Search contents")).toHaveFocus();
    expect(screen.queryByLabelText("Workspace files")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByPlaceholderText("Search contents"), { key: "Escape" });
    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    await waitFor(() => expect(eventMocks.listeners.has("menu://find-in-file")).toBe(true));
    act(() => {
      eventMocks.listeners.get("menu://find-in-file")?.({ payload: undefined });
    });
    expect(await screen.findByPlaceholderText("Find in file")).toHaveFocus();

    act(() => {
      eventMocks.listeners.get("menu://go-to-line")?.({ payload: undefined });
    });
    expect(screen.getByRole("dialog", { name: "Go to line" })).toBeInTheDocument();
  });

  it("opens indexed quick-open results that are not loaded in the tree", async () => {
    const indexedFile: FileEntry = {
      path: "deep/Nested.ts",
      name: "Nested.ts",
      parent: "deep",
      isDir: false,
      depth: 1,
      size: 42,
      modifiedMs: 303,
    };
    tauriMocks.searchIndexedFiles.mockImplementation(async (query: string) =>
      query === "nested" ? [indexedFile] : [],
    );
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "deep/Nested.ts") return "export const nested = true;";
      if (path === "README.md") return "readme";
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "n", ctrlKey: true, shiftKey: true });
    const input = await screen.findByPlaceholderText("Open file");
    fireEvent.change(input, { target: { value: "nested" } });

    await waitFor(() =>
      expect(tauriMocks.searchIndexedFiles).toHaveBeenCalledWith(
        "nested",
        12,
        false,
        false,
        false,
      ),
    );
    expect(await screen.findByText("deep/Nested.ts")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByLabelText("Editor deep/Nested.ts")).toHaveValue(
      "export const nested = true;",
    );
  });

  it("surfaces indexed quick-open failures", async () => {
    tauriMocks.searchIndexedFiles.mockRejectedValue(new Error("index unavailable"));
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "n", ctrlKey: true, shiftKey: true });
    const input = await screen.findByPlaceholderText("Open file");
    fireEvent.change(input, { target: { value: "needle" } });

    expect(
      await screen.findByText("Indexed file search failed: Error: index unavailable"),
    ).toBeInTheDocument();
    expect(await screen.findByText("File search failed")).toBeInTheDocument();
  });

  it("reports when native Find in File is used without an active file", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() => expect(eventMocks.listeners.has("menu://find-in-file")).toBe(true));

    act(() => {
      eventMocks.listeners.get("menu://find-in-file")?.({ payload: undefined });
    });

    expect(await screen.findByText("Find in file requires an open file")).toBeInTheDocument();
  });

  it("opens workspace content search from the keyboard", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "f", ctrlKey: true, shiftKey: true });

    expect(await screen.findByPlaceholderText("Search contents")).toHaveFocus();
  });

  it("zooms the editor and app from keyboard shortcuts", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    const shell = document.querySelector(".app-shell") as HTMLElement;
    expect(shell.style.getPropertyValue("--editor-font-size")).toBe("13px");

    fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    expect(await screen.findByText("Editor font size 14px")).toBeInTheDocument();
    expect(shell.style.getPropertyValue("--editor-font-size")).toBe("14px");

    fireEvent.keyDown(window, { key: "+", ctrlKey: true, shiftKey: true });
    expect(await screen.findByText("App zoom 110%")).toBeInTheDocument();
    expect(
      (document.querySelector(".app-shell") as HTMLElement).style.getPropertyValue("--app-zoom"),
    ).toBe("1.1");
    expect(
      (document.querySelector(".app-shell") as HTMLElement).style.getPropertyValue(
        "--app-zoom-inverse",
      ),
    ).toBe(String(100 / 110));

    for (let index = 0; index < 10; index += 1) {
      fireEvent.keyDown(window, { key: "-", ctrlKey: true, shiftKey: true });
    }
    expect(await screen.findByText("App zoom 10%")).toBeInTheDocument();
    expect(shell.style.getPropertyValue("--app-zoom")).toBe("0.1");
    expect(shell.style.getPropertyValue("--app-zoom-inverse")).toBe(String(100 / 10));

    for (let index = 0; index < 20; index += 1) {
      fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    }
    expect(await screen.findByText("Editor font size 34px")).toBeInTheDocument();
    expect(shell.style.getPropertyValue("--editor-font-size")).toBe("34px");

    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenCalledWith(
        expect.objectContaining({
          editorFontSize: 34,
          appZoomPercent: 10,
        }),
        expect.any(Object),
      ),
    );
  });

  it("resizes the sidebar and persists the workspace width", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    const shell = document.querySelector(".app-shell") as HTMLElement;
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("288px");

    const resizer = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(resizer).toHaveAttribute("aria-valuemax", "1040");

    fireEvent.keyDown(resizer, {
      key: "ArrowRight",
    });

    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("304px");
    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ sidebarWidth: 304 }),
      ),
    );
  });

  it("opens the new file dialog from the IntelliJ new shortcut", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Insert", ctrlKey: true, altKey: true });

    expect(screen.getByRole("dialog", { name: "New file" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getByTitle("New folder"));

    expect(screen.getByRole("dialog", { name: "New folder" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "New file" })).not.toBeInTheDocument();
  });

  it("matches macOS Option-key IntelliJ shortcuts by physical key code", async () => {
    const macNavigator = Object.create(navigator) as Navigator;
    Object.defineProperty(macNavigator, "platform", { value: "MacIntel" });
    Object.defineProperty(macNavigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)",
    });
    vi.stubGlobal("navigator", macNavigator);

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();

    fireEvent.keyDown(window, {
      key: "ø",
      code: "KeyN",
      ctrlKey: true,
      altKey: true,
    });

    expect(screen.getByRole("dialog", { name: "New file" })).toBeInTheDocument();
  });

  it("keeps native picker toolbar actions disabled in hosted browser mode", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();

    expect(screen.getByTitle("Open folder")).toBeDisabled();
    expect(screen.getByTitle("Open file")).toBeDisabled();
  });

  it("opens a native file picker result from the toolbar", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mockPickedNotesFile();

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Open file"));

    expect(await screen.findByLabelText("Editor notes.md")).toHaveValue("# Notes");
    expect(tauriMocks.pickOpenFile).toHaveBeenCalledTimes(1);
    expect(tauriMocks.setWorkspaceRootPath).toHaveBeenCalledWith(
      "/Users/gordonbeeming/Developer",
    );
    expect(tauriMocks.recordRecentFile).toHaveBeenCalledWith("notes.md", true);
  });

  it("keeps the old file-picker shortcut unbound", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mockPickedNotesFile();

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "o", metaKey: true });

    expect(tauriMocks.pickOpenFile).not.toHaveBeenCalled();
  });

  it("opens a native workspace folder from the toolbar", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.getWorkspaceRoot.mockReset();
    tauriMocks.getWorkspaceRoot
      .mockResolvedValueOnce("/workspace")
      .mockResolvedValue("/workspace-next");
    tauriMocks.listFiles.mockReset();
    tauriMocks.listFiles
      .mockResolvedValueOnce(files)
      .mockResolvedValueOnce([
        {
          path: "next.md",
          name: "next.md",
          isDir: false,
          depth: 0,
          size: 20,
          modifiedMs: 909,
        },
      ]);
    tauriMocks.pickWorkspaceFolder.mockResolvedValueOnce("/workspace-next");
    tauriMocks.getWorkspaceDisplayContext.mockReset();
    tauriMocks.getWorkspaceDisplayContext
      .mockResolvedValueOnce({
        appTitle: "ide - workspace",
        workspaceLabel: "workspace",
        fullLabel: "workspace",
      })
      .mockResolvedValue({
        appTitle: "ide - workspace-next",
        workspaceLabel: "workspace-next",
        fullLabel: "workspace-next",
      });

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Open folder"));

    expect(await treeButton("next.md")).toBeInTheDocument();
    await waitFor(() =>
      expect(appWindowMocks.setNativeWindowTitle).toHaveBeenLastCalledWith(
        "ide - workspace-next",
      ),
    );
    expect(document.title).toBe("ide - workspace-next");
    expect(screen.getByText("Opened workspace-next")).toBeInTheDocument();
  });

  it("opens the command palette from the keyboard and runs commands", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "a", ctrlKey: true, shiftKey: true });

    const palette = screen.getByRole("dialog", { name: "Command palette" });
    const input = within(palette).getByPlaceholderText("Run command");
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "workspace" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByRole("dialog", { name: "Command palette" }))
      .not.toBeInTheDocument();
    expect(await screen.findByPlaceholderText("Search contents")).toHaveFocus();
  });

  it("opens the command palette from the native menu", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() =>
      expect(eventMocks.listeners.has("menu://command-palette")).toBe(true),
    );

    act(() => {
      eventMocks.listeners.get("menu://command-palette")?.({ payload: undefined });
    });

    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("opens a native file picker result from the command palette", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mockPickedNotesFile();

    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "a", ctrlKey: true, shiftKey: true });

    const palette = screen.getByRole("dialog", { name: "Command palette" });
    const input = within(palette).getByPlaceholderText("Run command");
    fireEvent.change(input, { target: { value: "file picker" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByLabelText("Editor notes.md")).toHaveValue("# Notes");
    expect(tauriMocks.pickOpenFile).toHaveBeenCalledTimes(1);
    expect(tauriMocks.setWorkspaceRootPath).toHaveBeenCalledWith(
      "/Users/gordonbeeming/Developer",
    );
    expect(tauriMocks.recordRecentFile).toHaveBeenCalledWith("notes.md", true);
    expect(screen.queryByRole("dialog", { name: "Command palette" }))
      .not.toBeInTheDocument();
  });

  it("keeps unavailable command palette actions disabled", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "a", ctrlKey: true, shiftKey: true });

    const palette = screen.getByRole("dialog", { name: "Command palette" });
    const input = within(palette).getByPlaceholderText("Run command");
    fireEvent.change(input, { target: { value: "current file search" } });

    expect(
      within(palette).getByRole("button", {
        name: /Find in File\s*Search inside the active file/,
      }),
    ).toBeDisabled();

    fireEvent.change(input, { target: { value: "line number" } });
    expect(
      within(palette).getByRole("button", {
        name: /Go to Line\s*Jump within the active file/,
      }),
    ).toBeDisabled();
  });

  it("opens go to line from the keyboard and reveals the requested line", async () => {
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") return "one\ntwo\nthree\nfour\nfive";
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");

    fireEvent.keyDown(window, { key: "g", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Go to line" });
    const input = within(dialog).getByLabelText("Line number");

    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.submit(dialog);

    expect(screen.queryByRole("dialog", { name: "Go to line" }))
      .not.toBeInTheDocument();
    expect(await screen.findByText("Reveal line 4")).toBeInTheDocument();
    expect(screen.getByText("Moved to README.md:4")).toBeInTheDocument();
    expect(screen.getByText("4:1")).toBeInTheDocument();
  });

  it("validates go to line input and clamps lines past the end of the file", async () => {
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") return "one\ntwo\nthree";
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.keyDown(window, { key: "g", ctrlKey: true });

    let dialog = screen.getByRole("dialog", { name: "Go to line" });
    let input = within(dialog).getByLabelText("Line number");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.submit(dialog);

    expect(await screen.findByText("Line number must be a positive whole number."))
      .toBeInTheDocument();
    expect(screen.getByText("Go to line failed")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Go to line" })).toBeInTheDocument();

    dialog = screen.getByRole("dialog", { name: "Go to line" });
    input = within(dialog).getByLabelText("Line number");
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.submit(dialog);

    expect(screen.getByText("Reveal line 3")).toBeInTheDocument();
    expect(screen.getByText("Moved to README.md:3")).toBeInTheDocument();
  });

  it("disables save toolbar actions until there are unsaved edits", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    expect(screen.getByTitle("Save")).toBeDisabled();
    expect(screen.getByTitle("Save all")).toBeDisabled();

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    expect(screen.getByTitle("Save")).toBeDisabled();
    expect(screen.getByTitle("Save all")).toBeDisabled();

    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    expect(screen.getByTitle("Save")).toBeEnabled();
    expect(screen.getByTitle("Save all")).toBeEnabled();
  });

  it("does not write a clean active file when Save All is triggered from the keyboard", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
    expect(await screen.findByText("No unsaved files")).toBeInTheDocument();
  });

  it("keeps preview tabs temporary until the file is edited", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    const readmeTab = await findTab("README.md");
    expect(readmeTab).toHaveClass("tab--temp");
    expect(tauriMocks.recordRecentFile).toHaveBeenCalledWith("README.md", false);

    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    expect(tabButton("README.md")).not.toHaveClass("tab--temp");
    expect(tabButton("README.md")).toHaveTextContent("README.md");
  });

  it("replaces a clean preview tab when another file is single-clicked", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");

    fireEvent.click(await treeButton("src"));
    fireEvent.click(await treeButton("App.tsx"));

    await findTab("src/App.tsx");
    expect(tabButton("README.md")).toBeUndefined();
  });

  it("closes a clean tab when it is middle-clicked", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    const tab = await findTab("README.md");

    fireEvent(
      tab,
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );

    await waitFor(() => expect(tabButton("README.md")).toBeUndefined());
  });

  it("prompts before middle-click closes a dirty tab", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    const tab = await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    fireEvent(
      tab,
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );

    expect(
      await screen.findByRole("alertdialog", { name: "Close modified file?" }),
    ).toHaveTextContent("README.md has edits that have not been saved.");
    expect(tabButton("README.md")).toBeTruthy();
    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
  });

  it("blocks global file shortcuts while a dirty close confirmation is open", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    const tab = await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    fireEvent(
      tab,
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );

    const dialog = await screen.findByRole("alertdialog", {
      name: "Close modified file?",
    });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
    expect(tabButton("README.md")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "Close modified file?" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("blocks native menu actions while a dirty close confirmation is open", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    await waitFor(() => expect(eventMocks.listeners.has("menu://close-tab")).toBe(true));
    await waitFor(() => expect(eventMocks.listeners.has("menu://save-file")).toBe(true));
    await waitFor(() => expect(eventMocks.listeners.has("menu://new-file")).toBe(true));

    act(() => {
      eventMocks.listeners.get("menu://close-tab")?.({ payload: undefined });
    });

    const dialog = await screen.findByRole("alertdialog", {
      name: "Close modified file?",
    });

    act(() => {
      eventMocks.listeners.get("menu://save-file")?.({ payload: undefined });
      eventMocks.listeners.get("menu://new-file")?.({ payload: undefined });
    });

    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "New file" })).not.toBeInTheDocument();
    expect(await screen.findByText("Close the active dialog first")).toBeInTheDocument();
  });

  it("saves and closes a dirty tab from the close confirmation", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    const tab = await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    fireEvent(
      tab,
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );
    fireEvent.click(await screen.findByText("Save"));

    await waitFor(() =>
      expect(tauriMocks.writeFile).toHaveBeenCalledWith(
        "README.md",
        "changed readme",
        101,
        false,
      ),
    );
    await waitFor(() => expect(tabButton("README.md")).toBeUndefined());
    expect(
      screen.queryByRole("alertdialog", { name: "Close modified file?" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the dirty close confirmation open when save fails", async () => {
    tauriMocks.writeFile.mockRejectedValueOnce(new Error("disk full"));
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    const tab = await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    fireEvent(
      tab,
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );
    fireEvent.click(await screen.findByText("Save"));

    await screen.findByText("Error: disk full");
    expect(tabButton("README.md")).toBeTruthy();
    expect(
      screen.getByRole("alertdialog", { name: "Close modified file?" }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll(".dirty-dot")).toHaveLength(1);
  });

  it("closes the active tab from the native File menu", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    await waitFor(() => expect(eventMocks.listeners.has("menu://close-tab")).toBe(true));

    eventMocks.listeners.get("menu://close-tab")?.({ payload: undefined });

    await waitFor(() => expect(tabButton("README.md")).toBeUndefined());
    expect(screen.getByText("Open a file from the tree")).toBeInTheDocument();
  });

  it("closes all clean tabs from the native File menu", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    fireEvent.doubleClick(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.click(await treeButton("src"));
    fireEvent.doubleClick(await treeButton("App.tsx"));
    await findTab("src/App.tsx");
    await waitFor(() => expect(eventMocks.listeners.has("menu://close-all")).toBe(true));

    eventMocks.listeners.get("menu://close-all")?.({ payload: undefined });

    await waitFor(() => expect(tabButton("README.md")).toBeUndefined());
    expect(tabButton("src/App.tsx")).toBeUndefined();
    expect(screen.getByText("Closed all files")).toBeInTheDocument();
    expect(screen.getByText("Open a file from the tree")).toBeInTheDocument();
  });

  it("opens create dialogs from the native File menu", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() => expect(eventMocks.listeners.has("menu://new-file")).toBe(true));
    await waitFor(() => expect(eventMocks.listeners.has("menu://new-folder")).toBe(true));

    act(() => {
      eventMocks.listeners.get("menu://new-file")?.({ payload: undefined });
    });
    expect(screen.getByRole("dialog", { name: "New file" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));

    act(() => {
      eventMocks.listeners.get("menu://new-folder")?.({ payload: undefined });
    });
    expect(screen.getByRole("dialog", { name: "New folder" })).toBeInTheDocument();
  });

  it("saves dirty files from native File menu save actions", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });
    await waitFor(() => expect(eventMocks.listeners.has("menu://save-file")).toBe(true));
    await waitFor(() => expect(eventMocks.listeners.has("menu://save-all")).toBe(true));

    act(() => {
      eventMocks.listeners.get("menu://save-file")?.({ payload: undefined });
    });

    await waitFor(() =>
      expect(tauriMocks.writeFile).toHaveBeenCalledWith(
        "README.md",
        "changed readme",
        101,
        false,
      ),
    );

    fireEvent.change(screen.getByLabelText("Editor README.md"), {
      target: { value: "changed again" },
    });
    act(() => {
      eventMocks.listeners.get("menu://save-all")?.({ payload: undefined });
    });

    await waitFor(() =>
      expect(tauriMocks.writeFile).toHaveBeenLastCalledWith(
        "README.md",
        "changed again",
        101,
        false,
      ),
    );
  });

  it("opens reload, rename, and delete workflows from the native File menu", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });
    await waitFor(() => expect(eventMocks.listeners.has("menu://reload-file")).toBe(true));
    await waitFor(() => expect(eventMocks.listeners.has("menu://rename-selected")).toBe(true));
    await waitFor(() => expect(eventMocks.listeners.has("menu://delete-selected")).toBe(true));

    act(() => {
      eventMocks.listeners.get("menu://reload-file")?.({ payload: undefined });
    });
    expect(screen.getByRole("alertdialog", { name: "Reload file from disk?" }))
      .toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));

    act(() => {
      eventMocks.listeners.get("menu://rename-selected")?.({ payload: undefined });
    });
    expect(screen.getByRole("dialog", { name: "Rename file" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));

    act(() => {
      eventMocks.listeners.get("menu://delete-selected")?.({ payload: undefined });
    });
    expect(screen.getByRole("alertdialog", { name: "Delete file?" })).toHaveTextContent(
      "README.md will be permanently removed from the workspace.",
    );
  });

  it("passes native Navigate menu definition requests to the active editor", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    fireEvent.doubleClick(await treeButton("README.md"));
    await findTab("README.md");
    await waitFor(() =>
      expect(eventMocks.listeners.has("menu://go-to-definition")).toBe(true),
    );

    act(() => {
      eventMocks.listeners.get("menu://go-to-definition")?.({ payload: undefined });
    });

    expect(await screen.findByTestId("editor-command")).toHaveTextContent(
      "goToDefinition:1",
    );
  });

  it("passes native Navigate menu reference requests to the active editor", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    fireEvent.doubleClick(await treeButton("README.md"));
    await findTab("README.md");
    await waitFor(() =>
      expect(eventMocks.listeners.has("menu://find-references")).toBe(true),
    );

    act(() => {
      eventMocks.listeners.get("menu://find-references")?.({ payload: undefined });
    });

    expect(await screen.findByTestId("editor-command")).toHaveTextContent(
      "findReferences:1",
    );
  });

  it("does not issue native Navigate menu commands without an active file", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    await waitFor(() =>
      expect(eventMocks.listeners.has("menu://go-to-definition")).toBe(true),
    );
    act(() => {
      eventMocks.listeners.get("menu://go-to-definition")?.({ payload: undefined });
    });

    expect(screen.queryByTestId("editor-command")).not.toBeInTheDocument();
    expect(await screen.findByText("Go to definition requires an open file")).toBeInTheDocument();
  });

  it("prompts before closing all dirty tabs from the native File menu", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });
    await waitFor(() => expect(eventMocks.listeners.has("menu://close-all")).toBe(true));

    eventMocks.listeners.get("menu://close-all")?.({ payload: undefined });

    const dialog = await screen.findByRole("alertdialog", { name: "Close all files?" });
    expect(dialog).toHaveTextContent("README.md has edits that have not been saved.");
    expect(tabButton("README.md")).toBeTruthy();
    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
  });

  it("saves and closes every dirty tab from the close all confirmation", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });
    await waitFor(() => expect(eventMocks.listeners.has("menu://close-all")).toBe(true));

    eventMocks.listeners.get("menu://close-all")?.({ payload: undefined });
    const dialog = await screen.findByRole("alertdialog", { name: "Close all files?" });
    fireEvent.click(within(dialog).getByText("Save All"));

    await waitFor(() =>
      expect(tauriMocks.writeFile).toHaveBeenCalledWith(
        "README.md",
        "changed readme",
        101,
        false,
      ),
    );
    await waitFor(() => expect(tabButton("README.md")).toBeUndefined());
    expect(
      screen.queryByRole("alertdialog", { name: "Close all files?" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the close all confirmation open when save fails", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.writeFile.mockRejectedValueOnce(new Error("disk full"));
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });
    await waitFor(() => expect(eventMocks.listeners.has("menu://close-all")).toBe(true));

    eventMocks.listeners.get("menu://close-all")?.({ payload: undefined });
    const dialog = await screen.findByRole("alertdialog", { name: "Close all files?" });
    fireEvent.click(within(dialog).getByText("Save All"));

    await screen.findByText("Error: disk full");
    expect(tabButton("README.md")).toBeTruthy();
    expect(
      screen.getByRole("alertdialog", { name: "Close all files?" }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll(".dirty-dot")).toHaveLength(1);
  });

  it("switches open tabs with IntelliJ tab shortcuts", async () => {
    render(<App />);

    fireEvent.doubleClick(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.click(await treeButton("src"));
    fireEvent.doubleClick(await treeButton("App.tsx"));
    await findTab("src/App.tsx");
    expect(await screen.findByLabelText("Editor src/App.tsx")).toHaveValue(
      "export function App() {}",
    );

    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });

    expect(screen.getByLabelText("Editor README.md")).toHaveValue("readme");
    expect(tabButton("README.md")).toHaveClass("tab--active");

    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });

    expect(screen.getByLabelText("Editor src/App.tsx")).toHaveValue(
      "export function App() {}",
    );
    expect(tabButton("src/App.tsx")).toHaveClass("tab--active");
  });

  it("saves every dirty tab and clears dirty indicators", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    fireEvent.click(await treeButton("src"));
    fireEvent.click(await treeButton("App.tsx"));
    await findTab("src/App.tsx");
    fireEvent.change(await screen.findByLabelText("Editor src/App.tsx"), {
      target: { value: "changed app" },
    });

    fireEvent.click(screen.getByTitle("Save all"));

    await waitFor(() => expect(tauriMocks.writeFile).toHaveBeenCalledTimes(2));
    expect(tauriMocks.writeFile).toHaveBeenCalledWith(
      "README.md",
      "changed readme",
      101,
      false,
    );
    expect(tauriMocks.writeFile).toHaveBeenCalledWith(
      "src/App.tsx",
      "changed app",
      202,
      false,
    );
    await waitFor(() => expect(document.querySelectorAll(".dirty-dot")).toHaveLength(0));
    expect(screen.getByText("Saved 2 unsaved files")).toBeInTheDocument();
  });

  it("keeps a stale file dirty when save detects external changes", async () => {
    tauriMocks.writeFile.mockRejectedValueOnce(
      new Error("file changed on disk since it was opened"),
    );
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    fireEvent.click(screen.getByTitle("Save"));

    await screen.findByText("Error: file changed on disk since it was opened");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Error: file changed on disk since it was opened",
    );
    expect(tauriMocks.writeFile).toHaveBeenCalledWith(
      "README.md",
      "changed readme",
      101,
      false,
    );
    expect(document.querySelectorAll(".dirty-dot")).toHaveLength(1);
    expect(screen.getByText("Save failed")).toBeInTheDocument();
  });

  it("saves with fresh metadata after opening a file from a stale tree entry", async () => {
    const openOrder: string[] = [];
    tauriMocks.statFile.mockImplementation(async (path: string) => {
      const entry = files.find((candidate) => candidate.path === path);
      if (!entry) throw new Error(`missing ${path}`);
      if (path === "README.md") openOrder.push("stat");
      return path === "README.md" ? { ...entry, modifiedMs: 303 } : entry;
    });
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") {
        openOrder.push("read");
        return "readme";
      }
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    expect(openOrder).toEqual(["stat", "read"]);
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    fireEvent.click(screen.getByTitle("Save"));

    await waitFor(() =>
      expect(tauriMocks.writeFile).toHaveBeenCalledWith(
        "README.md",
        "changed readme",
        303,
        false,
      ),
    );
  });

  it("reloads a clean active file from disk", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    expect(await screen.findByLabelText("Editor README.md")).toHaveValue("readme");

    tauriMocks.readFile.mockResolvedValueOnce("disk readme");
    tauriMocks.listFiles.mockResolvedValueOnce([
      ...files.filter((file) => file.path !== "README.md"),
      {
        path: "README.md",
        name: "README.md",
        isDir: false,
        depth: 0,
        size: 24,
        modifiedMs: 303,
      },
    ]);
    fireEvent.click(screen.getByTitle("Reload from disk"));

    await waitFor(() =>
      expect(screen.getByLabelText("Editor README.md")).toHaveValue("disk readme"),
    );
    expect(document.querySelectorAll(".dirty-dot")).toHaveLength(0);
    expect(screen.getByText("Reloaded README.md")).toBeInTheDocument();
  });

  it("reloads a clean open tab from disk when the tab is refocused", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    expect(await screen.findByLabelText("Editor README.md")).toHaveValue("readme");

    tauriMocks.statFile.mockImplementation(async (path: string) => {
      const entry = files.find((candidate) => candidate.path === path);
      if (!entry) throw new Error(`missing ${path}`);
      return path === "README.md" ? { ...entry, size: 24, modifiedMs: 303 } : entry;
    });
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") return "disk readme";
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });

    fireEvent.click(tabButton("README.md")!);

    await waitFor(() =>
      expect(screen.getByLabelText("Editor README.md")).toHaveValue("disk readme"),
    );
    expect(document.querySelectorAll(".dirty-dot")).toHaveLength(0);
    expect(screen.getByText("Reloaded README.md")).toBeInTheDocument();
  });

  it("prompts when a dirty open file changed on disk and allows overwrite after keeping editor changes", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });
    const readsBeforeDiskCheck = tauriMocks.readFile.mock.calls.length;
    tauriMocks.statFile.mockImplementation(async (path: string) => {
      const entry = files.find((candidate) => candidate.path === path);
      if (!entry) throw new Error(`missing ${path}`);
      return path === "README.md" ? { ...entry, size: 24, modifiedMs: 303 } : entry;
    });

    window.dispatchEvent(new Event("focus"));

    const dialog = await screen.findByRole("alertdialog", {
      name: "Reload file from disk?",
    });
    expect(dialog).toHaveTextContent(
      "README.md has unsaved edits, and the file changed on disk.",
    );
    expect(tauriMocks.readFile).toHaveBeenCalledTimes(readsBeforeDiskCheck);
    expect(screen.getByLabelText("Editor README.md")).toHaveValue("changed readme");

    fireEvent.click(within(dialog).getByText("Keep Mine"));
    fireEvent.click(screen.getByTitle("Save"));

    await waitFor(() =>
      expect(tauriMocks.writeFile).toHaveBeenCalledWith(
        "README.md",
        "changed readme",
        303,
        false,
      ),
    );
  });

  it("does not prompt for external reload while saving the same file", async () => {
    let finishWrite: () => void = () => undefined;
    const writePromise = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    tauriMocks.writeFile.mockReturnValueOnce(writePromise);
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    fireEvent.click(screen.getByTitle("Save"));
    await waitFor(() => expect(tauriMocks.writeFile).toHaveBeenCalledTimes(1));

    tauriMocks.statFile.mockImplementation(async (path: string) => {
      const entry = files.find((candidate) => candidate.path === path);
      if (!entry) throw new Error(`missing ${path}`);
      return path === "README.md" ? { ...entry, size: 24, modifiedMs: 303 } : entry;
    });

    window.dispatchEvent(new Event("focus"));
    expect(
      screen.queryByRole("alertdialog", { name: "Reload file from disk?" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      finishWrite();
      await writePromise;
    });

    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
  });

  it("updates a clean open file from disk while it stays open", async () => {
    render(<App />);

    const readmeButton = await treeButton("README.md");
    vi.useFakeTimers();

    fireEvent.click(readmeButton);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Editor README.md")).toHaveValue("readme");

    tauriMocks.statFile.mockImplementation(async (path: string) => {
      const entry = files.find((candidate) => candidate.path === path);
      if (!entry) throw new Error(`missing ${path}`);
      return path === "README.md" ? { ...entry, size: 32, modifiedMs: 404 } : entry;
    });
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") return "background disk readme";
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(screen.getByLabelText("Editor README.md")).toHaveValue(
        "background disk readme",
      ),
    );
    expect(screen.getByText("Updated README.md from disk")).toBeInTheDocument();
  });

  it("reloads a clean active file from the keyboard", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    expect(await screen.findByLabelText("Editor README.md")).toHaveValue("readme");

    tauriMocks.readFile.mockResolvedValueOnce("keyboard disk readme");
    tauriMocks.listFiles.mockResolvedValueOnce([
      ...files.filter((file) => file.path !== "README.md"),
      {
        path: "README.md",
        name: "README.md",
        isDir: false,
        depth: 0,
        size: 33,
        modifiedMs: 304,
      },
    ]);
    fireEvent.keyDown(window, { key: "y", ctrlKey: true, altKey: true });

    await waitFor(() =>
      expect(screen.getByLabelText("Editor README.md")).toHaveValue(
        "keyboard disk readme",
      ),
    );
    expect(screen.getByText("Reloaded README.md")).toBeInTheDocument();
  });

  it("reports keyboard reload attempts without an active file", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "y", ctrlKey: true, altKey: true });

    expect(screen.getByText("Reload from disk requires an open file")).toBeInTheDocument();
    expect(tauriMocks.readFile).not.toHaveBeenCalled();
  });

  it("confirms before reloading a dirty active file from disk", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    fireEvent.click(screen.getByTitle("Reload from disk"));

    expect(screen.getByRole("alertdialog", { name: "Reload file from disk?" }))
      .toHaveTextContent(
        "README.md has edits that will be discarded and replaced with the current disk contents.",
      );
    expect(screen.getByLabelText("Editor README.md")).toHaveValue("changed readme");

    tauriMocks.readFile.mockResolvedValueOnce("disk readme");
    fireEvent.click(screen.getByText("Reload"));

    await waitFor(() =>
      expect(screen.getByLabelText("Editor README.md")).toHaveValue("disk readme"),
    );
    expect(screen.queryByRole("alertdialog", { name: "Reload file from disk?" }))
      .not.toBeInTheDocument();
    expect(document.querySelectorAll(".dirty-dot")).toHaveLength(0);
    expect(screen.getByText("Reloaded README.md")).toBeInTheDocument();
  });

  it("surfaces Save All failures and stops saving later dirty tabs", async () => {
    tauriMocks.writeFile.mockRejectedValueOnce(new Error("disk full"));
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

    fireEvent.click(await treeButton("src"));
    fireEvent.click(await treeButton("App.tsx"));
    await findTab("src/App.tsx");
    fireEvent.change(await screen.findByLabelText("Editor src/App.tsx"), {
      target: { value: "changed app" },
    });

    fireEvent.click(screen.getByTitle("Save all"));

    await screen.findByText("Error: disk full");
    expect(tauriMocks.writeFile).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    expect(document.querySelectorAll(".dirty-dot")).toHaveLength(2);
  });

  it("does not send stale selections from inactive files to agent context", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    const readmeEditor = await screen.findByLabelText("Editor README.md");
    fireEvent.select(readmeEditor);

    await waitFor(() => expect(latestAgentContext()?.selection?.filePath).toBe("README.md"));

    fireEvent.click(await treeButton("src"));
    fireEvent.click(await treeButton("App.tsx"));

    await waitFor(() =>
      expect(latestAgentContext()).toMatchObject({
        activeFile: "src/App.tsx",
        selection: undefined,
      }),
    );
  });

  it("shows caret position in the status bar without sending empty selection context", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    const editor = await screen.findByLabelText("Editor README.md");
    fireEvent.focus(editor);

    expect(screen.getByText("1:1")).toBeInTheDocument();
    await waitFor(() =>
      expect(latestAgentContext()).toMatchObject({
        activeFile: "README.md",
        selection: undefined,
      }),
    );
  });

  it("keeps diagnostics panel hidden by default while publishing diagnostics to agent context", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() => expect(lspMocks.diagnosticsHandler).toBeTypeOf("function"));

    act(() => {
      lspMocks.diagnosticsHandler?.("src/App.tsx", [
        diagnostic("src/App.tsx", "Expected semicolon", 1, 7, 13),
      ]);
    });

    expect(screen.queryByLabelText("Diagnostics")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Error at src/App.tsx:7:13: Expected semicolon",
      }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(latestAgentContext()).toMatchObject({
        diagnostics: [
          expect.objectContaining({
            filePath: "src/App.tsx",
            message: "Expected semicolon",
          }),
        ],
      }),
    );
  });

  it("opens diagnostics at the precise reported location", async () => {
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
        showDiagnosticsPanel: true,
      },
      workspace: {
        expandedFolders: [],
        openFiles: [],
      },
    });
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() => expect(lspMocks.diagnosticsHandler).toBeTypeOf("function"));

    act(() => {
      lspMocks.diagnosticsHandler?.("src/App.tsx", [
        diagnostic("src/App.tsx", "Expected semicolon", 1, 7, 13),
      ]);
    });

    const row = await screen.findByRole("button", {
      name: "Error at src/App.tsx:7:13: Expected semicolon",
    });
    expect(row).toHaveTextContent("src/App.tsx:7:13");

    fireEvent.click(row);

    expect(await screen.findByLabelText("Editor src/App.tsx")).toHaveValue(
      "export function App() {}",
    );
    expect(screen.getByText("Reveal line 7")).toBeInTheDocument();
    expect(tabButton("src/App.tsx")).toHaveClass("tab--temp");
  });

  it("pins diagnostic tabs when opened with a double click", async () => {
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
        showDiagnosticsPanel: true,
      },
      workspace: {
        expandedFolders: [],
        openFiles: [],
      },
    });
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await waitFor(() => expect(lspMocks.diagnosticsHandler).toBeTypeOf("function"));

    act(() => {
      lspMocks.diagnosticsHandler?.("src/App.tsx", [
        diagnostic("src/App.tsx", "React component is unused", 2, 4, 1),
      ]);
    });

    const row = await screen.findByRole("button", {
      name: "Warning at src/App.tsx:4:1: React component is unused",
    });
    fireEvent.doubleClick(row);

    expect(await screen.findByLabelText("Editor src/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("Reveal line 4")).toBeInTheDocument();
    expect(tabButton("src/App.tsx")).not.toHaveClass("tab--temp");
  });

  it("cycles current-file search results with Enter and Shift+Enter", async () => {
    tauriMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "README.md") {
        return "needle one\nplain line\nneedle two\nneedle three";
      }
      if (path === "src/App.tsx") return "export function App() {}";
      return "";
    });
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    const input = await openCurrentFileFind();
    fireEvent.change(input, { target: { value: "needle" } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Reveal line 1")).toBeInTheDocument();
    expect(screen.getByText("Match 1 of 3 at README.md:1")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Reveal line 3")).toBeInTheDocument();
    expect(screen.getByText("Match 2 of 3 at README.md:3")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("Reveal line 1")).toBeInTheDocument();
    expect(screen.getByText("Match 1 of 3 at README.md:1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /line 1\s*needle one/ }),
    ).toHaveClass("current-find-result--active");
  });

  it("opens content search results at the matched line", async () => {
    tauriMocks.searchFiles.mockResolvedValueOnce([
      {
        path: "src/App.tsx",
        lineNumber: 4,
        lineText: "const needle = true;",
        matchStart: 6,
        matchEnd: 12,
      },
    ]);
    render(<App />);

    fireEvent.change(await openContentSearch(), {
      target: { value: "needle" },
    });

    await waitFor(() =>
      expect(tauriMocks.searchFiles).toHaveBeenCalledWith("needle", 200, 1024 * 1024, false),
    );
    const resultPath = await screen.findByText("src/App.tsx:4");
    expect(screen.getByLabelText("Content search results")).toHaveTextContent(
      "Results1src/App.tsx:4const needle = true;",
    );
    expect(screen.queryByLabelText("Workspace files")).not.toBeInTheDocument();
    fireEvent.click(resultPath.closest("button")!);

    await findTab("src/App.tsx");
    expect(await screen.findByText("Reveal line 4")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Search contents"));
    const tree = await screen.findByLabelText("Workspace files");
    expect(await within(tree).findByRole("treeitem", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(await within(tree).findByRole("treeitem", { name: "App.tsx" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("does not reveal content search result opens in the tree when active-file tracking is off", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    tauriMocks.searchFiles.mockResolvedValueOnce([
      {
        path: "src/App.tsx",
        lineNumber: 4,
        lineText: "const needle = true;",
        matchStart: 6,
        matchEnd: 12,
      },
    ]);
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    await openSettingsDialog();
    fireEvent.click(screen.getByLabelText("Track active file"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument(),
    );

    fireEvent.change(await openContentSearch(), {
      target: { value: "needle" },
    });
    const resultPath = await screen.findByText("src/App.tsx:4");
    fireEvent.click(resultPath.closest("button")!);
    await findTab("src/App.tsx");

    fireEvent.click(screen.getByTitle("Search contents"));
    const tree = await screen.findByLabelText("Workspace files");
    expect(await within(tree).findByRole("treeitem", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(tree).queryByRole("treeitem", { name: "App.tsx" })).not.toBeInTheDocument();
  });

  it("clears stale content search results while a new query is searching", async () => {
    tauriMocks.searchFiles
      .mockResolvedValueOnce([
        {
          path: "src/App.tsx",
          lineNumber: 4,
          lineText: "const needle = true;",
          matchStart: 6,
          matchEnd: 12,
        },
      ])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            window.setTimeout(
              () =>
                resolve([
                  {
                    path: "README.md",
                    lineNumber: 1,
                    lineText: "thread",
                    matchStart: 0,
                    matchEnd: 6,
                  },
                ]),
              250,
            ),
          ),
      );
    render(<App />);

    const input = await openContentSearch();
    fireEvent.change(input, { target: { value: "needle" } });

    expect(await screen.findByText("src/App.tsx:4")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "thread" } });

    await waitFor(() =>
      expect(screen.getByLabelText("Content search results")).toHaveTextContent(
        "Searching0",
      ),
    );
    expect(screen.queryByText("src/App.tsx:4")).not.toBeInTheDocument();

    expect(await screen.findByText("README.md:1")).toBeInTheDocument();
  });

  it("surfaces content search failures", async () => {
    tauriMocks.searchFiles.mockRejectedValueOnce(new Error("index unavailable"));
    render(<App />);

    fireEvent.change(await openContentSearch(), {
      target: { value: "needle" },
    });

    await screen.findByText("Search failed: Error: index unavailable");
    expect(tauriMocks.searchFiles).toHaveBeenCalledWith("needle", 200, 1024 * 1024, false);
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("surfaces capped workspace content search results and opens search settings", async () => {
    tauriMocks.searchFiles.mockResolvedValueOnce({
      matches: [
        {
          path: "README.md",
          lineNumber: 1,
          lineText: "needle",
          matchStart: 0,
          matchEnd: 6,
        },
      ],
      truncated: true,
      limit: 1,
      searchedFiles: 2,
      skippedFiles: 1,
    });
    render(<App />);

    fireEvent.change(await openContentSearch(), {
      target: { value: "needle" },
    });

    expect(await screen.findByText("README.md:1")).toBeInTheDocument();
    const notice = screen
      .getByText(/Showing the first 1 matches/)
      .closest(".search-results__notice");
    expect(notice).not.toBeNull();
    expect(screen.getByText("First 1 matches")).toBeInTheDocument();
    expect(screen.getByText("1 / 2 files searched, 1 skipped")).toBeInTheDocument();

    fireEvent.click(within(notice as HTMLElement).getByRole("button", { name: "Settings" }));

    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Search/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("Workspace search results")).toBeInTheDocument();
  });

  it("clears stale content search errors when a new query starts", async () => {
    tauriMocks.searchFiles
      .mockRejectedValueOnce(new Error("index unavailable"))
      .mockResolvedValueOnce([
        {
          path: "README.md",
          lineNumber: 1,
          lineText: "thread",
          matchStart: 0,
          matchEnd: 6,
        },
      ]);
    render(<App />);

    const input = await openContentSearch();
    fireEvent.change(input, { target: { value: "needle" } });

    await screen.findByText("Search failed: Error: index unavailable");

    fireEvent.change(input, { target: { value: "thread" } });

    await waitFor(() =>
      expect(
        screen.queryByText("Search failed: Error: index unavailable"),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("README.md:1")).toBeInTheDocument();
  });

  it("finds text in the active file and reveals the matched line", async () => {
    render(<App />);

    fireEvent.click(await treeButton("src"));
    fireEvent.click(await treeButton("App.tsx"));
    await findTab("src/App.tsx");
    fireEvent.change(await openCurrentFileFind(), {
      target: { value: "function" },
    });

    expect(screen.getByLabelText("Current file search results")).toHaveTextContent(
      "Find in src/App.tsx1line 1export function App() {}",
    );
    fireEvent.click(screen.getByText("line 1"));

    expect(screen.getByText("Reveal line 1")).toBeInTheDocument();
    expect(screen.getByText("Found src/App.tsx:1")).toBeInTheDocument();
  });

  it("finds unsaved text in the active file", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "draft line\nunsaved needle" },
    });
    fireEvent.change(await openCurrentFileFind(), {
      target: { value: "needle" },
    });

    expect(screen.getByLabelText("Current file search results")).toHaveTextContent(
      "Find in README.md1line 2unsaved needle",
    );
  });

  it("creates a new file in the selected folder and opens it as a pinned tab", async () => {
    render(<App />);

    fireEvent.click(await treeButton("src"));
    fireEvent.click(screen.getByTitle("New file"));
    expect(screen.getByLabelText("Path")).toHaveValue("src/untitled.txt");

    fireEvent.change(screen.getByLabelText("Path"), {
      target: { value: "src/NewFile.tsx" },
    });
    tauriMocks.listFiles.mockResolvedValueOnce([
      ...files,
      {
        path: "src/NewFile.tsx",
        name: "NewFile.tsx",
        parent: "src",
        isDir: false,
        depth: 1,
        size: 0,
        modifiedMs: 404,
      },
    ]);
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(tauriMocks.createFile).toHaveBeenCalledWith("src/NewFile.tsx", false));
    const tab = await findTab("src/NewFile.tsx");
    expect(tab).not.toHaveClass("tab--temp");
    expect(screen.getByLabelText("Editor src/NewFile.tsx")).toHaveValue("");
    expect(screen.getByText("Created src/NewFile.tsx")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Editor src/NewFile.tsx"), {
      target: { value: "export function NewFile() {}" },
    });
    fireEvent.click(screen.getByTitle("Save"));

    await waitFor(() =>
      expect(tauriMocks.writeFile).toHaveBeenCalledWith(
        "src/NewFile.tsx",
        "export function NewFile() {}",
        404,
        false,
      ),
    );
  });

  it("keeps the new-file dialog open when creation fails", async () => {
    tauriMocks.createFile.mockRejectedValueOnce(new Error("file already exists"));
    render(<App />);

    fireEvent.click(screen.getByTitle("New file"));
    fireEvent.change(await screen.findByLabelText("Path"), {
      target: { value: "README.md" },
    });
    fireEvent.click(screen.getByText("Create"));

    await screen.findByText("Error: file already exists");
    expect(screen.getByRole("dialog", { name: "New file" })).toBeInTheDocument();
    expect(screen.getByText("Create file failed")).toBeInTheDocument();
  });

  it("creates a nested new folder in the selected folder", async () => {
    render(<App />);

    fireEvent.click(await treeButton("src"));
    fireEvent.click(screen.getByTitle("New folder"));
    expect(screen.getByLabelText("Path")).toHaveValue("src/new-folder");

    fireEvent.change(screen.getByLabelText("Path"), {
      target: { value: "src/features/editor" },
    });
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() =>
      expect(tauriMocks.createFolder).toHaveBeenCalledWith("src/features/editor", false),
    );
    expect(screen.queryByRole("dialog", { name: "New folder" })).not.toBeInTheDocument();
    expect(screen.getByText("Created folder src/features/editor")).toBeInTheDocument();
  });

  it("keeps the new-folder dialog open when creation fails", async () => {
    tauriMocks.createFolder.mockRejectedValueOnce(new Error("file already exists"));
    render(<App />);

    fireEvent.click(screen.getByTitle("New folder"));
    fireEvent.change(await screen.findByLabelText("Path"), {
      target: { value: "src" },
    });
    fireEvent.click(screen.getByText("Create"));

    await screen.findByText("Error: file already exists");
    expect(screen.getByRole("dialog", { name: "New folder" })).toBeInTheDocument();
    expect(screen.getByText("Create folder failed")).toBeInTheDocument();
  });

  it("renames the selected open file and keeps the tab active", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.click(screen.getByTitle("Rename selected item"));
    expect(screen.getByLabelText("New path")).toHaveValue("README.md");

    fireEvent.change(screen.getByLabelText("New path"), {
      target: { value: "README-renamed.md" },
    });
    tauriMocks.listFiles.mockResolvedValueOnce([
      ...files.filter((file) => file.path !== "README.md"),
      {
        path: "README-renamed.md",
        name: "README-renamed.md",
        isDir: false,
        depth: 0,
        size: 20,
        modifiedMs: 505,
      },
    ]);
    fireEvent.click(screen.getByText("Rename"));

    await waitFor(() =>
      expect(tauriMocks.renameFile).toHaveBeenCalledWith(
        "README.md",
        "README-renamed.md",
        false,
      ),
    );
    const tab = await findTab("README-renamed.md");
    expect(tab).toHaveClass("tab--active");
    expect(tabButton("README.md")).toBeUndefined();
    expect(screen.getByText("Renamed README.md to README-renamed.md")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Editor README-renamed.md"), {
      target: { value: "renamed readme" },
    });
    fireEvent.click(screen.getByTitle("Save"));

    await waitFor(() =>
      expect(tauriMocks.writeFile).toHaveBeenCalledWith(
        "README-renamed.md",
        "renamed readme",
        505,
        false,
      ),
    );
  });

  it("renames a selected folder and updates open files beneath it", async () => {
    render(<App />);

    fireEvent.click(await treeButton("src"));
    fireEvent.click(await treeButton("App.tsx"));
    await findTab("src/App.tsx");
    fireEvent.click(await treeButton("src"));
    fireEvent.click(screen.getByTitle("Rename selected item"));
    expect(screen.getByRole("dialog", { name: "Rename folder" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New path"), {
      target: { value: "app" },
    });
    tauriMocks.listFiles.mockResolvedValueOnce([
      {
        path: "app",
        name: "app",
        isDir: true,
        depth: 0,
        size: 0,
      },
      {
        path: "app/App.tsx",
        name: "App.tsx",
        parent: "app",
        isDir: false,
        depth: 1,
        size: 12,
        modifiedMs: 202,
      },
      ...files.filter((file) => !file.path.startsWith("src")),
    ]);
    fireEvent.click(screen.getByText("Rename"));

    await waitFor(() => expect(tauriMocks.renameFile).toHaveBeenCalledWith("src", "app", false));
    expect(await findTab("app/App.tsx")).toHaveClass("tab--active");
    expect(tabButton("src/App.tsx")).toBeUndefined();
    expect(screen.getByLabelText("Editor app/App.tsx")).toHaveValue(
      "export function App() {}",
    );
    expect(screen.getByText("Renamed src to app")).toBeInTheDocument();
  });

  it("keeps the rename dialog open when renaming fails", async () => {
    tauriMocks.renameFile.mockRejectedValueOnce(new Error("file already exists"));
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    fireEvent.click(screen.getByTitle("Rename selected item"));
    fireEvent.change(await screen.findByLabelText("New path"), {
      target: { value: "src/App.tsx" },
    });
    fireEvent.click(screen.getByText("Rename"));

    await screen.findByText("Error: file already exists");
    expect(screen.getByRole("dialog", { name: "Rename file" })).toBeInTheDocument();
    expect(screen.getByText("Rename failed")).toBeInTheDocument();
  });

  it("deletes the selected open file after confirmation and closes its tab", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.click(screen.getByTitle("Delete selected item"));
    expect(screen.getByRole("alertdialog", { name: "Delete file?" })).toHaveTextContent(
      "README.md will be permanently removed from the workspace.",
    );

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(tauriMocks.deleteFile).toHaveBeenCalledWith("README.md"));
    await waitFor(() => expect(tabButton("README.md")).toBeUndefined());
    expect(screen.getByText("Deleted README.md")).toBeInTheDocument();
  });

  it("deletes a selected folder and closes open files beneath it", async () => {
    render(<App />);

    fireEvent.click(await treeButton("src"));
    fireEvent.click(await treeButton("App.tsx"));
    await findTab("src/App.tsx");
    fireEvent.change(screen.getByLabelText("Editor src/App.tsx"), {
      target: { value: "dirty app" },
    });
    fireEvent.click(await treeButton("src"));
    fireEvent.click(screen.getByTitle("Delete selected item"));
    expect(screen.getByRole("alertdialog", { name: "Delete folder?" })).toHaveTextContent(
      "src will be permanently removed from the workspace. Any files inside this folder will also be removed. This selection also has unsaved editor changes.",
    );

    tauriMocks.listFiles.mockResolvedValueOnce(
      files.filter((file) => !file.path.startsWith("src")),
    );
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(tauriMocks.deleteFile).toHaveBeenCalledWith("src"));
    await waitFor(() => expect(tabButton("src/App.tsx")).toBeUndefined());
    expect(screen.getByText("Deleted src")).toBeInTheDocument();
  });

  it("keeps the delete confirmation open when deletion fails", async () => {
    tauriMocks.deleteFile.mockRejectedValueOnce(new Error("permission denied"));
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    fireEvent.click(screen.getByTitle("Delete selected item"));
    fireEvent.click(screen.getByText("Delete"));

    await screen.findByText("Error: permission denied");
    expect(screen.getByRole("alertdialog", { name: "Delete file?" })).toBeInTheDocument();
  });
});

describe("Git commit sidebar", () => {
  it("toggles the commit panel open and closed", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    expect(screen.queryByLabelText("Git commit panel")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Commit changes"));
    expect(await screen.findByLabelText("Git commit panel")).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace files")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Commit changes"));
    await waitFor(() =>
      expect(screen.queryByLabelText("Git commit panel")).not.toBeInTheDocument(),
    );
    expect(await treeButton("README.md")).toBeInTheDocument();
  });

  // These two override getGitStatus with a persistent mock (this describe has no
  // per-test reset, unlike "App shell interactions"), so they keep the standard
  // two-file set to stay compatible with the sibling tests that follow.
  it("shows an up-to-date indicator when level with the upstream", async () => {
    tauriMocks.getGitStatus.mockResolvedValue({
      status: "available",
      branch: "main",
      headDetached: false,
      headUnborn: false,
      files: [
        { path: "README.md", status: "modified", staged: false, unstaged: true },
        { path: "src/App.tsx", status: "modified", staged: true, unstaged: false },
      ],
      mergeInProgress: false,
      conflictedFiles: [],
      ahead: 0,
      behind: 0,
    });
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    expect(await within(panel).findByText("Up to date")).toBeInTheDocument();
  });

  it("shows ahead/behind counts against the upstream", async () => {
    tauriMocks.getGitStatus.mockResolvedValue({
      status: "available",
      branch: "main",
      headDetached: false,
      headUnborn: false,
      files: [
        { path: "README.md", status: "modified", staged: false, unstaged: true },
        { path: "src/App.tsx", status: "modified", staged: true, unstaged: false },
      ],
      mergeInProgress: false,
      conflictedFiles: [],
      ahead: 2,
      behind: 1,
    });
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    expect(await within(panel).findByLabelText("2 ahead, 1 behind")).toBeInTheDocument();
  });

  it("selects all changed files by default and supports the master tri-state checkbox", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    await waitFor(() => expect(within(panel).getByText("2 / 2")).toBeInTheDocument());
    const checkboxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes).toHaveLength(4); // master + folder(src) + 2 files
    expect(checkboxes.every((checkbox) => checkbox.checked)).toBe(true);

    fireEvent.click(within(panel).getByLabelText("Deselect all changes"));
    await waitFor(() => expect(within(panel).getByText("0 / 2")).toBeInTheDocument());
    expect(
      (within(panel).getAllByRole("checkbox") as HTMLInputElement[]).every(
        (checkbox) => !checkbox.checked,
      ),
    ).toBe(true);

    fireEvent.click(within(panel).getByLabelText("Select all changes"));
    await waitFor(() => expect(within(panel).getByText("2 / 2")).toBeInTheDocument());
  });

  it("disables the Commit button until a message and a selection both exist", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    await waitFor(() => expect(within(panel).getByText("2 / 2")).toBeInTheDocument());
    const commitButton = within(panel).getByRole("button", { name: /^Commit/ });
    expect(commitButton).toBeDisabled();

    fireEvent.change(within(panel).getByPlaceholderText("Commit message"), {
      target: { value: "Update readme" },
    });
    expect(commitButton).not.toBeDisabled();

    fireEvent.click(within(panel).getByLabelText("Deselect all changes"));
    expect(commitButton).toBeDisabled();
  });

  it("commits only the selected paths and refreshes the status afterward", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    await waitFor(() => expect(within(panel).getByText("2 / 2")).toBeInTheDocument());

    fireEvent.click(within(panel).getByLabelText("Deselect src/App.tsx"));
    await waitFor(() => expect(within(panel).getByText("1 / 2")).toBeInTheDocument());

    fireEvent.change(within(panel).getByPlaceholderText("Commit message"), {
      target: { value: "Update readme" },
    });

    tauriMocks.getGitStatus.mockResolvedValueOnce({
      status: "available",
      branch: "main",
      headDetached: false,
      headUnborn: false,
      files: [{ path: "src/App.tsx", status: "modified", staged: false, unstaged: true }],
    });

    fireEvent.click(within(panel).getByRole("button", { name: /^Commit/ }));

    await waitFor(() =>
      expect(tauriMocks.commitGitChanges).toHaveBeenCalledWith("Update readme", ["README.md"]),
    );
    await waitFor(() =>
      expect(within(panel).getByText(/Committed 1 file\(s\) as abc1234/)).toBeInTheDocument(),
    );
    // src/App.tsx had been deselected before the commit, so the refreshed list
    // (now missing the just-committed README.md) still shows it unselected.
    await waitFor(() => expect(within(panel).getByText("0 / 1")).toBeInTheDocument());
    expect(within(panel).getByPlaceholderText("Commit message")).toHaveValue("");
  });

  it("commits when Cmd/Ctrl+Enter is pressed in the message textarea", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    await waitFor(() => expect(within(panel).getByText("2 / 2")).toBeInTheDocument());

    const message = within(panel).getByPlaceholderText("Commit message");
    fireEvent.change(message, { target: { value: "Quick commit" } });
    fireEvent.keyDown(message, { key: "Enter", metaKey: true });

    await waitFor(() =>
      expect(tauriMocks.commitGitChanges).toHaveBeenCalledWith("Quick commit", [
        "README.md",
        "src/App.tsx",
      ]),
    );
  });

  it("gives a folder checkbox tri-state selection over its descendant files", async () => {
    // Queued twice: `getGitStatus` now fires once on the initial workspace
    // load (Part 2) and again on entering commit mode, both before this test
    // reads the panel — a single `mockResolvedValueOnce` would be consumed
    // by the mount call, leaving the entering-commit-mode call to fall
    // through to the describe-inherited baseline (README.md/src/App.tsx).
    const customStatus = {
      status: "available" as const,
      branch: "main",
      headDetached: false,
      headUnborn: false,
      files: [
        { path: "src/a.ts", status: "modified" as const, staged: false, unstaged: true },
        { path: "src/b.ts", status: "modified" as const, staged: false, unstaged: true },
      ],
    };
    tauriMocks.getGitStatus.mockResolvedValueOnce(customStatus);
    tauriMocks.getGitStatus.mockResolvedValueOnce(customStatus);
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    await waitFor(() => expect(within(panel).getByText("2 / 2")).toBeInTheDocument());
    const folderCheckbox = within(panel).getByLabelText(
      "Deselect folder src",
    ) as HTMLInputElement;
    expect(folderCheckbox.checked).toBe(true);

    fireEvent.click(within(panel).getByLabelText("Deselect src/a.ts"));
    await waitFor(() => expect(within(panel).getByText("1 / 2")).toBeInTheDocument());
    const partialFolderCheckbox = within(panel).getByLabelText(
      "Select folder src",
    ) as HTMLInputElement;
    expect(partialFolderCheckbox.checked).toBe(false);
    expect(partialFolderCheckbox.indeterminate).toBe(true);

    fireEvent.click(partialFolderCheckbox);
    await waitFor(() => expect(within(panel).getByText("2 / 2")).toBeInTheDocument());
  });

  it("opens a diff tab for a changed file, including deleted rows", async () => {
    // Queued twice — see the tri-state test above for why one isn't enough.
    const customStatus = {
      status: "available" as const,
      branch: "main",
      headDetached: false,
      headUnborn: false,
      files: [{ path: "gone.txt", status: "deleted" as const, staged: false, unstaged: true }],
    };
    tauriMocks.getGitStatus.mockResolvedValueOnce(customStatus);
    tauriMocks.getGitStatus.mockResolvedValueOnce(customStatus);
    tauriMocks.loadGitFileDiff.mockResolvedValueOnce({
      original: "bye\n",
      modified: "",
      status: "deleted",
      isBinary: false,
      isTooLarge: false,
    });
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    const row = await within(panel).findByText("gone.txt");
    fireEvent.click(row.closest("button")!);

    await waitFor(() =>
      expect(tauriMocks.loadGitFileDiff).toHaveBeenCalledWith("gone.txt", 5120 * 1024),
    );
    expect(await screen.findByLabelText("Diff gone.txt")).toBeInTheDocument();
  });

  it("shows the qualified path in the status bar for a diff tab, never the synthetic key", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    const readmeRow = await within(panel).findByText("README.md");
    fireEvent.click(readmeRow.closest("button")!);
    await screen.findByLabelText("Diff README.md");

    expect(document.querySelector(".statusbar__path")).toHaveTextContent(
      "README.md (Working Tree)",
    );
    expect(screen.queryByText(/^diff:\/\//)).not.toBeInTheDocument();
  });

  it("closes unpinned diff tabs on leaving commit mode but keeps pinned ones", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    const readmeRow = await within(panel).findByText("README.md");
    fireEvent.click(readmeRow.closest("button")!);
    await screen.findByLabelText("Diff README.md");
    // Pin the README diff before opening another one — an unpinned preview
    // diff tab is replaced by the next one opened, same as a file preview tab.
    // Use the .tab-strip-scoped helper: the status bar now also shows the
    // "(Working Tree)" label, so a page-wide text query would be ambiguous.
    await waitFor(() => expect(tabButton("README.md (Working Tree)")).toBeTruthy());
    fireEvent.doubleClick(tabButton("README.md (Working Tree)")!);

    const appRow = await within(panel).findByText("App.tsx");
    fireEvent.click(appRow.closest("button")!);
    await screen.findByLabelText("Diff src/App.tsx");

    fireEvent.click(screen.getByTitle("Commit changes"));

    await waitFor(() => expect(tabButton("src/App.tsx (Working Tree)")).toBeUndefined());
    expect(tabButton("README.md (Working Tree)")).toBeTruthy();
  });

  it("shows Git status badges and a folder dot in the main tree outside commit mode", async () => {
    render(<App />);

    const readmeButton = await treeButton("README.md");
    await waitFor(() =>
      expect(readmeButton.querySelector(".tree-row__status")).toHaveTextContent("M"),
    );
    expect(readmeButton.querySelector(".tree-row__status")).toHaveClass(
      "tree-row__status--modified",
    );

    // "src" starts collapsed (expandedFolders is empty by default), but the
    // dot on the folder row itself should still be visible without expanding.
    const srcButton = await treeButton("src");
    expect(srcButton.querySelector(".tree-row__status-dot")).toBeInTheDocument();

    fireEvent.click(srcButton);
    const appButton = await treeButton("App.tsx");
    expect(appButton.querySelector(".tree-row__status")).toHaveTextContent("M");

    // No selection checkboxes outside commit mode — same tree, same rows.
    expect(screen.queryByLabelText("Select README.md")).not.toBeInTheDocument();
  });

  it("collapses a folder in commit mode and the collapse carries back to browsing", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    // Entering commit mode auto-expands ancestors of changed paths, so "src"
    // (containing the changed src/App.tsx) starts expanded here even though
    // it's collapsed by default in normal browsing.
    const srcRow = await within(panel).findByText("src");
    const srcButton = srcRow.closest("button")!;
    await waitFor(() => expect(srcButton).toHaveAttribute("aria-expanded", "true"));
    expect(within(panel).getByText("App.tsx")).toBeInTheDocument();

    fireEvent.click(srcButton);
    await waitFor(() => expect(srcButton).toHaveAttribute("aria-expanded", "false"));
    expect(within(panel).queryByText("App.tsx")).not.toBeInTheDocument();

    // Leave commit mode — the manual collapse carries over to normal browsing.
    fireEvent.click(screen.getByTitle("Commit changes"));
    const tree = await screen.findByLabelText("Workspace files");
    const browsingSrcRow = await within(tree).findByText("src");
    expect(browsingSrcRow.closest("button")).toHaveAttribute("aria-expanded", "false");
    expect(within(tree).queryByText("App.tsx")).not.toBeInTheDocument();
  });

  it("reloads an open diff tab when the underlying file changes, keeping it pinned", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    const readmeRow = await within(panel).findByText("README.md");
    fireEvent.click(readmeRow.closest("button")!);
    await screen.findByLabelText("Diff README.md");
    expect(screen.getByText("modified: after")).toBeInTheDocument();

    await waitFor(() => expect(tabButton("README.md (Working Tree)")).toBeTruthy());
    fireEvent.doubleClick(tabButton("README.md (Working Tree)")!);
    expect(tabButton("README.md (Working Tree)")).not.toHaveClass("tab--temp");

    // Same trigger a background poll/window-focus/tab-reactivation would use
    // for a real file — a diff tab rides the same disk-state check.
    tauriMocks.loadGitFileDiff.mockResolvedValueOnce({
      original: "before\n",
      modified: "after v2\n",
      status: "modified",
      isBinary: false,
      isTooLarge: false,
    });
    window.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(screen.getByLabelText("Diff README.md")).toHaveTextContent("modified: after v2"),
    );
    // Reloading in place must not disturb the pin.
    expect(tabButton("README.md (Working Tree)")).toBeTruthy();
    expect(tabButton("README.md (Working Tree)")).not.toHaveClass("tab--temp");
  });

  it("leaves an open diff tab untouched when a refresh finds no change", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    const readmeRow = await within(panel).findByText("README.md");
    fireEvent.click(readmeRow.closest("button")!);
    await screen.findByLabelText("Diff README.md");
    expect(screen.getByText("modified: after")).toBeInTheDocument();

    const fetchesBefore = tauriMocks.loadGitFileDiff.mock.calls.length;
    // updateAgentContext depends directly on the raw `openFiles` array
    // reference (see the effect in App.tsx), so it's an existing, precise
    // proxy for "did a setOpenFiles call happen" — it must NOT fire again if
    // the refreshed diff is identical to what the tab already holds.
    await waitFor(() => expect(tauriMocks.updateAgentContext).toHaveBeenCalled());
    const agentContextCallsBefore = tauriMocks.updateAgentContext.mock.calls.length;

    tauriMocks.loadGitFileDiff.mockResolvedValueOnce({
      original: "before\n",
      modified: "after\n",
      status: "modified",
      isBinary: false,
      isTooLarge: false,
    });
    window.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(tauriMocks.loadGitFileDiff.mock.calls.length).toBeGreaterThan(fetchesBefore),
    );
    expect(tauriMocks.updateAgentContext.mock.calls.length).toBe(agentContextCallsBefore);
    expect(screen.getByText("modified: after")).toBeInTheDocument();
  });

  it("toggles the diff view mode and persists it as an app-level setting", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    const readmeRow = await within(panel).findByText("README.md");
    fireEvent.click(readmeRow.closest("button")!);
    const diff = await screen.findByLabelText("Diff README.md");
    expect(within(diff).getByText("view mode: inline")).toBeInTheDocument();

    fireEvent.click(within(diff).getByText("Side-by-side diff"));
    expect(within(diff).getByText("view mode: sideBySide")).toBeInTheDocument();
    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenCalledWith(
        expect.objectContaining({ diffViewMode: "sideBySide" }),
        expect.any(Object),
      ),
    );

    // The setting is app-level, not per-tab — a second diff tab opens in the
    // same mode without needing its own toggle.
    const appRow = await within(panel).findByText("App.tsx");
    fireEvent.click(appRow.closest("button")!);
    const appDiff = await screen.findByLabelText("Diff src/App.tsx");
    expect(within(appDiff).getByText("view mode: sideBySide")).toBeInTheDocument();
  });

  it("defaults the commit message box to 112px when nothing is persisted", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    const message = within(panel).getByPlaceholderText("Commit message");
    expect(message).toHaveStyle({ height: "112px" });

    const resizer = screen.getByRole("separator", { name: "Resize commit message" });
    expect(resizer).toHaveAttribute("aria-valuenow", "112");
    expect(resizer).toHaveAttribute("aria-valuemin", "56");
    expect(resizer).toHaveAttribute("aria-valuemax", "600");
  });

  it("applies a persisted commit message height on load", async () => {
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
        showDiagnosticsPanel: false,
      },
      workspace: {
        expandedFolders: [],
        openFiles: [],
        commitMessageHeight: 220,
      },
    });
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    const message = within(panel).getByPlaceholderText("Commit message");
    expect(message).toHaveStyle({ height: "220px" });
    expect(screen.getByRole("separator", { name: "Resize commit message" })).toHaveAttribute(
      "aria-valuenow",
      "220",
    );
  });

  it("resizes the commit message box with the keyboard and persists it", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Commit changes"));

    const panel = await screen.findByLabelText("Git commit panel");
    const message = within(panel).getByPlaceholderText("Commit message");
    const resizer = screen.getByRole("separator", { name: "Resize commit message" });

    // Dragging the handle up (or pressing ArrowUp) grows the box.
    fireEvent.keyDown(resizer, { key: "ArrowUp" });
    expect(message).toHaveStyle({ height: "128px" });
    expect(resizer).toHaveAttribute("aria-valuenow", "128");

    fireEvent.keyDown(resizer, { key: "ArrowDown" });
    fireEvent.keyDown(resizer, { key: "ArrowDown" });
    expect(message).toHaveStyle({ height: "96px" });

    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ commitMessageHeight: 96 }),
      ),
    );
  });
});

async function treeButton(name: string) {
  const tree = await screen.findByLabelText("Workspace files");
  const label = await within(tree).findByText(name);
  const button = label.closest("button");
  if (!button) throw new Error(`No tree button found for ${name}`);
  return button;
}

async function findTab(path: string) {
  await waitFor(() => expect(tabButton(path)).toBeTruthy());
  return tabButton(path)!;
}

function tabButton(path: string) {
  return [...document.querySelectorAll<HTMLButtonElement>(".tab")].find((button) =>
    button.textContent?.includes(path),
  );
}

async function openContentSearch() {
  fireEvent.click(screen.getByTitle("Search contents"));
  return screen.findByPlaceholderText("Search contents");
}

async function openCurrentFileFind() {
  fireEvent.click(screen.getByTitle("Find in file"));
  return screen.findByPlaceholderText("Find in file");
}

async function openSettingsDialog() {
  await waitFor(() =>
    expect(eventMocks.listeners.has("menu://show-settings")).toBe(true),
  );
  act(() => {
    eventMocks.listeners.get("menu://show-settings")?.({ payload: undefined });
  });
  return screen.findByRole("dialog", { name: "Settings" });
}

function selectSettingsTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(name) }));
}

function latestAgentContext() {
  const calls = tauriMocks.updateAgentContext.mock.calls;
  return calls.at(-1)?.[0];
}

function diagnostic(
  filePath: string,
  message: string,
  severity: number,
  startLine: number,
  startColumn: number,
): EditorDiagnostic {
  return {
    filePath,
    message,
    severity,
    startLine,
    startColumn,
    endLine: startLine,
    endColumn: startColumn + 1,
  };
}

function mockPickedNotesFile() {
  tauriMocks.pickOpenFile.mockResolvedValueOnce({
    workspaceRoot: "/Users/gordonbeeming/Developer",
    path: "notes.md",
    singleFile: true,
  });
  tauriMocks.statFile.mockResolvedValueOnce({
    path: "notes.md",
    name: "notes.md",
    isDir: false,
    depth: 0,
    size: 11,
    modifiedMs: 505,
  });
  tauriMocks.readFile.mockImplementation(async (path: string) => {
    if (path === "notes.md") return "# Notes";
    if (path === "README.md") return "readme";
    if (path === "src/App.tsx") return "export function App() {}";
    return "";
  });
}
