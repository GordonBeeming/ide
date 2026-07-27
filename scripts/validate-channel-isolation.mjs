#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const tempRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "ide-channel-isolation-")),
);

try {
  runCase("development target handoff", testDevelopmentTargetHandoff);
  runCase("unrelated Vite listener preservation", () =>
    testUnrelatedPortIsPreserved("unrelated-vite", "14717"),
  );
  runCase("unrelated API listener preservation", () =>
    testUnrelatedPortIsPreserved("unrelated-api", "17878"),
  );
  runCase("checkout-owned cleanup", testCheckoutOwnedCleanup);
  runCase("production port non-interference", testProductionPortIsIgnored);
  runCase("install policy and launcher paths", testInstallPolicyAndLaunchers);
  console.log("Channel isolation behavior validation passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function runCase(label, callback) {
  callback();
  console.log(`Passed: ${label}`);
}

function testDevelopmentTargetHandoff() {
  const harness = createHarness("handoff");
  const target = path.join(harness.base, "workspace");
  fs.mkdirSync(target);

  const result = runShell(path.join(rootDir, "run.sh"), [target], harness, "handoff");
  assertStatus(result, 0, "development target handoff");

  const curlLog = readLog(harness, "curl.log");
  assertIncludes(curlLog, "127.0.0.1:17878/api/codex-mcp");
  assertIncludes(curlLog, "127.0.0.1:17878/api/open-path");
  assertIncludes(curlLog, "Authorization: Bearer dev-token");
  assertNotIncludes(curlLog, "17877");
  assertEmptyLog(harness, "npm.log", "handoff must not start a second development app");
  assertProductionSentinel(harness);
}

function testUnrelatedPortIsPreserved(scenario, port) {
  const harness = createHarness(scenario);
  const result = runShell(path.join(rootDir, "run.sh"), [], harness, scenario);

  if (result.status === 0) {
    throw new Error(`${scenario} should fail instead of stopping an unrelated listener`);
  }
  assertIncludes(result.stderr, `Port ${port} is owned by an unrelated process`);
  assertEmptyLog(harness, "kill.log", `${scenario} must not send a signal`);
  assertEmptyLog(harness, "npm.log", `${scenario} must fail before launching Tauri`);
  assertProductionSentinel(harness);
}

function testCheckoutOwnedCleanup() {
  const harness = createHarness("checkout-owned-api");
  const result = runShell(path.join(rootDir, "run.sh"), [], harness, "checkout-owned-api");
  assertStatus(result, 0, "checkout-owned cleanup");

  assertIncludes(readLog(harness, "kill.log"), "4201");
  assertIncludes(readLog(harness, "npm.log"), "run tauri:dev -- --config src-tauri/tauri.dev.conf.json");
  assertNotIncludes(readLog(harness, "lsof.log"), "17877");
  assertProductionSentinel(harness);
}

function testProductionPortIsIgnored() {
  const harness = createHarness("empty-ports");
  const result = runShell(path.join(rootDir, "run.sh"), [], harness, "empty-ports");
  assertStatus(result, 0, "empty development ports");

  assertNotIncludes(readLog(harness, "lsof.log"), "17877");
  assertEmptyLog(harness, "kill.log", "production port must not trigger a signal");
  assertEmptyLog(harness, "osascript.log", "production app must not be addressed");
  assertProductionSentinel(harness);
}

function testInstallPolicyAndLaunchers() {
  const harness = createHarness("build-success");
  const checkout = path.join(harness.base, "checkout");
  const scriptsDir = path.join(checkout, "scripts");
  fs.mkdirSync(path.join(checkout, "src-tauri"), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  copyExecutable(path.join(rootDir, "build.sh"), path.join(checkout, "build.sh"));
  copyExecutable(
    path.join(rootDir, "scripts", "install-cli-command.sh"),
    path.join(scriptsDir, "install-cli-command.sh"),
  );
  fs.writeFileSync(path.join(checkout, "src-tauri", "tauri.dev.conf.json"), "{}\n");
  fs.writeFileSync(path.join(checkout, "run.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const installParent = path.join(harness.base, "installed");
  fs.mkdirSync(installParent);
  const installedApp = path.join(installParent, "ide-dev.app");
  const cliBinDir = path.join(harness.base, "bin");
  const buildEnv = {
    HARNESS_CHECKOUT: checkout,
    HARNESS_ALLOWED_ROOT: harness.base,
    IDE_DEV_INSTALLED_APP_PATH: installedApp,
    IDE_DEV_SIGNING_IDENTITY: "Apple Development: Harness",
    IDE_CLI_BIN_DIR: cliBinDir,
  };

  const result = runShell(path.join(checkout, "build.sh"), [], harness, "build-success", buildEnv);
  assertStatus(result, 0, "stubbed development build/install");
  if (!fs.existsSync(path.join(installedApp, "Contents", "MacOS", "ide"))) {
    throw new Error("stubbed build did not copy the development app to its approved target");
  }

  const codesignLog = readLog(harness, "codesign.log");
  assertIncludes(codesignLog, "--force --deep --sign Apple Development: Harness");
  assertIncludes(codesignLog, "--identifier com.gordonbeeming.ide.dev");
  assertIncludes(codesignLog, `--verify --deep --strict ${installedApp}`);
  assertIncludes(readLog(harness, "ditto.log"), installedApp);

  const ideLauncher = fs.readFileSync(path.join(cliBinDir, "ide"), "utf8");
  assertIncludes(ideLauncher, 'APP_BUNDLE="/Applications/ide.app"');
  const ideDevTarget = fs.readlinkSync(path.join(cliBinDir, "ide-dev"));
  if (ideDevTarget !== path.join(checkout, "run.sh")) {
    throw new Error(`ide-dev launcher should link to checkout run.sh, got ${ideDevTarget}`);
  }

  for (const rejectedPath of [
    `${harness.base}/installed/../escape/ide-dev.app`,
    path.join(harness.base, "installed", "another.app"),
    "/Applications/ide-dev.app",
  ]) {
    assertRejectedInstallPath(checkout, harness, rejectedPath, buildEnv);
  }

  const aliasTarget = path.join(harness.base, "outside-root");
  const aliasParent = path.join(harness.base, "install-alias");
  fs.mkdirSync(aliasTarget);
  fs.symlinkSync(aliasTarget, aliasParent);
  const symlinkPrefixResult = runShell(
    path.join(checkout, "build.sh"),
    [],
    harness,
    "build-success",
    {
      ...buildEnv,
      IDE_DEV_INSTALLED_APP_PATH: path.join(aliasParent, "ide-dev.app"),
    },
  );
  assertStatus(symlinkPrefixResult, 0, "symlink-prefix development install");
  assertProductionSentinel(harness);
}

function assertRejectedInstallPath(checkout, harness, rejectedPath, baseEnv) {
  truncateLog(harness, "npm.log");
  truncateLog(harness, "rm.log");
  truncateLog(harness, "ditto.log");

  const result = runShell(path.join(checkout, "build.sh"), [], harness, "build-rejected", {
    ...baseEnv,
    IDE_DEV_INSTALLED_APP_PATH: rejectedPath,
  });
  if (result.status === 0) {
    throw new Error(`unsafe development install path was accepted: ${rejectedPath}`);
  }
  assertEmptyLog(harness, "npm.log", `rejected path reached npm: ${rejectedPath}`);
  assertEmptyLog(harness, "rm.log", `rejected path reached rm: ${rejectedPath}`);
  assertEmptyLog(harness, "ditto.log", `rejected path reached ditto: ${rejectedPath}`);
  assertProductionSentinel(harness);
}

function createHarness(name) {
  const base = path.join(tempRoot, name);
  const home = path.join(base, "home");
  const state = path.join(base, "state");
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "production-sentinel"), "production-preserved\n");

  const bashEnv = path.join(base, "bash-env.sh");
  fs.writeFileSync(
    bashEnv,
    `kill() {
  printf '%s\\n' "$*" >> "$HARNESS_STATE/kill.log"
  for argument in "$@"; do
    case "$argument" in
      ''|'-'*) ;;
      *) touch "$HARNESS_STATE/killed-$argument" ;;
    esac
  done
  return 0
}
sleep() { return 0; }
`,
  );

  const stubs = {
    curl: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HARNESS_STATE/curl.log"
case "$HARNESS_SCENARIO" in
  handoff)
    case "$*" in
      *'/api/open-path'*) exit 0 ;;
      *'/api/codex-mcp'*) printf '%s\\n' '{"bearerToken":"dev-token"}'; exit 0 ;;
    esac
    ;;
esac
exit 1
`,
    lsof: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HARNESS_STATE/lsof.log"
case "$*" in
  *'-d cwd -Fn'*)
    case "$HARNESS_SCENARIO" in
      unrelated-vite) printf '%s\\n' 'n/unrelated/workspace' ;;
    esac
    exit 0
    ;;
  *'-tiTCP:14717'*)
    [ "$HARNESS_SCENARIO" = 'unrelated-vite' ] && printf '%s\\n' '4101'
    ;;
  *'-tiTCP:17878'*)
    if [ "$HARNESS_SCENARIO" = 'unrelated-api' ]; then
      printf '%s\\n' '4102'
    elif [ "$HARNESS_SCENARIO" = 'checkout-owned-api' ] && [ ! -e "$HARNESS_STATE/killed-4201" ]; then
      printf '%s\\n' '4201'
    fi
    ;;
esac
exit 0
`,
    ps: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HARNESS_STATE/ps.log"
if [ "$*" = '-axo pid=' ]; then
  if [ "$HARNESS_SCENARIO" = 'checkout-owned-api' ] && [ ! -e "$HARNESS_STATE/killed-4201" ]; then
    printf '%s\\n' '4201'
  fi
  exit 0
fi
case "$*" in
  *'-p 4101 '*) printf '%s\\n' '/usr/local/bin/node /unrelated/node_modules/.bin/vite' ;;
  *'-p 4102 '*) printf '%s\\n' '/usr/bin/python3 unrelated-server.py' ;;
  *'-p 4201 '*)
    [ ! -e "$HARNESS_STATE/killed-4201" ] && printf '%s\\n' "$HARNESS_REPO_ROOT/src-tauri/target/debug/ide"
    ;;
