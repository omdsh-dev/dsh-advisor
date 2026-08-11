---
module: advisor subsystem (omp → dsh port)
date: 2026-08-10
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
title: Porting the omp advisor subsystem to dsh — mechanism map and MVP decisions
description: Durable mechanism map of the omp advisor (second reviewer model per session) onto dsh primitives, with the verified MVP port decisions and the accepted gaps tracked for later iterations.
tags:
  - advisor
  - omp
  - dsh
  - port
  - session-events
  - emission-guard
  - delivery

applies_when:
  - Extending the dsh advisor plugin (multi-advisor roster, tool grants, context maintenance, UI)
  - Reviewing or debugging the advisor plugin's delta/delivery semantics
  - Porting other omp subsystems to dsh
---

# omp advisor → dsh port: mechanism map

## Context

omp's advisor attaches an independent reviewer model to a session: after each primary turn it receives an incremental transcript delta, reviews it, and injects severity-ranked advice (nit / concern / blocker) back into the primary session, gated end-to-end so a misbehaving reviewer can never pollute or stall the primary loop. dsh has every low-level mechanism (session event stream, agent inject/steer, independent llm calls, command registry) but no advisor capability. The port delivered the **core mechanism** as an installable plugin bundle.

## Guidance (mechanism map)

| omp mechanism | dsh port (verified) |
|---|---|
| turn-end hook (`setOnTurnEnd`) | session/event listener; stepped turn/end detection (`findLastMessageTurnEnd` semantics); filter reason kinds completed / max-tokens / error |
| cursor + delivered-prefix fingerprints | per-session cursor + message fingerprints; prefix rewrite (compact events, surface replace ops) → reset + full replay of the post-rewrite transcript; seed-to-length on mid-session enable |
| delta renderer (role labels, own-message exclusion) | markdown with `**user:**` / `**agent:**` labels; advisor's own injected messages excluded via a custom merge-extensible source kind (`advisor`) — the self-review guard; bounded delta window (default 60 messages, 0 = unbounded) with a truncation marker |
| advise tool + canned `Recorded.` | MVP: JSON-framed note + severity reply (first balanced `{...}`; empty note dropped; missing severity → nit; no parse retry; 256-token cap) — no tool loop |
| emission guard | normalize (NFKC → lowercase → non-alnum runs → single space), content-free phrase suppression, exact-text dedupe (FIFO, 4096), one-note-per-update, severity escalation (nit→concern→blocker allowed, equal/lower suppressed) |
| delivery routing | nit → inject (non-waking, next pre-step); concern/blocker → steer (waking); immuneTurns cooldown (default 3) after a delivered interrupt downgrades later interrupting notes to inject; messages carry `[advisor:{severity}]` text + the advisor source kind |
| backlog/catch-up/failure | async drain per session; retry once + backoff → drop; 3 drops → flush backlog; quota → paused (batch retained, no auto-resume); permanent errors → halted; **call-level deadline** (dsh-timeout, default 60 s) so a hung stream cannot wedge the drain; never parks the primary |
| reset/seed semantics | reset on compact/replace (rewrite) + session boundary; guard/dedupe state clears with the runtime; delivery/onNote throws contained (no unhandled rejection) |
| session→agent mapping | per-session map from agent created/disposed events keyed by the shared session id, fallback registry lookup; missing agent → drop + log |

## Key port decisions

- **Explicit model gate**: `enabled: true` without `provider` + `model` → advisor resolves disabled-with-reason; **no model call ever starts** (user decision; stricter than omp's role-chain fallback). Whitespace-only values also trip the gate (trim before check).
- **`/advisor` on|off|status** via conditional `ctx.inject(['commands'], ...)`; per-session ephemeral override (`override ?? config.enabled`); `/advisor on` recovers halted (dispose-and-recreate) and quota-exhausted (resume) runtimes; status surfaces the disabled-with-reason.

## Accepted MVP gaps (spec §3.2; roadmap-tracked, do NOT silently re-add)

Secret obfuscation of deltas; quarantine of unsafe advisor output; syncBacklog bounded catch-up wait; advisor context maintenance (clear-at-cursor → compact → promote); advisor tool grants (read/grep/glob isolated ToolSession); multi-advisor roster + WATCHDOG discovery; transcript JSONL + cost stats; dedicated UI. **Known accepted limitation**: topic-level paraphrase churn (a persistent disagreement produces a new-but-different note per turn via inject — frequency-bounded, topic-unbounded; per-topic similarity cooldown is the next-iteration hardening candidate; QA observed 5 turns: 1 note/turn, no storm, no stall).

## Why This Matters

The map is the contract for every later iteration (roster, tools, context maintenance, UI) and for debugging the delivered plugin: each mechanism has a verified dsh-side home, and each accepted gap has a tracked home on the roadmap.

## When to Apply

Any change to the dsh advisor plugin; any future omp→dsh port (the mapping method — mechanism → dsh primitive → gating → MVP gap — generalizes).

## Examples

- Frozen spec: `{SPECS_DIR}/advisor-plugin.md` (canonical; this doc is the condensed map).
- QA real-session evidence: full turn→delta→llm→guard→inject cycle with a real model; injected message observed in the persisted session stream with the advisor source kind and a non-waking next-step target.
