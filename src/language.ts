import type { Extension } from "@codemirror/state";

const extensionMap: Record<string, () => Promise<Extension>> = {
  ".css": async () => (await import("@codemirror/lang-css")).css(),
  ".cs": async () => {
    const [{ StreamLanguage }, { csharp }] = await Promise.all([
      import("@codemirror/language"),
      import("@codemirror/legacy-modes/mode/clike"),
    ]);
    return StreamLanguage.define(csharp);
  },
  ".html": async () => (await import("@codemirror/lang-html")).html(),
  ".js": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: false,
      typescript: false,
    }),
  ".jsx": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: true,
      typescript: false,
    }),
  ".md": async () => (await import("@codemirror/lang-markdown")).markdown(),
  ".markdown": async () => (await import("@codemirror/lang-markdown")).markdown(),
  ".rs": async () => (await import("@codemirror/lang-rust")).rust(),
  ".ts": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: false,
      typescript: true,
    }),
  ".tsx": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: true,
      typescript: true,
    }),
};

export async function languageForPath(path: string): Promise<Extension[]> {
  const lower = path.toLowerCase();
  const extension = Object.keys(extensionMap).find((candidate) =>
    lower.endsWith(candidate),
  );
  return extension ? [await extensionMap[extension]()] : [];
}
