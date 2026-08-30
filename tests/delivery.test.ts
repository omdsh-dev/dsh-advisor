/**
 * T6 — delivery routing (spec §2 S3, §4 mapping row, §6 delivery semantics,
 * §8.4 KD-4).
 *
 * Contract under test:
 * - `AdvisorDelivery.route(sessionId, note)` resolves the primary agent for the
 *   session (per-session map from `agent/created`/`agent/disposed` keyed by
 *   `agent.id` === `session.id`, with a `ctx.agents.get(session.id)` registry
 *   fallback — KD-4) and routes the accepted note:
 *   - nit → `agent.inject` (non-waking, next pre-step boundary);
 *   - concern/blocker → `agent.steer` (waking — idle driver starts a turn,
 *     running driver consumes at the next step boundary);
 *   - missing agent → drop the note + log (never throw, never stall).
 * - Advisor message shape (spec §6): a user-role message via `createUserMessage`
 *   whose source carries the distinct `kind === 'advisor'` (the plugin's
 *   `MessageSourceMap` merge extension, src/kinds.ts) and whose content is
 *   self-describing `[advisor:{severity}] {note}`.
 * - immuneTurns (spec §6): after a concern/blocker is actually steered, the
 *   next `immuneTurns` stepped primary turns must complete before another
 *   interrupting note may steer; interrupting notes inside the window downgrade
 *   to inject. The fence arms only on a real steer delivery; `reset` clears the
 *   latch (KD-5 reset triggers); `unregisterAgent` clears it with the session.
 * - Observer hooks: `SessionTranscriptObserver` fires `onSteppedTurnEnd` once
 *   per stepped reviewable turn/end (the cooldown decrement) and `onRewrite` on
 *   compact/replace events (the KD-5 latch reset).
 * - Containment (T4 F1): a throwing agent method inside `route` (the real
 *   delivery seam) never crashes the runtime drain.
 *
 * Events are synthetic but shaped exactly like dsh emits (same builders as the
 * T3 suite); the `feed` helper mirrors the cordis `session/event` listener
 * (each appended event delivered once against the growing live log).
 */

import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId, CONTEXT_SUMMARY_MAX_CHARS, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SurfaceOp } from '@deepseek-ai/dsh-session'
import { AdvisorDelivery, buildAdvisorMessage } from '../src/delivery'
import type { AdvisorDeliveryAgent, AdvisorDeliveryLogger } from '../src/delivery'
import { ADVISOR_SOURCE_KIND } from '../src/kinds'
import { SessionTranscriptObserver } from '../src/transcript'
import type { Delta } from '../src/transcript'
import { AdvisorRuntime } from '../src/advisor-runtime'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Silent logger default so tests don't spam console; pass a spy to assert. */
const silentLogger: AdvisorDeliveryLogger = { debug: () => {}, warn: () => {} }

function makeLogger(): { logger: AdvisorDeliveryLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  return { logger: { debug: () => {}, warn }, warn }
}

/** Fake agent with inject/steer spies (structural `AdvisorDeliveryAgent`). */
function makeAgent(id = 's1'): {
  agent: AdvisorDeliveryAgent
  inject: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
} {
  const inject = vi.fn()
  const steer = vi.fn()
  return { agent: { id, inject, steer }, inject, steer }
}

function makeDelivery(
  immuneTurns: number,
  overrides: Partial<ConstructorParameters<typeof AdvisorDelivery>[0]> = {},
): AdvisorDelivery {
  return new AdvisorDelivery({ immuneTurns, logger: silentLogger, ...overrides })
}

// ---------------------------------------------------------------------------
// Severity → channel routing (spec §6)
// ---------------------------------------------------------------------------

