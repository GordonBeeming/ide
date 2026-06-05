import { describe, expect, it } from "vitest";
import { languageForPath } from "./language";

describe("language loaders", () => {
  it.each([
    "README.md",
    "docs/notes.markdown",
    "docs/page.mdx",
    "package.json",
    "tsconfig.jsonc",
    "scripts/run.sh",
    ".zshrc",
    "Dockerfile",
    "docker-compose.yml",
    "Cargo.lock",
    "pyproject.toml",
    "src/main.py",
    "src/app.go",
    "src/query.sql",
    "src/main.cpp",
    "src/Main.java",
    "src/App.tsx",
    "src/App.mts",
    "src/styles.scss",
    "src/config.xml",
    "src/schema.proto",
    "src/file.diff",
    "src/Program.cs",
    "src/Web.csproj",
    "src/Library.fsproj",
    "src/Legacy.vbproj",
    "src/script.ps1",
    ".editorconfig",
  ])("loads highlighting for %s", async (path) => {
    await expect(languageForPath(path)).resolves.toHaveLength(1);
  });

  it("returns no highlighting extension for unsupported file types", async () => {
    await expect(languageForPath("assets/logo.unknown")).resolves.toEqual([]);
  });
});
