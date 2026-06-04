import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
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
];

const tauriMocks = vi.hoisted(() => ({
  getWorkspaceRoot: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
  createFolder: vi.fn(),
  renameFile: vi.fn(),
  deleteFile: vi.fn(),
  searchFiles: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  updateAgentContext: vi.fn(),
  getLspServers: vi.fn(),
  getHttpEndpoint: vi.fn(),
  getClaudeBridgeStatus: vi.fn(),
  getCodexMcpStatus: vi.fn(),
}));

vi.mock("./tauri", async () => {
  const actual = await vi.importActual<typeof import("./tauri")>("./tauri");
  return {
    ...actual,
    getWorkspaceRoot: tauriMocks.getWorkspaceRoot,
    listFiles: tauriMocks.listFiles,
    readFile: tauriMocks.readFile,
    writeFile: tauriMocks.writeFile,
    createFile: tauriMocks.createFile,
    createFolder: tauriMocks.createFolder,
    renameFile: tauriMocks.renameFile,
    deleteFile: tauriMocks.deleteFile,
    searchFiles: tauriMocks.searchFiles,
    pickWorkspaceFolder: tauriMocks.pickWorkspaceFolder,
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
}));

vi.mock("./appWindow", () => ({
  destroyNativeWindow: vi.fn(async () => false),
  onNativeWindowCloseRequested: vi.fn(async () => undefined),
}));

vi.mock("./EditorPane", () => ({
  default: ({
    contents,
    onChange,
    onSelection,
    path,
    revealLine,
  }: {
    contents: string;
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
      {revealLine ? <span>Reveal line {revealLine}</span> : null}
    </div>
  ),
}));

describe("App shell interactions", () => {
  beforeEach(() => {
    for (const mock of Object.values(tauriMocks)) {
      mock.mockReset();
    }
    tauriMocks.getWorkspaceRoot.mockResolvedValue("/workspace");
    tauriMocks.listFiles.mockResolvedValue(files);
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
    tauriMocks.updateAgentContext.mockResolvedValue(undefined);
    tauriMocks.getLspServers.mockResolvedValue([]);
    tauriMocks.getHttpEndpoint.mockResolvedValue("http://127.0.0.1:1420");
    tauriMocks.getClaudeBridgeStatus.mockResolvedValue(undefined);
    tauriMocks.getCodexMcpStatus.mockResolvedValue(undefined);
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

  it("selects non-text files in the tree without opening an editor tab", async () => {
    render(<App />);

    const imageRow = await treeButton("image.png");
    fireEvent.click(imageRow);

    expect(imageRow).toHaveClass("tree-row--active");
    expect(tauriMocks.readFile).not.toHaveBeenCalled();
    expect(screen.getByText("No file selected").closest(".editor-empty-state")).toBeInTheDocument();
    expect(screen.getByText("Open a file from the tree")).toBeInTheDocument();
  });

  it("keeps integration details out of the default sidebar layout", async () => {
    render(<App />);

    expect(await treeButton("README.md")).toBeInTheDocument();
    expect(screen.queryByText("Browser Endpoint")).not.toBeInTheDocument();
    expect(screen.queryByText("Claude Bridge")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex MCP")).not.toBeInTheDocument();
    expect(screen.queryByText("Language Servers")).not.toBeInTheDocument();
  });

  it("keeps preview tabs temporary until the file is edited", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    const readmeTab = await findTab("README.md");
    expect(readmeTab).toHaveClass("tab--temp");

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

    fireEvent.click(await treeButton("App.tsx"));

    await findTab("src/App.tsx");
    expect(tabButton("README.md")).toBeUndefined();
  });

  it("saves every dirty tab and clears dirty indicators", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.change(await screen.findByLabelText("Editor README.md"), {
      target: { value: "changed readme" },
    });

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

    fireEvent.change(screen.getByPlaceholderText("Search contents"), {
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

    fireEvent.change(screen.getByPlaceholderText("Search contents"), {
      target: { value: "needle" },
    });

    await screen.findByText("Search failed: Error: index unavailable");
    expect(tauriMocks.searchFiles).toHaveBeenCalledWith("needle");
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("finds text in the active file and reveals the matched line", async () => {
    render(<App />);

    fireEvent.click(await treeButton("App.tsx"));
    await findTab("src/App.tsx");
    fireEvent.change(screen.getByPlaceholderText("Find in file"), {
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
    fireEvent.change(screen.getByPlaceholderText("Find in file"), {
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
    fireEvent.click(screen.getByTitle("Rename file"));
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

  it("keeps the rename dialog open when renaming fails", async () => {
    tauriMocks.renameFile.mockRejectedValueOnce(new Error("file already exists"));
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    fireEvent.click(screen.getByTitle("Rename file"));
    fireEvent.change(await screen.findByLabelText("New path"), {
      target: { value: "src/App.tsx" },
    });
    fireEvent.click(screen.getByText("Rename"));

    await screen.findByText("Error: file already exists");
    expect(screen.getByRole("dialog", { name: "Rename file" })).toBeInTheDocument();
    expect(screen.getByText("Rename file failed")).toBeInTheDocument();
  });

  it("deletes the selected open file after confirmation and closes its tab", async () => {
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    await findTab("README.md");
    fireEvent.click(screen.getByTitle("Delete file"));
    expect(screen.getByRole("alertdialog", { name: "Delete file?" })).toHaveTextContent(
      "README.md will be permanently removed from the workspace.",
    );

    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(tauriMocks.deleteFile).toHaveBeenCalledWith("README.md"));
    await waitFor(() => expect(tabButton("README.md")).toBeUndefined());
    expect(screen.getByText("Deleted README.md")).toBeInTheDocument();
  });

  it("keeps the delete confirmation open when deletion fails", async () => {
    tauriMocks.deleteFile.mockRejectedValueOnce(new Error("permission denied"));
    render(<App />);

    fireEvent.click(await treeButton("README.md"));
    fireEvent.click(screen.getByTitle("Delete file"));
    fireEvent.click(screen.getByText("Delete"));

    await screen.findByText("Error: permission denied");
    expect(screen.getByRole("alertdialog", { name: "Delete file?" })).toBeInTheDocument();
    expect(screen.getByText("Delete file failed")).toBeInTheDocument();
  });
});

async function treeButton(name: string) {
  const label = await screen.findByText(name);
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

function latestAgentContext() {
  const calls = tauriMocks.updateAgentContext.mock.calls;
  return calls.at(-1)?.[0];
}
