---
module: dsh peer-only bump checklist (registry line + lockfile + release-age exemptions)
date: 2026-08-21
problem_type: workflow_issue
category: workflow-patterns
severity: low
title: Mechanical checklist for bumping dsh peerDependencies to a new published line
description: Verified process for a peer-only dsh bump (no API migration): verify the published line on the registry, bump every @deepseek-ai/dsh-* peer, re-resolve the lockfile, sync pnpm-workspace minimumReleaseAgeExclude including NEW transitive peers pulled in by the re-resolution, update the README badge, then typecheck/test/build. The 0.1.1-rc.1 breaking changes (credentials records/authorization, session-projection stateSchema, pi-ai auth injection, webserver index-inject, cacheHitPercent string|null, acp-snapshot scrub rename) are N/A for a plugin that consumes none of those APIs — the settings.plugin.item card surface (settingsSchema service, keyed slot + hooks compartment) is unchanged.
tags:
  - dsh
  - upstream-bump
  - peer-dependencies
  - pnpm-workspace
  - minimumReleaseAge
applies_when:
  - A new dsh line (rc or stable) is published and the plugin only needs its peers re-pinned
  - The plugin's consumed API surface is unchanged by the upstream breaking changes
---

# dsh peer-only bump checklist

## Context

dsh-advisor has bumped its `@deepseek-ai/dsh-*` peerDependencies four times
(rc.6 → rc.7 → rc.8 → 0.1.1-rc.1). When the upstream release's breaking
changes do not touch any API the plugin consumes, the bump is mechanical and
follows a fixed checklist. The 0.1.1-rc.1 release (172 commits) renamed
`credentials/updated` → `credentials/reference-updated`, added credential
records + `@deepseek-ai/dsh-authorization`, split session-projection
`schema` → `stateSchema` + `wire`, made pi-ai `createModels()` require auth
injection, replaced `tapIndex` with `webserver/index-inject`, changed
`cacheHitPercent` to `string | null`, and renamed the acp-snapshot scrub
pipeline — none of which dsh-advisor consumes (it listens to
`session/event` / `agent/created` / `agent/disposed` / `session/disposed` /
`connection/reset` and uses the settings.plugin.item card surface).

## Guidance

### 1. Verify the published line first

`npm view @deepseek-ai/dsh-agent versions --json` — if only `0.1.1-rc.1` is
published (no stable `0.1.1`), pin `^0.1.1-rc.1` (same prerelease-range
pattern as the previous `^0.1.0-rc.8`). Check EVERY peer package has the
line; check the new line's own peerDependencies to confirm
`@deepseek-ai/cordis` / `@deepseek-ai/schemastery` / `react` ranges did not
move (they stayed `^4.0.1` / `^3.18.1` at 0.1.1-rc.1).

### 2. Bump + re-resolve

- `package.json`: replace the old line in every `@deepseek-ai/dsh-*` peer.
- `pnpm install --no-frozen-lockfile` (frozen fails on specifier mismatch by
  design). The re-resolution pulls NEW transitive first-party peers into the
  lockfile (rc.8 → 0.1.1-rc.1 added dsh-permission-presets, dsh-sandbox,
  dsh-sandbox-policy, dsh-shell, dsh-subprocess).

### 3. Sync minimumReleaseAgeExclude

`pnpm-workspace.yaml` carries a standing exemption list for first-party
packages (CI supply-chain policy rejects fresh rc releases). After the
re-resolution, diff the lockfile's `@deepseek-ai/dsh-*@<line>` entries
against the exemption list and add any new packages (alphabetical
placement). Verify with `comm -3` between the two sorted sets — they must
be identical. New entries MUST use the same
`'@deepseek-ai/<pkg>@<line> || <line>'` form as the rest of the list (never
a bare single-form tail) and each package must appear exactly once — a
previous bump duplicated five new packages by appending a single-form
tail after the `||` entries.

### 4. Update the README badge

- README.md / README.zh.md shields.io dsh badge — the single
  human-facing compatible-version signal.
- `tests/peer-deps.test.ts` is version-agnostic: it derives the shared
  `dsh-*` range from package.json, so a bump needs no test edits.
- Do NOT retouch scattered version mentions in source/test comments or
  docs (CONCEPTS.md, docs/verification.md, docs/consumer-api.md) — they
  describe host-API facts, not the pinned line.
- CHANGELOG.md and historical knowledge docs are records — do NOT rewrite
  past entries.

### 5. Evidence

`pnpm typecheck` / `pnpm test` / `pnpm build` all exit 0. The client
card/store surface (SettingsSchemaService getPath/setPath/deletePath,
`settings.plugin.item` keyed slot + `hooks` compartment, SnapshotStore) is
unchanged at 0.1.1-rc.1 — verify against the installed types rather than
assuming a re-migration is needed.

## Why This Matters

The checklist is cheap when run at the bump and expensive when skipped: a
stale minimumReleaseAgeExclude breaks CI installs, a stale pin test fails
the suite, and a stale badge misleads consumers about the compatible host
line. The "walk the migration checklist against ACTUAL imports" step is
what keeps the bump mechanical — do not migrate APIs the plugin does not
use.

## When to Apply

Any dsh plugin bundle bumping peers to a new published line, immediately
after the release. If the plugin DOES consume a renamed/changed API, the
UPGRADE-ADAPTATION guide's per-item migration applies instead (see the
companion dsh-upstream-bump-adaptation.md for client-declaration and
runtime-verification concerns).
