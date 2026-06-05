import { describe, expect, it } from "vitest";
import { iconClassForFile, iconForFile } from "./fileTypes";

describe("file type icons", () => {
  it.each([
    ["package.json", "npm-icon"],
    ["run.sh", "terminal-icon"],
    ["README.md", "book-icon"],
    ["App.tsx", "tsx-icon"],
    ["fileTypes.ts", "ts-icon"],
    ["Cargo.toml", "package-icon"],
    ["Dockerfile", "docker-icon"],
    ["image.png", "image-icon"],
  ])("uses file-icons-js for %s", (fileName, expectedClass) => {
    expect(iconClassForFile(fileName)).toContain(expectedClass);
  });

  it("falls back for unknown files", () => {
    expect(iconClassForFile("archive.unrecognised")).toBeUndefined();
    expect(iconForFile("archive.unrecognised", false).displayName).toBe("File");
  });

  it("keeps configured folder fallbacks for important workspace folders", () => {
    expect(iconForFile(".github", true).displayName).toBe("FolderGit2");
    expect(iconForFile("src", true).displayName).toBe("Folder");
    expect(iconForFile("docs", true).displayName).toBe("Folder");
  });
});
