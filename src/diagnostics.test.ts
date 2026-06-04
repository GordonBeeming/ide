import { describe, expect, it } from "vitest";
import {
  diagnosticSeverityLabel,
  diagnosticSummary,
  sortDiagnostics,
} from "./diagnostics";
import type { EditorDiagnostic } from "./tauri";

const diagnostic = (
  filePath: string,
  startLine: number,
  severity?: number,
): EditorDiagnostic => ({
  filePath,
  message: "message",
  severity,
  startLine,
  startColumn: 1,
  endLine: startLine,
  endColumn: 2,
});

describe("diagnostics helpers", () => {
  it("labels known LSP diagnostic severities", () => {
    expect(diagnosticSeverityLabel(1)).toBe("Error");
    expect(diagnosticSeverityLabel(2)).toBe("Warning");
    expect(diagnosticSeverityLabel(3)).toBe("Info");
    expect(diagnosticSeverityLabel(4)).toBe("Hint");
    expect(diagnosticSeverityLabel(undefined)).toBe("Diagnostic");
  });

  it("summarizes diagnostic counts", () => {
    expect(diagnosticSummary(0)).toBe("0 diagnostics");
    expect(diagnosticSummary(1)).toBe("1 diagnostic");
    expect(diagnosticSummary(4)).toBe("4 diagnostics");
  });

  it("sorts diagnostics by file and start position", () => {
    const sorted = sortDiagnostics([
      diagnostic("src/b.ts", 3),
      diagnostic("src/a.ts", 8),
      diagnostic("src/a.ts", 2),
    ]);

    expect(sorted.map((item) => `${item.filePath}:${item.startLine}`)).toEqual([
      "src/a.ts:2",
      "src/a.ts:8",
      "src/b.ts:3",
    ]);
  });
});
