# Development

## Local Run

Run the desktop app from the repository root:

```bash
./run.sh
```

The script checks for `npm` and `cargo`, installs Node dependencies when `node_modules` is missing, then starts Tauri dev mode.

Pass a file or folder path to open that target as the launch workspace:

```bash
./run.sh /path/to/workspace
./run.sh /path/to/workspace/src/App.tsx
```

Folder targets become the workspace root. File targets open their parent folder as the workspace and then open the file as a persistent tab.

When a file or folder target is supplied and an Ide instance is already reachable on the loopback API, `run.sh` authenticates with the per-run bearer token and hands the target to `/api/open-path` instead of starting another dev instance.

When no target is supplied and an Ide instance is already reachable, `run.sh` tries to activate the existing macOS app and exits without starting a duplicate dev process. This avoids the Vite port and Cargo build-lock failures that happen when two dev instances are started from the same checkout.

Install the macOS Finder Quick Action:

```bash
./scripts/install-macos-finder-quick-action.sh
```

The service appears under Finder's Quick Actions menu as `Open in Ide`. It hands the selected file or folder to an already-running app through the loopback open-path endpoint when possible, otherwise it starts the local dev app in the background. Launcher logs are written to `~/Library/Logs/Ide/finder-open.log`.

`npm run finder:check` validates the generated Quick Action and runner in a temporary directory. It verifies that the service registers for files and folders, emits a valid plist/workflow, and hands targets to `/api/open-path` with the local bearer token before `run-tests.sh` moves on to browser smoke tests.

Packaged builds declare Tauri `bundle.fileAssociations` for common text, code, web, config, and .NET project files. Tauri emits `RunEvent::Opened` when the OS opens a file with the app; the Rust backend converts those file URLs into the same open-file/open-workspace payloads used by the native menu, stores cold-start requests until the frontend drains them, and emits live requests when the app is already running.

## Manual Commands

Run the full local verification suite:

```bash
./run-tests.sh
```

Or run individual checks:

```bash
npm install
npm run build
npm run budget
npm test
npm run finder:check
npm run launch:check
npm run menu:check
npm run tauri:check
npm run smoke
npm audit --audit-level=moderate
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo check
cd src-tauri && cargo test
cd src-tauri && cargo audit
npm run tauri:dev
```

`npm run budget` checks the production `dist/` output after `npm run build`. Current raw-size limits are 600 KB for startup JavaScript, 80 KB for startup CSS, and 90 KB for the lazy editor chunk. These are deliberately above the current app size, but low enough to catch accidental heavy runtime dependencies.

`npm run finder:check` runs the macOS Finder Quick Action installer against temporary service/support directories, lints the generated workflow on macOS, and checks that the runner uses the authenticated loopback open-path handoff. It does not touch the real `~/Library/Services` directory.

`npm run launch:check` validates the local launch runners. It checks that `run.sh` and the generated Finder runner both use the authenticated loopback open-path handoff before attempting to start or reuse a dev server.

`npm run menu:check` validates the native menu contract. It checks that every declared Tauri menu item has a Rust route, every expected native event is emitted by Rust, and every emitted app/menu event has a React listener.

`npm run tauri:check` validates the Tauri bundle metadata that affects native daily-driver behavior. It checks the developer-tool category, file association shape, required common editor extensions, text-only MIME types, duplicate extensions, and rejects obvious binary/media/archive associations.

`npm run smoke` starts Vite on a local ephemeral port, mocks the loopback API, and drives the real app shell through a local Chromium-family browser in light and dark mode. It covers collapsed search controls, command palette execution, workspace filtering, content search, opening a file, clean-save button state, and shell/editor theme alignment for both the empty editor canvas and the loaded CodeMirror canvas. The theme check asserts matching computed colors, expected light/dark luminance, and the actual painted editor center color, then temporarily forces the opposite editor-region theme class to prove the editor background still inherits from the shell. Set `IDE_SMOKE_BROWSER=/path/to/browser` if the script cannot find Chrome, Chromium, or Edge.

