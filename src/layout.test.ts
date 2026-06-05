import { describe, expect, it } from "vitest";
import { appShellClass, sidebarToggleTitle } from "./layout";

describe("layout state", () => {
  it("adds the collapsed shell modifier only when the sidebar is collapsed", () => {
    expect(appShellClass(false)).toBe("app-shell app-shell--light");
    expect(appShellClass(true)).toBe(
      "app-shell app-shell--light app-shell--sidebar-collapsed",
    );
  });

  it("adds the active system theme class to the app shell", () => {
    expect(appShellClass(false, false)).toBe("app-shell app-shell--light");
    expect(appShellClass(false, true)).toBe("app-shell app-shell--dark");
  });

  it("uses action titles that describe the next sidebar state", () => {
    expect(sidebarToggleTitle(false)).toBe("Collapse sidebar");
    expect(sidebarToggleTitle(true)).toBe("Expand sidebar");
  });
});
