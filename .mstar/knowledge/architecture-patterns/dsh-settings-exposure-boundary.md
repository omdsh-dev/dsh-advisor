---
module: dsh host settings exposure boundary
date: 2026-08-11
problem_type: architecture_pattern
category: architecture-patterns
severity: high
title: dsh host settings exposure boundary — third-party namespaces join via the upstream exposeToWebClients opt-in
description: The dsh host apiproxy only exposes allowlisted settings namespaces to web clients; a third-party plugin's settings section is refused with settings-not-exposed unless the namespace joins the boundary. Current fix: the upstream registration opt-in `exposeToWebClients: true` (dsh ≥ snapshot 20da39e) unions the namespace into the configuration-client boundary — no host patch. Older hosts fall back to the unexposed-namespace notice + plugin config row.
tags:
  - dsh
  - settings
  - exposure
  - apiproxy
  - exposeToWebClients
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

## The boundary (historical allowlist, verified at b8343cb; superseded at 20da39e)

- Pre-20da39e: `exposedNamespaces()` = `modelProviderNamespaces()` (settingsNs of llm configurable providers only) ∪ `WEB_SETTINGS_NAMESPACES ['permission']` ∪ `PRODUCT_SETTINGS_NAMESPACES ['ui-onboarding']` — **hardcoded module constants** in the host apiproxy source (packages/host/apiproxy). No registration flag existed; a third-party plugin CANNOT expose its namespace from inside the plugin repo.
- At snapshot 20da39e the host gained the registration-level opt-in: a namespace registered with `exposeToWebClients: true` reports `exposed: true` on its descriptor, and `exposedNamespaces()` unions exactly those namespaces into the configuration-client boundary. The hardcoded allowlist is no longer the only gate.
- `settings.describe` filters to the exposed set (the client never receives a non-exposed namespace's view); settings mutate/update/replace on a non-exposed namespace → settings-not-exposed refusal.

## Symptoms

- The Settings section renders (slot registration is client-side) but `settings.mutate` always fails with settings-not-exposed; the store sees `advisorView === undefined` and (without a presence check) presents a functional-looking form whose Apply can only fail.
- QA "toggle → save" fails at the first save; only a static/analysis review catches it before browser testing (the boot graph + bundle + factory-execution smokes do NOT exercise the settings wire).

## Fix path (current mechanism, verified)

1. **Registration opt-in (the fix, always)**: register the namespace with `exposeToWebClients: true` (the upstream registration-level opt-in, threaded through `installSettingsSection`'s hooks). On dsh ≥ snapshot 20da39e the namespace joins the web configuration boundary with **no host patching** — runtime-verified: `settings.describe` exposes the `advisor` namespace with the opt-in and no host-side change.
2. **Plugin-side mitigation (always, covers older hosts)**: track namespace presence (`advisorPresent`) and render a distinct "advisor namespace unavailable/unexposed in this dsh build" notice with no Apply when the view is absent; point at the plugin config row in the profile's `cordis.patch.yml` (`- id: advisor` + `config:` map). `/advisor` is a per-session toggle only and cannot supply provider/model.
3. **Retired: the plugin-shipped host patch mechanism**. The earlier fix shipped a git patch against the host source tree (a shipped patch directory + apply/revert/verify shell scripts with an install-time auto-apply, dsh-llm-fallbacks pattern) that added `'advisor'` to `PRODUCT_SETTINGS_NAMESPACES`. Once the upstream opt-in was runtime-verified, that entire mechanism (patch file, scripts, install-lifecycle automation, host-patch tests) was **retired and deleted** — it modified the operator's dsh source tree on install and had to be re-applied after every dsh upgrade. Do not re-introduce a host-tree patch: the opt-in is the upstream-supported path.

## Why This Matters

This is a cross-repo boundary that only surfaces at browser-level acceptance: all install/bundle/factory smokes pass while the settings wire silently refuses. Knowing that the boundary is joined by a registration flag (not by patching the host) saves a future plugin both a failed patch lifecycle and a full QC-tri + escalation cycle. The unexposed-namespace notice remains the correct fallback for older hosts that lack the opt-in.

## When to Apply

- Before promising a web Settings page for ANY third-party dsh plugin namespace: register with `exposeToWebClients: true` and verify against the running host.
- When diagnosing a rendered-but-never-saving Settings section.
- When deciding whether a host change is needed for a third-party feature (it is not, on dsh ≥ 20da39e).

## Examples

- The `advisor` settings namespace: registered with `exposeToWebClients: true`; runtime-verified exposed via the upstream opt-in with the shipped host patch reverted. The former plugin-shipped host patch (the shipped patch directory + scripts + host-patch tests) was retired in the same change.
