# Ide

A lean Tauri-based integrated development environment built for speed, local control, and agent-friendly editor context.

The goal is not to recreate Visual Studio Code. The goal is a focused editor shell that opens fast, keeps background work explicit, and exposes useful context to tools like Claude Code and Codex.

## Current State

Implemented:

- Tauri 2 desktop shell with a Rust backend.
- React frontend.
- File tree with file and folder icons.
- Native folder picker for switching workspaces.
- File-name filtering and bounded text search across the current workspace.
- Keyboard quick-open palette for opening files by path, including arrow-key result selection.
- Dirty-file prompts before closing tabs or the native app window.
- Guarded Rust-native workspace scanning and file read/write commands.
- CodeMirror 6 editor.
- Syntax highlighting for Rust, TypeScript, JavaScript, React/TSX/JSX, HTML, CSS, and C#.
- Lazy editor loading and lazy language loading for better startup performance.
- System light/dark mode via `prefers-color-scheme` with a high-contrast bias.
- Active file, open file, and selection context stored in backend state.
- LSP process manager for Rust, TypeScript/React, and C# with status refresh after bridge events.
- Local HTTP context endpoint for terminal/browser integrations.
- Claude Code `/ide` discovery bridge with authenticated localhost WebSocket MCP and read-only editor-context tools.
- Codex-compatible read-only MCP endpoint with a per-run bearer token.

Planned:

- Persisted diagnostics and a visible diagnostics panel.
- Better keyboard-first navigation for search results and tabs.
- Diff review and write-capable Claude bridge tools with explicit editor UI review.
- Deeper Codex IDE integration if OpenAI documents a third-party custom IDE protocol beyond MCP.
- PR-ready local polish and testing workflow.

## Run Locally

```bash
./run.sh
```

The script installs Node dependencies when needed and starts Tauri dev mode.

## Requirements

- Node.js 24 or newer
- npm 11 or newer
- Rust 1.95 or newer
- macOS, Linux, or Windows with the normal Tauri platform prerequisites

Known optional language-server tools:

- `rust-analyzer` for Rust
- `typescript-language-server` for TypeScript and React
- OmniSharp or another standalone C# LSP for C#

Claude Code can discover the running editor through `/ide` after the native app starts. The app writes a user-only lock file under `~/.claude/ide/` and exposes only read-only context tools in this first bridge.

Codex can consume editor context through the MCP endpoint shown in the native sidebar. Add it to Codex with the shown bearer token:

```toml
[mcp_servers.ide]
url = "http://127.0.0.1:17877/mcp"
bearer_token_env_var = "IDE_CODEX_MCP_TOKEN"
```

The public Codex docs describe `/ide` for Codex-owned IDE surfaces, but do not currently document a Claude-style third-party lockfile protocol.

## Verification

```bash
./run-tests.sh
```

`npm audit --audit-level=moderate` currently reports no known npm vulnerabilities. Rust advisory scanning should be run with `cargo audit` once `cargo-audit` is installed locally.

## Design Constraints

- Avoid heavy editor/runtime dependencies.
- Keep editor and language support lazy-loaded.
- Prefer Rust-native filesystem and process work.
- Keep LSP optional and per-language.
- Do not add GitHub workflows yet.

More detail is in [docs/development.md](docs/development.md).
Security guardrails are tracked in [docs/security.md](docs/security.md).
Source-backed technology notes are in [docs/research.md](docs/research.md).
