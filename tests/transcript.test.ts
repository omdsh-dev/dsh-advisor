/**
 * T3 — session observer + bounded delta renderer (spec §2 S2, §4 mapping table
 * rows, §6 self-review exclusion, §8.3 KD-3, §8.5 KD-5).
 *
 * Contract under test:
 * - `DeltaRenderer.update(events)` advances a cursor over the session event
 *   log and renders only the newly appended messages as a role-annotated
 *   markdown delta (`Delta = { markdown, willContinue }`).
 * - A prefix rewrite — `user/message` with `surfaceOp.op === 'replace'`,
 *   `compact/*` events (KD-5 triggers), or a fingerprint mismatch (defensive
 *   fallback) — resets the cursor and replays the full post-rewrite surface.
 * - Advisor-source messages (`source.kind === 'advisor'`) are excluded
 *   (self-review guard, spec §6).
 * - The bounded window (`maxDeltaMessages`, default 60, 0 = unbounded) keeps
 *   the most recent N messages and prepends the truncation marker (KD-3).
 * - Role labels `**user:**` / `**agent:**`; assistant tool calls and tool
 *   results are included (tool intent); reasoning blocks are excluded (MVP).
 * - `seedTo(length)` skips existing history (KD-5 seed-on-enable).
 * - `SessionTranscriptObserver` (the wiring unit): per-session renderer map,
 *   stepped turn/end detection (only stepped, reviewable turns — reason.kind
 *   ∈ {completed, 'max-tokens', error}), and per-session disposal.
 *
 * Events are synthetic but shaped exactly like dsh emits: contiguous `seq`
 * from 0, surface events carrying `surfaceOp`, `compact/*` log-only events
 * (dsh-compact's declared-merged types are not in this package's dependency
 * closure — the renderer matches them by `type` string, per the plan's
 * implementation-time verification item 3).
 */

import { describe, expect, it } from 'vitest'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SurfaceOp } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_MAX_DELTA_MESSAGES,
  DeltaRenderer,
  SessionTranscriptObserver,
  TRUNCATION_MARKER,
} from '../src/transcript'
import { ADVISOR_SOURCE_KIND } from '../src/kinds'

// ---------------------------------------------------------------------------
// Synthetic event builders (deterministic message ids so a rebuilt prefix has
// a stable fingerprint; different content ⇒ different ids ⇒ different fp).
// ---------------------------------------------------------------------------

interface EventSpec {
  type: string
  data: unknown
  surfaceOp?: SurfaceOp
  sourceEventSeqs?: number[]
}

/** Number events contiguously from seq 0 and cast to the SessionEvent union. */
function buildEvents(specs: readonly EventSpec[]): SessionEvent[] {
  return specs.map((spec, index) => {
    const event: Record<string, unknown> = {
      type: spec.type,
      seq: index,
      time: 1_000 + index,
      data: spec.data,
    }
    if (spec.surfaceOp !== undefined) event.surfaceOp = spec.surfaceOp
    if (spec.sourceEventSeqs !== undefined) event.sourceEventSeqs = spec.sourceEventSeqs
    return event as unknown as SessionEvent
  })
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

function userMessage(
  value: string,
  source: MessageSource = { kind: 'user' },
  surfaceOp: SurfaceOp = 'append',
  sourceEventSeqs?: number[],
): EventSpec {
  return {
    type: 'user/message',
    data: {
      id: MessageId(`user-${value}`),
      role: 'user',
      content: [text(value)],
      source,
    },
    surfaceOp,
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  }
}

function assistantMessage(value: string, toolCalls: Array<{ name: string; args: string }> = []): EventSpec {
  const content: ContentBlock[] = []
  if (value.length > 0) content.push(text(value))
  for (const [index, call] of toolCalls.entries()) {
    content.push({ type: 'tool-call', id: CallId(`call-${index}`), name: call.name, arguments: call.args })
  }
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: MessageId(`assistant-${value}-${toolCalls.length}`),
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    },
    surfaceOp: 'append',
  }
}

function toolResultMessage(value: string): EventSpec {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: MessageId(`tool-${value}`),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('call-0'), content: [text(value)], isError: false }],
        source: { kind: 'tool', callId: CallId('call-0') },
      },
    },
    surfaceOp: 'append',
  }
}

const turnStart = (turn: number): EventSpec => ({ type: 'turn/start', data: { turn } })
const stepStart = (turn: number, step: number): EventSpec => ({ type: 'step/start', data: { turn, step } })
const stepEnd = (turn: number, step: number): EventSpec => ({ type: 'step/end', data: { turn, step } })

