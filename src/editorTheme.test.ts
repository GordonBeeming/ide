import { describe, expect, it, vi } from "vitest";
import { codeFontStack, editorThemeExtensions } from "./editorTheme";
import { darkSchemeQuery, systemPrefersDark } from "./systemTheme";

describe("editor theme", () => {
  it("uses the one dark extension only when the system prefers dark mode", () => {
    expect(editorThemeExtensions(false)).toHaveLength(1);
    expect(editorThemeExtensions(true)).toHaveLength(2);
  });

  it("defaults to the IBM Plex Mono stack when no code font is given", () => {
    expect(editorThemeExtensions(false)).toHaveLength(1);
  });

  it("maps each code font setting to its font stack", () => {
    expect(codeFontStack("ibm-plex-mono")).toContain("'IBM Plex Mono'");
    expect(codeFontStack("system-mono")).not.toContain("IBM Plex Mono");
    expect(codeFontStack("system-mono")).toContain("ui-monospace");
  });

  it("reads the system dark-mode media query", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMedia);

    expect(systemPrefersDark()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(darkSchemeQuery);

    vi.unstubAllGlobals();
  });
});
