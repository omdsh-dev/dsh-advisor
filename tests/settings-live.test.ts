/**
 * T1-settings (plan dsh-advisor-settings-n2) — LIVE re-apply through the
 * composed plugin (review Important-1: the `bridge.onChange` listener inside
 * `apply()`, src/index.ts, had zero test coverage).
 *
 * Unlike the settings unit suite (tests/settings.test.ts — drives
 * `installAdvisorSettings` directly) and the integration suite (composes
 * `apply` WITHOUT the volatile harness), these tests compose the REAL plugin
 * into a real cordis `Context` with the loader double mounted
 * (`support/memory-settings.ts`): the plugin receives its entry config as
 * volatile references, and every edit is driven the way the Loader drives it
 * — write the references, then emit `loader/volatile-update` — so the full
 * wiring — volatile commit → bridge source → `onChange` → re-apply
 * (setImmuneTurns / setMaxDeltaMessages / setConfigEnabled / dispose+ensure
 * per-session runtimes) — is exercised end to end. `commit` writes the values
 * BEFORE emitting, so the synchronous re-apply has settled when the call
 * returns — that is the settle point for every write below.
 *
 * The delivery / observer / runtime instances live in `apply()`'s closure, so
 * every probe here is BEHAVIORAL (observable through the composed loop), not a
 * getter:
 * - immuneTurns = 7: after a real steer arms the fence, six more completed
 *   stepped turns are all downgraded to inject and only the seventh steers
 *   again (the default of 3 would already re-steer on the third) — the
 *   delivery cooldown demonstrably uses the NEW length.
 * - provider / model / systemPrompt: the rebuilt runtime's `GenerateOptions`
 *   (recorded by the stub adapter) carry the NEW values.
 * - runtime rebuilt: the pre-edit call went out as `stub`/`stub-model` with
 *   the entry system prompt; the post-edit call goes out as
 *   `other`/`other-model` with the edited prompt — a stale runtime would keep
 *   the old route.
 * - maxDeltaMessages = 20: one turn appending 22 messages to a live renderer
 *   is truncated to the last 20 with the marker (the pre-edit bound of 60
 *   would render all 22).
 * - hard gate: an entry edit that disables the advisor (and a re-enable with
 *   an empty provider/model pair) still blocks runtime creation — no model
 *   call can ever start through the live source (the resolver stays the SSOT).
 *
 * Events are synthetic but shaped exactly like dsh emits (same builders as the
 * T8 integration suite); `feed` mirrors the cordis `session/event` listener.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryEntryConfig, harnessAdvisorPlugin } from './support/memory-settings'
import { LlmAdapter, LlmRuntime, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SurfaceOp } from '@deepseek-ai/dsh-session'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AdvisorConfig } from '../src/config'
import { TRUNCATION_MARKER } from '../src/transcript'
import { DEFAULT_ADVISOR_SYSTEM_PROMPT } from '../src/prompts'

// n4 QC F-6: the single-reviewer guard is process-global; each test case
// composes a fresh harness, so the flag must reset between cases (production
// keeps the first-claim-wins behavior).
beforeEach(() => {
  delete (globalThis as Record<string, unknown>)['__dshAdvisorReviewer__']
})


// ---------------------------------------------------------------------------
// Stub adapter (T4/T8 pattern: real LlmRuntime + ctx.llm.registerAdapter)
// ---------------------------------------------------------------------------

/** Chunk script for a successful text reply. */
const textReply = (text: string): readonly StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

/**
 * Stub `LlmAdapter`: records every `GenerateOptions` it receives and replays a
 * scripted reply per call (indexed by call order). Registered for BOTH the
 * entry provider (`'stub'`) and the post-edit provider (`'other'`) — the
 * LlmRuntime stub dispatches by provider route, and the live re-apply test
 * must observe a call actually routed to the new provider.
 */
class StubAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string, _signal?: undefined): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('off') },
    })
  }

  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ReadonlyArray<readonly StreamChunk[]>) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const reply = this.script[this.requests.length - 1]
    if (reply === undefined) {
      throw new Error(`StubAdapter: script exhausted after ${this.requests.length} calls`)
    }
    yield * reply
  }
}

/**
 * Stub adapter whose next stream call hangs until released — the pending-
 * backlog probe for the conditional-rebuild test (qc3 W-1 / qc1 W-2): with a
 * call in flight, a following delta queues behind it, and a runtime rebuild
 * at that point would abort the in-flight call AND drop the queued delta.
 */
