import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, foldGutter, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { languageForPath } from "./language";
import type { EditorSelection } from "./tauri";

interface EditorPaneProps {
  path: string;
  contents: string;
  onChange: (path: string, contents: string) => void;
  onSelection: (selection: EditorSelection | undefined) => void;
}

export default function EditorPane({
  path,
  contents,
  onChange,
  onSelection,
}: EditorPaneProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!host.current) return;
    viewRef.current?.destroy();
    let cancelled = false;

    languageForPath(path).then((languageExtensions) => {
      if (cancelled || !host.current) return;

      const view = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: contents,
          extensions: [
            lineNumbers(),
            foldGutter(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            bracketMatching(),
            rectangularSelection(),
            crosshairCursor(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            keymap.of([...defaultKeymap, indentWithTab, ...historyKeymap, ...searchKeymap]),
            ...languageExtensions,
            EditorView.lineWrapping,
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                onChange(path, update.state.doc.toString());
              }

              if (update.selectionSet || update.docChanged) {
                const range = update.state.selection.main;
                const from = update.state.doc.lineAt(range.from);
                const to = update.state.doc.lineAt(range.to);
                const text = update.state.sliceDoc(range.from, range.to);
                onSelection(
                  text.length
                    ? {
                        filePath: path,
                        text,
                        startLine: from.number,
                        startColumn: range.from - from.from + 1,
                        endLine: to.number,
                        endColumn: range.to - to.from + 1,
                      }
                    : undefined,
                );
              }
            }),
            highContrastTheme,
            oneDark,
          ],
        }),
      });

      viewRef.current = view;
    });

    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [path]);

  return <div className="editor-host" ref={host} />;
}

const highContrastTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
  },
  ".cm-scroller": {
    fontFamily:
      "'SF Mono', 'Cascadia Code', 'JetBrains Mono', ui-monospace, monospace",
    lineHeight: "1.55",
  },
  ".cm-gutters": {
    borderRight: "1px solid var(--border)",
  },
});
