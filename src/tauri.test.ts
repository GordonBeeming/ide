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

  it("derives the workspace path prefix from the hosted URL", async () => {
    const { workspacePathPrefix } = await import("./tauri");

    // Dev server proxies to the single shared workspace — no prefix.
    expect(workspacePathPrefix({ port: "1420", pathname: "/abc123/" })).toBe("");
    // Hosted under /{hash}/ — every API call carries that segment.
    expect(workspacePathPrefix({ port: "17877", pathname: "/abc123/" })).toBe(
      "/abc123",
    );
    expect(
      workspacePathPrefix({ port: "17877", pathname: "/abc123/some/route" }),
    ).toBe("/abc123");
    // Bare root (chooser) has no workspace segment.
    expect(workspacePathPrefix({ port: "17877", pathname: "/" })).toBe("");
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
    const { getSettingsLocations, getUiState, updateUiState } = await import("./tauri");

    await expect(getUiState()).resolves.toEqual({
      view: {
        showDotfiles: false,
        showGeneratedInternal: false,
        showGitignoredFiles: false,
        showDiagnosticsPanel: false,
        trackActiveFile: true,
        treeScanLimit: 10000,
        maxOpenFileKb: 5120,
        workspaceSearchResultLimit: 200,
        workspaceSearchMaxFileKb: 1024,
        currentFileSearchResultLimit: 200,
        currentFileResultPreviewLimit: 12,
        quickOpenResultLimit: 12,
        backgroundIndexBatchEntries: 2000,
        workspaceTitleMaxChars: 50,
        commandPaletteResultLimit: 18,
        editorFontSize: 13,
        appZoomPercent: 100,
        dateTimeFormat: "localMedium",
        recentRelativeThreshold: "oneWeek",
        diffViewMode: "inline",
        autoFetchSeconds: 60,
        featureFlags: {},
      },
      workspace: {
        expandedFolders: [],
        openFiles: [],
      },
    });
    await expect(getSettingsLocations()).resolves.toEqual({});
    await updateUiState(
      {
        showDotfiles: true,
        showGeneratedInternal: true,
        showGitignoredFiles: false,
        showDiagnosticsPanel: true,
        treeScanLimit: 10000,
        maxOpenFileKb: 5120,
        workspaceSearchResultLimit: 200,
        workspaceSearchMaxFileKb: 1024,
        currentFileSearchResultLimit: 200,
        currentFileResultPreviewLimit: 12,
        quickOpenResultLimit: 12,
        backgroundIndexBatchEntries: 2000,
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

  it("reads native settings storage locations through Tauri", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue({
      settingsFile: "/app-data/ui-state.json",
      recentsFile: "/app-data/recents.json",
      workspaceIndexFile: "/app-local/workspace-index.sqlite",
    });
    const { getSettingsLocations } = await import("./tauri");

    await expect(getSettingsLocations()).resolves.toEqual({
      settingsFile: "/app-data/ui-state.json",
      recentsFile: "/app-data/recents.json",
      workspaceIndexFile: "/app-local/workspace-index.sqlite",
    });
    expect(invoke).toHaveBeenCalledWith("get_settings_locations");
  });

  it("reads hosted workspace index stats", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        indexedEntries: 12,
        indexedFiles: 7,
        indexedFolders: 5,
        loadedFolders: 3,
        pendingFolders: 2,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getWorkspaceIndexStats } = await import("./tauri");

    await expect(getWorkspaceIndexStats()).resolves.toEqual({
      indexedEntries: 12,
      indexedFiles: 7,
      indexedFolders: 5,
      loadedFolders: 3,
      pendingFolders: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace-index",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects malformed hosted workspace index stats", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ indexedFiles: 7 }));
    vi.stubGlobal("fetch", fetchMock);
    const { getWorkspaceIndexStats } = await import("./tauri");

    await expect(getWorkspaceIndexStats()).rejects.toThrow(
      "Workspace index stats response was not valid JSON",
    );
  });

  it("reads native workspace index stats through Tauri", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue({
      indexedEntries: 12,
      indexedFiles: 7,
      indexedFolders: 5,
      loadedFolders: 3,
      pendingFolders: 2,
    });
    const { getWorkspaceIndexStats } = await import("./tauri");

    await expect(getWorkspaceIndexStats()).resolves.toEqual({
      indexedEntries: 12,
      indexedFiles: 7,
      indexedFolders: 5,
      loadedFolders: 3,
      pendingFolders: 2,
    });
    expect(invoke).toHaveBeenCalledWith("get_workspace_index_stats", undefined);
  });

  it("advances hosted workspace indexing with a bounded authenticated request", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/codex-mcp") {
        return jsonResponse({ endpoint: "http://127.0.0.1:17877/mcp", bearerToken: "token" });
      }
      return jsonResponse({
        indexedEntries: 30,
        indexedFiles: 20,
        indexedFolders: 10,
        loadedFolders: 5,
        pendingFolders: 0,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { advanceWorkspaceIndex } = await import("./tauri");

    await expect(advanceWorkspaceIndex(2000, true, true)).resolves.toEqual({
      indexedEntries: 30,
      indexedFiles: 20,
      indexedFolders: 10,
      loadedFolders: 5,
      pendingFolders: 0,
    });

    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/workspace-index/advance?entryLimit=2000&showDotfiles=true&showGeneratedInternal=true",
    );
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
  });

  it("advances native workspace indexing through Tauri", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue({
      indexedEntries: 30,
      indexedFiles: 20,
      indexedFolders: 10,
      loadedFolders: 5,
      pendingFolders: 0,
    });
    const { advanceWorkspaceIndex } = await import("./tauri");

    await expect(advanceWorkspaceIndex(2000, true, true)).resolves.toEqual({
      indexedEntries: 30,
      indexedFiles: 20,
      indexedFolders: 10,
      loadedFolders: 5,
      pendingFolders: 0,
    });
    expect(invoke).toHaveBeenCalledWith("advance_workspace_index", {
      entryLimit: 2000,
      showDotfiles: true,
      showGeneratedInternal: true,
      showGitignoredFiles: false,
    });
  });

  it("passes explicit search limits through hosted search requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const { searchFiles } = await import("./tauri");

    await searchFiles("needle", 500, 512 * 1024, true);

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/search?query=needle&maxResults=500&maxFileBytes=524288&showDotfiles=true",
    );
  });

  it("normalizes hosted search metadata responses", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse({
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
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { searchFiles } = await import("./tauri");

    await expect(searchFiles("needle")).resolves.toMatchObject({
      matches: [{ path: "README.md" }],
      truncated: true,
      limit: 1,
      searchedFiles: 2,
      skippedFiles: 1,
    });
  });

  it("passes explicit open file size limits through hosted read requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("readme", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { readFile } = await import("./tauri");

    await readFile("README.md", 5 * 1024);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/file?path=README.md&maxOpenBytes=5120",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("passes explicit quick-open limits through hosted indexed file search", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const { searchIndexedFiles } = await import("./tauri");

    await searchIndexedFiles("app", 20);
    await searchIndexedFiles("app", 20, true, true);
    await searchIndexedFiles("app", 20, false, false, true);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/file-search?query=app&limit=20");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/file-search?query=app&limit=20&showDotfiles=true&showGeneratedInternal=true",
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/api/file-search?query=app&limit=20&showGitignoredFiles=true",
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
    await listFiles(false, false, undefined, true);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/files");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/files?showDotfiles=true");
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/api/files?showGeneratedInternal=true",
    );
    expect(fetchMock.mock.calls[3][0]).toBe(
      "/api/files?showDotfiles=true&showGeneratedInternal=true",
    );
    expect(fetchMock.mock.calls[4][0]).toBe("/api/files?treeScanLimit=8000");
    expect(fetchMock.mock.calls[5][0]).toBe("/api/files?showGitignoredFiles=true");
  });

  it("passes visibility settings through hosted directory listing requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const { listDirectory } = await import("./tauri");

    await listDirectory("src folder", true, true);
    await listDirectory("src folder", false, false, true);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/directory?path=src+folder&showDotfiles=true&showGeneratedInternal=true",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/directory?path=src+folder&showGitignoredFiles=true",
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
      showGitignoredFiles: false,
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
      showGitignoredFiles: false,
      treeScanLimit: 8000,
    });
  });

  it("normalizes native file listing metadata responses", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue({
      entries: [
        {
          path: "README.md",
          name: "README.md",
          isDir: false,
          depth: 0,
          size: 10,
        },
      ],
      truncated: true,
      limit: 1,
    });
    const { listFiles } = await import("./tauri");

    await expect(listFiles()).resolves.toMatchObject({
      entries: [{ path: "README.md" }],
      truncated: true,
      limit: 1,
    });
  });

  it("passes explicit search limits through native search commands", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue([]);
    const { searchFiles } = await import("./tauri");

    await searchFiles("needle", 500, 512 * 1024, true);

    expect(invoke).toHaveBeenCalledWith("search_files", {
      query: "needle",
      maxResults: 500,
      maxFileBytes: 512 * 1024,
      showDotfiles: true,
    });
  });

  it("normalizes native search metadata responses", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue({
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
    const { searchFiles } = await import("./tauri");

    await expect(searchFiles("needle")).resolves.toMatchObject({
      matches: [{ path: "README.md" }],
      truncated: true,
      limit: 1,
      searchedFiles: 2,
      skippedFiles: 1,
    });
  });

  it("passes explicit open file size limits through native read commands", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue("readme");
    const { readFile } = await import("./tauri");

    await readFile("README.md", 5 * 1024);

    expect(invoke).toHaveBeenCalledWith("read_file", {
      path: "README.md",
      maxOpenBytes: 5 * 1024,
      allowExternalSymlinks: false,
    });
  });

  it("passes explicit quick-open limits through native indexed file search", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue([]);
    const { searchIndexedFiles } = await import("./tauri");

    await searchIndexedFiles("app", 20);

    expect(invoke).toHaveBeenCalledWith("search_indexed_files", {
      query: "app",
      limit: 20,
      showDotfiles: false,
      showGeneratedInternal: false,
      showGitignoredFiles: false,
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
      showGitignoredFiles: false,
      allowExternalSymlinks: false,
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

describe("Git attribution response normalization", () => {
  it("normalizes available attribution with commit actions", async () => {
    const { normalizeGitAttribution } = await import("./tauri");

    expect(
      normalizeGitAttribution({
        path: "README.md",
        status: "available",
        file: {
          sha: "abc123456789",
          shortSha: "abc12345",
          authorName: "Gordon Beeming",
          authorEmail: "gordon@example.com",
          authoredAtSeconds: 1700000000,
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
              authoredAtSeconds: 1700000000,
              summary: "Add readme",
              actions: [],
            },
          },
        ],
        uncommittedLines: [2],
      }),
    ).toEqual({
      path: "README.md",
      status: "available",
      unsupportedReason: undefined,
      file: {
        sha: "abc123456789",
        shortSha: "abc12345",
        authorName: "Gordon Beeming",
        authorEmail: "gordon@example.com",
        authoredAtSeconds: 1700000000,
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
            authorEmail: undefined,
            authoredAtSeconds: 1700000000,
            summary: "Add readme",
            actions: [],
          },
        },
      ],
      uncommittedLines: [2],
    });
  });

  it("defaults missing uncommitted line metadata to no uncommitted lines", async () => {
    const { normalizeGitAttribution } = await import("./tauri");

    expect(
      normalizeGitAttribution({
        path: "README.md",
        status: "available",
        file: null,
        lines: [],
      }),
    ).toEqual({
      path: "README.md",
      status: "available",
      unsupportedReason: undefined,
      file: undefined,
      lines: [],
      uncommittedLines: [],
    });
  });

  it("rejects malformed attribution payloads", async () => {
    const { normalizeGitAttribution } = await import("./tauri");

    expect(normalizeGitAttribution({ path: "README.md", status: "available" })).toBeUndefined();
    expect(
      normalizeGitAttribution({
        path: "README.md",
        status: "available",
        file: null,
        lines: [{ lineNumber: 0, commit: {} }],
      }),
    ).toBeUndefined();
    expect(
      normalizeGitAttribution({
        path: "README.md",
        status: "available",
        file: null,
        lines: [],
        uncommittedLines: [1, 0],
      }),
    ).toBeUndefined();
  });
});

