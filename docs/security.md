# Security

Security is a core product constraint for this IDE. Changes should be reviewed with the assumption that the editor will open untrusted repositories and expose editor context to local agent tools.

## Current Guardrails

- Workspace file reads and writes are resolved relative to the workspace root.
- Absolute paths and parent traversal are rejected.
- File opens are capped at 5 MiB.
- Common generated folders and `.git` are skipped during tree scans.
- LSP markdown is sanitized before display.
- Language servers are discovered through fixed command definitions, not arbitrary user-provided command strings.
- LSP servers are lazy-started only for matching file types.
- Errors should be surfaced to the UI. Do not add empty catches or console-only error handling.

## Rules For Future Changes

- Keep filesystem access on the Rust side unless there is a clear reason not to.
- Treat every path from the frontend as untrusted.
- Prefer allowlists over denylists for commands and protocols.
- Do not execute repo-provided scripts automatically.
- Do not send editor context to remote services without an explicit user action and visible destination.
- Keep local HTTP endpoints bound to loopback.
- Add tests for path handling, protocol framing, and error handling whenever those surfaces change.

## Review Checklist

Before committing security-sensitive changes:

- Can an untrusted workspace escape the root path?
- Can an untrusted file trigger process execution?
- Can an LSP or agent message inject HTML or script?
- Are failures visible to the user?
- Are large files, generated folders, and long-running processes bounded?
- Is the behavior covered by tests?
