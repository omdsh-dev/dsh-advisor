/**
 * Next-prompt prediction (plan dsh-advisor-next-prompt-n12, T1) — the server
 * half: per-session arm/consume state, a generation fence, and the best-effort
 * prediction call. After each completed primary turn (armed via the observer's
 * `onCompletedTurnEnd` callback) the NEXT rendered delta for that session is
 * the prediction context: one lightweight `llm.stream` call asks the model for
 * the user's likely next prompt, the reply is shaped into a single-line
 * suggestion, and the result is stored for the web surface (T2 serves it via
 * `getSuggestion`; T3 renders it).
 *
 * The prediction is strictly best-effort and fully decoupled from the review
 * chain: it never touches `AdvisorRuntime` or delivery state, every failure
 * (throw, deadline, empty/`NONE` reply) is a silent drop with a debug log, the
 * SESSION-SCOPED effective config gates the arm, the fire read AND EVERY
 * ATTEMPT (a `/advisor off` override, a `nextPrompt: false` flip or a
 * provider/model pair change mid-chain aborts the prediction instead of
 * funding another model call — I-000024/I-000030), and
 * the fence is bound to the per-session STATE IDENTITY — a manager-level
 * token never reused after a `disposeSession`/rebuild (I-000026) — so any
 * result computed for a superseded turn is discarded wholesale.
 *
 * @module dsh-advisor/next-prompt
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { AdvisorLlm, AdvisorRuntimeLogger } from './advisor-runtime.js'
import type { AdvisorSuggestionFace } from './gateway.js'
import type { ResolvedAdvisorConfig } from './config.js'
import { DEFAULT_NEXT_PROMPT_SYSTEM_PROMPT } from './prompts.js'
import type { Delta } from './transcript.js'

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * Hard cap for one stored/served next-prompt suggestion (contract 5): the
 * text is always single-line and never longer than this — counted in CODE
 * POINTS, not UTF-16 code units (an astral emoji is one character, two
 * units; qc2 F-003). A verbose/rogue predictor reply must not grow the web
 * surface (T3) unboundedly.
 */
export const NEXT_PROMPT_MAX_CHARS = 120

/**
 * Whole-call deadline for one prediction `llm.stream` — deliberately tighter
 * than the review call's 60 s norm: the output is one short line, and the
 * feature is best-effort (a slow provider must not hold prediction state for
 * long).
 */
export const NEXT_PROMPT_CALL_TIMEOUT_MS = 20_000

/** Capability-owned code stamped onto the prediction deadline's TimeoutReason. */
const NEXT_PROMPT_CALL_TIMEOUT = 'NEXT_PROMPT_CALL_TIMEOUT'

/**
 * Attempts per generation: the initial try plus AT MOST ONE lightweight retry
 * (contract 4). No backoff — the prediction is immediate and the retry budget
 * is tiny by design.
 */
const MAX_ATTEMPTS = 2

/** Options for one {@link NextPromptManager} (per-fiber, next to the runtimes map). */
export interface NextPromptManagerOptions {
  /**
   * Live SESSION-SCOPED effective-config read (the resolver SSOT), keyed by
   * the session the prediction chain acts for: consulted at arm time
   * (`onCompletedTurnEnd`), at fire time (`onDelta`) AND before EVERY
   * attempt inside the prediction chain, so a config edit anywhere in the
   * window can never start — or continue — a gated prediction call. The
   * wiring passes the session-aware `safeEffective` (the `/advisor on|off`
   * override and the session model pin are folded in — I-000024); a global
   * read here would let an off session keep predicting and ignore its pin.
   */
  readonly resolve: (sessionId: string) => ResolvedAdvisorConfig
  /** The llm service (`ctx.llm`), re-read per call; injectable for tests. */
  readonly llm: () => AdvisorLlm
  /** Logger seam (`ctx.logger('advisor')` satisfies it). */
  readonly logger: AdvisorRuntimeLogger
  /** Test seam: prediction call deadline. Default {@link NEXT_PROMPT_CALL_TIMEOUT_MS}. */
  readonly callTimeoutMs?: number
}

