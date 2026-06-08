#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const assetsDir = path.join(distDir, "assets");

const budgets = {
  initialJsBytes: 600_000,
  initialCssBytes: 80_000,
  editorChunkBytes: 90_000,
};

function bytes(filePath) {
  return fs.statSync(filePath).size;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function assertBudget(label, actual, limit) {
  if (actual > limit) {
    fail(`${label} is ${actual} bytes, over budget ${limit} bytes`);
  }
}

function assetPath(assetUrl) {
  return path.join(distDir, assetUrl.replace(/^\//, ""));
}

if (!fs.existsSync(distDir)) {
  fail("dist/ does not exist. Run npm run build before npm run budget.");
  process.exit();
}

const indexPath = path.join(distDir, "index.html");
const indexHtml = fs.readFileSync(indexPath, "utf8");
const startupScripts = [...indexHtml.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map(
  (match) => match[1],
);
const startupStyles = [...indexHtml.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map(
  (match) => match[1],
);

if (startupScripts.length === 0) {
  fail("No startup script found in dist/index.html");
}
if (startupStyles.length === 0) {
  fail("No startup stylesheet found in dist/index.html");
}

const initialJsBytes = startupScripts
  .map(assetPath)
  .reduce((total, filePath) => total + bytes(filePath), 0);
const initialCssBytes = startupStyles
  .map(assetPath)
  .reduce((total, filePath) => total + bytes(filePath), 0);
const editorChunk = fs
  .readdirSync(assetsDir)
  .find((fileName) => /^EditorPane-.*\.js$/.test(fileName));

if (!editorChunk) {
  fail("No lazy EditorPane chunk found in dist/assets");
}

const editorChunkBytes = editorChunk
  ? bytes(path.join(assetsDir, editorChunk))
  : Number.POSITIVE_INFINITY;

assertBudget("Initial JavaScript", initialJsBytes, budgets.initialJsBytes);
assertBudget("Initial CSS", initialCssBytes, budgets.initialCssBytes);
assertBudget("Lazy editor chunk", editorChunkBytes, budgets.editorChunkBytes);

if (process.exitCode) {
  process.exit();
}

console.log(
  [
    "Bundle budget passed",
    `initial JS ${initialJsBytes}/${budgets.initialJsBytes} bytes`,
    `initial CSS ${initialCssBytes}/${budgets.initialCssBytes} bytes`,
    `editor chunk ${editorChunkBytes}/${budgets.editorChunkBytes} bytes`,
  ].join("\n"),
);
