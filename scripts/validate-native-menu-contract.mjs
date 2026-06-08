#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rustSource = fs.readFileSync(path.join(rootDir, "src-tauri/src/lib.rs"), "utf8");
const appSource = fs.readFileSync(path.join(rootDir, "src/App.tsx"), "utf8");

const expectedFrontendEvents = new Set([
  "app://error",
  "menu://close-all",
  "menu://close-tab",
  "menu://command-palette",
  "menu://delete-selected",
  "menu://find-in-file",
  "menu://find-in-files",
  "menu://find-references",
  "menu://go-to-definition",
  "menu://go-to-line",
  "menu://new-file",
  "menu://new-folder",
  "menu://open-file",
  "menu://open-workspace",
  "menu://quick-open",
  "menu://reload-file",
  "menu://rename-selected",
  "menu://save-all",
  "menu://save-file",
  "menu://show-integrations",
  "menu://show-key-bindings",
  "menu://show-settings",
]);

const unroutedMenuIds = new Set([
  "recent_file_empty",
  "recent_workspace_empty",
]);

const expectedRoutedMenuIds = new Set([
  "close_all",
  "close_tab",
  "command_palette",
  "delete_selected",
  "find_in_file",
  "find_in_files",
  "find_references",
  "go_to_definition",
  "go_to_line",
  "new_file",
  "new_folder",
  "open_file",
  "open_folder",
  "quick_open",
  "reload_file",
  "rename_selected",
  "save_all",
  "save_file",
  "show_integrations",
  "show_key_bindings",
  "show_settings",
]);

const errors = [];
const declaredMenuIds = new Set([
  ...matches(rustSource, /MenuItemBuilder::with_id\("([^"]+)"/g),
  ...matches(rustSource, /CheckMenuItem::with_id\(\s*app,\s*"([^"]+)"/g),
]);
const routedMenuIds = new Set(matches(rustSource, /id == "([^"]+)"/g));
const routedMenuPrefixes = new Set(matches(rustSource, /id\.strip_prefix\("([^"]+)"\)/g));
const emittedEvents = new Set([
  ...matches(rustSource, /app\.emit\(\s*"((?:menu|app):\/\/[^"]+)"/g),
  ...matches(rustSource, /emit_to_active_window\(\s*app,\s*"((?:menu|app):\/\/[^"]+)"/g),
]);
const listenedEvents = new Set(matches(appSource, /listen(?:<[^>]+>)?\(\s*"((?:menu|app):\/\/[^"]+)"/g));

for (const id of expectedRoutedMenuIds) {
  if (!declaredMenuIds.has(id)) {
    errors.push(`expected native menu item is not declared: ${id}`);
  }
  if (!routedMenuIds.has(id)) {
    errors.push(`expected native menu item is not routed: ${id}`);
  }
}

for (const id of declaredMenuIds) {
  if (unroutedMenuIds.has(id)) continue;
  if (!routedMenuIds.has(id)) {
    errors.push(`declared native menu item has no event route: ${id}`);
  }
}

for (const prefix of ["recent_workspace:", "recent_file:"]) {
  if (!routedMenuPrefixes.has(prefix)) {
    errors.push(`native recent menu prefix is not routed: ${prefix}`);
  }
}

for (const event of expectedFrontendEvents) {
  if (!emittedEvents.has(event)) {
    errors.push(`expected native event is not emitted by Rust: ${event}`);
  }
  if (!listenedEvents.has(event)) {
    errors.push(`expected native event is not listened to by React: ${event}`);
  }
}

for (const event of emittedEvents) {
  if (!expectedFrontendEvents.has(event)) {
    errors.push(`Rust emits an unreviewed native event: ${event}`);
  }
  if (!listenedEvents.has(event)) {
    errors.push(`Rust emits a native event without a React listener: ${event}`);
  }
}

for (const event of listenedEvents) {
  if (!expectedFrontendEvents.has(event)) {
    errors.push(`React listens to an unreviewed native event: ${event}`);
  }
  if (!emittedEvents.has(event)) {
    errors.push(`React listens to a native event Rust does not emit: ${event}`);
  }
}

if (
  !/#\[cfg\(target_os = "macos"\)\]\s+let app_menu = \{[\s\S]*?\.item\(&settings\)[\s\S]*?\.quit\(\)/.test(
    rustSource,
  )
) {
  errors.push("macOS app menu must contain Settings and Quit");
}

if (
  !/#\[cfg\(target_os = "macos"\)\]\s+let view_menu = SubmenuBuilder::new\(app, "View"\)\s+\.item\(&show_integrations\)\s+\.item\(&show_key_bindings\)\s+\.build\(\)/.test(
    rustSource,
  )
) {
  errors.push("macOS View menu must not contain Settings");
}

if (
  !/#\[cfg\(not\(target_os = "macos"\)\)\]\s+let view_menu = SubmenuBuilder::new\(app, "View"\)[\s\S]*?\.item\(&settings\)/.test(
    rustSource,
  )
) {
  errors.push("non-macOS View menu must keep Settings available");
}

if (errors.length > 0) {
  console.error("Native menu contract validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Native menu contract validation passed");

function matches(source, pattern) {
  return Array.from(source.matchAll(pattern), (match) => match[1]);
}
