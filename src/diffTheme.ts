import { EditorView } from "@codemirror/view";

// Scoped to the diff view; overrides @codemirror/merge's default green/red
// base theme so additions read blue (--accent) and deletions red (--danger),
// matching the rest of the app's palette instead of a generic diff green.
//
// `!important` here is load-bearing, not decorative. @codemirror/merge ships
// its defaults via `EditorView.baseTheme()` under selectors scoped to the
// unified view's root class, e.g. `&light.cm-merge-b .cm-changedLineGutter`.
// CodeMirror's theme precedence only orders same-specificity rules; it can't
// out-rank a rule whose selector is simply more specific than ours, and the
// library's scoped selectors are more specific than the bare hook classes
// below. Matching that scoping exactly would be brittle (it's an internal
// implementation detail the library could change in a patch release), so
// `!important` wins regardless of how the library scopes its own rule.
// `.cm-changedText`/`.cm-deletedText` also set the `background` SHORTHAND
// here (not just `background-color`) because the library's default for both
// is a background-image (a dotted-underline gradient) — clearing only the
// color would leave that image showing through.
export const diffTheme = EditorView.theme({
  // Additions & changed lines.
  ".cm-changedLine": {
    backgroundColor: "color-mix(in oklch, var(--accent) 12%, transparent) !important",
  },
  ".cm-changedText": {
    // Intra-line changed tokens get the stronger wash so edits read at a glance.
    background: "color-mix(in oklch, var(--accent) 26%, transparent) !important",
    borderRadius: "2px",
  },
  ".cm-changedLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--accent) 22%, transparent) !important",
  },
  // Removals. Deleted lines render as block widgets in the unified view.
  ".cm-deletedChunk": {
    backgroundColor: "color-mix(in oklch, var(--danger) 10%, transparent) !important",
    color: "var(--muted)",
  },
  ".cm-deletedText": {
    background: "color-mix(in oklch, var(--danger) 24%, transparent) !important",
    borderRadius: "2px",
  },
  ".cm-deletedLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--danger) 22%, transparent) !important",
  },
  // Folded unchanged regions between chunks.
  ".cm-collapsedLines": {
    color: "var(--muted)",
    backgroundColor: "var(--panel) !important",
    fontSize: "11px",
  },
});
