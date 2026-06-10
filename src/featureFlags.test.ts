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
    expect(resolveFeatureFlags({})).toEqual({ gitAttribution: false });
    expect(isFeatureEnabled("gitAttribution", {})).toBe(false);
  });

  it("lets a user override win over the default", () => {
    expect(isFeatureEnabled("gitAttribution", { gitAttribution: true })).toBe(true);
  });

  it("ignores unknown flag ids", () => {
    const overrides = sanitizeFeatureFlagOverrides({
      gitAttribution: true,
      retiredFlag: true,
      somethingElse: false,
    });

    expect(overrides).toEqual({ gitAttribution: true });
  });

  it("ignores malformed (non-boolean) override values", () => {
    const overrides = sanitizeFeatureFlagOverrides({
      gitAttribution: "yes",
    });

    expect(overrides).toEqual({});
    // A malformed value is dropped, so the flag resolves to its default.
    expect(isFeatureEnabled("gitAttribution", overrides)).toBe(false);
  });

  it("tolerates non-object persisted state", () => {
    expect(sanitizeFeatureFlagOverrides(null)).toEqual({});
    expect(sanitizeFeatureFlagOverrides("nope")).toEqual({});
    expect(sanitizeFeatureFlagOverrides(42)).toEqual({});
  });

  it("only surfaces preview flags in the Settings list", () => {
    const preview = previewFeatureFlags();

    expect(preview.every((flag) => flag.visibility === "preview")).toBe(true);
    expect(preview.map((flag) => flag.id)).toContain("gitAttribution");
  });

  it("keeps the registry self-consistent (id matches key)", () => {
    for (const [key, flag] of Object.entries(FEATURE_FLAGS)) {
      expect(flag.id).toBe(key);
    }
  });
});
