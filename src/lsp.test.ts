import { describe, expect, it, vi } from "vitest";
import {
  __lspClientCacheSizeForTest,
  __primeLspClientCacheForTest,
  diagnosticsFromLspMessage,
  languageForLsp,
  languageIdForPath,
  sanitizeHtml,
  setLspRootUri,
  workspacePathToFileUri,
  workspaceRelativePathToFileUri,
} from "./lsp";

describe("LSP HTML sanitizer", () => {
  it("selects the shared TypeScript server for TypeScript and React files", () => {
    expect(languageForLsp("src/main.ts")).toBe("typescript");
    expect(languageForLsp("src/App.tsx")).toBe("typescript");
    expect(languageForLsp("src/main.js")).toBe("typescript");
    expect(languageForLsp("src/App.jsx")).toBe("typescript");
  });

  it("uses path-specific language ids for TypeScript server documents", () => {
    expect(languageIdForPath("src/main.ts")).toBe("typescript");
    expect(languageIdForPath("src/App.tsx")).toBe("typescriptreact");
    expect(languageIdForPath("src/main.js")).toBe("javascript");
    expect(languageIdForPath("src/App.jsx")).toBe("javascriptreact");
    expect(languageIdForPath("src/Program.cs")).toBe("csharp");
    expect(languageIdForPath("src/main.rs")).toBe("rust");
  });

  it("builds workspace root file URIs for POSIX and Windows-style paths", () => {
    expect(workspacePathToFileUri("/Users/gordon/Developer/my ide")).toBe(
      "file:///Users/gordon/Developer/my%20ide",
    );
    expect(workspacePathToFileUri("C:\\Users\\gordon\\Developer\\my ide")).toBe(
      "file:///C:/Users/gordon/Developer/my%20ide",
    );
  });

  it("builds safe workspace-relative document URIs for LSP requests", () => {
    expect(
      workspaceRelativePathToFileUri(
        "src/My Component.tsx",
        "file:///Users/gordon/Developer/my%20ide",
      ),
    ).toBe("file:///Users/gordon/Developer/my%20ide/src/My%20Component.tsx");
  });

  it("rejects unsafe workspace-relative document URIs", () => {
    expect(() =>
      workspaceRelativePathToFileUri("../secret.ts", "file:///workspace"),
    ).toThrow("LSP document path must stay inside the current workspace");
  });

  it("disconnects cached clients when the workspace root changes", () => {
    const disconnect = vi.fn();
    const dispose = vi.fn();

    __primeLspClientCacheForTest("file:///workspace-a", [
      { language: "typescript", disconnect, dispose },
    ]);
    setLspRootUri("file:///workspace-b");

    expect(disconnect).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(__lspClientCacheSizeForTest()).toBe(0);
  });

  it("keeps cached clients when the workspace root is unchanged", () => {
    const disconnect = vi.fn();
    const dispose = vi.fn();

    __primeLspClientCacheForTest("file:///workspace", [
      { language: "typescript", disconnect, dispose },
    ]);
    setLspRootUri("file:///workspace/");

    expect(disconnect).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(__lspClientCacheSizeForTest()).toBe(1);
  });

  it("removes executable nodes and event handlers", () => {
    const sanitized = sanitizeHtml(
      '<p onclick="alert(1)">Docs</p><script>alert(1)</script><iframe srcdoc="<p>x</p>"></iframe>',
    );

    expect(sanitized).toBe("<p>Docs</p>");
  });

  it("removes unsafe URL and style attributes while keeping safe links", () => {
    const sanitized = sanitizeHtml(
      '<a href="javascript:alert(1)" style="color:red">Bad</a><a href="https://example.com">Good</a>',
    );

    expect(sanitized).toBe('<a>Bad</a><a href="https://example.com">Good</a>');
  });

  it("removes remote media elements from language server content", () => {
    const sanitized = sanitizeHtml(
      '<p>Docs</p><img src="https://example.com/pixel.png"><video src="https://example.com/movie.mp4"></video>',
    );

    expect(sanitized).toBe("<p>Docs</p>");
  });

  it("normalizes published diagnostics into workspace-relative positions", () => {
    const result = diagnosticsFromLspMessage(
      JSON.stringify({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: "file:///workspace/src/App.tsx",
          diagnostics: [
            {
              message: "Missing semicolon",
              severity: 2,
              source: "typescript",
              code: 1005,
              range: {
                start: { line: 4, character: 8 },
                end: { line: 4, character: 12 },
              },
            },
          ],
        },
      }),
      "file:///workspace",
    );

    expect(result?.filePath).toBe("src/App.tsx");
    expect(result?.diagnostics[0]).toMatchObject({
      filePath: "src/App.tsx",
      message: "Missing semicolon",
      severity: 2,
      source: "typescript",
      code: "1005",
      startLine: 5,
      startColumn: 9,
      endLine: 5,
      endColumn: 13,
    });
  });

  it("rejects diagnostics whose decoded path escapes the workspace", () => {
    expect(() =>
      diagnosticsFromLspMessage(
        JSON.stringify({
          method: "textDocument/publishDiagnostics",
          params: {
            uri: "file:///workspace/%2E%2E/secret.txt",
            diagnostics: [],
          },
        }),
        "file:///workspace",
      ),
    ).toThrow("Received LSP diagnostics for a file outside the current workspace");
  });

  it("rejects diagnostics with absolute-style decoded paths", () => {
    expect(() =>
      diagnosticsFromLspMessage(
        JSON.stringify({
          method: "textDocument/publishDiagnostics",
          params: {
            uri: "file:///workspace/C%3A/secret.txt",
            diagnostics: [],
          },
        }),
        "file:///workspace",
      ),
    ).toThrow("Received LSP diagnostics for a file outside the current workspace");
  });

  it("ignores non-diagnostic LSP messages", () => {
    expect(
      diagnosticsFromLspMessage(
        JSON.stringify({ id: 1, result: { capabilities: {} } }),
        "file:///workspace",
      ),
    ).toBeUndefined();
  });
});
