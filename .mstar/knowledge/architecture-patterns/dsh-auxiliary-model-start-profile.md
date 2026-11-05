---
title: dsh auxiliary-model-call start profiles — minimal GenerateOptions, no model-side token budget, capability-gated reasoning-effort selection with failure-retry caching
category: architecture-patterns
problem_type: knowledge
source_plan: dsh-advisor-minimal-start
iteration: iter-20260815-dsh-advisor-n7
created: 2026-08-15
last_updated: 2026-11-05
status: active
---

# dsh auxiliary-model-call start profiles (advisor KD-6 pattern)

## Context

dsh plugins that make **auxiliary** model calls (advisor reviewer, future subagent helpers) must not silently inherit conversational defaults: the agent loop's request is tool-laden and thinking-defaulted, but an auxiliary reviewer wants a minimal, predictable, cheap request. The advisor (iter-20260815-dsh-advisor-n7) froze this as spec KD-6 (`.mstar/specs/advisor-plugin.md` §8.6).

## Guidance

Three invariants, all pinned at the single builder seam, plus the capability surface the settings UI reads.

1. **Minimal request shape — closed whitelist, NO model-side token budget.** Every auxiliary `ctx.llm.stream` call builds `GenerateOptions` in ONE function (`buildOptions`) whose key set is exactly `['messages','model','provider','reasoningEffort','signal','system']` (minus `reasoningEffort` when the resolved model declares no reasoning effort). No `tools` (the wire field is omitted by both dsh adapters when unset — verified deepseek `serialize.ts`, pi-ai `context.ts`; no stock `llm/stream` middleware injects tools). Tests assert `Object.keys(options).sort()` equality with a **hardcoded literal** (not derived from the code under test) — so any new key drift breaks loudly. Pin the plugin control surface (`GenerateOptions`), never adapter wire JSON.

   **No `maxTokens` (2026-10-18 ruling, superseding the KD-I1/KD-6 budget chain).** On OpenAI-compatible APIs `max_tokens` caps reasoning + content TOGETHER, so a "runaway reply" budget on a thinking model intermittently starved the final content: the completion ended with no content, dsh-llm-pi-ai mapped it to an `EMPTY_RESPONSE` failure, and the auxiliary runtime misclassified it as transient — retry, drop, invisible in every status counter (the 2026-10-18 incident: `dropping delta after transient failures` after an API-key repair). The correct output bound for an auxiliary reviewer is at **extraction** (cap the parsed note, e.g. `ADVISOR_NOTE_MAX_CHARS`), never at the API budget; latency is bounded by the call deadline. Corollary: an `EMPTY_RESPONSE` failure must be classed as the empty-reply outcome (counted, reported, never retried — retrying reproduces the same empty completion), not as a transient transport error.

2. **Reasoning effort is selected from the model's declaration, never sent blind.** Sending `reasoningEffort` to a model without reasoning metadata throws `UNSUPPORTED_REASONING_EFFORT` from `LlmRuntime.resolveCallFor` and silently kills the auxiliary caller for non-deepseek models. Resolve capabilities via `ctx.llm.resolveModelInfo(provider, model, signal)` and pick the value in one order: a configured `reasoningEffort` id is sent when the resolved model declares it; otherwise the **smallest declared** effort (`efforts[0]` — dsh-llm documents the list as least → greatest) is sent; when the model declares no reasoning metadata the option is omitted entirely. An undeclared configured id (a leftover after a model switch) falls back to that smallest declared effort with one warning per runtime, and an undeclared value is never sent. DeepSeek wire: an `'off'` effort maps to `thinking: {type:'disabled'}` — host behavior, not plugin config. The spec's KD-6 decision paragraph and capability-gate bullet carry the matching `[Superseded in part]` annotation (`.mstar/specs/advisor-plugin.md` §8.6).

