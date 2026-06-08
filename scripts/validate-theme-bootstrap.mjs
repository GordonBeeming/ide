#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const indexPath = path.join(rootDir, "index.html");
const systemThemePath = path.join(rootDir, "src", "systemTheme.ts");

const indexHtml = fs.readFileSync(indexPath, "utf8");
const systemTheme = fs.readFileSync(systemThemePath, "utf8");

const queryMatch = systemTheme.match(
  /darkSchemeQuery\s*=\s*["']([^"']+)["']/,
);

if (!queryMatch) {
  fail("src/systemTheme.ts must export the dark-mode media query literal");
}

const [darkSchemeQuery] = queryMatch.slice(1);
const bootstrapScriptStart = indexHtml.indexOf("<script>");
const moduleScriptStart = indexHtml.indexOf('<script type="module"');

if (bootstrapScriptStart === -1) {
  fail("index.html must bootstrap the theme before the app module loads");
}

if (moduleScriptStart === -1) {
  fail("index.html must keep the app module script in the document");
}

if (bootstrapScriptStart > moduleScriptStart) {
  fail("index.html theme bootstrap must run before the app module script");
}

const bootstrapScript = indexHtml.slice(bootstrapScriptStart, moduleScriptStart);

for (const expected of [
  darkSchemeQuery,
  "document.documentElement.dataset.ideTheme",
  "document.documentElement.style.colorScheme",
]) {
  if (!bootstrapScript.includes(expected)) {
    fail(`index.html theme bootstrap is missing: ${expected}`);
  }
}

console.log("Theme bootstrap validation passed");

function fail(message) {
  console.error(message);
  process.exit(1);
}
