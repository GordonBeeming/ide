export const darkSchemeQuery = "(prefers-color-scheme: dark)";

export function systemPrefersDark(): boolean {
  return Boolean(window.matchMedia?.(darkSchemeQuery).matches);
}