**Caching discipline (the n7 bug class).** Cache `resolveModelInfo` results **only for definitive outcomes**, and cache the model's **declared effort list** (an empty list = definitive no-metadata) rather than a resolved id — one lookup then serves any later selection without the cache encoding a decision:

| Path | Class | Cache | Log |
|------|-------|-------|-----|
| method absent | definitive (empty effort list) | yes | once |
| present, resolves | definitive (declared effort list, possibly empty) | yes | once iff empty |
| present, rejects (throw **or** deadline abort — one class) | failure | **no** | never |

The original implementation cached the failure as permanent `undefined` — one transient `resolveModelInfo` throw (or a deadline-aborted lookup) silently dropped the capability verdict for the runtime's lifetime, re-starving the JSON frame (the n4 incident class). Correct shape: the `catch` path returns **before** any cache write, while a definitive empty list is itself a cached value — an absent map entry is the only miss, so a cached no-metadata verdict is never re-resolved. A persistently hanging resolution burns its attempt + retry and drops the delta — bounded, no wedge — and the next call retries fresh; **never** "fix" the burn by re-latching on abort.

**Capability surface for a settings UI.** A settings surface that offers efforts must query the host through a capability endpoint over `ctx.llm.resolveModelInfo` with a bounded deadline; a client-side model catalog is not a second source — it may omit profile-declared models, so a model declared in the provider profile would render no options. The endpoint bounds the lookup at 60 s and maps a timeout (or a resolver throw) to a tagged data error instead of throwing, so an unanswerable query degrades the control to its automatic option rather than failing the settings card.

### Session-scoped capability pins and truthful visibility

A plugin that lets one session pin a capability-gated option (here `reasoningEffort`) adds no second config surface: the pin rides the SAME atomic route override, and every read surface reports what the runtime actually resolved.

1. **A per-session effort is part of the atomic route override, and memory-only.** `src/commands.ts` `AdvisorModelPair` is `{provider, model, reasoningEffort?}`; an absent `reasoningEffort` means "inherit the global value", and the three fields are never merged across levels. The record lives for the live-session lifetime only — cleared with the pair by reset, dispose, owner teardown, cold resume or restart — never persisted. `src/index.ts` `effectiveReasoningEffort` (`overrides.model(sessionId)?.reasoningEffort ?? safeResolved().reasoningEffort`) is the single read of that precedence, and both `runtimeSignature` and the `AdvisorRuntime` construction consume it: an effort-only pin changes the signature and rebuilds the runtime exactly once, and `applyRouteChange` compares the effective effort so a pin that changes neither the pair nor the effort is `unchanged` with the runtime untouched. Because the signature reads the EFFECTIVE value, a global effort edit changes it only for unpinned sessions — it never reaches a pinned one.
2. **Normalize the command grammar at the parser, not at the callers.** `src/commands.ts` `parseModelSetArgs` validates ONE token: the first `/` splits provider from model, and the last `:` after that `/` splits model from effort, so a model id may itself contain `/` and `:`. The split delegates shape and effort validation to `parseModelPair`, the single authority the command face and the web gateway face share. The last-`:` rule leaves a model id ending in `:` undecidable, so the declared-effort rejection in `src/index.ts` `setModel` names the remedy instead of a bare mismatch: re-pin with an explicit declared effort suffix (`<provider>/<model>:<effort>:<declared-effort>`).
3. **Surface the resolved effort; do not recompute it.** `src/advisor-runtime.ts` `resolveReasoningEffort` records its definitive outcome once per runtime in `reasoningEffortResolved` — `configured`, `fallback-undeclared`, `auto` or `none` — and exposes it read-only through `reasoningEffortResolution`. `src/index.ts` `sessionStatus` passes that record on (`{source: 'pending'}` before the first review call, never a guess), `advisorStatusText` renders it as one `Effort:` line, and `snapshotOfStatus` ships it on the session wire. The failure path returns before any record write, so a failed lookup is advisory and never overwrites a prior verdict.
4. **Bind the capability option list to the pair it was resolved for.** `src/client/advisor-store.ts` `loadReasoning` keys the options by `${provider}\u0000${model}`: a lookup for a different pair clears the previous `reasoningEfforts` BEFORE the fetch, so a failed lookup leaves only the inherit option and can never surface another model's ids under the newly staged one. A same-pair re-probe failure keeps the list — those options still describe that pair.

