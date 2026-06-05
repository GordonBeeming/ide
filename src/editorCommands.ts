export type EditorCommandName = "goToDefinition" | "findReferences";

export interface EditorCommandRequest {
  filePath: string;
  name: EditorCommandName;
  nonce: number;
}

const labels: Record<EditorCommandName, string> = {
  goToDefinition: "Go to definition",
  findReferences: "Find references",
};

export function editorCommandLabel(command: EditorCommandName) {
  return labels[command];
}
