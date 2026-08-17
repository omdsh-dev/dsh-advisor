---
module: dsh plugin TUI client surface (dsh-tui)
date: 2026-08-16
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
title: Adding a plugin client surface to the dsh-TUI terminal front door (tuiCommandTrees + tuiSettingsSections + session-less config readback)
description: Verified pattern for surfacing a standalone dsh plugin inside the dsh-TUI terminal front end with zero dsh-TUI changes — bundle composition into the dsh-tui profile, DSH command-registry auto-merge into the TUI / menu, the plugin-facing tuiCommandTrees seam (register a TuiCommandTreeProvider for localized descriptions + subcommand completion), the tuiSettingsSections write seam (dsh-tui >= v0.8.0 /settings screen: register a TuiSettingsSection over your settings namespace; staged edits persist through revision-fenced in-process settings.mutate — no apiproxy allowlist gate), and the session-less config-readback parity rule (a readback command must resolve the composed config exactly like the web gateway — never the per-session override).
last_updated: 2026-08-17
tags:
  - dsh
  - plugin
  - dsh-tui
  - client
  - settings
---

# Adding a plugin client surface to the dsh-TUI terminal front door

## Context

dsh-TUI (`@deepseek-harness-tui/dsh-tui`, profile `dsh-tui`, launcher `bin/dsh-tui.js` self-bootstraps `dsh --profile dsh-tui add @deepseek-harness-tui/dsh-tui@<ver>` then spawns `dsh --profile dsh-tui`) is a terminal-only Ink/TUI front door over dsh-base. It renders NO web client bundles and NO typert gateway, but since **v0.8.0** it ships a `/settings` screen with a plugin settings-section extension seam (`tuiSettingsSections`). Verified against source @ dsh-TUI **v0.8.0** (tag `9ac578f1`, release PR #253; commit `02ff08e` on `main` — the seam file is identical between the tag and that commit). The pre-v0.8.0 no-settings-page surface (n8 pin @ `557a27a`, 2026-08-16) is **superseded**: plugin settings are now editable in the TUI, not only via namespace + profile patch + global `$DSH_HOME/settings.yaml` + a readback command.

The dsh-advisor plugin (a per-session reviewer) needed a first-class TUI surface: commands discoverable in the `/` menu, a settings readback, and — from n9 on — an editable Advisor section in the TUI `/settings` screen, without modifying the dsh-TUI repo and without adding a dependency on it.

## Guidance

### 1. Bundle composition needs zero dsh-TUI changes

`dsh plugin --profile dsh-tui add <pkg>` reads the package's `dsh.bundle.patch` (package.json `dsh` → `cordis.patch.yml`), appends its `- insert:` rows as a composition layer (dsh-base → bundles → bundle patches → user patch layer `~/.dsh/profiles/dsh-tui/cordis.patch.yml`). The advisor's `- insert: id: advisor` row lands in the profile with no host edits. `dsh --profile dsh-tui --dump-config` shows the row (composition-only, works even when the full plugin-tree boot is broken).

### 2. Commands auto-surface in the TUI `/` menu

The TUI merges the DSH command registry into its `/` menu (`refreshCommandList` in `src/dsh-adapter/channel.ts`: `commandService.list(target)` → merged rows; dispatch via `commandService.execute`). A plugin's registry commands (`ctx.inject(['commands'], ...)`) appear automatically. The row's `tag` comes from `CommandDefinition.input.hint` — keep it in sync when adding subcommands.

### 3. The plugin-facing command seam is `tuiCommandTrees`

`ctx.tuiCommandTrees` (cordis Service, row `dsh-tui-command-trees` — shipped in the dsh-tui bundle) lets plugins register:

```ts
interface TuiCommandTreeProvider {
  root: string                       // '^[a-z][a-z0-9_-]*$'; duplicate root throws
  descriptions?: LocalizedDescriptions  // Readonly<Partial<Record<'zh'|'en', string>>>
  children(canonicalPath: readonly string[]): readonly CommandCompletionNode[]  // root at index 0
}
interface CommandCompletionNode {
  name: string; aliases?: readonly string[]; description: string
  descriptions?: LocalizedDescriptions; tag?: string; descriptionKey?: string
}
```

`descriptions(root)` overrides the root row's description; `children` drives `/` overlay completion (leaves return `[]` — the TUI asks at depth 2). **Do NOT add `@deepseek-harness-tui/dsh-tui` as a dependency** — the shapes are small and structural; replicate them locally (zero new peers). The cordis Context lacks the `tuiCommandTrees` augmentation outside dsh-TUI — use a structural cast with a conditional `ctx.inject(['tuiCommandTrees'], ...)` (absent service → clean no-op, same pattern as settings/typert/commands children). Register behind any single-instance claim (the advisor's `claimReviewer()`) and defensively catch duplicate-root ('already registered' → debug log + no-op disposer) — the multi-fiber composition that affects sibling optional registrations applies here too.

