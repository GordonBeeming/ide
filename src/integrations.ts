import type { CodexMcpStatus } from "./tauri";

export function codexMcpConfigSnippet(status: CodexMcpStatus) {
  return [
    "[mcp_servers.ide]",
    `url = "${escapeDoubleQuoted(status.endpoint)}"`,
    `http_headers = { Authorization = "Bearer ${escapeDoubleQuoted(status.bearerToken)}" }`,
  ].join("\n");
}

function escapeDoubleQuoted(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
