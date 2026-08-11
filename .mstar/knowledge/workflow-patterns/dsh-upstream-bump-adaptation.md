---
module: dsh upstream bump adaptation (host patch + client declaration)
date: 2026-08-11
problem_type: workflow_issue
category: workflow-patterns
severity: medium
title: Adapting a dsh plugin bundle to an upstream dsh bump — patch regeneration, probe discriminators, declaration migration
description: Verified process for surviving a dsh staging-snapshot upgrade: regenerate host-exposure patches byte-exact against the refactored source (blob hashes, forward/reverse apply checks), make verify probes key on semantic discriminators with present/absent directions, migrate the dshClient → dsh.client declaration (no fallback, negative-verdict cache), and restart + re-verify the runtime.
plan_id: dsh-advisor-settings-ui-n3
tags:
  - dsh
  - upstream-bump
  - patch
  - verify-probes
  - dsh-client
  - settings-exposure
  - restart
applies_when:
  - A new $DSH_HOME/source/current staging snapshot is installed after a dsh upgrade
  - A shipped host patch (git apply into the dsh source tree) starts conflicting
  - The web Settings page stops exposing a plugin namespace after an upgrade
  - The plugin client half stops loading in the web shell after an upgrade
---

# dsh upstream bump adaptation (host patch + client declaration)

## Context

dsh upgrades stage a new `$DSH_HOME` staging snapshot (symlink → a `staging` snapshot directory). Plugins that ship host patches (git diffs applied into the dsh source tree, e.g. the settings-exposure allowlist patch) and client halves (package.json declarations scanned by `ClientModuleHostService`) silently break on the new baseline: the patch context no longer matches, and contract fields get renamed. Symptom pattern observed at the 20da39e bump (iter-20260810-dsh-advisor-n3): the old patch failed forward AND reverse apply; the runtime `settings.describe` no longer exposed the `advisor` namespace; the `dshClient` declaration was ignored by the new modules service.

## Guidance

### 1. Regenerate host patches byte-exact against the refactored source

- Read the CURRENT upstream file (never memory) and take the hunk context verbatim — em-dashes, backticks, comment blocks included.
- Build the diff by hand or via `git diff` on a scratch copy; the `index` line blob hashes matter for hygiene: old = `git rev-parse HEAD` with the file path, new = hash of the patched content (`git hash-object`). Wrong hashes are ignored by `git apply` but are a review hygiene flag.
- Acceptance before shipping: `git apply --check` from the target tree passes (forward) AND `git apply --reverse --check` fails (proves not already applied / state distinguishable). The shipped `scripts/apply-dsh-patch.sh` wraps this (idempotent: forward-apply check, reverse-check skip when already applied).
- Update in lockstep: the patch file, the patch README (baseline block + diff example + upgrade note), and the tests that pin the diff shape (e.g. host-patch.test.ts `-`/`+` line pins). Grep for the old baseline text afterwards.

### 2. Verify probes must key on semantic discriminators — present AND absent directions

- A probe on the *declaration* (e.g. `PRODUCT_SETTINGS_NAMESPACES = new Set(`) exists in both patched and unpatched states — it is NOT a patch discriminator. The patch's added *entry* (e.g. the `"advisor"` allowlist line) is the discriminator: `--absent` mode must key on it alone (mark the declaration probe present-only, e.g. `|P` scope).
- Probes must survive emit-shape drift: the new tsdown/rolldown emits the Set MULTI-LINE (each entry on its own indented line, double-quoted) where the old bundler emitted single-line — a line-based `[^;]*` regex cannot span lines. Use a line-anchored, quote-agnostic entry probe (`^[[:space:]]*["']advisor["']`) and a fixed-string (`grep -F`) declaration probe.
- After any upstream bump, re-run BOTH `verify` (present) and `verify --absent` (simulated reverted bundle) — the first probe-split regression (absent-mode false-fail) was only caught by exercising the absent direction.
- The `--runtime` probe (settings.describe success envelope + `"ns":"advisor"`) is the authoritative end-to-end gate; file probes alone cannot detect a server that was not restarted.

### 3. Migrate the client declaration: legacy `dshClient` → nested `client` key under `dsh`

- The modules service reads `pkg.dsh.client` ONLY (nested under `dsh`, alongside the `bundle` patch key); there is NO `dshClient` fallback (verified at 20da39e). A legacy-only declaration is silently not registered.
- Negative verdicts (`pkgMeta` cache) never expire within a process — the migration (and the patch) take effect only after a `dsh web` restart. Verify the boot-graph row (`"id":"<plugin>"` in `__DSH_BOOT__`) after restart.
- Pin the migration with a regression assertion (that the legacy `dshClient` field is `undefined` and the nested `client` key under `dsh` has the right shape) in the build-contract tests.

### 4. Restart + runtime verification sequence

1. Apply patch to the live tree (`scripts/apply-dsh-patch.sh`, includes apiproxy rebuild) → file probes.
2. Restart `dsh web` (patch + declaration both need it; the profile may auto-restart).
3. `verify-dsh-patch.sh --runtime` → namespace exposed.
4. Boot-graph row present (client half loaded under the new declaration).
5. Wire-level settings round-trip (describe → mutate → describe → restore, tracking revisions) — read/write against the REAL host.
6. Served bundle hygiene (no NUL / no builder machine path) + browser-level visual check (human).

## Why This Matters

Every artifact that mirrors an upstream shape (patch context, verify probes, the client declaration, the CSS-modules stub) carries a failure mode when the shape evolves. The adaptation cost is small when caught at the snapshot bump and large when discovered later (silent namespace refusal, silently-unregistered client half). The fail-closed direction (probe exits 1, build assertions throw) is what makes drift discoverable — keep it.

## When to Apply

Any dsh plugin bundle that ships a host patch, a client half, or both, immediately after a `$DSH_HOME` staging snapshot upgrade. Also applies to dsh-llm-fallbacks-style role patches (same mechanism).

## Examples

- iter-20260810-dsh-advisor-n3 (this repo): api-proxy patch regenerated for `AGENT_PRESET_SETTINGS_NAMESPACE` (new `dsh-agent-presets` package); bundle probe split into present/absent-aware line probes (two fix rounds — the absent-mode regression was caught by review, then fixed and verified against a simulated unpatched bundle); legacy `dshClient` → nested `client` migration pinned by test; runtime verified post-restart (probe PASS, boot row, RPC round-trip).