class GatedAdapter extends LlmAdapter {
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

  constructor(private readonly reply: readonly StreamChunk[]) {
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
    yield * this.reply
  }
}

/** Minimal adapter probe: every GenerateOptions the adapter received. */
interface AdapterProbe {
  readonly requests: GenerateOptions[]
}

// ---------------------------------------------------------------------------
// Composed harness (settings service + the real plugin)
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

/**
 * Compose the real plugin into a cordis context with the loader double
 * mounted: the harness entry (volatile references) is handed to the plugin
 * through the `Config`-less module wrapper, real `LlmRuntime` + the stub
 * adapter on both provider routes, fake `sessions`/`agents` services so the
 * plugin's top-level inject list resolves, then load the plugin through the
 * registry (`ctx.plugin`). Returns once apply has run — every write below is
 * an `entry.commit`, which settles synchronously (values written, then the
 * `loader/volatile-update` emission drives the synchronous re-apply).
 * @param adapterOverride - optional custom adapter (e.g. the gated backlog
 *   probe); defaults to a fresh {@link StubAdapter} over `replies`.
 */
async function composeLiveHarness(
  config: Partial<AdvisorConfig>,
  replies: ReadonlyArray<readonly StreamChunk[]>,
  adapterOverride?: LlmAdapter & AdapterProbe,
): Promise<{ ctx: Context; adapter: LlmAdapter & AdapterProbe; entry: MemoryEntryConfig }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = adapterOverride ?? new StubAdapter(replies)
  ctx.llm.registerAdapter(['stub', 'other'], adapter)
  ctx.provide('sessions', {} as never)
  ctx.provide('agents', { get: () => undefined } as never)
  const entry = new MemoryEntryConfig(fullConfig(config))
  await ctx.plugin(harnessAdvisorPlugin(), entry.config)
  return { ctx, adapter, entry }
}

/** Fake Agent with inject/steer spies; published via `agent/created`. */
function makeFakeAgent(id = 's1'): {
  agent: Agent
  inject: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
} {
  const inject = vi.fn()
  const steer = vi.fn()
  return { agent: { id, inject, steer } as unknown as Agent, inject, steer }
}

/** A session whose `events` is a live log the feed loop grows in place. */
function makeSession(id = 's1'): { session: Session; log: SessionEvent[] } {
  const log: SessionEvent[] = []
  return { session: { id, snapshotEvents: () => log } as unknown as Session, log }
}

/** Text of the single user delta message the runtime sends the model. */
function deltaTextOf(options: GenerateOptions): string {
  const block = options.messages[0]!.content[0]!
  return block.type === 'text' ? block.text : ''
}

// ---------------------------------------------------------------------------
// Synthetic session event builders (mirror of the T3/T6/T8 fixtures)
// ---------------------------------------------------------------------------

/** Synthetic replace op — dsh brands seqs (`SessionSeq`), compile-time only here. */
type ReplaceSurfaceOp = { op: 'replace'; startSeq: number; endSeq: number }

interface EventSpec {
  type: string
  data: unknown
  surfaceOp?: SurfaceOp | ReplaceSurfaceOp
  sourceEventSeqs?: number[]
}

