import { useEffect, useRef } from "react";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { Columns2, Rows3, TriangleAlert } from "lucide-react";
import { diffTheme } from "./diffTheme";
import { editorThemeExtensions } from "./editorTheme";
import { languageForPath } from "./language";
import type { DiffViewMode } from "./tauri";

interface DiffPaneProps {
  filePath: string;
  original: string;
  modified: string;
  isBinary: boolean;
  isTooLarge: boolean;
  prefersDark?: boolean;
  viewMode: DiffViewMode;
  onViewModeChange: (mode: DiffViewMode) => void;
}

// Either construction path destroys/recreates on every relevant prop change
// (same lifecycle the unified path always had) — there's no cheaper way to
// swap a live EditorView for a live MergeView (or vice versa) in place.
export default function DiffPane({
  filePath,
  original,
  modified,
  isBinary,
  isTooLarge,
  prefersDark = false,
  viewMode,
  onViewModeChange,
}: DiffPaneProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | MergeView | null>(null);

  useEffect(() => {
    if (isBinary || isTooLarge || !host.current) return;
    viewRef.current?.destroy();
    let cancelled = false;

    languageForPath(filePath).then((languageExtensions) => {
      if (cancelled || !host.current) return;

      const sharedExtensions: Extension[] = [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ...languageExtensions,
        diffTheme,
        ...editorThemeExtensions(prefersDark),
      ];

      if (viewMode === "sideBySide") {
        viewRef.current = new MergeView({
          a: { doc: original, extensions: [lineNumbers(), ...sharedExtensions] },
          b: { doc: modified, extensions: [lineNumbers(), ...sharedExtensions] },
          parent: host.current,
          gutter: true,
          highlightChanges: true,
          collapseUnchanged: { margin: 3, minSize: 6 },
        });
      } else {
        viewRef.current = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: modified,
            extensions: [
              lineNumbers(),
              ...sharedExtensions,
              unifiedMergeView({
                original,
                mergeControls: false,
                gutter: true,
                highlightChanges: true,
                syntaxHighlightDeletions: true,
                collapseUnchanged: { margin: 3, minSize: 6 },
              }),
            ],
          }),
        });
      }
    });

    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [filePath, original, modified, isBinary, isTooLarge, prefersDark, viewMode]);

  const toolbar = (
    <div className="diff-toolbar">
      <button
        type="button"
        className={`tiny-icon-button ${viewMode === "inline" ? "tiny-icon-button--active" : ""}`}
        aria-pressed={viewMode === "inline"}
        title="Inline diff"
        onClick={() => onViewModeChange("inline")}
      >
        <Rows3 size={14} />
      </button>
      <button
        type="button"
        className={`tiny-icon-button ${viewMode === "sideBySide" ? "tiny-icon-button--active" : ""}`}
        aria-pressed={viewMode === "sideBySide"}
        title="Side-by-side diff"
        onClick={() => onViewModeChange("sideBySide")}
      >
        <Columns2 size={14} />
      </button>
    </div>
  );

  if (isBinary) {
    return (
      <div className="diff-pane">
        {toolbar}
        <div className="diff-fallback" role="status">
          <TriangleAlert size={22} />
          <span>Binary file — no text diff to show.</span>
        </div>
      </div>
    );
  }
  if (isTooLarge) {
    return (
      <div className="diff-pane">
        {toolbar}
        <div className="diff-fallback" role="status">
          <TriangleAlert size={22} />
          <span>File too large to diff.</span>
        </div>
      </div>
    );
  }
  return (
    <div className="diff-pane">
      {toolbar}
      <div className="diff-host" ref={host} />
    </div>
  );
}
