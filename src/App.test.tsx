import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { EditorCommandRequest } from "./editorCommands";
import type { EditorSelection, FileEntry } from "./tauri";

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
  listFiles: vi.fn(),
  readFile: vi.fn(),
  statFile: vi.fn(),
  recordRecentFile: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
  createFolder: vi.fn(),
  renameFile: vi.fn(),
  deleteFile: vi.fn(),
  searchFiles: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  setWorkspaceRootPath: vi.fn(),
  getUiState: vi.fn(),
  updateUiState: vi.fn(),
  updateAgentContext: vi.fn(),
  getLspServers: vi.fn(),
  getHttpEndpoint: vi.fn(),
  getClaudeBridgeStatus: vi.fn(),
  getCodexMcpStatus: vi.fn(),
}));

const appWindowMocks = vi.hoisted(() => ({
  closeHandler: undefined as ((event: { preventDefault: () => void }) => void) | undefined,
  destroyNativeWindow: vi.fn(),
  onNativeWindowCloseRequested: vi.fn(),
  unlisten: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  listen: vi.fn(),
  unlisten: vi.fn(),
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
    listFiles: tauriMocks.listFiles,
    readFile: tauriMocks.readFile,
    statFile: tauriMocks.statFile,
    recordRecentFile: tauriMocks.recordRecentFile,
    writeFile: tauriMocks.writeFile,
    createFile: tauriMocks.createFile,
    createFolder: tauriMocks.createFolder,
    renameFile: tauriMocks.renameFile,
    deleteFile: tauriMocks.deleteFile,
    searchFiles: tauriMocks.searchFiles,
    pickWorkspaceFolder: tauriMocks.pickWorkspaceFolder,
    setWorkspaceRootPath: tauriMocks.setWorkspaceRootPath,
    getUiState: tauriMocks.getUiState,
    updateUiState: tauriMocks.updateUiState,
    updateAgentContext: tauriMocks.updateAgentContext,
    getLspServers: tauriMocks.getLspServers,
    getHttpEndpoint: tauriMocks.getHttpEndpoint,
    getClaudeBridgeStatus: tauriMocks.getClaudeBridgeStatus,
    getCodexMcpStatus: tauriMocks.getCodexMcpStatus,
  };
});

vi.mock("./lsp", () => ({
  setLspDiagnosticsHandler: vi.fn(),
  setLspErrorHandler: vi.fn(),
  setLspRootUri: vi.fn(),
  setLspStatusHandler: vi.fn(),
  workspacePathToFileUri: (path: string) => `file://${path}`,
}));

vi.mock("./appWindow", () => ({
  destroyNativeWindow: appWindowMocks.destroyNativeWindow,
  onNativeWindowCloseRequested: appWindowMocks.onNativeWindowCloseRequested,
}));

