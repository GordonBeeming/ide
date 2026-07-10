export const darkSchemeQuery = "(prefers-color-scheme: dark)";

// The index.html pre-paint bootstrap reads this same key from localStorage to
// honor an explicit light/dark choice before the app module loads. Keep the
// literal in sync with the string the bootstrap script reads.
export const themePreferenceStorageKey = "ide-theme-preference";

export function systemPrefersDark(): boolean {
  return window.matchMedia?.(darkSchemeQuery)?.matches ?? false;
}
