/**
 * T1 (plan dsh-advisor-settings-gateway-n5) — host-side `advisor` config
 * gateway (`/api/advisor/get` + `/api/advisor/set` via explicit
 * `ctx.typert.register` contribution — `ctx.typert.local` is what the
 * typertGateway claims first).
 *
 * Contract under test (`AdvisorConfigGateway`, src/gateway.ts):
 * ① No settings service (plain cordis ctx) — `get` returns the entry
 *    composed value (volatile references unwrapped), and `set` fails cleanly
 *    (the settings service is unavailable — KD-G5 error path).
 * ② With a settings service mounted — `set` writes the advisor ENTRY config
 *    through `settings.update('advisor', ...)` (the entry id); the loader
 *    double commits the volatile fields + emits `loader/volatile-update`, so
 *    the write is LIVE (the bridge source reflects it) and `set` returns the
 *    new composed value. A second `set` MERGES into the entry config; the
 *    patch rides the in-process write channel (the wire-level exposed-
 *    namespace check only guards the apiproxy path).
 * ③ `set` with an unknown key is rejected by the `Config` schema
 *    (unknown-key rejection unchanged) and nothing is persisted.
 * ④ Hard gate regression: enabled without provider/model still resolves to
 *    disabled-with-reason (no model call — SSOT unchanged).
 * ⑤ Endpoint claims: the explicit typert registration (the same
 *    `ctx.typert.local` store `claimsEndpoint` checks) claims
 *    `/api/advisor/get` + `/api/advisor/set`; the payload contract is exactly
 *    one plain-object `args` field; dispatch through the recorded `/api`
 *    interceptor and direct `ctx.typertGateway.invoke` both work.
 * ⑥ Multi-fiber dedupe: a second gateway on the same context fails loud
 *    (cordis Service duplicate registration) — the dedupe catch in
 *    `src/index.ts` relies on that exact error.
 * ⑦ Composed end-to-end: the real plugin `apply` wires the gateway; the
 *    typertGateway dispatches get/set against the live composed config.
 *
 * The settings service is the REAL `SettingsForms` shape's write seam, stood
 * in by a structural double delegating to the loader double
 * (`MemoryEntryConfig.commit`) — `SettingsForms` is a final host class whose
 * storage needs a real profile document; the double reproduces the one
 * contract the gateway consumes: `update(ns, patch)` lands the patch in the
 * entry config and (via the commit) announces it to the bridge.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { MemoryEntryConfig, harnessAdvisorPlugin } from './support/memory-settings'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { installAdvisorSettings } from '../src/settings'
import { AdvisorConfigGateway, advisorTypertContribution } from '../src/gateway'
import { resolveAdvisorConfig } from '../src/config'
import type { AdvisorConfig, ResolvedAdvisorConfig } from '../src/config'

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

/**
 * Mount the settings write seam: a structural `SettingsForms` double whose
 * `update(ns, patch)` lands the patch through the loader double (volatile
 * commit + `loader/volatile-update`) — the exact chain a real `update` drives
 * (config editor → loader → commit + event). Registered under the `settings`
 * service key as a real cordis Service, so the gateway's conditional inject
 * child captures it and a registry delete exercises the capture-clearing
 * disposer.
 */
let latestSettingsDouble: MemorySettingsDouble | undefined

class MemorySettingsDouble extends Service {
  static inject: string[] = []

  /** The one method the gateway drives: write the entry config through the
   * loader double (volatile commit + `loader/volatile-update`) — the exact
   * chain a real `SettingsForms.update` drives (config editor → loader →
   * commit + event). */
  readonly update: (ns: string, patch: Record<string, unknown>) => Promise<void>

  constructor(ctx: Context, entry: MemoryEntryConfig) {
    super(ctx, 'settings')
    latestSettingsDouble = this
    this.update = vi.fn(async (_ns: string, patch: Record<string, unknown>): Promise<void> => {
      entry.commit(ctx, patch)
    })
  }
}

