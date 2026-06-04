import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./lsp";

describe("LSP HTML sanitizer", () => {
  it("removes executable nodes and event handlers", () => {
    const sanitized = sanitizeHtml(
      '<p onclick="alert(1)">Docs</p><script>alert(1)</script><iframe srcdoc="<p>x</p>"></iframe>',
    );

    expect(sanitized).toBe("<p>Docs</p>");
  });

  it("removes unsafe URL and style attributes while keeping safe links", () => {
    const sanitized = sanitizeHtml(
      '<a href="javascript:alert(1)" style="color:red">Bad</a><a href="https://example.com">Good</a>',
    );

    expect(sanitized).toBe('<a>Bad</a><a href="https://example.com">Good</a>');
  });

  it("removes remote media elements from language server content", () => {
    const sanitized = sanitizeHtml(
      '<p>Docs</p><img src="https://example.com/pixel.png"><video src="https://example.com/movie.mp4"></video>',
    );

    expect(sanitized).toBe("<p>Docs</p>");
  });
});
