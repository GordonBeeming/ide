import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
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
    const onNotice = vi.fn();
    vi.mocked(lspExtensionsForPath).mockRejectedValueOnce(
      new Error("typescript-language-server was not found on PATH"),
    );
    const { container } = render(
      <EditorPane
        contents="export function App() {}"
        onChange={vi.fn()}
        onError={onError}
        onNotice={onNotice}
        onSelection={vi.fn()}
        path="src/App.tsx"
      />,
    );

    await waitFor(() => {
      expect(editorText(container)).toContain("export function App() {}");
    });
    expect(onError).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("Language server unavailable for src/App.tsx");
  });

  it("reports unavailable LSP navigation commands without breaking editing", async () => {
    const onNotice = vi.fn();
    const onError = vi.fn();
    const { container, rerender } = render(
      <EditorPane
        contents="export function App() {}"
        onChange={vi.fn()}
        onError={onError}
        onNotice={onNotice}
        onSelection={vi.fn()}
        path="src/App.tsx"
      />,
    );

    await waitFor(() => {
      expect(editorText(container)).toContain("export function App() {}");
    });

    rerender(
      <EditorPane
        contents="export function App() {}"
        editorCommand={{ filePath: "src/App.tsx", name: "goToDefinition", nonce: 1 }}
        onChange={vi.fn()}
        onError={onError}
        onNotice={onNotice}
        onSelection={vi.fn()}
        path="src/App.tsx"
      />,
    );

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        "Go to definition is not available for src/App.tsx",
      ),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("renders current-line Git attribution as ghost text", async () => {
    const onGitCommitClick = vi.fn();
    const commit = {
      sha: "abc123456789",
      shortSha: "abc12345",
      authorName: "Gordon Beeming",
      authoredAtSeconds: Math.floor(Date.now() / 1000) - 60,
      summary: "Add editor attribution",
      actions: [],
    };
    const { container } = render(
      <EditorPane
        contents={"first\nsecond"}
        dateTimeFormat="yyyyMmDdHhMm"
        recentRelativeThreshold="never"
        gitAttribution={{
          path: "src/App.tsx",
          status: "available",
          file: commit,
          lines: [{ lineNumber: 1, commit }],
        }}
        onChange={vi.fn()}
        onError={vi.fn()}
        onGitCommitClick={onGitCommitClick}
        onSelection={vi.fn()}
        path="src/App.tsx"
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".git-attribution-ghost")).toHaveTextContent(
        "Gordon Beeming",
      );
    });
    expect(container.querySelector(".git-attribution-ghost")).toHaveTextContent(
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/,
    );

    fireEvent.click(container.querySelector(".git-attribution-ghost")!);

    expect(onGitCommitClick).toHaveBeenCalledWith(commit);
    expect(editorText(container)).toContain("first");
  });

  it("keeps commit attribution while dirty and marks inserted lines as local edits", async () => {
    const firstCommit = {
      sha: "abc123456789",
      shortSha: "abc12345",
      authorName: "Gordon Beeming",
      authoredAtSeconds: Math.floor(Date.now() / 1000) - 600,
      summary: "Add first line",
      actions: [],
    };
    const secondCommit = {
      sha: "def123456789",
      shortSha: "def12345",
      authorName: "Alex Example",
      authoredAtSeconds: Math.floor(Date.now() / 1000) - 300,
      summary: "Add second line",
      actions: [],
    };
    const attribution = {
      path: "src/App.tsx",
      status: "available" as const,
      file: secondCommit,
      lines: [
        { lineNumber: 1, commit: firstCommit },
        { lineNumber: 2, commit: secondCommit },
      ],
    };
    const props = {
      dateTimeFormat: "yyyyMmDdHhMm" as const,
      gitAttribution: attribution,
      onChange: vi.fn(),
      onError: vi.fn(),
      onGitCommitClick: vi.fn(),
      onSelection: vi.fn(),
      path: "src/App.tsx",
      recentRelativeThreshold: "never" as const,
    };
    const { container, rerender } = render(
      <EditorPane contents={"first\nsecond"} isDirty={false} revealLine={1} {...props} />,
    );

    await waitFor(() => {
      expect(container.querySelector(".git-attribution-ghost")).toHaveTextContent(
        "Gordon Beeming",
      );
    });

    rerender(
      <EditorPane contents={"first\n\nsecond"} isDirty revealLine={2} {...props} />,
    );

    await waitFor(() => {
      expect(container.querySelector(".git-attribution-ghost--dirty")).toHaveTextContent(
        "You",
      );
    });
    expect(container.querySelector(".git-attribution-ghost--dirty")).toHaveTextContent(
      "Unsaved changes",
    );
    expect(container.querySelector(".git-attribution-ghost--dirty")).not.toHaveTextContent(
      "Add second line",
    );

    rerender(
      <EditorPane contents={"first\n\nsecond"} isDirty revealLine={3} {...props} />,
    );

    await waitFor(() => {
      expect(container.querySelector(".git-attribution-ghost")).toHaveTextContent(
        "Alex Example",
      );
    });
    expect(container.querySelector(".git-attribution-ghost")).toHaveTextContent(
      "Add second line",
    );
    expect(container.querySelector(".git-attribution-ghost--dirty")).toBeNull();
  });
});

function editorText(container: HTMLElement) {
  return container.querySelector(".cm-content")?.textContent ?? "";
}
