export function clampLineNumber(lineNumber: number | undefined, lineCount: number) {
  if (lineNumber === undefined || !Number.isFinite(lineNumber)) return undefined;
  return Math.min(Math.max(Math.trunc(lineNumber), 1), Math.max(lineCount, 1));
}
