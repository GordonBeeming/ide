import type { SearchMatch } from "./tauri";

const MAX_CURRENT_FILE_MATCHES = 200;

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
        lineText: line,
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
