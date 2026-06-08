import { describe, expect, it } from "vitest";
import { cursorStatus } from "./editorCursor";

describe("editor cursor", () => {
  it("shows the active file caret position before reveal targets", () => {
    expect(
      cursorStatus(
        "src/App.tsx",
        { filePath: "src/App.tsx", line: 8, column: 3 },
        { path: "src/App.tsx", lineNumber: 4 },
      ),
    ).toBe("8:3");
  });

  it("falls back to an active reveal target when the caret is not current", () => {
    expect(
      cursorStatus(
        "src/App.tsx",
        { filePath: "README.md", line: 1, column: 1 },
        { path: "src/App.tsx", lineNumber: 4 },
      ),
    ).toBe("4:1");
  });

  it("ignores stale caret and reveal data", () => {
    expect(
      cursorStatus(
        "src/App.tsx",
        { filePath: "README.md", line: 1, column: 1 },
        { path: "README.md", lineNumber: 4 },
      ),
    ).toBe("");
  });
});