### 4. The TUI settings screen + plugin seam (`tuiSettingsSections`)

Since v0.8.0 (upstream issue ccch1mneyyy/dsh-TUI#165, PR #238) the TUI has a `/settings` screen. Optional plugins declare WHAT is editable there by registering a SECTION over their settings namespace on the `tuiSettingsSections` host service — mirroring the web front door's `settings.plugin.item` slot (plugins ship sections; the host ships the chrome). Storage, validation and layering stay with the dsh settings service; the registry is display metadata only.

**The seam.** `TuiSettingsSectionsRuntime` is a cordis Service — key `tuiSettingsSections`, row `dsh-tui-settings-sections` (cordis.yml row `name: '@deepseek-harness-tui/dsh-tui/settings-sections'`, module `src/dsh-adapter/settings-sections.ts` in dsh-TUI). `register(section)` returns a disposer, trims + validates the namespace against `^[a-z][a-z0-9_-]*$` (invalid → `TypeError`), throws on a duplicate ns (`TUI settings section "X" is already registered`), and emits to subscribers — an open screen re-reads the section list when a plugin (un)loads mid-session.

**The contract.** `TuiSettingsSection = { ns, title, descriptions?, fields }`; `TuiSettingsField = { path: readonly string[], label, descriptions?, hint?, hintDescriptions?, kind: 'text'|'number'|'boolean'|'select', options?, placeholder?, secret?, format?, parse? }`. `path` uses the settings-service `mutate` path vocabulary (object keys; dict keys name their entry directly) — the advisor's flat §5.1 keys map 1:1 as single-element paths. `secret?: { ref }` is a credential control (mirrors the web cards' CardSecretSpec): the literal never rides the settings document — the draft starts blank on every open, a blank draft writes nothing, a typed draft writes through the credentials seam, and the screen shows only whether a value is configured. `format`/`parse` default per kind (text verbatim, number via `String`/`Number`, boolean `'true'`/`'false'`, select by option value); **default parse semantics**: an empty text/number draft stages a clear → the field re-inherits the composition layer; a draft `parse` cannot convert (non-finite number, unknown select option) is `invalid` → blocks the whole save. The screen marks a section **unavailable** when the composition serves no such namespace, and namespaces render **read-only** when the settings/credentials seams are absent (bare cordis.yml start).

**The write path.** The screen (`src/screens/Settings.tsx` + `src/dsh-adapter/settingsEditor.ts`) stages edits and writes ONLY on save: `channel.settingsHost().write(ns, ops, expectedRevision)` → in-process `settings.mutate(ns, ops, expectedRevision)` on the section's namespace (ops = `{op:'set'|'unset', path, value?}`; one retry on a stale-revision `SETTINGS_CONFLICT`). This write path has **no apiproxy `exposedNamespaces()` allowlist gate** — that gate lives only in the web wire; in-process `ctx.settings` is the same service the gateway's `set` uses. A section is therefore fully writable whenever the plugin's namespace is registered on the settings service (the advisor's `advisor` namespace is, via `installAdvisorSettings`).

**No cross-field validation (recorded upstream behavior, not a defect).** The seam parses fields individually, so a save may set `enabled: true` with empty `provider`/`model`. The web card blocks that save (`enabled` + empty-required gate); the TUI does not — the advisor's S4 explicit model gate resolves such a config to disabled-with-reason at runtime (visible via `/advisor status` + `/advisor config`).

**Schema re-validation backstop.** The settings service re-resolves the merged candidate through the namespace's registered schema at the front of the namespace write queue BEFORE persist — a value the schema rejects (e.g. `immuneTurns: 2.5` / `-1`, pinned by `tests/config.test.ts`) fails the WHOLE save with nothing stored, surfaced by the TUI as the `settings-save-failed` notice (live QA in a dsh-tui v0.8.0 profile verified: the rejected mutate leaves the revision and `settings.yaml` unchanged). The TUI default parse already keeps drafts schema-shaped, so this is a backstop, not the primary UX.

