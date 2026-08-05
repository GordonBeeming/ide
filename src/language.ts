import type { Extension } from "@codemirror/state";
import type { StreamParser } from "@codemirror/language";

type LanguageLoader = () => Promise<Extension>;
type LegacyModeModule = Record<string, StreamParser<unknown>>;

const extensionMap: Record<string, LanguageLoader> = {
  ".css": async () => (await import("@codemirror/lang-css")).css(),
  ".scss": legacyMode(() => import("@codemirror/legacy-modes/mode/sass"), "sass"),
  ".sass": legacyMode(() => import("@codemirror/legacy-modes/mode/sass"), "sass"),
  ".cs": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "csharp"),
  ".cshtml": async () => (await import("@codemirror/lang-html")).html(),
  ".csproj": legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  ".c": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "c"),
  ".h": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "c"),
  ".cc": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  ".cpp": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  ".cxx": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  ".hpp": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  ".hh": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  ".hxx": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "cpp"),
  ".java": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "java"),
  ".kt": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "kotlin"),
  ".kts": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "kotlin"),
  ".scala": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "scala"),
  ".dart": legacyMode(() => import("@codemirror/legacy-modes/mode/clike"), "dart"),
  ".diff": legacyMode(() => import("@codemirror/legacy-modes/mode/diff"), "diff"),
  ".patch": legacyMode(() => import("@codemirror/legacy-modes/mode/diff"), "diff"),
  ".go": legacyMode(() => import("@codemirror/legacy-modes/mode/go"), "go"),
  ".html": async () => (await import("@codemirror/lang-html")).html(),
  ".htm": async () => (await import("@codemirror/lang-html")).html(),
  ".svelte": async () => (await import("@codemirror/lang-html")).html(),
  ".vue": async () => (await import("@codemirror/lang-html")).html(),
  ".js": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: false,
      typescript: false,
    }),
  ".cjs": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: false,
      typescript: false,
    }),
  ".jsx": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: true,
      typescript: false,
    }),
  ".mjs": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: false,
      typescript: false,
    }),
  ".json": async () => (await import("@codemirror/lang-json")).json(),
  ".jsonld": async () => (await import("@codemirror/lang-json")).json(),
  ".jsonc": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: false,
      typescript: false,
    }),
  ".lua": legacyMode(() => import("@codemirror/legacy-modes/mode/lua"), "lua"),
  ".md": async () => (await import("@codemirror/lang-markdown")).markdown(),
  ".markdown": async () => (await import("@codemirror/lang-markdown")).markdown(),
  ".mdx": async () => (await import("@codemirror/lang-markdown")).markdown(),
  ".nginx": legacyMode(() => import("@codemirror/legacy-modes/mode/nginx"), "nginx"),
  ".pl": legacyMode(() => import("@codemirror/legacy-modes/mode/perl"), "perl"),
  ".pm": legacyMode(() => import("@codemirror/legacy-modes/mode/perl"), "perl"),
  ".properties": legacyMode(
    () => import("@codemirror/legacy-modes/mode/properties"),
    "properties",
  ),
  ".ini": legacyMode(() => import("@codemirror/legacy-modes/mode/properties"), "properties"),
  ".conf": legacyMode(() => import("@codemirror/legacy-modes/mode/properties"), "properties"),
  ".env": legacyMode(() => import("@codemirror/legacy-modes/mode/properties"), "properties"),
  ".proto": legacyMode(() => import("@codemirror/legacy-modes/mode/protobuf"), "protobuf"),
  ".ps1": legacyMode(() => import("@codemirror/legacy-modes/mode/powershell"), "powerShell"),
  ".psd1": legacyMode(() => import("@codemirror/legacy-modes/mode/powershell"), "powerShell"),
  ".psm1": legacyMode(() => import("@codemirror/legacy-modes/mode/powershell"), "powerShell"),
  ".ps1xml": legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  ".cdxml": legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  ".props": legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  ".fsproj": legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  ".py": legacyMode(() => import("@codemirror/legacy-modes/mode/python"), "python"),
  ".pyw": legacyMode(() => import("@codemirror/legacy-modes/mode/python"), "python"),
  ".r": legacyMode(() => import("@codemirror/legacy-modes/mode/r"), "r"),
  ".rb": legacyMode(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby"),
  ".rake": legacyMode(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby"),
  ".rs": async () => (await import("@codemirror/lang-rust")).rust(),
  ".sh": legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  ".bash": legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  ".zsh": legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  ".ksh": legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  ".command": legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  ".sql": legacyMode(() => import("@codemirror/legacy-modes/mode/sql"), "standardSQL"),
  ".swift": legacyMode(() => import("@codemirror/legacy-modes/mode/swift"), "swift"),
  ".toml": legacyMode(() => import("@codemirror/legacy-modes/mode/toml"), "toml"),
  ".ts": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: false,
      typescript: true,
    }),
  ".cts": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: false,
      typescript: true,
    }),
  ".mts": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: false,
      typescript: true,
    }),
  ".tsx": async () =>
    (await import("@codemirror/lang-javascript")).javascript({
      jsx: true,
      typescript: true,
    }),
  ".targets": legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  ".vb": legacyMode(() => import("@codemirror/legacy-modes/mode/vb"), "vb"),
  ".vbproj": legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  ".xml": legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  ".xsd": legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  ".xsl": legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  ".svg": legacyMode(() => import("@codemirror/legacy-modes/mode/xml"), "xml"),
  ".yaml": legacyMode(() => import("@codemirror/legacy-modes/mode/yaml"), "yaml"),
  ".yml": legacyMode(() => import("@codemirror/legacy-modes/mode/yaml"), "yaml"),
};

