export type EditorCommandName =
  | "goToDefinition"
  | "findReferences"
  | "replaceMatch"
  | "replaceAll";

// Column offsets are 0-based within the line, matching SearchMatch (tauri.ts).
export interface EditorReplaceTarget {
  line: number;
  matchStart: number;
  matchEnd: number;
}

export interface EditorReplacePayload {
  targets: EditorReplaceTarget[];
  replacement: string;
}

export interface EditorCommandRequest {
  filePath: string;
  name: EditorCommandName;
  nonce: number;
  // Present for replaceMatch / replaceAll; carries the range(s) to rewrite.
  replace?: EditorReplacePayload;
}

const labels: Record<EditorCommandName, string> = {
  goToDefinition: "Go to definition",
  findReferences: "Find references",
  replaceMatch: "Replace",
  replaceAll: "Replace all",
};

export function editorCommandLabel(command: EditorCommandName) {
  return labels[command];
}
