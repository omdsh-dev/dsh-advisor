/**
 * Session model override (spec §5.3) — composed wiring regressions.
 *
 * Unlike the command-surface unit suite (tests/commands.test.ts — parse /
 * render / handler dispatch against fakes), these tests compose the REAL
 * plugin into a real cordis `Context` (the tests/settings-live.test.ts
 * harness pattern: loader double via `MemoryEntryConfig`, real `LlmRuntime`
 * + stub adapter on both provider routes, a working fake agents registry,
 * and a captured commands registry) and drive the override through the real
 * `/advisor model` handler + `agent/*` lifecycle events, proving the WIRING:
 *
 * 1. A/B session isolation + inheritor default tracking: a session pin
 *    affects only its own session; global default edits reach inheritors,
 *    never pinned sessions.
 * 2. Global vs effective readback: `/advisor config` stays the GLOBAL
 *    defaults; `/advisor status` + `/advisor model` report the EFFECTIVE
 *    route with its source.
 * 3. Gate distinction: a complete session pair satisfies a pairless-but-valid
 *    global default; a MALFORMED global config cannot be bypassed.
 * 4. Model ops never toggle the enable switch; `/advisor off` retains the
 *    pin for a later `/advisor on`; an equal-default pin records without
 *    restarting the runtime (in-flight call survives) yet protects against
 *    later global edits.
 * 5. Validation fencing: the 60 s deadline fires against a hung lookup
 *    (cancellation honored by the CALLER, not the adapter); command cancel,
 *    supersede by a newer command, reset-during-validation, session dispose,
 *    and owner unload all leave the previous selection untouched.
 * 6. Route change effect: aborts the old advisor call, drops the backlog,
 *    re-seeds (no replay), and takes effect at the next delta; a late note
 *    from the old route is never delivered.
 * 7. Cold resume / fork lifetime: `agent/disposed` clears the pin — a
 *    re-created (forked or cold-resumed) session inherits global defaults.
 * 8. Multi-fiber single owner: a second plugin fiber stays inert (still one
 *    command registration; the elected owner keeps serving the surface).
 *
 * The deadline case uses fake timers so the 60 s default fires
 * deterministically; every other case runs on real timers.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryEntryConfig, harnessAdvisorPlugin } from './support/memory-settings'
import { LlmAdapter, LlmRuntime, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AdvisorConfig } from '../src/config'

// n4 QC F-6: the single-reviewer guard is process-global; each test case
// composes a fresh harness, so the flag must reset between cases (production
// keeps the first-claim-wins behavior).
beforeEach(() => {
  delete (globalThis as Record<string, unknown>)['__dshAdvisorReviewer__']
})

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

/** Chunk script for a successful text reply. */
const textReply = (note: string): readonly StreamChunk[] => [
  { type: 'text-delta', index: 0, text: `{"note":"${note}","severity":"nit"}` },
  { type: 'finish', reason: { kind: 'stop' } },
]

/**
 * Stub `LlmAdapter` with (a) a scripted stream reply per call order and
 * (b) an optional one-shot GATE on the next stream call (the in-flight-call
 * probe). `resolveModel` echoes the route (the validation acceptance gate).
 */
class GatedStubAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string, _signal?: undefined): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('off') },
    })
  }

  readonly requests: GenerateOptions[] = []
  private gate: Promise<void> | undefined
  private releaseGate: (() => void) | undefined

  constructor(private readonly script: ReadonlyArray<readonly StreamChunk[]>) {
    super()
  }

  /** Block the next stream call until {@link release} is called. */
  blockNext(): void {
    this.gate = new Promise((resolve) => { this.releaseGate = resolve })
  }

  /** Release the blocked call (if any). */
  release(): void {
    const release = this.releaseGate
    this.releaseGate = undefined
    this.gate = undefined
    release?.()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const gate = this.gate
    this.gate = undefined
    if (gate !== undefined) await gate
    const reply = this.script[this.requests.length - 1]
    if (reply === undefined) {
      throw new Error(`GatedStubAdapter: script exhausted after ${this.requests.length} calls`)
    }
    yield * reply
  }
}

