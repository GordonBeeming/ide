import { describe, expect, it } from "vitest";
import {
  addPreviewTab,
  adjacentTabPath,
  dirtyTabSummary,
  nextActivePathAfterClose,
  numberedTabPath,
  pinTab,
  tabCloseRequiresConfirmation,
  updateTabContents,
  type EditorTab,
} from "./tabs";

const tab = (path: string, pinned = false, dirty = false): EditorTab => ({
  path,
  contents: "",
  dirty,
  pinned,
});

describe("tab state", () => {
  it("replaces an unpinned clean preview tab when another preview opens", () => {
    const result = addPreviewTab([tab("a.ts")], tab("b.ts"));

    expect(result.map((item) => item.path)).toEqual(["b.ts"]);
  });

  it("keeps pinned and dirty tabs when opening a preview", () => {
    const result = addPreviewTab(
      [tab("a.ts", true), tab("b.ts", false, true), tab("c.ts")],
      tab("d.ts"),
    );

    expect(result.map((item) => item.path)).toEqual(["a.ts", "b.ts", "d.ts"]);
  });

  it("pins a tab without changing other tabs", () => {
    const result = pinTab([tab("a.ts"), tab("b.ts")], "b.ts");

    expect(result).toEqual([tab("a.ts"), tab("b.ts", true)]);
  });

  it("first content edit pins the tab permanently", () => {
    const result = updateTabContents([tab("a.ts")], "a.ts", "updated");

    expect(result[0]).toMatchObject({
      contents: "updated",
      dirty: true,
      pinned: true,
    });
  });

  it("chooses the previous remaining tab when closing the active tab", () => {
    const result = nextActivePathAfterClose(
      [tab("a.ts"), tab("b.ts"), tab("c.ts")],
      "c.ts",
      "c.ts",
    );

    expect(result).toBe("b.ts");
  });

  it("keeps active path when closing a non-active tab", () => {
    const result = nextActivePathAfterClose(
      [tab("a.ts"), tab("b.ts")],
      "b.ts",
      "a.ts",
    );

    expect(result).toBe("b.ts");
  });

  it("requires confirmation only for dirty tabs", () => {
    expect(tabCloseRequiresConfirmation([tab("a.ts", true, true)], "a.ts")).toBe(
      true,
    );
    expect(tabCloseRequiresConfirmation([tab("a.ts", true, false)], "a.ts")).toBe(
      false,
    );
    expect(tabCloseRequiresConfirmation([tab("a.ts", true, true)], "b.ts")).toBe(
      false,
    );
  });

  it("summarizes dirty tab counts", () => {
    expect(dirtyTabSummary([])).toBe("0 unsaved files");
    expect(dirtyTabSummary([tab("a.ts", true, true)])).toBe("1 unsaved file");
    expect(dirtyTabSummary([tab("a.ts", true, true), tab("b.ts", true, true)])).toBe(
      "2 unsaved files",
    );
  });

  it("finds adjacent tabs with wrapping", () => {
    const tabs = [tab("a.ts"), tab("b.ts"), tab("c.ts")];

    expect(adjacentTabPath(tabs, "a.ts", 1)).toBe("b.ts");
    expect(adjacentTabPath(tabs, "a.ts", -1)).toBe("c.ts");
    expect(adjacentTabPath(tabs, "c.ts", 1)).toBe("a.ts");
  });

  it("falls back to the first tab when active path is missing", () => {
    expect(adjacentTabPath([tab("a.ts"), tab("b.ts")], undefined, 1)).toBe(
      "b.ts",
    );
    expect(adjacentTabPath([], undefined, 1)).toBeUndefined();
  });

  it("maps numbered shortcuts to tabs and reserves 9 for the last tab", () => {
    const tabs = [
      tab("1.ts"),
      tab("2.ts"),
      tab("3.ts"),
      tab("4.ts"),
      tab("5.ts"),
      tab("6.ts"),
      tab("7.ts"),
      tab("8.ts"),
      tab("9.ts"),
      tab("10.ts"),
    ];

    expect(numberedTabPath(tabs, "1")).toBe("1.ts");
    expect(numberedTabPath(tabs, "8")).toBe("8.ts");
    expect(numberedTabPath(tabs, "9")).toBe("10.ts");
  });

  it("ignores invalid numbered shortcut keys", () => {
    expect(numberedTabPath([tab("a.ts")], "0")).toBeUndefined();
    expect(numberedTabPath([tab("a.ts")], "a")).toBeUndefined();
    expect(numberedTabPath([tab("a.ts")], "10")).toBeUndefined();
  });
});