esac
`,
    npm: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HARNESS_STATE/npm.log"
if [ "$HARNESS_SCENARIO" = 'build-rejected' ]; then
  exit 91
fi
if [ "$HARNESS_SCENARIO" = 'build-success' ]; then
  app="$HARNESS_CHECKOUT/src-tauri/target/release/bundle/macos/ide-dev.app"
  mkdir -p "$app/Contents/MacOS"
  printf '%s\\n' '#!/usr/bin/env bash' > "$app/Contents/MacOS/ide"
  chmod 755 "$app/Contents/MacOS/ide"
fi
exit 0
`,
    cargo: "#!/usr/bin/env bash\nexit 0\n",
    osascript: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HARNESS_STATE/osascript.log"
exit 0
`,
    open: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HARNESS_STATE/open.log"
exit 0
`,
    codesign: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HARNESS_STATE/codesign.log"
exit 0
`,
    security: "#!/usr/bin/env bash\nexit 0\n",
    mdimport: "#!/usr/bin/env bash\nexit 0\n",
    rm: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HARNESS_STATE/rm.log"
target=""
for argument in "$@"; do target="$argument"; done
case "$target" in
  "$HARNESS_ALLOWED_ROOT"/*) exec /bin/rm "$@" ;;
  *) printf '%s\\n' "blocked rm target: $target" >&2; exit 97 ;;
esac
`,
    ditto: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HARNESS_STATE/ditto.log"
