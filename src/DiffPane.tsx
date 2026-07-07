import { useEffect, useRef } from "react";
import { unifiedMergeView } from "@codemirror/merge";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { TriangleAlert } from "lucide-react";
import { diffTheme } from "./diffTheme";
import { editorThemeExtensions } from "./editorTheme";
import { languageForPath } from "./language";

interface DiffPaneProps {
  filePath: string;
  original: string;
  modified: string;
  isBinary: boolean;
  isTooLarge: boolean;
  prefersDark?: boolean;
}

export default function DiffPane({
  filePath,
  original,
  modified,
  isBinary,
  isTooLarge,
  prefersDark = false,
}: DiffPaneProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (isBinary || isTooLarge || !host.current) return;
    viewRef.current?.destroy();
    let cancelled = false;

    languageForPath(filePath).then((languageExtensions) => {
      if (cancelled || !host.current) return;
      viewRef.current = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: modified,
          extensions: [
            lineNumbers(),
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            EditorView.lineWrapping,
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            ...languageExtensions,
            unifiedMergeView({
              original,
              mergeControls: false,
              gutter: true,
              highlightChanges: true,
              syntaxHighlightDeletions: true,
              collapseUnchanged: { margin: 3, minSize: 6 },
            }),
            diffTheme,
            ...editorThemeExtensions(prefersDark),
          ],
        }),
      });
    });

    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [filePath, original, modified, isBinary, isTooLarge, prefersDark]);

  if (isBinary) {
    return (
      <div className="diff-fallback" role="status">
        <TriangleAlert size={22} />
        <span>Binary file — no text diff to show.</span>
      </div>
    );
  }
  if (isTooLarge) {
    return (
      <div className="diff-fallback" role="status">
        <TriangleAlert size={22} />
        <span>File too large to diff.</span>
      </div>
    );
  }
  return <div className="diff-host" ref={host} />;
}