vi.mock("./EditorPane", () => ({
  default: ({
    contents,
    editorCommand,
    onChange,
    onSelection,
    path,
    revealLine,
  }: {
    contents: string;
    editorCommand?: EditorCommandRequest;
    onChange: (path: string, contents: string) => void;
    onSelection: (selection: EditorSelection | undefined) => void;
    path: string;
    revealLine?: number;
  }) => (
    <div>
      <textarea
        aria-label={`Editor ${path}`}
        value={contents}
        onChange={(event) => onChange(path, event.target.value)}
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
      {editorCommand ? (
        <span data-testid="editor-command">
          {editorCommand.name}:{editorCommand.nonce}
        </span>
      ) : null}
      {revealLine ? <span>Reveal line {revealLine}</span> : null}
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
    appWindowMocks.unlisten.mockReset();
    eventMocks.listeners.clear();
    eventMocks.listen.mockReset();
    eventMocks.listen.mockImplementation(async (eventName, handler) => {
      eventMocks.listeners.set(eventName, handler);
      return eventMocks.unlisten;
    });
    eventMocks.unlisten.mockReset();
    tauriMocks.getWorkspaceRoot.mockResolvedValue("/workspace");
    tauriMocks.getInitialFile.mockResolvedValue(undefined);
    tauriMocks.listFiles.mockResolvedValue(files);
    tauriMocks.statFile.mockImplementation(async (path: string) => {
      const entry = files.find((candidate) => candidate.path === path);
      if (!entry) throw new Error(`missing ${path}`);
      return entry;
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
    tauriMocks.setWorkspaceRootPath.mockResolvedValue("/workspace");
    tauriMocks.getUiState.mockResolvedValue({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
      },
      workspace: {
        expandedFolders: [],
        openFiles: [],
      },
    });
    tauriMocks.updateUiState.mockResolvedValue(undefined);
    tauriMocks.updateAgentContext.mockResolvedValue(undefined);
    tauriMocks.getLspServers.mockResolvedValue([]);
    tauriMocks.getHttpEndpoint.mockResolvedValue("http://127.0.0.1:1420");
    tauriMocks.getClaudeBridgeStatus.mockResolvedValue(undefined);
    tauriMocks.getCodexMcpStatus.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("shows a loading workspace state before the initial scan completes", () => {
    tauriMocks.getWorkspaceRoot.mockReturnValue(new Promise(() => undefined));
    tauriMocks.listFiles.mockReturnValue(new Promise(() => undefined));

    render(<App />);

    expect(screen.getByText("Loading workspace")).toBeInTheDocument();
    expect(screen.getByText("Loading")).toBeInTheDocument();
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

  it("keeps first-level folders collapsed until the user opens them", async () => {
    render(<App />);

    expect(await treeButton("src")).toBeInTheDocument();
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();

    fireEvent.click(await treeButton("src"));

    expect(await treeButton("App.tsx")).toBeInTheDocument();
  });

  it("restores saved view settings, expanded folders, and open files", async () => {
    tauriMocks.getUiState.mockResolvedValueOnce({
      view: {
        showDotfiles: true,
        showGeneratedInternal: true,
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
      expect(tauriMocks.listFiles).toHaveBeenCalledWith(true, true),
    );
    expect(await treeButton("App.tsx")).toHaveClass("tree-row--active");
    const tab = await findTab("src/App.tsx");
    expect(tab).not.toHaveClass("tab--temp");
    expect(await screen.findByLabelText("Editor src/App.tsx")).toHaveValue(
      "export function App() {}",
    );
  });

  it("reloads the tree with dotfiles when the native menu toggle is used", async () => {
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
    await waitFor(() =>
      expect(eventMocks.listeners.has("menu://toggle-dotfiles")).toBe(true),
    );

    eventMocks.listeners.get("menu://toggle-dotfiles")?.({ payload: undefined });

    await waitFor(() =>
      expect(tauriMocks.listFiles).toHaveBeenLastCalledWith(true, false),
    );
    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        {
          showDotfiles: true,
          showGeneratedInternal: false,
        },
        expect.any(Object),
      ),
    );
    expect(await treeButton(".gitignore")).toBeInTheDocument();
  });

  it("reloads the tree with generated folders when the native menu toggle is used", async () => {
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
    await waitFor(() =>
      expect(eventMocks.listeners.has("menu://toggle-generated-internal")).toBe(true),
    );

    eventMocks.listeners
      .get("menu://toggle-generated-internal")
      ?.({ payload: undefined });

    await waitFor(() =>
      expect(tauriMocks.listFiles).toHaveBeenLastCalledWith(false, true),
    );
    await waitFor(() =>
      expect(tauriMocks.updateUiState).toHaveBeenLastCalledWith(
        {
          showDotfiles: false,
          showGeneratedInternal: true,
        },
        expect.any(Object),
      ),
    );
    expect(await treeButton("node_modules")).toBeInTheDocument();
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
    expect(screen.queryByText("Close IDE?")).not.toBeInTheDocument();
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
    expect(await screen.findByText("Close IDE?")).toBeInTheDocument();
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
        screen.getByText("No file selected").closest(".editor-empty-state"),
      ).toBeInTheDocument();
      expect(screen.getByText("Open a file from the tree")).toBeInTheDocument();
    },
  );

  it("keeps integration details out of the default sidebar layout", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    expect(screen.queryByText("Browser Endpoint")).not.toBeInTheDocument();
    expect(screen.queryByText("Claude Bridge")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex MCP")).not.toBeInTheDocument();
    expect(screen.queryByText("Language Servers")).not.toBeInTheDocument();
  });

  it("keeps search fields collapsed until the search controls are used", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Filter files")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search contents")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Find in file")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Filter files"));
    expect(await screen.findByPlaceholderText("Filter files")).toHaveFocus();

    fireEvent.click(screen.getByTitle("Search contents"));
    expect(await screen.findByPlaceholderText("Search contents")).toHaveFocus();

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.click(screen.getByTitle("Find in file"));
    expect(await screen.findByPlaceholderText("Find in file")).toHaveFocus();
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

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    await waitFor(() => expect(eventMocks.listeners.has("menu://find-in-file")).toBe(true));
    act(() => {
      eventMocks.listeners.get("menu://find-in-file")?.({ payload: undefined });
    });
    expect(await screen.findByPlaceholderText("Find in file")).toHaveFocus();
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

    fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });

    expect(await screen.findByPlaceholderText("Search contents")).toHaveFocus();
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

  it("does not write a clean active file when save is triggered from the keyboard", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");

    fireEvent.keyDown(window, { key: "s", metaKey: true });

    expect(tauriMocks.writeFile).not.toHaveBeenCalled();
    expect(await screen.findByText("No unsaved changes")).toBeInTheDocument();
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

  it("switches open tabs with numbered keyboard shortcuts", async () => {
    render(<App />);

    fireEvent.doubleClick(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.click(await treeButton("src"));
    fireEvent.doubleClick(await treeButton("App.tsx"));
    await findTab("src/App.tsx");
    expect(await screen.findByLabelText("Editor src/App.tsx")).toHaveValue(
      "export function App() {}",
    );

    fireEvent.keyDown(window, { key: "1", metaKey: true });

    expect(screen.getByLabelText("Editor README.md")).toHaveValue("readme");
    expect(tabButton("README.md")).toHaveClass("tab--active");

    fireEvent.keyDown(window, { key: "9", metaKey: true });

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
    );
    expect(tauriMocks.writeFile).toHaveBeenCalledWith(
      "src/App.tsx",
      "changed app",
      202,
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
    expect(tauriMocks.writeFile).toHaveBeenCalledWith(
      "README.md",
      "changed readme",
      101,
    );
    expect(document.querySelectorAll(".dirty-dot")).toHaveLength(1);
    expect(screen.getByText("Save failed")).toBeInTheDocument();
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

    await waitFor(() => expect(tauriMocks.searchFiles).toHaveBeenCalledWith("needle"));
    const resultPath = await screen.findByText("src/App.tsx:4");
    expect(screen.getByLabelText("Content search results")).toHaveTextContent(
      "Results1src/App.tsx:4const needle = true;",
    );
    fireEvent.click(resultPath.closest("button")!);

    await findTab("src/App.tsx");
    expect(screen.getByText("Reveal line 4")).toBeInTheDocument();
  });

  it("surfaces content search failures", async () => {
    tauriMocks.searchFiles.mockRejectedValueOnce(new Error("index unavailable"));
    render(<App />);

    fireEvent.change(await openContentSearch(), {
      target: { value: "needle" },
    });

    await screen.findByText("Search failed: Error: index unavailable");
    expect(tauriMocks.searchFiles).toHaveBeenCalledWith("needle");
    expect(screen.getByText("No matches")).toBeInTheDocument();
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

    await waitFor(() => expect(tauriMocks.createFile).toHaveBeenCalledWith("src/NewFile.tsx"));
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

  it("creates a new folder in the selected folder", async () => {
    render(<App />);

    fireEvent.click(await treeButton("src"));
    fireEvent.click(screen.getByTitle("New folder"));
    expect(screen.getByLabelText("Path")).toHaveValue("src/new-folder");

    fireEvent.change(screen.getByLabelText("Path"), {
      target: { value: "src/features" },
    });
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(tauriMocks.createFolder).toHaveBeenCalledWith("src/features"));
    expect(screen.queryByRole("dialog", { name: "New folder" })).not.toBeInTheDocument();
    expect(screen.getByText("Created folder src/features")).toBeInTheDocument();
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

    await waitFor(() => expect(tauriMocks.renameFile).toHaveBeenCalledWith("src", "app"));
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
    expect(screen.getByText("Delete failed")).toBeInTheDocument();
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

function latestAgentContext() {
  const calls = tauriMocks.updateAgentContext.mock.calls;
  return calls.at(-1)?.[0];
}
