# Security

Security is a core product constraint for this IDE. Changes should be reviewed with the assumption that the editor will open untrusted repositories and expose editor context to local agent tools.

## Current Guardrails

- Workspace file reads and writes are resolved relative to the workspace root.
- Absolute paths and parent traversal are rejected.
- File opens are capped at 5 MiB.
- Common generated folders and `.git` are skipped during tree scans.
- Content search skips generated folders, skips binary-looking files, caps searched file size, caps query length, and caps result count.
- Workspace switching canonicalizes selected directories, clears backend editor context, and clears LSP sessions.
- LSP markdown is sanitized before display.
- Language servers are discovered through fixed command definitions, not arbitrary user-provided command strings.
- LSP servers are lazy-started only for matching file types.
- Local HTTP and Claude bridge servers bind only to `127.0.0.1`.
- Claude IDE bridge discovery uses a user-only `~/.claude/ide/` directory, a `0600` lock file, and a per-run UUID auth token.
- Claude bridge tools are read-only in the first implementation.
- Codex MCP requests require a per-run bearer token and expose only read-only editor context tools. The token is available from the loopback status API because the terminal-browser UI needs to show it.
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
- Can an agent tool mutate files without visible confirmation?
- Are failures visible to the user?
- Are large files, generated folders, and long-running processes bounded?
- Does workspace switching clear stale context from local agent integrations?
- Is the behavior covered by tests?
