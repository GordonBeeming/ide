import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { CodeFont } from "./tauri";

const CODE_FONT_STACKS: Record<CodeFont, string> = {
  "ibm-plex-mono": "'IBM Plex Mono', ui-monospace, 'SF Mono', 'Menlo', monospace",
  "system-mono": "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace",
};

export function codeFontStack(codeFont: CodeFont): string {
  return CODE_FONT_STACKS[codeFont];
}

export function editorThemeExtensions(
  prefersDark: boolean,
  codeFont: CodeFont = "ibm-plex-mono",
): Extension[] {
  const theme = contentTheme(codeFont);
  return prefersDark ? [oneDark, theme] : [theme];
}

// oneDark ships its own hardcoded palette (background, gutter, selection,
// accents) that Signal's tokens don't drive. Replacing oneDark's syntax
// highlighting entirely (markdown headings/keywords/etc, via a HighlightStyle
// over @lezer/highlight tags) is a separate, much larger project than the
// shell/chrome retheme this covers — so this layer takes the pragmatic path
// the token migration spec allows: keep oneDark for token colors, and let
// this theme (which CodeMirror applies after oneDark and therefore wins on
// shared selectors) override every chrome color oneDark would otherwise set.
function contentTheme(codeFont: CodeFont): Extension {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "var(--editor-font-size, 13px)",
      backgroundColor: "var(--editor-bg)",
      color: "var(--editor-text)",
    },
    ".cm-content": {
      minHeight: "100%",
    },
    ".cm-scroller": {
      fontFamily: CODE_FONT_STACKS[codeFont],
      lineHeight: "1.55",
      backgroundColor: "var(--editor-bg)",
    },
    ".cm-gutters": {
      minHeight: "100%",
      borderRight: "1px solid var(--border)",
      backgroundColor: "var(--editor-gutter-bg)",
      color: "var(--text-subtle)",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in oklch, var(--accent-soft) 34%, transparent)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "color-mix(in oklch, var(--accent-soft) 46%, transparent)",
      color: "var(--text)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--selection-bg)",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--accent)",
    },
  });
}