/** Number events contiguously from `offset` and cast to the SessionEvent union. */
function buildEvents(specs: readonly EventSpec[], offset = 0): SessionEvent[] {
  return specs.map((spec, index) => {
    const event: Record<string, unknown> = {
      type: spec.type,
      seq: offset + index,
      time: 1_000 + offset + index,
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
  source: { kind: string } = { kind: 'user' },
  surfaceOp: SurfaceOp | ReplaceSurfaceOp = 'append',
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
  const events = buildEvents(specs, log.length)
  for (const event of events) {
    log.push(event)
    ctx.emit('session/event', session, event)
  }
}

/** Small deterministic wait so "zero calls" assertions see any would-be call. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

/** Invoke one captured `/advisor` handler with a dsh-shaped invocation. */
function invokeAdvisor(handler: CommandDefinition['handler'], rawInput: string, session: Session): CommandResult {
  const result = handler({
    commandId: 'c' as never,
    agent: { id: session.id, session } as unknown as Agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  } as CommandInvocation)
  if (result instanceof Promise) throw new Error('test: /advisor handler must be synchronous')
  return result
}

/** Compose a commands registry and return the captured real `/advisor` handler. */
async function registerCommands(ctx: Context): Promise<CommandDefinition['handler']> {
  const definitions: CommandDefinition[] = []
  ctx.provide('commands', {
    register: (definition: CommandDefinition): (() => void) => {
      definitions.push(definition)
      return () => {}
    },
  } as never)
  await vi.waitFor(() => expect(definitions).toHaveLength(1))
  return definitions[0]!.handler
}

// ---------------------------------------------------------------------------
// 1. Live re-apply: immuneTurns + provider/model/systemPrompt + runtime rebuild
// ---------------------------------------------------------------------------

describe('settings live re-apply — latched config + runtime rebuild (Important-1)', () => {
  it('re-applies immuneTurns and rebuilds the session runtime with the edited provider/model/systemPrompt', async () => {
    const { ctx, adapter, entry } = await composeLiveHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [
        [...textReply('{"note":"pre write nit","severity":"nit"}')],
        // Eight distinct concern replies: one steer (arms the fence) + six
        // downgraded-to-inject turns + one final steer (the fence exhausted).
        ...Array.from({ length: 8 }, (_, i) => [
          ...textReply(`{"note":"interrupt ${i}","severity":"concern"}`),
        ]),
      ],
    )
    const { agent, steer, inject } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent, source: 'startup' })
    const { session, log } = makeSession('s1')

    // Pre-edit: the session runtime exists and calls go out with the ENTRY
    // route (stub / stub-model / the entry system prompt).
    feed(ctx, session, log, simpleTurn(1, 'first request', 'first reply'))
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1))
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.provider).toBe('stub')
    expect(adapter.requests[0]!.model).toBe('stub-model')
    // The entry systemPrompt is '' → the runtime uses the KD-2 default prompt.
    expect(adapter.requests[0]!.system).toBe(DEFAULT_ADVISOR_SYSTEM_PROMPT)

    // Committed volatile edit: values written, then `loader/volatile-update`
    // — the synchronous onChange re-apply (setImmuneTurns(7) /
    // setMaxDeltaMessages(20) / setConfigEnabled(true) / dispose + ensure for
    // every live session runtime) has fully run when this call returns.
    entry.commit(ctx, {
      provider: 'other',
      model: 'other-model',
      immuneTurns: 7,
      maxDeltaMessages: 20,
      systemPrompt: 'custom',
    })

    // The next turn is drained by a REBUILT runtime with the NEW route — a
    // stale runtime would still call with 'stub'/'stub-model'/''. The concern
    // steers, arming the fence with the NEW length (7).
    feed(ctx, session, log, simpleTurn(2, 'second request', 'second reply'))
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]!.provider).toBe('other')
    expect(adapter.requests[1]!.model).toBe('other-model')
    expect(adapter.requests[1]!.system).toBe('custom')

    // immuneTurns = 7 in effect: after the steer, SIX more completed stepped
    // turns all downgrade to inject and the fence is still armed. (With the
    // default of 3 the third such turn would already steer again — this is
    // the observable that pins the length to the edited value.)
    for (let index = 0; index < 6; index++) {
      const turn = 3 + index
      feed(ctx, session, log, simpleTurn(turn, `turn ${turn} request`, `turn ${turn} reply`))
      await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(2 + index))
      expect(steer).toHaveBeenCalledTimes(1)
    }
    // 1 pre-edit nit + 6 downgraded concerns = 7 injects; still exactly one steer.
    expect(inject).toHaveBeenCalledTimes(7)
    expect(steer).toHaveBeenCalledTimes(1)

    // The seventh completed turn exhausts the 7-turn cooldown → steering resumes.
    feed(ctx, session, log, simpleTurn(9, 'ninth request', 'ninth reply'))
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(2))
    expect(inject).toHaveBeenCalledTimes(7)
    expect(adapter.requests).toHaveLength(9)
  })
})

// ---------------------------------------------------------------------------
// 2. Live re-apply: observer maxDeltaMessages bound on a live renderer
// ---------------------------------------------------------------------------

