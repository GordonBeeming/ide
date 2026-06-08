export interface CommandPaletteEntry {
  id: string;
  title: string;
  keywords?: string[];
}

export function commandPaletteMatches<T extends CommandPaletteEntry>(
  commands: T[],
  query: string,
  limit = 16,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return commands.slice(0, limit);

  return commands
    .map((command) => ({
      command,
      score: scoreCommand(command, normalizedQuery),
    }))
    .filter((item) => item.score >= 0)
    .sort(
      (a, b) => a.score - b.score || a.command.title.localeCompare(b.command.title),
    )
    .slice(0, limit)
    .map((item) => item.command);
}

export function moveCommandPaletteSelection(
  currentIndex: number,
  direction: 1 | -1,
  resultCount: number,
) {
  if (resultCount <= 0) return 0;
  return (currentIndex + direction + resultCount) % resultCount;
}

export function clampCommandPaletteSelection(
  currentIndex: number,
  resultCount: number,
) {
  if (resultCount <= 0) return 0;
  return Math.min(Math.max(currentIndex, 0), resultCount - 1);
}

function scoreCommand(command: CommandPaletteEntry, query: string) {
  const candidates = [
    command.title.toLowerCase(),
    command.id.toLowerCase(),
    ...(command.keywords ?? []).map((keyword) => keyword.toLowerCase()),
  ];

  return candidates.reduce((bestScore, candidate) => {
    const score = scoreText(candidate, query);
    if (score < 0) return bestScore;
    return bestScore < 0 ? score : Math.min(bestScore, score);
  }, -1);
}

function scoreText(text: string, query: string) {
  const directIndex = text.indexOf(query);
  if (directIndex >= 0) return directIndex;

  let lastIndex = -1;
  let gaps = 0;
  for (const character of query) {
    const index = text.indexOf(character, lastIndex + 1);
    if (index === -1) return -1;
    if (lastIndex >= 0) gaps += index - lastIndex - 1;
    lastIndex = index;
  }

  return 1000 + gaps + text.length / 1000;
}
