import { describe, expect, it, vi } from "vitest";
import { unlistenNativeCallbacks, type NativeUnlisten } from "./nativeEvents";

describe("native event cleanup", () => {
  it("reports synchronous unlisten failures", () => {
    const report = vi.fn();

    unlistenNativeCallbacks(
      [
        () => {
          throw new Error("listener missing");
        },
      ],
      report,
    );

    expect(report).toHaveBeenCalledWith(
      "Unable to unregister native event listener: Error: listener missing",
    );
  });

  it("reports async unlisten failures without leaving an unhandled rejection", async () => {
    const report = vi.fn();
    const unlisten: NativeUnlisten = () => Promise.reject(new Error("listener stale"));

    unlistenNativeCallbacks([unlisten], report);
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        "Unable to unregister native event listener: Error: listener stale",
      ),
    );
  });

  it("treats Tauri's already-removed listener error as idempotent cleanup", async () => {
    const report = vi.fn();
    const unlisten: NativeUnlisten = () =>
      Promise.reject(
        new TypeError(
          "undefined is not an object (evaluating 'listeners[eventId].handlerId')",
        ),
      );

    unlistenNativeCallbacks([unlisten], report);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(report).not.toHaveBeenCalled();
  });
});