const filenameMap: Record<string, LanguageLoader> = {
  ".bash_profile": legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  ".bashrc": legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  ".env": legacyMode(() => import("@codemirror/legacy-modes/mode/properties"), "properties"),
  ".editorconfig": legacyMode(
    () => import("@codemirror/legacy-modes/mode/properties"),
    "properties",
  ),
  ".gitconfig": legacyMode(() => import("@codemirror/legacy-modes/mode/properties"), "properties"),
  ".gitignore": legacyMode(() => import("@codemirror/legacy-modes/mode/properties"), "properties"),
  ".profile": legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  ".zprofile": legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  ".zshrc": legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  "cargo.lock": legacyMode(() => import("@codemirror/legacy-modes/mode/toml"), "toml"),
  "containerfile": legacyMode(() => import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile"),
  "dockerfile": legacyMode(() => import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile"),
  "gemfile": legacyMode(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby"),
  "makefile": legacyMode(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
  "nginx.conf": legacyMode(() => import("@codemirror/legacy-modes/mode/nginx"), "nginx"),
  "rakefile": legacyMode(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby"),
};

export async function languageForPath(path: string): Promise<Extension[]> {
  const lower = path.toLowerCase();
  const fileName = lower.split(/[\\/]/).pop() ?? lower;
  const filenameLoader = filenameMap[fileName];
  if (filenameLoader) return [await filenameLoader()];

  const extension = Object.keys(extensionMap).find((candidate) =>
    lower.endsWith(candidate),
  );
  return extension ? [await extensionMap[extension]()] : [];
}

function legacyMode(
  loadMode: () => Promise<unknown>,
  exportName: string,
): LanguageLoader {
  return async () => {
    const [{ StreamLanguage }, loadedMode] = await Promise.all([
      import("@codemirror/language"),
      loadMode(),
    ]);
    const mode = loadedMode as LegacyModeModule;
    const parser = mode[exportName];
    if (!parser) {
      throw new Error(`CodeMirror legacy mode export was not found: ${exportName}`);
    }
    return StreamLanguage.define(parser);
  };
}
