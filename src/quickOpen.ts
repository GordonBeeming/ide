import type { FileEntry } from "./tauri";

export function quickOpenMatches(
  files: FileEntry[],
  query: string,
  limit = 12,
): FileEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  const candidates = files.filter((file) => !file.isDir);
  if (!normalizedQuery) return candidates.slice(0, limit);

  return candidates
    .map((file) => ({
      file,
      score: scorePath(file.path.toLowerCase(), normalizedQuery),
    }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.file.path.localeCompare(b.file.path))
    .slice(0, limit)
    .map((item) => item.file);
}

export function moveQuickOpenSelection(
  currentIndex: number,
  direction: 1 | -1,
  resultCount: number,
) {
  if (resultCount <= 0) return 0;
  return (currentIndex + direction + resultCount) % resultCount;
}

export function clampQuickOpenSelection(currentIndex: number, resultCount: number) {
  if (resultCount <= 0) return 0;
  return Math.min(Math.max(currentIndex, 0), resultCount - 1);
}

function scorePath(path: string, query: string) {
  const directIndex = path.indexOf(query);
  if (directIndex >= 0) return directIndex;

  let lastIndex = -1;
  let gaps = 0;
  for (const character of query) {
    const index = path.indexOf(character, lastIndex + 1);
    if (index === -1) return -1;
    if (lastIndex >= 0) gaps += index - lastIndex - 1;
    lastIndex = index;
  }

  return 1000 + gaps + path.length / 1000;
}
