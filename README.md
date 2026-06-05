# Ide

A lean Tauri-based integrated development environment built for speed, local control, and agent-friendly editor context.

The goal is not to recreate Visual Studio Code. The goal is a focused editor shell that opens fast, keeps background work explicit, and exposes useful context to tools like Claude Code and Codex.

## Current State

Implemented:

- Tauri 2 desktop shell with a Rust backend.
- React frontend.
- File tree with package-backed coloured file icons and folder fallbacks.
- Native folder picker for switching workspaces.
- Native File menu with New File, New Folder, Open File, Open Folder, Recents, Save, Reload, Rename/Delete, Close Tab, and Close All.
- Native View menu toggles for showing dotfiles and generated/internal folders in the tree.
- File/folder launch targets through the local runner and macOS Finder Quick Action.
- Explicit workspace loading, empty, and load-failure retry states.
- Collapsible sidebar for focused editing.
- Collapsed file-name filtering and bounded text search across the current workspace.
- Collapsed current-file search over loaded and unsaved editor contents.
- Lightweight command palette for discoverable editor and workspace commands, including native file/folder open actions in the desktop app.
- Keyboard quick-open palette for opening files by path, including arrow-key result selection.
- Keyboard tab navigation, numbered tab selection, and close commands.
- Native Search menu with Go to File, Find in File, and Find in Files actions.
- Native Navigate menu actions for LSP-backed Go to Definition and Find References.
- Dirty-file prompts before closing tabs or the native app window.
- Reload active files from disk, with confirmation before discarding unsaved edits.
- New-file creation inside the current workspace.
- New-folder creation inside the current workspace.
- File and folder rename inside the current workspace.
- Confirmed file and folder deletion inside the current workspace.
- Save active file and Save All commands.
- Stale-save protection so externally modified files are not silently overwritten.
- Guarded Rust-native workspace scanning, file/folder creation, rename, deletion, and file read/write commands.
- Common binary/media/font/archive files select in the tree without attempting text-editor reads.
- CodeMirror 6 editor.
- Syntax highlighting for common code and config files, including Rust, TypeScript, JavaScript, React/TSX/JSX, JSON, Markdown, shell scripts, HTML, CSS/SCSS/Sass, C#, C/C++, Java/Kotlin/Scala, Python, Go, Ruby, SQL, XML/YAML/TOML, Dockerfiles, PowerShell, diffs, and .NET project files.
- Lazy editor loading and lazy language loading for better startup performance.
- System light/dark mode via `prefers-color-scheme` with a high-contrast bias, including the editor surface.
- Active file, open file, and selection context stored in backend state.
- LSP process manager for Rust, TypeScript/React, and C# with status refresh after bridge events.
- LSP-backed editor keymaps from CodeMirror for definition, references, hover, rename, formatting, and signature help when the matching language server is installed.
- LSP diagnostics panel and read-only agent context.
- Local HTTP context endpoint for terminal/browser integrations.
- Claude Code `/ide` discovery bridge with authenticated localhost WebSocket MCP and read-only editor-context tools.
- Codex-compatible read-only MCP endpoint with a per-run bearer token.
- Bearer-token protection for mutating local HTTP browser API calls.

Planned:

- Diff review and write-capable Claude bridge tools with explicit editor UI review.
- Deeper Codex IDE integration if OpenAI documents a third-party custom IDE protocol beyond MCP.
- PR-ready local polish and testing workflow.

## Run Locally

```bash
./run.sh
```

The script installs Node dependencies when needed and starts Tauri dev mode.

Open a specific folder or file:

```bash
./run.sh /path/to/workspace
./run.sh /path/to/workspace/src/App.tsx
```

On macOS, install the Finder Quick Action for direct file/folder opening:

```bash
./scripts/install-macos-finder-quick-action.sh
```

After installation, use Finder's right-click menu: Quick Actions > Open in Ide. Recent folders and files are stored in the OS app-data location and exposed through the native File menu, not as in-app sidebar content.

The Finder Quick Action generator is covered by `npm run finder:check`, which installs into a temporary directory and validates the generated service, file/folder UTI coverage, and loopback handoff script without touching your real Finder services.

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

Codex can consume editor context through the MCP endpoint shown from the native integration menu. Add it to Codex with the shown bearer token:

```toml
[mcp_servers.ide]
url = "http://127.0.0.1:17877/mcp"
bearer_token_env_var = "IDE_CODEX_MCP_TOKEN"
```

The public Codex docs describe `/ide` for Codex-owned IDE surfaces, but do not currently document a Claude-style third-party lockfile protocol.

The loopback browser API is read-friendly for local terminal/browser views. Mutating routes, including file writes and editor-context updates, require the same per-run bearer token.

## Verification

```bash
./run-tests.sh
```

`npm audit --audit-level=moderate` currently reports no known npm vulnerabilities.

`run-tests.sh` runs the npm audit automatically. It also validates the Finder Quick Action generator, checks production bundle budgets for startup JavaScript, startup CSS, and the lazy editor chunk, then runs a browser smoke test against the real React/CSS app shell in light and dark mode. The smoke test uses local Chrome, Chromium, or Edge through `playwright-core`; set `IDE_SMOKE_BROWSER=/path/to/browser` if it cannot find a browser automatically.

`run-tests.sh` also runs `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `cargo check`, and `cargo audit --deny warnings` when `cargo-audit` is installed. Current transitive Rust advisory warnings are reviewed in `src-tauri/.cargo/audit.toml`; new advisory warnings fail the local gate until reviewed.

## Design Constraints

- Avoid heavy editor/runtime dependencies.
- Keep editor and language support lazy-loaded.
- Prefer Rust-native filesystem and process work.
- Keep LSP optional and per-language.
- Do not add GitHub workflows yet.

More detail is in [docs/development.md](docs/development.md).
Security guardrails are tracked in [docs/security.md](docs/security.md).
Source-backed technology notes are in [docs/research.md](docs/research.md).
