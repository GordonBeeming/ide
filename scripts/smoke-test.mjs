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
  ["deep/Nested.ts", "export const nested = 'indexed smoke file';\n"],
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

  if (url.pathname === "/api/directory") {
    const directoryPath = url.searchParams.get("path") ?? "";
    await route.fulfill(json(files.filter((entry) => entry.parent === directoryPath)));
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

  if (url.pathname === "/api/file-search") {
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    await route.fulfill(
      json(
        query === "nested"
          ? [
              {
                path: "deep/Nested.ts",
                name: "Nested.ts",
                parent: "deep",
                isDir: false,
                depth: 1,
                size: 42,
                modifiedMs: 5,
              },
            ]
          : [],
      ),
    );
    return;
  }

  if (url.pathname === "/api/workspace-index") {
    await route.fulfill(
      json({
        indexedEntries: 7,
        indexedFiles: 4,
        indexedFolders: 3,
        loadedFolders: 2,
        pendingFolders: 1,
      }),
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
    const workbench = document.querySelector(".workbench");
    const editorRegion = document.querySelector(".editor-region");
    const cmScroller = document.querySelector(".cm-scroller");
    if (!appShell) throw new Error("app shell missing");
    if (!sidebar) throw new Error("sidebar missing");
    if (!topbar) throw new Error("topbar missing");
    if (!workbench) throw new Error("workbench missing");
    if (!editorRegion) throw new Error("editor region missing");
    return {
      appShell: getComputedStyle(appShell).backgroundColor,
      appShellClasses: [...appShell.classList],
      appShellTheme: appShell.dataset.ideTheme,
      documentTheme: document.documentElement.dataset.ideTheme,
      documentColorScheme: document.documentElement.style.colorScheme,
      sidebar: getComputedStyle(sidebar).backgroundColor,
      topbar: getComputedStyle(topbar).backgroundColor,
      workbench: getComputedStyle(workbench).backgroundColor,
      editorRegion: getComputedStyle(editorRegion).backgroundColor,
      editorRegionClasses: [...editorRegion.classList],
      editorPaintedCenter: editorPaintedCenterBackground(editorRegion),
      cmScroller: cmScroller ? getComputedStyle(cmScroller).backgroundColor : undefined,
    };

    function editorPaintedCenterBackground(editorRegion) {
      const rect = editorRegion.getBoundingClientRect();
      let current = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );

      while (current) {
        const background = getComputedStyle(current).backgroundColor;
        if (background !== "rgba(0, 0, 0, 0)") return background;
        if (current === editorRegion) break;
        current = current.parentElement;
      }

      return getComputedStyle(editorRegion).backgroundColor;
    }
  });

  if (colors.documentTheme !== expectedScheme) {
    throw new Error(
      `${expectedScheme} document theme mismatch: ${colors.documentTheme ?? "unset"}`,
    );
  }
  if (colors.documentColorScheme !== expectedScheme) {
    throw new Error(
      `${expectedScheme} document color-scheme mismatch: ${colors.documentColorScheme ?? "unset"}`,
    );
  }
  if (colors.appShellTheme !== expectedScheme) {
    throw new Error(
      `${expectedScheme} shell theme mismatch: ${colors.appShellTheme ?? "unset"}`,
    );
  }
  if (colors.appShell !== colors.editorRegion) {
    throw new Error(
      `${expectedScheme} theme mismatch: shell=${colors.appShell}, editor=${colors.editorRegion}`,
    );
  }
  if (colors.workbench !== colors.editorRegion) {
    throw new Error(
      `${expectedScheme} workbench mismatch: workbench=${colors.workbench}, editor=${colors.editorRegion}`,
    );
  }
  if (colors.editorPaintedCenter !== colors.editorRegion) {
    throw new Error(
      `${expectedScheme} visible editor mismatch: painted=${colors.editorPaintedCenter}, editor=${colors.editorRegion}`,
    );
  }
  if (colors.cmScroller && colors.cmScroller !== colors.editorRegion) {
    throw new Error(
      `${expectedScheme} editor mismatch: region=${colors.editorRegion}, scroller=${colors.cmScroller}`,
    );
  }

  const staleDocumentThemeColors = await page.evaluate((scheme) => {
    const appShell = document.querySelector(".app-shell");
    const sidebar = document.querySelector(".sidebar");
    const topbar = document.querySelector(".topbar");
    const workbench = document.querySelector(".workbench");
    const editorRegion = document.querySelector(".editor-region");
    const cmScroller = document.querySelector(".cm-scroller");
    if (!appShell) throw new Error("app shell missing");
    if (!sidebar) throw new Error("sidebar missing");
    if (!topbar) throw new Error("topbar missing");
    if (!workbench) throw new Error("workbench missing");
    if (!editorRegion) throw new Error("editor region missing");

    const originalDocumentTheme = document.documentElement.dataset.ideTheme;
    const originalColorScheme = document.documentElement.style.colorScheme;
    const oppositeScheme = scheme === "light" ? "dark" : "light";
    document.documentElement.dataset.ideTheme = oppositeScheme;
    document.documentElement.style.colorScheme = oppositeScheme;

    const result = {
      appShell: getComputedStyle(appShell).backgroundColor,
      sidebar: getComputedStyle(sidebar).backgroundColor,
      topbar: getComputedStyle(topbar).backgroundColor,
      workbench: getComputedStyle(workbench).backgroundColor,
      editorRegion: getComputedStyle(editorRegion).backgroundColor,
      cmScroller: cmScroller ? getComputedStyle(cmScroller).backgroundColor : undefined,
    };

    if (originalDocumentTheme === undefined) {
      delete document.documentElement.dataset.ideTheme;
    } else {
      document.documentElement.dataset.ideTheme = originalDocumentTheme;
    }
    document.documentElement.style.colorScheme = originalColorScheme;
    return result;
  }, expectedScheme);

  if (staleDocumentThemeColors.workbench !== staleDocumentThemeColors.editorRegion) {
    throw new Error(
      `${expectedScheme} stale document theme can desync workbench and editor: workbench=${staleDocumentThemeColors.workbench}, editor=${staleDocumentThemeColors.editorRegion}`,
    );
  }
  if (
    staleDocumentThemeColors.cmScroller &&
    staleDocumentThemeColors.cmScroller !== staleDocumentThemeColors.editorRegion
  ) {
    throw new Error(
      `${expectedScheme} stale document theme can desync editor scroller: region=${staleDocumentThemeColors.editorRegion}, scroller=${staleDocumentThemeColors.cmScroller}`,
    );
  }
  for (const [name, value] of Object.entries(staleDocumentThemeColors)) {
    if (!value) continue;
    const luminance = relativeLuminance(value);
    if (expectedScheme === "light" && luminance < 0.55) {
      throw new Error(
        `${expectedScheme} ${name} followed stale dark document theme: ${value}`,
      );
    }
    if (expectedScheme === "dark" && luminance > 0.3) {
      throw new Error(
        `${expectedScheme} ${name} followed stale light document theme: ${value}`,
      );
    }
  }

  const forcedLocalThemeMarkers = await page.evaluate((scheme) => {
    const appShell = document.querySelector(".app-shell");
    const editorRegion = document.querySelector(".editor-region");
    if (!appShell) throw new Error("app shell missing");
    if (!editorRegion) throw new Error("editor region missing");

    const originalClassName = editorRegion.className;
    const originalShellTheme = appShell.dataset.ideTheme;
    const oppositeScheme = scheme === "light" ? "dark" : "light";
    appShell.dataset.ideTheme = oppositeScheme;
    editorRegion.classList.add(`editor-region--${oppositeScheme}`);

    const result = {
      appShell: getComputedStyle(appShell).backgroundColor,
      editorRegion: getComputedStyle(editorRegion).backgroundColor,
      workbench: getComputedStyle(document.querySelector(".workbench")).backgroundColor,
    };
    if (originalShellTheme === undefined) {
      delete appShell.dataset.ideTheme;
    } else {
      appShell.dataset.ideTheme = originalShellTheme;
    }
    editorRegion.className = originalClassName;
    return result;
  }, expectedScheme);

  if (
    forcedLocalThemeMarkers.appShell !== forcedLocalThemeMarkers.editorRegion ||
    forcedLocalThemeMarkers.workbench !== forcedLocalThemeMarkers.editorRegion
  ) {
    throw new Error(
      `${expectedScheme} local theme markers can override root theme: shell=${forcedLocalThemeMarkers.appShell}, workbench=${forcedLocalThemeMarkers.workbench}, editor=${forcedLocalThemeMarkers.editorRegion}`,
    );
  }

  const expectedLight = expectedScheme === "light";
  for (const [name, value] of Object.entries({
    appShell: colors.appShell,
    sidebar: colors.sidebar,
    topbar: colors.topbar,
    workbench: colors.workbench,
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

async function assertInputValue(locator, expected, label) {
  const value = await locator.inputValue();
  if (value !== expected) {
    throw new Error(`${label} should have value "${expected}", got "${value}"`);
  }
}

async function assertThemeTransition(page, fromScheme) {
  const nextScheme = fromScheme === "light" ? "dark" : "light";

  await page.emulateMedia({ colorScheme: nextScheme });
  await page
    .locator(`.app-shell[data-ide-theme="${nextScheme}"]`)
    .waitFor({ state: "attached" });
  await assertTheme(page, nextScheme);

  await page.emulateMedia({ colorScheme: fromScheme });
  await page
    .locator(`.app-shell[data-ide-theme="${fromScheme}"]`)
    .waitFor({ state: "attached" });
  await assertTheme(page, fromScheme);
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

  await page.getByRole("treeitem", { name: "src" }).press("ArrowRight");
  await page.getByText("App.tsx").waitFor();
  await page.getByRole("treeitem", { name: "src" }).press("ArrowLeft");
  await page.getByText("App.tsx").waitFor({ state: "hidden" });

  await assertTheme(page, colorScheme);
  await assertThemeTransition(page, colorScheme);

  const commandModifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${commandModifier}+P`);
  await page.getByRole("dialog", { name: "Quick open" }).waitFor();
  await page.locator('input[placeholder="Open file"]').fill("nested");
  await page.getByText("deep/Nested.ts").waitFor();
  await page.keyboard.press("Enter");
  await page.locator(".cm-content").waitFor();
  await page.getByText("indexed smoke file").waitFor();

  await page.keyboard.press(`${commandModifier}+Shift+P`);
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.locator('input[placeholder="Run command"]').fill("workspace");
  await page.keyboard.press("Enter");
  await page.locator('input[placeholder="Search contents"]').waitFor();

  await page.keyboard.press(`${commandModifier}+Shift+P`);
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  await page.locator('input[placeholder="Run command"]').fill("settings");
  await page.keyboard.press("Enter");
  const settingsDialog = page.getByRole("dialog", { name: "Settings" });
  await settingsDialog.waitFor();
  await page.getByRole("tab", { name: /Storage/ }).click();
  const indexCoverage = page.getByLabel("Workspace index coverage");
  await indexCoverage.waitFor();
  await indexCoverage.getByText("Indexed files").waitFor();
  await indexCoverage.getByText("4").waitFor();
  await indexCoverage.getByText("Pending folders").waitFor();
  await indexCoverage.getByText("1").waitFor();
  await settingsDialog.getByRole("button", { name: "Close" }).click();
  await settingsDialog.waitFor({ state: "hidden" });

  await page.getByLabel("Filter files").click();
  const filterInput = page.locator('input[placeholder="Filter files"]');
  await filterInput.fill("README");
  await page.getByText("README.md").waitFor();
  if (await page.getByText("package.json").isVisible()) {
    throw new Error("file filter did not hide unrelated files");
  }

  await page.keyboard.press("Escape");
  await assertInputValue(filterInput, "", "file filter after first Escape");
  await page.getByText("package.json").waitFor();
  await page.keyboard.press("Escape");
  await filterInput.waitFor({ state: "hidden" });

  await page.getByLabel("Search contents").click();
  const contentSearchInput = page.locator('input[placeholder="Search contents"]');
  await contentSearchInput.fill("smoke");
  await page.getByText("docs/README.md:3").waitFor();
  await page.keyboard.press("Escape");
  await assertInputValue(contentSearchInput, "", "content search after first Escape");
  await page.getByText("docs/README.md:3").waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");
  await contentSearchInput.waitFor({ state: "hidden" });

  await page.getByLabel("Search contents").click();
  await contentSearchInput.fill("smoke");
  await page.getByText("docs/README.md:3").waitFor();

  await page.getByText("README.md").dblclick();
  await page.locator(".cm-content").waitFor();
  await page.getByText("Smoke workspace").waitFor();
  await assertTheme(page, colorScheme);

  await page.locator('button[title="Collapse sidebar"]').click();
  await page.locator(".app-shell--sidebar-collapsed").waitFor();
  await page.locator('button[title="Expand sidebar"]').waitFor();
  await page.getByText("Smoke workspace").waitFor();

  const collapsedEditorVisible = await page.locator(".cm-content").isVisible();
  if (!collapsedEditorVisible) {
    throw new Error("collapsing the sidebar hid the active editor");
  }

  await page.locator('button[title="Expand sidebar"]').click();
  await page.locator('button[title="Collapse sidebar"]').waitFor();
  await page.waitForFunction(() => {
    return !document
      .querySelector(".app-shell")
      ?.classList.contains("app-shell--sidebar-collapsed");
  });

  await page.keyboard.press("Control+G");
  await page.getByRole("dialog", { name: "Go to line" }).waitFor();
  await page.getByLabel("Line number").fill("2");
  await page.keyboard.press("Enter");
  await page.getByText("Moved to docs/README.md:2").waitFor();

  await page.getByLabel("Find in file").click();
  const currentFindInput = page.locator('input[placeholder="Find in file"]');
  await currentFindInput.fill("smoke");
  await page.keyboard.press("Enter");
  await page.getByText("Match 1 of 2 at docs/README.md:1").waitFor();
  await page.keyboard.press("Enter");
  await page.getByText("Match 2 of 2 at docs/README.md:3").waitFor();
  await page.keyboard.press("Escape");
  await assertInputValue(currentFindInput, "", "current-file search after first Escape");
  await page.keyboard.press("Escape");
  await currentFindInput.waitFor({ state: "hidden" });

  await page.getByRole("treeitem", { name: "image.png" }).click();
  await page.getByText("Non-text file selected").waitFor();
  await page.getByText("image.png selected").waitFor();
  await page.getByText("image.png is selected but is not editable as text.").waitFor();
  await page.getByText("Smoke workspace").waitFor({ state: "hidden" });

  const imageSelected = await page
    .getByRole("treeitem", { name: "image.png" })
    .getAttribute("aria-selected");
  if (imageSelected !== "true") {
    throw new Error(`non-text tree item should stay selected, got ${imageSelected ?? "unset"}`);
  }

  const editorCountAfterNonTextSelection = await page.locator(".cm-content").count();
  if (editorCountAfterNonTextSelection !== 0) {
    throw new Error(
      `non-text selection left ${editorCountAfterNonTextSelection} editor instance(s) mounted`,
    );
  }

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

async function runSystemThemeScenario(browser, url) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
  });
  await context.route("**/api/**", fulfillApi);

  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.getByText("Workspace", { exact: true }).waitFor();
  await page.getByText("No file selected").waitFor();

  const expectedScheme = await page.evaluate(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  await assertTheme(page, expectedScheme);
  await context.close();
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
    await runSystemThemeScenario(browser, url);
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
