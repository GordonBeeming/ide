import { EditorView } from "@codemirror/view";

// Scoped to the diff view; overrides @codemirror/merge's default green/red
// base theme so additions read blue (--accent) and deletions/originals read
// red (--danger), matching the rest of the app's palette instead of a
// generic diff green.
//
// Side-aware: verified against the installed @codemirror/merge build that
// both the unified view (inline mode) and the "b" (modified) side of a
// side-by-side MergeView carry `EditorView.editorAttributes.of({ class:
// "cm-merge-b" })` on their editor root, while the "a" (original) side of a
// side-by-side view carries `cm-merge-a` instead. A flat, unscoped rule
// would therefore paint the ORIGINAL pane in side-by-side mode the same
// blue as the modified pane, which reads backwards — its changed lines are
// scoped to --danger red instead, the same tone deleted content already
// uses.
//
// `!important` here is load-bearing, not decorative. @codemirror/merge ships
// its defaults via `EditorView.baseTheme()` under selectors scoped the same
// way, e.g. `&light.cm-merge-b .cm-changedLineGutter`. CodeMirror's theme
// precedence only orders same-specificity rules; it can't out-rank a rule
// whose selector is simply more specific than ours. Matching the library's
// scoping exactly (rather than exceeding it) is still not guaranteed to win
// a same-specificity tie in our favor, so `!important` covers that
// regardless of how the library orders its own rule in a future patch.
// `.cm-changedText`/`.cm-deletedText` also set the `background` SHORTHAND
// here (not just `background-color`) because the library's default for both
// is a background-image (a dotted-underline gradient) — clearing only the
// color would leave that image showing through.
export const diffTheme = EditorView.theme({
  // Additions & changed lines — unified view, and the side-by-side "b" pane.
  "&.cm-merge-b .cm-changedLine": {
    backgroundColor: "color-mix(in oklch, var(--accent) 12%, transparent) !important",
  },
  "&.cm-merge-b .cm-changedText": {
    // Intra-line changed tokens get the stronger wash so edits read at a glance.
    background: "color-mix(in oklch, var(--accent) 26%, transparent) !important",
    borderRadius: "2px",
  },
  "&.cm-merge-b .cm-changedLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--accent) 22%, transparent) !important",
  },
  // The side-by-side "a" (original) pane's changed lines — see the
  // side-aware note above for why this reads red instead of blue.
  "&.cm-merge-a .cm-changedLine": {
    backgroundColor: "color-mix(in oklch, var(--danger) 12%, transparent) !important",
  },
  "&.cm-merge-a .cm-changedText": {
    background: "color-mix(in oklch, var(--danger) 26%, transparent) !important",
    borderRadius: "2px",
  },
  "&.cm-merge-a .cm-changedLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--danger) 22%, transparent) !important",
  },
  // Removals. Deleted lines render as block widgets in the unified view only
  // (side-by-side shows a deletion as an empty gap on the "b" side instead),
  // so these stay unscoped — there's no "a"/"b" pane to distinguish.
  ".cm-deletedChunk": {
    backgroundColor: "color-mix(in oklch, var(--danger) 10%, transparent) !important",
    color: "var(--text-muted)",
  },
  ".cm-deletedText": {
    background: "color-mix(in oklch, var(--danger) 24%, transparent) !important",
    borderRadius: "2px",
  },
  ".cm-deletedLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--danger) 22%, transparent) !important",
  },
  // Folded unchanged regions between chunks — shared by both modes and both
  // panes, no side-specific meaning.
  ".cm-collapsedLines": {
    color: "var(--text-muted)",
    backgroundColor: "var(--surface) !important",
    fontSize: "11px",
  },
});
