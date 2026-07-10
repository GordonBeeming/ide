import { describe, expect, it } from "vitest";
import {
  clampMenuPosition,
  firstMenuIndex,
  lastMenuIndex,
  menuSeparator,
  moveMenuSelection,
  type MenuEntry,
  type MenuItem,
} from "./contextMenu";

const item = (id: string, overrides: Partial<MenuItem> = {}): MenuItem => ({
  id,
  label: id,
  onSelect: () => undefined,
  ...overrides,
});

describe("clampMenuPosition", () => {
  it("keeps a menu that already fits at the cursor position", () => {
    expect(clampMenuPosition(100, 100, 200, 150, 1200, 800)).toEqual({ x: 100, y: 100 });
  });

  it("pulls the menu back from the right edge", () => {
    expect(clampMenuPosition(1150, 100, 200, 150, 1200, 800)).toEqual({ x: 996, y: 100 });
  });

  it("pulls the menu back from the bottom edge", () => {
    expect(clampMenuPosition(100, 780, 200, 150, 1200, 800)).toEqual({ x: 100, y: 646 });
  });

  it("clamps into the corner when both edges overflow", () => {
    expect(clampMenuPosition(1190, 790, 200, 150, 1200, 800)).toEqual({ x: 996, y: 646 });
  });

  it("never places the menu before the margin, even for a menu bigger than the viewport", () => {
    expect(clampMenuPosition(-50, -50, 2000, 2000, 1200, 800)).toEqual({ x: 4, y: 4 });
  });
});

describe("firstMenuIndex / lastMenuIndex", () => {
  it("skips a leading separator", () => {
    const entries: MenuEntry[] = [menuSeparator, item("a"), item("b")];
    expect(firstMenuIndex(entries)).toBe(1);
  });

  it("skips a trailing separator", () => {
    const entries: MenuEntry[] = [item("a"), item("b"), menuSeparator];
    expect(lastMenuIndex(entries)).toBe(1);
  });

  it("skips disabled items at either end", () => {
    const entries: MenuEntry[] = [item("a", { disabled: true }), item("b"), item("c", { disabled: true })];
    expect(firstMenuIndex(entries)).toBe(1);
    expect(lastMenuIndex(entries)).toBe(1);
  });

  it("returns -1 when nothing is selectable", () => {
    const entries: MenuEntry[] = [menuSeparator, item("a", { disabled: true })];
    expect(firstMenuIndex(entries)).toBe(-1);
    expect(lastMenuIndex(entries)).toBe(-1);
  });
});

describe("moveMenuSelection", () => {
  const entries: MenuEntry[] = [
    item("a"),
    menuSeparator,
    item("b", { disabled: true }),
    item("c"),
  ];

  it("steps to the next selectable entry, skipping separators", () => {
    expect(moveMenuSelection(entries, 0, 1)).toBe(3);
  });

  it("steps to the previous selectable entry, skipping disabled items", () => {
    expect(moveMenuSelection(entries, 3, -1)).toBe(0);
  });

  it("wraps from the last entry to the first", () => {
    expect(moveMenuSelection(entries, 3, 1)).toBe(0);
  });

  it("wraps from the first entry to the last", () => {
    expect(moveMenuSelection(entries, 0, -1)).toBe(3);
  });

  it("returns -1 for an empty menu", () => {
    expect(moveMenuSelection([], -1, 1)).toBe(-1);
  });

  it("returns -1 when every entry is a separator or disabled", () => {
    const allDisabled: MenuEntry[] = [menuSeparator, item("a", { disabled: true })];
    expect(moveMenuSelection(allDisabled, 0, 1)).toBe(-1);
  });
});