/** Per-session state: the armed slot, the fence generation, the stored text. */
interface NextPromptSessionState {
  /**
   * The session state's identity token (I-000026): allocated once from the
   * manager-level `nextStateId` counter — which survives `disposeSession`
   * because it lives on the manager, not in the map entry — so a rebuilt
   * same-id state NEVER reuses a predecessor's token and an in-flight
   * prediction armed under the old token can never commit into it, even
   * when the numeric generation restarts to the same value.
   */
  readonly id: number
  /** The single pending slot armed by `onCompletedTurnEnd`, consumed by `onDelta`. */
  pending: boolean
  /**
   * Fence generation (contract 3): bumped by every `onCompletedTurnEnd` and
   * every `onUserTurnStart`; an in-flight prediction result whose state id
   * or generation no longer matches is discarded wholesale.
   */
  generation: number
  /** The stored single-line suggestion, or null. */
  suggestion: string | null
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/**
 * A reply fully wrapped in ONE markdown fence: an opening fence line (with or
 * without an info string) and a closing fence at the very end (same shape the
 * prose fallback strips in `advisor-runtime.ts`).
 */
const SURROUNDING_FENCE_PATTERN = /^```[^\n]*\n([\s\S]*?)\n?```$/

/**
 * C0 control characters EXCEPT the whitespace ones (`\t` `\n` `\v` `\f` `\r`,
 * U+0009–U+000D — they are `\s`, so the whitespace collapse below normalizes
 * them into the single-line shape). The stripped remainder (NUL, backspace,
 * ESC, …) has no place in a user-visible suggestion and could spoof fence or
 * quote boundaries during shaping.
 */
const C0_CONTROL_PATTERN = /[\u0000-\u0008\u000E-\u001F]/g

/**
 * Unicode invisible marks (PR-review security-hygiene lead, round 2): every
 * character class that renders invisibly yet could flip or disguise the
 * displayed suggestion while the visible text reads as intended —
 * - U+00AD soft hyphen, U+061C Arabic letter mark, U+180E Mongolian vowel
 *   separator,
 * - U+200B–U+200F zero-width characters (ZWSP, ZWNJ, ZWJ, LRM, RLM),
 * - U+202A–U+202E bidi direction embedding/override characters,
 * - U+2060–U+2064 word joiner + invisible operators,
 * - U+2066–U+2069 bidi isolates,
 * - U+FEFF (BOM / zero-width no-break space),
 * - U+E0000–U+E007F tag characters (astral — hence the `u` flag).
 * They are stripped BEFORE the visible-empty and `NONE` checks, so a
 * marks-only reply stores nothing and `NO<U+2060>NE` cannot dodge the
 * nothing-predictable comparison.
 */
const INVISIBLE_MARK_PATTERN =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu

/**
 * Shape one predictor reply into the stored single-line suggestion (contract
 * 5): strip C0 control characters (keeping whitespace) and Unicode invisible
 * marks ({@link INVISIBLE_MARK_PATTERN} — before every later check) → trim →
 * strip ONE
 * surrounding code fence → strip ONE layer of surrounding quotes/backticks →
 * collapse every whitespace run (newlines included) to single spaces → reject
 * the empty result and the literal `NONE` (the "nothing predictable" marker
 * the system prompt pins) → truncate to {@link NEXT_PROMPT_MAX_CHARS} CODE
 * POINTS (never a UTF-16 slice: a unit-boundary cut could split a surrogate
 * pair and store a lone surrogate that renders as U+FFFD). Returns
 * `undefined` for a dropped reply. Never throws.
 */
function shapeNextPrompt(raw: string): string | undefined {
  let text = raw.replace(C0_CONTROL_PATTERN, '').replace(INVISIBLE_MARK_PATTERN, '').trim()
  const fence = SURROUNDING_FENCE_PATTERN.exec(text)
  if (fence !== null) text = fence[1]!.trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if (
      (first === '"' && last === '"')
      || (first === "'" && last === "'")
      || (first === '`' && last === '`')
    ) {
      text = text.slice(1, -1).trim()
    }
  }
  // Collapse ALL whitespace runs — the stored and served text is always
  // single-line, whatever line-broken shape the model produced.
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length === 0) return undefined
  // Case-insensitive: the prompt pins the literal `NONE`, but a lowercase
  // "none" means the same nothing-predictable signal.
  if (text.toUpperCase() === 'NONE') return undefined
  // Code-point truncation: count code points, not UTF-16 code units, so a
  // surrogate pair (any astral character, e.g. an emoji) is never split —
  // a unit-boundary cut would store a lone surrogate that renders as U+FFFD.
  const points = Array.from(text)
  return points.length > NEXT_PROMPT_MAX_CHARS ? points.slice(0, NEXT_PROMPT_MAX_CHARS).join('') : text
}

