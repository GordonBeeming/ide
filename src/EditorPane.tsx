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
import { findReferences, jumpToDefinition } from "@codemirror/lsp-client";
import { languageForPath } from "./language";
import { lspExtensionsForPath } from "./lsp";
import type { EditorSelection } from "./tauri";
import { clampLineNumber } from "./editorNavigation";
import { editorThemeExtensions } from "./editorTheme";
import {
  editorCommandLabel,
  type EditorCommandRequest,
} from "./editorCommands";
import type { EditorCursor } from "./editorCursor";

interface EditorPaneProps {
  path: string;
  contents: string;
  prefersDark?: boolean;
  revealLine?: number;
  focusOnReveal?: boolean;
  editorCommand?: EditorCommandRequest;
  onChange: (path: string, contents: string) => void;
  onError: (message: string) => void;
  onNotice?: (message: string) => void;
  onCursor?: (cursor: EditorCursor | undefined) => void;
  onSelection: (selection: EditorSelection | undefined) => void;
}

export default function EditorPane({
  path,
  contents,
  editorCommand,
  focusOnReveal = true,
  prefersDark = false,
  revealLine,
  onChange,
  onError,
  onCursor,
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
                emitCursorAndSelection(update.view, path, onCursor, onSelection);
              }
            }),
            ...editorThemeExtensions(prefersDark),
          ],
        }),
      });

      viewRef.current = view;
      emitCursorAndSelection(view, path, onCursor, onSelection);
      revealLineInView(view, revealLine, focusOnReveal);
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
      revealLineInView(viewRef.current, revealLine, focusOnReveal);
    }
  }, [focusOnReveal, revealLine]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !editorCommand) return;
    if (editorCommand.filePath !== path) return;

    const label = editorCommandLabel(editorCommand.name);
    try {
      const handled =
        editorCommand.name === "goToDefinition"
          ? jumpToDefinition(view)
          : findReferences(view);
      onNotice?.(
        handled
          ? `${label} requested`
          : `${label} is not available for ${path}`,
      );
    } catch (error) {
      onError(`${label} failed for ${path}: ${String(error)}`);
    }
  }, [editorCommand, onError, onNotice, path]);

  return <div className="editor-host" ref={host} />;
}

function emitCursorAndSelection(
  view: EditorView,
  path: string,
  onCursor: ((cursor: EditorCursor | undefined) => void) | undefined,
  onSelection: (selection: EditorSelection | undefined) => void,
) {
  const range = view.state.selection.main;
  const from = view.state.doc.lineAt(range.from);
  const to = view.state.doc.lineAt(range.to);
  const text = view.state.sliceDoc(range.from, range.to);
  onCursor?.({
    filePath: path,
    line: from.number,
    column: range.from - from.from + 1,
  });
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

function revealLineInView(
  view: EditorView,
  lineNumber: number | undefined,
  focus = true,
) {
  const line = clampLineNumber(lineNumber, view.state.doc.lines);
  if (!line) return;

  const position = view.state.doc.line(line).from;
  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: "center" }),
  });
  if (focus) view.focus();
}
