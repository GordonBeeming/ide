#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const configPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
const defaultCapabilityPath = path.join(
  rootDir,
  "src-tauri",
  "capabilities",
  "default.json",
);

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const defaultCapability = JSON.parse(fs.readFileSync(defaultCapabilityPath, "utf8"));
const associations = config.bundle?.fileAssociations;
const bundleIcons = config.bundle?.icon;
const mainWindowPermissions = defaultCapability.permissions ?? [];
const defaultCapabilityWindows = defaultCapability.windows ?? [];

const requiredAssociatedExtensions = [
  "rs",
  "ts",
  "tsx",
  "js",
  "jsx",
  "cs",
  "md",
  "json",
  "jsonc",
  "toml",
  "yaml",
  "yml",
  "sh",
  "html",
  "css",
  "sql",
  "ps1",
  "csproj",
];

const unsupportedBinaryExtensions = new Set([
  "7z",
  "app",
  "avi",
  "bin",
  "bmp",
  "dll",
  "dmg",
  "exe",
  "gif",
  "gz",
  "ico",
  "jpeg",
  "jpg",
  "mov",
  "mp3",
  "mp4",
  "pdf",
  "png",
  "rar",
  "tar",
  "webp",
  "woff",
  "woff2",
  "zip",
]);

const errors = [];

if (config.identifier !== "com.gordonbeeming.ide") {
  errors.push("identifier must remain com.gordonbeeming.ide");
}

if (config.productName !== "ide") {
  errors.push('productName must remain lowercase "ide"');
}

const mainWindow = config.app?.windows?.[0];
if (mainWindow?.title !== "ide") {
  errors.push('main window title must remain lowercase "ide"');
}

if (!Array.isArray(defaultCapabilityWindows)) {
  errors.push("default capability windows must be an array");
} else {
  for (const windowPattern of ["main", "workspace-*"]) {
    if (!defaultCapabilityWindows.includes(windowPattern)) {
      errors.push(`default capability windows must include ${windowPattern}`);
    }
  }
}

if (!Array.isArray(mainWindowPermissions)) {
  errors.push("main window capability permissions must be an array");
} else {
  for (const permission of [
    "core:default",
    "core:window:allow-destroy",
    "core:window:allow-set-title",
  ]) {
    if (!mainWindowPermissions.includes(permission)) {
      errors.push(`main window capability is missing ${permission}`);
    }
  }
}

if (config.bundle?.category !== "DeveloperTool") {
  errors.push("bundle.category must be DeveloperTool");
}

const requiredBundleIcons = [
  "icons/32x32.png",
  "icons/128x128.png",
  "icons/128x128@2x.png",
  "icons/icon.icns",
  "icons/icon.ico",
];
if (!Array.isArray(bundleIcons) || bundleIcons.length === 0) {
  errors.push("bundle.icon must declare packaged app icons");
} else {
  for (const iconPath of requiredBundleIcons) {
    if (!bundleIcons.includes(iconPath)) {
      errors.push(`bundle.icon is missing ${iconPath}`);
    }
    if (!fs.existsSync(path.join(rootDir, "src-tauri", iconPath))) {
      errors.push(`bundle icon file does not exist: ${iconPath}`);
    }
  }
}

if (!Array.isArray(associations) || associations.length === 0) {
  errors.push("bundle.fileAssociations must declare editor file types");
}

const seenExtensions = new Set();
for (const [index, association] of (associations ?? []).entries()) {
  const label = association.name ?? `file association ${index + 1}`;
  if (!Array.isArray(association.ext) || association.ext.length === 0) {
    errors.push(`${label} must include at least one extension`);
    continue;
  }

  if (association.role !== "Editor") {
    errors.push(`${label} must use role Editor`);
  }
  if (!["Alternate", "Default"].includes(association.rank)) {
    errors.push(`${label} must use rank Alternate or Default`);
  }
  if (!["text/plain", "text/xml"].includes(association.mimeType)) {
    errors.push(`${label} must use a text MIME type`);
  }

  for (const ext of association.ext) {
    if (typeof ext !== "string" || ext.length === 0) {
      errors.push(`${label} contains a non-string or empty extension`);
      continue;
    }
    if (ext.startsWith(".")) {
      errors.push(`${label} extension must omit the leading dot: ${ext}`);
    }
    if (ext !== ext.toLowerCase()) {
      errors.push(`${label} extension must be lowercase: ${ext}`);
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(ext)) {
      errors.push(`${label} extension contains unsupported characters: ${ext}`);
    }
    if (seenExtensions.has(ext)) {
      errors.push(`duplicate file association extension: ${ext}`);
    }
    seenExtensions.add(ext);
    if (unsupportedBinaryExtensions.has(ext)) {
      errors.push(`binary/media/archive extension must not be associated: ${ext}`);
    }
  }
}

for (const ext of requiredAssociatedExtensions) {
  if (!seenExtensions.has(ext)) {
    errors.push(`required editor file association is missing: ${ext}`);
  }
}

if (config.bundle?.targets !== "all") {
  errors.push('bundle.targets must stay "all" so packaging metadata is generated');
}

if (config.build?.devUrl !== "http://127.0.0.1:1420") {
  errors.push("build.devUrl must stay on the expected local development port");
}

if (errors.length > 0) {
  console.error("Tauri config validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Tauri config validation passed");