`run-tests.sh` runs `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `cargo check`, and `cargo audit` when `cargo-audit` is installed. If `cargo-audit` is missing, the script prints an explicit warning so the advisory scan gap is visible.

## Architecture

The app is intentionally split into a small always-loaded shell and lazy-loaded editor pieces.

- `src/App.tsx`: workspace shell, tree view, tabs, keyboard navigation, file/folder create, delete/open/rename/save orchestration.
- `src/EditorPane.tsx`: CodeMirror editor. Loaded only after a file is opened.
- `src/EditorPane.test.tsx`: real CodeMirror component coverage for programmatic content sync, including reload-from-disk updates that must not report a user edit and unavailable LSP navigation command handling.
- `src/editorTheme.ts`: system-aware CodeMirror theme selection and high-contrast editor styling.
- `src/appWindow.ts`: guarded Tauri window-close integration.
- `src/fileTypes.ts`: package-backed coloured file icon resolution with explicit folder fallbacks.
- `src/quickOpen.ts`: tested quick-open file matching, ranking, editor-openable filtering, and keyboard selection rules. The app feeds it both loaded tree entries and SQLite-indexed workspace metadata so lazily loaded files can still be found; when results are short, quick-open expands unloaded folders through the same Settings-backed scan budget.
- `src/commandPalette.ts`: tested command palette matching, ranking, and keyboard selection rules.
- `src/editorNavigation.ts`: tested line clamping for search-result reveal behavior.
- `src/currentFileSearch.ts`: tested current-file search over loaded and unsaved editor contents.
- `src/App.test.tsx`: rendered shell coverage for non-text file selection, collapsed search controls and Escape dismissal, keyboard tree expansion/opening, accessible tree selection/expanded state, categorized Settings navigation, preview-tab lifecycle, dirty-tab save-and-close prompts, native Close Tab/Close All/Search menu handling, native menu blocking while modal dialogs are open, command-palette file opening, keyboard file/folder creation shortcuts, keyboard tab switching, go-to-line navigation and validation, caret status reporting, current-file search navigation, precise diagnostic navigation, new-file/folder creation, file/folder rename/delete, reload-from-disk behavior, stale-save handling, Save All success/failure behavior, active-file-safe agent selection context, and content search result/error behavior.
- `src/tauri.test.ts`: hosted browser transport coverage for bearer-token file/folder creation, native-only file picking, file rename/delete/writes, stale-save tokens, and loopback API base selection.
- `scripts/bundle-budget.mjs`: production bundle budget coverage for startup assets and the lazy editor chunk.
- `scripts/validate-finder-quick-action.mjs`: non-installing QA for the macOS Finder Quick Action service and generated runner.
- `scripts/validate-launch-runners.mjs`: contract coverage for `run.sh` and the Finder runner startup/handoff path.
- `scripts/validate-native-menu-contract.mjs`: contract coverage that keeps Tauri menu items, Rust emitted events, and React native-event listeners aligned.
- `scripts/smoke-test.mjs`: browser smoke coverage for empty-pane and loaded-editor theme alignment plus core UI flows that are hard to trust from jsdom alone.
- `src/language.ts`: lazy language loaders for common code and config files, including Rust, TypeScript/JavaScript/React, JSON, Markdown, shell, HTML, CSS/SCSS/Sass, C#, C/C++, JVM languages, Python, Go, Ruby, SQL, XML/YAML/TOML, Dockerfiles, PowerShell, diffs, and .NET project files.
- `src-tauri/src/workspace.rs`: Rust-native workspace scanning with explicit truncation metadata, guarded file/folder creation, guarded file/folder rename/delete, and guarded file IO.
- `src-tauri/src/workspace_index.rs`: SQLite-backed workspace metadata index stored under the OS app-local data directory. Initial scans replace the current workspace rows, lazy folder loads and quick-open expansion refresh direct children, folder-frontier state tracks what has been expanded, and editor file mutations upsert or remove affected paths plus stale frontier rows.
- `src-tauri/src/http_server.rs`: loopback HTTP API, browser endpoint static asset server with SPA fallback and missing asset 404s, authenticated write routes, and authenticated read-only Codex MCP endpoint.
- `src-tauri/src/claude_bridge.rs`: authenticated Claude Code IDE WebSocket bridge.
- `src-tauri/src/lib.rs`: Tauri command registration and in-memory editor context state.

Security rules live in [security.md](security.md). Treat them as part of the development process, not a release checklist.
Research notes and protocol references live in [research.md](research.md).

## Performance Notes

Current constraints:

- No Monaco editor.
- No filesystem plugin for broad client-side filesystem access.
- Hide dotfiles, dot folders, and generated/internal folders by default, with the categorized native Settings dialog controlling tree visibility, initial tree scan entries, editable file size, search caps, and UI result counts.
- Store tree metadata in the app-local SQLite index instead of keeping an unbounded in-memory tree. The index is disposable and can be rebuilt when the workspace reopens. Initial tree scans report when the Settings-backed entry cap truncated the result set so the UI can explain that deeper entries are loaded on demand. Quick open queries this metadata using the Settings-backed quick-open result cap and, when the current index cannot satisfy the query, expands unloaded folders in layer order within the Settings-backed tree scan cap; stale indexed folders are purged instead of surfaced as search failures. Quick open does not keep a second hidden limit.
- Always ignore `node_modules`, `target`, `dist`, `.git`, and common generated folders during content search.
- Workspace content search runs in Rust, walks the workspace by layer so shallow matches spend the result cap first, skips generated folders and binary-looking files, and applies the Settings-backed result/file-size caps before scanning. File opens use the Settings-backed editable file size cap.
- Keep syntax language packages dynamically imported by extension.
- Keep the editor theme tied to `prefers-color-scheme`; the app shell and CodeMirror surface should not drift into different light/dark modes.
- Keep LSP optional and lazy. Language servers should start only when a matching file type is opened.
- Refresh LSP status from bridge events so the sidebar does not show stale running state after server start or exit.
- Persist LSP `textDocument/publishDiagnostics` messages into backend agent context for read-only Claude and Codex bridge access.

When adding dependencies, check the production bundle:

```bash
npm run build
npm run budget
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