describe('AdvisorDelivery — severity → channel routing (spec §6)', () => {
  it('routes nit to inject, never waking the agent', () => {
    const { agent, inject, steer } = makeAgent()
    const delivery = makeDelivery(3)
    delivery.registerAgent(agent)

    expect(delivery.route('s1', { note: 'add a test for this branch', severity: 'nit' })).toBe('inject')
    expect(inject).toHaveBeenCalledTimes(1)
    expect(steer).not.toHaveBeenCalled()
  })

  it('routes concern to steer (waking)', () => {
    const { agent, inject, steer } = makeAgent()
    const delivery = makeDelivery(3)
    delivery.registerAgent(agent)

    expect(delivery.route('s1', { note: 'this loop looks wrong', severity: 'concern' })).toBe('steer')
    expect(steer).toHaveBeenCalledTimes(1)
    expect(inject).not.toHaveBeenCalled()
  })

  it('routes blocker to steer (waking)', () => {
    const { agent, steer } = makeAgent()
    const delivery = makeDelivery(3)
    delivery.registerAgent(agent)

    expect(delivery.route('s1', { note: 'continuing clearly wastes work', severity: 'blocker' })).toBe('steer')
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('resolves the agent via the registry fallback when the map has no entry (KD-4)', () => {
    const { agent, steer } = makeAgent()
    // The map is empty; only the registry fallback can resolve the agent.
    const delivery = makeDelivery(3, { lookupAgent: (id) => (id === 's1' ? agent : undefined) })

    expect(delivery.route('s1', { note: 'fallback steering', severity: 'concern' })).toBe('steer')
    expect(steer).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Advisor message construction (spec §6)
// ---------------------------------------------------------------------------

describe('AdvisorDelivery — advisor message construction (spec §6)', () => {
  it('builds a user-role message with the advisor source kind and self-describing content', () => {
    const message = buildAdvisorMessage({ note: 'extract the helper', severity: 'concern' })
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe(ADVISOR_SOURCE_KIND)
    expect(message.source).toMatchObject({
      form: 'notice',
      summary: '[concern] extract the helper',
    })
    expect(message.content).toEqual([{ type: 'text', text: '[advisor:concern] extract the helper' }])
  })

  it('bounds the notice summary to CONTEXT_SUMMARY_MAX_CHARS with an ellipsis (qc3 F-2 / qc2 S-1)', () => {
    const message = buildAdvisorMessage({ note: 'n'.repeat(500), severity: 'concern' })
    const source = message.source as { kind: string; form?: string; summary?: string }
    expect(source.form).toBe('notice')
    expect(source.summary!.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_CHARS)
    expect(source.summary!.endsWith('…')).toBe(true)
    // The bounded summary is derived from the same formatter as the content.
    expect(message.content).toEqual([{ type: 'text', text: `[advisor:concern] ${'n'.repeat(500)}` }])
  })

  it('routes the self-describing advisor message, not the raw note', () => {
    const { agent, inject } = makeAgent()
    const delivery = makeDelivery(3)
    delivery.registerAgent(agent)

    delivery.route('s1', { note: 'slow down and re-read the task', severity: 'nit' })
    const message = inject.mock.calls[0]![0] as UserMessage
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('advisor')
    expect(message.content).toEqual([{ type: 'text', text: '[advisor:nit] slow down and re-read the task' }])
  })
})

// ---------------------------------------------------------------------------
// immuneTurns cooldown (spec §6)
// ---------------------------------------------------------------------------

describe('AdvisorDelivery — immuneTurns cooldown (spec §6)', () => {
  it('downgrades interrupting notes to inject until N stepped turns complete, then steers again', () => {
    const { agent, inject, steer } = makeAgent()
    const delivery = makeDelivery(3)
    delivery.registerAgent(agent)

    // Turn N completes → the advisor extracts a concern → actually steered → the
    // fence arms with a countdown of immuneTurns (3).
    expect(delivery.route('s1', { note: 'first interrupt', severity: 'concern' })).toBe('steer')

    // Each completed stepped primary turn decrements the countdown; interrupting
    // notes inside the window downgrade to inject (and never re-arm the fence).
    delivery.onSteppedTurnEnd('s1')
    expect(delivery.route('s1', { note: 'still a problem', severity: 'blocker' })).toBe('inject')
    delivery.onSteppedTurnEnd('s1')
    expect(delivery.route('s1', { note: 'still a problem 2', severity: 'concern' })).toBe('inject')
    delivery.onSteppedTurnEnd('s1') // third turn completes → cooldown exhausted

    // Steering resumes.
    expect(delivery.route('s1', { note: 'still a problem 3', severity: 'concern' })).toBe('steer')

    expect(steer).toHaveBeenCalledTimes(2)
    expect(inject).toHaveBeenCalledTimes(2)
  })

  it('never arms the fence on a nit — a concern right after a nit still steers', () => {
    const { agent, inject, steer } = makeAgent()
    const delivery = makeDelivery(3)
    delivery.registerAgent(agent)

    expect(delivery.route('s1', { note: 'minor nit', severity: 'nit' })).toBe('inject')
    expect(delivery.route('s1', { note: 'real concern', severity: 'concern' })).toBe('steer')
    expect(steer).toHaveBeenCalledTimes(1)

    // Inside the armed window, nits still inject (they were inject all along).
    delivery.onSteppedTurnEnd('s1')
    expect(delivery.route('s1', { note: 'another nit', severity: 'nit' })).toBe('inject')
    expect(inject).toHaveBeenCalledTimes(2)
  })

  it('immuneTurns 0 disables the cooldown — every interrupt steers', () => {
    const { agent, steer } = makeAgent()
    const delivery = makeDelivery(0)
    delivery.registerAgent(agent)

    expect(delivery.route('s1', { note: 'a', severity: 'concern' })).toBe('steer')
    expect(delivery.route('s1', { note: 'b', severity: 'blocker' })).toBe('steer')
    expect(steer).toHaveBeenCalledTimes(2)
  })

  it('reset clears the armed cooldown (KD-5 reset triggers)', () => {
    const { agent, steer } = makeAgent()
    const delivery = makeDelivery(3)
    delivery.registerAgent(agent)

    delivery.route('s1', { note: 'interrupt', severity: 'concern' }) // arms 3
    delivery.reset('s1')                                             // compaction / surface replace
    expect(delivery.route('s1', { note: 'after reset', severity: 'concern' })).toBe('steer')
    expect(steer).toHaveBeenCalledTimes(2)
  })

  it('unregisterAgent clears the agent and its cooldown with the session (KD-4 dispose)', () => {
    const { agent } = makeAgent()
    const delivery = makeDelivery(3)
    delivery.registerAgent(agent)

    delivery.route('s1', { note: 'interrupt', severity: 'concern' }) // arms 3
    delivery.unregisterAgent('s1')
    // No agent anymore → dropped (and the cooldown died with the session).
    expect(delivery.route('s1', { note: 'x', severity: 'concern' })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Missing agent → drop (KD-4)
// ---------------------------------------------------------------------------

describe('AdvisorDelivery — missing agent → drop (KD-4)', () => {
  it('drops the note without throwing when no agent resolves, and logs a warning', () => {
    const { logger, warn } = makeLogger()
    const delivery = new AdvisorDelivery({ immuneTurns: 3, logger })

    expect(delivery.route('ghost-session', { note: 'no agent here', severity: 'blocker' })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('no agent')
  })
})

// ---------------------------------------------------------------------------
// Contained throw through the real routing seam (T4 F1)
// ---------------------------------------------------------------------------

/** Scripted fake for the runtime's `llm` option (same shape as the T4 suite). */
class FakeLlm {
  readonly calls: GenerateOptions[] = []
  constructor(private readonly responses: readonly { readonly chunks: readonly StreamChunk[] }[]) {}
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const response = this.responses[this.calls.length - 1]
    if (response === undefined) throw new Error(`FakeLlm: unexpected stream call #${this.calls.length}`)
    return streamOf(response.chunks)
  }
}

async function* streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  yield * chunks
}

const textReply = (text: string): readonly StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

const delta = (markdown: string): Delta => ({ markdown, willContinue: false })

describe('AdvisorDelivery — contained throw through the routing seam (T4 F1)', () => {
  it('a throwing agent method inside route never crashes the runtime drain', async () => {
    const { agent } = makeAgent()
    agent.steer = vi.fn(() => {
      throw new Error('steer exploded')
    })
    const delivery = makeDelivery(3)
    delivery.registerAgent(agent)

    const llm = new FakeLlm([
      { chunks: textReply('{"note":"first"}') },
      { chunks: textReply('{"note":"second","severity":"concern"}') },
    ])
    const runtime = new AdvisorRuntime({
      provider: 'test-provider',
      model: 'test-model',
      systemPrompt: 'review',
      llm,
      onNote: (note) => {
        delivery.route('s1', note)
      },
      retryBackoffMs: 0,
    })

    runtime.enqueue(delta('update one'))
    runtime.enqueue(delta('update two'))
    // The drain kicker must resolve, not reject (an unhandled rejection would
    // crash the process under Node ≥22/24 defaults) — T4 F1 containment holds
    // through the actual delivery routing seam.
    await expect(runtime.waitForDrain()).resolves.toBeUndefined()

    expect(llm.calls).toHaveLength(2) // the drain continued past both throws
    expect(runtime.status()).toBe('running')
    expect(runtime.pendingCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SessionTranscriptObserver — delivery hooks (turn counting + latch reset)
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
    data: { id: MessageId(`user-${value}`), role: 'user', content: [text(value)], source },
    surfaceOp,
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  }
}

function assistantMessage(value: string): EventSpec {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: MessageId(`assistant-${value}`),
        role: 'assistant',
        content: [text(value)],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
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

/** Mirror the cordis `session/event` listener: deliver each appended event once. */
function feedAppend(
  observer: SessionTranscriptObserver,
  sessionId: string,
  base: readonly EventSpec[],
  added: readonly EventSpec[],
): void {
  const all = buildEvents([...base, ...added])
  for (let index = base.length; index < all.length; index++) {
    observer.handleEvent(sessionId, all.slice(0, index + 1), all[index]!)
  }
}

describe('SessionTranscriptObserver — delivery hooks (T6)', () => {
  it('fires onSteppedTurnEnd once per stepped reviewable turn/end, skipping no-step and aborted turns', () => {
    const ends: string[] = []
    const observer = new SessionTranscriptObserver({
      maxDeltaMessages: 60,
      onDelta: () => {},
      onSteppedTurnEnd: (sessionId) => ends.push(sessionId),
    })
    feedAppend(observer, 's1', [], [
      ...simpleTurn(1, 'do it', 'done'),
      turnStart(2), turnEnd(2, 'completed'),                                    // no-step turn → no fire
      turnStart(3), userMessage('more'), stepStart(3, 1),
      assistantMessage('more done'), stepEnd(3, 1), turnEnd(3, 'aborted'),       // stepped but aborted → no fire
      ...simpleTurn(4, 'again', 'again done'),
    ])
    expect(ends).toEqual(['s1', 's1'])
  })

  it('fires onRewrite for compact/* and replace events, never for plain appends', () => {
    const rewrites: string[] = []
    const observer = new SessionTranscriptObserver({
      maxDeltaMessages: 60,
      onDelta: () => {},
      onRewrite: (sessionId) => rewrites.push(sessionId),
    })
    feedAppend(observer, 's1', [], [
      ...simpleTurn(1, 'hi', 'hello'),                                      // appends only → no rewrite
      compactStart(),                                                        // compact/* → rewrite
      userMessage('replaced prompt', { kind: 'user' }, { op: 'replace', start: 1, end: 3 }, [1, 3]), // surface replace → rewrite
      ...simpleTurn(2, 'next', 'reply'),                                     // appends → no rewrite
    ])
    expect(rewrites).toEqual(['s1', 's1'])
  })

  it('wires observer turn-ends into the delivery cooldown end to end', () => {
    const { agent, inject, steer } = makeAgent()
    const delivery = makeDelivery(2)
    delivery.registerAgent(agent)
    const observer = new SessionTranscriptObserver({
      maxDeltaMessages: 60,
      onDelta: () => {},
      onSteppedTurnEnd: (sessionId) => delivery.onSteppedTurnEnd(sessionId),
    })

    const turn1 = simpleTurn(1, 'first', 'reply one')
    const turn2 = simpleTurn(2, 'second', 'reply two')
    const turn3 = simpleTurn(3, 'third', 'reply three')

    // Turn 1 completes; the advisor (async) then delivers an interrupt → steer
    // arms the fence with a countdown of 2.
    feedAppend(observer, 's1', [], turn1)
    expect(delivery.route('s1', { note: 'interrupt', severity: 'concern' })).toBe('steer')

    // Turn 2 completes → countdown 1; the next interrupt downgrades to inject.
    feedAppend(observer, 's1', turn1, turn2)
    expect(delivery.route('s1', { note: 'still', severity: 'blocker' })).toBe('inject')

    // Turn 3 completes → countdown exhausted; steering resumes.
    feedAppend(observer, 's1', [...turn1, ...turn2], turn3)
    expect(delivery.route('s1', { note: 'resume', severity: 'concern' })).toBe('steer')

    expect(steer).toHaveBeenCalledTimes(2)
    expect(inject).toHaveBeenCalledTimes(1)
  })
})