source_app="$1"
installed_app="$2"
case "$installed_app" in
  "$HARNESS_ALLOWED_ROOT"/*) exec /usr/bin/ditto "$source_app" "$installed_app" ;;
  *) printf '%s\\n' "blocked ditto target: $installed_app" >&2; exit 98 ;;
esac
`,
  };

  for (const [command, contents] of Object.entries(stubs)) {
    writeExecutable(path.join(binDir, command), contents);
  }

  return { base, home, state, bashEnv, binDir };
}

function runShell(script, args, harness, scenario, extraEnv = {}) {
  return spawnSync("bash", [script, ...args], {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: harness.home,
      PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
      BASH_ENV: harness.bashEnv,
      HARNESS_STATE: harness.state,
      HARNESS_SCENARIO: scenario,
      HARNESS_REPO_ROOT: rootDir,
      HARNESS_ALLOWED_ROOT: harness.base,
      ...extraEnv,
    },
  });
}

function copyExecutable(source, destination) {
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o755);
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function readLog(harness, name) {
  const filePath = path.join(harness.state, name);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function truncateLog(harness, name) {
  fs.writeFileSync(path.join(harness.state, name), "");
}

function assertEmptyLog(harness, name, message) {
  if (readLog(harness, name).trim() !== "") {
    throw new Error(`${message}: ${readLog(harness, name).trim()}`);
  }
}

function assertProductionSentinel(harness) {
  const actual = fs.readFileSync(path.join(harness.state, "production-sentinel"), "utf8");
  if (actual !== "production-preserved\n") {
    throw new Error("production sentinel changed during channel behavior validation");
  }
}

function assertStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(
      `${label} exited ${result.status}; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
}

function assertIncludes(text, expected) {
  if (!text.includes(expected)) {
    throw new Error(`Expected output to include ${JSON.stringify(expected)}; got ${JSON.stringify(text)}`);
  }
}

function assertNotIncludes(text, unexpected) {
  if (text.includes(unexpected)) {
    throw new Error(`Output should not include ${JSON.stringify(unexpected)}; got ${JSON.stringify(text)}`);
  }
}
