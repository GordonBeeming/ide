import DOMPurify from "dompurify";
import { marked } from "marked";
import "./MarkdownPreview.css";

const sanitizeOptions = {
  FORBID_ATTR: ["class", "id", "style"],
  FORBID_TAGS: ["style"],
};

export function renderMarkdown(contents: string) {
  try {
    return DOMPurify.sanitize(
      marked.parse(contents, { async: false }) as string,
      sanitizeOptions,
    );
  } catch (error) {
    console.error("Failed to render Markdown:", error);
    return DOMPurify.sanitize(contents, sanitizeOptions);
  }
}
