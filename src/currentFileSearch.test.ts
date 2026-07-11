import { describe, expect, it } from "vitest";
import {
  currentFileMatches,
  currentFileResultWindow,
  nextCurrentFileMatchIndex,
} from "./currentFileSearch";

describe("current file search", () => {
  it("finds case-insensitive matches with line metadata", () => {
    const matches = currentFileMatches(
      "src/App.tsx",
      "const Needle = true;\nconst other = \"needle\";",
      "needle",
    );

    expect(matches).toEqual([
      {
        path: "src/App.tsx",
        lineNumber: 1,
        lineText: "const Needle = true;",
        matchStart: 6,
        matchEnd: 12,
      },
      {
        path: "src/App.tsx",
        lineNumber: 2,
        lineText: 'const other = "needle";',
        matchStart: 15,
        matchEnd: 21,
      },
    ]);
  });

  it("returns empty results for blank queries", () => {
    expect(currentFileMatches("README.md", "readme", "   ")).toEqual([]);
  });

  it("uses browser string offsets for unicode lines", () => {
    const matches = currentFileMatches("README.md", "éé 😀 Needle", "needle");

    expect(matches).toEqual([
      {
        path: "README.md",
        lineNumber: 1,
        lineText: "éé 😀 Needle",
        matchStart: 6,
        matchEnd: 12,
      },
    ]);
  });

  it("keeps offsets stable when case folding expands characters before the match", () => {
    const matches = currentFileMatches("README.md", "İ prefix Needle", "needle");

    expect(matches).toEqual([
      {
        path: "README.md",
        lineNumber: 1,
        lineText: "İ prefix Needle",
        matchStart: 9,
        matchEnd: 15,
      },
    ]);
  });

  it("treats punctuation in queries as literal text", () => {
    const matches = currentFileMatches("README.md", "a.b axb a.b", "a.b");

    expect(matches).toEqual([
      {
        path: "README.md",
        lineNumber: 1,
        lineText: "a.b axb a.b",
        matchStart: 0,
        matchEnd: 3,
      },
      {
        path: "README.md",
        lineNumber: 1,
        lineText: "a.b axb a.b",
        matchStart: 8,
        matchEnd: 11,
      },
    ]);
  });

  it("respects the configured match limit", () => {
    const matches = currentFileMatches("README.md", "a a a", "a", 2);

    expect(matches).toHaveLength(2);
  });

  it("caps preview text on a huge minified line without touching match offsets", () => {
    // ~600KB line, needle repeated so several hundred matches land deep in it.
    const line = `x`.repeat(300_000) + "needle" + `y`.repeat(300_000) + "needle" + "z".repeat(1000);
    const matches = currentFileMatches("app.min.js", line, "needle");

    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.lineText.length).toBeLessThanOrEqual(502);
      expect(match.lineText).toContain("needle");
      expect(match.lineText.startsWith("…")).toBe(true);
      // Full-line offsets are untouched, still index into `line` itself.
      expect(line.slice(match.matchStart, match.matchEnd)).toBe("needle");
    }
  });

  it("leaves short lines untouched (no ellipsis)", () => {
    const shortLine = "const needle = 1;".padEnd(499, " ");
    const matches = currentFileMatches("a.ts", shortLine, "needle");

    expect(matches).toHaveLength(1);
    expect(matches[0].lineText).toBe(shortLine);
    expect(matches[0].lineText).not.toContain("…");
  });

  it("only ellipsizes the far end when the match sits at the very start or end of a long line", () => {
    const longLine = "needle" + "z".repeat(600);
    const startMatches = currentFileMatches("a.ts", longLine, "needle");
    expect(startMatches).toHaveLength(1);
    expect(startMatches[0].lineText.startsWith("…")).toBe(false);
    expect(startMatches[0].lineText.endsWith("…")).toBe(true);
    expect(startMatches[0].lineText.startsWith("needle")).toBe(true);

    const endLine = "z".repeat(600) + "needle";
    const endMatches = currentFileMatches("a.ts", endLine, "needle");
    expect(endMatches).toHaveLength(1);
    expect(endMatches[0].lineText.startsWith("…")).toBe(true);
    expect(endMatches[0].lineText.endsWith("…")).toBe(false);
    expect(endMatches[0].lineText.endsWith("needle")).toBe(true);
  });

  it("cycles current-file match selection in both directions", () => {
    expect(nextCurrentFileMatchIndex(-1, 1, 3)).toBe(0);
    expect(nextCurrentFileMatchIndex(0, 1, 3)).toBe(1);
    expect(nextCurrentFileMatchIndex(2, 1, 3)).toBe(0);
    expect(nextCurrentFileMatchIndex(-1, -1, 3)).toBe(2);
    expect(nextCurrentFileMatchIndex(0, -1, 3)).toBe(2);
    expect(nextCurrentFileMatchIndex(99, 1, 3)).toBe(0);
    expect(nextCurrentFileMatchIndex(0, 1, 0)).toBe(-1);
  });

  it("scrolls the result preview window to follow the active match", () => {
    const results = Array.from({ length: 14 }, (_, index) => index);

    // No active match yet: show the first window.
    expect(currentFileResultWindow(results, -1, 4)).toEqual({
      startIndex: 0,
      items: [0, 1, 2, 3],
    });

    // Active near the start stays pinned to the top.
    expect(currentFileResultWindow(results, 1, 4)).toEqual({
      startIndex: 0,
      items: [0, 1, 2, 3],
    });

    // Mid-list: the active row sits one slot from the bottom (offset limit-2),
    // keeping one item of lookahead visible.
    expect(currentFileResultWindow(results, 5, 4)).toEqual({
      startIndex: 3,
      items: [3, 4, 5, 6],
    });

    // Near the end the window clamps so the last items show and active is still in view.
    expect(currentFileResultWindow(results, 13, 4)).toEqual({
      startIndex: 10,
      items: [10, 11, 12, 13],
    });
  });

  it("handles result windows shorter than the limit and a single-row limit", () => {
    expect(currentFileResultWindow([0, 1], 1, 4)).toEqual({
      startIndex: 0,
      items: [0, 1],
    });
    expect(currentFileResultWindow([0, 1, 2, 3], 2, 1)).toEqual({
      startIndex: 2,
      items: [2],
    });
    expect(currentFileResultWindow([], 0, 4)).toEqual({
      startIndex: 0,
      items: [],
    });
  });
});