type TurnEndKind = 'completed' | 'max-tokens' | 'error' | 'aborted' | 'blocked' | 'interrupted'

const turnEnd = (turn: number, reason: TurnEndKind = 'completed'): EventSpec => ({
  type: 'turn/end',
  data: {
    turn,
    reason: reason === 'error'
      ? { kind: 'error', error: { message: 'model failed', code: 'UNKNOWN' } }
      : { kind: reason },
  },
})

const compactStart = (): EventSpec => ({ type: 'compact/start', data: { compactionId: 'c1', turn: null } })
const compactSummary = (): EventSpec => ({
  type: 'compact/summary',
  data: {
    compactionId: 'c1',
    summary: [text('…')],
    shadowedRange: { start: 1, end: 3 },
    shadowedSeqs: [1, 3],
    shadowedTokenCount: 10,
    provider: 'deepseek',
    model: 'deepseek-chat',
  },
})
const compactEnd = (): EventSpec => ({ type: 'compact/end', data: { compactionId: 'c1', turn: null } })

/** One standard stepped turn: turn/start, user, step/start, assistant, step/end, turn/end. */
function simpleTurn(turn: number, userText: string, agentText: string): EventSpec[] {
  return [
    turnStart(turn),
    userMessage(userText),
    stepStart(turn, 1),
    assistantMessage(agentText),
    stepEnd(turn, 1),
    turnEnd(turn),
  ]
}

// ---------------------------------------------------------------------------
// DeltaRenderer — cursor advance on append
// ---------------------------------------------------------------------------

