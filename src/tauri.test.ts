import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("hosted Tauri API transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("adds the local bearer token to hosted write requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          endpoint: "http://127.0.0.1:17877/mcp",
          bearerToken: "secret-token",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { writeFile } = await import("./tauri");

    await writeFile("README.md", "changed", 1234);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/codex-mcp");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/file");
    const headers = fetchMock.mock.calls[1][1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(fetchMock.mock.calls[1][1]?.body).toBe(
      JSON.stringify({
        path: "README.md",
        contents: "changed",
        expectedModifiedMs: 1234,
      }),
    );
  });

  it("refreshes the hosted write token once when the app restarts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          endpoint: "http://127.0.0.1:17877/mcp",
          bearerToken: "old-token",
        }),
      )
      .mockResolvedValueOnce(new Response("stale token", { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse({
          endpoint: "http://127.0.0.1:17877/mcp",
          bearerToken: "new-token",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { writeFile } = await import("./tauri");

    await writeFile("README.md", "changed", 1234);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/codex-mcp");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/file");
    expect((fetchMock.mock.calls[1][1]?.headers as Headers).get("Authorization")).toBe(
      "Bearer old-token",
    );
    expect(fetchMock.mock.calls[2][0]).toBe("/api/codex-mcp");
    expect(fetchMock.mock.calls[3][0]).toBe("/api/file");
    expect((fetchMock.mock.calls[3][1]?.headers as Headers).get("Authorization")).toBe(
      "Bearer new-token",
    );
  });

  it("does not fetch a write token to retry unauthenticated hosted reads", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("missing", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const { readFile } = await import("./tauri");

    await expect(readFile("README.md")).rejects.toThrow("missing");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/file?path=README.md");
  });

  it("adds the local bearer token to hosted create-file requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          endpoint: "http://127.0.0.1:17877/mcp",
          bearerToken: "secret-token",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { createFile } = await import("./tauri");

    await createFile("src/new.ts");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/file");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("POST");
    const headers = fetchMock.mock.calls[1][1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
  });

  it("adds the local bearer token to hosted create-folder requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          endpoint: "http://127.0.0.1:17877/mcp",
          bearerToken: "secret-token",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { createFolder } = await import("./tauri");

    await createFolder("src/features");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/folder");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("POST");
    const headers = fetchMock.mock.calls[1][1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
  });

  it("adds the local bearer token to hosted rename-file requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          endpoint: "http://127.0.0.1:17877/mcp",
          bearerToken: "secret-token",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { renameFile } = await import("./tauri");

    await renameFile("README.md", "README-renamed.md");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/file");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PATCH");
    const headers = fetchMock.mock.calls[1][1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
  });

  it("adds the local bearer token to hosted delete-file requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          endpoint: "http://127.0.0.1:17877/mcp",
          bearerToken: "secret-token",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { deleteFile } = await import("./tauri");

    await deleteFile("README.md");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/file");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
    const headers = fetchMock.mock.calls[1][1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
  });

  it("uses the loopback API base for Vite dev server locations", async () => {
    const { apiBaseForLocation } = await import("./tauri");

    expect(apiBaseForLocation({ port: "1420" })).toBe("http://127.0.0.1:17877");
    expect(apiBaseForLocation({ port: "17877" })).toBe("");
  });

  it("uses the same-origin API base when hosted by the app HTTP server", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          endpoint: "http://127.0.0.1:17877/mcp",
          bearerToken: "secret-token",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { updateAgentContext } = await import("./tauri");

    await updateAgentContext({
      openFiles: [],
      diagnostics: [],
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/codex-mcp");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/agent-context");
  });

  it("does not persist recent files from hosted browser mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { recordRecentFile } = await import("./tauri");

    await recordRecentFile("README.md");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes single-file recent state through native commands", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(undefined);
    const { recordRecentFile } = await import("./tauri");

    await recordRecentFile("notes.md", true);

    expect(invoke).toHaveBeenCalledWith("record_recent_file", {
      path: "notes.md",
      singleFile: true,
    });
  });

  it("opens native file picker launch requests only through Tauri", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue({
      workspaceRoot: "/workspace",
      path: "notes.md",
      singleFile: true,
    });
    const { pickOpenFile } = await import("./tauri");

    await expect(pickOpenFile()).resolves.toEqual({
      workspaceRoot: "/workspace",
      path: "notes.md",
      singleFile: true,
    });
    expect(invoke).toHaveBeenCalledWith("pick_open_file");
  });

  it("drains native OS-open launch requests only through Tauri", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue([
      {
        type: "file",
        workspaceRoot: "/workspace",
        path: "notes.md",
        singleFile: true,
      },
    ]);
    const { takeOpenedLaunchTargets } = await import("./tauri");

    await expect(takeOpenedLaunchTargets()).resolves.toEqual([
      {
        type: "file",
        workspaceRoot: "/workspace",
        path: "notes.md",
        singleFile: true,
      },
    ]);
    expect(invoke).toHaveBeenCalledWith("take_opened_launch_targets");
  });

  it("does not request OS-open launch targets from hosted browser mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
    const { takeOpenedLaunchTargets } = await import("./tauri");

    await expect(takeOpenedLaunchTargets()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects native file picking from hosted browser mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { pickOpenFile } = await import("./tauri");

    await expect(pickOpenFile()).rejects.toThrow(
      "File picker is only available in the native Tauri app",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats malformed hosted Codex MCP status as unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const { getCodexMcpStatus } = await import("./tauri");

    await expect(getCodexMcpStatus()).resolves.toBeUndefined();
  });

  it("returns default UI state and does not persist it from hosted browser mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { getUiState, updateUiState } = await import("./tauri");

    await expect(getUiState()).resolves.toEqual({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
        treeScanLimit: 4000,
        workspaceSearchResultLimit: 200,
        workspaceSearchMaxFileKb: 1024,
        currentFileSearchResultLimit: 200,
        quickOpenResultLimit: 12,
        commandPaletteResultLimit: 18,
      },
      workspace: {
        expandedFolders: [],
        openFiles: [],
      },
    });
    await updateUiState(
      {
        showDotfiles: true,
        showGeneratedInternal: true,
        treeScanLimit: 4000,
        workspaceSearchResultLimit: 200,
        workspaceSearchMaxFileKb: 1024,
        currentFileSearchResultLimit: 200,
        quickOpenResultLimit: 12,
        commandPaletteResultLimit: 18,
      },
      {
        expandedFolders: ["src"],
        openFiles: ["README.md"],
        activeFile: "README.md",
        selectedPath: "README.md",
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes explicit search limits through hosted search requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const { searchFiles } = await import("./tauri");

    await searchFiles("needle", 500, 512 * 1024);

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/search?query=needle&maxResults=500&maxFileBytes=524288",
    );
  });

  it("passes dotfile visibility through hosted file listing requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const { listFiles } = await import("./tauri");

    await listFiles();
    await listFiles(true);
    await listFiles(false, true);
    await listFiles(true, true);
    await listFiles(false, false, 8000);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/files");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/files?showDotfiles=true");
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/api/files?showGeneratedInternal=true",
    );
    expect(fetchMock.mock.calls[3][0]).toBe(
      "/api/files?showDotfiles=true&showGeneratedInternal=true",
    );
    expect(fetchMock.mock.calls[4][0]).toBe("/api/files?treeScanLimit=8000");
  });

  it("passes visibility settings through hosted directory listing requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const { listDirectory } = await import("./tauri");

    await listDirectory("src folder", true, true);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/directory?path=src+folder&showDotfiles=true&showGeneratedInternal=true",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reads hosted file metadata without scanning the workspace", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        path: "README.md",
        name: "README.md",
        isDir: false,
        depth: 0,
        size: 20,
        modifiedMs: 123,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { statFile } = await import("./tauri");

    await expect(statFile("README.md")).resolves.toEqual({
      path: "README.md",
      name: "README.md",
      isDir: false,
      depth: 0,
      size: 20,
      modifiedMs: 123,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/file-metadata?path=README.md",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects hosted file listing responses that are not arrays", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { listFiles } = await import("./tauri");

    await expect(listFiles()).rejects.toThrow(
      "Workspace file list response was not valid JSON",
    );
  });

  it("passes dotfile visibility through native file listing commands", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue([]);
    const { listFiles } = await import("./tauri");

    await listFiles(true, true);

    expect(invoke).toHaveBeenCalledWith("list_files", {
      showDotfiles: true,
      showGeneratedInternal: true,
    });
  });

  it("passes explicit scan limits through native file listing commands", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue([]);
    const { listFiles } = await import("./tauri");

    await listFiles(false, false, 8000);

    expect(invoke).toHaveBeenCalledWith("list_files", {
      showDotfiles: false,
      showGeneratedInternal: false,
      treeScanLimit: 8000,
    });
  });

  it("passes explicit search limits through native search commands", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue([]);
    const { searchFiles } = await import("./tauri");

    await searchFiles("needle", 500, 512 * 1024);

    expect(invoke).toHaveBeenCalledWith("search_files", {
      query: "needle",
      maxResults: 500,
      maxFileBytes: 512 * 1024,
    });
  });

  it("passes visibility settings through native directory listing commands", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue([]);
    const { listDirectory } = await import("./tauri");

    await listDirectory("src", true, true);

    expect(invoke).toHaveBeenCalledWith("list_directory", {
      path: "src",
      showDotfiles: true,
      showGeneratedInternal: true,
    });
  });

  it("uses native commands for UI state persistence", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce({
      view: {
        showDotfiles: true,
        showGeneratedInternal: false,
      },
      workspace: {
        expandedFolders: ["src"],
        openFiles: ["src/App.tsx"],
        activeFile: "src/App.tsx",
        selectedPath: "src/App.tsx",
      },
    });
    const { getUiState, updateUiState } = await import("./tauri");

    await expect(getUiState()).resolves.toMatchObject({
      view: {
        showDotfiles: true,
      },
      workspace: {
        openFiles: ["src/App.tsx"],
      },
    });
    await updateUiState(
      {
        showDotfiles: true,
        showGeneratedInternal: false,
      },
      {
        expandedFolders: ["src"],
        openFiles: ["src/App.tsx"],
        activeFile: "src/App.tsx",
        selectedPath: "src/App.tsx",
      },
    );

    expect(invoke).toHaveBeenCalledWith("get_ui_state");
    expect(invoke).toHaveBeenCalledWith("update_ui_state", {
      view: {
        showDotfiles: true,
        showGeneratedInternal: false,
      },
      workspace: {
        expandedFolders: ["src"],
        openFiles: ["src/App.tsx"],
        activeFile: "src/App.tsx",
        selectedPath: "src/App.tsx",
      },
    });
  });
});
