# dsh advisor plugin — Architecture & Contract Spec

> **Status:** frozen reference (Review & Edit chain, architect seat, iter-20260810-dsh-advisor).
> **Durable location:** `.mstar/specs/advisor-plugin.md` (tracked). The working draft lives in the iteration package (`.mstar/iterations/iter-20260810-dsh-advisor/specs/advisor-plugin-spec.md`, gitignored); **this file is the canonical SSOT.** Plan `primary_spec` points here.
> **References:** repos named only — `omp` (the "advisor" subsystem being ported) and `dsh` (DeepSeek Harness). No local paths in this tracked document.

## 1. Problem statement

A single-model coding session has no independent second opinion. Direction errors, premature commitments, and risky moves are usually caught only after the fact by the human, when rework is already costly.

The omp coding agent ships an "advisor" subsystem that addresses exactly this: a second, independent reviewer model attached to a session. After each primary turn it receives an incremental delta of the primary transcript, reviews it, and injects concise severity-ranked advice (nit / concern / blocker) back into the primary session — steering the live run when a material risk is found, queuing asides otherwise. It is advisory only: it never approves actions, and it is gated end-to-end (dedupe, rate-limit, failure policy) so a misbehaving reviewer can never pollute or stall the primary loop.

dsh has every low-level mechanism needed (session event stream, `agent.inject`/`agent.steer`, independent `ctx.llm` model calls, command registry) but no advisor capability. This iteration ports the **core mechanism** as an installable dsh plugin bundle in this repo: one advisor per session, an explicitly configured model (provider + model are required for the advisor to run any model call), severity-ranked injection, and the safety gates that make it safe to attach to a live session. Full omp parity is out of scope this iteration and tracked in the iteration roadmap (§3).

## 2. Scope (this iteration)

- **S1** Standalone plugin bundle (`dsh.bundle` + `cordis.patch.yml`), installable via `dsh plugin --profile <name> add`.
- **S2** Core runtime: per-session observation of `session/event`; on each stepped `turn/end`, incremental delta via cursor + fingerprints; role-annotated markdown delta (own messages excluded, self-review guard); advisor model call via `ctx.llm.stream`; structured `{note, severity}` extraction.
- **S3** Delivery: nit → `agent.inject` (non-waking, next step boundary); concern/blocker → `agent.steer` (waking); `immuneTurns` cooldown (default 3); advisor messages logged with a distinct source kind (`advisor`).
- **S4** Config: `enabled` (default false); when enabled, `provider` + `model` are **mandatory** — missing either disables the advisor (no model call, disabled-with-reason); optional `systemPrompt`, `immuneTurns`, `maxDeltaMessages` window.
- **S5** `/advisor` on/off/status commands.
- **S6** Unit + integration tests, README (install/config/usage/limitations).

Scope items S1–S6 map 1:1 to the iteration Acceptance Criteria AC-1..AC-6 in the delivery compass.

## 3. Non-goals (roadmap) and accepted MVP gaps

### 3.1 Roadmap non-goals (full omp parity — not delivered this iteration)

Each item is explicitly recorded in the iteration compass Roadmap Position (batch, owner, trigger, Done definition):

- **Multi-advisor roster** (WATCHDOG.yml-style parallel advisors) → Next iteration. MVP: exactly one advisor per session.
- **WATCHDOG.md file discovery** → Next iteration. MVP configuration is plugin/profile-level only.
- **Advisor tool grants** (read/grep/glob or writable tools in an isolated ToolSession) → Next-next iteration. MVP: independent `ctx.llm` call only, no tools.
- **Advisor context maintenance / model promotion** (omp `maintainAdvisorContext`) → Next-next iteration. MVP: bounded delta window (KD-3).
- **Advisor transcript JSONL persistence + cost stats** → Next-next iteration.
- **Dedicated Web UI panel / advisor card rendering** → Next-next iteration. MVP: advice surfaces only as tagged injected messages.

### 3.2 MVP gaps vs omp (accepted — one-line impact each)

Tracked in the compass roadmap; consciously dropped from the MVP with accepted impact:

