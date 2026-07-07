import { EditorView } from "@codemirror/view";

// Scoped to the diff view; overrides @codemirror/merge's default green/red
// base theme so additions read blue (--accent) and deletions red (--danger),
// matching the rest of the app's palette instead of a generic diff green.
export const diffTheme = EditorView.theme({
  // Additions & changed lines.
  ".cm-changedLine": {
    backgroundColor: "color-mix(in oklch, var(--accent) 12%, transparent)",
  },
  ".cm-changedText": {
    // Intra-line changed tokens get the stronger wash so edits read at a glance.
    backgroundColor: "color-mix(in oklch, var(--accent) 26%, transparent)",
    borderRadius: "2px",
  },
  ".cm-changedLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--accent) 22%, transparent)",
  },
  // Removals. Deleted lines render as block widgets in the unified view.
  ".cm-deletedChunk": {
    backgroundColor: "color-mix(in oklch, var(--danger) 10%, transparent)",
    color: "var(--muted)",
  },
  ".cm-deletedText": {
    backgroundColor: "color-mix(in oklch, var(--danger) 24%, transparent)",
    borderRadius: "2px",
  },
  ".cm-deletedLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--danger) 22%, transparent)",
  },
  // Folded unchanged regions between chunks.
  ".cm-collapsedLines": {
    color: "var(--muted)",
    backgroundColor: "var(--panel)",
    fontSize: "11px",
  },
});
