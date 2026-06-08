import { describe, expect, it } from "vitest";
import { codexMcpConfigSnippet } from "./integrations";

describe("codexMcpConfigSnippet", () => {
  it("builds a Codex MCP config snippet with an embedded bearer header", () => {
    expect(
      codexMcpConfigSnippet({
        endpoint: "http://127.0.0.1:17877/mcp",
        bearerToken: "session-token",
      }),
    ).toBe(
      [
        "# ~/.codex/config.toml",
        "[mcp_servers.ide]",
        'url = "http://127.0.0.1:17877/mcp"',
        'http_headers = { Authorization = "Bearer session-token" }',
      ].join("\n"),
    );
  });

  it("escapes token and URL content for TOML snippets", () => {
    expect(
      codexMcpConfigSnippet({
        endpoint: 'http://127.0.0.1:17877/mcp?name="ide"',
        bearerToken: 'tok"en\\value',
      }),
    ).toContain('http_headers = { Authorization = "Bearer tok\\"en\\\\value" }');
    expect(
      codexMcpConfigSnippet({
        endpoint: 'http://127.0.0.1:17877/mcp?name="ide"',
        bearerToken: 'tok"en\\value',
      }),
    ).toContain('url = "http://127.0.0.1:17877/mcp?name=\\"ide\\""');
  });
});