| omp capability | MVP disposition | Impact (accepted) |
|---|---|---|
| Secret obfuscation of delta content | Skipped in the delta renderer | Secrets present in the transcript can reach the advisor model; mitigated by operator configuring a trusted reviewer model and by README guidance. Roadmap: Next-next. |
| Quarantine of unsafe advisor output | Not ported; the JSON frame + validation + advisory-only prompt framing are the mitigation | A misbehaving note can carry directive text; it is delivered as self-described advisory content (`[advisor:…]`, "weigh, don't blindly obey" framing), never as an approved action. Roadmap: Next-next. |
| `syncBacklog` catch-up wait | Not ported (never park the primary) | Advisor notes may arrive after the next primary turn started; advisory-only semantics make lag acceptable. Roadmap: context-maintenance batch (Next-next). |
| Advisor context maintenance (clear→compact→promote) | Not ported; `maxDeltaMessages` default bounds advisor input instead | Long-session full replays are truncated (marker), so the advisor may lose early context after compaction. Roadmap: Next-next. |
| Advisor tools | Not ported | The advisor cannot verify claims itself; it reviews text only. Roadmap: Next-next. |
| Transcript JSONL + cost stats | Not ported | No cost observability or resumable advisor history. Roadmap: Next-next. |

## 4. omp → dsh mechanism mapping (reference for implementation)

| omp mechanism | omp location | dsh port (final) |
|---|---|---|
| turn-end hook | `agent-session.ts` `setOnTurnEnd` | `ctx.on('session/event', (session, event) => …)`; stepped turn-end detection via `findLastMessageTurnEnd` (`@deepseek-ai/dsh-session`); trigger on `turn/end` whose `reason.kind ∈ {completed, 'max-tokens', error}` (skip `aborted`/`blocked`/`interrupted` — do not critique user-cut-short turns) |
| cursor + delivered-prefix fingerprints | `advisor/runtime.ts` `#lastCount`/`#deliveredPrefix` | `src/transcript.ts` DeltaRenderer (T3): cursor over `session.events` seqs + fingerprint of delivered prefix; detects prefix rewrite |
| delta renderer (role labels, own-message exclusion, primary-context expansion, secret obfuscation) | `session-history-format.ts` + `runtime.ts` `#formatRawDelta` | markdown renderer over `session/event` + `session.events` snapshot (role labels via the surface event stream / `deriveEventMessage`); own-message exclusion via `source.kind === 'advisor'`; **MVP skips** secret obfuscation and primary-context expansion (see §3.2) |
| advise tool + `Recorded.` canned reply | `advisor/advise-tool.ts` | no tool in MVP — JSON-framed `{note, severity}` reply (KD-2) |
| emission guard | `advisor/emission-guard.ts` | `src/emission-guard.ts` (T5), same rules: normalize/dedupe/content-free suppression/one-per-update/escalation |
| delivery routing + severities | `session-advisors.ts` `#routeAdvice` | `src/delivery.ts` (T6): nit → `agent.inject`; concern/blocker → `agent.steer`; `immuneTurns` cooldown |
| backlog/catch-up/failure policy | `runtime.ts` `#drain` | `src/advisor-runtime.ts` (T4): async drain, retry-light then drop, never park (no `syncBacklog` wait) |
| reset/seed semantics | runtime reset on compaction/boundary; `seedTo(length)` | reset on `compact/*` events and on `user/message` with `surfaceOp.op === 'replace'`; `seedTo(currentLength)` on mid-session enable (KD-5) |
| isolation (own Agent + ToolSession) | `session-advisors.ts` | MVP: independent `ctx.llm.stream` call only (own provider/model); tool grants = roadmap — request shape pinned by the KD-6 minimal-request contract (§8.6) |
| WATCHDOG.md/yml discovery | `advisor/watchdog.ts`, `config.ts` | roadmap |

## 5. Configuration contract

### 5.1 Schema (plugin row config — `cordis.patch.yml` or profile override)

