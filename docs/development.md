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
- `src/language.ts`: lazy language loaders for Rust, TypeScript/JavaScript/React, HTML, CSS, and C#.
- `src-tauri/src/workspace.rs`: Rust-native workspace scanning and guarded file IO.
- `src-tauri/src/lib.rs`: Tauri command registration and in-memory editor context state.

## Performance Notes

Current constraints:

- No Monaco editor.
- No filesystem plugin for broad client-side filesystem access.
- Ignore `node_modules`, `target`, `dist`, `.git`, and common generated folders during tree scans.
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

## LSP Direction

The planned LSP support is:

- Rust: `rust-analyzer`
- TypeScript/React: `typescript-language-server`
- C#: OmniSharp or C# Dev Kit compatible language server when available outside VS Code

The editor should use the official `@codemirror/lsp-client` transport interface. The Rust backend should own language-server process management so the UI can stay browser-safe and avoid spawning processes from the frontend.

## Agent Context Direction

The app already tracks active file, open files, and selected text through Tauri commands. Planned agent bridge work:

- Claude-compatible localhost IDE bridge using `~/.claude/ide/*.lock`.
- Local HTTP context endpoint for terminal/browser integrations.
- Codex support where public docs expose a compatible custom IDE protocol. Current public docs confirm `/ide` consumes open files and selection context, but do not document a third-party lockfile protocol.
