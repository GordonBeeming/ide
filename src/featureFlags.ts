// Typed feature-flag registry. The registry owns the metadata and defaults; the
// only thing persisted to disk is the set of intentional user overrides, so a
// flag can be removed from the registry without leaving a typed field behind.
//
// Lifecycle (see docs/development.md): a larger feature ships as a "preview"
// flag users opt into, then either graduates to a normal setting in its natural
// category or becomes always-on and the flag is deleted. Removing a flag here
// and from KNOWN_FEATURE_FLAGS in src-tauri/src/lib.rs prunes any stale override
// the next time settings load.

export type FeatureFlagId = "contextMenus";

// "preview" flags surface in Settings → Preview Features for opt-in/opt-out.
// "internal" flags are gated in code only and never rendered as a user toggle.
export type FeatureFlagVisibility = "preview" | "internal";

export type FeatureFlagLifecycle = "preview" | "stabilizing" | "graduating";

export interface FeatureFlagDefinition {
  id: FeatureFlagId;
  label: string;
  description: string;
  defaultEnabled: boolean;
  visibility: FeatureFlagVisibility;
  lifecycle: FeatureFlagLifecycle;
  // What makes this flag removable or promotable to a normal setting.
  graduationCriteria: string;
  // Optional note on where the flag should land if promoted to a real setting.
  promotionNote?: string;
}

export const FEATURE_FLAGS: Record<FeatureFlagId, FeatureFlagDefinition> = {
  contextMenus: {
    id: "contextMenus",
    label: "Context menus",
    description:
      "Right-click menus tailored to each surface (file tree, tabs, editor, search, commit panel) instead of the browser's default menu.",
    defaultEnabled: true,
    visibility: "preview",
    lifecycle: "preview",
    graduationCriteria:
      "Menus cover every surface without missing actions or keyboard-nav bugs. Once stable, remove this flag and make the behavior always-on.",
  },
};

function isFeatureFlagId(value: string): value is FeatureFlagId {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, value);
}

// A map of known flag id → user choice. Only ids in the registry survive
// sanitization, but the type stays a plain string map so it flows cleanly into
// the persisted settings payload without per-id optional typing.
export type FeatureFlagOverrides = Record<string, boolean>;

// Drop unknown ids and non-boolean values from raw persisted state. Mirrors the
// backend prune so the frontend stays correct even if it reads an override map
// directly. Tolerates any shape because persisted JSON can be hand-edited.
export function sanitizeFeatureFlagOverrides(raw: unknown): FeatureFlagOverrides {
  if (raw === null || typeof raw !== "object") return {};
  const overrides: FeatureFlagOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean" && isFeatureFlagId(key)) {
      overrides[key] = value;
    }
  }
  return overrides;
}

// Effective state for every known flag: registry default unless the user set an
// override. This is the single source feature code should consult.
export function resolveFeatureFlags(
  overrides: FeatureFlagOverrides,
): Record<FeatureFlagId, boolean> {
  const sanitized = sanitizeFeatureFlagOverrides(overrides);
  const resolved = {} as Record<FeatureFlagId, boolean>;
  for (const flag of Object.values(FEATURE_FLAGS)) {
    resolved[flag.id] = sanitized[flag.id] ?? flag.defaultEnabled;
  }
  return resolved;
}

export function isFeatureEnabled(
  id: FeatureFlagId,
  overrides: FeatureFlagOverrides,
): boolean {
  // Direct O(1) lookup with no allocation — this runs in render hot paths, so
  // avoid resolving the whole registry per check. A non-boolean (hand-edited)
  // override falls back to the registry default, same as sanitization would.
  const override = overrides[id];
  return typeof override === "boolean" ? override : FEATURE_FLAGS[id].defaultEnabled;
}

// Flags that belong in the Settings "Preview Features" surface. Internal flags
// are deliberately excluded so they never become user-visible toggles.
export function previewFeatureFlags(): FeatureFlagDefinition[] {
  return Object.values(FEATURE_FLAGS).filter(
    (flag) => flag.visibility === "preview",
  );
}
