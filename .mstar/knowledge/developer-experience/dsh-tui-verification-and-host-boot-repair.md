---
module: dsh host profile boot repair + interactive TUI verification
date: 2026-08-16
problem_type: knowledge
category: developer-experience
severity: medium
title: Repairing a broken dsh profile boot (node-addon-require-builtin binding) and verifying interactive TUI surfaces reliably
description: Two verified lessons from dsh-tui QA. (1) Host repair: when ALL dsh profile boots fail with ERR_MODULE_NOT_FOUND for '@deepseek-ai/cordis-plugin-timer' imported from cordis-plugin-loader, the node-addon-require-builtin platform binding is missing/broken — `--dump-config` still works (composition-only) while the full plugin-tree boot does not; repair by reinstalling the global dsh CLI and relinking the platform binding into the loader's node_modules. (2) Verification: subagent-driven interactive TUI PTY automation is unreliable (Ink full-screen ANSI repaint parsing, keystroke-timing-sensitive completion overlays, async LLM turn + reviewer windows) — the dependable evidence path is dump-config + unit/integration pins + a direct PTY command probe (boot, send commands, capture rendered output).
last_updated: 2026-08-16
tags:
  - dsh
  - dsh-tui
  - qa
  - troubleshooting
---

# Repairing dsh profile boot + verifying interactive TUI surfaces reliably

## Context

QA of the dsh-advisor dsh-tui client surface required a REAL `dsh --profile dsh-tui` session. Four subagent-driven QA attempts failed — two on a host environment issue, two on the flakiness of driving the interactive Ink TUI through a PTY. Both lessons are reusable.

## Lesson 1 — Host boot repair: `node-addon-require-builtin` platform binding

### Symptoms

Every real dsh profile boot (web AND tui) exits 1 immediately:

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): loader entries failed to apply
  [cause]: Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis-plugin-timer'
    imported from .../cordis-plugin-loader/lib/index.js
```

`dsh --profile <p> --dump-config` still exits 0 (composition-only — does not load the full plugin tree). This one symptom hides a HOST issue, not a profile/plugin issue.

### Root cause

`@deepseek-ai/cordis-plugin-loader/lib/index.js` resolves bare specifiers through `node-addon-require-builtin` (a native ESM/CJS loader hook, `requireBuiltin(id)`). The wrapper (`node-addon-require-builtin`) requires `node-addon-native-custom-loader`, which probes for the platform binding package (`node-addon-require-builtin-darwin-arm64`, prebuilt `prebuilt/darwin-arm64-napi-v9.node`) via optionalDependencies. When pnpm does not link the platform package into the loader's tree (pnpm 11 blocked builds / stale global lockfile), the probe fails with `No usable native binding found for node-addon-require-builtin-darwin-arm64 (auto)` and bare imports fall through to Node's default resolution from the loader package dir → package not found.

### Repair (verified)

1. `pnpm add -g @deepseek-ai/dsh@0.1.0-rc.6` — rebuild the global install (re-points the bin shim; may still reuse the broken store tree).
2. Relink the platform binding so `node-addon-native-custom-loader`'s `require('node-addon-require-builtin-darwin-arm64')` resolves — the binding package lives in the pnpm store (`.../store/v11/links/@/node-addon-require-builtin-darwin-arm64/<ver>/<hash>/node_modules/node-addon-require-builtin-darwin-arm64`); symlink it into the native loader's `node_modules/`. Verify with `node -e "require('<loader>/node_modules/node-addon-require-builtin')"` → `getBindingInfo()` shows `bindingSource: optional-package`, ABI `napi-v9`.
3. Re-test: `dsh --profile <p>` in a PTY must reach the app banner. For dsh-tui specifically, a non-TTY stdout is REFUSED by design (`dsh-tui requires an interactive terminal (stdout must be a TTY)`) — that error means the plugin tree loaded and the TUI guard is working.

## Lesson 2 — Interactive TUI verification: what actually works

### What is unreliable

Subagent-driven PTY automation of an Ink TUI through a supervised-process channel: attempts hung (a 3600s `ln` command in one agent's shell), stalled ~60 min mid-session, and required repeated cancellation. Failure modes: full-screen ANSI repaint streams mixed with UI chrome (noisy to parse), completion-overlay/keystroke timing sensitivity, and async LLM turn + reviewer windows with no deterministic completion signal.

### The dependable evidence path (ranked)

1. **`--dump-config`** — deterministic; proves bundle composition + row presence (e.g. `# == dsh-advisor` / `- id: advisor`).
2. **Unit/integration pins** — command parse/render, completion children, session-less config readback, inject/steer delivery with the advisor source kind (vitest, fake LLM adapters).
3. **Direct PTY probe (PM/QA seat, not a subagent loop)** — boot via a supervised process with a readiness log pattern (the TUI banner), `send` the commands, capture the log, `stop`; then stop. This captured live `/advisor status` → 'Advisor: enabled' and `/advisor config` → 'Advisor config: enabled' rendering.
4. **Human spot-check** for the remaining interactive UX (menu overlay snapshot, Tab completion, a live turn→note injection) — document as an explicit residual gap with the exact commands, rather than grinding an unreliable automation path.

## Why This Matters

- The dump-config-works-but-boot-fails signal is easy to misread as a plugin defect; it is a host binding issue affecting every profile.
- Wasted effort is avoidable: ~4 subagent QA attempts + 3h before switching to the dependable evidence path.
- The repair steps are machine-portable (any developer with a broken pnpm-global dsh install).

## When to Apply

- Any dsh profile boot failure with `cordis-plugin-loader`/`cordis:include` ERR_MODULE_NOT_FOUND symptoms.
- Planning QA for any interactive terminal front end (dsh-tui or similar): budget for deterministic evidence + a direct probe + an explicit human-spot-check residual, and time-box subagent PTY attempts.
