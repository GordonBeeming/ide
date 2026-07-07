import type { GitFileStatus } from "./tauri";

export interface EditorTabDiff {
  filePath: string;
  original: string;
  modified: string;
  status: GitFileStatus;
  isBinary: boolean;
  isTooLarge: boolean;
}

export interface EditorTab {
  // Diff tabs use the synthetic key `diff://<filePath>` so every other
  // path-keyed helper in this module keeps working unmodified — a file can be
  // open for editing and as a diff at the same time without colliding.
  path: string;
  contents: string;
  dirty: boolean;
  modifiedMs?: number;
  pinned: boolean;
  diff?: EditorTabDiff;
}

export function addPreviewTab(
  tabs: EditorTab[],
  tab: EditorTab,
): EditorTab[] {
  const existing = tabs.find((item) => item.path === tab.path);
  if (existing) return tabs;

  const retained = tabs.filter((item) => item.pinned || item.dirty);
  return [...retained, tab];
}

export function pinTab(tabs: EditorTab[], path: string): EditorTab[] {
  return tabs.map((tab) => (tab.path === path ? { ...tab, pinned: true } : tab));
}

export function updateTabContents(
  tabs: EditorTab[],
  path: string,
  contents: string,
): EditorTab[] {
  return tabs.map((tab) =>
    tab.path === path ? { ...tab, contents, dirty: true, pinned: true } : tab,
  );
}

export function nextActivePathAfterClose(
  tabs: EditorTab[],
  activePath: string | undefined,
  closedPath: string,
): string | undefined {
  if (activePath !== closedPath) return activePath;
  return tabs.filter((tab) => tab.path !== closedPath).at(-1)?.path;
}

export function tabCloseRequiresConfirmation(
  tabs: EditorTab[],
  path: string,
): boolean {
  return Boolean(tabs.find((tab) => tab.path === path)?.dirty);
}

export function dirtyTabSummary(tabs: EditorTab[]) {
  const count = tabs.filter((tab) => tab.dirty).length;
  return count === 1 ? "1 unsaved file" : `${count} unsaved files`;
}

export function adjacentTabPath(
  tabs: EditorTab[],
  activePath: string | undefined,
  direction: 1 | -1,
): string | undefined {
  if (tabs.length === 0) return undefined;
  const activeIndex = tabs.findIndex((tab) => tab.path === activePath);
  const currentIndex = activeIndex >= 0 ? activeIndex : 0;
  return tabs[(currentIndex + direction + tabs.length) % tabs.length]?.path;
}

export function numberedTabPath(
  tabs: EditorTab[],
  key: string,
): string | undefined {
  if (!/^[1-9]$/.test(key)) return undefined;
  const number = Number.parseInt(key, 10);
  const index = number === 9 ? tabs.length - 1 : number - 1;
  return tabs[index]?.path;
}
