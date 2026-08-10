/**
 * T8 — integration test: the composed plugin loop (spec §7 Integration).
 *
 * Composes the real dsh-advisor plugin into a real cordis `Context` with:
 * - a real `LlmService` plus a stub `LlmAdapter` registered via
 *   `ctx.llm.registerAdapter(['stub'], adapter)` (the T4 established pattern);
 * - fake `sessions` / `agents` services (`ctx.provide`) so the plugin's
 *   top-level `inject: ['sessions', 'agents', 'llm']` resolves and `apply`
 *   runs through the cordis registry;
 * - a fake `Agent` published via `agent/created` (KD-4 map) whose
 *   `inject`/`steer` are spies.
 *
 * What this proves is the WIRING — the observer → runtime → emission guard →
 * delivery chain bound in `src/index.ts` — not the units (each is covered by
 * its own T3–T7 suite):
 * 1. A full `user → primary → turn/end → delta → advisor call → guard → steer`
 *    cycle: synthetic `session/event` events (user / assistant / tool
 *    messages) produce a rendered delta, the stub returns a JSON-framed
 *    `{"note","severity"}` reply, the guard passes it, and delivery calls
 *    `agent.steer` with a message whose `source.kind === 'advisor'`.
 * 2. A nit routes to `agent.inject`, never `steer`.
 * 3. The explicit model gate (S4): `enabled: true` without `provider`/`model`
 *    starts zero model calls.
 * 4. `/advisor` commands register only when a `commands` registry is composed
 *    (conditional child activation — T7 ⚠️).
 * 5. A `compact/*` event and a `user/message` surface replace both reset the
 *    composed observer (full post-rewrite replay) AND the emission guard
 *    (KD-5 reset wiring follow-through — T5 ⚠️): the same note is delivered
 *    again across a compaction.
 *
 * Events are synthetic but shaped exactly like dsh emits (same builders as
 * the T3/T6 suites); `feed` mirrors the cordis `session/event` listener (each
 * appended event delivered once against the growing live log).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId, LlmAdapter, LlmService, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SurfaceOp } from '@deepseek-ai/dsh-session'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands'
import * as advisorPlugin from '../src/index'
import type { AdvisorConfig } from '../src/config'
import { ADVISOR_SOURCE_KIND } from '../src/kinds'

// ---------------------------------------------------------------------------
// Stub adapter (T4 pattern: real LlmService + ctx.llm.registerAdapter)
// ---------------------------------------------------------------------------

/** Chunk script for a successful text reply. */
const textReply = (text: string): readonly StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Chunk script for a terminal provider failure (KD-5 classification input). */
const errorReply = (failure: { message: string; code: string }): readonly StreamChunk[] => [
  { type: 'finish', reason: { kind: 'error', failure } },
]

/** A quota/rate-limit failure → `quota_exhausted` pause (KD-5). */
const quotaFailure = (): { message: string; code: string } => ({
  message: 'insufficient_quota: you exceeded your current quota, please check your billing',
  code: 'QUOTA',
})

/** A permanent failure → `halted` (KD-5): model-not-supported wording. */
const permanentFailure = (): { message: string; code: string } => ({
  message: "the model 'gpt-5' is not supported when using Codex with a ChatGPT account (invalid_request_error)",
  code: 'INVALID_REQUEST',
})

/**
 * Stub `LlmAdapter`: records every `GenerateOptions` it receives and replays a
 * scripted reply per call (indexed by call order). Registers as provider
 * `'stub'`; the default `LlmAdapter.providerInfo`/`resolveModel` metadata
 * suffices (id/name = provider).
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
// Composed harness
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

interface Harness {
  ctx: Context
  adapter: StubAdapter
}

/**
 * Compose the real plugin into a cordis context: real `LlmService` + stub
 * adapter for provider `'stub'`, fake `sessions`/`agents` services so the
 * plugin's top-level inject list resolves, then load the plugin through the
 * registry (`ctx.plugin`) — config schema validation + apply included.
 */
async function composeHarness(
  config: Partial<AdvisorConfig>,
  replies: ReadonlyArray<readonly StreamChunk[]>,
): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  const adapter = new StubAdapter(replies)
  ctx.llm.registerAdapter(['stub'], adapter)
  // The plugin declares inject ['sessions', 'agents', 'llm']; `apply` never
  // reads `ctx.sessions`, and reads `ctx.agents.get(...)` only as the KD-4
  // registry fallback (the primary path is the agent/created map).
  ctx.provide('sessions', {} as never)
  ctx.provide('agents', { get: () => undefined } as never)
  await ctx.plugin(advisorPlugin, fullConfig(config))
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
// Synthetic session event builders (mirror of the T3/T6 test fixtures)
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