/**
 * Mount the settings double as a class PLUGIN (mounted like the old
 * `MemorySettings`, so `ctx.registry.delete` still disposes it and exercises
 * the gateway's capture-clearing inject disposer). `ctx.plugin` resolves to
 * the fiber, not the instance — the constructor stashes the instance for the
 * spy assertions.
 */
async function provideSettingsDouble(ctx: Context, entry: MemoryEntryConfig): Promise<MemorySettingsDouble> {
  await ctx.plugin(MemorySettingsDouble, entry)
  return latestSettingsDouble!
}

/** Read the gateway's internal settings capture (activated inject child). */
function settingsOf(gateway: AdvisorConfigGateway): unknown {
  return (gateway as unknown as { settings?: unknown }).settings
}

/** Wait until the conditional `ctx.inject(['settings'], ...)` child captured the service. */
async function waitCaptured(ctx: Context, gateway: AdvisorConfigGateway): Promise<void> {
  await vi.waitFor(() => expect(settingsOf(gateway)).toBeDefined())
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

  it('get unwraps a volatile-reference entry (the loader-resolved shape)', () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' }))
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entry.config))
    expect(gateway.get().config.enabled).toBe(true)
    expect(gateway.get().config.provider).toBe('deepseek')
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
// ② with a settings service → set writes the entry config, live composed change
// ---------------------------------------------------------------------------

describe('with a settings service (set writes the entry config)', () => {
  it('set writes the entry config, the composed value changes live, and set returns it', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ systemPrompt: 'entry prompt', immuneTurns: 5 }))
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

    const result = await gateway.set({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' })

    // The write rode the settings channel keyed by the ENTRY id.
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

  it('set rides the settings.update entry-id channel (ns = the bundle row id)', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig())
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    const settings = await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

    await gateway.set({ enabled: true })
    expect(settings.update).toHaveBeenCalledWith('advisor', { enabled: true })
  })

  it('a patch changing only one key leaves the other entry values intact', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ immuneTurns: 3, maxDeltaMessages: 60 }))
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

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

  it('a second set MERGES into the existing entry config (merge, not replace semantics)', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ systemPrompt: 'entry prompt' }))
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

    await gateway.set({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' })
    await gateway.set({ maxDeltaMessages: 10 })

    // The entry config keeps ALL four keys written across the two calls — a
    // replace-semantics write would have dropped the earlier trio.
    expect(gateway.get()).toEqual({
      config: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        systemPrompt: 'entry prompt',
        immuneTurns: 3,
        maxDeltaMessages: 10,
      },
    })
  })

  it('an empty patch is a no-op: returns the current composed value without a write (S2)', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' }))
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    const settings = await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

    const result = await gateway.set({})
    expect(settings.update).not.toHaveBeenCalled()
    expect(result).toEqual(gateway.get())
    expect(result.config.enabled).toBe(true)
  })

  it('strips null-valued patch keys before the write (raw null never lands in the entry config)', async () => {
    // JSON cannot carry undefined, so a null value is a third-party client's
    // way of saying "absent". The resolver already treats null as missing on
    // read; the raw entry config must not store it either — the null key is
    // dropped before the write, so the pinned provider survives.
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' }))
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

    await gateway.set({ provider: null, systemPrompt: 'edited' } as never)
    expect(gateway.get().config).toEqual({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'edited',
      immuneTurns: 3,
      maxDeltaMessages: 60,
    })
  })

  it('an all-null patch is a no-op: nothing written, composed value unchanged', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' }))
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    const settings = await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

    await gateway.set({ provider: null, model: null } as never)
    expect(settings.update).not.toHaveBeenCalled()
    expect(gateway.get().config.enabled).toBe(true)
    expect(gateway.get().config.provider).toBe('deepseek')
  })

  it('set fails cleanly after the settings service is disposed (the inject child disposer clears the capture)', async () => {
    // The inject child's returned disposer mirrors the loader's teardown: when
    // the settings service goes away, the captured reference is cleared, so
    // `set` fails with the KD-G5 error instead of holding a stale service
    // reference (which would throw from inside the settings package after
    // disposal).
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig())
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

    ctx.registry.delete(MemorySettingsDouble)
    await vi.waitFor(() => expect(settingsOf(gateway)).toBeUndefined())
    await expect(gateway.set({ enabled: true })).rejects.toThrow(/settings service is unavailable/)
  })
})

