/**
 * T1-settings (plan dsh-advisor-settings-n2) — LIVE re-apply through the
 * composed plugin (review Important-1: the `bridge.onChange` listener inside
 * `apply()`, src/index.ts, had zero test coverage).
 *
 * Unlike the settings unit suite (tests/settings.test.ts — drives
 * `installAdvisorSettings` directly) and the integration suite (composes
 * `apply` WITHOUT a settings service), these tests compose the REAL plugin
 * into a real cordis `Context` with `MemorySettings` mounted, so the full
 * wiring — settings service → `installSettingsSection` → bridge source thunk →
 * `onChange` → re-apply (setImmuneTurns / setMaxDeltaMessages /
 * setConfigEnabled / dispose+ensure per-session runtimes) — is exercised end
 * to end. `MemorySettings` notifies watchers synchronously inside
 * `update()`/`replace()`, so awaiting the update promise is the settle point
 * for the re-apply.
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
 * - hard gate: a settings edit that disables the advisor (and a re-enable with
 *   an empty provider/model pair) still blocks runtime creation — no model
 *   call can ever start through the live source (the resolver stays the SSOT).
 *
 * Events are synthetic but shaped exactly like dsh emits (same builders as the
 * T8 integration suite); `feed` mirrors the cordis `session/event` listener.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { MemorySettings } from '@deepseek-ai/dsh-settings'
import { LlmAdapter, LlmService, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SurfaceOp } from '@deepseek-ai/dsh-session'
import * as advisorPlugin from '../src/index'
import type { AdvisorConfig } from '../src/config'
import { ADVISOR_SETTINGS_NAMESPACE } from '../src/settings'
import { TRUNCATION_MARKER } from '../src/transcript'
import { DEFAULT_ADVISOR_SYSTEM_PROMPT } from '../src/prompts'

// ---------------------------------------------------------------------------
// Stub adapter (T4/T8 pattern: real LlmService + ctx.llm.registerAdapter)
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
 * LlmService stub dispatches by provider route, and the live re-apply test
 * must observe a call actually routed to the new provider.
 */
class StubAdapter extends LlmAdapter {
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
 * Compose the real plugin into a cordis context with the settings service
 * mounted: `MemorySettings` first (the `installSettingsSection` consumer child
 * then activates once the advisor plugin loads), real `LlmService` + the stub
 * adapter on both provider routes, fake `sessions`/`agents` services so the
 * plugin's top-level inject list resolves, then load the plugin through the
 * registry (`ctx.plugin`) — config schema validation + apply included. Returns
 * once the `advisor` namespace is registered (the write path is only valid
 * after that).
 */
async function composeLiveHarness(
  config: Partial<AdvisorConfig>,
  replies: ReadonlyArray<readonly StreamChunk[]>,
): Promise<{ ctx: Context; adapter: StubAdapter }> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(LlmService)
  const adapter = new StubAdapter(replies)
  ctx.llm.registerAdapter(['stub', 'other'], adapter)
  ctx.provide('sessions', {} as never)
  ctx.provide('agents', { get: () => undefined } as never)
  await ctx.plugin(advisorPlugin, fullConfig(config))
  await vi.waitFor(() => {
    expect(ctx.settings.describe().some((d) => d.ns === ADVISOR_SETTINGS_NAMESPACE)).toBe(true)
  })
  return { ctx, adapter }
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
  return { session: { id, events: log } as unknown as Session, log }
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
  surfaceOp?: SurfaceOp
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

// ---------------------------------------------------------------------------
// 1. Live re-apply: immuneTurns + provider/model/systemPrompt + runtime rebuild
// ---------------------------------------------------------------------------

describe('settings live re-apply — latched config + runtime rebuild (Important-1)', () => {
  it('re-applies immuneTurns and rebuilds the session runtime with the edited provider/model/systemPrompt', async () => {
    const { ctx, adapter } = await composeLiveHarness(
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
    ctx.emit('agent/created', { agent })
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

    // A committed settings edit changing the composed values. MemorySettings
    // notifies its watchers synchronously inside update(), so once this
    // promise resolves the bridge.onChange re-apply has fully run:
    // setImmuneTurns(7) / setMaxDeltaMessages(20) / setConfigEnabled(true) /
    // dispose + ensure for every live session runtime.
    await ctx.settings.update(ADVISOR_SETTINGS_NAMESPACE, {
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
    const { ctx, adapter } = await composeLiveHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [
        [...textReply('{"note":"first nit","severity":"nit"}')],
        [...textReply('{"note":"bulk nit","severity":"nit"}')],
      ],
    )
    const { agent } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')

    // The session's renderer exists BEFORE the edit (bound = the entry 60), so
    // the re-apply must update a live renderer, not just the observer default.
    feed(ctx, session, log, simpleTurn(1, 'small turn', 'small reply'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    await ctx.settings.update(ADVISOR_SETTINGS_NAMESPACE, { maxDeltaMessages: 20 })

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
    const { ctx, adapter } = await composeLiveHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [[...textReply('{"note":"first nit","severity":"nit"}')]],
    )
    const { agent } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')

    // The runtime exists before the edit.
    feed(ctx, session, log, simpleTurn(1, 'first request', 'first reply'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    // Settings-page switch off: the live gate (effectiveEnabled) drops every
    // delta — no model call, and the onChange rebuild loop disposes the runtime.
    await ctx.settings.update(ADVISOR_SETTINGS_NAMESPACE, { enabled: false })
    feed(ctx, session, log, simpleTurn(2, 'second request', 'second reply'))
    await flush()
    expect(adapter.requests).toHaveLength(1)

    // Even re-enabled, an empty provider/model pair trips the S4 gate through
    // the live source (resolveAdvisorConfig stays the SSOT) — an edit can
    // never start a gated model call.
    await ctx.settings.update(ADVISOR_SETTINGS_NAMESPACE, { enabled: true, provider: '', model: '' })
    feed(ctx, session, log, simpleTurn(3, 'third request', 'third reply'))
    await flush()
    expect(adapter.requests).toHaveLength(1)
  })
})
