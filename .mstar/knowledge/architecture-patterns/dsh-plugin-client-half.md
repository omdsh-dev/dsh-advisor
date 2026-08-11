---
module: dsh plugin client half (web Settings integration)
date: 2026-08-11
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
title: Adding a dsh web Settings section to a standalone plugin (client half contract)
description: Verified recipe for a standalone dsh plugin's browser half: the dsh.client declaration (nested under dsh, post-20da39e), closure-factory CJS bundle served from /plugins/<id>/client.js, CSS-modules inline injection with style-tag lifecycle, settings.section slot registration, and the frozen externals/purity/JSX contracts — plus the host-side settings namespace wiring it edits.
plan_id: dsh-advisor-settings-ui-n3
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

The dsh web shell loads a **client half** from plugin bundles: any loader entry whose package.json declares a `client` key nested under `dsh` gets scanned by `ClientModuleHostService`, composed into the window boot manifest (`__DSH_BOOT__` is injected by the shell), and its bundle served at `/plugins/<id>/client.js`. The client half is a cordis client plugin (runs in the browser) that registers UI into shell slots (e.g. the `settings.section` slot → a new Settings panel section). Host-side, the plugin registers a settings namespace (`installSettingsSection`) whose user layer the section edits.

## Guidance

### Package declaration

- `package.json`: the declaration lives **nested under `dsh`** — `"dsh": { "client": { "inject": [...], "platform": "web" } }` — naming the runtime/ui-settings/locale client packages with platform web (mirror ui-models verbatim — the package-level inject edges name boot dependencies; the plugin's cordis `inject` is separate: `['slots','locale','connection']`). The `dsh` object may also carry the `bundle` patch key (plugin profile patch) — keep both.
- **The legacy top-level `dshClient` field is gone upstream (snapshot 20da39e)**: `ClientModuleHostService` reads `pkg.dsh.client` only, with NO `dshClient` fallback — a package declaring only the legacy field is silently not registered. Migrate on any upstream bump, and pin it with a regression assertion (that the legacy `dshClient` field is `undefined`).
- **Negative verdicts are cached until restart**: adding/renaming the declaration takes effect only after a `dsh web` restart (boot-graph row re-check after restart is the verification).
- the package client export subpath maps to lib/client.js with a flat re-export d.ts; the files array must include the lib directory (covering client.js and client.d.ts).

### Bundle contract (KD-S5, verified)

- **Closure-factory CJS**: the bundle registers itself via the module loader's load handoff (id = package name, factory = require-based closure). No ESM statements, no import.meta at top level of the emitted file.
- **Externals = the frozen CLIENT_EXTERNALS table** (from the dsh-private web platform module + the documented exemption): react, react/jsx-runtime, react-dom, react-dom/client, cordis, the ui-slots/web-react/ui-primitives/schema-form client packages, and the runtime client subpath. **There is NO peer auto-externalization** — anything else `@deepseek-ai/*` in client code must be **type-only import** (erased at build); values come via cordis inject. the connection, locale, and ui-settings client subpaths are type-only (`import type {}` for SlotMap/Context merges).
- **Purity gate**: value imports of any other `@deepseek-ai/*` are build errors (cross-plugin collaboration goes through cordis services, never shared module instances).
- **JSX: automatic runtime** (jsx automatic in esbuild) — the classic transform emits a free `React` global the loader never provides → `ReferenceError: React is not defined` at first render. react/jsx-runtime is in the table precisely for this; assert the bundle requires it when any tsx file is present.
- NODE_ENV and import.meta.env.MODE defines; sourcemap optional.
- Build tool: esbuild works (explicit devDep); dsh-private uses tsdown with the same table. In-script + test assertions: file exists, contains `window.__ModuleLoader__.load`, id matches, requires ⊆ externals, no import.meta statement.

### CSS Modules inline injection (styling a section with the web design language)

To style a section with the shell's design language (CSS modules + `--dsw-alias-*` tokens), the client build compiles `*.module.css` inline (mirror of the dsh tsdown preset's `dsh-css-modules-inline`):

- **Mechanism**: esbuild `onResolve` rewrites `*.module.css` imports to a virtual id (a `\0dsh-css:` prefix with the absolute path and a .mjs suffix, with `namespace` set — esbuild requires a namespace for non-file paths); `onLoad` compiles the file with **lightningcss** (`cssModules: { pattern: '[hash]_[local]' }`, minify) and emits a JS module whose default export is the hashed class map, plus an **idempotent `<style data-plugin>` injection** carrying a `data-plugin-css` value of the load id plus the module basename guarded by `document.querySelector('style[data-plugin-css=…]') === null` + `document.head.appendChild`. `watchFiles: [fileId]` mirrors the preset's `addWatchFile` (needed for any future watch mode).
- **Loader lifecycle**: the web loader cleans up plugin-owned tags by `style[data-plugin=<id>]` on unload/HMR refresh (`removeOwnedStyles`), so the `data-plugin` attribution must be exactly the load id; the idempotency key (`data-plugin-css`) prevents duplicates within a document lifetime. Pin the `data-plugin` attribution with a build/test assertion — the loader cleanup keys on it.
- **Type side**: `src/client/css-modules.d.ts` (`declare module '*.module.css'` + `declare module '*.css'`, byte-identical to dsh's own convention); `tsconfig.client.json` include `src/client` auto-covers it; the spec program needs it added to `include` explicitly (ambient wildcards apply only when the d.ts is in the program). Vitest's default `css: false` stubs css imports in component specs — no transform config needed.
- **Bundle hygiene**: esbuild stamps the virtual-module id into an output comment (`// dsh-css-modules:\0<abs path>.mjs`), shipping a **raw NUL byte + the builder's absolute path** in the served/tarball artifact. Post-build strip the comment lines and assert `\0`/machine-path absence at both assertion sites (build script + contract test) — `lib/` ships in the tarball.
- Design language: sections style natively (CSS module per section, all colors via `--dsw-alias-*` tokens, light/dark adaptive — never hardcode hex; the one sanctioned literal is the select-chevron data-URI `#81858C` caption gray, shared by both themes, byte-identical to the ModelsSection reference).

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
- `dsh-advisor` n3: migrated the declaration to the nested `client` key under `dsh` (new host contract), added the CSS-modules inline injection + style-tag lifecycle + NUL/path hygiene (F-1..F-3 QC fix wave, commit df7a262), restyled the section with the ModelsSection vocabulary + `--dsw-alias-*` tokens, and verified the boot-graph row + served bundle at runtime after restart.