const turnEnd = (turn: number, reason = 'completed'): EventSpec => ({
  type: 'turn/end',
  data: { turn, reason: { kind: reason } },
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

/** A stepped turn that also carries a tool call + tool result (S2 delta shape). */
function toolTurn(turn: number, userText: string, agentText: string): EventSpec[] {
  return [
    turnStart(turn),
    userMessage(userText),
    stepStart(turn, 1),
    assistantMessage(agentText, [{ name: 'run_tests', args: '{}' }]),
    toolResultMessage('3 passed'),
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

/** Invoke a real `/advisor` handler against a live session (synchronous). */
function invokeHandler(
  handler: CommandDefinition['handler'],
  rawInput: string,
  session: Session,
): CommandResult {
  const result = handler({
    commandId: CommandId('cmd-qc-fix'),
    agent: { id: session.id, session } as unknown as Agent,
    rawInput,
    signal: new AbortController().signal,
  })
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
// 1. Full cycle: user → turn/end → delta → advisor call → guard → steer
// ---------------------------------------------------------------------------

describe('integration — full advisor loop (spec §7)', () => {
  it('drives user → primary → turn/end → delta → advisor call → guard → steer with a stub adapter', async () => {
    const { ctx, adapter } = await composeHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [[...textReply('{"note":"extract the helper","severity":"concern"}')]],
    )
    const { agent, steer, inject } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')

    feed(ctx, session, log, toolTurn(1, 'implement the feature', 'Done.'))

    // The drain is async fire-and-forget; wait for the delivery to land.
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))
    expect(inject).not.toHaveBeenCalled()

    // The steered message carries the advisor source kind + self-describing content.
    const message = steer.mock.calls[0]![0] as UserMessage
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe(ADVISOR_SOURCE_KIND)
    expect(message.content).toEqual([{ type: 'text', text: '[advisor:concern] extract the helper' }])

    // The model call carried the expected options and the rendered delta.
    expect(adapter.requests).toHaveLength(1)
    const options = adapter.requests[0]!
    expect(options.provider).toBe('stub')
    expect(options.model).toBe('stub-model')
    expect(options.maxTokens).toBe(256)
    expect('purpose' in options).toBe(false) // KD-5: purpose left unset
    const delta = deltaTextOf(options)
    expect(delta).toContain('### Session update')
    expect(delta).toContain('**user**: implement the feature')
    // Tool calls render as role-labelled text plus "- tool call: name(args)" lines.
    expect(delta).toContain('- tool call: run_tests({})')
    expect(delta).toContain('**user**: [tool result] 3 passed')
    expect(delta).toContain('**agent**: Done.')
  })

  it('routes a nit to agent.inject, never steer', async () => {
    const { ctx, adapter } = await composeHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [[...textReply('{"note":"add a unit test","severity":"nit"}')]],
    )
    const { agent, steer, inject } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')

    feed(ctx, session, log, simpleTurn(1, 'do the thing', 'done'))

    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1))
    expect(steer).not.toHaveBeenCalled()
    const message = inject.mock.calls[0]![0] as UserMessage
    expect(message.source.kind).toBe('advisor')
    expect(message.content).toEqual([{ type: 'text', text: '[advisor:nit] add a unit test' }])
    expect(adapter.requests).toHaveLength(1)
  })

  it('starts zero model calls when enabled without provider/model (explicit gate, S4)', async () => {
    const { ctx, adapter } = await composeHarness({ enabled: true }, [])
    const { agent } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')

    feed(ctx, session, log, toolTurn(1, 'do the thing', 'done'))

    await flush()
    expect(adapter.requests).toEqual([]) // no runtime → no model call, ever
  })

  it('starts zero model calls when the config switch is off (enabled: false)', async () => {
    const { ctx, adapter } = await composeHarness({ enabled: false }, [])
    const { agent } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')

    feed(ctx, session, log, simpleTurn(1, 'do the thing', 'done'))

    await flush()
    expect(adapter.requests).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Conditional command activation (T7 ⚠️)
// ---------------------------------------------------------------------------

describe('integration — /advisor commands conditional activation (T7)', () => {
  it('runs a full cycle without a commands registry, then registers when one is composed', async () => {
    const { ctx, adapter } = await composeHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [[...textReply('{"note":"watch the loop bound","severity":"concern"}')]],
    )
    const { agent, steer } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')

    // No commands service anywhere: the plugin must still run the full loop —
    // the commands child is conditional and must NOT join the top-level inject.
    feed(ctx, session, log, simpleTurn(1, 'loop over the list', 'done'))
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))
    expect(adapter.requests).toHaveLength(1)

    // Composing a commands registry afterwards activates the inject child.
    const definitions: CommandDefinition[] = []
    ctx.provide('commands', {
      register: (definition: CommandDefinition): (() => void) => {
        definitions.push(definition)
        return () => {}
      },
    } as never)
    await vi.waitFor(() => expect(definitions).toHaveLength(1))
    expect(definitions[0]!.name).toBe('advisor')
    expect(typeof definitions[0]!.handler).toBe('function')
  })

  it('the registered /advisor on handler starts the live runtime (KD-5 seed-on-enable)', async () => {
    const { ctx, adapter } = await composeHarness(
      // Config switch off; provider/model present so the S4 gate passes once
      // the per-session override flips on.
      { enabled: false, provider: 'stub', model: 'stub-model' },
      [[...textReply('{"note":"after enabling","severity":"concern"}')]],
    )
    const { agent, steer } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')

    // Register the commands registry and capture the real handler (bound to
    // the real controller inside apply — this exercises the live wiring).
    const definitions: CommandDefinition[] = []
    ctx.provide('commands', {
      register: (definition: CommandDefinition): (() => void) => {
        definitions.push(definition)
        return () => {}
      },
    } as never)
    await vi.waitFor(() => expect(definitions).toHaveLength(1))

    // Config off → a completed turn produces no model call.
    feed(ctx, session, log, simpleTurn(1, 'history turn', 'old reply'))
    await flush()
    expect(adapter.requests).toEqual([])

    // /advisor on with the REAL handler: flips the override, seeds the cursor
    // to the current transcript length, and creates/resumes the runtime.
    const result = definitions[0]!.handler({
      commandId: CommandId('cmd-t8'),
      agent: { id: 's1', session: { id: 's1', events: log } } as unknown as Agent,
      rawInput: ' on',
      signal: new AbortController().signal,
    })
    if (result instanceof Promise) throw new Error('test: /advisor handler must be synchronous')
    expect(result.text).toContain('Advisor on')

    // The next completed turn is reviewed — incrementally, without replaying
    // the pre-enable history (KD-5 seed-on-enable).
    feed(ctx, session, log, simpleTurn(2, 'new work', 'new reply'))
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))

    expect(adapter.requests).toHaveLength(1)
    const delta = deltaTextOf(adapter.requests[0]!)
    expect(delta).toContain('**user**: new work')
    expect(delta).not.toContain('history turn')
    expect(steer.mock.calls[0]![0]).toMatchObject({
      role: 'user',
      source: { kind: ADVISOR_SOURCE_KIND },
    })
  })
})

