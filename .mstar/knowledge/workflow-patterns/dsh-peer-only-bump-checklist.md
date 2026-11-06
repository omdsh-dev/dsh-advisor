---
module: dsh peer-only bump checklist (registry line + peer floors + lockfile + release-age exemptions)
date: 2026-08-21
last_updated: 2026-11-06
plan_id: dsh-advisor-dsh-0.2.2-rc1-upgrade
problem_type: workflow_issue
category: workflow-patterns
severity: low
title: Mechanical checklist for bumping dsh peerDependencies to a new published line
description: Verified process for a peer-only dsh bump (no API migration): verify the published line on the registry, inspect the new line's own peerDependencies for cordis/schemastery floor moves and move the root peer ranges plus the tests/peer-deps.test.ts pin assertion with them, bump every @deepseek-ai/dsh-* peer, re-resolve the lockfile under the CI pnpm version, sync pnpm-workspace minimumReleaseAgeExclude to the resolved first-party set (two-way set difference empty), re-judge the standing overrides, update the README badge, walk the UPGRADE-ADAPTATION checklist against actual imports, then typecheck/test/build. The breaking changes of each line are N/A for a plugin that consumes only agent/session/llm/typert/client surfaces — 0.1.1-rc.1 (credentials records/authorization, session-projection stateSchema, pi-ai auth injection, webserver index-inject, cacheHitPercent string|null, acp-snapshot scrub rename) and all 15 items of 0.2.2-rc.1 — the settings.plugin.item card surface (settingsSchema service, keyed slot + hooks compartment) is unchanged.
tags:
  - dsh
  - upstream-bump
  - peer-dependencies
  - peer-ranges
  - pnpm-workspace
  - minimumReleaseAge
applies_when:
  - A new dsh line (rc or stable) is published and the plugin only needs its peers re-pinned
  - The plugin's consumed API surface is unchanged by the upstream breaking changes
---

# dsh peer-only bump checklist

## Context

dsh-advisor has bumped its `@deepseek-ai/dsh-*` peerDependencies five times
(rc.6 → rc.7 → rc.8 → 0.1.1-rc.1 → 0.2.2-rc.1). When the upstream release's
breaking changes do not touch any API the plugin consumes, the bump is
mechanical and follows a fixed checklist. The 0.1.1-rc.1 release (172
commits) renamed `credentials/updated` → `credentials/reference-updated`,
added credential records + `@deepseek-ai/dsh-authorization`, split
session-projection `schema` → `stateSchema` + `wire`, made pi-ai
`createModels()` require auth injection, replaced `tapIndex` with
`webserver/index-inject`, changed
`cacheHitPercent` to `string | null`, and renamed the acp-snapshot scrub
pipeline — none of which dsh-advisor consumes (it listens to
`session/event` / `agent/created` / `agent/disposed` / `session/disposed` /
`connection/reset` and uses the settings.plugin.item card surface).

## Guidance

### 1. Verify the published line first, including its own peer floors

`npm view @deepseek-ai/dsh-agent versions --json` — if only `0.2.2-rc.1` is
published (no stable `0.2.2`), pin `^0.2.2-rc.1` (same prerelease-range
pattern as the previous `^0.1.1-rc.1`). Check EVERY peer package has the
line.

Then inspect the NEW line's own peerDependencies — the bump can move the
root peers too:

```
npm view @deepseek-ai/dsh-agent@<line> peerDependencies --json
npm view @deepseek-ai/dsh-settings@<line> peerDependencies --json
```

At 0.1.1-rc.1 `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` stayed
`^4.0.1` / `^3.18.1`, so only the `dsh-*` peers moved. At 0.2.2-rc.1 they
did not: `dsh-settings@0.2.2-rc.1` and `dsh-agent@0.2.2-rc.1` declare
`cordis ~4.1.0` / `schemastery ~3.19.0`, which forces the root peer ranges
to `^4.1.0` / `^3.19.0` and the hardcoded schemastery assertion in
`tests/peer-deps.test.ts` to `^3.19.0` in the same change.

**Failure signature**: leaving the root floors stale keeps CI green (the
`dsh-*` specifiers match, so install, typecheck and tests pass) while
`pnpm peers check` reports unmet peers — four groups at 0.2.2-rc.1. Run
`pnpm peers check` as part of this step; CI is not the signal for it.

### 2. Bump + re-resolve under the CI pnpm version

- `package.json`: replace the old line in every `@deepseek-ai/dsh-*` peer
  (20 peers at 0.2.2-rc.1).
