import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { Columns2, Rows3, TriangleAlert } from "lucide-react";
import { diffTheme } from "./diffTheme";
import { editorThemeExtensions } from "./editorTheme";
import { languageForPath } from "./language";
import type { CodeFont, DiffViewMode } from "./tauri";

interface DiffPaneProps {
  filePath: string;
  original: string;
  modified: string;
  isBinary: boolean;
  isTooLarge: boolean;
  prefersDark?: boolean;
  codeFont?: CodeFont;
  viewMode: DiffViewMode;
  onViewModeChange: (mode: DiffViewMode) => void;
  // Drives the split-ratio reset when commit mode is left while a pinned
  // side-by-side diff tab stays open (the pane itself isn't remounted in
  // that case, so the reset needs an explicit signal rather than relying
  // on fresh state from a new mount).
  commitModeActive: boolean;
}

const minSplitRatio = 20;
const maxSplitRatio = 80;
const defaultSplitRatio = 50;
const splitRatioStep = 5;

function clampSplitRatio(value: number) {
  return Math.min(maxSplitRatio, Math.max(minSplitRatio, value));
}

// The two side-by-side panes are library-created DOM (`.cm-mergeViewEditor`
// wrappers, not anything DiffPane renders), so the ratio is applied
// imperatively rather than through props/CSS classes. Only the first pane's
// flex is set to a fixed basis — the second already has the library's
// default `flex-grow: 1; flex-basis: 0`, so it fills whatever the first
// pane doesn't take.
function applySplitRatio(host: HTMLDivElement, ratio: number) {
  const panes = host.querySelectorAll<HTMLElement>(".cm-mergeViewEditor");
  if (panes.length < 2) return;
  panes[0].style.flex = `0 0 ${ratio}%`;
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
  codeFont = "ibm-plex-mono",
  viewMode,
  onViewModeChange,
  commitModeActive,
}: DiffPaneProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | MergeView | null>(null);
  const [splitRatio, setSplitRatioState] = useState(defaultSplitRatio);
  // Mirrors `splitRatio` synchronously so the view-creation effect (which
  // must NOT depend on `splitRatio` — that would tear down and rebuild both
  // CodeMirror editors on every drag frame) can still read the latest ratio
  // right after creating a fresh side-by-side view.
  const splitRatioRef = useRef(defaultSplitRatio);
  const splitResizeRef = useRef<
    { startX: number; startRatio: number; hostWidth: number } | undefined
  >(undefined);

  const setSplitRatio = useCallback((value: number) => {
    const clamped = clampSplitRatio(value);
    splitRatioRef.current = clamped;
    setSplitRatioState(clamped);
  }, []);

  // Ephemeral by design (never persisted): toggling modes should never keep
  // the old split, so it resets whenever the pane's actual rendering mode
  // changes — including inline → side-by-side, which the ask calls out
  // explicitly.
  useEffect(() => {
    setSplitRatio(defaultSplitRatio);
  }, [viewMode, setSplitRatio]);

  // Leaving commit mode with a pinned side-by-side diff tab still open
  // doesn't remount this component (it's still the active tab), so the
  // reset needs this explicit signal rather than relying on fresh state.
  useEffect(() => {
    if (!commitModeActive) setSplitRatio(defaultSplitRatio);
  }, [commitModeActive, setSplitRatio]);

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
        ...editorThemeExtensions(prefersDark, codeFont),
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
        applySplitRatio(host.current, splitRatioRef.current);
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
  }, [filePath, original, modified, isBinary, isTooLarge, prefersDark, codeFont, viewMode]);

  // Re-applies on every ratio change (drag frames, keyboard nudges) without
  // touching the CodeMirror views themselves — just the wrapper's flex.
  useEffect(() => {
    if (viewMode !== "sideBySide" || !host.current) return;
    applySplitRatio(host.current, splitRatio);
  }, [splitRatio, viewMode]);

  const beginSplitResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!host.current) return;
      event.preventDefault();
      splitResizeRef.current = {
        startX: event.clientX,
        startRatio: splitRatio,
        hostWidth: host.current.getBoundingClientRect().width,
      };
    },
    [splitRatio],
  );

  const handleSplitResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      setSplitRatio(splitRatio + direction * splitRatioStep);
    },
    [setSplitRatio, splitRatio],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resize = splitResizeRef.current;
      if (!resize || resize.hostWidth <= 0) return;
      const deltaPercent = ((event.clientX - resize.startX) / resize.hostWidth) * 100;
      setSplitRatio(resize.startRatio + deltaPercent);
    };
    const handlePointerUp = () => {
      splitResizeRef.current = undefined;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [setSplitRatio]);

  const toolbar = (
    <div className="diff-toolbar">
      <button
        type="button"
        className={`tiny-icon-button ${viewMode === "inline" ? "tiny-icon-button--active" : ""}`}
        aria-pressed={viewMode === "inline"}
        aria-label="Inline diff"
        title="Inline diff"
        onClick={() => onViewModeChange("inline")}
      >
        <Rows3 size={14} />
      </button>
      <button
        type="button"
        className={`tiny-icon-button ${viewMode === "sideBySide" ? "tiny-icon-button--active" : ""}`}
        aria-pressed={viewMode === "sideBySide"}
        aria-label="Side-by-side diff"
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
      <div className="diff-host-wrapper">
        <div className="diff-host" ref={host} />
        {viewMode === "sideBySide" ? (
          <div
            className="diff-split-handle"
            role="separator"
            tabIndex={0}
            aria-label="Resize diff panes"
            aria-orientation="vertical"
            aria-valuemin={minSplitRatio}
            aria-valuemax={maxSplitRatio}
            aria-valuenow={splitRatio}
            style={{ left: `${splitRatio}%` }}
            onKeyDown={handleSplitResizeKeyDown}
            onPointerDown={beginSplitResize}
          />
        ) : null}
      </div>
    </div>
  );
}
