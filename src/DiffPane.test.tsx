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
        commitModeActive
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
    // The split handle is a side-by-side-only affordance.
    expect(container.querySelector(".diff-split-handle")).not.toBeInTheDocument();
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
        commitModeActive
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".cm-mergeView")).toBeInTheDocument();
    });
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(2);
    expect(container.querySelector(".cm-merge-a")).toBeInTheDocument();
    expect(container.querySelector(".cm-merge-b")).toBeInTheDocument();
    const handle = container.querySelector(".diff-split-handle");
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute("aria-valuenow", "50");
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
        commitModeActive
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
        commitModeActive
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
        commitModeActive
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
        commitModeActive
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
        commitModeActive
      />,
    );
    expect(await screen.findByTitle("Inline diff")).toBeInTheDocument();
    expect(await screen.findByText("File too large to diff.")).toBeInTheDocument();
  });

  it("nudges the split ratio with the keyboard and applies it to the first pane's flex", async () => {
    const { container } = render(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="sideBySide"
        onViewModeChange={vi.fn()}
        commitModeActive
      />,
    );
    await waitFor(() => expect(container.querySelectorAll(".cm-editor")).toHaveLength(2));

    const handle = screen.getByRole("separator", { name: "Resize diff panes" });
    expect(handle).toHaveAttribute("aria-valuenow", "50");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "55");
    const firstPane = container.querySelectorAll<HTMLElement>(".cm-mergeViewEditor")[0];
    expect(firstPane.style.flex).toBe("0 0 55%");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "45");
    expect(firstPane.style.flex).toBe("0 0 45%");
  });

  it("clamps the split ratio to 20-80", async () => {
    render(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="sideBySide"
        onViewModeChange={vi.fn()}
        commitModeActive
      />,
    );
    const handle = await screen.findByRole("separator", { name: "Resize diff panes" });

    for (let i = 0; i < 10; i += 1) {
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
    }
    expect(handle).toHaveAttribute("aria-valuenow", "20");

    for (let i = 0; i < 20; i += 1) {
      fireEvent.keyDown(handle, { key: "ArrowRight" });
    }
    expect(handle).toHaveAttribute("aria-valuenow", "80");
  });

  it("resets the split ratio to 50 when toggling away from side-by-side and back", async () => {
    const { rerender } = render(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="sideBySide"
        onViewModeChange={vi.fn()}
        commitModeActive
      />,
    );
    const handle = await screen.findByRole("separator", { name: "Resize diff panes" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "60");

    rerender(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="inline"
        onViewModeChange={vi.fn()}
        commitModeActive
      />,
    );
    expect(screen.queryByRole("separator", { name: "Resize diff panes" })).not.toBeInTheDocument();

    rerender(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="sideBySide"
        onViewModeChange={vi.fn()}
        commitModeActive
      />,
    );
    expect(await screen.findByRole("separator", { name: "Resize diff panes" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
  });

  it("resets the split ratio to 50 when commit mode is left, without unmounting", async () => {
    const { rerender } = render(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="sideBySide"
        onViewModeChange={vi.fn()}
        commitModeActive
      />,
    );
    const handle = await screen.findByRole("separator", { name: "Resize diff panes" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "65");

    // A pinned side-by-side diff tab stays the active tab when commit mode
    // is left — this component keeps rendering, it just gets the signal.
    rerender(
      <DiffPane
        filePath="src/App.tsx"
        original="before"
        modified="after"
        isBinary={false}
        isTooLarge={false}
        viewMode="sideBySide"
        onViewModeChange={vi.fn()}
        commitModeActive={false}
      />,
    );
    expect(await screen.findByRole("separator", { name: "Resize diff panes" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
  });
});
