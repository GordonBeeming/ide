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

  it("passes dotfile visibility through hosted file listing requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const { listFiles } = await import("./tauri");

    await listFiles();
    await listFiles(true);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/files");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/files?showDotfiles=true");
  });

  it("passes dotfile visibility through native file listing commands", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue([]);
    const { listFiles } = await import("./tauri");

    await listFiles(true);

    expect(invoke).toHaveBeenCalledWith("list_files", { showDotfiles: true });
  });
});
