import type { SearchMatch } from "./tauri";

const MAX_CURRENT_FILE_MATCHES = 200;

// A single minified line can be hundreds of KB; shipping the whole line as
// preview text per match (up to MAX_CURRENT_FILE_MATCHES times) freezes the
// webview. Cap the preview to a window around the match instead. matchStart/
// matchEnd stay as full-line offsets (EditorPane uses them to select in the
// real document) — only the displayed text is windowed.
const PREVIEW_MAX_CHARS = 500;
const PREVIEW_CONTEXT_BEFORE_CHARS = 160;

function previewWindow(line: string, matchStart: number): string {
  if (line.length <= PREVIEW_MAX_CHARS) return line;

  let windowStart = Math.max(0, matchStart - PREVIEW_CONTEXT_BEFORE_CHARS);
  let windowEnd = windowStart + PREVIEW_MAX_CHARS;
  if (windowEnd > line.length) {
    windowEnd = line.length;
    windowStart = Math.max(0, windowEnd - PREVIEW_MAX_CHARS);
  }
  // A match longer than the window is cut too — queries are at most a few
  // hundred chars, so this only trims pathological cases.

  const prefix = windowStart > 0 ? "…" : "";
  const suffix = windowEnd < line.length ? "…" : "";
  return prefix + line.slice(windowStart, windowEnd) + suffix;
}

export function currentFileMatches(
  path: string,
  contents: string,
  query: string,
  maxMatches = MAX_CURRENT_FILE_MATCHES,
): SearchMatch[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const queryPattern = new RegExp(escapeRegExp(trimmedQuery), "giu");
  const matches: SearchMatch[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (matches.length >= maxMatches) break;

    queryPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while (matches.length < maxMatches && (match = queryPattern.exec(line)) !== null) {
      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;

      matches.push({
        path,
        lineNumber: index + 1,
        lineText: previewWindow(line, matchStart),
        matchStart,
        matchEnd,
      });
    }
  }

  return matches;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Picks the slice of results to preview so the active match stays visible with
// one item of lookahead: the active row sits one slot from the bottom (offset
// limit-2) until it is the genuine last match, then it occupies the last slot.
// `startIndex` lets callers map back to absolute match indices.
export function currentFileResultWindow<T>(
  results: T[],
  activeIndex: number,
  limit: number,
): { startIndex: number; items: T[] } {
  if (limit <= 0 || results.length === 0) {
    return { startIndex: 0, items: [] };
  }

  const maxStart = Math.max(0, results.length - limit);
  let startIndex = 0;
  if (activeIndex >= 0) {
    const desiredOffset = Math.max(0, limit - 2);
    startIndex = Math.min(Math.max(activeIndex - desiredOffset, 0), maxStart);
  }

  return { startIndex, items: results.slice(startIndex, startIndex + limit) };
}

export function nextCurrentFileMatchIndex(
  currentIndex: number,
  direction: 1 | -1,
  totalMatches: number,
) {
  if (totalMatches <= 0) return -1;

  const baseIndex =
    currentIndex < 0 || currentIndex >= totalMatches
      ? direction > 0
        ? -1
        : 0
      : currentIndex;
  return (baseIndex + direction + totalMatches) % totalMatches;
}