/**
 * Stub adapter whose `resolveModel` (the validation lookup) hangs until
 * released and counts every attempt. It deliberately IGNORES the abort
 * signal — exactly the hung-adapter case the wiring's `raceSignal` exists
 * for: the 60 s deadline must fire in the CALLER even when the adapter
 * never settles and never observes cancellation.
 */
class HangingResolveAdapter extends GatedStubAdapter {
  private hold: Promise<void> | undefined
  private releaseHold: (() => void) | undefined
  resolveAttempts = 0

  constructor() {
    super([])
  }

  hangNextResolve(): void {
    this.hold = new Promise((resolve) => { this.releaseHold = resolve })
  }

  releaseResolve(): void {
    const release = this.releaseHold
    this.hold = undefined
    this.releaseHold = undefined
    release?.()
  }

  override resolveModel(provider: string, model: string, _signal?: undefined): Promise<LlmResolvedModelInfo> {
    this.resolveAttempts++
    const hold = this.hold
    // Consume ONLY the hold — `releaseHold` must survive until releaseResolve
    // (the settings-live GatedAdapter makes the same split for its gate).
    if (hold !== undefined) {
      this.hold = undefined
      return hold.then(() => super.resolveModel(provider, model))
    }
    return super.resolveModel(provider, model)
  }
}

// ---------------------------------------------------------------------------
// Composed harness (loader double + real plugin + commands registry)
// ---------------------------------------------------------------------------

/** Merge test config over the schema defaults (full `AdvisorConfig` shape). */
function fullConfig(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    enabled: false,
    systemPrompt: '',
    immuneTurns: 3,
    maxDeltaMessages: 60,
    ...overrides,
  }
}

async function composeOverrideHarness(
  config: Partial<AdvisorConfig>,
  replies: ReadonlyArray<readonly StreamChunk[]>,
): Promise<{
  ctx: Context
  adapter: GatedStubAdapter
  entry: MemoryEntryConfig
  handler: CommandDefinition['handler']
  definitions: CommandDefinition[]
  agents: Map<string, Agent>
  fiber: { dispose(): Promise<void> }
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new GatedStubAdapter(replies)
  ctx.llm.registerAdapter(['stub', 'other'], adapter)
  ctx.provide('sessions', {} as never)
  // A WORKING registry (unlike settings-live's always-undefined stub): the
  // controller's setModel fence checks session liveness through
  // `ctx.agents.get(sessionId)` (spec §5.3 — a dispose cannot be undone by a
  // delayed completion), so the harness registry must track live agents.
  const agents = new Map<string, Agent>()
  ctx.provide('agents', { get: (id: string) => agents.get(id) } as never)
  const entry = new MemoryEntryConfig(fullConfig(config))
  // The fiber handle is the OWNER-TEARDOWN seam in tests (Fiber.dispose —
  // unload the plugin, run the claim-release effect).
  const fiber = await ctx.plugin(harnessAdvisorPlugin(), entry.config)
  // The commands registry composes the conditional inject child (same lazy
  // activation as the settings-live suite).
  const definitions: CommandDefinition[] = []
  ctx.provide('commands', {
    register: (definition: CommandDefinition): (() => void) => {
      definitions.push(definition)
      return () => {}
    },
  } as never)
  await vi.waitFor(() => expect(definitions).toHaveLength(1))
  return { ctx, adapter, entry, handler: definitions[0]!.handler, definitions, agents, fiber: fiber as unknown as { dispose(): Promise<void> } }
}

/** Publish a fake agent (steer/inject spies) and register it for liveness. */
function publishAgent(
  ctx: Context,
  agents: Map<string, Agent>,
  id = 's1',
): { inject: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn> } {
  const inject = vi.fn()
  const steer = vi.fn()
  const agent = { id, inject, steer } as unknown as Agent
  agents.set(id, agent)
  ctx.emit('agent/created', { agent, source: 'startup' })
  return { inject, steer }
}

/** A session whose `events` is a live log the feed loop grows in place, with
 * a mutable `seq` (the `/advisor` handler reads it for the KD-5 seed). */
function makeSession(id = 's1'): { session: Session; log: SessionEvent[] } {
  const log: SessionEvent[] = []
  const session = { id, snapshotEvents: () => log, seq: 0 } as unknown as Session
  return { session, log }
}