describe("Git status response normalization", () => {
  it("normalizes an available status with mixed file states", async () => {
    const { normalizeGitStatus } = await import("./tauri");

    expect(
      normalizeGitStatus({
        status: "available",
        branch: "main",
        headDetached: false,
        headUnborn: false,
        files: [
          { path: "a.txt", status: "modified", staged: true, unstaged: false },
          { path: "b.txt", status: "deleted", staged: false, unstaged: true },
          { path: "c.txt", status: "added", staged: false, unstaged: true },
        ],
        mergeInProgress: false,
        conflictedFiles: [],
      }),
    ).toEqual({
      status: "available",
      unsupportedReason: undefined,
      branch: "main",
      headDetached: false,
      headUnborn: false,
      files: [
        { path: "a.txt", status: "modified", staged: true, unstaged: false },
        { path: "b.txt", status: "deleted", staged: false, unstaged: true },
        { path: "c.txt", status: "added", staged: false, unstaged: true },
      ],
      mergeInProgress: false,
      conflictedFiles: [],
      noUpstream: false,
    });
  });

  it("carries merge state and conflicted files", async () => {
    const { normalizeGitStatus } = await import("./tauri");

    expect(
      normalizeGitStatus({
        status: "available",
        branch: "main",
        headDetached: false,
        headUnborn: false,
        files: [],
        mergeInProgress: true,
        conflictedFiles: ["conflict.txt"],
      }),
    ).toEqual({
      status: "available",
      unsupportedReason: undefined,
      branch: "main",
      headDetached: false,
      headUnborn: false,
      files: [],
      mergeInProgress: true,
      conflictedFiles: ["conflict.txt"],
      noUpstream: false,
    });
  });

  it("defaults merge fields when an older backend omits them", async () => {
    const { normalizeGitStatus } = await import("./tauri");

    const status = normalizeGitStatus({
      status: "available",
      branch: "main",
      headDetached: false,
      headUnborn: false,
      files: [],
    });

    expect(status?.mergeInProgress).toBe(false);
    expect(status?.conflictedFiles).toEqual([]);
    expect(status?.ahead).toBeUndefined();
    expect(status?.behind).toBeUndefined();
  });

  it("carries ahead/behind counts and rejects bad ones", async () => {
    const { normalizeGitStatus } = await import("./tauri");

    const base = {
      status: "available" as const,
      branch: "main",
      headDetached: false,
      headUnborn: false,
      files: [],
      mergeInProgress: false,
      conflictedFiles: [],
    };

    const counted = normalizeGitStatus({ ...base, ahead: 2, behind: 1 });
    expect(counted?.ahead).toBe(2);
    expect(counted?.behind).toBe(1);
    expect(counted?.noUpstream).toBe(false);

    // No upstream serializes as null → undefined, and `noUpstream` becomes
    // true since the backend explicitly reported the null (as opposed to the
    // key being absent below).
    const noUpstream = normalizeGitStatus({ ...base, ahead: null, behind: null });
    expect(noUpstream?.ahead).toBeUndefined();
    expect(noUpstream?.behind).toBeUndefined();
    expect(noUpstream?.noUpstream).toBe(true);

    // A detached or unborn HEAD also nulls ahead/behind (no branch to compare
    // against), but that's not a confirmed no-upstream *branch* — noUpstream
    // must stay false so it keeps meaning exactly what its name says
    // everywhere it's read, not just at one call site that remembers to
    // additionally check headDetached/headUnborn.
    const detached = normalizeGitStatus({
      ...base,
      headDetached: true,
      ahead: null,
      behind: null,
    });
    expect(detached?.noUpstream).toBe(false);
    const unborn = normalizeGitStatus({ ...base, headUnborn: true, ahead: null, behind: null });
    expect(unborn?.noUpstream).toBe(false);

    // Negative / non-integer values are treated as absent, same as null, but
    // `noUpstream` only fires on an explicit null, not a merely-invalid value.
    const bad = normalizeGitStatus({ ...base, ahead: -1, behind: 1.5 });
    expect(bad?.ahead).toBeUndefined();
    expect(bad?.behind).toBeUndefined();
    expect(bad?.noUpstream).toBe(false);

    // A backend that predates ahead/behind omits the key entirely — that must
    // not be confused with a confirmed no-upstream state.
    const legacy = normalizeGitStatus(base);
    expect(legacy?.ahead).toBeUndefined();
    expect(legacy?.noUpstream).toBe(false);
  });

  it("normalizes an unsupported status without a branch", async () => {
    const { normalizeGitStatus } = await import("./tauri");

    expect(
      normalizeGitStatus({
        status: "unsupported",
        unsupportedReason: "Workspace is not inside a Git repository",
        headDetached: false,
        headUnborn: false,
        files: [],
        mergeInProgress: false,
        conflictedFiles: [],
      }),
    ).toEqual({
      status: "unsupported",
      unsupportedReason: "Workspace is not inside a Git repository",
      branch: undefined,
      headDetached: false,
      headUnborn: false,
      files: [],
      mergeInProgress: false,
      conflictedFiles: [],
      noUpstream: false,
    });
  });

  it("rejects malformed status payloads", async () => {
    const { normalizeGitStatus } = await import("./tauri");

    expect(normalizeGitStatus({ status: "available" })).toBeUndefined();
    expect(
      normalizeGitStatus({
        status: "available",
        headDetached: false,
        headUnborn: false,
        files: [{ path: "a.txt", status: "renamed", staged: true, unstaged: false }],
      }),
    ).toBeUndefined();
  });
});

