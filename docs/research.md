# Research Notes

## Editor Core

- Tauri 2 gives the app a small native shell with Rust-owned filesystem and process work.
- CodeMirror 6 keeps the editor surface modular. Language packages and the LSP client can be lazy-loaded by file type.
- Monaco remains intentionally excluded because this IDE is optimizing for startup cost and controlled feature scope.

## Claude Code IDE Bridge

Claude Code IDE integration is based on a localhost MCP transport discovered through lock files:

- Official Claude Code docs describe VS Code integration as a `127.0.0.1` server with a fresh auth token written under `~/.claude/ide/` using `0600` file permissions in a `0700` directory.
- Community implementations document the same discovery shape: `~/.claude/ide/<port>.lock`, `transport: "ws"`, `workspaceFolders`, and `authToken`.
- The first implementation in this repo exposes read-only tools only: current selection, latest selection, open editors, workspace folders, and diagnostics.

References:

- https://code.claude.com/docs/en/ide-integrations
- https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md
- https://github.com/coder/claudecode.nvim

## Codex Integration

OpenAI documentation currently points to MCP as the supported extension mechanism for Codex CLI and the Codex IDE extension. I did not find a public Claude-style third-party IDE lockfile protocol for Codex.

Current implication:

- Keep the app's editor context available locally.
- Prefer a standard MCP bridge for Codex once we add a Codex-specific adapter.
- Do not claim native Codex `/ide` support until OpenAI documents a compatible custom IDE protocol.

References:

- https://platform.openai.com/docs/docs-mcp
- https://help.openai.com/en/articles/11096431
- https://openai.com/index/introducing-upgrades-to-codex/