### 5. Session-less config readback parity (correctness rule)

A settings-readback command MUST read the composed config exactly like the web gateway (`/api/advisor/get`): resolve the bridge source through the shared resolver (`resolveAdvisorConfig`), with **no session context**. Never route the readback through the per-session effective config (`effectiveConfig`/`safeEffective`) — those bake the `/advisor off` session toggle into `enabled`, so a user who turns the advisor off for the session would see the readback misreport the persisted settings (web-vs-TUI divergence). Runtime state (on/off, pending, last activity) stays in the status command; config state stays in the config command. Containment: when the resolver throws on a rejected settings user layer, seed the readback's scalar latches from the RAW source (`raw?.immuneTurns ?? 3`, ...) — mirroring the gateway's S1 fallback — so both front ends report the same values.

The `/advisor config` edit hint is now truthful about the write surface: when the `tuiSettingsSections` seam is mounted it lists the TUI `/settings` screen (Advisor section, dsh-tui ≥ v0.8.0) FIRST, then the profile patch layer + `$DSH_HOME/settings.yaml`. The probe is a LIVE `ctx.get('tuiSettingsSections') !== undefined` at render time (the seam supports mid-session mount/unmount via `subscribe()`, so a captured boolean would go stale), keyed on the shared `TUI_SETTINGS_SECTIONS` constant — the same key the registration condition uses, so the two cannot drift apart. It is an environment signal only, never derived from the per-session override, and does not change the resolved-config read.

## Why This Matters

- A terminal front door and a web front door share one config SSOT; readback parity prevents "the TUI says 3, the web card says 5" confusion for the same settings.yaml.
- The plugin-facing TUI surface is now TWO seams: `tuiCommandTrees` (commands + completion) and `tuiSettingsSections` (settings write). The post-#165 write surface is implemented — future TUI work starts from the implemented contracts instead of re-deriving them from the host source.
- Zero new peers keeps the plugin's dependency contract intact (mount-only, public-registry peers only).
- The schema re-validation backstop means a section registration can never write non-schema junk into the settings user layer, even though the TUI does no cross-field validation.

## When to Apply

- Adding or maintaining ANY plugin surface in a dsh-TUI profile (commands, completion, settings readback, settings write).
- Making a plugin's settings editable in the TUI `/settings` screen (dsh-tui ≥ v0.8.0): register a `TuiSettingsSection` over the plugin's EXISTING settings namespace on `tuiSettingsSections`. Reuse the same composed-config resolver + namespace as the web gateway/readback — the section is display metadata over the namespace; a save lands in the same user layer the web card writes.

## Examples

- dsh-advisor iter-20260816-n8: `src/tui.ts` (structural `TuiCommandTreeProvider` for `/advisor` with zh/en descriptions + on|off|status|config completion), `src/commands.ts` + `src/index.ts` (`/advisor config` — `AdvisorComposedConfig` built from `safeResolved()`, session-less; `safeFallback` seeds scalars from the raw source; `input.hint` `'[on|off|status|config]'`), README dsh-tui profile section, `dsh --profile dsh-tui` live QA (dump-config + PTY boot + `/advisor status|config` rendering).
- dsh-advisor iter-20260817-n9 (plan dsh-advisor-tui-settings-n9): `src/tui-settings.ts` — structural `TuiSettingsSection`/`TuiSettingsField` type copies (no `@deepseek-harness-tui/dsh-tui` peer), `installTuiSettingsSection` registers the Advisor section via conditional `ctx.inject(['tuiSettingsSections'])` (absent service → no-op), duplicate-ns containment (debug log + no-op disposer), reviewer-claim gating (called after `claimReviewer()`, next to `installTuiClient`), and the shared `TUI_SETTINGS_SECTIONS` service-key constant driving BOTH the registration condition and the `/advisor config` hint probe. The section covers the five safe §5.1 keys (enabled/provider/model/immuneTurns/maxDeltaMessages); `systemPrompt` is intentionally excluded — the TUI `text` control is single-line and would truncate/replace a multi-line prompt, so it stays editable via the web card or `$DSH_HOME/settings.yaml`. Unit tests (`tests/tui-settings.test.ts`) pin the registration contract, no-op, duplicate containment, claim gating, and field-path ↔ §5.1 schema alignment; QA ran in a real dsh-tui v0.8.0 session (mutate + schema-rejection probes: `immuneTurns: 2.5` / `-1` fail the whole save with revision + file unchanged; a stale expectedRevision → `SettingsConflictError`).