describe('DeltaRenderer — cursor advance on append', () => {
  it('renders the first update as the full new surface', () => {
    const renderer = new DeltaRenderer()
    const delta = renderer.update(buildEvents(simpleTurn(1, 'fix the bug', 'I will fix it.')))
    expect(delta).toBeDefined()
    expect(delta!.willContinue).toBe(false)
    expect(delta!.markdown).toContain('### Session update')
    expect(delta!.markdown).toContain('**user**: fix the bug')
    expect(delta!.markdown).toContain('**agent**: I will fix it.')
  })

  it('renders only the new messages on a subsequent update (cursor advanced)', () => {
    const renderer = new DeltaRenderer()
    const turn1 = buildEvents(simpleTurn(1, 'fix the bug', 'I will fix it.'))
    renderer.update(turn1)
    const turn2 = buildEvents([
      ...simpleTurn(1, 'fix the bug', 'I will fix it.'),
      ...simpleTurn(2, 'now add tests', 'Adding tests.'),
    ])
    const delta = renderer.update(turn2)
    expect(delta).toBeDefined()
    expect(delta!.markdown).toContain('**user**: now add tests')
    expect(delta!.markdown).toContain('**agent**: Adding tests.')
    expect(delta!.markdown).not.toContain('fix the bug')
  })

  it('returns undefined when nothing new was appended (e.g. a rejected no-step turn)', () => {
    const renderer = new DeltaRenderer()
    const turn1 = buildEvents(simpleTurn(1, 'hi', 'hello'))
    renderer.update(turn1)
    const events = buildEvents([...simpleTurn(1, 'hi', 'hello'), turnStart(2), turnEnd(2)])
    expect(renderer.update(events)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// DeltaRenderer — prefix rewrite detection (fingerprint / surfaceOp replace)
// ---------------------------------------------------------------------------

describe('DeltaRenderer — prefix rewrite detection', () => {
  it('resets and fully replays when the delivered prefix changes (fingerprint mismatch)', () => {
    const renderer = new DeltaRenderer()
    const original = buildEvents(simpleTurn(1, 'original prompt', 'Original reply.'))
    const first = renderer.update(original)
    expect(first!.markdown).toContain('original prompt')

    // A hidden rewrite of the delivered prefix (same event count, different
    // messages). In dsh a rewrite always arrives as a replace event — the
    // authoritative trigger below — the fingerprint is the defensive fallback.
    const rewritten = buildEvents(simpleTurn(1, 'REWRITTEN prompt', 'Rewritten reply.'))
    const second = renderer.update(rewritten)
    expect(second).toBeDefined()
    expect(second!.markdown).toContain('REWRITTEN prompt')
    expect(second!.markdown).toContain('Rewritten reply.')
    expect(second!.markdown).not.toContain('original prompt')
  })

  it('resets on a user/message replace without compact events (KD-5 trigger b)', () => {
    const renderer = new DeltaRenderer()
    const turn1 = buildEvents(simpleTurn(1, 'old prompt', 'old reply'))
    renderer.update(turn1)
    const replaced = buildEvents([
      ...simpleTurn(1, 'old prompt', 'old reply'),
      userMessage('Summary of the earlier exchange.', { kind: 'user' }, { op: 'replace', start: 1, end: 3 }, [1, 3]),
      ...simpleTurn(2, 'continue', 'Continuing.'),
    ])
    const delta = renderer.update(replaced)
    expect(delta).toBeDefined()
    expect(delta!.markdown).toContain('Summary of the earlier exchange.')
    expect(delta!.markdown).toContain('**user**: continue')
    expect(delta!.markdown).toContain('**agent**: Continuing.')
    expect(delta!.markdown).not.toContain('old prompt')
  })
})

// ---------------------------------------------------------------------------
// DeltaRenderer — reset on compact events (KD-5 trigger a)
// ---------------------------------------------------------------------------

describe('DeltaRenderer — reset on compact events (KD-5)', () => {
  it('replays the full post-rewrite transcript (shadowed messages dropped)', () => {
    const renderer = new DeltaRenderer({ maxDeltaMessages: 60 })
    const turn1 = buildEvents(simpleTurn(1, 'original prompt', 'Original reply.'))
    renderer.update(turn1)
    const compacted = buildEvents([
      ...simpleTurn(1, 'original prompt', 'Original reply.'),
      compactStart(),
      compactSummary(),
      userMessage('Summary of earlier work.', { kind: 'user' }, { op: 'replace', start: 1, end: 3 }, [1, 3]),
      compactEnd(),
      ...simpleTurn(2, 'continue', 'Continuing.'),
    ])
    const delta = renderer.update(compacted)
    expect(delta).toBeDefined()
    // Post-rewrite surface = summary + turn-2 messages.
    expect(delta!.markdown).toContain('Summary of earlier work.')
    expect(delta!.markdown).toContain('**user**: continue')
    expect(delta!.markdown).toContain('**agent**: Continuing.')
    // Shadowed pre-compaction messages must not reappear.
    expect(delta!.markdown).not.toContain('original prompt')
    expect(delta!.markdown).not.toContain('Original reply.')
  })
})

// ---------------------------------------------------------------------------
// DeltaRenderer — own-message (advisor kind) exclusion (spec §6)
// ---------------------------------------------------------------------------

describe('DeltaRenderer — own-message exclusion (self-review guard)', () => {
  it('excludes advisor-source messages from the delta', () => {
    const renderer = new DeltaRenderer()
    const events = buildEvents([
      turnStart(1),
      userMessage('[advisor:nit] consider extracting a helper', { kind: ADVISOR_SOURCE_KIND }),
      userMessage('continue the task'),
      stepStart(1, 1),
      assistantMessage('Working on it.'),
      stepEnd(1, 1),
      turnEnd(1),
    ])
    const delta = renderer.update(events)
    expect(delta).toBeDefined()
    expect(delta!.markdown).toContain('**user**: continue the task')
    expect(delta!.markdown).toContain('**agent**: Working on it.')
    expect(delta!.markdown).not.toContain('advisor')
  })
})

// ---------------------------------------------------------------------------
// DeltaRenderer — bounded window (KD-3)
// ---------------------------------------------------------------------------

describe('DeltaRenderer — bounded window (KD-3)', () => {
  it('truncates a delta that exceeds maxDeltaMessages with the marker', () => {
    const renderer = new DeltaRenderer({ maxDeltaMessages: 2 })
    const delta = renderer.update(buildEvents([
      ...simpleTurn(1, 'm1', 'r1'),
      ...simpleTurn(2, 'm2', 'r2'),
    ]))
    expect(delta).toBeDefined()
    expect(delta!.markdown).toContain(TRUNCATION_MARKER)
    expect(delta!.markdown).toContain('**user**: m2')
    expect(delta!.markdown).toContain('**agent**: r2')
    expect(delta!.markdown).not.toContain('**user**: m1')
    // The marker precedes the retained messages.
    expect(delta!.markdown.indexOf(TRUNCATION_MARKER)).toBeLessThan(delta!.markdown.indexOf('**user**: m2'))
  })

  it('defaults to 60 and does not truncate typical deltas', () => {
    expect(DEFAULT_MAX_DELTA_MESSAGES).toBe(60)
    const renderer = new DeltaRenderer()
    const delta = renderer.update(buildEvents(simpleTurn(1, 'a', 'b')))
    expect(delta!.markdown).not.toContain(TRUNCATION_MARKER)
  })

  it('treats 0 as unbounded', () => {
    const renderer = new DeltaRenderer({ maxDeltaMessages: 0 })
    const delta = renderer.update(buildEvents([
      ...simpleTurn(1, 'm1', 'r1'),
      ...simpleTurn(2, 'm2', 'r2'),
    ]))
    expect(delta!.markdown).toContain('**user**: m1')
    expect(delta!.markdown).toContain('**user**: m2')
    expect(delta!.markdown).not.toContain(TRUNCATION_MARKER)
  })
})

// ---------------------------------------------------------------------------
// DeltaRenderer — rendering format (role labels, tool intent, reasoning)
// ---------------------------------------------------------------------------

describe('DeltaRenderer — markdown rendering', () => {
  it('renders assistant tool calls and tool results (tool intent)', () => {
    const renderer = new DeltaRenderer()
    const delta = renderer.update(buildEvents([
      turnStart(1),
      userMessage('run the tests'),
      stepStart(1, 1),
      assistantMessage('', [{ name: 'run_tests', args: '{}' }]),
      toolResultMessage('3 passed'),
      stepEnd(1, 1),
      turnEnd(1),
    ]))
    expect(delta).toBeDefined()
    expect(delta!.markdown).toContain('**agent**: - tool call: run_tests({})')
    expect(delta!.markdown).toContain('**user**: [tool result] 3 passed')
  })

  it('excludes reasoning blocks from assistant text (MVP)', () => {
    const renderer = new DeltaRenderer()
    const delta = renderer.update(buildEvents([
      turnStart(1),
      userMessage('question'),
      stepStart(1, 1),
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: MessageId('a1'),
            role: 'assistant',
            content: [{ type: 'reasoning', text: 'secret chain of thought' }, text('visible answer')],
            source: { kind: 'model', provider: 'p', model: 'm' },
          },
        },
        surfaceOp: 'append',
      },
      stepEnd(1, 1),
      turnEnd(1),
    ]))
    expect(delta!.markdown).toContain('**agent**: visible answer')
    expect(delta!.markdown).not.toContain('secret chain of thought')
  })
})

// ---------------------------------------------------------------------------
// DeltaRenderer — seedTo (KD-5 seed-on-enable)
// ---------------------------------------------------------------------------

describe('DeltaRenderer — seedTo (KD-5)', () => {
  it('skips existing history after seeding', () => {
    const renderer = new DeltaRenderer()
    const events = buildEvents([
      ...simpleTurn(1, 'old turn', 'old reply'),
      ...simpleTurn(2, 'new turn', 'new reply'),
    ])
    renderer.seedTo(6) // skip turn 1 (its 6 events)
    const delta = renderer.update(events)
    expect(delta).toBeDefined()
    expect(delta!.markdown).toContain('**user**: new turn')
    expect(delta!.markdown).not.toContain('old turn')
  })

  it('still detects a rewrite of the seeded prefix afterwards', () => {
    const renderer = new DeltaRenderer()
    const events = buildEvents([
      ...simpleTurn(1, 'old', 'old reply'),
      ...simpleTurn(2, 'new', 'new reply'),
    ])
    renderer.seedTo(6)
    renderer.update(events)
    const rewritten = buildEvents([
      ...simpleTurn(1, 'REWRITTEN', 'x'),
      ...simpleTurn(2, 'new', 'new reply'),
    ])
    const delta = renderer.update(rewritten)
    expect(delta!.markdown).toContain('REWRITTEN')
  })

  it('rejects invalid lengths', () => {
    const renderer = new DeltaRenderer()
    expect(() => renderer.seedTo(-1)).toThrow()
    expect(() => renderer.seedTo(1.5)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// SessionTranscriptObserver — the wiring unit (listener + turn detection)
// ---------------------------------------------------------------------------

/** Mirror the cordis `session/event` listener: feed a growing live log. */
function feed(observer: SessionTranscriptObserver, sessionId: string, specs: readonly EventSpec[]): void {
  const all = buildEvents(specs)
  for (let index = 0; index < all.length; index++) {
    observer.handleEvent(sessionId, all.slice(0, index + 1), all[index]!)
  }
}

describe('SessionTranscriptObserver — wiring (turn detection + per-session dispatch)', () => {
  it('emits a delta once per stepped reviewable turn/end', () => {
    const deltas: Array<{ sessionId: string; markdown: string }> = []
    const observer = new SessionTranscriptObserver({
      maxDeltaMessages: 60,
      onDelta: (sessionId, delta) => deltas.push({ sessionId, markdown: delta.markdown }),
    })
    feed(observer, 's1', simpleTurn(1, 'first', 'reply one'))
    expect(deltas).toHaveLength(1)
    expect(deltas[0]!.sessionId).toBe('s1')
    expect(deltas[0]!.markdown).toContain('**user**: first')
  })

  it('ignores no-step turns and non-reviewable end reasons', () => {
    const deltas: string[] = []
    const observer = new SessionTranscriptObserver({
      maxDeltaMessages: 60,
      onDelta: (_sessionId, delta) => deltas.push(delta.markdown),
    })
    feed(observer, 's1', [
      ...simpleTurn(1, 'do it', 'done'),                              // stepped + completed → reviewed
      turnStart(2), turnEnd(2, 'completed'),                          // no-step turn → ignored
      turnStart(3), userMessage('more'), stepStart(3, 1),
      assistantMessage('more done'), stepEnd(3, 1), turnEnd(3, 'aborted'), // stepped but aborted → ignored
    ])
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toContain('**user**: do it')
  })

  it('keeps per-session renderers separate and disposes them', () => {
    const deltas: Array<{ id: string; markdown: string }> = []
    const observer = new SessionTranscriptObserver({
      maxDeltaMessages: 60,
      onDelta: (sessionId, delta) => deltas.push({ id: sessionId, markdown: delta.markdown }),
    })
    const turnA = simpleTurn(1, 'session A prompt', 'A reply')
    const turnB = simpleTurn(1, 'session B prompt', 'B reply')
    feed(observer, 'a', turnA)
    feed(observer, 'b', turnB)
    expect(deltas.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(deltas[0]!.markdown).toContain('session A prompt')
    expect(deltas[1]!.markdown).toContain('session B prompt')

    // Dispose 'a': the next stepped turn/end creates a fresh renderer, which
    // replays the full history once, then resumes incremental deltas.
    observer.disposeSession('a')
    feed(observer, 'a', [...turnA, ...simpleTurn(2, 'second A prompt', 'second A reply')])
    const aDeltas = deltas.filter((entry) => entry.id === 'a')
    expect(aDeltas).toHaveLength(3) // turn 1 (pre-dispose) + replay + turn 2
    expect(aDeltas[1]!.markdown).toContain('session A prompt')
    expect(aDeltas[1]!.markdown).toContain('A reply')
    expect(aDeltas[2]!.markdown).toContain('second A prompt')
    expect(aDeltas[2]!.markdown).not.toContain('session A prompt')
  })

  it('forwards the configured window to per-session renderers (KD-3)', () => {
    const deltas: string[] = []
    const observer = new SessionTranscriptObserver({
      maxDeltaMessages: 1,
      onDelta: (_sessionId, delta) => deltas.push(delta.markdown),
    })
    feed(observer, 's1', simpleTurn(1, 'm1', 'r1'))
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toContain(TRUNCATION_MARKER)
    expect(deltas[0]).toContain('**agent**: r1')
    expect(deltas[0]).not.toContain('**user**: m1')
  })

  it('seeds a session renderer via seedTo (KD-5 enable path)', () => {
    const deltas: string[] = []
    const observer = new SessionTranscriptObserver({
      maxDeltaMessages: 60,
      onDelta: (_sessionId, delta) => deltas.push(delta.markdown),
    })
    const specs = [...simpleTurn(1, 'history', 'old reply'), ...simpleTurn(2, 'new', 'new reply')]
    feed(observer, 's1', specs.slice(0, 6)) // turn 1 completes while observing
    observer.seedTo('s1', 6)                // mid-session enable: skip history
    feed(observer, 's1', specs)             // turn 2 completes
    expect(deltas).toHaveLength(2)
    expect(deltas[1]).toContain('**user**: new')
    expect(deltas[1]).not.toContain('history')
  })

  it('remembers a seed issued before the session renderer exists', () => {
    const deltas: string[] = []
    const observer = new SessionTranscriptObserver({
      maxDeltaMessages: 60,
      onDelta: (_sessionId, delta) => deltas.push(delta.markdown),
    })
    observer.seedTo('s1', 6) // enable before any stepped turn completed
    feed(observer, 's1', simpleTurn(1, 'history', 'old reply'))
    expect(deltas).toHaveLength(0)
    // The next turn renders incrementally (only the new messages).
    feed(observer, 's1', [...simpleTurn(1, 'history', 'old reply'), ...simpleTurn(2, 'fresh', 'fresh reply')])
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toContain('**user**: fresh')
    expect(deltas[0]).not.toContain('history')
  })
})
