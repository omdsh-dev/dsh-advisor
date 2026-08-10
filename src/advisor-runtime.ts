/**
 * Per-session advisor runtime (spec §2 S2, §4 mapping rows, §6, §8.2 KD-2,
 * §8.5 KD-5) — the "advisor model call + note extraction + drain/backlog"
 * core.
 *
 * One {@link AdvisorRuntime} exists per session (created on `agent/created` or
 * lazily on the first stepped `turn/end`, disposed on `agent/disposed` /
 * `session/disposed` — wired in `index.ts`). It owns:
 *
 * - a FIFO queue of pending transcript deltas (bounded — spec §6 "bounded
 *   backlog"; drop-newest when full);
 * - a serialized async drain loop: one `llm.stream` call per delta with
 *   `{ provider, model, system, messages: [user delta], maxTokens: 256 }` and
 *   `purpose` left UNSET (KD-5 — an advisor call is an ordinary conversation
 *   request);
 * - a call-level deadline on every `llm.stream` call (dsh-timeout `deadline`,
 *   fused with the dispose signal and raced per chunk): a hung provider stream
 *   times out instead of wedging the drain, and a timeout is a transient
 *   failure (KD-5 retry → drop);
 * - KD-2 JSON-frame extraction: the first balanced `{…}` in the reply is
 *   parsed (tolerant of prose/fences), `note` must be non-empty (else
 *   drop+log), `severity` missing/invalid defaults to `nit`, no parse retry;
 * - the KD-5 failure policy: transient → 1 retry with a short backoff → drop;
 *   3 consecutive dropped deltas → flush the pending backlog (never stall);
 *   permanent errors (`invalid_request_error`, model-not-found, "is not
 *   supported when") → halt the session's advisor; quota/rate-limit → pause
 *   (`quota_exhausted`), batch retained, no auto-resume timer; the in-flight
 *   call is aborted on dispose via the `signal`. `halted` is terminal in
 *   place — the command layer rebuilds the runtime (dispose + recreate); a
 *   `quota_exhausted` runtime resumes via {@link AdvisorRuntime.resume}.
 *
 * The runtime never parks the primary loop: everything is fire-and-forget
 * async and a failing advisor can only drop its own backlog.
 *
 * @module dsh-advisor/advisor-runtime
 */