describe("Git commit response normalization", () => {
  it("normalizes a commit result", async () => {
    const { normalizeGitCommitResult } = await import("./tauri");

    expect(
      normalizeGitCommitResult({
        sha: "abc123456789",
        shortSha: "abc12345",
        branch: "main",
        committedPaths: ["a.txt", "b.txt"],
      }),
    ).toEqual({
      sha: "abc123456789",
      shortSha: "abc12345",
      branch: "main",
      committedPaths: ["a.txt", "b.txt"],
    });
  });

  it("normalizes a detached-HEAD commit result without a branch", async () => {
    const { normalizeGitCommitResult } = await import("./tauri");

    expect(
      normalizeGitCommitResult({
        sha: "abc123456789",
        shortSha: "abc12345",
        committedPaths: [],
      }),
    ).toEqual({
      sha: "abc123456789",
      shortSha: "abc12345",
      branch: undefined,
      committedPaths: [],
    });
  });

  it("rejects malformed commit result payloads", async () => {
    const { normalizeGitCommitResult } = await import("./tauri");

    expect(normalizeGitCommitResult({ sha: "abc" })).toBeUndefined();
    expect(
      normalizeGitCommitResult({
        sha: "abc",
        shortSha: "abc",
        committedPaths: [1, 2],
      }),
    ).toBeUndefined();
  });
});

