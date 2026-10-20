# Maintaining Skill Graph

## Product and documentation

This is a local, read-only OpenChamber extension for understanding OpenCode skill
discovery and written references. Keep README.md user-facing: screenshot, value,
scope, installation, basic controls. Put parser and maintenance detail here.
Do not include personal skill inventories or machine-specific paths in published
docs. `docs/skill-graph.png` shows an illustrative library in the actual UI.

## Architecture

- `graph.ts`: discovery, exposure, reference extraction, diagnostics and
  reachability over a `SkillFiles` adapter. Preserve file/line/text provenance.
- `panel/main.ts`, `panel/styles.css`, `panel/index.html`: SVG graph, controls,
  inspector and polling. Use SDK controls and host theme variables.
- `report.ts`: read-only Node adapter and CLI (`node report.ts [--deep] [--json]
  [root]`). Tests must not require a developer's personal skills to exist.
- `dev.mjs`: local preview at `http://127.0.0.1:4317/`. `SKILL_GRAPH_ROOT=/dir`
  previews another library. Never package it as runtime extension code.
- `build.mjs` and `package.mjs`: esbuild bundle and runtime-only ZIP with checksum.
  Generated bundles, dependencies, browser artifacts and `dist/` stay out of git.

Read the current source for helper modules and tests added alongside these files.
Prefer narrow fixes and evidence-based checks over a broad framework rewrite.

## Discovery and reference semantics

Use [OpenCode V2 skills documentation](https://opencode.ai/v2/docs/skills/) as
the source of truth. Path-derived IDs and frontmatter display names are distinct.
Root-level `*.md` files are definitions; nested definitions require exact
`SKILL.md`. Do not flag valid root-level `skill.md` as a casing error.

A skill without a description is not exposed. `metadata.opencode/autoinvoke`
takes precedence over `disable-model-invocation`. Boolean values and recognized
boolean strings are accepted. Hidden skills remain explicitly loadable.

Edges describe text, not execution or semantic dependencies:

- An exact backticked skill ID outside a fenced code block is an ID mention.
  A mention from an exposed skill is labeled index discovery.
- A Markdown destination or recognized relative/absolute skills-root path can
  produce a file-reference edge. The deepest owning skill folder owns the target.
- Internal references stay associated with their own skill. Nested Markdown is
  opt-in, attributed to the owning skill, not presented as extra skill nodes.
- Bare prose, semantic similarity, non-Markdown files and inferred invocation
  are outside scope. A missing edge is not proof that an agent cannot find a skill.

Reference extraction must not double-count the same destination, discard absolute
Markdown destinations, or end a code fence on a backtick prefix with trailing text.
Keep matching source lines and forms inspectable when extending the scanner.

Diagnostics distinguish loading errors, warnings and portability information.
An unreachable skill is one with no chain of recorded references from exposed
skills. Naming mismatches are warnings under V2, not proof of a loading failure.
Diagnostic subjects may be files or nested folders rather than skill nodes; their
inspector paths must handle that without assuming every subject is a stray folder.

## UI behavior

- Wide mode: independent inspector scrolling, graph drag-to-pan and wheel zoom.
- At 700px and narrower: one bounded scrollable body, stacked graph and inspector,
  ordinary wheel and touch gestures scroll the page. Buttons or Ctrl/Command-wheel
  zoom. Do not restore auto-height on both html/body under a clipped iframe root.
- Preserve keyboard focus when inspector or legend controls are recreated.
- Refreshes must honor the latest Nested setting even if a build is already busy.
- Watch polls every five seconds while visible; do not add a service merely to
  watch files. SDK 2.5.0 has no file-watch subscription.

## Permissions and installation

The manifest allows filesystem access only to `~/.config/opencode/skills` and
`~/.config/opencode/skills/**`. Both patterns are needed to list the root itself.
The grant technically includes writes; keep the panel read-only. Do not add broad
home access or a service to avoid sandbox restrictions. The host rejects symlinks
escaping the approved tree. Local previews should enforce comparable boundaries.

Install through Settings → Extensions → Add. On OpenChamber 2.5.0 the Settings UI
uses `POST /api/guests` with `{"path":"<absolute folder>"}`, then
`PUT /api/guests/skill-graph/capabilities` with `{"granted":["filesystem"]}`.
Treat these as version-specific observed routes, not a stable SDK contract.
Registration lives in `~/.config/openchamber/extensions.json`; preserve other
extensions and use supported APIs rather than overwriting that registry.

## Verification and publishing

```sh
npm ci
npm run check
npm run package
npm test
```

Run focused parser fixtures and UI regression tests for changed behavior. Exercise
actual scroll/focus behavior when changing responsive layout or rerendering; a
CSS string assertion is insufficient. Stop preview servers and close test tabs.
Verify ZIP contents and checksum after final README or bundle changes.

`test/panel.test.mjs` runs browser regressions when Playwright is available.
Set `PLAYWRIGHT_MODULE` to an installed Playwright module path if it is not a
local dependency, and optionally `PLAYWRIGHT_EXECUTABLE` to a browser executable.
Without Playwright, `npm test` explicitly skips that suite; do not report it as
browser-verified. The browser fixture covers diagnostic navigation, focus,
refresh races and narrow-layout scrolling without loading personal skills.

Before publishing, inspect staged files. Exclude real skill contents, credentials,
personal screenshots, temporary fixtures and browser traces. Keep the public
screenshot legible at README width, using an explicitly illustrative library.
Do not commit generated `panel/main.js`, `node_modules/`, or `dist/`. The repository
URL alone is not installable until the source is built; do not advertise an absent
release download. No release or license choice is implied by a public repository.

## Sources

- [OpenChamber extension guide](https://docs.openchamber.dev/sdk/),
  [host API](https://docs.openchamber.dev/sdk/host/),
  [UI kit](https://docs.openchamber.dev/sdk/ui/).
- Installed `@openchamber/sdk` 2.5.0 README, API and GUEST_SERVICES docs. Read only
  relevant sections, not the entire API manual for a small change.
- [OpenCode V2 skills](https://opencode.ai/v2/docs/skills/).
- Packaging pattern adapted from
  [openchamber-jobs](https://github.com/rndmcnlly/openchamber-jobs).
