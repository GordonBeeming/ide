import DOMPurify from "dompurify";
import { marked } from "marked";
import "./MarkdownPreview.css";

export function renderMarkdown(contents: string) {
  try {
    return DOMPurify.sanitize(marked.parse(contents, { async: false }) as string);
  } catch (error) {
    console.error("Failed to render Markdown:", error);
    return DOMPurify.sanitize(contents);
  }
}
