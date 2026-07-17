import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { marked } from "marked";
import { describe, expect, it, vi } from "vitest";
import MarkdownPreview from "./MarkdownPreview";
import { renderMarkdown } from "./markdownRenderer";

async function advancePreview() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

describe("MarkdownPreview", () => {
  it("renders live Markdown while preserving the preview scroll position", async () => {
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
      await advancePreview();

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

  it("opens only absolute HTTP(S) links outside the app", async () => {
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
      await screen.findByRole("link", { name: "external" });
      const [external, relative] = Array.from(preview.querySelectorAll("a"));

      fireEvent.click(external);
      fireEvent.click(relative);

      expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it("collapses rapid edits into the final preview", async () => {
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

      expect(screen.queryByRole("heading", { name: "First" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Final" })).not.toBeInTheDocument();
      await advancePreview();
      expect(screen.getByRole("heading", { name: "Final" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Second" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers hidden edits until the current contents are shown", async () => {
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
      await advancePreview();
      expect(screen.getByRole("heading", { name: "Final" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flash previously rendered contents when the preview is shown again", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <MarkdownPreview contents="# Before" path="README.md">
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );
      await advancePreview();
      expect(screen.getByRole("heading", { name: "Before" })).toBeInTheDocument();

      rerender(
        <MarkdownPreview contents="# After" path="README.md" visible={false}>
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );
      rerender(
        <MarkdownPreview contents="# After" path="README.md">
          <textarea aria-label="Editor" />
        </MarkdownPreview>,
      );

      expect(screen.queryByRole("heading", { name: "Before" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "After" })).not.toBeInTheDocument();
      await advancePreview();
      expect(screen.getByRole("heading", { name: "After" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes unsafe Markdown and embedded HTML", async () => {
    render(
      <MarkdownPreview
        contents={'<style>.app-shell { display: none }</style>\n<script>alert(1)</script>\n<img src="x" style="position: fixed" onerror="alert(2)">\n[bad](javascript:alert(3))'}
        path="unsafe.md"
      >
        <textarea aria-label="Editor" />
      </MarkdownPreview>,
    );

    const preview = screen.getByRole("region", { name: "Preview unsafe.md" });
    await screen.findByRole("img");
    expect(preview.querySelector("style")).toBeNull();
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.querySelector("img")).not.toHaveAttribute("style");
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

  it("falls back to sanitized source when Markdown parsing fails", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const parse = vi.spyOn(marked, "parse").mockImplementationOnce(() => {
      throw new Error("parser failed");
    });
    try {
      expect(renderMarkdown('<strong>Fallback</strong><script>alert(1)</script>'))
        .toBe("<strong>Fallback</strong>");
      expect(error).toHaveBeenCalledWith("Failed to render Markdown:", expect.any(Error));
    } finally {
      parse.mockRestore();
      error.mockRestore();
    }
  });
});
