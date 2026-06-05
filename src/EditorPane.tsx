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
import { languageForPath } from "./language";
import { lspExtensionsForPath } from "./lsp";
import type { EditorSelection } from "./tauri";
import { clampLineNumber } from "./editorNavigation";
import { editorThemeExtensions } from "./editorTheme";

interface EditorPaneProps {
  path: string;
  contents: string;
  prefersDark?: boolean;
  revealLine?: number;
  onChange: (path: string, contents: string) => void;
  onError: (message: string) => void;
  onNotice?: (message: string) => void;
  onSelection: (selection: EditorSelection | undefined) => void;
}

export default function EditorPane({
  path,
  contents,
  prefersDark = false,
  revealLine,
  onChange,
  onError,
  onNotice,
  onSelection,
}: EditorPaneProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const suppressNextChangeRef = useRef(false);

  useEffect(() => {
    if (!host.current) return;
    viewRef.current?.destroy();
    let cancelled = false;

    languageForPath(path).then(async (languageExtensions) => {
      if (cancelled || !host.current) return;

      const lspExtensions = await lspExtensionsForPath(path).catch((error) => {
        onNotice?.(`Language server unavailable for ${path}`);
        return [];
      });
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
            ...lspExtensions,
            EditorView.lineWrapping,
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                if (suppressNextChangeRef.current) {
                  suppressNextChangeRef.current = false;
                } else {
                  onChange(path, update.state.doc.toString());
                }
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
            ...editorThemeExtensions(prefersDark),
          ],
        }),
      });

      viewRef.current = view;
      revealLineInView(view, revealLine);
    }).catch((error) => {
      if (!cancelled) {
        onError(`Unable to initialize editor for ${path}: ${String(error)}`);
      }
    });

    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [path, prefersDark]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const current = view.state.doc.toString();
    if (current === contents) return;

    suppressNextChangeRef.current = true;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: contents,
      },
    });
  }, [contents]);

  useEffect(() => {
    if (viewRef.current) {
      revealLineInView(viewRef.current, revealLine);
    }
  }, [revealLine]);

  return <div className="editor-host" ref={host} />;
}

function revealLineInView(view: EditorView, lineNumber: number | undefined) {
  const line = clampLineNumber(lineNumber, view.state.doc.lines);
  if (!line) return;

  const position = view.state.doc.line(line).from;
  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: "center" }),
  });
  view.focus();
}