describe('settings live re-apply — observer maxDeltaMessages (Important-1)', () => {
  it('applies the edited delta window to an already-live per-session renderer', async () => {
    const { ctx, adapter, entry } = await composeLiveHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [
        [...textReply('{"note":"first nit","severity":"nit"}')],
        [...textReply('{"note":"bulk nit","severity":"nit"}')],
      ],
    )
    const { agent } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent, source: 'startup' })
    const { session, log } = makeSession('s1')

    // The session's renderer exists BEFORE the edit (bound = the entry 60), so
    // the re-apply must update a live renderer, not just the observer default.
    feed(ctx, session, log, simpleTurn(1, 'small turn', 'small reply'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    entry.commit(ctx, { maxDeltaMessages: 20 })

    // One turn appending 22 messages to the live renderer: with the NEW bound
    // (20) the delta keeps exactly the last 20 and prepends the marker; the
    // pre-edit bound (60) would render all 22 with no marker.
    feed(ctx, session, log, [
      turnStart(2),
      ...Array.from({ length: 21 }, (_, i) => userMessage(`bulk-${i}`)),
      stepStart(2, 1),
      assistantMessage('bulk done'),
      stepEnd(2, 1),
      turnEnd(2),
    ])
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))

    const delta = deltaTextOf(adapter.requests[1]!)
    expect(delta).toContain(TRUNCATION_MARKER)
    // The marker precedes the retained messages.
    expect(delta.indexOf(TRUNCATION_MARKER)).toBeLessThan(delta.indexOf('**user**: bulk-20'))
    // The last 20 of the 22 appended messages survive; the first two bulk
    // messages fall outside the window.
    expect(delta).toContain('**user**: bulk-20')
    expect(delta).toContain('**agent**: bulk done')
    // Line-anchored: 'bulk-10' contains 'bulk-1' as a substring, so a plain
    // toContain would false-positive on the retained bulk-10..bulk-20 lines.
    expect(delta).not.toMatch(/\*\*user\*\*: bulk-0(?:\n|$)/)
    expect(delta).not.toMatch(/\*\*user\*\*: bulk-1(?:\n|$)/)
    // 19 retained users + 1 assistant = 20 messages — the edited window.
    expect(delta.match(/\*\*user\*\*: bulk-/g)).toHaveLength(19)
  })
})

// ---------------------------------------------------------------------------
// 3. Hard gate through the live path
// ---------------------------------------------------------------------------

describe('settings live re-apply — hard gate through the live source (Important-1)', () => {
  it('a settings edit that disables the advisor still blocks runtime creation; re-enabling without a provider/model pair is gated too', async () => {
    const { ctx, adapter, entry } = await composeLiveHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [[...textReply('{"note":"first nit","severity":"nit"}')]],
    )
    const { agent } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent, source: 'startup' })
    const { session, log } = makeSession('s1')

    // The runtime exists before the edit.
    feed(ctx, session, log, simpleTurn(1, 'first request', 'first reply'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    // Settings-page switch off: the live gate (effectiveEnabled) drops every
    // delta — no model call, and the onChange rebuild loop disposes the runtime.
    entry.commit(ctx, { enabled: false })
    feed(ctx, session, log, simpleTurn(2, 'second request', 'second reply'))
    await flush()
    expect(adapter.requests).toHaveLength(1)

    // Even re-enabled, an empty provider/model pair trips the S4 gate through
    // the live source (resolveAdvisorConfig stays the SSOT) — an edit can
    // never start a gated model call.
    entry.commit(ctx, { enabled: true, provider: '', model: '' })
    feed(ctx, session, log, simpleTurn(3, 'third request', 'third reply'))
    await flush()
    expect(adapter.requests).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Conditional runtime rebuild (qc3 W-1 / qc1 W-2): an immuneTurns-only edit
//    must NOT rebuild live runtimes; a systemPrompt edit MUST.
// ---------------------------------------------------------------------------

describe('settings live re-apply — conditional runtime rebuild (qc3 W-1 / qc1 W-2)', () => {
  it('an immuneTurns-only edit does not rebuild the runtime: the pending backlog and the emission guard survive', async () => {
    // One note text for both calls: the emission guard dedupes the repeat —
    // a rebuilt runtime would carry a fresh guard and deliver it again.
    const note = '{"note":"same note","severity":"nit"}'
    const gated = new GatedAdapter([...textReply(note)])
    const { ctx, adapter, entry } = await composeLiveHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [],
      gated,
    )
    const { agent, inject, steer } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent, source: 'startup' })
    const { session, log } = makeSession('s1')

    // Turn 1: the first advisor call hangs mid-flight (gated).
    gated.blockNext()
    feed(ctx, session, log, simpleTurn(1, 'first request', 'first reply'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    // Turn 2's delta queues behind the in-flight call (a pending backlog).
    feed(ctx, session, log, simpleTurn(2, 'second request', 'second reply'))
    await flush()

    // An immuneTurns-only settings edit: the latch updates in place and the
    // runtime MUST NOT be torn down (no abort of the in-flight call, no
    // backlog drop, no emission-guard reset).
    entry.commit(ctx, { immuneTurns: 7 })

    // Release the in-flight call: BOTH deltas drain through the SAME runtime
    // — a rebuild would have dropped the queued delta (requests stays 1).
    gated.release()
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    // The duplicate note is suppressed by the SURVIVING guard — a rebuilt
    // runtime would accept it again (inject would be 2).
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1))
    expect(steer).not.toHaveBeenCalled()
  })

  it('a systemPrompt-only edit rebuilds the runtime: the next call carries the new prompt', async () => {
    const { ctx, adapter, entry } = await composeLiveHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [
        [...textReply('{"note":"before edit","severity":"nit"}')],
        [...textReply('{"note":"after edit","severity":"nit"}')],
      ],
    )
    const { agent, inject } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent, source: 'startup' })
    const { session, log } = makeSession('s1')

    feed(ctx, session, log, simpleTurn(1, 'first request', 'first reply'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    expect(adapter.requests[0]!.system).toBe(DEFAULT_ADVISOR_SYSTEM_PROMPT)

    // A systemPrompt edit is runtime-affecting: the rebuild must happen, so
    // the next call carries the NEW prompt (a stale runtime would keep '').
    entry.commit(ctx, { systemPrompt: 'custom' })

    feed(ctx, session, log, simpleTurn(2, 'second request', 'second reply'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    expect(adapter.requests[1]!.system).toBe('custom')
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(2))
  })
})

