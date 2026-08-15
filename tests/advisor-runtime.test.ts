/**
 * T4 — advisor model call + note extraction + drain/backlog
 * (spec §2 S2, §4 mapping rows, §6 delivery semantics, §8.2 KD-2, §8.5 KD-5).
 *
 * Contract under test:
 * - `AdvisorRuntime` (per-session): `enqueue(delta)` queues a rendered transcript
 *   delta and asynchronously drains it — one `llm.stream` call per delta with
 *   `{ provider, model, system, messages: [user delta], maxTokens: 5120 }` and
 *   `purpose` left UNSET (KD-5). Extracted `{note, severity}` is handed to the
 *   `onNote` hook (the T5 emission guard wraps it).
 * - JSON-frame extraction (KD-2): first balanced `{…}` parsed, tolerant of
 *   surrounding prose/fences; `note` non-empty else drop+log; missing/invalid
 *   `severity` defaults to `nit`; no frame → drop+log, no model retry.
 * - Failure policy (KD-5): transient → 1 retry with a short backoff → drop;
 *   3 consecutive dropped deltas → flush the pending backlog; permanent errors
 *   (`invalid_request_error`, model-not-found, "is not supported when") → halt
 *   with status; quota/rate-limit → pause (`quota_exhausted`), batch retained,
 *   no auto-resume timer; in-flight call aborted on dispose via the signal;
 *   never park the primary.
 * - Bounded backlog (spec §6): `maxQueued` (default 32) bounds the waiting
 *   queue; a delta enqueued while the queue is full is dropped at enqueue
 *   (drop-newest) with a `debug` log carrying `{ maxQueued }`, an in-flight
 *   delta does not count against the bound, and accepted deltas drain in FIFO
 *   order.
 * - No model call when the config is disabled (explicit gate, S4) — verified at
 *   the plugin `apply` level.
 *
 * Most tests drive the runtime directly with an injected fake `llm.stream`
 * (per the brief); one composed test registers a stub `LlmAdapter` on a real
 * `LlmRuntime` to prove the registration/dispatch path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
// The overlay shim (`export *`) forwards named exports but not the package
// default, so `LlmRuntime` (named export of @deepseek-ai/dsh-llm) is imported
// by name, not as the default.
import { LlmRuntime, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { AdvisorRuntime, ADVISOR_MAX_TOKENS, ADVISOR_NOTE_MAX_CHARS, extractAdviceNote } from '../src/advisor-runtime'
import type { AdvisorLlm, AdvisorRuntimeOptions, AdvisorRuntimeStatus, AdviceNote } from '../src/advisor-runtime'
import type { Delta } from '../src/transcript'
import { apply } from '../src/index'
import type { AdvisorConfig } from '../src/config'
import { DEFAULT_ADVISOR_SYSTEM_PROMPT } from '../src/prompts'

// n4 QC F-6: the single-reviewer guard is process-global; each test case
// composes a fresh harness, so the flag must reset between cases (production
// keeps the first-claim-wins behavior).
beforeEach(() => {
  delete (globalThis as Record<string, unknown>)['__dshAdvisorReviewer__']
})


// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TEST_SYSTEM_PROMPT = 'You are an independent reviewer for a coding session.'

/** A rendered transcript delta (shape produced by T3's DeltaRenderer). */
const delta = (markdown: string): Delta => ({ markdown, willContinue: false })

/**
 * Scripted fake for the runtime's `llm` option: records calls, replays responses.
 * `gate` = a releasable hang (settings-live `GatedAdapter` pattern): the stream
 * blocks until the gate resolves, then yields `chunks` — used to hold a delta
 * in flight while the backlog fills (spec §6 drop-newest tests).
 */
type FakeResponse =
  | { readonly chunks: readonly StreamChunk[] }
  | { readonly throw: Error }
  | { readonly hang: true }
  | { readonly gate: Promise<void>; readonly chunks: readonly StreamChunk[] }

/** Simulated model capability for {@link FakeLlm.resolveModelInfo}. */
type FakeCapability = 'off' | 'none' | 'throw'

class FakeLlm {
  readonly calls: GenerateOptions[] = []

  constructor(
    private readonly responses: readonly FakeResponse[],
    /** 'off' = deepseek-style declared efforts (default); 'none' = base adapter, no reasoning metadata; 'throw' = resolution failure. Public + mutable: the no-latch test flips it mid-runtime. */
    public capability: FakeCapability = 'off',
  ) {}

  resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.capability === 'throw') return Promise.reject(new Error('capability resolution failed'))
    return Promise.resolve(
      this.capability === 'off'
        ? {
            provider,
            id: model,
            name: model,
            reasoning: {
              efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }],
              defaultEffort: ReasoningEffortId('off'),
            },
          }
        : { provider, id: model, name: model },
    )
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const response = this.responses[this.calls.length - 1]
    if (response === undefined) {
      throw new Error(`FakeLlm: unexpected stream call #${this.calls.length} (script exhausted)`)
    }
    if ('throw' in response) throw response.throw
    if ('hang' in response) {
      // A black-holed provider stream: never yields, never ends, never rejects —
      // and it ignores the abort signal. The drain must still un-wedge via the
      // call-level deadline (qc2 W-4 / qc3 W-1).
      return (async function* () {
        await new Promise<void>(() => {})
      })()
    }
    if ('gate' in response) {
      // A releasable hang: block on the gate, then replay the reply. Unlike the
      // black-hole `hang`, the blocked call completes once the test resolves
      // the gate, so the drain can finish and the backlog semantics can be
      // asserted end to end.
      return (async function* () {
        await response.gate
        yield * response.chunks
      })()
    }
    return streamOf(response.chunks)
  }
}

async function* streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  yield * chunks
}

/**
 * Fake whose `resolveModelInfo` honors the abort signal (dsh-llm's contract —
 * "signal - optional cancellation for adapter-owned asynchronous lookup"): the
 * FIRST resolution hangs until the passed signal aborts (rejecting with
 * AbortError); the SECOND resolves immediately with 'off'. This pins the
 * no-latch contract (n4 QC N-5): an aborted resolution is a failure, NOT a
 * definitive verdict, so the KD-5 retry re-resolves with a fresh deadline
 * instead of reusing a latched `undefined`. With NO signal (the pre-fix
 * behavior) the first resolution would hang forever — exactly the
 * wedged-drain failure the fix removes.
 */
class SignalBoundLlm {
  readonly resolveSignals: Array<AbortSignal | undefined> = []
  readonly calls: GenerateOptions[] = []
  private resolutions = 0

  constructor(private readonly reply: readonly StreamChunk[]) {}

  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.resolveSignals.push(signal)
    this.resolutions++
    if (this.resolutions === 1) {
      if (signal === undefined) return new Promise(() => {}) // no signal → hang forever
      return new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }],
        defaultEffort: ReasoningEffortId('off'),
      },
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    return streamOf(this.reply)
  }
}

/** Chunk script for a successful text reply. */
const textReply = (text: string): readonly StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Chunk script for a terminal provider error. */
const errorReply = (failure: LlmFailure): readonly StreamChunk[] => [
  { type: 'finish', reason: { kind: 'error', failure } },
]

const transientFailure = (): LlmFailure => ({ message: 'upstream server error', code: 'SERVER' })
const quotaFailure = (): LlmFailure => ({
  message: 'insufficient_quota: you exceeded your current quota, please check your billing',
  code: 'QUOTA',
})
const permanentFailure = (): LlmFailure => ({
  message: "the model 'gpt-5' is not supported when using Codex with a ChatGPT account (invalid_request_error)",
  code: 'INVALID_REQUEST',
})

function makeRuntime(llm: AdvisorLlm, overrides: Partial<AdvisorRuntimeOptions> = {}): {
  runtime: AdvisorRuntime
  notes: AdviceNote[]
} {
  const notes: AdviceNote[] = []
  const runtime = new AdvisorRuntime({
    provider: 'test-provider',
    model: 'test-model',
    systemPrompt: TEST_SYSTEM_PROMPT,
    llm,
    onNote: (note) => notes.push(note),
    retryBackoffMs: 0,
    ...overrides,
  })
  return { runtime, notes }
}

