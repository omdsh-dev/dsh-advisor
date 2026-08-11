---
module: dsh upstream bump adaptation (client declaration + runtime re-verification)
date: 2026-08-11
problem_type: workflow_issue
category: workflow-patterns
severity: medium
title: Adapting a dsh plugin bundle to an upstream dsh bump — contract migration, probe discriminators, restart verification
description: Verified process for surviving a dsh staging-snapshot upgrade: key file/runtime probes on semantic discriminators with present/absent directions, migrate the dshClient → dsh.client declaration (no fallback, negative-verdict cache), restart + re-verify the runtime. The plugin-shipped host patch mechanism (which had to be regenerated per bump) is retired; the settings exposure boundary has NO upstream opt-in (verified at pristine 20da39e) — the web section is notice-only and configuration flows through the plugin config row. Never verify host capabilities against a locally-modified host tree (circular verification).
tags:
  - dsh
  - upstream-bump
  - verify-probes
  - dsh-client
  - settings-exposure
  - restart
applies_when:
  - A new $DSH_HOME/source/current staging snapshot is installed after a dsh upgrade
  - The web Settings page stops exposing a plugin namespace after an upgrade
  - The plugin client half stops loading in the web shell after an upgrade
---

# dsh upstream bump adaptation (client declaration + runtime re-verification)

## Context

dsh upgrades stage a new `$DSH_HOME` staging snapshot (symlink → a `staging` snapshot directory). Plugin client halves (package.json declarations scanned by `ClientModuleHostService`) and runtime-facing contracts silently break on the new baseline: contract fields get renamed, and emit shapes drift. Symptom pattern observed at the 20da39e bump: the `dshClient` declaration was ignored by the new modules service. The `advisor` namespace is NOT exposed on the web configuration boundary on ANY current upstream dsh build (there is no registration-level opt-in upstream — see the settings exposure boundary knowledge doc); an apparent "exposure" observed against a locally-modified staging worktree is a circular-verification artifact, not an upstream capability.

## Guidance

### 1. Verify probes must key on semantic discriminators — present AND absent directions

- A probe on a *declaration* that exists in both states (e.g. `PRODUCT_SETTINGS_NAMESPACES = new Set(`) is NOT a discriminator — it cannot tell patched from unpatched, present from absent. Key probes on the added *entry* (e.g. an allowlist entry) or on a marker that exists in exactly one state; exercise both directions (present AND absent) so a probe split regression cannot hide.
- Probes must survive emit-shape drift: a bundler change can flip an emit from single-line to multi-line (each entry on its own indented line). Use line-anchored, quote-agnostic entry probes and fixed-string (`grep -F`) declaration probes instead of span-line regexes.
- The authoritative end-to-end gate is a live probe (e.g. `settings.describe` success envelope + `"ns":"advisor"`); file probes alone cannot detect a server that was not restarted.

### 2. Migrate the client declaration: legacy `dshClient` → nested `client` key under `dsh`

- The modules service reads `pkg.dsh.client` ONLY (nested under `dsh`, alongside the `bundle` patch key); there is NO `dshClient` fallback (verified at 20da39e). A legacy-only declaration is silently not registered.
- Negative verdicts (`pkgMeta` cache) never expire within a process — the migration takes effect only after a `dsh web` restart. Verify the boot-graph row (`"id":"<plugin>"` in `__DSH_BOOT__`) after restart.
- Pin the migration with a regression assertion (that the legacy `dshClient` field is `undefined` and the nested `client` key under `dsh` has the right shape) in the build-contract tests.

### 3. Restart + runtime verification sequence

1. Restart `dsh web` (declaration changes need it; the profile may auto-restart).
2. Boot-graph row present (client half loaded under the new declaration).
3. `settings.describe` reflects the real host boundary: on current upstream builds the `advisor` namespace is ABSENT (expected — no opt-in exists; see the settings exposure boundary knowledge doc). Treat "namespace exposed" as a discriminating probe only when the host tree is pristine — a locally-modified staging worktree makes the probe circular.
4. Wire-level plugin-command check (`/advisor status` matched) — the plugin runs fully from the plugin config row; the web section is notice-only.
5. Served bundle hygiene (no NUL / no builder machine path) + browser-level visual check (human).

### 4. Retired: the plugin-shipped host patch mechanism

The earlier fix shipped a host patch (git diff applied into the dsh source tree) plus apply/revert/verify shell scripts and an install-time auto-apply, and every upstream bump required regenerating the patch byte-exact against the refactored source (blob hashes, forward/reverse apply checks, present/absent probe splits). That mechanism was **retired and deleted** — the patch, scripts, and host-patch tests are gone, and no host source-tree modification is shipped anymore. The SAME class of modification must not be reintroduced by editing the running host's $DSH_HOME/source/current worktree directly (uncommitted): that is indistinguishable from the retired patch (it silently regresses on the next snapshot rebuild) and it makes verification circular. Keep the host pristine; upstream bumps touch only the plugin's own contracts (declaration shape, emit shape, probe targets).

## Why This Matters

Every artifact that mirrors an upstream shape (the client declaration, verify probes, the CSS-modules stub) carries a failure mode when the shape evolves. The adaptation cost is small when caught at the snapshot bump and large when discovered later (silently-unregistered client half, silent namespace refusal). The fail-closed direction (probe exits 1, build assertions throw) is what makes drift discoverable — keep it.

## When to Apply

Any dsh plugin bundle that ships a client half, immediately after a `$DSH_HOME` staging snapshot upgrade. Host-side settings exposure needs no patch and has no upstream opt-in — the web section talks through the GatewayService RPC channel (`/api/<ns>/<method>`), which is not allowlist-gated (see the settings exposure boundary knowledge doc).

## Examples

- 20da39e bump (this repo): the `dshClient` → nested `client` migration was pinned by test and verified post-restart (boot row). The old host-tree patch conflict at that bump was the trigger for the patch-mechanism retirement. Note the settings-exposure lesson from the SAME bump: the `exposeToWebClients` capability existed only as uncommitted edits in the local staging worktree; verifying "namespace exposed" against that modified host produced a circular conclusion that upstream supported the opt-in — the pristine upstream tree has no such option (TS2353 on `SettingsRegisterOptions`), and clearing the staging worktree + restarting the host removed the namespace from `settings.describe` as expected.
- "advisor enabled but never injects" host diagnosis: three live probes (session/event reachability via a mounted temp plugin, observer gate chain replica, direct `ctx.llm.stream`) pinned the REAL chain: delivery was never broken; (a) NO_ADAPTER because the plugin's ctx sits in an isolated scope whose local `llm` service lacks provider adapters (adapter registrations live on the application root's LlmService) → resolve `ctx.root.get('llm') ?? ctx.llm`; (b) "reply yielded no note" because deepseek-v4-flash's reasoning stream consumed the whole maxTokens=256 budget → text output empty (finish max-tokens) → `reasoningEffort: 'off'` (capability-gated via resolveModelInfo) + a 20× budget. Also: multi-fiber composition (3 active instances) needs a single-reviewer claim guard; self-trigger hazard when the trigger event class includes the advisor's own inbox splices (payload-discriminate on `source.kind === 'user'`). Host logs (`ctx.logger('advisor')` output) were the decisive evidence the operator supplied — keep them reachable during diagnosis.