// ---------------------------------------------------------------------------
// Stream plumbing
// ---------------------------------------------------------------------------

/**
 * Race one async-iterator demand against a deadline signal (the same
 * containment the advisor runtime applies, scoped to this module): resolve
 * with the iterator's next result, or `'aborted'` when the signal aborts
 * first — a hung provider stream (no chunk, no end, no error) cannot wedge
 * the prediction even when the provider ignores the abort signal.
 */
function raceIteratorNext<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise<IteratorResult<T> | 'aborted'>((resolve, reject) => {
    const onAbort = (): void => resolve('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => {
          signal.removeEventListener('abort', onAbort)
          resolve(result)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
  })
}

// ---------------------------------------------------------------------------
// NextPromptManager
// ---------------------------------------------------------------------------

/**
 * Per-fiber next-prompt predictor (plan dsh-advisor-next-prompt-n12, T1).
 * Wired in `index.ts` next to the runtimes map: the observer's two callbacks
 * (`onCompletedTurnEnd` / `onUserTurnStart`) and the delta forwarding feed
 * it; disposal mirrors the per-session runtime lifecycle.
 *
 * All async work is fire-and-forget — the session/event hot path is never
 * parked, and a failing prediction can only drop its own suggestion.
 */
export class NextPromptManager {
  private readonly sessions = new Map<string, NextPromptSessionState>()
  /**
   * Manager-level state-id allocator (I-000026): monotonically increasing,
   * NEVER reset by `disposeSession`/`disposeAll` — a rebuilt same-id session
   * always gets a fresh token, invalidating every prediction armed before.
   */
  private nextStateId = 0
  private readonly callTimeoutMs: number

  constructor(private readonly options: NextPromptManagerOptions) {
    this.callTimeoutMs = options.callTimeoutMs ?? NEXT_PROMPT_CALL_TIMEOUT_MS
  }

  /**
   * One completed primary turn: bump the fence (any in-flight prediction for
   * the previous turn becomes stale) and arm the single pending slot — gated
   * on the resolver SSOT (`enabled` AND `nextPrompt`); a closed gate arms
   * nothing, so no prediction call can ever start (contract 1).
   */
  onCompletedTurnEnd(sessionId: string): void {
    const state = this.stateFor(sessionId)
    state.generation += 1
    const config = this.resolveConfig(sessionId)
    state.pending = config.enabled && config.nextPrompt
  }