import { createUserMessage, isQuotaExceededError } from '@deepseek-ai/dsh-llm'
import { INVALID_CREDENTIAL_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { createEmissionGuard } from './emission-guard'
import type { EmissionGuard } from './emission-guard'
import type { Delta } from './transcript'

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** Severity vocabulary (spec §6) carried by every delivered advice note. */
export type AdviceSeverity = 'nit' | 'concern' | 'blocker'

/** One extracted advice note, fed to the T5 emission guard for delivery. */
export interface AdviceNote {
  readonly note: string
  readonly severity: AdviceSeverity
}

/**
 * Per-session runtime status surface for T7 `/advisor status`.
 *
 * T4 sets `running` | `quota_exhausted` | `halted`; `paused` is reserved for
 * explicit pause semantics and `disabled` for the config gate — the runtime is
 * never constructed in either state (`index.ts` returns early when the resolved
 * config is disabled).
 */
export type AdvisorRuntimeStatus = 'running' | 'paused' | 'quota_exhausted' | 'halted' | 'disabled'

/** Minimal `ctx.llm` surface the runtime drives (satisfied by `LlmService`). */
export interface AdvisorLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Logger seam (cordis `ctx.logger('advisor')` satisfies it; console works too). */
export interface AdvisorRuntimeLogger {
  debug(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** Options for one per-session {@link AdvisorRuntime}. */
export interface AdvisorRuntimeOptions {
  /** Resolved provider route (the explicit gate guarantees it when enabled). */
  readonly provider: string
  /** Resolved model id (the explicit gate guarantees it when enabled). */
  readonly model: string
  /** System prompt sent with every advisor call (config override or KD-2 default). */
  readonly systemPrompt: string
  /** Output-token cap (KD-2); default 256. */
  readonly maxTokens?: number
  /** Backoff for the single transient retry (KD-5); default 1000ms. */
  readonly retryBackoffMs?: number
  /**
   * Call-level deadline for one `llm.stream` call (qc2 W-4 / qc3 W-1): a hung
   * provider stream (no chunk, no end, no error) times out instead of wedging
   * this session's drain. A timeout is classified as a transient failure —
   * KD-5 retry(1) → drop. Default 60000ms.
   */
  readonly callTimeoutMs?: number
  /** Bounded backlog (spec §6); default 32 — drop-newest with a log when full. */
  readonly maxQueued?: number
  /** The llm service (`ctx.llm`); injectable for tests. */
  readonly llm: AdvisorLlm
  /**
   * The T5 emission guard gating extracted notes before delivery. Defaults to
   * a fresh {@link createEmissionGuard} (per-runtime lifetime — a new guard
   * per session); injectable for tests.
   */
  readonly guard?: EmissionGuard
  /**
   * Invoked once per extracted note that passes the T5 emission guard
   * (accepted = delivered to T6; suppressed notes are dropped silently).
   */
  readonly onNote: (note: AdviceNote) => void
  readonly logger?: AdvisorRuntimeLogger
}

/** Pinned policy values (KD-2 / KD-5). */
const DEFAULT_MAX_TOKENS = 256
const DEFAULT_RETRY_BACKOFF_MS = 1_000
const DEFAULT_MAX_QUEUED = 32
/** Whole-call deadline for one `llm.stream` (qc2 W-4 / qc3 W-1); see `callTimeoutMs`. */
const DEFAULT_CALL_TIMEOUT_MS = 60_000
/** Capability-owned code stamped onto the deadline's TimeoutReason. */
const ADVISOR_CALL_TIMEOUT = 'ADVISOR_CALL_TIMEOUT'
/** Transient retries after the first attempt (KD-5: retry(1) → drop). */
const MAX_TRANSIENT_ATTEMPTS = 1
/** Consecutive dropped deltas after which the pending backlog is flushed (KD-5). */
const MAX_CONSECUTIVE_DROPS = 3

// ---------------------------------------------------------------------------
// KD-2 — JSON-frame note extraction
// ---------------------------------------------------------------------------

/**
 * Yield every top-level balanced `{…}` region of `text`, skipping braces
 * inside string literals so a quoted `{`/`}` never corrupts the balance.
 */
function* balancedObjects(text: string): Generator<string> {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      if (start < 0) {
        start = index
        depth = 1
      } else {
        depth++
      }
    } else if (char === '}') {
      if (start >= 0 && --depth === 0) {
        yield text.slice(start, index + 1)
        start = -1
      }
    }
  }
}

/**
 * Extract one {@link AdviceNote} from the advisor's reply (KD-2).
 *
 * Locates the first balanced `{…}` object (tolerant of surrounding prose and
 * markdown fences), parses it, and validates: `note` must be a non-empty
 * string after trim (else drop), `severity` missing/invalid defaults to
 * `nit`. A reply with no parseable frame returns `undefined` — the caller
 * drops + logs, and there is NO retry for parse failures (the retry budget is
 * reserved for transport errors, KD-2). Never throws.
 */
export function extractAdviceNote(reply: string): AdviceNote | undefined {
  for (const frame of balancedObjects(reply)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(frame)
    } catch {
      continue // not JSON — try the next balanced region
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    const note = record.note
    if (typeof note !== 'string' || note.trim().length === 0) continue // KD-2: drop empty note
    const severity = record.severity
    return {
      note: note.trim(),
      severity: severity === 'concern' || severity === 'blocker' ? severity : 'nit',
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// KD-5 — failure classification
// ---------------------------------------------------------------------------

type FailureClass = 'transient' | 'quota' | 'permanent'

/**
 * omp's permanent-rejection wording (see the advisor runtime it ports): a
 * request the provider refuses outright for this advisor configuration — no
 * retry can fix it. Halting avoids re-attempting on every new delta forever.
 */
const PERMANENT_FAILURE_PATTERN = /invalid_request_error|model[_ ]not[_ ]found|is not supported when|does not exist/i

/** Classify one provider failure per KD-5 (quota/rate-limit → pause, permanent → halt). */
function classifyFailure(failure: LlmFailure): FailureClass {
  if (
    failure.code === QUOTA_EXCEEDED_CODE
    || failure.code === 'RATE_LIMIT'
    || isQuotaExceededError(failure.message)
  ) {
    return 'quota'
  }
  if (
    failure.code === INVALID_CREDENTIAL_CODE
    || failure.code === 'NO_ADAPTER'
    || PERMANENT_FAILURE_PATTERN.test(failure.message)
  ) {
    return 'permanent'
  }
  return 'transient'
}

/** Minimal provider-neutral failure snapshot from a thrown value. */
function normalizeFailure(value: unknown): LlmFailure {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code
    return {
      message: value.message,
      code: typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN',
    }
  }
  return { message: String(value), code: 'UNKNOWN' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Race one async-iterator demand against a deadline signal: resolve with the
 * iterator's next result, or `'aborted'` when the signal aborts first. A
 * provider error rejects through the race (the caller classifies it). This is
 * what makes a hung stream (no chunk, no end, no error) terminable even when
 * the provider ignores the abort signal — the runtime never depends on the
 * provider honoring `signal` (qc2 W-4 / qc3 W-1).
 */
function raceIteratorNext<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise<IteratorResult<T> | 'aborted'>((resolve, reject) => {
    const onAbort = () => resolve('aborted')
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
// AdvisorRuntime
// ---------------------------------------------------------------------------

/** Outcome of processing one delta through {@link AdvisorRuntime.processDelta}. */
type ProcessResult =
  | { readonly kind: 'note' }
  | { readonly kind: 'no-note' }  // model call succeeded but the reply carried no valid note (KD-2 drop)
  | { readonly kind: 'drop' }     // transient failure exhausted the retry budget
  | { readonly kind: 'requeue' }  // quota pause — the batch is retained
  | { readonly kind: 'halt' }     // permanent error — the session's advisor stops
  | { readonly kind: 'aborted' }  // dispose aborted the in-flight call

/** Result of one {@link AdvisorRuntime.callModel} attempt. */
type CallResult =
  | { readonly kind: 'note'; readonly note: AdviceNote }
  | { readonly kind: 'no-note' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failure'; readonly failure: LlmFailure }

/**
 * Per-session advisor runtime: queue deltas, async drain, `llm.stream` call,
 * JSON-frame note extraction, and the KD-5 failure policy. All async work is
 * fire-and-forget — the primary loop is never parked.
 */
export class AdvisorRuntime {
  private readonly provider: string
  private readonly model: string
  private readonly systemPrompt: string
  private readonly maxTokens: number
  private readonly retryBackoffMs: number
  private readonly callTimeoutMs: number
  private readonly maxQueued: number
  private readonly llm: AdvisorLlm
  private readonly guard: EmissionGuard
  private readonly onNote: (note: AdviceNote) => void
  private readonly logger: AdvisorRuntimeLogger
  private readonly controller = new AbortController()

  private readonly queue: Delta[] = []
  private state: AdvisorRuntimeStatus = 'running'
  private draining = false
  private disposed = false
  private consecutiveDrops = 0
  private drainPromise: Promise<void> | undefined
  /** Epoch-ms of the last note accepted by the emission guard (T7 status). */
  private lastActivityAt: number | undefined

  constructor(options: AdvisorRuntimeOptions) {
    this.provider = options.provider
    this.model = options.model
    this.systemPrompt = options.systemPrompt
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED
    this.llm = options.llm
    this.guard = options.guard ?? createEmissionGuard()
    this.onNote = options.onNote
    this.logger = options.logger ?? console
  }

  /** Current per-session status (T7 `/advisor status` surface). */
  status(): AdvisorRuntimeStatus {
    return this.state
  }

  /** Number of deltas waiting to be drained (bounded by `maxQueued`). */
  get pendingCount(): number {
    return this.queue.length
  }

  /**
   * T7 `/advisor status` surface — epoch-ms of the last note accepted by the
   * emission guard, or `undefined` before the first accepted note.
   */
  get lastActivity(): number | undefined {
    return this.lastActivityAt
  }

  /**
   * Queue one rendered transcript delta (from the T3 observer's `onDelta`).
   * While `quota_exhausted`, deltas queue up (bounded) but the drain is never
   * auto-restarted (KD-5 — no auto-resume timer); while `halted`/disposed they
   * are dropped with a log. Never throws, never parks the caller.
   */
  enqueue(delta: Delta): void {
    if (this.disposed) {
      this.logger.debug('advisor: enqueue ignored — runtime disposed')
      return
    }
    if (this.state === 'halted') {
      this.logger.debug('advisor: enqueue ignored — advisor halted')
      return
    }
    if (this.queue.length >= this.maxQueued) {
      // simplify: FIFO queue with drop-newest when full. A full queue means the
      // advisor is far behind; the newest delta is the most redundant. A
      // coalescing batch (omp-style) would be the upgrade path.
      this.logger.debug('advisor: enqueue dropped — backlog full', { maxQueued: this.maxQueued })
      return
    }
    this.queue.push(delta)
    if (this.state === 'quota_exhausted') return // paused: retain, never auto-resume
    this.kickDrain()
  }

  /** Abort the in-flight call and stop the drain (wiring: session/agent disposed). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort('advisor disposed')
    this.queue.length = 0
    this.consecutiveDrops = 0
  }

  /**
   * Manual resume after a quota pause (T7 `/advisor on`); no-op when halted/
   * disposed — a halted runtime is terminal in place and is recovered by the
   * command layer via dispose-and-recreate (qc1/qc2/qc3 W-1/I-4), never
   * resumed here.
   */
  resume(): void {
    if (this.disposed || this.state === 'halted') return
    this.state = 'running'
    this.kickDrain()
  }

  /**
   * KD-5 reset trigger: a compaction / surface rewrite clears the emission
   * guard's dedupe history and per-update latch — the session state is being
   * rewritten, so the old note history no longer applies (a note already
   * advised before the rewrite may legitimately be advised again). The wiring
   * (`index.ts` onRewrite) calls this alongside the delivery cooldown reset.
   */
  resetGuard(): void {
    this.guard.reset()
  }

  /** Resolve once the current drain run settles (test/integration hook). */
  async waitForDrain(): Promise<void> {
    await this.drainPromise
  }

  private kickDrain(): void {
    if (this.draining || this.disposed) return
    if (this.state === 'quota_exhausted' || this.state === 'halted') return
    this.drainPromise = this.drain().catch((error) => {
      // Defense in depth: the drain is fire-and-forget, so a rejection here
      // would be an unhandled promise rejection (process crash under Node
      // ≥22/24 defaults). A failing advisor may only drop its own backlog —
      // per-batch errors stay contained inside callModel.
      this.logger.warn('advisor: drain loop failed — contained', { error })
    })
  }

  /** Serialized drain loop: process the queue one delta at a time. */
  private async drain(): Promise<void> {
    this.draining = true
    try {
      while (
        !this.disposed
        && this.queue.length > 0
        && this.state !== 'quota_exhausted'
        && this.state !== 'halted'
      ) {
        const delta = this.queue.shift()!
        switch ((await this.processDelta(delta)).kind) {
          case 'note':
          case 'no-note':
            // A completed model call breaks the failure streak — extraction
            // failures (KD-2 drops) are output-quality issues, not transport
            // failures, and do not count toward the 3-drop flush.
            this.consecutiveDrops = 0
            break
          case 'drop':
            this.consecutiveDrops++
            if (this.consecutiveDrops >= MAX_CONSECUTIVE_DROPS) this.flushBacklog()
            break
          case 'requeue':
            this.queue.unshift(delta) // quota pause: batch retained for a later resume
            return
          case 'halt':
            this.flushBacklog() // halted: drop any still-pending backlog
            return
          case 'aborted':
            return
        }
      }
    } finally {
      this.draining = false
    }
  }

  /** KD-5: clear the pending backlog after consecutive failures (never stall). */
  private flushBacklog(): void {
    this.consecutiveDrops = 0
    if (this.queue.length === 0) return
    const flushed = this.queue.length
    this.queue.length = 0
    this.logger.warn('advisor: flushed pending backlog after consecutive failures', { flushed })
  }

  /** Process one delta: attempt + single retry (transient), classify terminal failures. */
  private async processDelta(delta: Delta): Promise<ProcessResult> {
    // One advisor model cycle per delta: the emission guard's one-note-per-
    // update latch resets here, so each processed delta may deliver one note
    // again (spec §6; the reset point is the drain's per-delta boundary).
    this.guard.beginUpdate()
    for (let attempt = 0; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        if (this.disposed) return { kind: 'aborted' }
        await sleep(this.retryBackoffMs)
        if (this.disposed) return { kind: 'aborted' }
      }
      const result = await this.callModel(delta)
      if (result.kind === 'note' || result.kind === 'no-note' || result.kind === 'aborted') return result
      switch (classifyFailure(result.failure)) {
        case 'quota':
          this.state = 'quota_exhausted'
          this.logger.warn('advisor: quota/rate-limit reached — paused, batch retained', { failure: result.failure })
          return { kind: 'requeue' }
        case 'permanent':
          this.state = 'halted'
          this.logger.warn('advisor: permanent model error — halted', { failure: result.failure })
          return { kind: 'halt' }
        case 'transient':
          break // retry once (the loop's next iteration)
      }
    }
    this.logger.warn('advisor: dropping delta after transient failures', { attempts: MAX_TRANSIENT_ATTEMPTS + 1 })
    return { kind: 'drop' }
  }

  /** One model call: build options, stream text, extract the note (KD-2). */
  private async callModel(delta: Delta): Promise<CallResult> {
    let text = ''
    let finish: FinishReason | undefined
    // Call-level deadline (dsh-timeout): fuses the runtime's dispose signal
    // with a whole-call timer. The fused signal is passed to the provider
    // (AbortSignal honored) AND raced per chunk below, so a hung stream cannot
    // wedge the drain even when the provider ignores the signal. A timeout is
    // a transient failure — KD-5 retry(1) → drop (qc2 W-4 / qc3 W-1).
    using deadlineHandle = deadline(this.controller.signal, this.callTimeoutMs, ADVISOR_CALL_TIMEOUT)
    const deadlineSignal = deadlineHandle.signal
    try {
      const stream = this.llm.stream(this.buildOptions(delta, deadlineSignal))
      const iterator = stream[Symbol.asyncIterator]()
      for (;;) {
        const next = await raceIteratorNext(iterator, deadlineSignal)
        if (next === 'aborted') {
          // Best-effort teardown of a provider that may still be mid-flight;
          // never await a hung teardown (it may never settle).
          iterator.return?.().catch(() => {})
          if (timeoutOf(deadlineSignal, ADVISOR_CALL_TIMEOUT) !== undefined) {
            return {
              kind: 'failure',
              failure: { message: `advisor call timed out after ${this.callTimeoutMs}ms`, code: 'TIMEOUT' },
            }
          }
          return { kind: 'aborted' } // dispose aborted the in-flight call
        }
        if (next.done) break
        const chunk = next.value
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish') finish = chunk.reason
      }
    } catch (error) {
      return { kind: 'failure', failure: normalizeFailure(error) }
    }
    if (finish === undefined) {
      return { kind: 'failure', failure: { message: 'advisor stream ended without a finish chunk', code: 'UNKNOWN' } }
    }
    if (finish.kind === 'error') return { kind: 'failure', failure: finish.failure }
    if (finish.kind === 'aborted') {
      // Our own dispose aborts the in-flight call; a provider-side abort is a
      // terminal failure like any other. A deadline timeout surfaced as a
      // provider abort (rather than through the per-chunk race) is still the
      // transient timeout case — KD-5 retry once → drop.
      if (timeoutOf(deadlineSignal, ADVISOR_CALL_TIMEOUT) !== undefined) {
        return {
          kind: 'failure',
          failure: { message: `advisor call timed out after ${this.callTimeoutMs}ms`, code: 'TIMEOUT' },
        }
      }
      if (this.disposed || this.controller.signal.aborted) return { kind: 'aborted' }
      return { kind: 'failure', failure: finish.failure }
    }
    // stop | max-tokens | tool-calls: extract from the collected text (KD-2;
    // no retry on parse failures — the frame must simply be absent/valid).
    const note = extractAdviceNote(text)
    if (note === undefined) {
      this.logger.debug('advisor: reply yielded no note — dropped (KD-2)')
      return { kind: 'no-note' }
    }
    try {
      // The T5 emission guard sits between extraction and delivery: only
      // accepted notes reach the delivery callback (T6). Suppression is
      // silent — the caller cannot tell an accepted from a suppressed note,
      // and a guard failure must never crash the drain (T4 F1 containment).
      if (this.guard.accept(note)) {
        // T7: timestamp the moment a note is accepted for delivery (before
        // onNote, so a throwing delivery seam cannot lose the activity
        // record) — surfaced by `/advisor status` as "last activity".
        this.lastActivityAt = Date.now()
        this.onNote(note)
      } else {
        this.logger.debug('advisor: note suppressed by emission guard', {
          note: note.note,
          severity: note.severity,
        })
      }
    } catch (error) {
      // The emission guard / delivery seam must never crash the drain: log
      // and continue. The model call itself succeeded — this is not a
      // transport failure, so retry/drop/quota/halt semantics are untouched
      // and the note still counts as extracted.
      this.logger.warn('advisor: emission guard or delivery callback threw — contained', { error })
    }
    return { kind: 'note', note }
  }

  private buildOptions(delta: Delta, signal: AbortSignal): GenerateOptions {
    return {
      provider: this.provider,
      model: this.model,
      system: this.systemPrompt,
      messages: [createUserMessage({
        content: [{ type: 'text', text: delta.markdown }],
        source: { kind: 'user' },
      })],
      maxTokens: this.maxTokens,
      signal,
      // KD-5: `purpose` is a closed union ('compaction' | 'session-title'); an
      // advisor call is an ordinary conversation request and leaves it unset.
    }
  }
}