// ---------------------------------------------------------------------------
// 5. Unknown-key user layer containment (qc2 W-1): live reads never throw.
// ---------------------------------------------------------------------------

describe('settings live re-apply — unknown-key user layer containment (qc2 W-1)', () => {
  it('an unknown key never wedges live reads: no throw, no model call, /advisor status shows disabled-with-reason', async () => {
    const { ctx, adapter, entry } = await composeLiveHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [[...textReply('{"note":"never delivered","severity":"nit"}')]],
    )
    const handler = await registerCommands(ctx)
    const { agent } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent, source: 'startup' })
    const { session, log } = makeSession('s1')

    // The settings user layer gains an unknown key — resolveAdvisorConfig
    // throws on every read, but the safe live path must contain it.
    entry.commit(ctx, { bogus: 1 })

    // A stepped turn: the session/event handler must not throw, and no model
    // call can start (gate semantics — disabled-with-reason).
    feed(ctx, session, log, simpleTurn(1, 'request', 'reply'))
    await flush()
    expect(adapter.requests).toHaveLength(0)

    // /advisor status reads the effective config through the safe wrapper:
    // disabled-with-reason carrying the resolver message (not a wedge).
    const result = invokeAdvisor(handler, 'status', session)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('Advisor: disabled')
      expect(result.text).toContain('unknown config key "bogus"')
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Commit-time switch re-apply: a committed volatile edit re-derives the
//    config-level fallback switch, so sessions created AFTER the commit pick
//    it up (the old attach-ordering case rode the inject child's microtask
//    activation — gone with the 0.1.7-rc.1 registration-free model).
// ---------------------------------------------------------------------------

describe('settings live re-apply — config switch follows the committed entry', () => {
  it('boots with the entry switch off: after a committed enable, the FIRST turn already runs a session runtime without any further edit', async () => {
    const { ctx, adapter, entry } = await composeLiveHarness(
      { enabled: false }, // entry switch off at load
      [[...textReply('{"note":"boot nit","severity":"nit"}')]],
    )
    const { agent, inject } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent, source: 'startup' })
    const { session, log } = makeSession('s1')

    // One committed enable + provider/model pair: the onChange re-apply
    // flipped overrides.setConfigEnabled(true), so the first turn runs a
    // session runtime and calls the model — no restart, no second commit.
    entry.commit(ctx, { enabled: true, provider: 'stub', model: 'stub-model' })
    feed(ctx, session, log, simpleTurn(1, 'first request', 'first reply'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    expect(adapter.requests[0]!.provider).toBe('stub')
    expect(adapter.requests[0]!.model).toBe('stub-model')
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1))
  })
})

