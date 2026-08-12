---
module: dsh host settings exposure boundary
date: 2026-08-11
last_updated: 2026-08-12
problem_type: architecture_pattern
category: architecture-patterns
severity: high
title: dsh host settings exposure boundary — no registration opt-in exists upstream; third-party namespaces stay off the web boundary
description: The dsh host apiproxy only exposes allowlisted settings namespaces to web clients; a third-party plugin's settings section is refused with settings-not-exposed unless the namespace joins the boundary. Upstream dsh (verified at pristine snapshot 20da39e) has NO registration-level opt-in: `SettingsRegisterOptions` has no `exposeToWebClients` key and `exposedNamespaces()` unions only model-provider plus product namespaces. The working fix bypasses the allowlist entirely through the official GatewayService RPC channel (`/api/<ns>/<method>` claimed by the host's typertGateway; the in-process `ctx.settings.update` inside the `@Remote` set body carries no exposed-namespace check) — the web section reads/writes the namespace through it, and no host patch is applied or required.
tags:
  - dsh
  - settings
  - exposure
  - apiproxy
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

## The boundary (verified at pristine snapshot 20da39e)

- `exposedNamespaces()` = `modelProviderNamespaces()` (settingsNs of llm configurable providers only) ∪ `WEB_SETTINGS_NAMESPACES ['locale', 'permission', 'ui-conversation', 'ui-theme']` ∪ `PRODUCT_SETTINGS_NAMESPACES ['ui-onboarding', AGENT_PRESET_SETTINGS_NAMESPACE]` — **hardcoded module constants** in the host apiproxy source (packages/host/apiproxy). No registration flag exists.
- **There is NO `exposeToWebClients` registration option upstream**: `SettingsRegisterOptions` (packages/settings/settings) has no such key — verified twice: (1) `tsc` fails with TS2353 when the option is passed, (2) the pristine 20da39e tree's `exposedNamespaces()` has no descriptor-union logic. A previous belief that "upstream 20da39e natively supports the opt-in" was a **circular verification**: the capability had been implemented as uncommitted edits in a locally-modified staging tree, and the "runtime-verified exposed" probe was run against that modified host, not against pristine upstream.
- `settings.describe` filters to the exposed set (the client never receives a non-exposed namespace's view); settings mutate/update/replace on a non-exposed namespace → settings-not-exposed refusal.

## Symptoms

- The Settings section renders (slot registration is client-side) but `settings.mutate` always fails with settings-not-exposed; the store sees `advisorView === undefined` and (without a presence check) presents a functional-looking form whose Apply can only fail.
- QA "toggle → save" fails at the first save; only a static/analysis review catches it before browser testing (the boot graph + bundle + factory-execution smokes do NOT exercise the settings wire).

## Fix path (current mechanism, verified)

0. **The working fix (n5): official GatewayService RPC channel — bypasses the allowlist entirely.** The web section does NOT depend on the settings exposure allowlist. The plugin registers a `GatewayService` subclass (@deepseek-ai/dsh-type-meta) whose `@Remote` get/set methods become `/api/<namespace>/<method>` endpoints: the host's typertGateway is the SINGLE `/api` RPC interceptor (a plugin must NOT connection.rpc.intercept on /api again — the interceptor slot is single-seat and throws), and its SRC discovery (`ctx.reflect.props` + `remoteMethods` on the typertGateway binding) claims endpoints from ANY registered service, plugin fibers included (same mechanism as the dsh `goals` service). The section calls connection.rpc.call on the /api interceptor with endpoint advisor/get or advisor/set and payload { args } (payload contract: exactly one plain-object `args` field, keys = method parameter names). The in-process write (`ctx.settings.update(ns, patch)` inside the `@Remote` set body) carries **no exposed-namespace check** — the allowlist gate exists only in the apiproxy wire layer, not in the Settings service itself (verified: zero exposed/notExposed references in the settings package). Endpoint form is the SLASH form (advisor/get), not the dot form (advisor.get) — endpoint claims split on `/` and `invokeRpc` requires two slash segments. Multi-fiber dedupe: cordis Service registration fails loud on a duplicate key; catch-and-log so the first fiber owns the gateway.
1. **Plugin-side mitigation (fallback)**: track gateway reachability (advisorPresent = the advisor/get call succeeds) and render a "configuration channel not available" notice with no Apply when unreachable; point at the plugin config row in the profile's cordis.patch.yml (- id: advisor + config: map). `/advisor` is a per-session toggle only and cannot supply provider/model.
2. **Registration with NO opt-in**: register the namespace plainly (`settings.register(ns, Config, { base: entry })`). Passing `exposeToWebClients` is a type error against upstream `SettingsRegisterOptions` and does not expose anything at runtime. Registration itself is all the runtime depends on (the live source/onChange bridge); the web section reaches the namespace through the GatewayService channel instead.
3. **Retired: the plugin-shipped host patch mechanism**. An earlier fix shipped a git patch against the host source tree (a shipped patch directory + apply/revert/verify shell scripts with an install-time auto-apply, dsh-llm-fallbacks pattern) that added `'advisor'` to `PRODUCT_SETTINGS_NAMESPACES`. That entire mechanism (patch file, scripts, install-lifecycle automation, host-patch tests) was **retired and deleted** — it modified the operator's dsh source tree on install and had to be re-applied after every dsh upgrade. Do not re-introduce a host-tree patch. Note the same trap applies to the staging tree: editing the running host's $DSH_HOME/source/current worktree (uncommitted) is the SAME class of host modification as the retired patch — it silently regresses on the next snapshot rebuild. Keep the host pristine.

## Why This Matters

This is a cross-repo boundary that only surfaces at browser-level acceptance: all install/bundle/factory smokes pass while the settings wire silently refuses. The correct posture for a third-party plugin is: route the web Settings section through the `GatewayService` RPC channel (item 0), which bypasses the allowlist without any host change; the plugin config row stays the authoritative fallback configuration path. Do not verify host capabilities against a locally-modified host tree — verify against pristine upstream (or a clean snapshot) or the verification is circular.

**Current web configuration face (n6)**: the advisor's web configuration surface is now the "插件配置" (plugin config) page card — the standalone `settings.section` entry was removed and the plugin registers a `settings.plugin.item` card (id `advisor`, order 30) instead, keeping the n5 GatewayService channel (item 0) for reads and writes. The allowlist boundary statement above stays accurate: the `advisor` namespace remains off both `WEB_SETTINGS_NAMESPACES` and `PRODUCT_SETTINGS_NAMESPACES`, the client settings scope still answers `settings-not-exposed`, and no host change is involved. The card-surface recipe is documented in `{KNOWLEDGE_DIR}/architecture-patterns/dsh-plugin-config-card-surface.md`.

## When to Apply

- Before promising a writable web Settings page for ANY third-party dsh plugin namespace: use the `GatewayService` + `@Remote` channel (item 0) — upstream dsh provides no registration-level exposure opt-in, but the gateway channel is NOT allowlist-gated.
- When diagnosing a rendered-but-never-saving Settings section.
- When deciding whether a host change is needed for a third-party feature: none is applied or required — the gateway channel and plugin config row cover both paths.

## Examples

- The `advisor` settings namespace: registered plainly (no opt-in, no host change); AdvisorConfigGateway (GatewayService, @Remote get/set) claims the advisor/get + advisor/set endpoints through the host's typertGateway; the web section reads/writes through connection.rpc.call on those endpoints — E2E-verified (get returns the composed config, set writes the user layer, unknown keys rejected, settings.describe still omits the namespace because the apiproxy allowlist is untouched — expected). The former plugin-shipped host patch (patch directory + scripts + host-patch tests) was retired, and the locally-edited staging worktree (which had carried the uncommitted exposeToWebClients implementation) was reverted to pristine.
