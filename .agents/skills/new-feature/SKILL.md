---
name: new-feature
description: >
  Analyze a new product or application feature idea, create a reviewable
  feature analysis artifact, then turn the approved artifact into GitHub
  backlog issues/PBIs. Use when Gordon invokes "$new-feature", says "new
  feature", gives a rough feature idea, asks to break down a feature request,
  or wants feature PBIs/issues created. Do not use for bugfix-only work,
  release creation, dependency-only maintenance, or direct implementation after
  an existing issue is already selected.
---

# New Feature

## Goal

Turn a rough product idea into a reviewable feature analysis artifact, then
transpose the approved artifact into one or more feature-level backlog issues
that a team can estimate, prioritize, implement, validate, and later use as the
paper trail for product changes.

The skill is complete when:

- The ask is split only where it represents distinct deliverable end-user value.
- Each feature has a codebase-informed size, complexity, dependency, risk, and
  validation analysis.
- A reviewable artifact is created for Gordon to review before GitHub issue
  creation, following the active artifact instructions for format, location,
  branding, links, and verification.
- GitHub issues/PBIs are created only after Gordon approves the artifact, or the
  blocker to issue creation is clearly named.
- The final response links the artifact and, after approval, the created issues.

## Inputs

Collect or infer:

- The raw feature idea and desired outcome.
- Target repository and backlog/project. Prefer the current repo when not
  supplied.
- Product constraints, target users, release timing, and non-goals when provided.
- Existing issues, PRs, docs, designs, or code references that affect scope.

Ask a concise question only when the missing answer materially changes issue
creation, such as the target repo/backlog being ambiguous or the idea being too
unclear to identify user value. Otherwise make reasonable assumptions and state
them in the issue.

## Artifact-First Workflow

Create a review artifact before creating any GitHub issues.

Before choosing the artifact format or path, inspect and apply any artifact
instructions already active for the current run, including repo `AGENTS.md`
files and imported agent rule files that mention artifacts, HTML output,
branding, clickable code links, or render verification. Do not describe this as
using a global skill; just follow the applicable artifact instructions.

When no artifact instruction is found, use these portable defaults:

```text
- Format: self-contained HTML
- Location: artifacts/new-feature/YYYY-MM-DD-short-feature-slug.html
- Styling: clean, readable, self-contained CSS with no external asset
  dependency unless the repo already provides one
- Links: absolute local file references in the HTML source, shortened only at
  render time when possible
- Verification: open/render the HTML artifact and inspect it for layout,
  clipping, overlap, and path-link behavior before handing it back
```

If the repo already has an artifact directory or convention, follow the existing
convention only when no active artifact instruction says otherwise.

The artifact must help Gordon understand the proposed breakdown and decision
points before committing anything to the backlog. It should include:

- Original raw ask.
- Assumptions and open questions.
- Recommended feature decomposition, including what was deliberately kept as
  checklist tasks rather than split into separate features.
- A comparison table across all proposed features with effort, likely files,
  rough LOC, complexity, foreignness, dependencies, risk, and confidence.
- A detailed section for each proposed feature using the analysis fields below.
- A "GitHub transposition plan" that maps each proposed feature to one future
  issue title and body source.
- A change log section for review iterations.

For both the artifact and the eventual GitHub PBI/issue body, implementation
tasks must describe what work is needed, not how the code should be changed.
Use product, capability, workflow, validation, and rollout language. Do not
write tasks like "add field X to file Y" or "create component Z in path W".
Concrete files, paths, and code symbols belong only in likely touch-point or
evidence sections, and must be labelled as planning-time hints that may drift
before implementation starts.

Every feature in the artifact and every transposed GitHub PBI/issue must include
these planning fields:

```text
Effort: XS, S, M, L, or XL
Complexity: 1/5, 2/5, 3/5, 4/5, or 5/5
Foreignness: 1/5, 2/5, 3/5, 4/5, or 5/5
Confidence: Low, Medium, or High
```

After creating or updating the artifact, stop and report the artifact path. Ask
Gordon to review it and either request changes or approve transposition to
GitHub. Do not create GitHub issues during the same pass unless Gordon has
already explicitly approved GitHub creation after seeing the artifact.

