/**
 * T1 (plan dsh-advisor-settings-gateway-n5) — host-side `advisor` config
 * gateway (`/api/advisor/get` + `/api/advisor/set` via typertGateway SRC
 * claims).
 *
 * Contract under test (`AdvisorConfigGateway`, src/gateway.ts):
 * ① No settings service (plain cordis ctx) — `get` returns the entry
 *    composed value (schema defaults → entry base), and `set` fails cleanly
 *    (the settings service is unavailable — KD-G5 error path).
 * ② With a settings service mounted — `set` writes the USER layer (visible in
 *    `describe().user`), the composed value changes (base defaults the patch
 *    did not touch are kept), the write is LIVE (the bridge source reflects
 *    it), and `set` returns the new composed value.
 * ③ `set` with an unknown key is rejected by the `Config` schema
 *    (unknown-key rejection unchanged) and nothing is persisted.
 * ④ Hard gate regression: settings-enabled without provider/model still
 *    resolves to disabled-with-reason (no model call — SSOT unchanged).
 * ⑤ Endpoint claims: the typertGateway SRC discovery (the same
 *    `ctx.reflect.props` + `remoteMethods` walk `claimsEndpoint` uses) claims
 *    `/api/advisor/get` + `/api/advisor/set`; the payload contract is exactly
 *    one plain-object `args` field; dispatch through the recorded `/api`
 *    interceptor and direct `ctx.typertGateway.invoke` both work.
 * ⑥ Multi-fiber dedupe: a second gateway on the same context fails loud
 *    (cordis Service duplicate registration) — the dedupe catch in
 *    `src/index.ts` relies on that exact error.
 * ⑦ Composed end-to-end: the real plugin `apply` wires the gateway; the
 *    typertGateway dispatches get/set against the live composed config.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from 'cordis'
import { MemorySettings } from './support/memory-settings'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { ADVISOR_SETTINGS_NAMESPACE, installAdvisorSettings } from '../src/settings'
import { AdvisorConfigGateway } from '../src/gateway'
import { resolveAdvisorConfig } from '../src/config'
import type { AdvisorConfig, ResolvedAdvisorConfig } from '../src/config'
import * as advisorPlugin from '../src/index'

// n4 QC F-6: the single-reviewer guard is process-global; the composed test
// mounts the real plugin, so the flag must reset between cases.
beforeEach(() => {
  delete (globalThis as Record<string, unknown>)['__dshAdvisorReviewer__']
})

/** Full entry (plugin-row) config shape, merged over the schema defaults. */
function entryConfig(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    enabled: false,
    systemPrompt: '',
    immuneTurns: 3,
    maxDeltaMessages: 60,
    ...overrides,
  }
}

/** Read the gateway's internal settings capture (activated inject child). */
function settingsOf(gateway: AdvisorConfigGateway): unknown {
  return (gateway as unknown as { settings?: unknown }).settings
}

/** Wait until the conditional `ctx.inject(['settings'], ...)` child registered the namespace. */
async function waitRegistered(ctx: Context): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.settings.describe().some((d) => d.ns === ADVISOR_SETTINGS_NAMESPACE)).toBe(true)
  })
}

// ---------------------------------------------------------------------------
// ① no settings service → entry fallback (get works, set fails cleanly)
// ---------------------------------------------------------------------------

describe('no settings service (entry fallback)', () => {
  it('get returns the entry composed value; the gateway is a registered service', () => {
    const ctx = new Context()
    const entry = entryConfig({ enabled: true, provider: 'deepseek', model: 'deepseek-chat', immuneTurns: 5 })
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entry))

    expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' })
    expect(gateway.get()).toEqual({
      config: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        systemPrompt: '',
        immuneTurns: 5,
        maxDeltaMessages: 60,
      },
    })
  })

  it('set fails cleanly when no settings service is composed (KD-G5 error path)', async () => {
    const ctx = new Context()
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entryConfig()))
    await expect(gateway.set({ enabled: true })).rejects.toThrow(/settings service is unavailable/)
  })

  it('a second gateway on the same context fails loud (multi-fiber dedupe relies on this)', () => {
    const ctx = new Context()
    const entry = entryConfig()
    new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entry))
    expect(() => new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entry)))
      .toThrow(/has been registered/)
  })
})

// ---------------------------------------------------------------------------
// ② with a settings service → set writes the user layer, live composed change
// ---------------------------------------------------------------------------

