---
module: dsh plugin TUI client surface (dsh-tui)
date: 2026-08-16
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
title: Adding a plugin client surface to the dsh-TUI terminal front door (tuiCommandTrees + session-less config readback)
description: Verified pattern for surfacing a standalone dsh plugin inside the dsh-TUI terminal front end with zero dsh-TUI changes — bundle composition into the dsh-tui profile, DSH command-registry auto-merge into the TUI / menu, the plugin-facing tuiCommandTrees seam (register a TuiCommandTreeProvider for localized descriptions + subcommand completion), the no-settings-page constraint (settings = settings namespace + profile patch + global $DSH_HOME/settings.yaml), and the session-less config-readback parity rule (a readback command must resolve the composed config exactly like the web gateway — never the per-session override).
last_updated: 2026-08-16
tags:
  - dsh
  - plugin
  - dsh-tui
  - client
---

# Adding a plugin client surface to the dsh-TUI terminal front door

## Context

dsh-TUI (`@deepseek-harness-tui/dsh-tui`, profile `dsh-tui`, launcher `bin/dsh-tui.js` self-bootstraps `dsh --profile dsh-tui add @deepseek-harness-tui/dsh-tui@<ver>` then spawns `dsh --profile dsh-tui`) is a terminal-only Ink/TUI front door over dsh-base. It renders NO web client bundles, has NO settings page, NO typert gateway, and NO generic plugin settings UI. Verified against source @ 557a27a (2026-08-16).

The dsh-advisor plugin (a per-session reviewer) needed a first-class TUI surface: commands discoverable in the `/` menu + a settings readback, without modifying the dsh-TUI repo and without adding a dependency on it.

## Guidance

### 1. Bundle composition needs zero dsh-TUI changes

`dsh plugin --profile dsh-tui add <pkg>` reads the package's `dsh.bundle.patch` (package.json `dsh` → `cordis.patch.yml`), appends its `- insert:` rows as a composition layer (dsh-base → bundles → bundle patches → user patch layer `~/.dsh/profiles/dsh-tui/cordis.patch.yml`). The advisor's `- insert: id: advisor` row lands in the profile with no host edits. `dsh --profile dsh-tui --dump-config` shows the row (composition-only, works even when the full plugin-tree boot is broken).

### 2. Commands auto-surface in the TUI `/` menu

The TUI merges the DSH command registry into its `/` menu (`refreshCommandList` in `src/dsh-adapter/channel.ts`: `commandService.list(target)` → merged rows; dispatch via `commandService.execute`). A plugin's registry commands (`ctx.inject(['commands'], ...)`) appear automatically. The row's `tag` comes from `CommandDefinition.input.hint` — keep it in sync when adding subcommands.

### 3. The plugin-facing TUI seam is `tuiCommandTrees`

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

### 4. The TUI has no settings page — settings surface = namespace + readback + docs

No plugin settings UI seam exists (filed upstream: ccch1mneyyy/dsh-TUI#165). The working surface is:
- the plugin's settings namespace (registers via the dsh settings service; reads the same live composed config),
- operator edit paths: profile patch layer (`~/.dsh/profiles/dsh-tui/cordis.patch.yml`) + the GLOBAL `$DSH_HOME/settings.yaml` (shared across ALL profiles — the web Settings card writes the same user layer),
- a read-only readback command (`/advisor config`) rendering the composed config + edit hints.

### 5. Session-less config readback parity (correctness rule)

A settings-readback command MUST read the composed config exactly like the web gateway (`/api/advisor/get`): resolve the bridge source through the shared resolver (`resolveAdvisorConfig`), with **no session context**. Never route the readback through the per-session effective config (`effectiveConfig`/`safeEffective`) — those bake the `/advisor off` session toggle into `enabled`, so a user who turns the advisor off for the session would see the readback misreport the persisted settings (web-vs-TUI divergence). Runtime state (on/off, pending, last activity) stays in the status command; config state stays in the config command. Containment: when the resolver throws on a rejected settings user layer, seed the readback's scalar latches from the RAW source (`raw?.immuneTurns ?? 3`, ...) — mirroring the gateway's S1 fallback — so both front ends report the same values.

## Why This Matters

- A terminal front door and a web front door share one config SSOT; readback parity prevents "the TUI says 3, the web card says 5" confusion for the same settings.yaml.
- The `tuiCommandTrees` seam is the entire plugin-facing UI surface of dsh-TUI today — knowing it means future TUI work (e.g. the post-#165 write surface) starts from the right contract instead of re-deriving it from the host source.
- Zero new peers keeps the plugin's dependency contract intact (mount-only, public-registry peers only).

## When to Apply

- Adding or maintaining ANY plugin surface in a dsh-TUI profile (commands, completion, settings readback).
- The upstream settings-seam work (ccch1mneyyy/dsh-TUI#165): when dsh-TUI gains a settings UI, the advisor's TUI write surface should reuse the same composed-config resolver + namespace, adding a write path on top of this readback.

## Examples

- dsh-advisor iter-20260816-n8: `src/tui.ts` (structural TuiCommandTreeProvider for `/advisor` with zh/en descriptions + on|off|status|config completion), `src/commands.ts` + `src/index.ts` (`/advisor config` — `AdvisorComposedConfig` built from `safeResolved()`, session-less; `safeFallback` seeds scalars from the raw source; `input.hint` `'[on|off|status|config]'`), README dsh-tui profile section, `dsh --profile dsh-tui` live QA (dump-config + PTY boot + `/advisor status|config` rendering).
