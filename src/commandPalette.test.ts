import { describe, expect, it } from "vitest";
import {
  clampCommandPaletteSelection,
  commandPaletteMatches,
  moveCommandPaletteSelection,
  type CommandPaletteEntry,
} from "./commandPalette";

const command = (
  id: string,
  title: string,
  keywords: string[] = [],
): CommandPaletteEntry => ({
  id,
  title,
  keywords,
});

describe("command palette", () => {
  it("matches commands by title, id, and keywords", () => {
    const matches = commandPaletteMatches(
      [
        command("find_in_files", "Find in Files", ["workspace search"]),
        command("quick_open", "Go to File", ["open file"]),
        command("save_all", "Save All"),
      ],
      "workspace",
    );

    expect(matches.map((match) => match.id)).toEqual(["find_in_files"]);
  });

  it("supports fuzzy ordered character matching", () => {
    const matches = commandPaletteMatches(
      [
        command("show_integrations", "Show Integrations"),
        command("toggle_sidebar", "Toggle Sidebar"),
      ],
      "tsi",
    );

    expect(matches[0].id).toBe("toggle_sidebar");
  });

  it("respects result limits", () => {
    const matches = commandPaletteMatches(
      [
        command("a", "A"),
        command("b", "B"),
        command("c", "C"),
      ],
      "",
      2,
    );

    expect(matches.map((match) => match.id)).toEqual(["a", "b"]);
  });

  it("wraps keyboard selection through available results", () => {
    expect(moveCommandPaletteSelection(0, 1, 3)).toBe(1);
    expect(moveCommandPaletteSelection(2, 1, 3)).toBe(0);
    expect(moveCommandPaletteSelection(0, -1, 3)).toBe(2);
  });

  it("clamps keyboard selection when results shrink", () => {
    expect(clampCommandPaletteSelection(8, 3)).toBe(2);
    expect(clampCommandPaletteSelection(-1, 3)).toBe(0);
    expect(clampCommandPaletteSelection(4, 0)).toBe(0);
  });
});
