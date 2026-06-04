import { describe, expect, it } from "vitest";
import { appShellClass, sidebarToggleTitle } from "./layout";

describe("layout state", () => {
  it("adds the collapsed shell modifier only when the sidebar is collapsed", () => {
    expect(appShellClass(false)).toBe("app-shell");
    expect(appShellClass(true)).toBe("app-shell app-shell--sidebar-collapsed");
  });

  it("uses action titles that describe the next sidebar state", () => {
    expect(sidebarToggleTitle(false)).toBe("Collapse sidebar");
    expect(sidebarToggleTitle(true)).toBe("Expand sidebar");
  });
});
