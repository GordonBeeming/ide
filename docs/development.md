# Development

## Local Run

Run the desktop app from the repository root:

```bash
./run.sh
```

The script checks for `npm` and `cargo`, installs Node dependencies when `node_modules` is missing, then starts Tauri dev mode.

## Manual Commands

Run the full local verification suite:

```bash
./run-tests.sh
```

Or run individual checks:

```bash
npm install
npm run build
npm test
cd src-tauri && cargo check
cd src-tauri && cargo test
npm run tauri:dev
```

## Architecture

The app is intentionally split into a small always-loaded shell and lazy-loaded editor pieces.

- `src/App.tsx`: workspace shell, tree view, tabs, file open/save orchestration.
- `src/EditorPane.tsx`: CodeMirror editor. Loaded only after a file is opened.
- `src/quickOpen.ts`: tested quick-open file matching and ranking.
- `src/editorNavigation.ts`: tested line clamping for search-result reveal behavior.
- `src/language.ts`: lazy language loaders for Rust, TypeScript/JavaScript/React, HTML, CSS, and C#.
- `src-tauri/src/workspace.rs`: Rust-native workspace scanning and guarded file IO.
- `src-tauri/src/http_server.rs`: loopback HTTP API and static asset server for browser/terminal use.
- `src-tauri/src/claude_bridge.rs`: authenticated Claude Code IDE WebSocket bridge.
- `src-tauri/src/lib.rs`: Tauri command registration and in-memory editor context state.

Security rules live in [security.md](security.md). Treat them as part of the development process, not a release checklist.
Research notes and protocol references live in [research.md](research.md).

## Performance Notes

Current constraints:

- No Monaco editor.
- No filesystem plugin for broad client-side filesystem access.
- Ignore `node_modules`, `target`, `dist`, `.git`, and common generated folders during tree scans.
- Workspace content search runs in Rust, skips generated folders and binary-looking files, caps searched file size, and limits returned matches.
- Keep syntax language packages dynamically imported by extension.
- Keep LSP optional and lazy. Language servers should start only when a matching file type is opened.

When adding dependencies, check the production bundle:

```bash
npm run build
```

The initial shell chunk should stay small enough to load quickly before editor/language chunks are requested.

## Tests

Frontend tests use Vitest:

```bash
npm test
```

Backend tests use Cargo:

```bash
cd src-tauri && cargo test
```

Prefer pure helper tests for UI state rules, and Rust unit tests for filesystem, path safety, process detection, and protocol framing. Add heavier rendered UI tests only where the behavior cannot be validated through smaller units.

## Workspace Switching

The native folder picker is owned by the Rust backend through `tauri-plugin-dialog`. Switching workspace roots:

- canonicalizes the selected directory
- rejects non-directory paths
- clears open editor tabs in the frontend
- clears backend agent context
- clears running LSP sessions so a language server is not reused with the wrong root
- rewrites the Claude bridge lock file workspace metadata

The frontend refuses to switch folders while any open tab is dirty.

## LSP Direction

The planned LSP support is:

- Rust: `rust-analyzer`
- TypeScript/React: `typescript-language-server`
- C#: OmniSharp or C# Dev Kit compatible language server when available outside VS Code

The editor should use the official `@codemirror/lsp-client` transport interface. The Rust backend should own language-server process management so the UI can stay browser-safe and avoid spawning processes from the frontend.

## Agent Context Direction

The app tracks active file, open files, and selected text through shared backend state. Current bridge surfaces:

- Claude-compatible localhost IDE bridge using `~/.claude/ide/*.lock`, WebSocket MCP, and a per-run auth token.
- Local HTTP context endpoint for terminal/browser integrations.

The Claude bridge currently exposes read-only tools:

- `getCurrentSelection`
- `getLatestSelection`
- `getOpenEditors`
- `getWorkspaceFolders`
- `getDiagnostics` returning an empty list until diagnostics are persisted by the editor

Write-capable tools such as `openDiff`, `saveDocument`, or code execution should not be added until the editor has a visible review/confirmation surface for those actions.

Codex support should be added where OpenAI documents a compatible third-party custom IDE protocol. Current public docs confirm Codex `/ide` consumes open files and selection context, but do not document a Claude-style third-party lockfile protocol.
