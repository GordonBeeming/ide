import { describe, expect, it } from "vitest";
import { languageForPath } from "./language";

describe("language loaders", () => {
  it("loads Markdown highlighting for markdown files", async () => {
    await expect(languageForPath("README.md")).resolves.toHaveLength(1);
    await expect(languageForPath("docs/notes.markdown")).resolves.toHaveLength(1);
  });
});