// ---------------------------------------------------------------------------
// ③ set validation (Config schema, unknown-key rejection unchanged)
// ---------------------------------------------------------------------------

describe('set validation (Config schema, unknown-key rejection unchanged)', () => {
  it('an unknown key is rejected before anything is written', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig())
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    const settings = await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

    await expect(gateway.set({ bogus: 1 } as never)).rejects.toThrow(/unknown config key "bogus"/)
    // Nothing was persisted: the write channel was never driven.
    expect(settings.update).not.toHaveBeenCalled()
    expect(bridge.source()).toEqual(entryConfig())
  })

  it('a patch violating the schema bounds is rejected', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig())
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

    await expect(gateway.set({ immuneTurns: -1 } as never)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// ④ hard gate regression through the gateway
// ---------------------------------------------------------------------------

describe('hard gate regression (resolveAdvisorConfig stays the SSOT)', () => {
  it('set-enabled without provider/model still resolves to disabled-with-reason', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig())
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

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
    const entry = new MemoryEntryConfig(entryConfig())
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

    await gateway.set({ enabled: true, provider: '', model: '' })
    const config = gateway.get().config
    expect(config.enabled).toBe(false)
    expect(config.disabledReason).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// ⑤ endpoint claims (explicit typert registration + payload contract)
// ---------------------------------------------------------------------------

type FakeRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

type FakeRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<FakeRpcResult>

/** Records the `/api` interceptor the typertGateway mounts (alpha.2 `HostConnectionRpc.intercept` shape). */
class FakeConnectionService extends Service {
  channel: string | undefined
  matches: ((endpoint: string) => boolean) | undefined
  handler: FakeRpcHandler | undefined

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc() {
    const owner = this.ctx
    return {
      intercept: (
        channel: '/api',
        matches: (endpoint: string) => boolean,
        handler: FakeRpcHandler,
      ) =>
        owner.effect(() => {
          this.channel = channel
          this.matches = matches
          this.handler = handler
          return () => {
            this.channel = undefined
            this.matches = undefined
            this.handler = undefined
          }
        }),
    }
  }
}

describe('typertGateway endpoint claims + payload contract', () => {
  async function composeGatewayHarness(seedEntry?: Record<string, unknown>): Promise<{ ctx: Context; connection: FakeConnectionService; entry: MemoryEntryConfig }> {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(FakeConnectionService)
    await ctx.plugin(TypertGatewayService)
    // Entry values a seed would have pinned pre-load (the pre-0.1.7 user
    // layer) now ride the entry config itself: the harness hands the plugin
    // its already-resolved volatile references.
    const entry = new MemoryEntryConfig(entryConfig({
      systemPrompt: 'entry prompt',
      immuneTurns: 5,
      ...(seedEntry as Partial<AdvisorConfig> | undefined),
    }))
    const bridge = installAdvisorSettings(ctx, entry.config)
    new AdvisorConfigGateway(ctx, bridge)
    await provideSettingsDouble(ctx, entry)
    ctx.typert.register(advisorTypertContribution())
    const connection = ctx.get('connection') as unknown as FakeConnectionService
    await vi.waitFor(() => expect(connection.channel).toBe('/api'))
    return { ctx, connection, entry }
  }

  it('claims /api/advisor/get + /api/advisor/set through the explicit typert registration (ctx.typert.local)', async () => {
    const { ctx, connection } = await composeGatewayHarness()
    // The registration writes invocation descriptors into `ctx.typert.local`
    // — the store `claimsEndpoint` checks FIRST — and the gateway remains a
    // registered cordis service.
    expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' })
    expect(ctx.typert.local.get('advisor/get')).toMatchObject({ service: 'advisor', namespace: 'advisor', method: 'get' })
    expect(ctx.typert.local.get('advisor/set')).toMatchObject({ service: 'advisor', namespace: 'advisor', method: 'set' })
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

  it('invokes directly through ctx.typertGateway (same strict descriptor path)', async () => {
    const { ctx } = await composeGatewayHarness()
    const result = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'get', args: {} })
    expect(result).toMatchObject({ config: { enabled: false, immuneTurns: 5 } })
  })

  it('a seeded unknown key never fails get: ok:true + disabled-with-reason carrying the message (M2 containment)', async () => {
    // Entry config with an unknown key (survives the non-strict schemastery
    // object merge) — the gateway's read must contain it (qc2 W-1): ok:true,
    // disabled-with-reason carrying the resolver message, no model call can
    // start (gate semantics), and the scalar latches are seeded from the raw
    // source (S1) rather than hardcoded defaults.
    const { connection } = await composeGatewayHarness({ bogus: 1 } as Partial<AdvisorConfig>)
    const got = await connection.handler!('advisor/get', { args: {} }, new AbortController().signal)
    expect(got.ok).toBe(true)
    if (got.ok) {
      const config = (got.value as { config: ResolvedAdvisorConfig }).config
      expect(config.enabled).toBe(false)
      expect(config.disabledReason).toContain('unknown config key "bogus"')
      // S1: the readable raw source seeds the scalar latches (entry values).
      expect(config.immuneTurns).toBe(5)
      expect(config.systemPrompt).toBe('entry prompt')
      // The offending config is not a usable provider/model pair — omitted.
      expect('provider' in config).toBe(false)
      expect('model' in config).toBe(false)
    }
  })

  it('rejects a business-invalid patch at the wire: ok:false + unknown config key (M3)', async () => {
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    const rejected = await connection.handler!('advisor/set', { args: { patch: { bogus: 1 } } }, signal)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.error.message).toContain('unknown config key "bogus"')
    }
    // The rejected write persisted nothing: the composed config is unchanged.
    const got = await connection.handler!('advisor/get', { args: {} }, signal)
    expect(got.ok).toBe(true)
    if (got.ok) {
      expect((got.value as { config: ResolvedAdvisorConfig }).config.enabled).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// ⑦ composed end-to-end: real plugin apply wires the gateway
// ---------------------------------------------------------------------------

describe('composed plugin (apply wires the gateway)', () => {
  it('typertGateway dispatches get/set against the live composed config', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    ctx.provide('sessions', {} as never)
    ctx.provide('agents', { get: () => undefined } as never)
    ctx.provide('llm', { stream: async () => {} } as never)
    const entry = new MemoryEntryConfig(entryConfig({ systemPrompt: 'entry prompt', immuneTurns: 5 }))
    await provideSettingsDouble(ctx, entry)
    await ctx.plugin(harnessAdvisorPlugin(), entry.config)
    await vi.waitFor(() => {
      expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' })
    })

    const before = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'get', args: {} }) as { config: ResolvedAdvisorConfig }
    expect(before.config).toEqual({
      enabled: false,
      systemPrompt: 'entry prompt',
      immuneTurns: 5,
      maxDeltaMessages: 60,
    })

    // The set child may activate a tick after the plugin loads; the waitFor
    // retries the transient settings-unavailable failure.
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
  })

  it('a second plugin instance is deduped: one advisor service, no loud error, dispatch stays unambiguous (multi-fiber)', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    ctx.provide('sessions', {} as never)
    ctx.provide('agents', { get: () => undefined } as never)
    ctx.provide('llm', { stream: async () => {} } as never)
    const entry = new MemoryEntryConfig(entryConfig())
    await provideSettingsDouble(ctx, entry)
    const errors: unknown[] = []
    const debugs: unknown[] = []
    const levels = {
      error: (message: unknown) => { errors.push(message) },
      warn: () => {},
      info: () => {},
      debug: (message: unknown) => { debugs.push(message) },
    }
    ctx.logger = Object.assign(() => ({ ...levels }), levels) as never
    await ctx.plugin(harnessAdvisorPlugin(), entry.config)
    await vi.waitFor(() => expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' }))

    // Second instance on the SAME context: the gateway registration must be
    // deduped (like the old settings registration) — no loud error, debug log.
    await ctx.plugin(harnessAdvisorPlugin(), entry.config)
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
