import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EditorPane from "./EditorPane";
import { lspExtensionsForPath } from "./lsp";

vi.mock("./language", () => ({
  languageForPath: vi.fn(async () => []),
}));

vi.mock("./lsp", () => ({
  lspExtensionsForPath: vi.fn(async () => []),
}));

describe("EditorPane", () => {
  beforeEach(() => {
    vi.mocked(lspExtensionsForPath).mockResolvedValue([]);
  });

  it("syncs external content changes without reporting a user edit", async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <EditorPane
        contents="before"
        onChange={onChange}
        onError={vi.fn()}
        onSelection={vi.fn()}
        path="README.md"
      />,
    );

    await waitFor(() => {
      expect(editorText(container)).toContain("before");
    });

    rerender(
      <EditorPane
        contents="after"
        onChange={onChange}
        onError={vi.fn()}
        onSelection={vi.fn()}
        path="README.md"
      />,
    );

    await waitFor(() => {
      expect(editorText(container)).toContain("after");
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the editor usable when LSP startup fails", async () => {
    const onError = vi.fn();
    vi.mocked(lspExtensionsForPath).mockRejectedValueOnce(
      new Error("typescript-language-server was not found on PATH"),
    );
    const { container } = render(
      <EditorPane
        contents="export function App() {}"
        onChange={vi.fn()}
        onError={onError}
        onSelection={vi.fn()}
        path="src/App.tsx"
      />,
    );

    await waitFor(() => {
      expect(editorText(container)).toContain("export function App() {}");
    });
    expect(onError).toHaveBeenCalledWith(
      "Language server unavailable for src/App.tsx: Error: typescript-language-server was not found on PATH",
    );
  });
});

function editorText(container: HTMLElement) {
  return container.querySelector(".cm-content")?.textContent ?? "";
}
