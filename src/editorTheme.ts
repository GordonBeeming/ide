import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export const darkSchemeQuery = "(prefers-color-scheme: dark)";

export function editorThemeExtensions(prefersDark: boolean): Extension[] {
  return prefersDark ? [highContrastTheme, oneDark] : [highContrastTheme];
}

export function systemPrefersDark(): boolean {
  return Boolean(window.matchMedia?.(darkSchemeQuery).matches);
}

const highContrastTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "var(--bg)",
    color: "var(--text)",
  },
  ".cm-scroller": {
    fontFamily:
      "'SF Mono', 'Cascadia Code', 'JetBrains Mono', ui-monospace, monospace",
    lineHeight: "1.55",
  },
  ".cm-gutters": {
    borderRight: "1px solid var(--border)",
    backgroundColor: "var(--panel)",
    color: "var(--muted)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--accent-weak) 34%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--accent-weak) 46%, transparent)",
    color: "var(--text)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklch, var(--accent) 28%, transparent)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--accent)",
  },
});
