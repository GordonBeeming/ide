import type { CodexMcpStatus } from "./tauri";

export function codexMcpConfigSnippet(status: CodexMcpStatus) {
  return [
    `export IDE_CODEX_MCP_TOKEN="${escapeDoubleQuoted(status.bearerToken)}"`,
    "",
    "# ~/.codex/config.toml",
    "[mcp_servers.ide]",
    `url = "${escapeDoubleQuoted(status.endpoint)}"`,
    'bearer_token_env_var = "IDE_CODEX_MCP_TOKEN"',
  ].join("\n");
}

function escapeDoubleQuoted(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
