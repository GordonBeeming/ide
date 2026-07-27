#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const installScript = path.join(rootDir, "scripts", "install-macos-finder-quick-action.sh");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-finder-action-"));
const serviceRoot = path.join(tempDir, "Services", "Open in ide.workflow");
const supportDir = path.join(tempDir, "Support", "ide");

try {
  execFileSync("bash", [installScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      IDE_SERVICE_ROOT: serviceRoot,
      IDE_SUPPORT_DIR: supportDir,
      IDE_SKIP_SERVICE_REFRESH: "1",
    },
    stdio: "pipe",
  });

  const runnerPath = path.join(supportDir, "open-from-finder.sh");
  const infoPlistPath = path.join(serviceRoot, "Contents", "Info.plist");
  const workflowPath = path.join(serviceRoot, "Contents", "document.wflow");
  assertFile(runnerPath);
  assertFile(infoPlistPath);
  assertFile(workflowPath);

  const runnerMode = fs.statSync(runnerPath).mode;
  if ((runnerMode & 0o111) === 0) {
    throw new Error("Finder runner is not executable");
  }

  const runner = fs.readFileSync(runnerPath, "utf8");
  assertIncludes(runner, 'APP_BUNDLE="/Applications/ide.app"');
  assertIncludes(runner, 'API_BASE="http://127.0.0.1:17877"');
  assertIncludes(runner, "bearerToken");
  assertIncludes(runner, 'Authorization: Bearer $token');
  assertIncludes(runner, "-X POST");
  assertIncludes(runner, "$API_BASE/api/open-path");
  assertIncludes(runner, 'if [ ! -x "$APP_BUNDLE/Contents/MacOS/ide" ]; then');
  assertIncludes(runner, 'open "$APP_BUNDLE" --args "$TARGET"');
  assertNotIncludes(runner, "FRONTEND_URL");
  assertNotIncludes(runner, "ROOT_DIR");
  assertNotIncludes(runner, "npm");
  assertNotIncludes(runner, "cargo");
  assertNotIncludes(runner, "ensure_frontend_server");
  assertNotIncludes(runner, "launch_app");
  assertOrdered(runner, "if handoff_to_running_app; then", 'open "$APP_BUNDLE" --args "$TARGET"');

  const infoPlist = fs.readFileSync(infoPlistPath, "utf8");
  assertIncludes(infoPlist, "<string>Open in ide</string>");
  assertIncludes(infoPlist, "<string>public.item</string>");
  assertIncludes(infoPlist, "<string>public.folder</string>");
  assertIncludes(infoPlist, "<string>public.data</string>");
  assertIncludes(infoPlist, "<string>public.content</string>");
  assertIncludes(infoPlist, "<string>NSFilenamesPboardType</string>");

  const workflow = fs.readFileSync(workflowPath, "utf8");
  assertIncludes(workflow, "Application Support/ide/open-from-finder.sh");
  assertIncludes(workflow, 'for target in "$@"; do');
  assertIncludes(workflow, "Finder did not pass a file or folder");
  assertIncludes(workflow, "com.apple.Automator.fileSystemObject");
  assertIncludes(workflow, "com.apple.Automator.servicesMenu");

  lintPlist(infoPlistPath);
  lintPlist(workflowPath);
  console.log("Finder Quick Action validation passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Expected generated file to exist: ${filePath}`);
  }
}

function assertIncludes(text, expected) {
  if (!text.includes(expected)) {
    throw new Error(`Generated Finder Quick Action output is missing: ${expected}`);
  }
}

function assertNotIncludes(text, unexpected) {
  if (text.includes(unexpected)) {
    throw new Error(`Generated Finder Quick Action output should not include: ${unexpected}`);
  }
}

function assertOrdered(text, earlier, later) {
  const earlierIndex = text.indexOf(earlier);
  const laterIndex = text.indexOf(later);
  if (earlierIndex === -1 || laterIndex === -1 || earlierIndex >= laterIndex) {
    throw new Error(`Expected "${earlier}" to appear before "${later}"`);
  }
}

function lintPlist(filePath) {
  if (process.platform !== "darwin") return;
  execFileSync("plutil", ["-lint", filePath], { stdio: "pipe" });
}
