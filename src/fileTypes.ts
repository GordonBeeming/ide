import "file-icons-js/css/style.css";

import { createElement, type ComponentType, type CSSProperties } from "react";
import { getClassWithColor } from "file-icons-js";
import {
  File,
  Folder,
  FolderGit2,
  LucideIcon,
} from "lucide-react";

export type FileIconProps = {
  size?: number;
  className?: string;
};

export type FileIconComponent = ComponentType<FileIconProps>;

type FolderIconRule = {
  icon: LucideIcon;
  names: readonly string[];
};

const binaryFileExtensions = new Set([
  ".7z",
  ".aac",
  ".aiff",
  ".app",
  ".avi",
  ".bin",
  ".bmp",
  ".bz2",
  ".class",
  ".dmg",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".flac",
  ".gif",
  ".gz",
  ".heic",
  ".icns",
  ".ico",
  ".iso",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".rar",
  ".so",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tgz",
  ".tiff",
  ".ttf",
  ".wasm",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xz",
  ".zip",
]);

const folderIconRules: readonly FolderIconRule[] = [
  { icon: FolderGit2, names: [".git", ".github"] },
];

const fileIconCache = new Map<string, FileIconComponent>();

export function iconForFile(name: string, isDir: boolean): FileIconComponent {
  if (isDir) return iconForFolder(name);

  const iconClass = iconClassForFile(name);
  if (!iconClass) return File;
  return componentForFileIconClass(iconClass);
}

export function iconClassForFile(name: string): string | undefined {
  return getClassWithColor(name) ?? undefined;
}

export function isKnownBinaryFile(name: string): boolean {
  const lower = name.toLowerCase();
  const dotIndex = lower.lastIndexOf(".");
  if (dotIndex < 0) return false;
  return binaryFileExtensions.has(lower.slice(dotIndex));
}

function iconForFolder(name: string): LucideIcon {
  const lower = name.toLowerCase();
  const rule = folderIconRules.find((candidate) => candidate.names.includes(lower));
  return rule?.icon ?? Folder;
}

function componentForFileIconClass(iconClass: string): FileIconComponent {
  const cached = fileIconCache.get(iconClass);
  if (cached) return cached;

  const Icon = ({ size = 15, className }: FileIconProps) => {
    const classes = ["icon", "file-type-icon", iconClass, className]
      .filter(Boolean)
      .join(" ");
    const style: CSSProperties = {
      fontSize: size,
      height: size,
      lineHeight: 1,
      width: size,
    };
    return createElement("i", {
      "aria-hidden": true,
      className: classes,
      style,
    });
  };

  Icon.displayName = `FileIcon(${iconClass})`;
  fileIconCache.set(iconClass, Icon);
  return Icon;
}
