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

  const normalizedQuery = trimmedQuery.toLowerCase();
  const matches: SearchMatch[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (matches.length >= maxMatches) break;

    const normalizedLine = line.toLowerCase();
    let offset = 0;
    while (matches.length < maxMatches) {
      const matchStart = normalizedLine.indexOf(normalizedQuery, offset);
      if (matchStart === -1) break;

      matches.push({
        path,
        lineNumber: index + 1,
        lineText: line,
        matchStart,
        matchEnd: matchStart + trimmedQuery.length,
      });
      offset = matchStart + Math.max(trimmedQuery.length, 1);
    }
  }

  return matches;
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
