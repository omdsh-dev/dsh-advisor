---
title: dsh auxiliary-model-call start profiles — minimal GenerateOptions + capability-gated thinking-off with failure-retry caching
category: architecture-patterns
problem_type: knowledge
source_plan: dsh-advisor-minimal-start
iteration: iter-20260815-dsh-advisor-n7
created: 2026-08-15
last_updated: 2026-08-15
status: active
---

# dsh auxiliary-model-call start profiles (advisor KD-6 pattern)

## Context

dsh plugins that make **auxiliary** model calls (advisor reviewer, future subagent helpers) must not silently inherit conversational defaults: the agent loop's request is tool-laden and thinking-defaulted, but an auxiliary reviewer wants a minimal, predictable, cheap request. The advisor (iter-20260815-dsh-advisor-n7) froze this as spec KD-6 (`.mstar/specs/advisor-plugin.md` §8.6).

## Guidance

Two invariants, both regression-pinned at the single builder seam:

1. **Minimal request shape — closed whitelist.** Every auxiliary `ctx.llm.stream` call builds `GenerateOptions` in ONE function (`buildOptions`) whose key set is exactly `['maxTokens','messages','model','provider','reasoningEffort','signal','system']` (minus `reasoningEffort` when the model does not advertise it). No `tools` (the wire field is omitted by both dsh adapters when unset — verified deepseek `serialize.ts`, pi-ai `context.ts`; no stock `llm/stream` middleware injects tools). Tests assert `Object.keys(options).sort()` equality with a **hardcoded literal** (not derived from the code under test) plus literal `768` for the frozen token cap — so any new key or value drift breaks loudly. Pin the plugin control surface (`GenerateOptions`), never adapter wire JSON.

2. **Thinking-off is capability-gated, never unconditional.** Sending `reasoningEffort` to a model without reasoning metadata throws `UNSUPPORTED_REASONING_EFFORT` from `LlmRuntime.resolveCallFor` and silently kills the auxiliary caller for non-deepseek models. Resolve capabilities via `ctx.llm.resolveModelInfo(provider, model, signal)` and send `'off'` **only** when `reasoning.efforts` advertises it (DeepSeek wire: `'off' → thinking: {type:'disabled'}` — host behavior, not plugin config).

**Caching discipline (the n7 bug class).** Cache `resolveModelInfo` results **only for definitive outcomes**:

| Path | Class | Cache | Log |
|------|-------|-------|-----|
| method absent | definitive `undefined` | yes | once |
| present, resolves | definitive (`'off'`/`undefined`) | yes | once iff `undefined` |
| present, rejects (throw **or** deadline abort — one class) | failure | **no** | never |

The original implementation cached the failure as permanent `undefined` — one transient `resolveModelInfo` throw (or a deadline-aborted lookup) silently dropped thinking-off for the runtime's lifetime, re-starving the JSON frame (the n4 incident class). Correct shape: the `catch` path returns **before** any cache write; use `cache.has(key)` (not `.get()`) so a cached-definitive-`undefined` is distinguishable from a miss. A persistently hanging resolution burns its attempt + retry and drops the delta — bounded, no wedge — and the next call retries fresh; **never** "fix" the burn by re-latching on abort.

## Why This Matters

- Auxiliary callers are invisible: nothing surfaces "advisor quietly started thinking again" — only the closed-whitelist + no-latch tests make the guarantee falsifiable.
- Failure-as-verdict caching converts a blip into a permanent behavior change; the classification table is the reusable fix pattern.
- One builder + literal-pin tests is the cheapest durable defense against future feature creep re-adding tools or sampling "while we're at it".

## When to Apply

- Any dsh plugin making independent `ctx.llm.stream` calls (compaction helpers, title generators, reviewers, subagents).
- Any capability-gated option where the capability lookup itself can fail transiently (adapter throw, deadline abort, unknown route).
- Roadmap: per-role start profiles for dsh subagents (next iteration candidate) should reuse this exact pattern instead of forking a second config surface.

## Examples

- `src/advisor-runtime.ts` `buildOptions` + `resolveReasoningEffort` (post-n7, commit 73b54be).
- `tests/advisor-runtime.test.ts`: closed-whitelist pins (KD-6 back-pointers), no-latch throw→'off' recovery, log-once via injectable `logger` spy seam, N-5 deadline-bounded rewrite asserting `resolveSignals[1].aborted === false`.
