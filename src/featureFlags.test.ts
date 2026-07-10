import { describe, expect, it } from "vitest";
import {
  FEATURE_FLAGS,
  isFeatureEnabled,
  previewFeatureFlags,
  resolveFeatureFlags,
  sanitizeFeatureFlagOverrides,
} from "./featureFlags";

describe("feature flags", () => {
  it("falls back to the registry default when there is no override", () => {
    expect(resolveFeatureFlags({})).toEqual({
      contextMenus: true,
    });
    expect(isFeatureEnabled("contextMenus", {})).toBe(true);
  });

  it("lets a user override win over the default", () => {
    expect(isFeatureEnabled("contextMenus", { contextMenus: false })).toBe(false);
  });

  it("ignores unknown flag ids", () => {
    const overrides = sanitizeFeatureFlagOverrides({
      contextMenus: false,
      retiredFlag: true,
      somethingElse: false,
    });

    expect(overrides).toEqual({ contextMenus: false });
  });

  it("ignores malformed (non-boolean) override values", () => {
    const overrides = sanitizeFeatureFlagOverrides({
      contextMenus: "yes",
    });

    expect(overrides).toEqual({});
    // A malformed value is dropped, so the flag resolves to its default.
    expect(isFeatureEnabled("contextMenus", overrides)).toBe(true);
  });

  it("tolerates non-object persisted state", () => {
    expect(sanitizeFeatureFlagOverrides(null)).toEqual({});
    expect(sanitizeFeatureFlagOverrides("nope")).toEqual({});
    expect(sanitizeFeatureFlagOverrides(42)).toEqual({});
  });

  it("only surfaces preview flags in the Settings list", () => {
    const preview = previewFeatureFlags();

    expect(preview.every((flag) => flag.visibility === "preview")).toBe(true);
    expect(preview.map((flag) => flag.id)).toContain("contextMenus");
  });

  it("keeps the registry self-consistent (id matches key)", () => {
    for (const [key, flag] of Object.entries(FEATURE_FLAGS)) {
      expect(flag.id).toBe(key);
    }
  });
});