// ---------------------------------------------------------------------------
// 3. KD-5 reset wiring in the composed harness (T5 ⚠️ guard.reset follow-through)
// ---------------------------------------------------------------------------

describe('integration — compact / surface-replace reset the composed observer + guard (KD-5)', () => {
  it('a compact/* rewrite triggers a full replay AND a fresh emission-guard history', async () => {
    const { ctx, adapter } = await composeHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [
        [...textReply('{"note":"extract the helper","severity":"concern"}')],
        [...textReply('{"note":"extract the helper","severity":"concern"}')],
      ],
    )
    const { agent, steer } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')

    // Turn 1 completes → delta 1 → note accepted → steered (fence arms).
    feed(ctx, session, log, simpleTurn(1, 'original prompt', 'Original reply.'))
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))

    // Compaction rewrites the transcript (compact/* + the summary replace).
    feed(ctx, session, log, [
      compactStart(),
      compactSummary(),
      userMessage('Summary of earlier work.', { kind: 'user' }, { op: 'replace', start: 1, end: 3 }, [1, 3]),
      compactEnd(),
    ])

    // Turn 2 completes: the renderer replays the full post-rewrite surface and
    // the emission guard — reset by the rewrite (KD-5) — accepts the SAME note
    // again (without the reset wiring it would be deduped away: T5 ⚠️).
    feed(ctx, session, log, simpleTurn(2, 'continue', 'Continuing.'))
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(2))

    expect(adapter.requests).toHaveLength(2)
    const replay = deltaTextOf(adapter.requests[1]!)
    expect(replay).toContain('Summary of earlier work.')
    expect(replay).toContain('**user**: continue')
    expect(replay).not.toContain('original prompt')
    expect(replay).not.toContain('Original reply.')
  })

  it('a user/message surface replace (no compact events) also triggers the replay', async () => {
    const { ctx, adapter } = await composeHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [
        [...textReply('{"note":"first nit","severity":"nit"}')],
        [...textReply('{"note":"second nit","severity":"nit"}')],
      ],
    )
    const { agent, inject } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')

    feed(ctx, session, log, simpleTurn(1, 'original prompt', 'Original reply.'))
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1))

    // A surface replace WITHOUT compact/* events (the authoritative KD-5
    // trigger b) rewrites the delivered prefix.
    feed(ctx, session, log, [
      userMessage('Replacement summary.', { kind: 'user' }, { op: 'replace', start: 1, end: 3 }, [1, 3]),
    ])

    feed(ctx, session, log, simpleTurn(2, 'continue', 'Continuing.'))
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(2))

    expect(adapter.requests).toHaveLength(2)
    const replay = deltaTextOf(adapter.requests[1]!)
    expect(replay).toContain('Replacement summary.')
    expect(replay).toContain('**user**: continue')
    expect(replay).not.toContain('original prompt')
    expect(replay).not.toContain('Original reply.')
  })
})