- Re-resolve with `npx --yes pnpm@11.21.0 install --no-frozen-lockfile`
  (frozen fails on specifier mismatch by design). The install MUST run
  under the pnpm version CI uses — a newer local pnpm rewrites the
  lockfile under a different contract, and `lockfileVersion` (`'9.0'` at
  0.2.2-rc.1) is part of that contract. Verify it stayed unchanged in the
  diff.
- The re-resolution pulls NEW transitive first-party peers into the
  lockfile (rc.8 → 0.1.1-rc.1 added dsh-permission-presets, dsh-sandbox,
  dsh-sandbox-policy, dsh-shell, dsh-subprocess).

### 3. Sync minimumReleaseAgeExclude

`pnpm-workspace.yaml` carries a standing exemption list for first-party
packages (CI supply-chain policy rejects fresh rc releases). After the
re-resolution, diff the lockfile's `@deepseek-ai/*` entries against the
exemption list and add any new packages (alphabetical placement).

Entries are the exact resolved `'@deepseek-ai/<pkg>@<version>'` form and
each package appears exactly once — a previous bump duplicated five new
packages by appending a second tail form after the existing entries.

**Acceptance for this step**: the two-way set difference between the
lockfile-resolved first-party set and the exemption list is empty in BOTH
directions (`comm -3` between the two sorted sets prints nothing; 73
entries at 0.2.2-rc.1). A one-way check misses both a stale entry (lockfile
dropped it) and a missing one (lockfile gained it), and either breaks
`pnpm install --frozen-lockfile` in CI.

The `cordis` / `schemastery` / `cosmokit` rows churn on every bump — their
versions follow the upstream line even when no `dsh-*` package changed, so
re-diff instead of trusting the previous list.

### 4. Re-judge the standing overrides

`overrides` is workspace-only metadata (never shipped to consumers) and its
justification is the resolved graph, so re-read it at each bump:

- An override whose vulnerable constraint the graph no longer pins drops
  out. `fast-uri` was in exactly this position: ajv declares `^3.0.1`,
  which resolves 3.1.9 (the fixed 3.x line) on a fresh resolution, so the
  override was deleted.
- An override stays while an upstream package still pins the bad version
  exactly. `zod` remains because the `dsh-*` peers pin `zod: 4.4.3`
  exactly, which no range override can exclude.

Record the reason in the file's comment next to the override, not only in
the bump's report.

### 5. Update the README badge

- README.md / README.zh.md shields.io dsh badge — the single
  human-facing compatible-version signal.
- `tests/peer-deps.test.ts` derives the shared `dsh-*` range from
  package.json, so a plain `dsh-*`-only bump needs no test edits — but a
  peer-floor move (step 1) does: the schemastery assertion is hardcoded.
- Do NOT retouch scattered version mentions in source/test comments or
  docs (CONCEPTS.md, docs/verification.md, docs/consumer-api.md) — they
  describe host-API facts, not the pinned line.
- CHANGELOG.md and historical knowledge docs are records — do NOT rewrite
  past entries.

### 6. Walk the UPGRADE-ADAPTATION checklist against ACTUAL imports

The upstream release ships a migration list; walk it item by item against
the imports the plugin actually has, and record N/A with the reason for
each. At 0.2.2-rc.1 all 15 items were N/A: the plugin consumes only
agent/session/llm/typert/client surfaces, so nothing touched `dsh-tools`,
schedule, SDK-wire, WebServer, storage or attachment APIs. Do not migrate
APIs the plugin does not use, and do not skip the walk because the previous
bump was also N/A.

### 7. Evidence

`pnpm typecheck` / `pnpm test` / `pnpm build` all exit 0, and `pnpm peers
check` reports no unmet peers. The client card/store surface
(SettingsSchemaService getPath/setPath/deletePath, `settings.plugin.item`
keyed slot + `hooks` compartment, SnapshotStore) is unchanged at
0.2.2-rc.1 — verify against the installed types rather than assuming a
re-migration is needed.

## Why This Matters

The checklist is cheap when run at the bump and expensive when skipped: a
stale minimumReleaseAgeExclude breaks CI installs, a stale peer floor
surfaces only in `pnpm peers check` (CI stays green, so nothing else
reports it), a stale hardcoded pin assertion fails the suite, and a stale
badge misleads consumers about the compatible host line. The "walk the
migration checklist against ACTUAL imports" step is what keeps the bump
mechanical — do not migrate APIs the plugin does not use.

## When to Apply

Any dsh plugin bundle bumping peers to a new published line, immediately
after the release. If the plugin DOES consume a renamed/changed API, the
UPGRADE-ADAPTATION guide's per-item migration applies instead (see the
companion dsh-upstream-bump-adaptation.md for client-declaration and
runtime-verification concerns).