// ---------------------------------------------------------------------------
// Drain — one llm.stream call per delta with the expected options
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — drain calls llm.stream once per delta with expected options', () => {
  it('enqueues the delta as a user message and emits the extracted note', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"extract the helper","severity":"concern"}') }])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('### Session update\n\n**user**: fix the bug'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'extract the helper', severity: 'concern' }])
    expect(llm.calls).toHaveLength(1)
    const options = llm.calls[0]!
    expect(options).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
      system: TEST_SYSTEM_PROMPT,
      maxTokens: ADVISOR_MAX_TOKENS,
      reasoningEffort: 'off',
    })
    // KD-5: purpose is a closed union and must be left unset for an advisor call.
    expect(options.purpose).toBeUndefined()
    expect('purpose' in options).toBe(false)
    expect(options.signal).toBeDefined()
    expect(options.messages).toHaveLength(1)
    const message = options.messages[0]!
    expect(message.role).toBe('user')
    expect(message.content[0]).toEqual({ type: 'text', text: '### Session update\n\n**user**: fix the bug' })
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })

  it('calls the model once per delta, serialized per session', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"first"}') },
      { chunks: textReply('{"note":"second","severity":"blocker"}') },
    ])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(notes).toEqual([
      { note: 'first', severity: 'nit' },
      { note: 'second', severity: 'blocker' },
    ])
    expect(llm.calls).toHaveLength(2)
    const textOf = (options: GenerateOptions): string => {
      const block = options.messages[0]!.content[0]!
      return block.type === 'text' ? block.text : ''
    }
    expect(textOf(llm.calls[0]!)).toBe('update one')
    expect(textOf(llm.calls[1]!)).toBe('update two')
  })

  it('exposes the configured default system prompt (KD-2 reviewer contract)', () => {
    for (const token of ['nit', 'concern', 'blocker', '{"note"', '"severity"']) {
      expect(DEFAULT_ADVISOR_SYSTEM_PROMPT).toContain(token)
    }
  })

  it('omits reasoningEffort when the model declares no reasoning capability (W-1 fallback — no UNSUPPORTED_REASONING_EFFORT)', async () => {
    // Base-adapter shape: resolveModel returns { provider, id, name } with NO
    // reasoning metadata (the pre-n4 non-deepseek path). The advisor call must
    // still succeed — the option is omitted and resolveCallFor materializes
    // the adapter default instead of throwing.
    const llm = new FakeLlm([{ chunks: textReply('{"note":"plain model works"}') }], 'none')
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('### Session update\n\n**user**: fix the bug'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'plain model works', severity: 'nit' }])
    expect(llm.calls).toHaveLength(1)
    const options = llm.calls[0]!
    expect(options).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
      system: TEST_SYSTEM_PROMPT,
      maxTokens: ADVISOR_MAX_TOKENS,
    })
    expect('reasoningEffort' in options).toBe(false)
  })

  it('a capability-resolution failure also omits reasoningEffort and never fails the call', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"resilient"}') }], 'throw')
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'resilient', severity: 'nit' }])
    expect(llm.calls).toHaveLength(1)
    expect('reasoningEffort' in llm.calls[0]!).toBe(false)
  })

  it('does not latch a resolution failure: a later definitive resolution re-advertises reasoningEffort', async () => {
    // First delta: the capability resolution throws — the failure is advisory
    // and must NOT be cached as a permanent no-'off' verdict. Second delta:
    // the same runtime, but the model now declares 'off' — the fresh
    // resolution re-advertises it (a latched `undefined` would drop
    // thinking-off for the runtime's lifetime).
    const llm = new FakeLlm(
      [
        { chunks: textReply('{"note":"first"}') },
        { chunks: textReply('{"note":"second"}') },
      ],
      'throw',
    )
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('update one'))
    await runtime.waitForDrain()
    expect(notes).toEqual([{ note: 'first', severity: 'nit' }])
    expect(llm.calls).toHaveLength(1)
    expect('reasoningEffort' in llm.calls[0]!).toBe(false)

    llm.capability = 'off'
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(notes).toEqual([
      { note: 'first', severity: 'nit' },
      { note: 'second', severity: 'nit' },
    ])
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1]!.reasoningEffort).toBe(ReasoningEffortId('off'))
    // Closed whitelist on both calls (T2-style): call 0 has no reasoningEffort
    // (the failure is not a verdict), call 1 re-advertises 'off' after the
    // fresh resolution — same key set minus/plus reasoningEffort.
    expect(Object.keys(llm.calls[0]!).sort()).toEqual(['maxTokens', 'messages', 'model', 'provider', 'signal', 'system'])
    expect(Object.keys(llm.calls[1]!).sort()).toEqual(['maxTokens', 'messages', 'model', 'provider', 'reasoningEffort', 'signal', 'system'])
    // Zero tools contract: no advisor call ever carries a tools key.
    expect('tools' in llm.calls[0]!).toBe(false)
    expect('tools' in llm.calls[1]!).toBe(false)
  })

  it('logs the thinking-off-unavailable line once per runtime, not per call', async () => {
    const debug = vi.fn()
    const warn = vi.fn()
    const llm = new FakeLlm(
      [
        { chunks: textReply('{"note":"first"}') },
        { chunks: textReply('{"note":"second"}') },
      ],
      'none',
    )
    const { runtime, notes } = makeRuntime(llm, { logger: { debug, warn } })

    runtime.enqueue(delta('update one'))
    await runtime.waitForDrain()
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(notes).toEqual([
      { note: 'first', severity: 'nit' },
      { note: 'second', severity: 'nit' },
    ])
    // The definitive no-'off' verdict is logged once; the second delta hits
    // the cached verdict and stays silent.
    const unavailable = debug.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.startsWith('advisor: thinking-off unavailable'),
    )
    expect(unavailable).toHaveLength(1)
  })

  it('never logs the thinking-off-unavailable line for a resolution failure', async () => {
    const debug = vi.fn()
    const warn = vi.fn()
    const llm = new FakeLlm(
      [
        { chunks: textReply('{"note":"first"}') },
        { chunks: textReply('{"note":"second"}') },
      ],
      'throw',
    )
    const { runtime, notes } = makeRuntime(llm, { logger: { debug, warn } })

    runtime.enqueue(delta('update one'))
    await runtime.waitForDrain()
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(notes).toEqual([
      { note: 'first', severity: 'nit' },
      { note: 'second', severity: 'nit' },
    ])
    // Resolution failures get no log-once latch of their own: the unavailable
    // line never fires on a throw.
    const unavailable = debug.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.startsWith('advisor: thinking-off unavailable'),
    )
    expect(unavailable).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC-1 closed whitelist — every advisor GenerateOptions is a minimal start:
// exact key set, zero tools, single user delta (regression pin, T2)
// KD-6 (§8.6) regression pin
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — minimal request shape (AC-1 closed whitelist)', () => {
  it('sends a minimal request with capability off: exact key whitelist, zero tools, single user delta', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"minimal"}') }], 'off')
    const { runtime } = makeRuntime(llm)

    runtime.enqueue(delta('### Session update\n\n**user**: fix the bug'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(1)
    const options = llm.calls[0]!
    // Closed whitelist (AC-1): the exact sorted key set, nothing more.
    expect(Object.keys(options).sort()).toEqual(['maxTokens', 'messages', 'model', 'provider', 'reasoningEffort', 'signal', 'system'])
    // Zero-tools contract; no temperature/stop tuning; no purpose (KD-5).
    expect('tools' in options).toBe(false)
    expect('temperature' in options).toBe(false)
    expect('stop' in options).toBe(false)
    expect('purpose' in options).toBe(false)
    // Single user delta with the configured system prompt and token cap.
    expect(options.messages).toHaveLength(1)
    expect(options.messages[0]!.role).toBe('user')
    expect(options.system).toBe(TEST_SYSTEM_PROMPT)
    // KD-6 frozen value (= ADVISOR_MAX_TOKENS)
    expect(options.maxTokens).toBe(5120)
  })

  it('sends the same minimal request without reasoningEffort when the model has no reasoning capability', async () => {
    const llm = new FakeLlm([{ chunks: textReply('{"note":"minimal"}') }], 'none')
    const { runtime } = makeRuntime(llm)

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(1)
    const options = llm.calls[0]!
    // Closed whitelist minus reasoningEffort (capability 'none' → not advertised).
    expect(Object.keys(options).sort()).toEqual(['maxTokens', 'messages', 'model', 'provider', 'signal', 'system'])
    expect('reasoningEffort' in options).toBe(false)
    expect('tools' in options).toBe(false)
    expect('temperature' in options).toBe(false)
    expect('stop' in options).toBe(false)
    expect('purpose' in options).toBe(false)
    expect(options.messages).toHaveLength(1)
    expect(options.messages[0]!.role).toBe('user')
    expect(options.system).toBe(TEST_SYSTEM_PROMPT)
    // KD-6 frozen value (= ADVISOR_MAX_TOKENS)
    expect(options.maxTokens).toBe(5120)
  })
})

