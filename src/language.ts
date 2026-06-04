import type { Extension } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { StreamLanguage } from "@codemirror/language";
import { csharp } from "@codemirror/legacy-modes/mode/clike";

const extensionMap: Record<string, () => Extension> = {
  ".css": css,
  ".cs": () => StreamLanguage.define(csharp),
  ".html": html,
  ".js": () => javascript({ jsx: false, typescript: false }),
  ".jsx": () => javascript({ jsx: true, typescript: false }),
  ".rs": rust,
  ".ts": () => javascript({ jsx: false, typescript: true }),
  ".tsx": () => javascript({ jsx: true, typescript: true }),
};

export function languageForPath(path: string): Extension[] {
  const lower = path.toLowerCase();
  const extension = Object.keys(extensionMap).find((candidate) =>
    lower.endsWith(candidate),
  );
  return extension ? [extensionMap[extension]()] : [];
}
