/**
 * T1 (plan dsh-advisor-next-prompt-n12) — the server next-prompt runner.
 *
 * Contract under test (`NextPromptManager`, one instance per plugin fiber):
 * 1. Gate — prediction calls start ONLY when `resolve().enabled` is true AND
 *    `resolve().nextPrompt` is true; otherwise zero llm calls ever (the spy
 *    llm proves it).
 * 2. Arm/consume — `onCompletedTurnEnd` arms exactly one pending slot per
 *    session; the NEXT `onDelta` for that session is the prediction context
 *    and fires the call; a delta-less turn (no `onDelta`) cancels the pending
 *    slot with no call.
 * 3. Fence — per-session generation counter; `onUserTurnStart` bumps it AND
 *    clears the stored text immediately; every new `onCompletedTurnEnd` bumps
 *    it; a result computed for a superseded generation is discarded (text and
 *    counters untouched).
 * 4. Best-effort — fire-and-forget with its own dsh-timeout `deadline`; at
 *    most ONE lightweight retry within the same generation, and the
 *    session-scoped gate is re-read before EVERY attempt (a mid-chain
 *    config flip or a provider/model pair change aborts the chain —
 *    I-000030); every failure
 *    (throw, deadline, empty/`NONE` reply) is a silent drop with a debug log.
 * 5. Shaping — strip C0 control characters (keeping whitespace), strip
 *    Unicode invisible marks (soft hyphen, ALM, MVS, zero-width, bidi,
 *    joiners/invisible operators, tag characters), strip
 *    surrounding quotes/backticks/code fences, collapse whitespace runs to
 *    single spaces, reject the empty result, truncate to
 *    `NEXT_PROMPT_MAX_CHARS` CODE POINTS (never splitting a surrogate pair);
 *    the stored text is always single-line.
 * 6. Reads — `getSuggestion` returns `{ suggestion: null }` for a session
 *    with no stored text; per-session state is dropped by `disposeSession` /
 *    `disposeAll`.
 *
 * All cases drive the manager directly with an injected fake `llm.stream`
 * (mock llm, fake timers for the deadline case — no live API).
 */

import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { NextPromptManager } from '../src/next-prompt'
import type { NextPromptManagerOptions } from '../src/next-prompt'
import type { AdvisorLlm } from '../src/advisor-runtime'
import type { Delta } from '../src/transcript'
import type { ResolvedAdvisorConfig } from '../src/config'
import { DEFAULT_NEXT_PROMPT_SYSTEM_PROMPT } from '../src/prompts'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A rendered transcript delta (shape produced by the T3 observer). */
const delta = (markdown: string): Delta => ({ markdown, willContinue: false })

/** A fully enabled resolved config (post-gate) with predictions on. */
const baseConfig = (): ResolvedAdvisorConfig => ({
  enabled: true,
  provider: 'test-provider',
  model: 'test-model',
  systemPrompt: '',
  immuneTurns: 3,
  maxDeltaMessages: 60,
  nextPrompt: true,
  defaultEnabled: true,
})

/** Chunk script for a successful text reply. */
const textReply = (text: string): readonly StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Chunk script for an empty reply — terminal finish, no text deltas. */
const emptyReply = (): readonly StreamChunk[] => [{ type: 'finish', reason: { kind: 'stop' } }]

type Reply =
  | { readonly chunks: readonly StreamChunk[] }
  | { readonly throw: Error }
  | { readonly hang: true }

/** Scripted fake llm: records calls, replays responses (advisor-runtime pattern). */
class FakeLlm implements AdvisorLlm {
  readonly calls: GenerateOptions[] = []

  constructor(private readonly responses: readonly Reply[]) {}

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const response = this.responses[this.calls.length - 1]
    if (response === undefined) {
      throw new Error(`FakeLlm: unexpected stream call #${this.calls.length} (script exhausted)`)
    }
    if ('throw' in response) throw response.throw
    if ('hang' in response) {
      return (async function* () {
        await new Promise<void>(() => {})
      })()
    }
    return (async function* () {
      yield* response.chunks
    })()
  }
}

/**
 * Gated fake llm: the FIRST stream call blocks until `open()`, then replays
 * the reply — used to hold a prediction in flight across a fence bump.
 */
