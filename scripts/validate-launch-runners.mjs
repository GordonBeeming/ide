#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const runScriptPath = path.join(rootDir, "run.sh");
const finderInstallScript = path.join(rootDir, "scripts", "install-macos-finder-quick-action.sh");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-launch-runners-"));

try {
  const runScript = readExecutable(runScriptPath, "run.sh");
  assertIncludes(runScript, "handoff_to_running_app()");
  assertIncludes(runScript, 'api_base="http://127.0.0.1:17877"');
  assertIncludes(runScript, "$api_base/api/codex-mcp");
  assertIncludes(runScript, "bearerToken");
  assertIncludes(runScript, 'Authorization: Bearer $token');
  assertIncludes(runScript, "-X POST");
  assertIncludes(runScript, "$api_base/api/open-path");
  assertIncludes(runScript, 'if [ -n "$OPEN_PATH" ] && handoff_to_running_app "$OPEN_PATH"; then');
  assertIncludes(runScript, "running_app_reachable()");
  assertIncludes(runScript, "activate_running_app()");
  assertIncludes(runScript, 'if [ -z "$OPEN_PATH" ] && running_app_reachable; then');
  assertIncludes(runScript, "Ide is already running; not starting a duplicate dev instance.");
  assertIncludes(runScript, "ensure_dev_port_available");
  assertOrdered(runScript, "handoff_to_running_app \"$OPEN_PATH\"", "ensure_dev_port_available");
  assertOrdered(runScript, "running_app_reachable", "ensure_dev_port_available");

  const serviceRoot = path.join(tempDir, "Services", "Open in Ide.workflow");
  const supportDir = path.join(tempDir, "Support", "Ide");
  execFileSync("bash", [finderInstallScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      IDE_SERVICE_ROOT: serviceRoot,
      IDE_SUPPORT_DIR: supportDir,
      IDE_SKIP_SERVICE_REFRESH: "1",
    },
    stdio: "pipe",
  });

  const finderRunner = readExecutable(
    path.join(supportDir, "open-from-finder.sh"),
    "Finder runner",
  );
  assertIncludes(finderRunner, "handoff_to_running_app()");
  assertIncludes(finderRunner, 'API_BASE="http://127.0.0.1:17877"');
  assertIncludes(finderRunner, "$API_BASE/api/codex-mcp");
  assertIncludes(finderRunner, "bearerToken");
  assertIncludes(finderRunner, 'Authorization: Bearer $token');
  assertIncludes(finderRunner, "-X POST");
  assertIncludes(finderRunner, "$API_BASE/api/open-path");
  assertIncludes(finderRunner, "ensure_frontend_server");
  assertIncludes(finderRunner, "launch_app");
  if (!/if handoff_to_running_app; then[\s\S]*ensure_frontend_server[\s\S]*launch_app/.test(finderRunner)) {
    throw new Error("Finder runner must hand off to a running app before starting the dev server");
  }

  console.log("Launch runner validation passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function readExecutable(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
  const mode = fs.statSync(filePath).mode;
  if ((mode & 0o111) === 0) {
    throw new Error(`${label} is not executable`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function assertIncludes(text, expected) {
  if (!text.includes(expected)) {
    throw new Error(`Launch runner output is missing: ${expected}`);
  }
}

function assertOrdered(text, earlier, later) {
  const earlierIndex = text.indexOf(earlier);
  const laterIndex = text.indexOf(later);
  if (earlierIndex === -1 || laterIndex === -1 || earlierIndex >= laterIndex) {
    throw new Error(`Expected "${earlier}" to appear before "${later}"`);
  }
}
