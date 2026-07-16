import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MarkdownPreview from "./MarkdownPreview";

describe("MarkdownPreview", () => {
  it("renders live Markdown while preserving the preview scroll position", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <MarkdownPreview contents="# Before" path="README.md">
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );
      const preview = screen.getByRole("region", { name: "Preview README.md" });
      preview.scrollTop = 120;
      fireEvent.scroll(preview);

      rerender(
        <MarkdownPreview contents="## After" path="README.md">
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );
      act(() => vi.advanceTimersByTime(100));

      expect(screen.getByRole("heading", { name: "After" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Before" })).not.toBeInTheDocument();
      expect(preview).toHaveProperty("scrollTop", 120);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the editor mounted when the preview is toggled", () => {
    const { rerender } = render(
      <MarkdownPreview contents="# Preview" path="README.md" visible>
        <textarea aria-label="Editor" />
      </MarkdownPreview>,
    );
    const editor = screen.getByLabelText("Editor");

    rerender(
      <MarkdownPreview contents="# Preview" path="README.md" visible={false}>
        <textarea aria-label="Editor" />
      </MarkdownPreview>,
    );
    rerender(
      <MarkdownPreview contents="# Preview" path="README.md" visible>
        <textarea aria-label="Editor" />
      </MarkdownPreview>,
    );

    expect(screen.getByLabelText("Editor")).toBe(editor);
  });

  it("opens only absolute HTTP(S) links outside the app", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      render(
        <MarkdownPreview
          contents={'[external](https://example.com) [relative](docs/guide.md)'}
          path="README.md"
        >
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );
      const preview = screen.getByRole("region", { name: "Preview README.md" });
      const [external, relative] = Array.from(preview.querySelectorAll("a"));

      fireEvent.click(external);
      fireEvent.click(relative);

      expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it("collapses rapid edits into the final preview", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <MarkdownPreview contents="# First" path="README.md">
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );
      rerender(
        <MarkdownPreview contents="# Second" path="README.md">
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );
      rerender(
        <MarkdownPreview contents="# Final" path="README.md">
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );

      expect(screen.getByRole("heading", { name: "First" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Final" })).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(100));
      expect(screen.getByRole("heading", { name: "Final" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Second" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers hidden edits until the current contents are shown", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <MarkdownPreview contents="# Initial" path="README.md" visible={false}>
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );
      rerender(
        <MarkdownPreview contents="# Intermediate" path="README.md" visible={false}>
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );
      vi.advanceTimersByTime(100);
      rerender(
        <MarkdownPreview contents="# Final" path="README.md" visible={false}>
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );
      rerender(
        <MarkdownPreview contents="# Final" path="README.md" visible>
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );

      expect(screen.queryByRole("heading", { name: "Initial" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Intermediate" })).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(100));
      expect(screen.getByRole("heading", { name: "Final" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes unsafe Markdown and embedded HTML", () => {
    render(
      <MarkdownPreview
        contents={'<script>alert(1)</script>\n<img src="x" onerror="alert(2)">\n[bad](javascript:alert(3))'}
        path="unsafe.md"
      >
        <textarea aria-label="Editor" />
      </MarkdownPreview>,
    );

    const preview = screen.getByRole("region", { name: "Preview unsafe.md" });
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.querySelector("img")).not.toHaveAttribute("onerror");
    expect(preview.querySelector("a[href]")).toBeNull();
  });

  it("lets keyboard users resize the split", () => {
    render(
      <MarkdownPreview contents="preview" path="README.md">
        <textarea aria-label="Editor" />
      </MarkdownPreview>,
    );
    const separator = screen.getByRole("separator", {
      name: "Resize Markdown editor and preview",
    });

    expect(separator).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "55");
  });
});