```yaml
advisor:
  enabled: false          # bool, default false — master switch
  provider: <route>       # string, optional — REQUIRED when enabled
  model: <model-id>       # string, optional — REQUIRED when enabled
  systemPrompt: ""        # string, optional — default built-in reviewer prompt
  immuneTurns: 3          # int ≥ 0, default 3 — cooldown after a delivered interrupt
  maxDeltaMessages: 60    # int ≥ 0, default 60 — 0 = unbounded (see §8 KD-3)
```

Schema library: schemastery (as used by dsh packages). Unknown keys are rejected (strict schema).

### 5.2 Validation rules (explicit model gate — user-locked)

- `enabled: true` with `provider` **or** `model` missing or empty (the explicit gate requires both) → the advisor **never starts a model call** and reports a disabled-with-reason status (`/advisor status` shows the reason). This is a hard gate, not a warning.
- `provider`/`model` are ignored while `enabled: false`.
- `immuneTurns`: integer ≥ 0, default 3.
- `maxDeltaMessages`: integer ≥ 0, default 60; `0`/unset → unbounded.
- Unknown keys → rejected at schema validation.

## 6. Delivery semantics

- **Severity routing:** nit → `agent.inject` (non-waking, consumed at the next pre-step boundary); concern/blocker → `agent.steer` (waking — an idle driver starts a turn, a running driver consumes at its next step boundary). Blocker is reserved for "continuing clearly wastes work" (contradicts an explicit user instruction, going in circles, fundamentally unsound).
- **immuneTurns:** after a concern/blocker is actually steered, the next `immuneTurns` (default 3) stepped primary turns must complete before another interrupting note may steer; interrupting notes in the window downgrade to inject. The fence arms only on a real steer delivery.
- **Advisor message shape:** user-role via `createUserMessage({ content, source: { kind: 'advisor' } })`; the plugin declares the `MessageSourceMap` merge extension (`declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { advisor: { kind: 'advisor' } } }`). Injected content is self-describing: `[advisor:{severity}] {note}`. The primary system prompt does not mention advisories; the prefix is the only cue how to treat them ("weigh, don't blindly obey" spirit).
- **Self-review exclusion:** every advisor-source message is excluded from subsequent advisor deltas (renderer filters `source.kind === 'advisor'`), so the advisor never reads its own injected advice back.
- **No-stall guarantee:** the drain is fully async with a bounded backlog; failure → drop, never park; there is no `syncBacklog` wait in the MVP. A failing/quota'd advisor never blocks the primary turn loop.
- **MVP simplification vs omp:** omp's delivery matrix (terminal-answer preservation, plan-mode/ACP deferral, user-interrupt auto-resume suppression, headless drain) is not ported. MVP always routes per severity; the emission guard + immuneTurns + severity defaults bound the noise. Preserve-card semantics = roadmap.

## 7. Verification plan

- **Unit (per module):**
  - `transcript.ts` — cursor advances on append; prefix rewrite (fingerprint mismatch or `surfaceOp replace`) → reset + full replay; own-message (`source.kind === 'advisor'`) exclusion; bounded window with truncation marker (§8 KD-3); role labels; `seedTo(length)`.
  - `emission-guard.ts` — normalization (`"Stop."` ≡ `*stop*`), dedupe, content-free suppression, one-note-per-update, escalation (nit→concern allowed, concern→nit suppressed), reset clears history.
  - `config.ts` — schema defaults; missing provider/model with `enabled: true` → disabled-with-reason; unknown keys rejected; severity enum validation.
  - `advisor-runtime.ts` — drain with a stub adapter registered via `ctx.llm.registerAdapter`; JSON-frame parse (valid/invalid/missing severity → default nit); adapter throw → note dropped, runtime continues; no model call when config disabled; quota error → pause; permanent error → halt.
  - `advisor-runtime.ts` — minimal request contract (KD-6, §8.6): every recorded advisor `GenerateOptions` key set matches the closed AC-1 whitelist (`['maxTokens', 'messages', 'model', 'provider', 'reasoningEffort', 'signal', 'system']` when the model advertises `'off'`, same list without `reasoningEffort` otherwise) with `'tools'`/`'temperature'`/`'stop'`/`'purpose'` absent, one user delta, `maxTokens === ADVISOR_MAX_TOKENS` (5120), and the configured `system`; a `resolveModelInfo` failure (throw or deadline abort) writes no cache entry and a later definitive resolution re-advertises `reasoningEffort: 'off'` (no-latch + recovery); a definitive no-`'off'` logs the `advisor: thinking-off unavailable …` debug line once per runtime (log-once) while a resolution failure never logs it (failures silent); a deadline-aborted resolution is re-resolved by the retry and the drain stays deadline-bounded (n4 QC N-5 rewrite).
  - `delivery.ts` — nit injects without waking; concern/blocker steer; immuneTurns downgrade window; advisor-source messages carry `source.kind === 'advisor'`.