// ---------------------------------------------------------------------------
// 7. /advisor config — session-less composed readback (plan
//    dsh-advisor-tui-client-n8 T2). The REAL wiring reads `safeResolved()`
//    (the live entry config with the hard gate applied), never the
//    per-session effective config — a `/advisor off` session override must
//    not misreport the persisted config (web-card /api/advisor/get parity).
// ---------------------------------------------------------------------------

describe('/advisor config — session-less composed readback (T2)', () => {
  it('reports the composed entry config and ignores the per-session override', async () => {
    const { ctx, entry } = await composeLiveHarness(
      { enabled: true, provider: 'stub', model: 'stub-model', systemPrompt: 'custom prompt\nsecond line' },
      [],
    )
    const handler = await registerCommands(ctx)
    const { agent } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent, source: 'startup' })
    const { session } = makeSession('s1')

    // A committed volatile edit changes the live entry config — the
    // observation channel (AC-3) must show the composed value.
    entry.commit(ctx, { model: 'other-model' })
    const composed = invokeAdvisor(handler, 'config', session)
    expect(composed.kind).toBe('success')
    if (composed.kind === 'success') {
      expect(composed.text).toContain('Advisor config: enabled')
      expect(composed.text).toContain('Model: stub/other-model')
      // The summary is the FIRST line of the prompt, not a full dump.
      expect(composed.text).toContain('systemPrompt: "custom prompt"')
      expect(composed.text).not.toContain('second line')
    }

    // Flip the per-session override OFF: the status surface follows the
    // override (runtime state owned by status)...
    const off = invokeAdvisor(handler, 'off', session)
    expect(off.kind).toBe('success')
    const status = invokeAdvisor(handler, 'status', session)
    expect(status.kind).toBe('success')
    if (status.kind === 'success') expect(status.text).toContain('Advisor: disabled')

    // ...but the config readback stays session-less: still the composed
    // enabled config with the composed provider/model — never the session
    // state (config-vs-status separation).
    const readback = invokeAdvisor(handler, 'config', session)
    expect(readback.kind).toBe('success')
    if (readback.kind === 'success') {
      expect(readback.text).toContain('Advisor config: enabled')
      expect(readback.text).toContain('Model: stub/other-model')
      expect(readback.text).toContain('systemPrompt: "custom prompt"')
    }
  })

  it('summarizes a long multi-line systemPrompt to the first line, ≤ 80 chars, never a full dump', async () => {
    const longFirstLine = `line-one-${'x'.repeat(100)}` // 109 chars
    const { ctx, entry } = await composeLiveHarness(
      {
        enabled: true,
        provider: 'stub',
        model: 'stub-model',
        systemPrompt: `${longFirstLine}\nsecond line must never appear`,
      },
      [],
    )
    const handler = await registerCommands(ctx)
    const { session } = makeSession('s1')
    const result = invokeAdvisor(handler, 'config', session)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain(`systemPrompt: "${longFirstLine.slice(0, 79)}…"`)
      expect(result.text).not.toContain('second line must never appear')
    }
  })

  it('an unknown-key user layer: /advisor config stays disabled-with-reason and seeds the scalars from the raw source (qc2 W-1 on the config path, F-1/F-4)', async () => {
    // The exact qc2 W-1 scenario already pinned for /advisor status — now on
    // the config readback: the user layer gains an unknown key the resolver
    // rejects, but the raw source is still readable, so the fallback must
    // seed immuneTurns/maxDeltaMessages/systemPrompt from it (web-card
    // readConfig S1 parity) instead of the hardcoded 3/60/'' defaults.
    const { ctx, entry } = await composeLiveHarness(
      { enabled: true, provider: 'stub', model: 'stub-model', immuneTurns: 5, maxDeltaMessages: 20, systemPrompt: 'keep me' },
      [],
    )
    const handler = await registerCommands(ctx)
    const { session } = makeSession('s1')

    entry.commit(ctx, { bogus: 1 })

    const result = invokeAdvisor(handler, 'config', session)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('Advisor config: disabled')
      expect(result.text).toContain('unknown config key "bogus"')
      // Seeded from the readable raw source — NOT the hardcoded defaults.
      expect(result.text).toContain('immuneTurns: 5')
      expect(result.text).toContain('maxDeltaMessages: 20')
      expect(result.text).toContain('systemPrompt: "keep me"')
    }
  })
})