## Why This Matters

- Auxiliary callers are invisible: nothing surfaces "advisor quietly started thinking again" or "an unsupported effort was sent" — only the closed-whitelist, capability-gated selection and no-latch tests make the guarantee falsifiable.
- Failure-as-verdict caching converts a blip into a permanent behavior change; the classification table is the reusable fix pattern.
- Caching the declared list rather than a decision keeps one lookup valid across config edits and model switches, and keeps a definitive no-metadata verdict distinct from a failure.
- One builder + literal-pin tests is the cheapest durable defense against future feature creep re-adding tools or sampling "while we're at it".
- A settings control that reads only the client catalog drifts from the models the host can actually route; the host capability endpoint is the single source.

## When to Apply

- Any dsh plugin making independent `ctx.llm.stream` calls (compaction helpers, title generators, reviewers, subagents).
- Any capability-gated option where the capability lookup itself can fail transiently (adapter throw, deadline abort, unknown route).
- Any settings surface that enumerates model capabilities (effort tiers, limits): read them from a host capability endpoint with a bounded deadline, never from a client-side catalog.
- Any plugin that exposes a per-session override of a capability-gated option: carry it inside the atomic route override, read the runtime's recorded verdict instead of recomputing it, and bind the settings option list to the pair it was resolved for.
- Roadmap: per-role start profiles for dsh subagents (next iteration candidate) should reuse this exact pattern instead of forking a second config surface.

## Examples

- `src/config.ts` `reasoningEffort` — the optional persisted key (absent/empty = automatic: the smallest declared effort).
- `src/advisor-runtime.ts` `resolveReasoningEffort` + `buildOptions` — the selection rule, the declared-list cache and the warn-once fallback.
- `src/gateway.ts` `modelReasoning` — the read-only capability endpoint: 60 s deadline, tagged data errors, never a throw.
- `src/client/advisor-store.ts` `ensureModelReasoning` — the per-key capability cache that feeds the settings control.
- `tests/advisor-runtime.test.ts`: closed-whitelist pins (KD-6 back-pointers), smallest-declared default, configured-hit and undeclared-fallback + warn-once, resolution failure not cached, log-once via the injectable `logger` spy seam, and the N-5 deadline-bounded rewrite asserting `resolveSignals[1].aborted === false`.
- `src/advisor-runtime.ts` `classifyFailure` — `EMPTY_RESPONSE` returns the `'empty'` class (2026-10-18): no retry, counted into the empty-reply counters, no-note outcome, failure detail in the drop warn.
- `src/commands.ts` `parseModelSetArgs` + `parseModelPair` — the one-token `<provider>/<model>[:<effort>]` grammar (first `/`, last `:`) and the shape/effort validator the command face and `src/gateway.ts` both call.
- `src/index.ts` `effectiveReasoningEffort` + `runtimeSignature` — the session pin wins over the global value in both the signature and the runtime construction, so an effort-only pin rebuilds once and a global edit never reaches a pinned session.
- `src/advisor-runtime.ts` `resolveReasoningEffort` → `reasoningEffortResolution`, read by `src/index.ts` `sessionStatus` / `snapshotOfStatus` and rendered by `src/commands.ts` `advisorStatusText` — one recorded verdict per runtime, `pending` before the first call, failure never overwrites.
- `src/client/advisor-store.ts` `loadReasoning` — the settings option list is keyed to its `${provider}\u0000${model}` pair and cleared before a different pair's lookup.
