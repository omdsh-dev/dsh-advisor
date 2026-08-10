/**
 * T5 — emission guard (spec §4 mapping row, §6 one-note-per-update,
 * §8.2 KD-2 "guard also drops extras").
 *
 * Contract under test:
 * - `EmissionGuard.accept(note)` sits between the T4 runtime and delivery
 *   (T6): `true` = pass through to the delivery callback, `false` = silently
 *   suppressed (no error is thrown — the caller cannot tell why).
 * - Normalization: lowercase → NFKC → every run of non-alphanumeric
 *   characters collapsed to one space → trimmed, so `"Stop."`, `*stop*` and
 *   `"  STOP  "` all key to the same normalized note.
 * - Content-free phrase suppression: the omp base list
 *   (`stop`/`done`/`complete`/`no issue continue`/`lgtm`/`nothing to add`)
 *   plus documented equivalents are suppressed; matching is exact on the
 *   normalized text (a note that merely contains a phrase is not suppressed).
 * - Dedupe: a normalized note already accepted this session is dropped, with
 *   a FIFO-bounded history (default 4096, omp parity); a real escalation
 *   (nit → concern → blocker) of the same note is still accepted while
 *   equal/lower-severity repeats are suppressed.
 * - One note per update: at most one note per advisor model cycle; the
 *   per-update latch resets when the runtime signals a new cycle
 *   (`beginUpdate()`, once per processed delta).
 * - `reset()` clears the history and the per-update latch (session reset /
 *   new session).
 * - Wiring: the runtime calls `guard.accept(note)` between extraction and
 *   the delivery callback and only invokes the callback for accepted notes;
 *   a throwing guard is contained per T4 F1 (never crashes the drain).
 */

import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  CONTENT_FREE_PHRASES,
  DEFAULT_MAX_HISTORY,
  EmissionGuard,
  createEmissionGuard,
} from '../src/emission-guard'
import { AdvisorRuntime } from '../src/advisor-runtime'
import type { AdvisorLlm, AdvisorRuntimeOptions, AdviceNote } from '../src/advisor-runtime'
import type { Delta } from '../src/transcript'

// ---------------------------------------------------------------------------
// Normalization equivalence
// ---------------------------------------------------------------------------

describe('EmissionGuard — normalization (spec §4)', () => {
  it('keys equivalent spellings of the same note to one identity', () => {
    const guard = new EmissionGuard()
    expect(guard.accept({ note: 'Add a guard.', severity: 'nit' })).toBe(true)
    guard.beginUpdate()
    expect(guard.accept({ note: '*add a guard*', severity: 'nit' })).toBe(false)
    guard.beginUpdate()
    expect(guard.accept({ note: '  ADD A GUARD  ', severity: 'nit' })).toBe(false)
  })

  it('NFKC-normalizes full-width and compatibility characters', () => {
    const guard = new EmissionGuard()
    expect(guard.accept({ note: 'ｈｅｌｐ', severity: 'nit' })).toBe(true) // full-width → 'help'
    guard.beginUpdate()
    expect(guard.accept({ note: 'help', severity: 'nit' })).toBe(false)
  })

  it('collapses every run of non-alphanumeric characters to one space', () => {
    const guard = new EmissionGuard()
    expect(guard.accept({ note: 'stop... this loop', severity: 'nit' })).toBe(true)
    guard.beginUpdate()
    expect(guard.accept({ note: 'stop—this loop', severity: 'nit' })).toBe(false) // ellipsis vs em-dash
  })
})

// ---------------------------------------------------------------------------
// Content-free phrase suppression
// ---------------------------------------------------------------------------

