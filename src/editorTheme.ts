import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export function editorThemeExtensions(prefersDark: boolean): Extension[] {
  return prefersDark ? [oneDark, highContrastTheme] : [highContrastTheme];
}

// oneDark ships its own hardcoded palette (background, gutter, selection,
// accents) that Signal's tokens don't drive. Replacing oneDark's syntax
// highlighting entirely (markdown headings/keywords/etc, via a HighlightStyle
// over @lezer/highlight tags) is a separate, much larger project than the
// shell/chrome retheme this covers — so this layer takes the pragmatic path
// the token migration spec allows: keep oneDark for token colors, and let
// this theme (which CodeMirror applies after oneDark and therefore wins on
// shared selectors) override every chrome color oneDark would otherwise set.
const highContrastTheme = EditorView.theme({
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
    fontFamily:
      "'SF Mono', 'Cascadia Code', 'JetBrains Mono', ui-monospace, monospace",
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