// ---------------------------------------------------------------------------
// 4. QC fix wave 1 — recovery + gate-reporting wiring in the composed harness
// ---------------------------------------------------------------------------

describe('integration — /advisor recovery + S4 gate reporting wiring (QC fix wave 1)', () => {
  it('config-enabled-but-gate-blocked: status shows the S4 reason and /advisor on says no model call can start (qc3 I-1/I-2)', async () => {
    const { ctx, adapter } = await composeHarness({ enabled: true }, [])
    const { agent } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')
    const handler = await registerCommands(ctx)

    // `/advisor status` must show the disabled-with-reason (spec §5.2) — the
    // gate reason previously vanished because the overrides were seeded with
    // the POST-gate switch.
    const status = invokeHandler(handler, ' status', session)
    expect(status.kind).toBe('success')
    expect(status.text).toContain('Reason:')
    expect(status.text).toContain('configure both to enable the advisor')

    // `/advisor on` reply must carry the gate caveat — not a bare "Advisor on".
    const on = invokeHandler(handler, ' on', session)
    expect(on.text).toContain('no model call can start')

    // A full turn still starts zero model calls (hard gate holds).
    feed(ctx, session, log, simpleTurn(1, 'do the thing', 'done'))
    await flush()
    expect(adapter.requests).toEqual([])
  })

  it('/advisor on resumes a quota-paused session advisor (KD-5 manual resume; qc1/qc2/qc3 W-1/I-4)', async () => {
    const { ctx, adapter } = await composeHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [
        [...errorReply(quotaFailure())], // turn 1 → quota_exhausted pause
        [...textReply('{"note":"back after resume","severity":"concern"}')], // the retained batch, after resume
      ],
    )
    const { agent, steer } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')
    const handler = await registerCommands(ctx)

    feed(ctx, session, log, simpleTurn(1, 'first', 'reply one'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    expect(invokeHandler(handler, ' status', session).text).toContain('quota_exhausted')

    // `/advisor on` must RESUME (not "already on") — the retained batch drains.
    const on = invokeHandler(handler, ' on', session)
    expect(on.text).not.toContain('already on')
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))
    expect(adapter.requests).toHaveLength(2)
    expect(steer.mock.calls[0]![0]).toMatchObject({
      role: 'user',
      source: { kind: ADVISOR_SOURCE_KIND },
    })
  })

  it('/advisor on rebuilds a halted session advisor after a permanent model error (qc1/qc2/qc3 W-1/I-4)', async () => {
    const { ctx, adapter } = await composeHarness(
      { enabled: true, provider: 'stub', model: 'stub-model' },
      [
        [...errorReply(permanentFailure())], // turn 1 → permanent → halted
        [...textReply('{"note":"fresh start","severity":"concern"}')], // the rebuilt runtime
      ],
    )
    const { agent, steer } = makeFakeAgent('s1')
    ctx.emit('agent/created', { agent })
    const { session, log } = makeSession('s1')
    const handler = await registerCommands(ctx)

    feed(ctx, session, log, simpleTurn(1, 'first', 'reply one'))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    expect(invokeHandler(handler, ' status', session).text).toContain('halted')

    // `/advisor on` must rebuild the runtime (not "already on") — deltas
    // dropped while halted are not replayed, but the next turn is reviewed.
    const on = invokeHandler(handler, ' on', session)
    expect(on.text).not.toContain('already on')
    feed(ctx, session, log, simpleTurn(2, 'second', 'reply two'))
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))

    expect(adapter.requests).toHaveLength(2)
    const delta = deltaTextOf(adapter.requests[1]!)
    expect(delta).toContain('**user**: second')
    expect(delta).not.toContain('first')
    expect(steer.mock.calls[0]![0]).toMatchObject({
      role: 'user',
      source: { kind: ADVISOR_SOURCE_KIND },
    })
  })
})