## Feature Decomposition

A feature is a deliverable unit of end-user value. Split the ask when separate
parts:

- Serve different user journeys or personas.
- Can ship independently and still be useful.
- Have different acceptance criteria, validation paths, or risk profiles.
- Touch largely unrelated product areas.

Prefer one issue with checklist tasks when work is only separated by
implementation layer, such as UI, API, storage, tests, telemetry, docs,
permissions, or infrastructure that supports the same user-visible outcome.

Do not create infrastructure-only feature issues unless the infrastructure is
itself a visible product capability. Capture supporting infrastructure as tasks
inside the relevant feature issue.

## Evidence Rules

- Start with `rg`, `rg --files`, manifests, docs, route definitions, API
  contracts, tests, and nearby feature code.
- Use the smallest codebase read that can support a useful estimate. A normal
  first pass should stay under about 15 search/file-read commands before
  drafting the decomposition.
- Search again only when a required file area, existing pattern, dependency,
  schema, permission, or validation path is missing.
- For external packages or platform APIs, use current primary sources before
  making version, license, pricing, or capability claims.
- Cite exact local files, issue URLs, docs, or command outputs in the issue body
  when they materially support the estimate.

## Analysis To Produce

For each feature, include:

- **Title**: Short, user-facing, and outcome-oriented.
- **Summary**: What the user can do when this ships.
- **User value**: Why this matters to the end user or operator.
- **Scope**: In scope, out of scope, and assumptions.
- **Acceptance criteria**: Concrete behavior that proves the feature is done.
- **Implementation tasks**: Checklist items for what work is needed across
  product behavior, user experience, data, permissions, telemetry, docs, tests,
  and rollout. Keep these stable if the code moves before implementation.
  Avoid file names, code symbols, and exact implementation steps.
- **Codebase impact estimate**:
  - Existing files likely touched.
  - New files likely added.
  - Rough line-count range. Use broad ranges such as `100-250`, `250-600`,
    `600-1,500`, `1,500-4,000`, or `4,000+` lines.
  - Overall effort: exactly one of `XS`, `S`, `M`, `L`, or `XL`.
- **Complexity and foreignness**:
  - Complexity score from `1` to `5`, where `1` is straightforward and `5` is
    uncertain, cross-cutting, or high-risk.
  - Foreignness score from `1` to `5`, where `1` matches existing patterns and
    `5` introduces unfamiliar architecture, domain, tooling, or product
    behavior.
  - Confidence: exactly one of `Low`, `Medium`, or `High`.
- **Dependencies**:
  - New runtime, build, service, API, infrastructure, data, auth, or vendor
    dependencies.
  - Existing internal systems the work depends on.
  - Whether each dependency is optional, required, or avoidable.
- **Risks and decision points**:
  - Data migration, permissions, security/privacy, accessibility, performance,
    backwards compatibility, UX ambiguity, offline behavior, support burden,
    rollout, and maintenance risks where relevant.
- **Validation plan**:
  - Targeted tests, type checks, builds, smoke tests, visual checks, and manual
    acceptance checks.
- **Likely touch points**:
  - Optional planning-time hints for files, folders, APIs, schemas, tests, or
    existing patterns that informed the estimate.
  - Make clear these are not implementation instructions and may change before
    the PBI is worked.
## GitHub Issue Creation

Only run this phase after Gordon has reviewed the artifact and approved
transposition to GitHub. If he requests changes, patch the artifact first and
return for another review pass.

## GitHub Planning Labels

Each created PBI/issue must have exactly one label from each planning group:

| Label | Color | Meaning |
| --- | --- | --- |
| `effort:XS` | `#cfe8ff` | Extra small effort |
| `effort:S` | `#9bd5ff` | Small effort |
| `effort:M` | `#58a6ff` | Medium effort |
| `effort:L` | `#1f6feb` | Large effort |
| `effort:XL` | `#0b3d91` | Extra large effort |
| `complexity:1` | `#f3e8ff` | Complexity 1 of 5 |
| `complexity:2` | `#e9d5ff` | Complexity 2 of 5 |
| `complexity:3` | `#d8b4fe` | Complexity 3 of 5 |
| `complexity:4` | `#a855f7` | Complexity 4 of 5 |
| `complexity:5` | `#6b21a8` | Complexity 5 of 5 |
| `foreignness:1` | `#ffedd5` | Foreignness 1 of 5 |
| `foreignness:2` | `#fed7aa` | Foreignness 2 of 5 |
| `foreignness:3` | `#fdba74` | Foreignness 3 of 5 |
| `foreignness:4` | `#fb923c` | Foreignness 4 of 5 |
| `foreignness:5` | `#c2410c` | Foreignness 5 of 5 |
| `confidence:Low` | `#dcfce7` | Low confidence |
| `confidence:Medium` | `#86efac` | Medium confidence |
| `confidence:High` | `#16a34a` | High confidence |

These labels mirror the artifact/PBI planning fields. If a required label is
missing, create it before creating or updating the issue. If the issue already
has another label from the same planning group, replace it so only one value per
group remains. Keep each group on a single hue ramp, with lighter shades for
lower/easier values and darker shades for higher/harder values.

1. Determine the repo:
   ```bash
   gh repo view --json nameWithOwner --jq .nameWithOwner
   ```

2. Inspect existing issue labels and conventions before creating issues:
   ```bash
   gh label list --repo OWNER/REPO --limit 100
   ```
   Use existing labels such as `feature`, `enhancement`, `pbi`, or `backlog`
   when present. The planning labels above are required for this skill.

3. If the target GitHub Project/backlog is known, add the created issue to it.
   If it is not discoverable from repo docs or user context, create the issue in
   the repo and report that project placement still needs the project owner or
   number.

4. Create one GitHub issue per approved feature from the artifact. Use checklist
   tasks inside the issue for supporting work instead of sub-issues unless
   Gordon explicitly asks for sub-issues or the repo has a clear convention
   requiring them.
   Ensure the issue keeps implementation tasks at the "what is needed" level.
   Put concrete file/path/code-symbol references only in `Likely Touch Points`
   or evidence sections, never in the task checklist.

5. Use a temporary body file and `gh issue create`:
   ```bash
   gh issue create --repo OWNER/REPO --title "TITLE" --body-file /tmp/new-feature-TITLE.md
   ```
   Apply the selected planning labels during creation, for example:
   ```bash
   gh issue create --repo OWNER/REPO --title "TITLE" --body-file /tmp/new-feature-TITLE.md \
     --label "enhancement" \
     --label "effort:M" \
     --label "complexity:3" \
     --label "foreignness:2" \
     --label "confidence:High"
   ```

6. Validate every created issue:
   ```bash
   gh issue view ISSUE_NUMBER --repo OWNER/REPO --json title,body,url,labels
   ```
   Confirm the body includes the summary, acceptance criteria, tasks, estimates,
   dependencies, risks, and validation plan. Confirm the issue has exactly one
   label from each planning group.

## Issue Body Shape

Use this shape for each issue:

```md
## Summary

...

## User Value

...

## Scope

### In Scope

- ...

### Out of Scope

- ...

### Assumptions

- ...

## Acceptance Criteria

- [ ] ...

## Implementation Tasks

- [ ] Describe needed product/capability/workflow/test/rollout work without
      naming exact files, paths, or code symbols.

## Codebase Impact Estimate

| Area | Estimate |
| --- | --- |
| Existing files touched | ... |
| New files added | ... |
| Rough LOC | ... |
| Effort | ... |
| Complexity | ... |
| Foreignness | ... |
| Confidence | ... |

## Likely Touch Points

Planning-time hints only. These are not implementation instructions and may
drift before the PBI is worked.

- `path/to/file`

## Dependencies

- ...

## Risks and Decisions

- ...

## Validation Plan

- ...

```

## Final Response

Keep the response concise:

- Before approval, link the artifact and summarize the top decisions that need
  review.
- After approval, list created issue links.
- Explain any feature split in one sentence per split.
- Include the effort/complexity summary table.
- Name any backlog placement, GitHub auth, or open-question blockers.

Do not implement the feature as part of this skill unless Gordon explicitly
switches from planning/backlog creation to implementation.