Security verification:

```bash
npm audit --audit-level=moderate
cd src-tauri && cargo audit
```

`cargo audit` requires the `cargo-audit` tool to be installed. If it is missing, install it before treating Rust advisory scanning as complete.

## Workspace Switching

The native folder picker is owned by the Rust backend through `tauri-plugin-dialog`. Switching workspace roots:

- canonicalizes the selected directory
- rejects non-directory paths
- clears open editor tabs in the frontend
- clears backend agent context
- clears backend LSP sessions and frontend LSP client caches so a language server is not reused with the wrong root
- rewrites the Claude bridge lock file workspace metadata

Native OS file-open events reuse the same switching path. Opening a file from the OS uses the file's parent as the workspace root and opens the file as a persistent single-file session; opening a folder still goes through the Open Folder menu, `run.sh`, or the Finder Quick Action because platform file associations do not register folders.

The frontend refuses to switch folders while any open tab is dirty.

## Native Menu and Recents

The app stores recent folders and recent files in the OS app-data directory through Tauri's `app_data_dir`, currently as `recents.json`. This keeps configuration and history out of browser local storage and avoids leaking editor workflow state into the visible UI. Recent files also store whether the file was opened as a single-file launch target, so Finder-opened files reopen without exposing their containing folder in the tree.

The File menu owns:

- `New File`
- `New Folder`
- `Open File...`
- `Open Folder...`
- `Recent Folders`
- `Recent Files`
- `Save`
- `Save All`
- `Reload from Disk`
- `Rename Selected`
- `Delete Selected`
- `Close Tab`
- `Close All`

The Search menu owns:

- `Command Palette...`
- `Go to File...`
- `Go to Line...`
- `Find in File`
- `Find in Files`

Menu selections are delivered to the frontend through Tauri events. The frontend reuses the toolbar and keyboard workflow handlers, including dirty-file guards before closing or reloading files, stale-write checks before saving, and collapsed search controls that open only when requested. Modal dialogs block global IDE shortcuts and native menu actions while still allowing `Escape` to dismiss the active dialog, so save/close/open commands cannot fire behind confirmations or settings.

The command palette exposes the same daily-driver actions from the keyboard. Native-only actions such as `Open File` use Rust-owned Tauri dialog commands and stay disabled in hosted browser mode.

## Editor Workflow

Supported keyboard commands:

- `Cmd/Ctrl+S`: save the active file.
- `Cmd/Ctrl+Shift+S`: save all dirty files.
- `Cmd/Ctrl+R`: reload the active file from disk.
- `Cmd/Ctrl+W`: close the active tab.
- `Cmd/Ctrl+Shift+W`: close all tabs.
- `Cmd/Ctrl+B`: toggle the sidebar.
- `Cmd/Ctrl+O`: open a file with the native picker.
- `Cmd/Ctrl+Shift+O`: open a workspace folder with the native picker.
- `Cmd/Ctrl+Shift+P`: open the command palette.
- `Cmd/Ctrl+F`: open and focus current-file search.
- `Cmd/Ctrl+Shift+F`: open and focus workspace content search.
- `Ctrl+G`: jump to a line in the active file.
- `Cmd/Ctrl+N`: create a new file.
- `Cmd/Ctrl+Shift+N`: create a new folder.
- `Cmd/Ctrl+P`: open the quick-open palette.
- `F2`: rename the selected file or folder.
- `Ctrl+Tab` / `Ctrl+Shift+Tab`: move between open tabs.

