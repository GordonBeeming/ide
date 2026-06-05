# Security

Security is a core product constraint for this IDE. Changes should be reviewed with the assumption that the editor will open untrusted repositories and expose editor context to local agent tools.

## Current Guardrails

- Workspace file/folder creation and file rename, deletion, reads, and writes are resolved relative to the workspace root.
- Absolute paths and parent traversal are rejected.
- Existing file operations reject symbolic links, and content search skips symbolic links, so a workspace cannot expose files outside its root through symlink targets.
- File opens are capped at 5 MiB.
- Common generated folders and `.git` are skipped during tree scans.
- Content search skips generated folders, skips binary-looking files, caps searched file size, caps query length, and caps result count.
- New-file creation uses create-new filesystem semantics so existing files are not overwritten, then captures the created file timestamp for first-save conflict detection.
- New-folder creation rejects existing targets.
- File writes can include the file's last known modification timestamp; stale writes are rejected with a conflict instead of overwriting external edits.
- File rename rejects directory sources and existing destination paths.
- File deletion rejects directory sources and requires visible confirmation in the UI.
- Reloading a dirty file from disk requires visible confirmation before unsaved edits are discarded.
- Workspace switching canonicalizes selected directories, clears backend editor context, clears backend LSP sessions, and disconnects frontend LSP client caches.
- LSP markdown is sanitized before display.
- Language servers are discovered through fixed command definitions, not arbitrary user-provided command strings.
- LSP servers are lazy-started only for matching file types.
- LSP diagnostics are stored as structured data in local backend state for read-only bridge access, and diagnostic file URIs must decode to safe workspace-relative paths.
- Local HTTP and Claude bridge servers bind only to `127.0.0.1`.
- Claude IDE bridge discovery uses a user-only `~/.claude/ide/` directory, a `0600` lock file, and a per-run UUID auth token.
- Claude bridge tools are read-only in the first implementation.
- Codex MCP requests require a per-run bearer token and expose only read-only editor context tools. The token is available from the loopback status API because the terminal-browser UI needs to show it.
- Mutating local HTTP browser API routes require the per-run bearer token. Read routes remain available for local terminal/browser views.
- Dev-mode CORS is limited to loopback origins so the Vite frontend can talk to the Rust loopback API without opening the API to arbitrary websites.
- Errors should be surfaced to the UI. Do not add empty catches or console-only error handling.

## Rules For Future Changes

- Keep filesystem access on the Rust side unless there is a clear reason not to.
- Treat every path from the frontend as untrusted.
- Prefer allowlists over denylists for commands and protocols.
- Do not execute repo-provided scripts automatically.
- Do not send editor context to remote services without an explicit user action and visible destination.
- Keep local HTTP and WebSocket endpoints bound to loopback.
- Do not add write-capable agent tools without visible user review and failure states.
- Add tests for path handling, protocol framing, and error handling whenever those surfaces change.

## Review Checklist

Before committing security-sensitive changes:

- Can an untrusted workspace escape the root path?
- Can an untrusted file trigger process execution?
- Can an LSP or agent message inject HTML or script?
- Can a local agent connect without the expected auth token?
- Can a local browser caller mutate files or context without the expected auth token?
- Can an agent tool mutate files without visible confirmation?
- Are failures visible to the user?
- Can a stale editor buffer overwrite changes made outside the app?
- Are large files, generated folders, and long-running processes bounded?
- Does workspace switching clear stale context from local agent integrations?
- Is the behavior covered by tests?
- Have `npm audit --audit-level=moderate` and `cargo audit` been run for dependency-sensitive changes?

## Dependency Advisory Policy

`run-tests.sh` runs `cargo audit --deny warnings` when `cargo-audit` is installed. The policy file at `src-tauri/.cargo/audit.toml` explicitly acknowledges the current transitive warning advisories from the Tauri 2 / Wry Linux GTK stack and Tauri's `urlpattern` dependency.

Do not add advisory IDs to that allowlist casually. New advisories should fail the local gate until they are reviewed, traced to the dependency tree, and either fixed by upgrading/removing the dependency or documented with a narrow rationale.
