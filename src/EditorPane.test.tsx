import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EditorPane from "./EditorPane";

vi.mock("./language", () => ({
  languageForPath: vi.fn(async () => []),
}));

vi.mock("./lsp", () => ({
  lspExtensionsForPath: vi.fn(async () => []),
}));

describe("EditorPane", () => {
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
});

function editorText(container: HTMLElement) {
  return container.querySelector(".cm-content")?.textContent ?? "";
}
