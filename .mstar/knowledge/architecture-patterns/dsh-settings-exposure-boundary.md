---
module: dsh host settings exposure boundary
date: 2026-08-10
problem_type: architecture_pattern
category: architecture-patterns
severity: high
title: dsh host settings exposure boundary — third-party namespaces need a host patch (dsh-llm-fallbacks pattern)
description: The dsh host apiproxy only exposes allowlisted settings namespaces to web clients; a third-party plugin's settings section is refused with settings-not-exposed. Verified fix path: host patch mechanism shipped by the plugin (patches/ + apply/revert/verify/autopatch scripts, dsh-llm-fallbacks pattern) + unexposed-namespace guidance in the section.
plan_id: dsh-advisor-settings-n2
tags:
  - dsh
  - settings
  - exposure
  - apiproxy
  - host-patch
  - settings-not-exposed
  - blocker
applies_when:
  - A plugin registers a settings namespace and expects the web Settings page to read/write it
  - Diagnosing settings-not-exposed or a Settings section that renders but never saves
  - Evaluating whether a host change is needed for a third-party feature
---

# dsh host settings exposure boundary

## Context

The dsh web Settings page's wire (`settings.describe` / `settings.mutate` / `settings.update` / `settings.replace`) is served by the host's apiproxy. **The host deliberately exposes only an allowlist of namespaces to web clients** — a future registration does NOT become remotely readable/writable by default (this is an explicit design comment in the apiproxy, not an oversight).

## The boundary (verified at b8343cb, dev mirror AND installed runtime)

- `exposedNamespaces()` = `modelProviderNamespaces()` (settingsNs of llm configurable providers only) ∪ `WEB_SETTINGS_NAMESPACES ['permission']` ∪ `PRODUCT_SETTINGS_NAMESPACES ['ui-onboarding']` — **hardcoded module constants** in the host apiproxy source (packages/host/apiproxy).
- `settings.describe` filters to the exposed set (the client never receives a non-exposed namespace's view); settings mutate/update/replace on a non-exposed namespace → settings-not-exposed refusal.
- **No config escape hatch**: the apiproxy config only carries a workspace root; no registration flag on `installSettingsSection`; no plugin hook. A third-party plugin CANNOT expose its namespace from inside the plugin repo.

## Symptoms

- The Settings section renders (slot registration is client-side) but `settings.mutate` always fails with settings-not-exposed; the store sees `advisorView === undefined` and (without a presence check) presents a functional-looking form whose Apply can only fail.
- QA "toggle → save" fails at the first save; only a static/analysis review catches it before browser testing (the boot graph + bundle + factory-execution smokes do NOT exercise the settings wire).

## Fix path (verified, user-approved)

1. **Plugin-side mitigations (always)**: track namespace presence (`advisorPresent`) and render a distinct "advisor namespace unavailable/unexposed in this dsh build" notice with no Apply when the view is absent; special-case settings-not-exposed copy.
2. **Host patch mechanism (dsh-llm-fallbacks pattern, user-directed)**: the plugin ships the host-side change as a git patch + scripts, so the OPERATOR can apply it to their dsh source tree:
   - the apiproxy patch under patches/ — minimal diff: add `'advisor'` to `PRODUCT_SETTINGS_NAMESPACES` (or the equivalent allowlist), repo-root-relative paths (pnpm `@scope+pkg@version.patch` naming).
   - the apply/revert/verify/autopatch scripts under scripts/: runtime-derived target (the DSH_SOURCE_DIR env var, defaulting to the dsh source current dir), tri-state `git apply --check` / `--reverse --check` (idempotent), `--check`/`--skip-build`/`-d|--target` options, probe-based verify (source + build artifact markers, SKIP on missing files), warn-only install-time autopatch with an env opt-out (the DSH_ADVISOR_AUTOPATCH env opt-out), build step: incremental tsc over the apiproxy package plus the host-face tsdown build.
   - **Gotcha**: the .git entry under the dsh source current dir is a FILE (worktree), so the `.git`-presence check must use `-e` not `-d` (the dsh-llm-fallbacks reference uses `-d` and would reject the real default target).
   - Security framing: apply runs the target tree's build code — trusted tree only; patch is minimal + revertible; dsh upgrades reset the patch (re-run apply).
3. **Residual lifecycle**: register as a true blocker-defer (`decision: defer`, severity per impact, Durable Roadmap target: operator applies patch + rebuild → QA re-verifies the real round-trip). The plugin must not claim the round-trip works without it.

## Why This Matters

This is a cross-repo blocker that only surfaces at browser-level acceptance: all install/bundle/factory smokes pass while the settings wire silently refuses. Knowing the boundary + the patch mechanism saves a future plugin a full QC-tri + escalation cycle. The R# (R1 in this repo's status.json (harness process artifact)) tracks the operator action.

## When to Apply

- Before promising a web Settings page for ANY third-party dsh plugin namespace.
- When diagnosing a rendered-but-never-saving Settings section.
- When deciding whether a host change is in-repo or cross-repo (it is cross-repo here).

## Examples

- `dsh-advisor` n2: C-1 QC2 Critical → user decision (option A + patch mechanism) → `patches/` + 4 scripts + tests/host-patch.test.ts (read-only `--check` vs real tree; full apply/verify/revert cycle on a scratch clone) → R1 open (blocker-defer).
