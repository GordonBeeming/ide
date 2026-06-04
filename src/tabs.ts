export interface EditorTab {
  path: string;
  contents: string;
  dirty: boolean;
  pinned: boolean;
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