  /**
   * One rendered delta (forwarded AFTER the review enqueue in `index.ts`):
   * the armed slot is consumed exactly once and the delta markdown becomes
   * the prediction context. The gate is re-checked at fire time — the live
   * config may have flipped between the arm and this delta — and AGAIN
   * before every attempt inside `predict` (I-000030), so no snapshot
   * carried here can outlive the gate.
   */
  onDelta(sessionId: string, delta: Delta): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined || !state.pending) return
    state.pending = false
    const config = this.resolveConfig(sessionId)
    if (!config.enabled || !config.nextPrompt) return
    // The provider/model pair is resolved per attempt inside `predict` —
    // passing a snapshot here would let a stale pair fund a retry after the
    // gate closed or the pin moved (I-000030).
    void this.predict(sessionId, state.id, state.generation, delta.markdown)
  }

  /**
   * The user started typing a new turn: bump the fence (an in-flight
   * prediction is superseded — its result is dropped when it settles) and
   * clear the stored suggestion immediately (contract 3).
   */
  onUserTurnStart(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    state.generation += 1
    state.suggestion = null
  }

  /** Read the stored suggestion (T2 serves this to the web client). */
  getSuggestion(sessionId: string): { suggestion: string | null } {
    return { suggestion: this.sessions.get(sessionId)?.suggestion ?? null }
  }

  /** Drop one session's state (wiring: `session/disposed` / `agent/disposed`). */
  disposeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Drop every session's state (wiring: the reviewer-claim teardown effect). */
  disposeAll(): void {
    this.sessions.clear()
  }

  private stateFor(sessionId: string): NextPromptSessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      // A fresh token per creation (I-000026): the allocator never rewinds.
      state = { id: this.nextStateId++, pending: false, generation: 0, suggestion: null }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * The per-session resolver read with qc2 W-1 containment: a throwing
   * resolver must never break the session/event hot path, so a failed read
   * fails CLOSED (no arm, no prediction call).
   */
  private resolveConfig(sessionId: string): ResolvedAdvisorConfig {
    try {
      return this.options.resolve(sessionId)
    } catch (error) {
      this.options.logger.debug('advisor: next-prompt config read failed — prediction skipped', {
        error,
      })
      return {
        enabled: false,
        systemPrompt: '',
        immuneTurns: 0,
        maxDeltaMessages: 60,
        nextPrompt: false,
        // Fail-closed placeholder (GitHub issue #124 adds the plain-boolean
        // field): the disabled gate already blocks every prediction, so the
        // concrete value is inert — keep the schema default for consistency.
        defaultEnabled: true,
      }
    }
  }

  /**
   * Whether the addressed session state is still the one a prediction was
   * armed under: the fence compares BOTH the state-identity token (I-000026
   * — a same-id dispose/rebuild always allocates a new token, so an older
   * in-flight result can never pass) AND the numeric generation (a newer
   * completed turn or user turn start on the SAME state supersedes).
   */
  private isCurrent(sessionId: string, stateId: number, generation: number): boolean {
    const state = this.sessions.get(sessionId)
    return state !== undefined && state.id === stateId && state.generation === generation
  }

  /**
   * Fire-and-forget prediction for one armed state (contract 4): at most one
   * immediate lightweight retry, every failure a silent debug drop, and a
   * fence re-check before every attempt AND before the commit — a result
   * computed for a superseded state (identity OR generation, `isCurrent`)
   * is discarded wholesale (contract 3). The SESSION-SCOPED gate is ALSO
   * re-read before every attempt (I-000030/I-000024 residual): a config flip
   * mid-chain (`/advisor off`, `nextPrompt: false`) aborts the chain
   * immediately — no further model call goes out — and a CHANGED
   * provider/model pair aborts too (this prediction is never re-routed; the
   * next turn predicts fresh under the new pair).
   */
  private async predict(
    sessionId: string,
    stateId: number,
    generation: number,
    context: string,
  ): Promise<void> {
    let text: string | undefined
    let pair: { readonly provider: string; readonly model: string } | undefined
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (!this.isCurrent(sessionId, stateId, generation)) return // superseded
      // Per-attempt gate re-read (I-000030): the first attempt's timing is
      // the provider's, so only a live read (never a snapshot) can stop the
      // chain the moment the session gate closes. A failed read fails CLOSED
      // (resolveConfig).
      const config = this.resolveConfig(sessionId)
      if (!config.enabled || !config.nextPrompt) return // gate closed mid-chain
      // `enabled` guarantees the pair (S4 gate) — the same non-null reads the
      // runtime construction in `index.ts` performs behind the same gate.
      const attemptPair = { provider: config.provider!, model: config.model! }
      if (pair !== undefined
        && (pair.provider !== attemptPair.provider || pair.model !== attemptPair.model)) {
        return // the pair changed mid-chain — do not re-route this prediction
      }
      pair = attemptPair
      const raw = await this.callOnce(context, attemptPair.provider, attemptPair.model, sessionId)
      text = raw === undefined ? undefined : shapeNextPrompt(raw)
      if (text !== undefined) break
    }
    if (text === undefined) {
      // Silent drop (contract 4): a failed prediction is never worth a warn —
      // the review chain is unaffected and the next turn re-arms anyway.
      this.options.logger.debug('advisor: next-prompt prediction dropped', { sessionId })
      return
    }
    if (!this.isCurrent(sessionId, stateId, generation)) return // superseded mid-flight
    this.sessions.get(sessionId)!.suggestion = text
  }

  /**
   * One `llm.stream` attempt: the prediction system prompt + the delta as the
   * single user message, bounded by its own dsh-timeout deadline (raced per
   * chunk like the review call, so a hung stream cannot wedge the attempt).
   * Transport failures (throw, deadline) resolve `undefined` — the caller's
   * retry budget covers them; there is no finish-reason contract here (the
   * collected text is the whole best-effort result).
   */
  private async callOnce(context: string, provider: string, model: string, sessionId: string): Promise<string | undefined> {
    let text = ''
    using deadlineHandle = deadline(undefined, this.callTimeoutMs, NEXT_PROMPT_CALL_TIMEOUT)
    const signal = deadlineHandle.signal
    try {
      const stream = this.options.llm().stream(this.buildOptions(context, provider, model, signal, sessionId))
      const iterator = stream[Symbol.asyncIterator]()
      for (;;) {
        const next = await raceIteratorNext(iterator, signal)
        if (next === 'aborted') {
          // The only abort source is this deadline (no upstream signal exists).
          // Best-effort teardown of a provider that may still be mid-flight.
          iterator.return?.().catch(() => {})
          return undefined
        }
        if (next.done) break
        const chunk = next.value
        if (chunk.type === 'text-delta') text += chunk.text
      }
    } catch {
      return undefined // provider error — silent drop (at most one retry)
    }
    return text
  }

  private buildOptions(context: string, provider: string, model: string, signal: AbortSignal, sessionId: string): GenerateOptions {
    return {
      provider,
      model,
      system: DEFAULT_NEXT_PROMPT_SYSTEM_PROMPT,
      messages: [createUserMessage({
        content: [{ type: 'text', text: context }],
        source: { kind: 'user' },
      })],
      // The conversation this prediction belongs to: providers that route per
      // conversation on a request header (OpenCode Go's `x-opencode-session`)
      // refuse a request without it.
      sessionId: sessionId as SessionId,
      signal,
      // An ordinary conversation request — `purpose` stays unset, like the
      // review call (KD-5).
    }
  }
}

