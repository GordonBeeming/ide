export function appShellClass(sidebarCollapsed: boolean, prefersDark = false): string {
  const classes = ["app-shell", prefersDark ? "app-shell--dark" : "app-shell--light"];
  if (sidebarCollapsed) classes.push("app-shell--sidebar-collapsed");
  return classes.join(" ");
}

export function editorRegionClass(prefersDark = false): string {
  return `editor-region editor-region--${prefersDark ? "dark" : "light"}`;
}

export function applyDocumentTheme(prefersDark: boolean, doc: Document = document): void {
  doc.documentElement.dataset.ideTheme = prefersDark ? "dark" : "light";
}

export function sidebarToggleTitle(sidebarCollapsed: boolean): string {
  return sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
}
