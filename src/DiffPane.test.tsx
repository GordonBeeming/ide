import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import DiffPane from "./DiffPane";

vi.mock("./language", () => ({
  languageForPath: vi.fn(async () => []),
}));

describe("DiffPane", () => {
  beforeAll(() => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 0, 0),
    });
  });

  it("renders a single unified editor in inline mode", async () => {
    const { container } = render(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="inline"
        onViewModeChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".cm-editor")).toBeInTheDocument();
    });
    // Inline mode is one editor, not a MergeView with two panes.
    expect(container.querySelector(".cm-mergeView")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(container.querySelector(".cm-merge-a")).not.toBeInTheDocument();
    expect(container.querySelector(".cm-merge-b")).toBeInTheDocument();
  });

  it("renders two editors (original + modified panes) in side-by-side mode", async () => {
    const { container } = render(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="sideBySide"
        onViewModeChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".cm-mergeView")).toBeInTheDocument();
    });
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(2);
    expect(container.querySelector(".cm-merge-a")).toBeInTheDocument();
    expect(container.querySelector(".cm-merge-b")).toBeInTheDocument();
  });

  it("rebuilds the view when switching modes", async () => {
    const { container, rerender } = render(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="inline"
        onViewModeChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeInTheDocument());
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);

    rerender(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="sideBySide"
        onViewModeChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(container.querySelectorAll(".cm-editor")).toHaveLength(2));
  });

  it("shows the toolbar with the active mode marked and calls back on click", async () => {
    const onViewModeChange = vi.fn();
    render(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="inline"
        onViewModeChange={onViewModeChange}
      />,
    );

    const inlineButton = await screen.findByTitle("Inline diff");
    const sideBySideButton = await screen.findByTitle("Side-by-side diff");
    expect(inlineButton).toHaveClass("tiny-icon-button--active");
    expect(inlineButton).toHaveAttribute("aria-pressed", "true");
    expect(sideBySideButton).not.toHaveClass("tiny-icon-button--active");
    expect(sideBySideButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(sideBySideButton);
    expect(onViewModeChange).toHaveBeenCalledWith("sideBySide");
  });

  it("still shows the toolbar for binary and too-large fallbacks", async () => {
    const { rerender } = render(
      <DiffPane
        filePath="image.png"
        original=""
        modified=""
        isBinary
        isTooLarge={false}
        viewMode="inline"
        onViewModeChange={vi.fn()}
      />,
    );
    expect(await screen.findByTitle("Inline diff")).toBeInTheDocument();
    expect(await screen.findByText("Binary file — no text diff to show.")).toBeInTheDocument();

    rerender(
      <DiffPane
        filePath="huge.log"
        original=""
        modified=""
        isBinary={false}
        isTooLarge
        viewMode="inline"
        onViewModeChange={vi.fn()}
      />,
    );
    expect(await screen.findByTitle("Inline diff")).toBeInTheDocument();
    expect(await screen.findByText("File too large to diff.")).toBeInTheDocument();
  });
});