// ---------------------------------------------------------------------------
// Delivery seam — a throwing onNote must never crash the drain (F1)
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — a throwing onNote is contained (F1)', () => {
  it('logs, continues the drain, and never rejects the kicker promise', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('{"note":"first"}') },
      { chunks: textReply('{"note":"second","severity":"concern"}') },
    ])
    const { runtime } = makeRuntime(llm, {
      onNote: () => {
        throw new Error('delivery exploded')
      },
    })

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    // The drain kicker (drainPromise) must resolve, not reject — an unhandled
    // rejection here would crash the process under Node ≥22/24 defaults.
    await expect(runtime.waitForDrain()).resolves.toBeUndefined()

    expect(llm.calls).toHaveLength(2) // the drain continued past both throws
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// JSON-frame extraction (KD-2)
// ---------------------------------------------------------------------------

describe('extractAdviceNote — JSON frame parsing (KD-2)', () => {
  it('parses a valid framed note with an explicit severity', () => {
    expect(extract('{"note":"check the loop","severity":"blocker"}')).toEqual({
      note: 'check the loop',
      severity: 'blocker',
    })
  })

  it('defaults a missing severity to nit', () => {
    expect(extract('{"note":"minor style point"}')).toEqual({ note: 'minor style point', severity: 'nit' })
  })

  it('defaults an invalid severity to nit', () => {
    expect(extract('{"note":"odd","severity":"critical"}')).toEqual({ note: 'odd', severity: 'nit' })
    expect(extract('{"note":"odd","severity":42}')).toEqual({ note: 'odd', severity: 'nit' })
  })

  it('is tolerant of surrounding prose and markdown fences', () => {
    expect(extract('```json\n{"note":"fenced","severity":"concern"}\n```')).toEqual({
      note: 'fenced',
      severity: 'concern',
    })
    expect(extract('Here is my review:\n{"note":"prose first"}')).toEqual({ note: 'prose first', severity: 'nit' })
  })

  it('skips an empty-note frame and accepts a later valid frame', () => {
    expect(extract('{"note":""}\n{"note":"the real note","severity":"concern"}')).toEqual({
      note: 'the real note',
      severity: 'concern',
    })
  })

  it('drops a whitespace-only note (drop + log, never crash)', () => {
    expect(extract('{"note":"   "}')).toBeUndefined()
  })

  it('drops a reply with no parseable frame (no model retry)', () => {
    expect(extract('no frame here')).toBeUndefined()
    expect(extract('{"note":')).toBeUndefined()
    expect(extract('[]')).toBeUndefined()
  })

  it('caps an over-long note at ADVISOR_NOTE_MAX_CHARS with a truncation marker (qc3 F-2)', () => {
    const longNote = 'x'.repeat(ADVISOR_NOTE_MAX_CHARS + 500)
    const result = extract(`{"note":"${longNote}","severity":"concern"}`)
    expect(result).toBeDefined()
    expect(result!.severity).toBe('concern')
    expect(result!.note.length).toBe(ADVISOR_NOTE_MAX_CHARS)
    expect(result!.note.endsWith('…')).toBe(true)
    expect(result!.note.slice(0, ADVISOR_NOTE_MAX_CHARS - 1)).toBe('x'.repeat(ADVISOR_NOTE_MAX_CHARS - 1))
  })

  it('keeps a note within the cap untouched', () => {
    expect(extract('{"note":"short note"}')).toEqual({ note: 'short note', severity: 'nit' })
  })
})