- **Integration:** a composed cordis context with a stub LLM adapter + a fake session/agent harness; assert the full `user → primary → turn/end → delta → advisor call → note → inject` cycle, and assert the explicit-gate (no model call when `enabled: true` without provider/model).
- **Install smoke (T1):** `pnpm pack` → `dsh plugin --profile <scratch> add <tarball>` → boot or `--dump-config` shows the `advisor` row with no load errors. Dev-side resolution evidence: KD-1 (§8.1).
- **QA gate:** mandatory (behavioral change) — a real dsh session with the advisor enabled, observing one full turn→advisor→inject cycle (AC-6).

## 8. Resolved decisions (KD)

### 8.1 KD-1 — dev-time dependency resolution for private `@deepseek-ai/dsh-*` packages — SUPERSEDED by KD-R1 (iter-20260810-dsh-advisor-n2)

> **Update (2026-08-10, iteration-close):** the gitignored dev overlay below was **replaced by committed `peer-stubs/`** (KD-R1, iter-20260810-dsh-advisor-n2): one committed stub package per directly-consumed private package, wired as `file:./peer-stubs/<name>` devDependencies; `cordis`/`schemastery` stay registry devDeps; `prepare: pnpm build` added so **git-URL installs** work (pnpm ≥10 gates it behind `onlyBuiltDependencies`/`allowBuilds`). `pnpm install` now exits 0 in any clone with **no** `DSH_SOURCE`. Details: plan `dsh-advisor-readme-n2` KD-R1 + knowledge `developer-experience/dsh-standalone-plugin-dev.md`. The original mechanism is preserved below for history.

**Original decision: gitignored dev overlay (workspace members, shim packages).** Committed files stay free of local absolute paths; all absolute paths live only in the gitignored `dev/` directory, generated by a committed, path-free bootstrap script.

**Mechanism (verified end-to-end in a scratch dir):**

- **Committed** `pnpm-workspace.yaml`:
  ```yaml
  packages:
    - dev/*
  linkWorkspacePackages: true
  ```
  (`linkWorkspacePackages: true` is required — without it pnpm resolved the private ranges from the registry and failed with 404.)
- **Committed** `package.json`: devDependencies are plain version ranges, path-free: `@deepseek-ai/dsh-{llm,session,agent,commands,brand,invariants,scope,system-prompt,timeout,type-meta}` all `^0.0.1`, plus `cordis` `^4.0.0-rc.7` and tooling (`typescript`, `vitest`, `@types/node`). All 10 `@deepseek-ai/*` packages are the transitive peer/runtime closure of the four direct imports; each must be resolvable for pnpm to link cleanly. `cordis` must also come from the overlay (see below).
- **Gitignored** `dev/` — one shim member per package, generated by `scripts/dev-link.mjs` (committed; `DSH_SOURCE=<path> pnpm dev:link`, default sibling `../dsh-private`). Each shim is:
  - `package.json`: `{ name, version, type: 'module', private: true, main: './index.js', types: '<abs>/lib/types/index.d.ts' }` — no `bin`, no deps;
  - `index.js`: `export * from "<abs>/lib/index.js"` (Node ESM accepts absolute-path specifiers).
- **Do NOT symlink the real package dirs into `dev/`**: the real dirs carry their own `node_modules` (e.g. their own `cordis`), which splits the `cordis` module identity between the plugin and the dsh types — every `declare module 'cordis'` augmentation (from `dsh-session`, `dsh-agent`, `dsh-llm`, `dsh-commands`) silently stops applying (`ctx.sessions`, `ctx.agents`, `ctx.llm`, `session/event` all vanish from the type). It also makes pnpm `linkBins` chmod the real package's `bin` through the symlink. The shim form avoids both.

