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
