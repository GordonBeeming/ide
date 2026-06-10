---
name: feature-flags
description: >
  Add, gate on, remove, or promote a local feature flag in the ide app. Use when
  the user says "$feature-flags", "add a feature flag", "put this behind a flag",
  "remove a flag", "make this always on", "promote a flag to a setting", or
  "preview feature". The concepts live in docs/development.md; this skill is the
  step-by-step procedure for each lifecycle operation, including the exact files
  to touch and the order to touch them.
---

# Feature Flags

Operate the local feature-flag system: introduce a capability behind a flag,
gate code on it, and later either remove the flag (feature becomes always-on) or
promote it into a normal user setting. Background and the lifecycle narrative are
in [docs/development.md](../../../docs/development.md#feature-flags).

## Mental Model

Two halves and one rule.

- **Registry** — `src/featureFlags.ts` owns flag metadata and defaults:
  `FEATURE_FLAGS` (the catalog), the `FeatureFlagId` union, and the
  `FeatureFlagDefinition` shape (id, label, description, `defaultEnabled`,
  `visibility`, `lifecycle`, `graduationCriteria`).
- **Persisted state** — the `featureFlags` map on `PersistedViewSettings` in
  `src-tauri/src/lib.rs` stores **overrides only**. A flag's effective value is
  its registry default unless the user set something different, and only that
  difference is written to `ui-state.json`.
- **The sync rule** — every id in the TS registry must also appear in
  `KNOWN_FEATURE_FLAGS` in `src-tauri/src/lib.rs`. On load,
  `sanitize_view_settings` drops any persisted override whose id is not in that
  list, so an id missing from `KNOWN_FEATURE_FLAGS` silently loses its saved
  value. Add to both lists, remove from both lists.

Read effective state with `isFeatureEnabled(id, overrides)`. Every call site
asks the same question and gets the same answer, so never read the raw map
directly in feature code.

## Add A Flag

1. In `src/featureFlags.ts`, add the new id to the `FeatureFlagId` union and an
   entry to `FEATURE_FLAGS`:

   ```ts
   myFeature: {
     id: "myFeature",
     label: "My feature",
     description: "What the user gets when this is on. In progress, off by default.",
     defaultEnabled: false,
     visibility: "preview",
     lifecycle: "preview",
     graduationCriteria: "What makes this removable or promotable to a setting.",
   },
   ```

2. In `src-tauri/src/lib.rs`, add the same id to `KNOWN_FEATURE_FLAGS`.

3. Gate the feature with `isFeatureEnabled` (see below). A disabled flag must
   render no UI, start no background work, and write no stored data.

4. Visibility is automatic: a `preview` flag shows up in Settings → Preview
   Features with no extra UI code, and an `internal` flag never renders as a
   toggle. The Preview Features tab iterates `previewFeatureFlags()` in
   `src/App.tsx`, so a new preview flag appears on its own.

5. Cover it in `src/featureFlags.test.ts` — at minimum the default value and that
   an override wins. If the flag changes Rust-visible behavior, extend the
   sanitize tests in `src-tauri/src/lib.rs`.

## Gate Code On A Flag

`isFeatureEnabled` takes the current overrides and returns the effective value.
In `App.tsx` the overrides live in the `featureFlags` state; pass them through:

```ts
if (isFeatureEnabled("myFeature", featureFlags)) {
  // render the UI, start the work, read/write the data
}
```

When the flag is off, this branch must not run at all. That is what keeps an
unfinished feature from leaking UI, background work, or stored data to users who
have not opted in.

## Remove A Flag (Feature Becomes Always-On)

When the feature is stable and everyone should have it:

1. Remove the gate so the code path runs unconditionally, then delete any tests
   that only existed to prove the flag toggled behavior.
2. Delete the entry from `FEATURE_FLAGS` and its member from the `FeatureFlagId`
   union in `src/featureFlags.ts`.
3. Delete the id from `KNOWN_FEATURE_FLAGS` in `src-tauri/src/lib.rs`.

No migration is needed. Any saved override for the removed id is now unknown, so
`sanitize_view_settings` prunes it from `ui-state.json` on the next load.

## Promote A Flag To A Setting

When the feature should stay user-controlled, move it out of Preview Features and
into a permanent setting in whatever category fits it.

1. Add a real setting field across the existing settings stack, following an
   existing flat setting like `showDotfiles` as the worked example:
   - `PersistedViewSettings` in both `src/tauri.ts` and `src-tauri/src/lib.rs`.
   - The default in `defaultUiSnapshot` (`src/tauri.ts`) and the `Default` impl
     plus any clamp in `sanitize_view_settings` (`src-tauri/src/lib.rs`).
   - `useState`, `applyPersistedUiSnapshot`, and the debounced persist effect in
     `src/App.tsx`.
   - A control in the right Settings category in `src/App.tsx`.
2. Migrate the saved choice **before** removing the flag, so a user who opted in
   keeps it: when loading state, if the old `featureFlags[id]` override is set,
   seed the new setting from it.
3. Once the new setting reads and persists, remove the flag using the steps in
   *Remove A Flag*.

## Visibility

- `preview` — user-facing. Shows in Settings → Preview Features so people can opt
  in and out. Use this for anything users might reasonably want to try early.
- `internal` — gated in code only, never rendered. Use this for rollout switches
  that should not be a user-facing toggle.

## Verify

- Run `./run-tests.sh`, or the targeted subset while iterating:
  `npm test` then `cd src-tauri && cargo test`.
- Manual: toggle the flag in Settings → Preview Features, restart the app, and
  confirm it stuck. Then hand-add a bogus id to `ui-state.json`, restart, and
  confirm it is pruned.

## Keep In Sync And Avoid Flag Debt

- The registry (`src/featureFlags.ts`) and `KNOWN_FEATURE_FLAGS`
  (`src-tauri/src/lib.rs`) must list the same ids. Drift means a flag's persisted
  override gets pruned out from under it.
- Do not let preview flags linger. Each one carries `graduationCriteria` for a
  reason: once it is met, decide whether to remove the flag or promote it to a
  setting, and do it. A pile of stale preview toggles makes Settings feel
  unfinished.
