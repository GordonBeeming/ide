import { getCurrentWindow, type CloseRequestedEvent } from "@tauri-apps/api/window";

export type CloseRequestHandler = (event: CloseRequestedEvent) => void | Promise<void>;

export function isNativeTauriRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function onNativeWindowCloseRequested(handler: CloseRequestHandler) {
  if (!isNativeTauriRuntime()) return undefined;
  return getCurrentWindow().onCloseRequested(handler);
}

export async function destroyNativeWindow() {
  if (!isNativeTauriRuntime()) return false;
  await getCurrentWindow().destroy();
  return true;
}

export async function setNativeWindowTitle(title: string) {
  if (!isNativeTauriRuntime()) return false;
  await getCurrentWindow().setTitle(title);
  return true;
}