**Verification evidence (scratch dir, exact commands and outcomes):**

| Step | Command | Outcome |
|---|---|---|
| Install | `pnpm install` (with overlay) | exit 0 |
| Install without overlay | `pnpm install` (no DSH_SOURCE, any clone) | exit 0 — private packages resolve via committed `peer-stubs/` `file:` devDeps (KD-R1 supersession) |
| Typecheck | `pnpm exec tsc --noEmit` (strict, `moduleResolution: bundler`) | exit 0 — probe exercising `session/event` + `findLastMessageTurnEnd`, `ctx.llm.stream` with `GenerateOptions`, `createUserMessage` with custom source kind, `ctx.agents.get`, command registration — all type-clean, augmentations applied |
| Runtime | `node --input-type=module` importing `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `cordis` | exit 0 — `createUserMessage` with `{kind:'advisor'}` accepted, `findLastMessageTurnEnd` callable |
| Tests | `pnpm exec vitest run` (3 smoke tests incl. stepped turn-end detection) | exit 0, 3/3 passed |

Environment: Node v24.18.0, pnpm 10.28.1 (assignment note said "pnpm ≥ 11 available"; the installed version is 10.28.1 and the overlay verifies on it — treat pnpm ≥ 10 as the requirement; pnpm 11 is expected to behave identically). Toolchain: TypeScript `module: ESNext` + `moduleResolution: bundler` (matches the dsh monorepo's own base tsconfig; `node16` resolution is unusable here because cordis's published d.ts uses extensionless relative imports).

**Runtime side:** the installed plugin declares `cordis` and the four `@deepseek-ai/dsh-{session,agent,llm,commands}` as **peerDependencies**; the dsh installation resolves them at runtime (two-anchor bundle resolution + the `$DSH_HOME/profiles/node_modules` flat fallback, which parent-walk makes every in-box `@deepseek-ai/*` package resolvable from any profile). Verified present in the flat fallback: all four packages plus the full transitive peer set, and `cordis@4.0.0-rc.7` (public on npm; the vendored copy is what the dsh install uses).

**Alternatives assessed:** (A) `file:` devDependencies to the local checkout — committed absolute paths violate the user rule, and file: deps on the real dirs reintroduce the node_modules-shadowing augmentation problem; rejected unless shimmed, which is exactly the chosen design. (B) typecheck-only tsconfig `paths` map to the flat fallback — works for types but tests would need vitest aliases and the plugin's `cordis` (registry copy) would diverge from the one the dsh libs link at runtime (two cordis instances in one test process); more moving parts. The overlay is the single-mechanism solution (types + runtime + tests).

### 8.2 KD-2 — structured note extraction — RESOLVED

**Decision: JSON-framed `{note, severity}` reply (no tool loop in MVP).**

- **Frame contract:** the system prompt instructs the advisor to reply with exactly one JSON object: `{"note": "<text>", "severity": "nit"|"concern"|"blocker"}`; `severity` may be omitted (means nit). One note per update.
- **Extraction:** locate the first balanced `{…}` object in the reply (tolerant of surrounding prose/markdown fences), `JSON.parse` it.
- **Validation:** `note` must be a non-empty string after trim — otherwise **drop + log** (never crash the drain). `severity` must be one of `nit|concern|blocker`; missing or invalid → default `nit` (rationale: the least-invasive default — matches omp's "omit for a plain nit" and a mis-severity defaulting to nit minimizes disruption).
- **Invalid-reply fallback:** drop + log a warning; **no retry for parse failures** (the retry budget is reserved for transport errors; a model that cannot emit the frame will not improve on retry).
- **Output-token cap:** the advisor call sets `maxTokens: 256` so a runaway reply cannot blow the budget; the frame must fit within it. **[Superseded (2026-08-11, n4 user direction — qc2 S-2 / qc1 S-2 / qc3 F-2):** the advisor call runs with `ADVISOR_MAX_TOKENS = 5120` (256 → 5120, 20x) so even a reasoning-heavy reply cannot starve the JSON frame — see KD-6 (§8.6). The historical 256 text above is preserved for context; the raised ceiling is re-bounded downstream (`extractAdviceNote` `ADVISOR_NOTE_MAX_CHARS` cap, bounded notice summary).]**
- **One-per-update enforcement:** prompt rule + the emission guard's one-note-per-update rate limit (guard also drops extras).

### 8.3 KD-3 — delta message window — RESOLVED

**Decision: bounded `maxDeltaMessages` window, default 60; `0`/unset = unbounded.**

- Rationale: the incremental delta (messages since the cursor) is small by construction; the unbounded path is the **full replay after reset/rewrite** (compaction, prefix rewrite) and the seed on mid-session enable. The MVP has no advisor context maintenance (roadmap), so an unbounded replay on a long session makes the single advisor call arbitrarily large (cost + provider window overflow). Bounding it keeps worst-case advisor input predictable; omp tolerates unbounded replays only because of its maintenance machinery.
- **Truncation behavior:** when the delta would exceed `maxDeltaMessages`, keep the most recent N messages and prepend a marker line `… <earlier messages omitted>` to the rendered markdown. Applies to every rendered delta (incremental deltas are normally far below the bound).
- The bound also caps the seed on `/advisor on` mid-session (KD-5).

### 8.4 KD-4 — session → agent mapping — RESOLVED

**Decision: maintain a per-session map from `agent/created` / `agent/disposed`, keyed by session id, with a registry fallback.**

- Mechanism: `ctx.on('agent/created', ({agent}) => map.set(agent.id, agent))` and `ctx.on('agent/disposed', ({agent}) => map.delete(agent.id))`, keyed by `agent.id` — `Agent.id === Session.id` by construction (verified in `@deepseek-ai/dsh-agent`: `readonly id: SessionId`, `readonly session: Session`; the registry is `ctx.agents` with `get(id: SessionId): Agent | undefined`). The `session/event` handler resolves the agent via the map, falling back to `ctx.agents.get(session.id)` (covers agents published before the plugin loaded).
- Rationale: the map makes delivery O(1) without a registry lookup per event and gives a clean dispose hook; the registry fallback covers edge cases; no per-agent scoped listeners are needed (they would multiply listeners and complicate disposal). Missing agent at delivery time → drop the note + log (advisory only, never stall).

### 8.5 KD-5 — reset triggers, seed-on-enable, failure policy, and the `purpose` field — RESOLVED

- **Reset triggers:** (a) any `compact/*` event (`compact/start` | `compact/summary` | `compact/end`, declared-merged into `SessionEventMap` by `@deepseek-ai/dsh-compact`) → reset renderer cursor + emission guard + immuneTurns latches; next stepped `turn/end` replays the full post-rewrite transcript (bounded by KD-3). (b) any `user/message` carrying `surfaceOp.op === 'replace'` (the compaction surface replacement) → same reset (the renderer's fingerprint check also detects prefix changes; the event is the authoritative trigger). (c) `agent/disposed` → dispose the per-session runtime.
- **Seed-on-enable:** `/advisor on` mid-session seeds the cursor to the current transcript length (`seedTo(currentLength)`) — no full-history replay, matching omp.
- **Failure policy (MVP-sized, omp §3 simplified):** transient errors → 1 retry with a short backoff, then drop the delta; 3 consecutive dropped deltas → flush the pending backlog (never stall); permanent errors (`invalid_request_error`, model-not-found) → halt that session's advisor with an error status; quota/rate-limit → pause that session's advisor (status `quota_exhausted`), requeue the delta, no auto-resume timer; in-flight call aborted on session dispose via the `signal`. The primary loop is never parked (no `syncBacklog`).
- **`purpose` field:** `GenerateOptions.purpose` is a **closed union** `'compaction' | 'session-title'` (verified in `@deepseek-ai/dsh-llm`); an advisor call is an ordinary conversation request and **leaves `purpose` unset**. If the union later becomes extensible, an `'advisor'` purpose could be added for adapter-level metering — not needed for the MVP; no action.

### 8.6 KD-6 — minimal advisor request contract (zero tools, capability-gated thinking-off) — RESOLVED

**Decision: every advisor `ctx.llm.stream` call is a minimal start — the closed AC-1 `GenerateOptions` whitelist, zero `tools` key, capability-gated `reasoningEffort: 'off'`, `purpose` unset (KD-5), and `maxTokens` 5120 (KD-2 supersession). The guarantee is a code invariant, not an operator switch.**

- **Closed whitelist (AC-1, regression-pinned):** every recorded advisor `GenerateOptions` key set is exactly one of two variants (`Object.keys(…).sort()` equality): `['maxTokens', 'messages', 'model', 'provider', 'reasoningEffort', 'signal', 'system']` when the resolved model advertises `'off'`, else the same list **without** `reasoningEffort`. `'tools'`, `'temperature'`, `'stop'`, `'purpose'` are never present; `messages` is exactly one user delta; `maxTokens === ADVISOR_MAX_TOKENS` (5120); `system` is the configured prompt. The pin is on the plugin control surface (`GenerateOptions`), not dsh adapter wire JSON — adapters omit the wire `tools` field when unset and stock `llm/stream` middleware injects none (verified against dsh source).
- **Thinking-off is capability-gated (n4 QC frozen — qc2 W-1 / qc1 W-1 / qc3 F-3):** `reasoningEffort: 'off'` is sent **only** when the resolved model's `reasoning.efforts` advertises `'off'`; otherwise the option is omitted entirely (an explicit effort for a model without reasoning metadata is rejected with `UNSUPPORTED_REASONING_EFFORT`, silently killing the advisor for non-deepseek models). The DeepSeek wire mapping `off → thinking: {type:'disabled'}` is **host behavior**, not a plugin configuration; unconditional `'off'` is a Non-Goal.
- **Resolution failures never latch; definitive no-`'off'` logs once:** a `resolveModelInfo` throw **or** deadline abort is a failure, not a verdict — it writes no `reasoningEffortCache` entry and the next call re-resolves afresh. Only **definitive** outcomes are cached: method absent ("no capability API") or a resolved verdict (`'off'` / no-`'off'`). A definitive no-`'off'` emits the `advisor: thinking-off unavailable …` debug line **once per runtime**; resolution failures never emit it and get no log-once latch of their own.
- **No new plugin config keys:** the single §5.1 schema surface is unchanged (`enabled` / `provider` / `model` / `systemPrompt` / `immuneTurns` / `maxDeltaMessages`); no `thinking` / `tools` / `reasoningEffort` / "minimal start" toggle keys exist.
- **`purpose` unset (KD-5); `maxTokens` 5120 (KD-2 supersession):** an advisor call is an ordinary conversation request and leaves `purpose` unset (closed union `'compaction' | 'session-title'`). `maxTokens` is `ADVISOR_MAX_TOKENS` (5120) — the user-directed supersession of KD-2's historical `256` (§8.2 annotation above); the raised ceiling is re-bounded downstream (`extractAdviceNote` `ADVISOR_NOTE_MAX_CHARS` cap, bounded notice summary).
- **Contract freeze (AC-4):** the §4 isolation row points at this contract; §7 verification entries mirror the T1/T2 regression pins (no-latch + recovery, log-once, failures-silent, N-5 deadline-bounded rewrite, closed-whitelist two variants).

## 9. Risks and rollback

- **API drift:** this spec pins the dsh API surface (session events, agent inject/steer, llm.stream, commands, registry) as verified against the dsh source at spec time; the integration test (T8) and install smoke (T1) are the drift detectors. If a pinned shape moves, the affected task updates the mapping table in this spec first.
- **Advisor noise/quality:** emission guard + severity defaults + immuneTurns (see §6); QA gate observes a real session.
- **Sandbox/permission coupling of dev resolution:** `dev:link` writes absolute paths into gitignored `dev/`; documented in README; failure mode is a loud install error with a fix (`pnpm dev:link`).

## 10. Effort (agent-oriented)

Architect estimate recorded in the plan (`dsh-advisor-mvp`): S (8 tasks, TDD, SDD execution).
