import type { EditorDiagnostic } from "./tauri";

export function diagnosticSeverityLabel(severity: number | undefined) {
  if (severity === 1) return "Error";
  if (severity === 2) return "Warning";
  if (severity === 3) return "Info";
  if (severity === 4) return "Hint";
  return "Diagnostic";
}

export function diagnosticSummary(count: number) {
  return count === 1 ? "1 diagnostic" : `${count} diagnostics`;
}

export function sortDiagnostics(diagnostics: EditorDiagnostic[]) {
  return [...diagnostics].sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.startLine - b.startLine ||
      a.startColumn - b.startColumn,
  );
}

export function diagnosticKey(diagnostic: EditorDiagnostic) {
  return [
    diagnostic.filePath,
    diagnostic.startLine,
    diagnostic.startColumn,
    diagnostic.endLine,
    diagnostic.endColumn,
    diagnostic.message,
  ].join(":");
}
