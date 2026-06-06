# Research Notes

## Editor Core

- Tauri 2 gives the app a small native shell with Rust-owned filesystem and process work.
- CodeMirror 6 keeps the editor surface modular. Language packages and the LSP client can be lazy-loaded by file type.
- Monaco remains intentionally excluded because this IDE is optimizing for startup cost and controlled feature scope.

## Native File Opening

Tauri 2 supports bundled file associations through `bundle.fileAssociations` in `tauri.conf.json`. The config maps extensions, MIME types, editor/viewer role, and handler rank into platform metadata such as macOS `CFBundleDocumentTypes`/Launch Services and Linux desktop MIME entries.

Tauri emits `RunEvent::Opened` when the OS opens associated files with the app. The event can arrive while the app is already running or during startup, so the backend needs to both emit a live frontend event and store cold-start requests until the frontend drains them.

References:

- https://v2.tauri.app/reference/config/#fileassociation
- https://v2.tauri.app/learn/mobile-file-associations/#handling-opened-files

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

OpenAI documentation currently points to MCP as the supported external tool/context mechanism for Codex CLI and the Codex IDE extension. It also documents `codex app-server` as the JSON-RPC interface used for rich clients such as the Codex VS Code extension. I did not find a public Claude-style third-party IDE lockfile protocol for Codex.

Current implication:

- Keep the app's editor context available locally.
- Keep the implemented standard MCP bridge as the supported Codex editor-context path.
- Treat `codex app-server` as the researched future path for a deep Codex-in-editor client, with review/approval UI and transport authentication designed before any write-capable workflows.
- Do not claim native Codex `/ide` support until OpenAI documents a compatible custom IDE protocol.

References:

- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/ide/slash-commands

## Workspace Indexing And Search

Established editors avoid treating the whole filesystem as an always-resident in-memory tree:

- VS Code delegates closed-file workspace search to ripgrep and applies `search.exclude`, `files.exclude`, ignore files, and `.gitignore` patterns before searching. That is a useful guardrail for this project: excludes and ignore files are part of performance, not just UI polish.
- ripgrep's own default behavior is to recursively search while respecting ignore rules and skipping hidden/binary data unless explicitly overridden.
- SQLite FTS5 is a good future fit for bounded full-text search, especially with external-content tables, but the SQLite docs are explicit that external-content indexes must be kept up to date by the application.
- Tauri exposes OS-conventional app data and app-local-data directories. User settings/recents belong in app data where backup is reasonable; disposable workspace search metadata belongs in app-local data so it can be rebuilt.

Current implementation:

- Keep the tree scan layered and configurable instead of traversing an entire drive on startup.
- Store discovered workspace metadata in a SQLite database under app-local data.
- Replace indexed rows on initial workspace scans.
- Refresh indexed direct children when a folder is lazily expanded.
- Track expanded directory frontiers and let quick-open expand unloaded folders in layer order when the indexed metadata cannot satisfy a query.
- Upsert/remove affected indexed paths after editor file creation, writes, renames, and deletes.
- Keep current streaming content search bounded by Settings-backed result and per-file-size caps.
- Continue to keep generated/internal folders out of content search by default.

Deferred implementation:

- Full-text content indexing should use a bounded SQLite FTS5 design with size limits, binary detection, generated-folder exclusion, and rebuild-on-open behavior before replacing the current streaming Rust content search. The app should not duplicate every file's contents into a persistent database without an explicit cap and clear settings.

References:

- https://github.com/microsoft/vscode/wiki/Search-Issues
- https://github.com/BurntSushi/ripgrep
- https://www.sqlite.org/fts5.html
- https://tauri.app/reference/javascript/api/namespacepath/
