#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { createServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const files = [
  { path: "docs", name: "docs", isDir: true, depth: 0, size: 0 },
  {
    path: "docs/README.md",
    name: "README.md",
    parent: "docs",
    isDir: false,
    depth: 1,
    size: 48,
    modifiedMs: 1,
  },
  { path: "src", name: "src", isDir: true, depth: 0, size: 0 },
  {
    path: "src/App.tsx",
    name: "App.tsx",
    parent: "src",
    isDir: false,
    depth: 1,
    size: 64,
    modifiedMs: 2,
  },
  {
    path: "package.json",
    name: "package.json",
    isDir: false,
    depth: 0,
    size: 64,
    modifiedMs: 3,
  },
  {
    path: "image.png",
    name: "image.png",
    isDir: false,
    depth: 0,
    size: 12,
    modifiedMs: 4,
  },
];

const fileContents = new Map([
  [
    "docs/README.md",
    "# Smoke workspace\n\nThis smoke markdown file proves editor loading.\n",
  ],
  ["src/App.tsx", "export function App() {\n  return <main>Smoke</main>;\n}\n"],
  ["package.json", "{\n  \"name\": \"ide-smoke\"\n}\n"],
]);

function findBrowserExecutable() {
  const candidates = [
    process.env.IDE_SMOKE_BROWSER,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    commandPath("google-chrome"),
    commandPath("chromium"),
    commandPath("chromium-browser"),
    commandPath("microsoft-edge"),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function commandPath(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function json(body) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

function text(body) {
  return {
    status: 200,
    contentType: "text/plain; charset=utf-8",
    body,
  };
}

async function fulfillApi(route) {
  const request = route.request();
  const url = new URL(request.url());

  if (request.method() === "PUT" && url.pathname === "/api/agent-context") {
    await route.fulfill({ status: 204 });
    return;
  }

  if (url.pathname === "/api/workspace-root") {
    await route.fulfill(text("/tmp/ide-smoke-workspace"));
    return;
  }

  if (url.pathname === "/api/files") {
    await route.fulfill(json(files));
    return;
  }

  if (url.pathname === "/api/file") {
    const filePath = url.searchParams.get("path") ?? "";
    await route.fulfill(text(fileContents.get(filePath) ?? ""));
    return;
  }

  if (url.pathname === "/api/search") {
    await route.fulfill(
      json([
        {
          path: "docs/README.md",
          lineNumber: 3,
          lineText: "This smoke markdown file proves editor loading.",
          matchStart: 5,
          matchEnd: 10,
        },
      ]),
    );
    return;
  }

  if (url.pathname === "/api/lsp") {
    await route.fulfill(json([]));
    return;
  }

  if (url.pathname === "/api/codex-mcp") {
    await route.fulfill(
      json({
        endpoint: "http://127.0.0.1:17877/mcp",
        bearerToken: "smoke-token",
      }),
    );
    return;
  }

  await route.fulfill({ status: 404, body: `Unhandled smoke API route: ${url.pathname}` });
}

async function assertTheme(page, expectedScheme) {
  const colors = await page.evaluate(() => {
    const appShell = document.querySelector(".app-shell");
    const sidebar = document.querySelector(".sidebar");
    const topbar = document.querySelector(".topbar");
    const editorRegion = document.querySelector(".editor-region");
    const cmScroller = document.querySelector(".cm-scroller");
    if (!appShell) throw new Error("app shell missing");
    if (!sidebar) throw new Error("sidebar missing");
    if (!topbar) throw new Error("topbar missing");
    if (!editorRegion) throw new Error("editor region missing");
    return {
      appShell: getComputedStyle(appShell).backgroundColor,
      appShellClasses: [...appShell.classList],
      documentTheme: document.documentElement.dataset.ideTheme,
      sidebar: getComputedStyle(sidebar).backgroundColor,
      topbar: getComputedStyle(topbar).backgroundColor,
      editorRegion: getComputedStyle(editorRegion).backgroundColor,
      cmScroller: cmScroller ? getComputedStyle(cmScroller).backgroundColor : undefined,
    };
  });

  if (!colors.appShellClasses.includes(`app-shell--${expectedScheme}`)) {
    throw new Error(
      `${expectedScheme} theme class missing: ${colors.appShellClasses.join(" ")}`,
    );
  }
  if (colors.documentTheme !== expectedScheme) {
    throw new Error(
      `${expectedScheme} document theme mismatch: ${colors.documentTheme ?? "unset"}`,
    );
  }
  if (colors.appShell !== colors.editorRegion) {
    throw new Error(
      `${expectedScheme} theme mismatch: shell=${colors.appShell}, editor=${colors.editorRegion}`,
    );
  }
  if (colors.cmScroller && colors.cmScroller !== colors.editorRegion) {
    throw new Error(
      `${expectedScheme} editor mismatch: region=${colors.editorRegion}, scroller=${colors.cmScroller}`,
    );
  }

  const expectedLight = expectedScheme === "light";
  for (const [name, value] of Object.entries({
    appShell: colors.appShell,
    sidebar: colors.sidebar,
    topbar: colors.topbar,
    editorRegion: colors.editorRegion,
    ...(colors.cmScroller ? { cmScroller: colors.cmScroller } : {}),
  })) {
    const luminance = relativeLuminance(value);
    if (expectedLight && luminance < 0.55) {
      throw new Error(`${expectedScheme} ${name} is too dark: ${value}`);
    }
    if (!expectedLight && luminance > 0.3) {
      throw new Error(`${expectedScheme} ${name} is too light: ${value}`);
    }
  }
}

function relativeLuminance(cssColor) {
  const oklchMatch = cssColor.match(/^oklch\(([\d.]+)/);
  if (oklchMatch) {
    return Number(oklchMatch[1]);
  }

  const match = cssColor.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`Unsupported computed color format: ${cssColor}`);
  const [red, green, blue] = match.slice(1, 4).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

async function runScenario(browser, url, colorScheme) {
  const context = await browser.newContext({
    colorScheme,
    viewport: { width: 1280, height: 820 },
  });
  await context.route("**/api/**", fulfillApi);

  const consoleErrors = [];
  const pageErrors = [];
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(url, { waitUntil: "networkidle" });
  await page.getByText("Workspace", { exact: true }).waitFor();
  await page.locator(".sidebar__title strong", { hasText: "ide-smoke-workspace" }).waitFor();
  await page.getByText("No file selected").waitFor();

  if ((await page.locator('input[placeholder="Filter files"]').count()) !== 0) {
    throw new Error("file filter input should be collapsed on first render");
  }
  if ((await page.locator('input[placeholder="Search contents"]').count()) !== 0) {
    throw new Error("content search input should be collapsed on first render");
  }
  if ((await page.locator('input[placeholder="Find in file"]').count()) !== 0) {
    throw new Error("current-file search input should be collapsed on first render");
  }

  await assertTheme(page, colorScheme);

  const commandModifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${commandModifier}+Shift+P`);
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.locator('input[placeholder="Run command"]').fill("workspace");
  await page.keyboard.press("Enter");
  await page.locator('input[placeholder="Search contents"]').waitFor();

  await page.getByLabel("Filter files").click();
  await page.locator('input[placeholder="Filter files"]').fill("README");
  await page.getByText("README.md").waitFor();
  if (await page.getByText("package.json").isVisible()) {
    throw new Error("file filter did not hide unrelated files");
  }

  await page.locator('input[placeholder="Filter files"]').fill("");
  await page.getByLabel("Search contents").click();
  await page.locator('input[placeholder="Search contents"]').fill("smoke");
  await page.getByText("docs/README.md:3").waitFor();

  await page.getByText("README.md").dblclick();
  await page.locator(".cm-content").waitFor();
  await page.getByText("Smoke workspace").waitFor();
  await assertTheme(page, colorScheme);

  const saveDisabled = await page
    .locator('button[title="Save"]')
    .evaluate((button) => button.disabled);
  const saveAllDisabled = await page
    .locator('button[title="Save all"]')
    .evaluate((button) => button.disabled);
  if (!saveDisabled || !saveAllDisabled) {
    throw new Error("save commands should be disabled for clean opened files");
  }

  await context.close();

  if (pageErrors.length > 0) {
    throw new Error(`${colorScheme} page errors: ${pageErrors.join("\n")}`);
  }
  if (consoleErrors.length > 0) {
    throw new Error(`${colorScheme} console errors: ${consoleErrors.join("\n")}`);
  }
}

async function main() {
  const browserExecutable = findBrowserExecutable();
  if (!browserExecutable) {
    throw new Error(
      "No local Chromium browser found for smoke tests. Install Google Chrome or set IDE_SMOKE_BROWSER.",
    );
  }

  const server = await createServer({
    configFile: path.join(rootDir, "vite.config.ts"),
    root: rootDir,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
    },
  });

  let browser;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("Vite did not expose a TCP address for smoke tests");
    }
    const url = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({
      executablePath: browserExecutable,
      headless: true,
    });
    await runScenario(browser, url, "light");
    await runScenario(browser, url, "dark");
    console.log("Smoke tests passed");
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