describe('with a settings service (set writes the user layer)', () => {
  it('set writes the user layer (describe visible), the composed value changes live, and set returns it', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ systemPrompt: 'entry prompt', immuneTurns: 5 })
    const bridge = installAdvisorSettings(ctx, entry)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    await waitRegistered(ctx)
    // The gateway's own inject child must have captured the settings service.
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    const result = await gateway.set({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' })

    // describe exposes the raw user layer (what the UI form wrote).
    const descriptor = ctx.settings.describe().find((d) => d.ns === ADVISOR_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toEqual({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' })
    // The composed value keeps the base defaults the patch did not override.
    const composed: ResolvedAdvisorConfig = {
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'entry prompt',
      immuneTurns: 5,
      maxDeltaMessages: 60,
    }
    // Live: the bridge source the runtime reads reflects the write.
    expect(resolveAdvisorConfig(bridge.source())).toEqual(composed)
    // get and the set result both return the new composed value.
    expect(gateway.get()).toEqual({ config: composed })
    expect(result).toEqual({ config: composed })
  })

  it('a patch changing only one key leaves the other base values intact', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const bridge = installAdvisorSettings(ctx, entryConfig({ immuneTurns: 3, maxDeltaMessages: 60 }))
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await gateway.set({ maxDeltaMessages: 10 })
    expect(gateway.get()).toEqual({
      config: {
        enabled: false,
        systemPrompt: '',
        immuneTurns: 3,
        maxDeltaMessages: 10,
      },
    })
  })
})

// ---------------------------------------------------------------------------
// ③ set unknown key → rejected (Config schema, nothing persisted)
// ---------------------------------------------------------------------------

describe('set validation (Config schema, unknown-key rejection unchanged)', () => {
  it('an unknown key is rejected before anything is written', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const bridge = installAdvisorSettings(ctx, entryConfig())
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await expect(gateway.set({ bogus: 1 } as never)).rejects.toThrow(/unknown config key "bogus"/)
    // Nothing was persisted: the user layer stays absent.
    const descriptor = ctx.settings.describe().find((d) => d.ns === ADVISOR_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toBeUndefined()
  })

  it('a patch violating the schema bounds is rejected', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entryConfig()))
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await expect(gateway.set({ immuneTurns: -1 } as never)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// ④ hard gate regression through the gateway
// ---------------------------------------------------------------------------

describe('hard gate regression (resolveAdvisorConfig stays the SSOT)', () => {
  it('set-enabled without provider/model still resolves to disabled-with-reason', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entryConfig()))
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    // The schema accepts an enabled-without-pair patch (the gate is a READ
    // resolution, not a write gate — the user may configure in stages).
    await gateway.set({ enabled: true })
    const config = gateway.get().config
    expect(config.enabled).toBe(false)
    expect(config.disabledReason).toMatch(/provider and model are missing/)
    // The wire shape carries no undefined fields (typertGateway JSON boundary).
    expect('provider' in config).toBe(false)
    expect('model' in config).toBe(false)
  })

  it('an empty provider/model pair trips the gate the same way', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entryConfig()))
    await waitRegistered(ctx)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())

    await gateway.set({ enabled: true, provider: '', model: '' })
    const config = gateway.get().config
    expect(config.enabled).toBe(false)
    expect(config.disabledReason).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// ⑤ endpoint claims (typertGateway SRC discovery + payload contract)
// ---------------------------------------------------------------------------

type FakeRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

type FakeRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<FakeRpcResult>

/** Records the `/api` interceptor the typertGateway mounts (gateway.spec.ts pattern). */
class FakeConnectionService extends Service {
  channel: string | undefined
  authority: string | undefined
  matches: ((endpoint: string) => boolean) | undefined
  handler: FakeRpcHandler | undefined

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc() {
    const owner = this.ctx
    return {
      intercept: (
        channel: string,
        matches: (endpoint: string) => boolean,
        handler: FakeRpcHandler,
        options: { readonly authority: string },
      ) =>
        owner.effect(() => {
          this.channel = channel
          this.authority = options.authority
          this.matches = matches
          this.handler = handler
          return () => {
            this.channel = undefined
            this.authority = undefined
            this.matches = undefined
            this.handler = undefined
          }
        }),
    }
  }
}

