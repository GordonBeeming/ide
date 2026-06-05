#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const configPath = path.join(rootDir, "src-tauri", "tauri.conf.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const associations = config.bundle?.fileAssociations;

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

if (config.bundle?.category !== "DeveloperTool") {
  errors.push("bundle.category must be DeveloperTool");
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
