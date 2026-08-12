---
module: dsh web plugin configuration card surface (settings.plugin.item slot)
date: 2026-08-12
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
title: Registering a plugin configuration card on the dsh web "插件配置" settings page
description: Verified recipe for a standalone dsh plugin's web configuration card on the "插件配置" (plugin config) settings page: the shell-declared `settings.plugin.item` card slot (declared by the ui-plugin-config `settings.section` id 'plugins'), the generator + yield registration shape with locale / business-only inject faces, the PropsRuntime + PropsLocale + InjectFace component contract, the type-only peer dependency that merges the SlotMap, the load-on-mount invariant, the two data-channel routes (allowlisted settings scope vs GatewayService RPC), and the build/test discipline that pins card CSS fragments. The advisor's current configuration surface — supersedes the settings.section recipe (C1 gateway card, iteration iter-20260811-dsh-advisor-n6).
tags:
  - dsh
  - plugin
  - client-half
  - plugin-config
  - settings
  - card
  - slot
  - gateway
applies_when:
  - A third-party dsh plugin needs a configuration surface on the web "插件配置" page
  - Choosing the data channel: allowlisted settings scope vs GatewayService RPC
  - Migrating an existing settings.section entry into a plugin-config card
plan_id: dsh-advisor-plugin-config-card
iteration_ref: iter-20260811-dsh-advisor-n6
source: iteration:iter-20260811-dsh-advisor-n6/guides/plugin-config-migration.md
related_components:
  - dsh web shell
  - host apiproxy allowlist
  - GatewayService RPC channel
---

# dsh web plugin configuration card surface (settings.plugin.item)

## Context

The dsh web settings page has a "插件配置" (plugin config) section: a `settings.section` entry with id `plugins`, registered by the @deepseek-ai/dsh-client-ui-plugin-config browser package (ui-plugin-config). That section declares a single child slot, `settings.plugin.item` (kind `list`, scope `root`), and renders the registered cards stacked by `order`; with zero cards registered it renders an empty-line placeholder. Any browser-half plugin can register a card — the section neither knows nor cares which plugin owns a card, and it supplies deliberately empty owner props (`children?: never`): the card draws its own internals.

The card surface is orthogonal to the settings exposure boundary. The host apiproxy exposes only allowlisted namespaces to the client settings scope — `WEB_SETTINGS_NAMESPACES` plus `PRODUCT_SETTINGS_NAMESPACES` (and the settingsNs of configurable model providers) — and a namespace absent from both answers `settings-not-exposed` on describe/mutate/update. A card whose data channel is the settings scope must therefore bind an allowlisted namespace; a card whose namespace is off the allowlist must use a different channel (the GatewayService route below).

## Guidance

### Card registration shape (generator + yield)

Registration mirrors the upstream cards verbatim:

```ts
ctx.slots.inject('settings.plugin.item', function* () {
  yield ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'advisor',
    order: 30, // bash 0 / agent-loop 10 / web-search 20 / advisor 30
    locale: NS, // the card's own dictionary namespace, e.g. 'settings.advisor'
    inject: () => ({ controller, useSnapshot }), // business face ONLY
  }, AdvisorCard)
})
```

- The generator + `yield` form is the required shape (every upstream card uses it). The card carries no nav label: nav identity is a `settings.section` registration option (`id` / `order` / `label`), and the plugin-config card is not a nav entry — it renders inside the 插件配置 section. Deleting a `settings.section` registration deletes its sidebar entry, which is how a standalone section is removed.
- `locale: NS` declares the card's dictionary namespace; the renderer synthesizes the typed `t` seat on the component props (`PropsLocale<NS>`, typed to the namespace's dictionary union). `t` is NOT part of the inject face — the inject face carries only the business surface (controllers, snapshot hooks).

### Card component contract

```ts
type AdvisorCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.advisor'>
  & InjectFace<AdvisorCardInjected>
```

- The card root is an `<li>` (the section renders a `<ul>` of cards).
- The card draws its own chrome — title, description, fields, save/discard — because the section's owner props are empty and the upstream plugin-config client value face exports no reusable card components (no PluginCard / ValueField value exports). Build the chrome in the plugin's own design language (`--dsw-alias-*` tokens, light/dark adaptive).
- `cardCount` is read once: the section injects `ctx.slots.entries('settings.plugin.item').length` at registration and the renderer caches the root inject face, so the count reflects registration at section mount, not live cards. It only drives the empty-line placeholder; card rendering is driven by the slot ledger, so a card registering after the section still renders.

### Type contract: peer-only, type-only

- Merging the slot's SlotMap entry is a type-only import:

```ts
import type {} from '@deepseek-ai/dsh-client-ui-plugin-config/client'
```

  The package's ./client type entry re-exports the slot-contract `declare module` merge, so `ctx.slots.register` accepts `settings.plugin.item`. Type-only imports are erased by the esbuild TS loader before resolution — they never reach CLIENT_EXTERNALS or the bundle purity gate.
- The package is a peer-only dependency (peerDependencies, never devDependencies): the repo's dsh-links contract asserts every `@deepseek-ai/*` entry appears only in peerDependencies (`tests/dsh-links.test.ts`); dev-time resolution comes from the link farm under `$DSH_SOURCE_DIR` (`scripts/setup-dsh-links.mjs`, whose `requiredPeers()` picks new peers up automatically).

### Load-on-mount invariant

Cards mount lazily (the settings panel mounts the section only when the user opens it), so the first mount triggers the first load:

```
if (state.status === 'idle') void controller.load()
```

- Loop guard: `load()` must flip status synchronously (idle → loading) before its first await. The re-render then reads 'loading' and the idle branch stops firing — no loop — and a StrictMode double render sees the already-flipped snapshot (no duplicate fetch). Do not restructure into a `useEffect` with `[]` deps: that would refetch on every remount, changing the load-once semantics.
- Background invalidations must not fetch an unopened card: guard the refetch with `refreshIfLoaded` (idle-guard).

### Two data-channel routes

**Route A — settings-scope-backed card** (namespace IS on the allowlist). The card binds via `ctx.settingsScope.bind({ namespace })` and reads/writes through the settings wire. It gains the full settings UX: staged edits (edit / resetField / save / discard), the revision fence (`expectedRevision` — a stale writer is refused as `settings-conflict`), write-failure recovery read, and per-field `overridden` badges (user-layer key presence, not value comparison).

**Route B — gateway-backed card (C1)** (namespace NOT on the allowlist; the client settings scope answers `settings-not-exposed`). Keep the wire OUT of the apiproxy boundary entirely: the plugin registers a `GatewayService` subclass whose `@Remote` get/set methods become `/api/<namespace>/<method>` endpoints, claimed by the host's typertGateway (the single `/api` RPC interceptor — SRC discovery claims endpoints from any registered service, plugin fibers included); the card reads/writes via `connection.rpc.call` on the /api interceptor with the endpoint slash form (two slash segments, not the dot form). The in-process settings write inside the `@Remote` set body carries no exposed-namespace check — the allowlist gate lives only in the apiproxy wire layer, not in the Settings service.

- Trade-offs: Route B gives up the per-field `overridden` badge, true unset, and the revision fence (C1); they arrive with Route A (C2), which requires the namespace allowlisted upstream. Route B's upstream immunity is high: it depends only on the slot name string and the empty owner props, so upstream settings refactors do not break it.
- Decide: allowlisted namespace → Route A for the full UX; otherwise → Route B, zero host changes (no patch, no fork, no staging edits).

### Build discipline (CSS fragments)

The client CSS-modules inline injection is pinned by hardcoded fragment assertions in both `scripts/build-client.mjs` (tagId fragments) and `tests/client-build.test.ts` (tagId + class regexes). Renaming or removing a module css file (e.g. section → card) must update those assertions in the SAME commit, or the build gate fails. The classMap emit is sorted by local name for byte-deterministic bundles (lightningcss insertion order is nondeterministic); the sort keeps consecutive builds byte-stable.

## Why This Matters

The 插件配置 page is the current, upstream-blessed configuration surface for plugins. The standalone `settings.section` recipe couples UI presence, nav identity, and the settings wire to the apiproxy allowlist, which third-party namespaces cannot join without host changes. The card surface decouples UI presence (pure client-side slot registration) from data access (channel choice), so a third-party plugin can ship a real configuration page card with zero host changes — the same posture that retired the host-patch mechanism.

## When to Apply

- Any dsh plugin shipping a web configuration surface: prefer a plugin-config card over a new standalone `settings.section`.
- Choosing the data channel: namespace allowlisted → settings scope; otherwise → GatewayService RPC (C1).
- Migrating an existing `settings.section`: remove the section registration (the sidebar nav disappears with it), register the card, keep the data channel and store.

## Examples

- The dsh-advisor card (iteration iter-20260811-dsh-advisor-n6): registration in `src/client/index.ts`, component in `src/client/advisor-card.tsx` (props contract above, root `<li>`). The card (id `advisor`, order 30) renders after the upstream bash / agent-loop / web-search cards on the 插件配置 page; the data channel is the n5 GatewayService endpoints `/api/advisor/get` + `/api/advisor/set` (store `src/client/advisor-store.ts` unchanged from the section era); the old standalone `settings.section` entry (the sidebar "Advisor" nav) was removed. Verified live: card order, six-key read/write round-trip with reload consistency, degradation notice when the gateway is unreachable, and pre-migration config compatibility.