describe("Git sync response normalization", () => {
  it("normalizes a synced result with pull/push counts", async () => {
    const { normalizeGitSyncResult } = await import("./tauri");

    expect(
      normalizeGitSyncResult({
        outcome: "synced",
        branch: "main",
        pulled: 2,
        pushed: 1,
      }),
    ).toEqual({
      outcome: "synced",
      branch: "main",
      pulled: 2,
      pushed: 1,
      files: [],
    });
  });

  it("defaults missing counts to zero for an up-to-date result", async () => {
    const { normalizeGitSyncResult } = await import("./tauri");

    expect(
      normalizeGitSyncResult({ outcome: "upToDate", branch: "main" }),
    ).toEqual({
      outcome: "upToDate",
      branch: "main",
      pulled: 0,
      pushed: 0,
      files: [],
    });
  });

  it("treats negative or non-integer counts as zero", async () => {
    const { normalizeGitSyncResult } = await import("./tauri");

    expect(
      normalizeGitSyncResult({
        outcome: "synced",
        branch: "main",
        pulled: -1,
        pushed: 1.5,
      }),
    ).toEqual({
      outcome: "synced",
      branch: "main",
      pulled: 0,
      pushed: 0,
      files: [],
    });
  });

  it("carries the conflicted file list for a merge conflict", async () => {
    const { normalizeGitSyncResult } = await import("./tauri");

    expect(
      normalizeGitSyncResult({
        outcome: "mergeConflict",
        branch: "main",
        files: ["conflict.txt"],
      }),
    ).toEqual({
      outcome: "mergeConflict",
      branch: "main",
      pulled: 0,
      pushed: 0,
      files: ["conflict.txt"],
    });
  });

  it("rejects malformed sync payloads", async () => {
    const { normalizeGitSyncResult } = await import("./tauri");

    expect(normalizeGitSyncResult({ outcome: "synced" })).toBeUndefined();
    expect(normalizeGitSyncResult({ outcome: "bogus", branch: "main" })).toBeUndefined();
    expect(
      normalizeGitSyncResult({ outcome: "mergeConflict", branch: "main", files: [1] }),
    ).toBeUndefined();
  });
});

