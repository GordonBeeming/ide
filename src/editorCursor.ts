export interface EditorCursor {
  filePath: string;
  line: number;
  column: number;
}

export interface RevealTarget {
  path: string;
  lineNumber: number;
}

export function cursorStatus(
  activePath: string | undefined,
  cursor: EditorCursor | undefined,
  revealTarget: RevealTarget | undefined,
) {
  if (cursor && cursor.filePath === activePath) {
    return `${cursor.line}:${cursor.column}`;
  }

  if (revealTarget && revealTarget.path === activePath) {
    return `${revealTarget.lineNumber}:1`;
  }

  return "";
}