/** Local alias so the extraction tests read naturally. */
function extract(reply: string): AdviceNote | undefined {
  return extractAdviceNote(reply)
}

// ---------------------------------------------------------------------------
// Failure policy (KD-5) — transient retry, drop, flush, pause, halt
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — failure policy (KD-5)', () => {
  it('retries a transient failure once after the backoff, then drops the delta', async () => {
    vi.useFakeTimers()
    try {
      const llm = new FakeLlm([{ throw: new Error('server error') }, { throw: new Error('server error') }])
      const { runtime, notes } = makeRuntime(llm, { retryBackoffMs: 1_000 })

      runtime.enqueue(delta('first update'))
      // The capability resolution (resolveModelInfo) is an async pre-step, so
      // the first attempt lands after a microtask hop rather than synchronously.
      await vi.waitFor(() => expect(llm.calls).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(llm.calls).toHaveLength(2)
      expect(notes).toEqual([])
      expect(runtime.pendingCount).toBe(0)
      expect(runtime.status()).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a failed delta (adapter throw) and continues with later deltas', async () => {
    const llm = new FakeLlm([
      { throw: new Error('server error') },
      { throw: new Error('server error') },
      { chunks: textReply('{"note":"recovered"}') },
    ])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('bad update'))
    runtime.enqueue(delta('good update'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'recovered', severity: 'nit' }])
    expect(llm.calls).toHaveLength(3) // 2 attempts on the failed delta + 1 on the good one
    expect(runtime.status()).toBe('running')
  })

  it('flushes the pending backlog after 3 consecutive dropped deltas', async () => {
    const llm = new FakeLlm([
      { throw: new Error('server error') },
      { throw: new Error('server error') },
      { throw: new Error('server error') },
      { throw: new Error('server error') },
      { throw: new Error('server error') },
      { throw: new Error('server error') },
    ])
    const { runtime, notes } = makeRuntime(llm)

    // Five deltas: the first three are dropped (each after its retry); the
    // third drop trips the flush, which clears the two still-queued deltas.
    for (let index = 1; index <= 5; index++) runtime.enqueue(delta(`update ${index}`))
    await runtime.waitForDrain()

    expect(notes).toEqual([])
    expect(llm.calls).toHaveLength(6) // 3 deltas × (attempt + retry); queued deltas never dispatched
    expect(runtime.pendingCount).toBe(0)
  })

  it('times out a hung stream (no chunk, no end, no error), drops it per KD-5, and the drain continues', async () => {
    // The first two calls hang forever (attempt + single retry); the third
    // succeeds. The call-level deadline must classify each hang as a transient
    // timeout → KD-5 retry(1) → drop — the drain is never wedged (qc2 W-4 /
    // qc3 W-1), even though the provider ignores the abort signal.
    const llm = new FakeLlm([
      { hang: true },
      { hang: true },
      { chunks: textReply('{"note":"recovered","severity":"concern"}') },
    ])
    const { runtime, notes } = makeRuntime(llm, { callTimeoutMs: 20 })

    runtime.enqueue(delta('hung update'))
    runtime.enqueue(delta('good update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(3) // hung attempt + hung retry + the recovered delta
    expect(notes).toEqual([{ note: 'recovered', severity: 'concern' }])
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })

  // KD-6 (§8.6) regression pin
  it('does not latch a deadline-aborted capability resolution — the retry re-resolves and delivers (n4 QC N-5)', async () => {
    const llm = new SignalBoundLlm(textReply('{"note":"resolution bounded"}'))
    const { runtime, notes } = makeRuntime(llm, { callTimeoutMs: 20 })

    runtime.enqueue(delta('update'))
    await runtime.waitForDrain()

    // Attempt 1: the deadline signal reached the capability resolution
    // (threaded through, N-5) and aborted it — a transient timeout, NOT a
    // definitive verdict. The abort is not cached, so the KD-5 retry
    // re-resolves with a fresh deadline instead of reusing a latched
    // `undefined`.
    expect(llm.resolveSignals).toHaveLength(2)
    expect(llm.resolveSignals[0]).toBeInstanceOf(AbortSignal)
    expect(llm.resolveSignals[0]!.aborted).toBe(true)
    expect(llm.resolveSignals[1]).toBeInstanceOf(AbortSignal)
    // The retry re-resolves with a FRESH, non-aborted signal — the abort was
    // not latched and is not reused (n4 QC N-5 / qc3 S-2).
    expect(llm.resolveSignals[1]!.aborted).toBe(false)
    // Attempt 2 re-resolved 'off' — the option is back on the retry, the note
    // is delivered, and the whole drain stayed deadline-bounded.
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1]!.reasoningEffort).toBe(ReasoningEffortId('off'))
    expect(notes).toEqual([{ note: 'resolution bounded', severity: 'nit' }])
    expect(runtime.status()).toBe('running')
  })

  it('a timeout is a transient failure: the single retry gets a fresh deadline and can succeed', async () => {
    // Attempt 1 hangs → timeout; the KD-5 retry (fresh deadline) succeeds.
    const llm = new FakeLlm([
      { hang: true },
      { chunks: textReply('{"note":"slow but recovered"}') },
    ])
    const { runtime, notes } = makeRuntime(llm, { callTimeoutMs: 20 })

    runtime.enqueue(delta('slow update'))
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(2)
    expect(notes).toEqual([{ note: 'slow but recovered', severity: 'nit' }])
    expect(runtime.status()).toBe('running')
  })

  it('pauses on quota/rate-limit with the batch retained and no auto-resume', async () => {
    const llm = new FakeLlm([
      { chunks: errorReply(quotaFailure()) },
      { chunks: textReply('{"note":"after resume"}') },
      { chunks: textReply('{"note":"queued while paused"}') },
    ])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('first'))
    await runtime.waitForDrain()
    expect(runtime.status()).toBe('quota_exhausted')
    expect(runtime.pendingCount).toBe(1) // the batch is requeued, not dropped
    expect(llm.calls).toHaveLength(1)

    // No auto-resume: new deltas queue up but no model call starts.
    runtime.enqueue(delta('second'))
    await Promise.resolve()
    expect(llm.calls).toHaveLength(1)
    expect(runtime.pendingCount).toBe(2)

    // Manual resume (T7 `/advisor on` path) drains the retained + queued batch.
    runtime.resume()
    await runtime.waitForDrain()
    expect(notes).toEqual([
      { note: 'after resume', severity: 'nit' },
      { note: 'queued while paused', severity: 'nit' },
    ])
    expect(llm.calls).toHaveLength(3) // quota call + retained batch + queued delta
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })

  it('halts on a permanent error and drops subsequent deltas without calling the model', async () => {
    const llm = new FakeLlm([{ chunks: errorReply(permanentFailure()) }])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('first'))
    await runtime.waitForDrain()
    expect(runtime.status()).toBe('halted')
    expect(notes).toEqual([])
    expect(llm.calls).toHaveLength(1)

    runtime.enqueue(delta('second'))
    await runtime.waitForDrain()
    expect(llm.calls).toHaveLength(1) // halted: never called again
    expect(runtime.pendingCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Bounded backlog (spec §6) — drop-newest with a debug log when the queue is full
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — bounded backlog drop-newest (spec §6)', () => {
  /** Manually-resolvable promise — releases a gated `FakeLlm` stream on demand. */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }

  /** Delta markdown carried by one recorded `llm.stream` call (drain-test pattern). */
  const textOf = (options: GenerateOptions): string => {
    const block = options.messages[0]!.content[0]!
    return block.type === 'text' ? block.text : ''
  }

  it('drops the newest delta when the backlog is full, while a delta is in flight', async () => {
    // The first delta is held in flight on a releasable gate (the drain parks
    // on the stream's first `next()`), so the queue fills to `maxQueued`
    // deterministically — no wall-clock timing.
    const gate = deferred()
    const llm = new FakeLlm([
      { gate: gate.promise, chunks: textReply('{"note":"first"}') },
      { chunks: textReply('{"note":"second"}') },
      { chunks: textReply('{"note":"third"}') },
    ])
    const debug = vi.fn()
    const warn = vi.fn()
    const { runtime, notes } = makeRuntime(llm, { maxQueued: 2, logger: { debug, warn } })

    runtime.enqueue(delta('update one'))
    await vi.waitFor(() => expect(llm.calls).toHaveLength(1)) // dequeued + in flight
    expect(runtime.pendingCount).toBe(0)

    // The queue fills to maxQueued (2) while the first delta is still in flight.
    runtime.enqueue(delta('update two'))
    runtime.enqueue(delta('update three'))
    expect(runtime.pendingCount).toBe(2)

    // Backlog full → drop-newest: the next delta is refused at enqueue and
    // never dispatched to the model.
    runtime.enqueue(delta('update four'))
    expect(runtime.pendingCount).toBe(2)
    expect(llm.calls).toHaveLength(1)

    // Observability (spec §6): the drop is logged with the maxQueued payload.
    expect(debug).toHaveBeenCalledWith('advisor: enqueue dropped — backlog full', { maxQueued: 2 })

    // Release the in-flight call: the accepted deltas drain in FIFO order and
    // the dropped delta never appears.
    gate.resolve()
    await runtime.waitForDrain()

    expect([textOf(llm.calls[0]!), textOf(llm.calls[1]!), textOf(llm.calls[2]!)]).toEqual([
      'update one',
      'update two',
      'update three',
    ])
    expect(notes).toEqual([
      { note: 'first', severity: 'nit' },
      { note: 'second', severity: 'nit' },
      { note: 'third', severity: 'nit' },
    ])
    expect(llm.calls).toHaveLength(3)
    expect(runtime.pendingCount).toBe(0)
    expect(runtime.status()).toBe('running')
  })

  it('retains FIFO order for accepted deltas when the queue fills from capacity-1', async () => {
    // maxQueued 3: one delta in flight (gated) + three queued = the queue sits
    // at capacity; the next delta is dropped at enqueue; the accepted four
    // drain in enqueue order.
    const gate = deferred()
    const llm = new FakeLlm([
      { gate: gate.promise, chunks: textReply('{"note":"first"}') },
      { chunks: textReply('{"note":"second"}') },
      { chunks: textReply('{"note":"third"}') },
      { chunks: textReply('{"note":"fourth"}') },
    ])
    const { runtime } = makeRuntime(llm, { maxQueued: 3 })

    runtime.enqueue(delta('update one'))
    await vi.waitFor(() => expect(llm.calls).toHaveLength(1)) // in flight

    runtime.enqueue(delta('update two'))
    runtime.enqueue(delta('update three'))
    runtime.enqueue(delta('update four')) // queue reaches maxQueued (3)
    expect(runtime.pendingCount).toBe(3)
    runtime.enqueue(delta('update five')) // dropped — the queue is full
    expect(runtime.pendingCount).toBe(3)
    expect(llm.calls).toHaveLength(1)

    gate.resolve()
    await runtime.waitForDrain()

    expect(llm.calls).toHaveLength(4)
    expect([
      textOf(llm.calls[0]!),
      textOf(llm.calls[1]!),
      textOf(llm.calls[2]!),
      textOf(llm.calls[3]!),
    ]).toEqual(['update one', 'update two', 'update three', 'update four'])
    expect(runtime.pendingCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle — dispose aborts the in-flight call and stops the drain
// ---------------------------------------------------------------------------

describe('AdvisorRuntime — dispose (KD-5 in-flight abort)', () => {
  /** Fake that suspends until the request signal aborts, then reports aborted. */
  class SignalAwaitingLlm {
    calls = 0
    readonly signals: AbortSignal[] = []

    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.calls++
      const signal = options.signal
      this.signals.push(signal!)
      return (async function* () {
        if (signal === undefined) throw new Error('expected an abort signal')
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
      })()
    }
  }

  it('aborts the in-flight call via the signal, clears the queue, and ignores later enqueues', async () => {
    const llm = new SignalAwaitingLlm()
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('in flight'))
    runtime.enqueue(delta('queued'))
    // Capability resolution is an async pre-step; the first delta's stream
    // call lands after a microtask hop, the second stays queued.
    await vi.waitFor(() => expect(llm.calls).toBe(1)) // first delta in flight, second still queued

    runtime.dispose()
    await runtime.waitForDrain()

    expect(llm.signals[0]!.aborted).toBe(true) // in-flight call aborted via the signal
    expect(runtime.pendingCount).toBe(0)       // queued delta cleared on dispose
    expect(notes).toEqual([])

    runtime.enqueue(delta('after dispose'))
    await runtime.waitForDrain()
    expect(llm.calls).toBe(1) // no new calls after dispose
  })
})

// ---------------------------------------------------------------------------
// Composed contexts — real LlmRuntime + stub adapter registration
// ---------------------------------------------------------------------------

class RecordingAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string, _signal?: undefined): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('off') },
    })
  }

  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script
  }
}

