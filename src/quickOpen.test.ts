import { describe, expect, it } from "vitest";
import {
  clampQuickOpenSelection,
  moveQuickOpenSelection,
  quickOpenMatches,
} from "./quickOpen";
import type { FileEntry } from "./tauri";

const file = (path: string, isDir = false): FileEntry => ({
  path,
  name: path.split("/").at(-1) ?? path,
  isDir,
  depth: path.split("/").length - 1,
  size: 0,
});

describe("quick open", () => {
  it("matches files by direct path text first", () => {
    const matches = quickOpenMatches(
      [file("src/App.tsx"), file("src-tauri/src/lib.rs"), file("README.md")],
      "app",
    );

    expect(matches.map((match) => match.path)).toEqual(["src/App.tsx"]);
  });

  it("supports fuzzy ordered character matching", () => {
    const matches = quickOpenMatches(
      [file("src/EditorPane.tsx"), file("src/fileTypes.ts"), file("docs/security.md")],
      "edp",
    );

    expect(matches[0].path).toBe("src/EditorPane.tsx");
  });

  it("excludes directories and respects limits", () => {
    const matches = quickOpenMatches(
      [file("src", true), file("a.ts"), file("b.ts"), file("c.ts")],
      "",
      2,
    );

    expect(matches.map((match) => match.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("wraps keyboard selection through available results", () => {
    expect(moveQuickOpenSelection(0, 1, 3)).toBe(1);
    expect(moveQuickOpenSelection(2, 1, 3)).toBe(0);
    expect(moveQuickOpenSelection(0, -1, 3)).toBe(2);
  });

  it("clamps keyboard selection when results shrink", () => {
    expect(clampQuickOpenSelection(8, 3)).toBe(2);
    expect(clampQuickOpenSelection(-1, 3)).toBe(0);
    expect(clampQuickOpenSelection(4, 0)).toBe(0);
  });
});
