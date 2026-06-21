import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, foldGutter, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  crosshairCursor,
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { findReferences, jumpToDefinition } from "@codemirror/lsp-client";
import {
  defaultDateTimeFormat,
  defaultRecentRelativeThreshold,
  formatDateTime,
  formatDateTimeAbsolute,
  type DateTimeFormatId,
  type RecentRelativeThresholdId,
} from "./dateTimeFormat";
import { languageForPath } from "./language";
import { lspExtensionsForPath } from "./lsp";
import type { EditorSelection, GitAttribution, GitCommitInfo } from "./tauri";
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
  dateTimeFormat?: DateTimeFormatId;
  recentRelativeThreshold?: RecentRelativeThresholdId;
  prefersDark?: boolean;
  revealLine?: number;
  focusOnReveal?: boolean;
  editorCommand?: EditorCommandRequest;
  gitAttribution?: GitAttribution;
  onChange: (path: string, contents: string) => void;
  onError: (message: string) => void;
  onGitCommitClick?: (commit: GitCommitInfo) => void;
  onNotice?: (message: string) => void;
  onCursor?: (cursor: EditorCursor | undefined) => void;
  onSelection: (selection: EditorSelection | undefined) => void;
}

export default function EditorPane({
  path,
  contents,
  dateTimeFormat = defaultDateTimeFormat,
  recentRelativeThreshold = defaultRecentRelativeThreshold,
  editorCommand,
  gitAttribution,
  focusOnReveal = true,
  prefersDark = false,
  revealLine,
  onChange,
  onError,
  onGitCommitClick,
  onCursor,
  onNotice,
  onSelection,
}: EditorPaneProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const gitAttributionCompartmentRef = useRef(new Compartment());
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
            gitAttributionCompartmentRef.current.of(
              gitAttributionExtension(
                gitAttribution,
                dateTimeFormat,
                recentRelativeThreshold,
                onGitCommitClick,
              ),
            ),
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
    view.dispatch({
      effects: gitAttributionCompartmentRef.current.reconfigure(
        gitAttributionExtension(
          gitAttribution,
          dateTimeFormat,
          recentRelativeThreshold,
          onGitCommitClick,
        ),
      ),
    });
  }, [dateTimeFormat, gitAttribution, onGitCommitClick, recentRelativeThreshold]);

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

function gitAttributionExtension(
  attribution: GitAttribution | undefined,
  dateTimeFormat: DateTimeFormatId,
  recentRelativeThreshold: RecentRelativeThresholdId,
  onGitCommitClick: ((commit: GitCommitInfo) => void) | undefined,
) {
  if (!attribution || attribution.status !== "available" || attribution.lines.length === 0) {
    return [];
  }

  const byLine = new Map(
    attribution.lines.map((line) => [line.lineNumber, line.commit] as const),
  );

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildGitAttributionDecorations(
          view,
          byLine,
          dateTimeFormat,
          recentRelativeThreshold,
          onGitCommitClick,
        );
      }

      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged || update.viewportChanged) {
          this.decorations = buildGitAttributionDecorations(
            update.view,
            byLine,
            dateTimeFormat,
            recentRelativeThreshold,
            onGitCommitClick,
          );
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
    },
  );
}

function buildGitAttributionDecorations(
  view: EditorView,
  byLine: Map<number, GitCommitInfo>,
  dateTimeFormat: DateTimeFormatId,
  recentRelativeThreshold: RecentRelativeThresholdId,
  onGitCommitClick: ((commit: GitCommitInfo) => void) | undefined,
) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const commit = byLine.get(line.number);
  if (!commit) return Decoration.none;

  return Decoration.set([
    Decoration.widget({
      widget: new GitAttributionWidget(
        commit,
        dateTimeFormat,
        recentRelativeThreshold,
        onGitCommitClick,
      ),
      side: 1,
    }).range(line.to),
  ]);
}

class GitAttributionWidget extends WidgetType {
  constructor(
    private readonly commit: GitCommitInfo,
    private readonly dateTimeFormat: DateTimeFormatId,
    private readonly recentRelativeThreshold: RecentRelativeThresholdId,
    private readonly onGitCommitClick: ((commit: GitCommitInfo) => void) | undefined,
  ) {
    super();
  }

  eq(other: GitAttributionWidget) {
    return (
      other.commit.sha === this.commit.sha &&
      other.commit.summary === this.commit.summary &&
      other.dateTimeFormat === this.dateTimeFormat &&
      other.recentRelativeThreshold === this.recentRelativeThreshold
    );
  }

  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "git-attribution-ghost";
    button.title = fullCommitDescription(
      this.commit,
      this.dateTimeFormat,
      this.recentRelativeThreshold,
    );
    button.textContent = [
      this.commit.authorName,
      commitTimeLabel(this.commit, this.dateTimeFormat, this.recentRelativeThreshold),
      this.commit.summary,
    ]
      .filter(Boolean)
      .join(" - ");
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onGitCommitClick?.(this.commit);
    };
    return button;
  }

  ignoreEvent() {
    return false;
  }
}

function commitTimeLabel(
  commit: GitCommitInfo,
  dateTimeFormat: DateTimeFormatId,
  recentRelativeThreshold: RecentRelativeThresholdId,
) {
  if (commit.authoredAtSeconds === undefined) return "";
  return formatDateTime(
    commit.authoredAtSeconds * 1000,
    dateTimeFormat,
    recentRelativeThreshold,
  );
}

function fullCommitDescription(
  commit: GitCommitInfo,
  dateTimeFormat: DateTimeFormatId,
  recentRelativeThreshold: RecentRelativeThresholdId,
) {
  const date = formatDateTimeAbsolute(
    commit.authoredAtSeconds === undefined
      ? undefined
      : commit.authoredAtSeconds * 1000,
  );
  return [
    commit.authorName,
    commitTimeLabel(commit, dateTimeFormat, recentRelativeThreshold),
    commit.shortSha,
    date,
    commit.summary,
  ]
    .filter(Boolean)
    .join(" - ");
}
