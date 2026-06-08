import { describe, expect, it } from "vitest";
import {
  currentFileMatches,
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

  it("cycles current-file match selection in both directions", () => {
    expect(nextCurrentFileMatchIndex(-1, 1, 3)).toBe(0);
    expect(nextCurrentFileMatchIndex(0, 1, 3)).toBe(1);
    expect(nextCurrentFileMatchIndex(2, 1, 3)).toBe(0);
    expect(nextCurrentFileMatchIndex(-1, -1, 3)).toBe(2);
    expect(nextCurrentFileMatchIndex(0, -1, 3)).toBe(2);
    expect(nextCurrentFileMatchIndex(99, 1, 3)).toBe(0);
    expect(nextCurrentFileMatchIndex(0, 1, 0)).toBe(-1);
  });
});
