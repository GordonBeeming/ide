export function appShellClass(sidebarCollapsed: boolean): string {
  const classes = ["app-shell"];
  if (sidebarCollapsed) classes.push("app-shell--sidebar-collapsed");
  return classes.join(" ");
}

export function editorRegionClass(): string {
  return "editor-region";
}

export function applyDocumentTheme(prefersDark: boolean, doc: Document = document): void {
  doc.documentElement.dataset.ideTheme = prefersDark ? "dark" : "light";
  doc.documentElement.style.colorScheme = prefersDark ? "dark" : "light";
}

export function sidebarToggleTitle(sidebarCollapsed: boolean): string {
  return sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
}