describe('AdvisorRuntime — composed with a real LlmRuntime + registered adapter', () => {
  it('dispatches through ctx.llm.registerAdapter with the expected options', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter([...textReply('{"note":"registered adapter works"}')])
    ctx.llm.registerAdapter(['test-provider'], adapter)

    const notes: AdviceNote[] = []
    const runtime = new AdvisorRuntime({
      provider: 'test-provider',
      model: 'test-model',
      systemPrompt: TEST_SYSTEM_PROMPT,
      llm: ctx.llm,
      onNote: (note) => notes.push(note),
    })
    runtime.enqueue(delta('### Session update\n\n**agent**: wrote the tests'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'registered adapter works', severity: 'nit' }])
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
      system: TEST_SYSTEM_PROMPT,
      maxTokens: ADVISOR_MAX_TOKENS,
      reasoningEffort: 'off',
    })
    expect(adapter.requests[0]!.purpose).toBeUndefined()
    expect('purpose' in adapter.requests[0]!).toBe(false)
  })

  it('never starts a model call when the config is disabled (explicit gate, S4)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter([...textReply('{"note":"should never be called"}')])
    ctx.llm.registerAdapter(['test-provider'], adapter)

    apply(ctx, { enabled: false } as AdvisorConfig)

    // A full stepped turn would otherwise render a delta and dispatch a call.
    const events = buildEvents(minimalTurn())
    const session = { id: 's1', events } as unknown as Session
    for (const event of events) {
      ctx.emit('session/event', session, event)
    }
    expect(adapter.requests).toEqual([])
  })
})