Sidebar file filtering, workspace content search, and current-file search stay collapsed until requested; they remain open while they contain query text. `Escape` clears a populated search field first, then collapses the empty field on the next press. Tree rows support keyboard use: `Enter` opens files as preview tabs or toggles folders, `Space` toggles folders, and `ArrowRight` / `ArrowLeft` expand or collapse folders. Quick open lists editor-supported files only, so common binary/media/font/archive files are selectable in the tree without being offered as editor targets. Current-file search runs against the active tab contents, including unsaved edits, can reveal a matched line in the editor, and cycles matches with `Enter` / `Shift+Enter`. The status bar reports the active editor caret position without publishing empty selections into agent context. Common binary, media, font, archive, and executable file types select in the tree without attempting text-editor reads. New-file and new-folder creation use the selected folder or selected file's parent as the default path and reject existing targets. New-file and new-folder creation also creates missing parent directories for explicit nested paths such as `src/features/new.tsx` or `src/features/editor`. New files open as persistent tabs with their first scanned `modifiedMs`, so their first save gets the same stale-write protection as opened files. File and folder rename reject existing destination paths; file rename refreshes the renamed tab's `modifiedMs`, while folder rename updates any open child tab paths, expanded folder state, diagnostics, reveal state, and selection context. File and folder deletion require confirmation; deleting a folder also closes any open tabs under the folder and removes related diagnostics/context. Reload from disk refreshes the active file contents and modification timestamp; dirty files require confirmation before unsaved edits are discarded. Saves send the file's last known `modifiedMs`; if the disk file changed since it was opened, the backend returns a conflict and the tab remains dirty. Save All walks dirty tabs in order and stops at the first failed write so the error remains visible to the user. Close All uses the same dirty-file confirmation and failed-save behavior before clearing tabs.

## LSP Direction

The planned LSP support is:

- Rust: `rust-analyzer`
- TypeScript/React: `typescript-language-server`
- C#: OmniSharp or C# Dev Kit compatible language server when available outside VS Code

The editor should use the official `@codemirror/lsp-client` transport interface. The Rust backend should own language-server process management so the UI can stay browser-safe and avoid spawning processes from the frontend.

`@codemirror/lsp-client` currently provides the editor-side keymaps for definition/declaration/type-definition/implementation jumps, references, rename, formatting, completion, hover, and signature help through `languageServerExtensions()`. The native Navigate menu also forwards Go to Definition and Find References to the active lazy-loaded editor so those actions are discoverable without loading editor code into the shell. LSP workspace roots and document paths must be encoded as file URIs with tests for spaces, Windows-style drive roots, and rejected workspace escapes. Diagnostics are persisted for bridge access and shown in the sidebar diagnostics panel with `file:line:column` targets; single click opens a preview tab at the diagnostic line, while double click pins the tab.

The TypeScript language server is reused for `.ts`, `.tsx`, `.js`, and `.jsx` files, but editor documents must still use path-specific language IDs: `typescript`, `typescriptreact`, `javascript`, and `javascriptreact`. This keeps React and JavaScript files aligned with TypeScript server expectations without launching separate servers.

Changing workspace roots must disconnect cached frontend LSP clients and dispose their Tauri event listeners. The backend already stops server processes during a root switch, and the frontend cache must not reconnect a CodeMirror document to a stale root/session pair.

## Agent Context Direction

The app tracks active file, open files, and selected text through shared backend state. Current bridge surfaces:

- Claude-compatible localhost IDE bridge using `~/.claude/ide/*.lock`, WebSocket MCP, and a per-run auth token.
- Codex-compatible localhost MCP endpoint over HTTP with a per-run bearer token.
- Local HTTP context endpoint for terminal/browser integrations.

The local HTTP API supports terminal/browser views over loopback. `POST /api/file`, `POST /api/folder`, `PATCH /api/file`, `DELETE /api/file`, `PUT /api/file`, and `PUT /api/agent-context` require the per-run bearer token; unauthenticated local callers can read context but cannot mutate files or editor state. `PUT /api/file` accepts an optional `expectedModifiedMs` value and returns `409 Conflict` when it does not match the current disk timestamp.

Selection context is published only when the recorded selection belongs to the current active file. Tab changes and file switches should never leak a stale selection from a previously active editor into Claude or Codex context.

The Claude bridge currently exposes read-only tools:

- `getCurrentSelection`
- `getLatestSelection`
- `getOpenEditors`
- `getWorkspaceFolders`
- `getDiagnostics`

The Codex MCP endpoint exposes equivalent read-only tools with snake_case names:

- `get_current_selection`
- `get_latest_selection`
- `get_open_editors`
- `get_workspace_folders`
- `get_editor_context`
- `get_diagnostics`

Write-capable tools such as `openDiff`, `saveDocument`, or code execution should not be added until the editor has a visible review/confirmation surface for those actions.

Current public Codex docs confirm Codex `/ide` consumes open files and selection context in Codex-owned IDE surfaces, that third-party tools can integrate with Codex through MCP, and that `codex app-server` is the rich-client protocol used by clients such as the Codex VS Code extension. They do not document a Claude-style third-party IDE lockfile protocol. Treat app-server support as a future integration path, not as the current editor-context bridge.
