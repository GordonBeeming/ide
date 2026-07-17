import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaidMocks }));

import { renderMermaidDiagrams } from "./mermaidRenderer";

describe("renderMermaidDiagrams", () => {
  beforeEach(() => {
    mermaidMocks.initialize.mockReset();
    mermaidMocks.render.mockReset();
  });

  it("renders diagrams with strict Mermaid security and the active theme", async () => {
    const diagram = document.createElement("div");
    diagram.textContent = "flowchart LR\nA --> B";
    document.body.append(diagram);
    const bindFunctions = vi.fn();
    mermaidMocks.render.mockResolvedValue({
      svg: '<svg aria-label="Rendered diagram"></svg>',
      bindFunctions,
    });

    await renderMermaidDiagrams([diagram], true);

    expect(mermaidMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        startOnLoad: false,
        suppressErrorRendering: true,
        theme: "dark",
      }),
    );
    expect(mermaidMocks.render).toHaveBeenCalledWith(
      expect.stringMatching(/^markdown-mermaid-/),
      "flowchart LR\nA --> B",
    );
    expect(diagram.querySelector("svg")).not.toBeNull();
    expect(bindFunctions).toHaveBeenCalledWith(diagram);
  });

  it("keeps the source visible when a diagram is invalid", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const diagram = document.createElement("div");
    diagram.innerHTML = "<pre>not a diagram</pre>";
    document.body.append(diagram);
    mermaidMocks.render.mockRejectedValue(new Error("invalid diagram"));

    try {
      await renderMermaidDiagrams([diagram], false);

      expect(diagram).toHaveAttribute("data-mermaid-error", "true");
      expect(diagram).toHaveTextContent("not a diagram");
      expect(error).toHaveBeenCalledWith(
        "Failed to render Mermaid diagram:",
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }
  });
});