/** Base-adapter stub: `resolveModel` returns NO reasoning metadata (W-1 path). */
class NoReasoningAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script
  }
}

describe('AdvisorRuntime — capability-gated reasoningEffort against a real LlmRuntime (W-1)', () => {
  it('a registered adapter WITHOUT reasoning metadata yields a note with no reasoningEffort sent', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new NoReasoningAdapter([...textReply('{"note":"plain model works","severity":"nit"}')])
    ctx.llm.registerAdapter(['plain'], adapter)

    const notes: AdviceNote[] = []
    const runtime = new AdvisorRuntime({
      provider: 'plain',
      model: 'plain-model',
      systemPrompt: TEST_SYSTEM_PROMPT,
      llm: ctx.llm,
      onNote: (note) => notes.push(note),
    })
    runtime.enqueue(delta('### Session update\n\n**agent**: wrote the tests'))
    await runtime.waitForDrain()

    // The real LlmRuntime would throw UNSUPPORTED_REASONING_EFFORT if the
    // runtime sent an explicit effort for this model — the capability gate
    // omits it, resolveCallFor materializes nothing, and the note arrives.
    expect(notes).toEqual([{ note: 'plain model works', severity: 'nit' }])
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'plain',
      model: 'plain-model',
      system: TEST_SYSTEM_PROMPT,
      maxTokens: ADVISOR_MAX_TOKENS,
    })
    expect('reasoningEffort' in adapter.requests[0]!).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Synthetic session event builders (mirror of the transcript test fixtures)
// ---------------------------------------------------------------------------

interface EventSpec {
  type: string
  data: unknown
  surfaceOp?: string
}

function buildEvents(specs: readonly EventSpec[]): SessionEvent[] {
  return specs.map((spec, index) => {
    const event: Record<string, unknown> = {
      type: spec.type,
      seq: index,
      time: 1_000 + index,
      data: spec.data,
    }
    if (spec.surfaceOp !== undefined) event.surfaceOp = spec.surfaceOp
    return event as unknown as SessionEvent
  })
}

/** One standard stepped turn ending in a reviewable `completed` reason. */
function minimalTurn(): EventSpec[] {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'do the thing' }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}
