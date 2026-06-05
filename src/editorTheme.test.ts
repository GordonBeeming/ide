import { describe, expect, it, vi } from "vitest";
import { editorThemeExtensions } from "./editorTheme";
import { darkSchemeQuery, systemPrefersDark } from "./systemTheme";

describe("editor theme", () => {
  it("uses the one dark extension only when the system prefers dark mode", () => {
    expect(editorThemeExtensions(false)).toHaveLength(1);
    expect(editorThemeExtensions(true)).toHaveLength(2);
  });

  it("reads the system dark-mode media query", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMedia);

    expect(systemPrefersDark()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(darkSchemeQuery);

    vi.unstubAllGlobals();
  });
});