describe('typertGateway endpoint claims + payload contract', () => {
  async function composeGatewayHarness(): Promise<{ ctx: Context; connection: FakeConnectionService }> {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(FakeConnectionService)
    await ctx.plugin(TypertGatewayService)
    const bridge = installAdvisorSettings(ctx, entryConfig({ systemPrompt: 'entry prompt', immuneTurns: 5 }))
    new AdvisorConfigGateway(ctx, bridge)
    await waitRegistered(ctx)
    const connection = ctx.get('connection') as unknown as FakeConnectionService
    await vi.waitFor(() => expect(connection.channel).toBe('/api'))
    return { ctx, connection }
  }

  it('claims /api/advisor/get + /api/advisor/set through the SRC discovery (reflect.props + remoteMethods)', async () => {
    const { ctx, connection } = await composeGatewayHarness()
    // The same discovery claimsEndpoint uses: the service appears in the
    // shared reflection and carries the typertGateway binding + Remote markers.
    expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' })
    expect(connection.authority).toBe('trusted-host')
    expect(connection.matches!('advisor/get')).toBe(true)
    expect(connection.matches!('advisor/set')).toBe(true)
    // Unrelated endpoints are NOT claimed (the interceptor falls through).
    expect(connection.matches!('advisor/other')).toBe(false)
    expect(connection.matches!('goals/create')).toBe(false)
  })

  it('dispatches get/set through the /api interceptor with the { args } payload contract', async () => {
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    const got = await connection.handler!('advisor/get', { args: {} }, signal)
    expect(got).toEqual({
      ok: true,
      value: {
        config: {
          enabled: false,
          systemPrompt: 'entry prompt',
          immuneTurns: 5,
          maxDeltaMessages: 60,
        },
      },
    })

    const setResult = await connection.handler!(
      'advisor/set',
      { args: { patch: { enabled: true, provider: 'deepseek', model: 'deepseek-chat' } } },
      signal,
    )
    expect(setResult.ok).toBe(true)
    if (setResult.ok) {
      expect(setResult.value).toMatchObject({
        config: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', immuneTurns: 5 },
      })
    }

    // The written value is visible on the next get.
    const gotAgain = await connection.handler!('advisor/get', { args: {} }, signal)
    expect(gotAgain).toMatchObject({
      ok: true,
      value: { config: { enabled: true, provider: 'deepseek', model: 'deepseek-chat' } },
    })
  })

  it('enforces the payload contract: exactly one plain-object args field', async () => {
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    const badArgs = await connection.handler!('advisor/set', { args: 'not-an-object' }, signal)
    expect(badArgs.ok).toBe(false)
    if (!badArgs.ok) expect(badArgs.error.message).toContain('plain-object args field')

    const unknownWire = await connection.handler!('advisor/set', { args: { wrong: 1 } }, signal)
    expect(unknownWire.ok).toBe(false)
    if (!unknownWire.ok) expect(unknownWire.error.message).toContain('args fields do not match the descriptor')
  })

  it('invokes directly through ctx.typertGateway (same SRC descriptor path)', async () => {
    const { ctx } = await composeGatewayHarness()
    const result = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'get', args: {} })
    expect(result).toMatchObject({ config: { enabled: false, immuneTurns: 5 } })
  })
})

// ---------------------------------------------------------------------------
// ⑦ composed end-to-end: real plugin apply wires the gateway
// ---------------------------------------------------------------------------

describe('composed plugin (apply wires the gateway)', () => {
  it('typertGateway dispatches get/set against the live composed config', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    ctx.provide('sessions', {} as never)
    ctx.provide('agents', { get: () => undefined } as never)
    ctx.provide('llm', { stream: async () => {} } as never)
    await ctx.plugin(advisorPlugin, entryConfig({ systemPrompt: 'entry prompt', immuneTurns: 5 }))
    await vi.waitFor(() => {
      expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' })
    })
    await waitRegistered(ctx)

    const before = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'get', args: {} }) as { config: ResolvedAdvisorConfig }
    expect(before.config).toEqual({
      enabled: false,
      systemPrompt: 'entry prompt',
      immuneTurns: 5,
      maxDeltaMessages: 60,
    })

    // The set child may activate a tick after the namespace registers; the
    // waitFor retries the transient settings-unavailable failure.
    await vi.waitFor(async () => {
      const result = await ctx.typertGateway.invoke({
        namespace: 'advisor',
        method: 'set',
        args: { patch: { enabled: true, provider: 'deepseek', model: 'deepseek-chat' } },
      }) as { config: ResolvedAdvisorConfig }
      expect(result.config.enabled).toBe(true)
      expect(result.config.provider).toBe('deepseek')
      expect(result.config.model).toBe('deepseek-chat')
    })

    const after = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'get', args: {} }) as { config: ResolvedAdvisorConfig }
    expect(after.config).toEqual({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'entry prompt',
      immuneTurns: 5,
      maxDeltaMessages: 60,
    })
    // describe shows the user layer written through the gateway.
    const descriptor = ctx.settings.describe().find((d) => d.ns === ADVISOR_SETTINGS_NAMESPACE)!
    expect(descriptor.user).toEqual({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('a second plugin instance is deduped: one advisor service, no loud error, dispatch stays unambiguous (multi-fiber)', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    ctx.provide('sessions', {} as never)
    ctx.provide('agents', { get: () => undefined } as never)
    ctx.provide('llm', { stream: async () => {} } as never)
    const errors: unknown[] = []
    const debugs: unknown[] = []
    const levels = {
      error: (message: unknown) => { errors.push(message) },
      warn: () => {},
      info: () => {},
      debug: (message: unknown) => { debugs.push(message) },
    }
    ctx.logger = Object.assign(() => ({ ...levels }), levels) as never
    await ctx.plugin(advisorPlugin, entryConfig())
    await vi.waitFor(() => expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' }))

    // Second instance on the SAME context: the gateway registration must be
    // deduped (like the settings registration) — no loud error, debug log.
    await ctx.plugin(advisorPlugin, entryConfig())
    await vi.waitFor(() => {
      expect(debugs.some((message) => String(message).includes('gateway already registered'))).toBe(true)
    })
    expect(errors).toEqual([])

    // The single registration keeps dispatch unambiguous (a duplicate would
    // surface as typertGateway ambiguous-endpoint).
    const result = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'get', args: {} })
    expect(result).toMatchObject({ config: { enabled: false } })
  })
})