describe('EmissionGuard — content-free phrase suppression (spec §4)', () => {
  it('suppresses the omp base content-free phrases', () => {
    for (const phrase of ['stop', 'done', 'complete', 'no issue continue', 'lgtm', 'nothing to add']) {
      expect(new EmissionGuard().accept({ note: phrase, severity: 'nit' }), `phrase: ${phrase}`).toBe(false)
    }
  })

  it('suppresses casing/punctuation variants of content-free phrases', () => {
    for (const variant of ['Stop.', 'DONE!', 'LGTM.', 'Nothing to add']) {
      expect(new EmissionGuard().accept({ note: variant, severity: 'nit' }), `variant: ${variant}`).toBe(false)
    }
  })

  it('suppresses documented equivalent phrases (additions beyond the omp base)', () => {
    const additions = [
      'ok', 'okay', 'good', 'fine', 'looks good', 'looks fine', 'all good',
      'all clear', 'no issue', 'no issues', 'nothing', 'looks good to me',
    ]
    for (const phrase of additions) {
      expect(CONTENT_FREE_PHRASES.has(phrase), `phrase ${phrase} is in the list`).toBe(true)
      expect(new EmissionGuard().accept({ note: phrase, severity: 'nit' }), `phrase: ${phrase}`).toBe(false)
    }
  })

  it('suppresses a punctuation-only or whitespace-only note (normalizes to empty)', () => {
    expect(new EmissionGuard().accept({ note: '   ', severity: 'nit' })).toBe(false)
    expect(new EmissionGuard().accept({ note: '!!!', severity: 'nit' })).toBe(false)
  })

  it('does not suppress a note that merely contains a content-free phrase (exact match)', () => {
    expect(new EmissionGuard().accept({ note: 'stop the infinite loop', severity: 'concern' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Dedupe across updates
// ---------------------------------------------------------------------------

describe('EmissionGuard — normalized dedupe across updates', () => {
  it('drops a repeat of an already-accepted note in a later update', () => {
    const guard = new EmissionGuard()
    expect(guard.accept({ note: 'use a guard here', severity: 'nit' })).toBe(true)
    guard.beginUpdate()
    expect(guard.accept({ note: 'Use a guard here!', severity: 'nit' })).toBe(false)
    guard.beginUpdate()
    expect(guard.accept({ note: 'use a guard differently', severity: 'nit' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Per-update rate limit
// ---------------------------------------------------------------------------

describe('EmissionGuard — one note per update (spec §6, §8.2)', () => {
  it('accepts at most one note per update, even for distinct notes', () => {
    const guard = new EmissionGuard()
    expect(guard.accept({ note: 'first note', severity: 'nit' })).toBe(true)
    expect(guard.accept({ note: 'second note', severity: 'concern' })).toBe(false) // distinct, same update
    guard.beginUpdate()
    expect(guard.accept({ note: 'second note', severity: 'concern' })).toBe(true) // fresh update
  })
})

// ---------------------------------------------------------------------------
// Severity escalation
// ---------------------------------------------------------------------------

describe('EmissionGuard — escalation allowed, equal/lower repeats suppressed', () => {
  it('accepts nit → concern → blocker escalations of the same note', () => {
    const guard = new EmissionGuard()
    expect(guard.accept({ note: 'the loop spins forever', severity: 'nit' })).toBe(true)
    guard.beginUpdate()
    expect(guard.accept({ note: 'the loop spins forever', severity: 'concern' })).toBe(true)
    guard.beginUpdate()
    expect(guard.accept({ note: 'the loop spins forever', severity: 'blocker' })).toBe(true)
  })

  it('suppresses equal or lower-severity repeats after the accepted level', () => {
    const guard = new EmissionGuard()
    expect(guard.accept({ note: 'the loop spins forever', severity: 'blocker' })).toBe(true)
    guard.beginUpdate()
    expect(guard.accept({ note: 'the loop spins forever', severity: 'blocker' })).toBe(false) // equal
    guard.beginUpdate()
    expect(guard.accept({ note: 'the loop spins forever', severity: 'concern' })).toBe(false) // downgrade
    guard.beginUpdate()
    expect(guard.accept({ note: 'the loop spins forever', severity: 'nit' })).toBe(false) // downgrade
  })
})

// ---------------------------------------------------------------------------
// FIFO history bound
// ---------------------------------------------------------------------------

describe('EmissionGuard — FIFO-bounded dedupe history', () => {
  it('defaults to the omp bound (4096)', () => {
    expect(DEFAULT_MAX_HISTORY).toBe(4096)
  })

  it('evicts the oldest accepted note past the bound and accepts it again', () => {
    const guard = new EmissionGuard({ maxHistory: 2 })
    expect(guard.accept({ note: 'a', severity: 'nit' })).toBe(true)
    guard.beginUpdate()
    expect(guard.accept({ note: 'b', severity: 'nit' })).toBe(true)
    guard.beginUpdate()
    expect(guard.accept({ note: 'c', severity: 'nit' })).toBe(true) // evicts 'a'
    guard.beginUpdate()
    expect(guard.accept({ note: 'a', severity: 'nit' })).toBe(true) // evicted → treated as new, pushes out 'b'
    guard.beginUpdate()
    expect(guard.accept({ note: 'c', severity: 'nit' })).toBe(false) // 'c' is still tracked
    guard.beginUpdate()
    expect(guard.accept({ note: 'b', severity: 'nit' })).toBe(true) // 'b' was evicted → new again
  })
})

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe('EmissionGuard — reset clears state', () => {
  it('clears the dedupe history and the per-update latch', () => {
    const guard = new EmissionGuard()
    expect(guard.accept({ note: 'a', severity: 'nit' })).toBe(true)
    expect(guard.accept({ note: 'b', severity: 'nit' })).toBe(false) // per-update latch engaged
    guard.reset()
    expect(guard.accept({ note: 'a', severity: 'nit' })).toBe(true) // history cleared
    expect(guard.accept({ note: 'a', severity: 'nit' })).toBe(false) // and the latch is fresh
  })
})

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('createEmissionGuard — factory (plan T5)', () => {
  it('creates a working EmissionGuard', () => {
    const guard = createEmissionGuard()
    expect(guard).toBeInstanceOf(EmissionGuard)
    expect(guard.accept({ note: 'x', severity: 'nit' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Runtime wiring — only accepted notes reach the delivery callback
// ---------------------------------------------------------------------------

/** A rendered transcript delta (shape produced by T3's DeltaRenderer). */
const delta = (markdown: string): Delta => ({ markdown, willContinue: false })

async function* streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  yield * chunks
}

/** Fake llm: records calls, replays one JSON-framed text reply per call. */
class ScriptedLlm implements AdvisorLlm {
  readonly calls: GenerateOptions[] = []

  constructor(private readonly replies: readonly string[]) {}

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const text = this.replies[this.calls.length - 1]
    if (text === undefined) throw new Error(`ScriptedLlm: script exhausted after ${this.calls.length} calls`)
    return streamOf([
      { type: 'text-delta', index: 0, text },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  }
}

function makeRuntime(
  llm: AdvisorLlm,
  overrides: Partial<AdvisorRuntimeOptions> = {},
): { runtime: AdvisorRuntime; notes: AdviceNote[] } {
  const notes: AdviceNote[] = []
  const runtime = new AdvisorRuntime({
    provider: 'test-provider',
    model: 'test-model',
    systemPrompt: 'test system prompt',
    llm,
    onNote: (note) => notes.push(note),
    ...overrides,
  })
  return { runtime, notes }
}

describe('AdvisorRuntime — emission guard wiring (T5)', () => {
  it('delivers only accepted notes to the delivery callback (dedupe across updates)', async () => {
    const llm = new ScriptedLlm(['{"note":"repeat me"}', '{"note":"repeat me"}'])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(notes).toEqual([{ note: 'repeat me', severity: 'nit' }])
    expect(llm.calls).toHaveLength(2) // the second call happened; only its note was suppressed
    expect(runtime.status()).toBe('running')
  })

  it('accepts a fresh note in each update (per-delta latch reset)', async () => {
    const llm = new ScriptedLlm(['{"note":"first"}', '{"note":"second"}'])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    await runtime.waitForDrain()

    expect(notes).toEqual([
      { note: 'first', severity: 'nit' },
      { note: 'second', severity: 'nit' },
    ])
    expect(llm.calls).toHaveLength(2)
  })

  it('continues draining after a suppressed note (suppression is not a transport failure)', async () => {
    const llm = new ScriptedLlm(['{"note":"same"}', '{"note":"same"}', '{"note":"brand new"}'])
    const { runtime, notes } = makeRuntime(llm)

    runtime.enqueue(delta('one'))
    runtime.enqueue(delta('two'))
    runtime.enqueue(delta('three'))
    await runtime.waitForDrain()

    expect(notes).toEqual([
      { note: 'same', severity: 'nit' },
      { note: 'brand new', severity: 'nit' },
    ])
    expect(llm.calls).toHaveLength(3)
    expect(runtime.status()).toBe('running')
  })

  it('contains a throwing guard (T4 F1 — a guard failure never crashes the drain)', async () => {
    const throwingGuard = {
      beginUpdate: () => {},
      accept: () => {
        throw new Error('guard exploded')
      },
      reset: () => {},
    } as unknown as EmissionGuard
    const llm = new ScriptedLlm(['{"note":"x"}'])
    const { runtime, notes } = makeRuntime(llm, { guard: throwingGuard })

    runtime.enqueue(delta('one'))
    // The drain kicker must resolve, not reject — an unhandled rejection here
    // would crash the process under Node ≥22/24 defaults.
    await expect(runtime.waitForDrain()).resolves.toBeUndefined()

    expect(llm.calls).toHaveLength(1) // the model call completed
    expect(notes).toEqual([]) // the guarded note never reached delivery
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })
})