/** Text of the single user delta message the runtime sends the model. */
function deltaTextOf(options: GenerateOptions): string {
  const block = options.messages[0]!.content[0]!
  return block.type === 'text' ? block.text : ''
}

// ---------------------------------------------------------------------------
// Synthetic session event builders (mirror of the T3/T6/T8 fixtures)
// ---------------------------------------------------------------------------

interface EventSpec {
  type: string
  data: unknown
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

function userMessage(value: string): EventSpec {
  return {
    type: 'user/message',
    data: { id: MessageId(`user-${value}`), role: 'user', content: [text(value)], source: { kind: 'user' } },
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
  }
}

const turnStart = (turn: number): EventSpec => ({ type: 'turn/start', data: { turn } })
const stepStart = (turn: number, step: number): EventSpec => ({ type: 'step/start', data: { turn, step } })
const stepEnd = (turn: number, step: number): EventSpec => ({ type: 'step/end', data: { turn, step } })

const turnEnd = (turn: number, reason = 'completed'): EventSpec => ({
  type: 'turn/end',
  data: { turn, reason: { kind: reason } },
})

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
function feed(ctx: Context, session: Session, log: SessionEvent[], specs: readonly EventSpec[]): void {
  const offset = log.length
  const events = specs.map((spec, index) => ({
    type: spec.type,
    seq: offset + index,
    time: 1_000 + offset + index,
    data: spec.data,
  })) as unknown as SessionEvent[]
  for (const event of events) {
    log.push(event)
    ctx.emit('session/event', session, event)
  }
  ;(session as { seq: number }).seq = log.length
}

/** Invoke the captured handler; `model set` is legitimately async. */
async function invokeAdvisor(
  handler: CommandDefinition['handler'],
  rawInput: string,
  session: Session,
  signal = new AbortController().signal,
): Promise<CommandResult> {
  const result = handler({
    commandId: 'c' as never,
    agent: { id: session.id, session } as unknown as Agent,
    rawInput,
    attachments: [],
    signal,
  } as CommandInvocation)
  return result instanceof Promise ? result : Promise.resolve(result)
}

const textOf = (result: CommandResult): string => (result.kind === 'success' ? result.text ?? '' : '')

/** Deregister + announce one agent's disposal (the KD-5(c) cleanup trigger). */
function disposeAgent(ctx: Context, agents: Map<string, Agent>, id: string): void {
  const agent = agents.get(id)
  if (agent === undefined) throw new Error(`test: agent ${id} is not registered`)
  agents.delete(id)
  ctx.emit('agent/disposed', { agent })
}

/** Small deterministic wait so async task chains (and would-be calls) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

// ---------------------------------------------------------------------------
// 1 + 2. A/B isolation, inheritor tracking, global vs effective readback
// ---------------------------------------------------------------------------

describe('session model override — A/B isolation + inheritor tracking (spec §5.3)', () => {
  it('a pin affects only its own session; global edits reach inheritors, never the pinned session', async () => {
    const { ctx, adapter, entry, handler, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [textReply('a1'), textReply('b1'), textReply('a2'), textReply('b2')],
    )
    publishAgent(ctx, agents, 'A')
    publishAgent(ctx, agents, 'B')
    const sessionA = makeSession('A')
    const sessionB = makeSession('B')

    // Pin session A to the `other` route; B stays on the global default.
    const setResult = await invokeAdvisor(handler, ' model set other other-model', sessionA.session)
    expect(textOf(setResult)).toContain('Session model pinned: other/other-model')

    feed(ctx, sessionA.session, sessionA.log, simpleTurn(1, 'a1', 'a1r'))
    feed(ctx, sessionB.session, sessionB.log, simpleTurn(1, 'b1', 'b1r'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    expect(adapter.requests[0]).toMatchObject({ provider: 'other', model: 'other-model' })
    expect(adapter.requests[1]).toMatchObject({ provider: 'stub', model: 'stub-model' })

    // Global default edit: B (inheritor) follows; A (pinned) does not.
    entry.commit(ctx, { provider: 'other', model: 'other-model-2' })
    feed(ctx, sessionA.session, sessionA.log, simpleTurn(2, 'a2', 'a2r'))
    feed(ctx, sessionB.session, sessionB.log, simpleTurn(2, 'b2', 'b2r'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(4))
    expect(adapter.requests[2]).toMatchObject({ provider: 'other', model: 'other-model' }) // pinned
    expect(adapter.requests[3]).toMatchObject({ provider: 'other', model: 'other-model-2' }) // inheritor
  })

  it('readback labels: /advisor config stays GLOBAL; /advisor status + /advisor model report the effective route', async () => {
    const { ctx, handler, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [],
    )
    publishAgent(ctx, agents, 's1')
    const { session } = makeSession('s1')

    const configBefore = await invokeAdvisor(handler, ' config', session)
    expect(textOf(configBefore)).toContain('Model: stub/stub-model')

    await invokeAdvisor(handler, ' model set other other-model', session)

    // /advisor config reads the SESSION-LESS entry config — still the global
    // default (a session pin must never leak into the config readback).
    const configAfter = await invokeAdvisor(handler, ' config', session)
    expect(textOf(configAfter)).toContain('Model: stub/stub-model')

    const status = await invokeAdvisor(handler, ' status', session)
    expect(textOf(status)).toContain('Model: other/other-model (session override)')
    const model = await invokeAdvisor(handler, ' model', session)
    expect(textOf(model)).toContain('Model: other/other-model')
    expect(textOf(model)).toContain('Source: session override')

    // Reset re-inherits the CURRENT default; the labels flip back.
    const reset = await invokeAdvisor(handler, ' model reset', session)
    expect(textOf(reset)).toContain('pin removed')
    expect(textOf(reset)).toContain('Model: stub/stub-model (global default)')
  })
})

// ---------------------------------------------------------------------------
// 3. Gate distinction: pairless-but-valid default vs malformed global
// ---------------------------------------------------------------------------

describe('session model override — explicit gate applies AFTER session resolution (spec §5.2+§5.3)', () => {
  it('a complete session pair satisfies a pairless-but-valid global default', async () => {
    const { ctx, adapter, handler, agents } = await composeOverrideHarness(
      // Enabled globally WITHOUT a pair: gate-blocked (no model call anywhere).
      { enabled: true },
      [textReply('unblocked')],
    )
    publishAgent(ctx, agents, 's1')
    const { session, log } = makeSession('s1')

    // Pre-pin: no runtime, status shows the S4 reason.
    feed(ctx, session, log, simpleTurn(1, 'u1', 'a1'))
    await flush()
    expect(adapter.requests).toHaveLength(0)
    const before = await invokeAdvisor(handler, ' status', session)
    expect(textOf(before)).toContain('provider and model are missing')

    // Pin: the pair satisfies the gate for THIS session only — the advisor runs.
    const setResult = await invokeAdvisor(handler, ' model set stub stub-model', session)
    expect(textOf(setResult)).toContain('Session model pinned: stub/stub-model')
    feed(ctx, session, log, simpleTurn(2, 'u2', 'a2'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    expect(adapter.requests[0]).toMatchObject({ provider: 'stub', model: 'stub-model' })
  })

  it('a malformed global config cannot be bypassed — the pin records but the advisor stays blocked', async () => {
    const { ctx, adapter, entry, handler, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [textReply('x')],
    )
    publishAgent(ctx, agents, 's1')
    const { session, log } = makeSession('s1')
    feed(ctx, session, log, simpleTurn(1, 'u1', 'a1'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    // An unknown key survives the non-strict schemastery merge into the entry:
    // the resolver rejects the composed config → fail closed for EVERY session.
    entry.commit(ctx, { evil: 1 } as unknown as Partial<AdvisorConfig>)
    await flush()
    const stopped = adapter.requests.length
    feed(ctx, session, log, simpleTurn(2, 'u2', 'a2'))
    await flush()
    expect(adapter.requests.length).toBe(stopped) // no model call on a broken config

    // The pin still validates (the LLM service is config-independent) and
    // records, but the effective route stays fail-closed.
    const setResult = await invokeAdvisor(handler, ' model set other other-model', session)
    expect(textOf(setResult)).toContain('Session model pinned')
    const status = await invokeAdvisor(handler, ' status', session)
    expect(textOf(status)).toContain('unknown config key "evil"')
    expect(textOf(status)).not.toContain('(session override)')
    feed(ctx, session, log, simpleTurn(3, 'u3', 'a3'))
    await flush()
    expect(adapter.requests.length).toBe(stopped)
  })
})

// ---------------------------------------------------------------------------
// 4. Enable-switch independence + equal-default pin
// ---------------------------------------------------------------------------

describe('session model override — enable-switch independence (spec §5.3)', () => {
  it('model set never toggles enabled; off retains the pin for a later on', async () => {
    const { ctx, adapter, handler, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [textReply('after on')],
    )
    publishAgent(ctx, agents, 's1')
    const { session, log } = makeSession('s1')

    await invokeAdvisor(handler, ' off', session)
    // Pin while OFF: recorded (committed), but no runtime, no model call.
    const setResult = await invokeAdvisor(handler, ' model set other other-model', session)
    expect(textOf(setResult)).toContain('Session model pinned: other/other-model')
    const status = await invokeAdvisor(handler, ' status', session)
    expect(textOf(status)).toContain('Advisor: disabled')
    expect(textOf(status)).toContain('Model: other/other-model (session override)')
    feed(ctx, session, log, simpleTurn(1, 'u1', 'a1'))
    await flush()
    expect(adapter.requests).toHaveLength(0) // disabled: no call

    // On picks up the RETAINED pin, not the global default.
    await invokeAdvisor(handler, ' on', session)
    feed(ctx, session, log, simpleTurn(2, 'u2', 'a2'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    expect(adapter.requests[0]).toMatchObject({ provider: 'other', model: 'other-model' })
  })

  it('an equal-default pin records without restarting (in-flight call survives) and protects against later default edits', async () => {
    const { ctx, adapter, entry, handler, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [textReply('in flight'), textReply('after edit')],
    )
    const { inject } = publishAgent(ctx, agents, 's1')
    const { session, log } = makeSession('s1')

    // Call in flight on the global route.
    adapter.blockNext()
    feed(ctx, session, log, simpleTurn(1, 'u1', 'a1'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    // Pin the SAME route: outcome 'unchanged' — the in-flight call is NOT
    // aborted (an equal pin restarts nothing) and its note still delivers.
    const setResult = await invokeAdvisor(handler, ' model set stub stub-model', session)
    expect(textOf(setResult)).toContain('same effective route, runtime untouched')
    const status = await invokeAdvisor(handler, ' status', session)
    expect(textOf(status)).toContain('(session override)') // recorded as a pin

    adapter.release()
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1))

    // Protection: a later global default edit does NOT touch the pinned route.
    entry.commit(ctx, { provider: 'other', model: 'other-model' })
    feed(ctx, session, log, simpleTurn(2, 'u2', 'a2'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    expect(adapter.requests[1]).toMatchObject({ provider: 'stub', model: 'stub-model' })
  })
})

// ---------------------------------------------------------------------------
// 5. Validation fencing (deadline / cancel / supersede / reset / dispose)
// ---------------------------------------------------------------------------

describe('session model override — validation fencing (spec §5.3)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the 60s deadline fires against a hung lookup even when the adapter ignores cancellation', async () => {
    const { ctx, handler, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [],
    )
    const hanging = new HangingResolveAdapter()
    ctx.llm.registerAdapter(['hang'], hanging)
    hanging.hangNextResolve()
    publishAgent(ctx, agents, 's1')
    const { session } = makeSession('s1')

    vi.useFakeTimers()
    const pending = invokeAdvisor(handler, ' model set hang hang-model', session)
    const settled = pending.then(textOf)
    await vi.advanceTimersByTimeAsync(59_000)
    let done = false
    void settled.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false) // before the deadline: still validating

    await vi.advanceTimersByTimeAsync(1_000)
    const reply = await settled
    expect(reply).toContain('model validation timed out after 60000ms')
    expect(hanging.resolveAttempts).toBe(1) // no automatic retry
    // Failure leaves the previous selection untouched.
    const status = await invokeAdvisor(handler, ' status', session)
    expect(textOf(status)).toContain('Model: stub/stub-model (global default)')
  }, 15_000)

  it('cancelling the invoking command aborts the lookup with NO retry; previous selection untouched', async () => {
    const { ctx, handler, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [],
    )
    const hanging = new HangingResolveAdapter()
    ctx.llm.registerAdapter(['hang'], hanging)
    hanging.hangNextResolve()
    publishAgent(ctx, agents, 's1')
    const { session } = makeSession('s1')
    const controller = new AbortController()

    const pending = invokeAdvisor(handler, ' model set hang hang-model', session, controller.signal)
    await flush()
    controller.abort()
    const reply = textOf(await pending)
    expect(reply).toContain('cancelled')
    // No automatic retry: exactly one resolveModel attempt was made.
    expect(hanging.resolveAttempts).toBe(1)
    const status = await invokeAdvisor(handler, ' status', session)
    expect(textOf(status)).toContain('(global default)')
  })

  it('a newer set supersedes unresolved older work; the final pin is the newer pair', async () => {
    const { ctx, handler, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [],
    )
    const hanging = new HangingResolveAdapter()
    ctx.llm.registerAdapter(['hang'], hanging)
    hanging.hangNextResolve()
    publishAgent(ctx, agents, 's1')
    const { session } = makeSession('s1')

    const first = invokeAdvisor(handler, ' model set hang hang-model', session)
    await flush()
    // Second set starts while the first is unresolved: generation bumps.
    const second = invokeAdvisor(handler, ' model set other other-model', session)
    expect(textOf(await second)).toContain('Session model pinned: other/other-model')

    hanging.releaseResolve()
    expect(textOf(await first)).toContain('superseded')
    const status = await invokeAdvisor(handler, ' status', session)
    expect(textOf(status)).toContain('Model: other/other-model (session override)')
  })

  it('reset during validation supersedes the pending set and re-inherits', async () => {
    const { ctx, handler, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [],
    )
    const hanging = new HangingResolveAdapter()
    ctx.llm.registerAdapter(['hang'], hanging)
    hanging.hangNextResolve()
    publishAgent(ctx, agents, 's1')
    const { session } = makeSession('s1')

    const pending = invokeAdvisor(handler, ' model set hang hang-model', session)
    await flush()
    const reset = await invokeAdvisor(handler, ' model reset', session)
    expect(textOf(reset)).toContain('already inherits') // nothing pinned yet

    hanging.releaseResolve()
    expect(textOf(await pending)).toContain('superseded')
    const status = await invokeAdvisor(handler, ' status', session)
    expect(textOf(status)).toContain('(global default)')
  })

  it('a session dispose during validation cannot be undone by the delayed completion', async () => {
    const { ctx, agents, handler } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [],
    )
    const hanging = new HangingResolveAdapter()
    ctx.llm.registerAdapter(['hang'], hanging)
    hanging.hangNextResolve()
    publishAgent(ctx, agents, 's1')
    const { session } = makeSession('s1')

    const pending = invokeAdvisor(handler, ' model set hang hang-model', session)
    await flush()
    // Dispose the session while the lookup is in flight: the wiring clears the
    // override state AND the registry entry (the liveness fence).
    disposeAgent(ctx, agents, 's1')

    hanging.releaseResolve()
    expect(textOf(await pending)).toContain('no longer live')
    // The cold-resumed session inherits the global defaults.
    const status = await invokeAdvisor(handler, ' status', session)
    expect(textOf(status)).toContain('(global default)')
  })

  it('owner unload during validation aborts the lookup and drops the pin commit', async () => {
    const { ctx, fiber, handler, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [],
    )
    const hanging = new HangingResolveAdapter()
    ctx.llm.registerAdapter(['hang'], hanging)
    hanging.hangNextResolve()
    publishAgent(ctx, agents, 's1')
    const { session } = makeSession('s1')

    const pending = invokeAdvisor(handler, ' model set hang hang-model', session)
    await flush()
    await fiber.dispose() // owner teardown: release the claim + abort validations
    hanging.releaseResolve()
    expect(textOf(await pending)).toContain('no longer live')
  })
})

// ---------------------------------------------------------------------------
// 6. Route change effect: abort old call, drop backlog, re-seed, next delta
// ---------------------------------------------------------------------------

describe('session model override — route change effect (spec §5.3)', () => {
  it('aborts the old call, drops the backlog, re-seeds (no replay), and serves the next delta on the new route', async () => {
    const { ctx, adapter, handler, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [textReply('old route note'), textReply('new route note')],
    )
    const { inject } = publishAgent(ctx, agents, 's1')
    const { session, log } = makeSession('s1')

    // Turn 1 drains on the old route; turn 2 queues BEHIND the blocked call...
    adapter.blockNext()
    feed(ctx, session, log, simpleTurn(1, 'u1', 'a1'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    feed(ctx, session, log, simpleTurn(2, 'u2-backlog', 'a2'))
    await flush()

    // ...the pin lands mid-flight: the old call aborts, the queued delta is
    // dropped, the cursor re-seeds.
    const setResult = await invokeAdvisor(handler, ' model set other other-model', session)
    expect(textOf(setResult)).toContain('Session model pinned: other/other-model')

    // The late old-route call settles — its note must NEVER deliver.
    adapter.release()
    await flush()
    expect(inject).not.toHaveBeenCalled()
    expect(inject).toHaveBeenCalledTimes(0)

    // Turn 3: served by the NEW runtime on the NEW route, and the delta is
    // only turn 3 (re-seed — no replay of turn 2's dropped backlog).
    feed(ctx, session, log, simpleTurn(3, 'u3', 'a3'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    expect(adapter.requests[1]).toMatchObject({ provider: 'other', model: 'other-model' })
    expect(deltaTextOf(adapter.requests[1]!)).toContain('u3')
    expect(deltaTextOf(adapter.requests[1]!)).not.toContain('u2-backlog')
    expect(deltaTextOf(adapter.requests[1]!)).not.toContain('u1')
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1))
  })
})

// ---------------------------------------------------------------------------
// 7. Cold resume / fork lifetime
// ---------------------------------------------------------------------------

describe('session model override — lifetime (spec §5.3 + KD-5)', () => {
  it('agent dispose clears the pin: a cold-resumed or forked session inherits global defaults', async () => {
    const { ctx, agents, handler } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [],
    )
    publishAgent(ctx, agents, 's1')
    const { session } = makeSession('s1')

    await invokeAdvisor(handler, ' model set other other-model', session)
    let model = await invokeAdvisor(handler, ' model', session)
    expect(textOf(model)).toContain('Source: session override')

    // Dispose (cold resume / navigation teardown) — the in-memory pin is gone.
    disposeAgent(ctx, agents, 's1')

    // A fork/new session id (or the cold-resumed same id) inherits defaults.
    publishAgent(ctx, agents, 's1-fork')
    const forkSession = makeSession('s1-fork')
    model = await invokeAdvisor(handler, ' model', forkSession.session)
    expect(textOf(model)).toContain('Source: global default')
    const reset = await invokeAdvisor(handler, ' model reset', forkSession.session)
    expect(textOf(reset)).toContain('already inherits')
  })
})

// ---------------------------------------------------------------------------
// 8. Multi-fiber single owner
// ---------------------------------------------------------------------------

describe('session model override — single elected owner (spec §5.3)', () => {
  it('a second plugin fiber stays inert: still one command registration, the owner keeps serving', async () => {
    const { ctx, handler, definitions, agents } = await composeOverrideHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [],
    )
    publishAgent(ctx, agents, 's1')
    const { session } = makeSession('s1')

    // Compose a second fiber (the host's observed multi-fiber composition):
    // the single-reviewer guard makes it return before any commands wiring.
    const secondEntry = new MemoryEntryConfig(fullConfig({ enabled: true, provider: 'stub', model: 'stub-model' }))
    await ctx.plugin(harnessAdvisorPlugin(), secondEntry.config)
    await flush()
    expect(definitions).toHaveLength(1) // no duplicate registration

    // The elected owner still serves the model surface.
    const result = await invokeAdvisor(handler, ' model set other other-model', session)
    expect(textOf(result)).toContain('Session model pinned: other/other-model')
  })
})
