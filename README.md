# Ide

A lean Tauri-based integrated development environment built for speed, local control, and agent-friendly editor context.

The goal is not to recreate Visual Studio Code. The goal is a focused editor shell that opens fast, keeps background work explicit, and exposes useful context to tools like Claude Code and Codex.

## Current State

Implemented:

- Tauri 2 desktop shell with a Rust backend.
- React frontend.
- File tree with file and folder icons.
- Guarded Rust-native workspace scanning and file read/write commands.
- CodeMirror 6 editor.
- Syntax highlighting for Rust, TypeScript, JavaScript, React/TSX/JSX, HTML, CSS, and C#.
- Lazy editor loading and lazy language loading for better startup performance.
- System light/dark mode via `prefers-color-scheme` with a high-contrast bias.
- Active file, open file, and selection context stored in backend state.

Planned:

- LSP process manager for Rust, TypeScript/React, and C#.
- Go-to definition and richer diagnostics through CodeMirror LSP integration.
- Claude Code `/ide` compatible local bridge.
- Local HTTP context endpoint for terminal/browser integrations.
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

## Verification

```bash
npm run build
cd src-tauri && cargo check
```

## Design Constraints

- Avoid heavy editor/runtime dependencies.
- Keep editor and language support lazy-loaded.
- Prefer Rust-native filesystem and process work.
- Keep LSP optional and per-language.
- Do not add GitHub workflows yet.

More detail is in [docs/development.md](docs/development.md).
