export type NativeUnlisten = () => void | Promise<void>;

export function unlistenNativeCallbacks(
  callbacks: NativeUnlisten[],
  onError: (message: string) => void,
): void {
  callbacks.forEach((unlisten) => {
    try {
      const result = unlisten();
      if (isPromiseLike(result)) {
        void result.catch((reason: unknown) => {
          if (isAlreadyRemovedTauriListener(reason)) return;
          onError(formatUnlistenError(reason));
        });
      }
    } catch (reason) {
      if (isAlreadyRemovedTauriListener(reason)) return;
      onError(formatUnlistenError(reason));
    }
  });
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return Boolean(
    value &&
      typeof value === "object" &&
      "catch" in value &&
      typeof (value as { catch?: unknown }).catch === "function",
  );
}

function formatUnlistenError(reason: unknown): string {
  return `Unable to unregister native event listener: ${String(reason)}`;
}

function isAlreadyRemovedTauriListener(reason: unknown): boolean {
  return String(reason).includes("listeners[eventId].handlerId");
}
