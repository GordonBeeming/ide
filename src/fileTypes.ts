import {
  Braces,
  Code2,
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderGit2,
  LucideIcon,
  Package,
} from "lucide-react";

export function iconForFile(name: string, isDir: boolean): LucideIcon {
  if (isDir) {
    if (name === ".git" || name === ".github") return FolderGit2;
    if (name === "src" || name === "app") return FolderGit2;
    return Folder;
  }

  const lower = name.toLowerCase();
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return FileJson;
  if (lower.endsWith(".md") || lower.endsWith(".txt")) return FileText;
  if (lower.endsWith(".rs")) return Braces;
  if (lower.endsWith(".cs")) return Code2;
  if (/\.(ts|tsx|js|jsx|css|html)$/.test(lower)) return FileCode2;
  if (lower === "package.json" || lower === "cargo.toml") return Package;
  return File;
}
