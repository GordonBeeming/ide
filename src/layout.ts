export function appShellClass(sidebarCollapsed: boolean): string {
  return sidebarCollapsed ? "app-shell app-shell--sidebar-collapsed" : "app-shell";
}

export function sidebarToggleTitle(sidebarCollapsed: boolean): string {
  return sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
}