describe("Git merge-commit response normalization", () => {
  it("normalizes a completed merge commit", async () => {
    const { normalizeGitMergeCommit } = await import("./tauri");

    expect(
      normalizeGitMergeCommit({ sha: "abc123456789", shortSha: "abc12345", branch: "main" }),
    ).toEqual({ sha: "abc123456789", shortSha: "abc12345", branch: "main" });
  });

  it("tolerates a missing branch (detached HEAD)", async () => {
    const { normalizeGitMergeCommit } = await import("./tauri");

    expect(normalizeGitMergeCommit({ sha: "abc", shortSha: "abc" })).toEqual({
      sha: "abc",
      shortSha: "abc",
      branch: undefined,
    });
  });

  it("rejects malformed merge payloads", async () => {
    const { normalizeGitMergeCommit } = await import("./tauri");

    expect(normalizeGitMergeCommit({ sha: "abc" })).toBeUndefined();
    expect(normalizeGitMergeCommit(null)).toBeUndefined();
  });
});

describe("Git file diff response normalization", () => {
  it("normalizes a modified-file diff", async () => {
    const { normalizeGitFileDiff } = await import("./tauri");

    expect(
      normalizeGitFileDiff({
        original: "before\n",
        modified: "after\n",
        status: "modified",
        isBinary: false,
        isTooLarge: false,
      }),
    ).toEqual({
      original: "before\n",
      modified: "after\n",
      status: "modified",
      isBinary: false,
      isTooLarge: false,
    });
  });

  it("normalizes a binary diff with empty text sides", async () => {
    const { normalizeGitFileDiff } = await import("./tauri");

    expect(
      normalizeGitFileDiff({
        original: "",
        modified: "",
        status: "added",
        isBinary: true,
        isTooLarge: false,
      }),
    ).toEqual({
      original: "",
      modified: "",
      status: "added",
      isBinary: true,
      isTooLarge: false,
    });
  });

  it("rejects malformed diff payloads", async () => {
    const { normalizeGitFileDiff } = await import("./tauri");

    expect(normalizeGitFileDiff({ original: "a", modified: "b" })).toBeUndefined();
    expect(
      normalizeGitFileDiff({
        original: "a",
        modified: "b",
        status: "renamed",
        isBinary: false,
        isTooLarge: false,
      }),
    ).toBeUndefined();
  });
});

describe("Diff view mode sanitization", () => {
  it("keeps known values and falls back to inline for anything else", async () => {
    const { sanitizeDiffViewMode } = await import("./tauri");

    expect(sanitizeDiffViewMode("inline")).toBe("inline");
    expect(sanitizeDiffViewMode("sideBySide")).toBe("sideBySide");
    expect(sanitizeDiffViewMode("split")).toBe("inline");
    expect(sanitizeDiffViewMode(undefined)).toBe("inline");
    expect(sanitizeDiffViewMode(null)).toBe("inline");
  });
});