class GatedLlm implements AdvisorLlm {
  readonly calls: GenerateOptions[] = []
  private readonly chunks: readonly StreamChunk[]
  private opener?: (chunks: readonly StreamChunk[]) => void
  private readonly openPromise: Promise<readonly StreamChunk[]>

  constructor(chunks: readonly StreamChunk[]) {
    this.chunks = chunks
    this.openPromise = new Promise((resolve) => {
      this.opener = resolve
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    return (async function* (self: GatedLlm) {
      yield* await self.openPromise
    })(this)
  }

  open(): void {
    this.opener?.(this.chunks)
  }
}

/**
 * Per-call gated llm (I-000026): like {@link GatedLlm}, but each stream call
 * gets its OWN gate and reply script, so two overlapping predictions can be
 * released and observed independently — the old state's result vs the
 * rebuilt state's result.
 */
class SequencedGatedLlm implements AdvisorLlm {
  readonly calls: GenerateOptions[] = []
  private readonly openers: Array<(chunks: readonly StreamChunk[]) => void> = []
  private readonly openPromises: Array<Promise<readonly StreamChunk[]>>

  constructor(private readonly scripts: readonly (readonly StreamChunk[])[]) {
    // One gate per scripted call; the executors run synchronously in map
    // order, so openers[i] resolves openPromises[i].
    this.openPromises = scripts.map(() => new Promise<readonly StreamChunk[]>((resolve) => {
      this.openers.push(resolve)
    }))
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const index = this.calls.length - 1
    return (async function* (self: SequencedGatedLlm, i: number) {
      yield* await self.openPromises[i]
    })(this, index)
  }

  open(index: number): void {
    this.openers[index]?.(this.scripts[index]!)
  }
}

/**
 * Build one manager over a fake llm. `resolve` is a function of the SESSION
 * ID (the I-000024 seam) so gate-flip and per-session tests can repoint the
 * live config between the arm and the delta — or between sessions.
 */
function makeManager(
  llm: AdvisorLlm,
  resolve: (sessionId: string) => ResolvedAdvisorConfig = () => baseConfig(),
  overrides: Partial<NextPromptManagerOptions> = {},
): { manager: NextPromptManager; logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } } {
  const logger = { debug: vi.fn(), warn: vi.fn() }
  const manager = new NextPromptManager({
    resolve,
    llm: () => llm,
    logger,
    callTimeoutMs: 20,
    ...overrides,
  })
  return { manager, logger }
}

/** Flush the fire-and-forget prediction chain (microtasks + one macrotask). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// Contract 1 — gate
// ---------------------------------------------------------------------------

describe('gate (contract 1)', () => {
  it('makes zero llm calls when the advisor is disabled (S4 gate)', async () => {
    const llm = new FakeLlm([])
    const { manager } = makeManager(llm, () => ({ ...baseConfig(), enabled: false }))

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('### Session update\n\n**agent**: fixed the parser'))
    await settle()

    expect(llm.calls).toHaveLength(0)
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
  })

  it('makes zero llm calls when nextPrompt is off', async () => {
    const llm = new FakeLlm([])
    const { manager } = makeManager(llm, () => ({ ...baseConfig(), nextPrompt: false }))

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('### Session update\n\n**agent**: fixed the parser'))
    await settle()

    expect(llm.calls).toHaveLength(0)
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
  })

  it('keeps zero calls when the gate flips on between the arm and the delta', async () => {
    // Arming under a closed gate must not leave a slot that a later config
    // flip (volatile live edit) could fire: zero llm calls ever.
    const llm = new FakeLlm([])
    const configRef = { current: { ...baseConfig(), nextPrompt: false } }
    const { manager } = makeManager(llm, () => configRef.current)

    manager.onCompletedTurnEnd('s')
    configRef.current = baseConfig() // nextPrompt on before the delta arrives
    manager.onDelta('s', delta('### Session update\n\n**agent**: fixed the parser'))
    await settle()

    expect(llm.calls).toHaveLength(0)
  })

  it('fires exactly one prediction call with the prediction system prompt when enabled and on', async () => {
    const llm = new FakeLlm([{ chunks: textReply('write a regression test') }])
    const { manager } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('### Session update\n\n**agent**: fixed the parser'))
    await settle()

    expect(llm.calls).toHaveLength(1)
    const options = llm.calls[0]!
    expect(options).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
      system: DEFAULT_NEXT_PROMPT_SYSTEM_PROMPT,
    })
    // An ordinary conversation request — the purpose marker stays unset.
    expect(options.purpose).toBeUndefined()
    // The prediction carries the conversation it was made for; header-routed
    // providers (OpenCode Go's `x-opencode-session`) refuse it otherwise.
    expect(options.sessionId).toBe('s')
    expect(options.messages).toHaveLength(1)
    const message = options.messages[0]!
    expect(message.role).toBe('user')
    expect(message.content[0]).toEqual({
      type: 'text',
      text: '### Session update\n\n**agent**: fixed the parser',
    })
    expect(manager.getSuggestion('s')).toEqual({ suggestion: 'write a regression test' })
  })

  it('resolves per session: an off session never predicts, an on session does (I-000024)', async () => {
    // The resolver is SESSION-SCOPED: session `on` reads the enabled
    // effective config, session `off` reads its `/advisor off` override
    // (enabled: false) — a global read would let `off` keep predicting.
    const llm = new FakeLlm([{ chunks: textReply('for the on session') }])
    const { manager } = makeManager(llm, (sessionId) =>
      sessionId === 'on' ? baseConfig() : { ...baseConfig(), enabled: false })

    manager.onCompletedTurnEnd('on')
    manager.onDelta('on', delta('turn update'))
    manager.onCompletedTurnEnd('off')
    manager.onDelta('off', delta('turn update'))
    await settle()

    expect(llm.calls).toHaveLength(1)
    expect(manager.getSuggestion('on')).toEqual({ suggestion: 'for the on session' })
    expect(manager.getSuggestion('off')).toEqual({ suggestion: null })
  })

  it('predicts through each session\'s own pinned pair (I-000024)', async () => {
    // A session pin is part of the effective config the gate reads, so the
    // prediction call carries the PINNED provider/model, not the global one.
    const llm = new FakeLlm([
      { chunks: textReply('pinned reply') },
      { chunks: textReply('global reply') },
    ])
    const { manager } = makeManager(llm, (sessionId) => sessionId === 'pinned'
      ? { ...baseConfig(), provider: 'pinned-provider', model: 'pinned-model' }
      : baseConfig())

    manager.onCompletedTurnEnd('pinned')
    manager.onDelta('pinned', delta('turn update'))
    await settle()
    manager.onCompletedTurnEnd('global')
    manager.onDelta('global', delta('turn update'))
    await settle()

    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[0]).toMatchObject({ provider: 'pinned-provider', model: 'pinned-model' })
    expect(llm.calls[1]).toMatchObject({ provider: 'test-provider', model: 'test-model' })
    expect(manager.getSuggestion('pinned')).toEqual({ suggestion: 'pinned reply' })
    expect(manager.getSuggestion('global')).toEqual({ suggestion: 'global reply' })
  })
})

// ---------------------------------------------------------------------------
// Contract 2 — arm/consume
// ---------------------------------------------------------------------------

describe('arm/consume (contract 2)', () => {
  it('uses each next delta as the prediction context, one call per completed turn', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('first next step') },
      { chunks: textReply('second next step') },
    ])
    const { manager } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('turn one update'))
    await settle()
    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('turn two update'))
    await settle()

    expect(llm.calls).toHaveLength(2)
    const textOf = (options: GenerateOptions): string => {
      const block = options.messages[0]!.content[0]!
      return block.type === 'text' ? block.text : ''
    }
    expect(textOf(llm.calls[0]!)).toBe('turn one update')
    expect(textOf(llm.calls[1]!)).toBe('turn two update')
    expect(manager.getSuggestion('s')).toEqual({ suggestion: 'second next step' })
  })

  it('arms exactly ONE pending slot: a second arm before the delta yields a single call', async () => {
    const llm = new FakeLlm([{ chunks: textReply('one suggestion') }])
    const { manager } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onCompletedTurnEnd('s') // re-arms the SAME slot — never two
    manager.onDelta('s', delta('turn update'))
    await settle()

    expect(llm.calls).toHaveLength(1)
  })

  it('a delta-less turn cancels the pending slot with no call', async () => {
    const llm = new FakeLlm([{ chunks: textReply('later suggestion') }])
    const { manager } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    await settle() // no onDelta ever follows this turn — nothing may fire
    expect(llm.calls).toHaveLength(0)
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })

    // The next completed turn re-arms cleanly and predicts exactly once.
    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('next turn update'))
    await settle()
    expect(llm.calls).toHaveLength(1)
    expect(manager.getSuggestion('s')).toEqual({ suggestion: 'later suggestion' })
  })

  it('an armed slot is consumed exactly once: extra deltas do not fire', async () => {
    const llm = new FakeLlm([{ chunks: textReply('single shot') }])
    const { manager } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('the delta'))
    await settle()
    manager.onDelta('s', delta('an unannounced extra delta'))
    await settle()

    expect(llm.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Contract 3 — fence
// ---------------------------------------------------------------------------

describe('fence (contract 3)', () => {
  it('onUserTurnStart clears the stored suggestion immediately', async () => {
    const llm = new FakeLlm([{ chunks: textReply('stale suggestion') }])
    const { manager } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('turn update'))
    await settle()
    expect(manager.getSuggestion('s').suggestion).toBe('stale suggestion')

    manager.onUserTurnStart('s')
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
  })

  it('a result computed for a superseded generation is discarded (completed-turn bump)', async () => {
    const llm = new GatedLlm(textReply('stale idea'))
    const { manager } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('turn one'))
    // The prediction is in flight (gated) when the next completed turn bumps
    // the generation and re-arms.
    manager.onCompletedTurnEnd('s')
    llm.open()
    await settle()

    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
    expect(llm.calls).toHaveLength(1)

    // The fence must not wedge anything: the re-armed slot still predicts.
    manager.onDelta('s', delta('turn two'))
    await settle()
    expect(llm.calls).toHaveLength(2)
    expect(manager.getSuggestion('s').suggestion).toBe('stale idea')
  })

  it('a prediction in flight when the user starts typing is discarded', async () => {
    const llm = new GatedLlm(textReply('late idea'))
    const { manager } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('turn update'))
    manager.onUserTurnStart('s') // bumps the generation and clears immediately
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })

    llm.open()
    await settle()
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
    expect(llm.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Contract 4 — best-effort
// ---------------------------------------------------------------------------

describe('best-effort (contract 4)', () => {
  it('retries once after a transport throw and stores the retry result', async () => {
    const llm = new FakeLlm([
      { throw: new Error('provider down') },
      { chunks: textReply('retry worked') },
    ])
    const { manager } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('turn update'))
    await settle()

    expect(llm.calls).toHaveLength(2)
    expect(manager.getSuggestion('s')).toEqual({ suggestion: 'retry worked' })
  })

  it('drops silently after the retry also throws (debug log, never warn)', async () => {
    const llm = new FakeLlm([
      { throw: new Error('provider down') },
      { throw: new Error('still down') },
    ])
    const { manager, logger } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('turn update'))
    await settle()

    expect(llm.calls).toHaveLength(2) // the initial try + the ONE retry
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
    expect(logger.debug).toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('times out a hung stream per attempt and drops silently (deadline)', async () => {
    vi.useFakeTimers()
    try {
      const llm = new FakeLlm([{ hang: true }, { hang: true }])
      const { manager, logger } = makeManager(llm, () => baseConfig(), { callTimeoutMs: 20 })

      manager.onCompletedTurnEnd('s')
      manager.onDelta('s', delta('turn update'))
      await vi.advanceTimersByTimeAsync(100)

      expect(llm.calls).toHaveLength(2) // both attempts hit the 20ms deadline
      expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
      expect(logger.debug).toHaveBeenCalled()
      expect(logger.warn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops an empty reply silently (after the one retry)', async () => {
    const llm = new FakeLlm([{ chunks: emptyReply() }, { chunks: emptyReply() }])
    const { manager, logger } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('turn update'))
    await settle()

    expect(llm.calls).toHaveLength(2)
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
    expect(logger.debug).toHaveBeenCalled()
  })

  it('drops a NONE reply silently (after the one retry)', async () => {
    const llm = new FakeLlm([{ chunks: textReply('NONE') }, { chunks: textReply('NONE') }])
    const { manager, logger } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('turn update'))
    await settle()

    expect(llm.calls).toHaveLength(2)
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
    expect(logger.debug).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Mid-chain gate re-check (I-000030 / I-000024 residual)
// ---------------------------------------------------------------------------

describe('mid-chain gate re-check (I-000030)', () => {
  it('never re-issues the retry after the gate closed mid-flight', async () => {
    vi.useFakeTimers()
    try {
      // Script has ONE entry: any second call would throw (fake llm guard),
      // failing the test if the retry went out past the closed gate.
      const llm = new FakeLlm([{ hang: true }])
      const configRef = { current: baseConfig() }
      const { manager } = makeManager(llm, () => configRef.current, { callTimeoutMs: 20 })

      manager.onCompletedTurnEnd('s')
      manager.onDelta('s', delta('turn update')) // attempt 1 in flight (hung)
      configRef.current = { ...baseConfig(), enabled: false } // `/advisor off` mid-flight

      await vi.advanceTimersByTimeAsync(100) // the hung attempt hits its deadline

      // EXACTLY ONE llm call: the first attempt's failure must not fund a
      // retry — the per-attempt re-read sees the closed gate and aborts.
      expect(llm.calls).toHaveLength(1)
      expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts the chain when the provider/model pair changed mid-flight (no re-route)', async () => {
    vi.useFakeTimers()
    try {
      const llm = new FakeLlm([{ hang: true }])
      const configRef = { current: baseConfig() }
      const { manager } = makeManager(llm, () => configRef.current, { callTimeoutMs: 20 })

      manager.onCompletedTurnEnd('s')
      manager.onDelta('s', delta('turn update')) // attempt 1 under the ORIGINAL pair (hung)
      configRef.current = { ...baseConfig(), provider: 'moved-provider', model: 'moved-model' }

      await vi.advanceTimersByTimeAsync(100)

      // EXACTLY ONE llm call, still under the original pair: a mid-chain
      // pair change aborts this prediction (never re-routed) — the next
      // turn predicts fresh under the new pair.
      expect(llm.calls).toHaveLength(1)
      expect(llm.calls[0]).toMatchObject({ provider: 'test-provider', model: 'test-model' })
      expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Contract 5 — shaping
// ---------------------------------------------------------------------------

describe('shaping (contract 5)', () => {
  const shapingCases: ReadonlyArray<readonly [raw: string, expected: string | null]> = [
    ['  fix   the\n\nlogin  bug  ', 'fix the login bug'],
    ['"review the diff"', 'review the diff'],
    ["'review the diff'", 'review the diff'],
    ['`review the diff`', 'review the diff'],
    ['```\nreview the diff\n```', 'review the diff'],
    ['```ts\nrun the type check\n```', 'run the type check'],
    ['NONE', null],
    ['   ', null],
    ['', null],
    ['a'.repeat(130), 'a'.repeat(120)],
    // C0 control characters (qc2 F-003): NUL-range and ESC/BS are stripped,
    // while whitespace C0 (\r) survives as the collapsed single space.
    ['fix\x1B[31mthe\x08\rbug', 'fix[31mthe bug'],
    // Bidi/zero-width marks (security-hygiene lead): direction overrides
    // (U+202A–U+202E), isolates (U+2066–U+2069), zero-width characters
    // (U+200B–U+200F) and the BOM (U+FEFF) are stripped invisibly — the
    // visible text and single-space shaping stay intact.
    ['pre\u202Ae\u2066x\u200Bt\u200E and \u200F\uFEFFship it', 'preext and ship it'],
    // Round-2 invisible-mark policy (I-000031): the soft hyphen, the Arabic
    // letter mark, the Mongolian vowel separator, the word-joiner range and
    // the astral tag characters are stripped like the rest — a marks-only
    // reply stores nothing (visible-empty) and NO<U+2060>NE cannot dodge
    // the NONE comparison.
    ['con\u00ADtinue', 'continue'],
    ['\u061Ccheck\u061C the log', 'check the log'],
    ['\u180Ere\u180Erun tests', 'rerun tests'],
    ['\u2060', null],
    ['NO\u2060NE', null],
    ['\u{E0061}ship\u{E007F} it', 'ship it'],
    // Truncation lands on a code-point boundary: 119 ASCII + one rocket is
    // exactly 120 code points (121 UTF-16 units) — kept whole, where a
    // unit-boundary slice would store the rocket's lone high surrogate.
    [`${'a'.repeat(119)}🚀`, `${'a'.repeat(119)}🚀`],
    // The cap counts code points: 200 rockets truncate to 120 rockets (240
    // UTF-16 units), not to 120 units.
    ['🚀'.repeat(200), '🚀'.repeat(120)],
  ]

  it.each(shapingCases)('stores the shaped single-line suggestion for %j', async (raw, expected) => {
    const llm = new FakeLlm([{ chunks: textReply(raw) }])
    const { manager } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('### Session update\n\n**agent**: did work'))
    await settle()

    expect(manager.getSuggestion('s')).toEqual({ suggestion: expected })
  })

  it('truncates an emoji-heavy reply at a code-point boundary — never a lone surrogate (qc2 F-003)', async () => {
    const llm = new FakeLlm([{ chunks: textReply(`${'a'.repeat(119)}🚀🚀🚀`) }])
    const { manager } = makeManager(llm)

    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('### Session update\n\n**agent**: did work'))
    await settle()

    const stored = manager.getSuggestion('s').suggestion
    expect(stored).not.toBeNull()
    // 120 code points — the cap counts characters, not UTF-16 units.
    expect(Array.from(stored!)).toHaveLength(120)
    // The astral character at the old unit boundary (119 a's + 1 unit into
    // the first rocket) is kept WHOLE: the stored text ends on the intact
    // pair, and no high/low surrogate is unpaired anywhere.
    expect(stored!.endsWith('🚀')).toBe(true)
    expect(stored).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})

// ---------------------------------------------------------------------------
// Contract 6 — reads and disposal
// ---------------------------------------------------------------------------

describe('reads and disposal (contract 6)', () => {
  it('returns { suggestion: null } for a session with no stored text', () => {
    const { manager } = makeManager(new FakeLlm([]))
    expect(manager.getSuggestion('unknown-session')).toEqual({ suggestion: null })
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
  })

  it('disposeSession drops the per-session state', async () => {
    const llm = new FakeLlm([{ chunks: textReply('a suggestion') }])
    const { manager } = makeManager(llm)
    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('turn update'))
    await settle()
    expect(manager.getSuggestion('s').suggestion).toBe('a suggestion')

    manager.disposeSession('s')
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })
  })

  it('disposeAll drops every session', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('for one') },
      { chunks: textReply('for two') },
    ])
    const { manager } = makeManager(llm)
    manager.onCompletedTurnEnd('one')
    manager.onDelta('one', delta('turn update'))
    manager.onCompletedTurnEnd('two')
    manager.onDelta('two', delta('turn update'))
    await settle()
    expect(manager.getSuggestion('one').suggestion).toBe('for one')
    expect(manager.getSuggestion('two').suggestion).toBe('for two')

    manager.disposeAll()
    expect(manager.getSuggestion('one')).toEqual({ suggestion: null })
    expect(manager.getSuggestion('two')).toEqual({ suggestion: null })
  })

  it('a disposed session can predict again — state is rebuilt, not disabled', async () => {
    const llm = new FakeLlm([
      { chunks: textReply('first suggestion') },
      { chunks: textReply('second suggestion') },
    ])
    const { manager } = makeManager(llm)
    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('turn update'))
    await settle()

    manager.disposeSession('s')
    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('next turn'))
    await settle()

    expect(llm.calls).toHaveLength(2)
    expect(manager.getSuggestion('s')).toEqual({ suggestion: 'second suggestion' })
  })

  it('an in-flight prediction from before a same-id rebuild never writes the rebuilt state (I-000026)', async () => {
    // The stale result must be fenced by STATE IDENTITY, not the numeric
    // generation: the rebuilt same-id session restarts at generation 1, so
    // a generation-only comparison would let the old prediction commit into
    // the new state.
    const llm = new SequencedGatedLlm([
      textReply('ghost from the old state'),
      textReply('fresh suggestion'),
    ])
    const { manager } = makeManager(llm)

    // Old state: arm + fire, prediction held in flight.
    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('old turn'))
    expect(llm.calls).toHaveLength(1)

    // Dispose and rebuild the SAME id: new state, generation restarts at 1,
    // the second prediction arms and fires while the first is still gated.
    manager.disposeSession('s')
    manager.onCompletedTurnEnd('s')
    manager.onDelta('s', delta('new turn'))
    expect(llm.calls).toHaveLength(2)

    // The OLD prediction settles first: the identity fence discards it, and
    // nothing is written into the rebuilt state.
    llm.open(0)
    await settle()
    expect(manager.getSuggestion('s')).toEqual({ suggestion: null })

    // The rebuilt state's OWN prediction settles and commits — the fence
    // invalidates the stale result only, never the live chain.
    llm.open(1)
    await settle()
    expect(manager.getSuggestion('s')).toEqual({ suggestion: 'fresh suggestion' })
  })
})
