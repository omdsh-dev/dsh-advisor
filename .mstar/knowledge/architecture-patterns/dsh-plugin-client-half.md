---
module: dsh plugin client half (web Settings integration)
date: 2026-08-10
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
title: Adding a dsh web Settings section to a standalone plugin (client half contract)
description: Verified recipe for a standalone dsh plugin's browser half: dshClient declaration, closure-factory CJS bundle served from /plugins/<id>/client.js, settings.section slot registration, and the frozen externals/purity/JSX contracts — plus the host-side settings namespace wiring it edits.
plan_id: dsh-advisor-settings-n2
tags:
  - dsh
  - plugin
  - client-half
  - settings
  - web
  - bundle
  - closure-factory
applies_when:
  - A standalone dsh plugin needs to appear in the dsh web Settings panel
  - Shipping any browser UI from a third-party dsh plugin bundle
  - Debugging client bundle load failures in the web shell (boot graph / served bundle)
---

# dsh plugin client half (web Settings section)

## Context

The dsh web shell loads a **client half** from plugin bundles: any loader entry whose package.json declares `dshClient` gets scanned by `ClientModuleHostService`, composed into the window boot manifest (`__DSH_BOOT__` is injected by the shell), and its bundle served at `/plugins/<id>/client.js`. The client half is a cordis client plugin (runs in the browser) that registers UI into shell slots (e.g. the `settings.section` slot → a new Settings panel section). Host-side, the plugin registers a settings namespace (`installSettingsSection`) whose user layer the section edits.

## Guidance

### Package declaration

- `package.json`: a dshClient declaration naming the runtime/ui-settings/locale client packages with platform web (mirror ui-models verbatim — the package-level inject edges name boot dependencies; the plugin's cordis `inject` is separate: `['slots','locale','connection']`).
- the package client export subpath maps to lib/client.js with a flat re-export d.ts; the files array must include the lib directory (covering client.js and client.d.ts).

### Bundle contract (KD-S5, verified)

- **Closure-factory CJS**: the bundle registers itself via the module loader's load handoff (id = package name, factory = require-based closure). No ESM statements, no import.meta at top level of the emitted file.
- **Externals = the frozen CLIENT_EXTERNALS table** (from the dsh-private web platform module + the documented exemption): react, react/jsx-runtime, react-dom, react-dom/client, cordis, the ui-slots/web-react/ui-primitives/schema-form client packages, and the runtime client subpath. **There is NO peer auto-externalization** — anything else `@deepseek-ai/*` in client code must be **type-only import** (erased at build); values come via cordis inject. the connection, locale, and ui-settings client subpaths are type-only (`import type {}` for SlotMap/Context merges).
- **Purity gate**: value imports of any other `@deepseek-ai/*` are build errors (cross-plugin collaboration goes through cordis services, never shared module instances).
- **JSX: automatic runtime** (jsx automatic in esbuild) — the classic transform emits a free `React` global the loader never provides → `ReferenceError: React is not defined` at first render. react/jsx-runtime is in the table precisely for this; assert the bundle requires it when any tsx file is present.
- NODE_ENV and import.meta.env.MODE defines; sourcemap optional.
- Build tool: esbuild works (explicit devDep); dsh-private uses tsdown with the same table. In-script + test assertions: file exists, contains `window.__ModuleLoader__.load`, id matches, requires ⊆ externals, no import.meta statement.

### Client plugin entry (`src/client/index.ts`)

Mirror `ui-models`: `inject = ['slots','locale','connection']`; `ctx.effect(() => ctx.locale.register(NS, { zh, en }))`; `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: '<section-id>', order: 20, label: () => t('nav'), inject: injected }, SectionComponent))`. Store via `createSnapshotStore` + `bindSnapshotSelector`; refresh on settings-changed and models-changed frames (coalesce with a microtask debounce).

### Settings section data flow

- Provider options = **configured providers only** (mirror ui-models join: `llm.providers({})` directory + `settings.describe({})` namespaces; configured = profile resolves at `settingsPath`).
- Model options = provider profile's `models` first, fallback `llm.models({})` catalog groups; both empty → empty + guidance, **no free-text input**.
- Writes: `settings.mutate({ ns, ops: [{op:'set'|'unset', path, value}], expectedRevision })` against the section's own namespace user layer (base = plugin-row config via `installSettingsSection`). Handle `settings-conflict` (re-sync) and `settings-not-exposed` (distinct copy).
- **Required-when-enabled is client-side only**: the host hard gate stays the SSOT (enabled without provider/model → disabled-with-reason, never a model call).

## Why This Matters

The web shell's module table is the ONLY resolver for client bundles: externals not in the frozen table, free `React` globals, or value imports of sibling client packages all fail at runtime in ways unit tests don't catch (the vm factory probe executes the factory but never renders). The boot graph + served bundle + factory execution is the install-time verification; real rendering is a browser-level QA step.

## When to Apply

Any standalone plugin shipping browser UI into dsh web. Reference implementations: dsh-advisor (this repo, src/client/), dsh-private ui-models, and the mstar harness dsh bundle (workflow panel).

## Examples

- `dsh-advisor` n2: `scripts/build-client.mjs` (esbuild closure factory), `src/client/index.ts` (settings.section id `advisor`), verified via scratch `dsh web` boot (boot graph row, served bundle, vm factory execution).