// ---------------------------------------------------------------------------
// Suggestion read face (the gateway's `AdvisorSuggestionFace`)
// ---------------------------------------------------------------------------

/**
 * Build the elected owner's read-only suggestion face (plan
 * dsh-advisor-next-prompt-n12, T2 — I-000024): the SAME manager the observer
 * feeds, gated by the SESSION-SCOPED resolver on every read. A closed gate
 * (`!enabled` — a `/advisor off` session, or an S4-blocked one — or
 * `!nextPrompt`) answers the empty suggestion WITHOUT consulting the
 * manager, so no stale stored value can leak past a session-scoped flip;
 * an open gate serves the stored text (a pinned-pair session included — the
 * pinned pair rides `enabled`, so the suggestion reaches the web surface).
 * The wiring passes its `safeEffective` wrapper, so a throwing resolver
 * stays contained there; this factory adds no second error layer.
 */
export function advisorSuggestionFace(
  resolve: (sessionId: string) => ResolvedAdvisorConfig,
  manager: NextPromptManager,
): AdvisorSuggestionFace {
  return {
    getSuggestion(sessionId) {
      const config = resolve(sessionId)
      if (!config.enabled || !config.nextPrompt) return { suggestion: null }
      return manager.getSuggestion(sessionId)
    },
  }
}
