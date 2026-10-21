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
 *    (unknown-key rejection unchanged) and nothing is persisted — the removed
 *    `enabled` key (2026-09-26) is tolerated and stripped from the write
 *    payload — accepted, never persisted (2026-09-27 ruling).
 * ④ Hard gate regression: a pairless config still resolves to
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
import { ownerPeer, provideRemoteAccess } from './support/typert-gateway'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { installAdvisorSettings } from '../src/settings'
import { AdvisorConfigGateway, advisorTypertContribution } from '../src/gateway'
import type {
  AdvisorGatewayLogger, AdvisorModelInfoResolver, AdvisorModelReasoningEffortWire, AdvisorModelReasoningResult,
} from '../src/gateway'
import { resolveAdvisorConfig } from '../src/config'
import type { AdvisorConfig, ResolvedAdvisorConfig } from '../src/config'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'

// n4 QC F-6: the single-reviewer guard is process-global; the composed test
// mounts the real plugin, so the flag must reset between cases.
beforeEach(() => {
  delete (globalThis as Record<string, unknown>)['__dshAdvisorReviewer__']
})

/** Full entry (plugin-row) config shape, merged over the schema defaults. */
function entryConfig(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
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
    const entry = entryConfig({ provider: 'deepseek', model: 'deepseek-chat', immuneTurns: 5 })
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entry))

    expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' })
    // Wire shape (issue #102, qc1 W-1): the resolver fills the schema
    // defaults, so the read path carries proseFallback too. No maxTokens
    // since the 2026-10-18 ruling (the budget is removed).
    expect(gateway.get()).toEqual({
      config: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        systemPrompt: '',
        immuneTurns: 5,
        maxDeltaMessages: 60,
        proseFallback: false,
        nextPrompt: true,
        defaultEnabled: true,
      },
    })
  })

  it('get unwraps a volatile-reference entry (the loader-resolved shape)', () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ provider: 'deepseek', model: 'deepseek-chat' }))
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entry.config))
    expect(gateway.get().config.enabled).toBe(true)
    expect(gateway.get().config.provider).toBe('deepseek')
  })

  it('set fails cleanly when no settings service is composed (KD-G5 error path)', async () => {
    const ctx = new Context()
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entryConfig()))
    await expect(gateway.set({ maxDeltaMessages: 10 })).rejects.toThrow(/settings service is unavailable/)
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

    const result = await gateway.set({ provider: 'deepseek', model: 'deepseek-chat' })

    // The write rode the settings channel keyed by the ENTRY id.
    // The full-config fixture mirrors the RESOLVER's output shape — the
    // schema default fills proseFallback (issue #102) and nextPrompt (plan
    // dsh-advisor-next-prompt-n12); maxTokens is gone (2026-10-18 ruling).
    const composed: ResolvedAdvisorConfig = {
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'entry prompt',
      immuneTurns: 5,
      maxDeltaMessages: 60,
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
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

    await gateway.set({ maxDeltaMessages: 10 })
    expect(settings.update).toHaveBeenCalledWith('advisor', { maxDeltaMessages: 10 })
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
        proseFallback: false,
        nextPrompt: true,
        defaultEnabled: true,
        disabledReason: expect.any(String),
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

    await gateway.set({ provider: 'deepseek', model: 'deepseek-chat' })
    await gateway.set({ maxDeltaMessages: 10 })

    // The entry config keeps ALL three keys written across the two calls — a
    // replace-semantics write would have dropped the earlier pair.
    expect(gateway.get()).toEqual({
      config: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        systemPrompt: 'entry prompt',
        immuneTurns: 3,
        maxDeltaMessages: 10,
        proseFallback: false,
        nextPrompt: true,
        defaultEnabled: true,
      },
    })
  })

  it('an empty patch is a no-op: returns the current composed value without a write (S2)', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ provider: 'deepseek', model: 'deepseek-chat' }))
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
    const entry = new MemoryEntryConfig(entryConfig({ provider: 'deepseek', model: 'deepseek-chat' }))
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
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
    })
  })

  it('an all-null patch is a no-op: nothing written, composed value unchanged', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ provider: 'deepseek', model: 'deepseek-chat' }))
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
    await expect(gateway.set({ maxDeltaMessages: 10 })).rejects.toThrow(/settings service is unavailable/)
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
  it('tolerates the legacy `enabled` key in a patch but never persists it (2026-09-27 ruling)', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig())
    const bridge = installAdvisorSettings(ctx, entry.config)
    const gateway = new AdvisorConfigGateway(ctx, bridge)
    const settings = await provideSettingsDouble(ctx, entry)
    await waitCaptured(ctx, gateway)

    // Stored-profile parity: the removed key passes validation (a stored
    // profile carrying `enabled:` loads cleanly) but is STRIPPED from the
    // write payload — the row toggle replaced it, so the dead key must not be
    // re-persisted. The valid pair in the same patch lands normally.
    await gateway.set({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' } as never)
    expect(settings.update).toHaveBeenCalledWith('advisor', { provider: 'deepseek', model: 'deepseek-chat' })
    // The landed write resolves through the gate: the pair made it enabled.
    const config = gateway.get().config
    expect(config.enabled).toBe(true)
    expect(config.provider).toBe('deepseek')
  })

  it('a pairless entry resolves to disabled-with-reason through get', async () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig())
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entry.config))

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

    // The gate is a READ resolution, not a write gate — the user may
    // configure in stages; the empty pair simply resolves disabled.
    await gateway.set({ provider: '', model: '' })
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

type FakeRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerScope) => Promise<FakeRpcResult>

/** Records the `/api` interceptor the typertGateway mounts (alpha.2 `HostConnectionRpc.intercept` shape). */
class FakeConnectionService extends Service {
  channel: string | undefined
  matches: ((endpoint: string) => boolean) | undefined
  handler: FakeRpcHandler | undefined
  /** The owner Peer this carrier admits; 0.2.1 requires every intercepted call to name one. */
  readonly peer: PeerScope

  constructor(ctx: Context) {
    super(ctx, 'connection')
    this.peer = ownerPeer(ctx)
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
  async function composeGatewayHarness(
    seedEntry?: Record<string, unknown>,
    resolveModelInfo?: AdvisorModelInfoResolver,
  ): Promise<{ ctx: Context; connection: FakeConnectionService; entry: MemoryEntryConfig }> {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(FakeConnectionService)
    await ctx.plugin(TypertGatewayService)
    provideRemoteAccess(ctx)
    // Entry values a seed would have pinned pre-load (the pre-0.1.7 user
    // layer) now ride the entry config itself: the harness hands the plugin
    // its already-resolved volatile references.
    const entry = new MemoryEntryConfig(entryConfig({
      systemPrompt: 'entry prompt',
      immuneTurns: 5,
      ...(seedEntry as Partial<AdvisorConfig> | undefined),
    }))
    const bridge = installAdvisorSettings(ctx, entry.config)
    new AdvisorConfigGateway(ctx, bridge, () => undefined, resolveModelInfo)
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
    expect(ctx.typert.local.get('advisor/modelReasoning')).toMatchObject({ service: 'advisor', namespace: 'advisor', method: 'modelReasoning' })
    expect(connection.matches!('advisor/get')).toBe(true)
    expect(connection.matches!('advisor/set')).toBe(true)
    expect(connection.matches!('advisor/modelReasoning')).toBe(true)
    // Unrelated endpoints are NOT claimed (the interceptor falls through).
    expect(connection.matches!('advisor/other')).toBe(false)
    expect(connection.matches!('goals/create')).toBe(false)
  })

  it('dispatches get/set through the /api interceptor with the { args } payload contract', async () => {
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    const got = await connection.handler!('advisor/get', { args: {} }, signal, connection.peer)
    // Seven-key wire (issue #102, qc1 W-1): the read path carries the two new
    // persisted keys (schema-defaulted false here).
    expect(got).toEqual({
      ok: true,
      value: {
        config: {
          enabled: false,
          systemPrompt: 'entry prompt',
          immuneTurns: 5,
          maxDeltaMessages: 60,
          proseFallback: false,
          nextPrompt: true,
          defaultEnabled: true,
          disabledReason: expect.any(String),
        },
      },
    })

    const setResult = await connection.handler!(
      'advisor/set',
      { args: { patch: { provider: 'deepseek', model: 'deepseek-chat' } } },
      signal,
      connection.peer,
    )
    expect(setResult.ok).toBe(true)
    if (setResult.ok) {
      expect(setResult.value).toMatchObject({
        config: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', immuneTurns: 5 },
      })
    }

    // The written value is visible on the next get.
    const gotAgain = await connection.handler!('advisor/get', { args: {} }, signal, connection.peer)
    expect(gotAgain).toMatchObject({
      ok: true,
      value: { config: { enabled: true, provider: 'deepseek', model: 'deepseek-chat' } },
    })
  })

  it('enforces the payload contract: exactly one plain-object args field', async () => {
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    const badArgs = await connection.handler!('advisor/set', { args: 'not-an-object' }, signal, connection.peer)
    expect(badArgs.ok).toBe(false)
    if (!badArgs.ok) expect(badArgs.error.message).toContain('plain-object args field')

    const unknownWire = await connection.handler!('advisor/set', { args: { wrong: 1 } }, signal, connection.peer)
    expect(unknownWire.ok).toBe(false)
    if (!unknownWire.ok) expect(unknownWire.error.message).toContain('args fields do not match the descriptor')
  })

  it('invokes directly through ctx.typertGateway (same strict descriptor path)', async () => {
    const { ctx } = await composeGatewayHarness()
    const result = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'get', args: {}, peer: ownerPeer(ctx) })
    expect(result).toMatchObject({ config: { enabled: false, immuneTurns: 5 } })
  })

  it('a seeded unknown key never fails get: ok:true + disabled-with-reason carrying the message (M2 containment)', async () => {
    // Entry config with an unknown key (survives the non-strict schemastery
    // object merge) — the gateway's read must contain it (qc2 W-1): ok:true,
    // disabled-with-reason carrying the resolver message, no model call can
    // start (gate semantics), and the scalar latches are seeded from the raw
    // source (S1) rather than hardcoded defaults.
    const { connection } = await composeGatewayHarness({ bogus: 1 } as Partial<AdvisorConfig>)
    const got = await connection.handler!('advisor/get', { args: {} }, new AbortController().signal, connection.peer)
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

    const rejected = await connection.handler!('advisor/set', { args: { patch: { bogus: 1 } } }, signal, connection.peer)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.error.message).toContain('unknown config key "bogus"')
    }
    // The rejected write persisted nothing: the composed config is unchanged.
    const got = await connection.handler!('advisor/get', { args: {} }, signal, connection.peer)
    expect(got.ok).toBe(true)
    if (got.ok) {
      expect((got.value as { config: ResolvedAdvisorConfig }).config.enabled).toBe(false)
    }
  })

  it('carries non-default proseFallback on set and through a get round-trip, and drops a legacy maxTokens patch key (wire, qc1 W-1)', async () => {
    // The write path always carried the new keys (schema-validated patch);
    // the READ path is the W-1 seam: the response wire and the next get must
    // carry the persisted values, not silently strip them. A maxTokens key
    // in the patch is the 2026-10-18-removed legacy: the resolver tolerates
    // and drops it on stored profiles, and it never appears on the wire.
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    const setResult = await connection.handler!(
      'advisor/set',
      { args: { patch: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096, proseFallback: true } } },
      signal,
      connection.peer,
    )
    expect(setResult.ok).toBe(true)
    if (setResult.ok) {
      expect(setResult.value).toMatchObject({
        config: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', proseFallback: true },
      })
      expect('maxTokens' in (setResult.value as { config: ResolvedAdvisorConfig }).config).toBe(false)
    }

    const got = await connection.handler!('advisor/get', { args: {} }, signal, connection.peer)
    expect(got.ok).toBe(true)
    if (got.ok) {
      expect(got.value).toMatchObject({
        config: { enabled: true, provider: 'deepseek', model: 'deepseek-chat', proseFallback: true },
      })
      expect('maxTokens' in (got.value as { config: ResolvedAdvisorConfig }).config).toBe(false)
    }
  })

  it('always carries defaultEnabled on get and round-trips a non-default false through set (GitHub issue #124)', async () => {
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    // The default get carries the key (schema default true) — it is a
    // persisted key, always included like nextPrompt.
    const before = await connection.handler!('advisor/get', { args: {} }, signal, connection.peer)
    expect(before.ok).toBe(true)
    if (before.ok) {
      const config = (before.value as { config: ResolvedAdvisorConfig }).config
      expect(config.defaultEnabled).toBe(true)
      expect('defaultEnabled' in config).toBe(true)
    }

    // A non-default patch persists and round-trips through the next get.
    const setResult = await connection.handler!(
      'advisor/set',
      { args: { patch: { provider: 'deepseek', model: 'deepseek-chat', defaultEnabled: false } } },
      signal,
      connection.peer,
    )
    expect(setResult.ok).toBe(true)
    if (setResult.ok) {
      expect((setResult.value as { config: ResolvedAdvisorConfig }).config.defaultEnabled).toBe(false)
    }
    const after = await connection.handler!('advisor/get', { args: {} }, signal, connection.peer)
    expect(after.ok).toBe(true)
    if (after.ok) {
      expect((after.value as { config: ResolvedAdvisorConfig }).config.defaultEnabled).toBe(false)
    }
  })

  it('the S1 containment fallback carries a raw-pinned proseFallback and omits it when the raw entry lacks it', async () => {
    // S1 mirrors the readable raw source's scalar latches (systemPrompt /
    // immuneTurns / maxDeltaMessages style) — the issue-#102 key rides the
    // same path: present on the wire iff the raw entry pins it (the
    // resolver never ran, so no schema default fills it here).
    const seeded = await composeGatewayHarness({ bogus: 1, proseFallback: true } as Partial<AdvisorConfig>)
    const seededGot = await seeded.connection.handler!('advisor/get', { args: {} }, new AbortController().signal, seeded.connection.peer)
    expect(seededGot.ok).toBe(true)
    if (seededGot.ok) {
      const config = (seededGot.value as { config: ResolvedAdvisorConfig }).config
      expect(config.disabledReason).toContain('unknown config key "bogus"')
      expect(config.proseFallback).toBe(true)
    }

    const bare = await composeGatewayHarness({ bogus: 1 } as Partial<AdvisorConfig>)
    const bareGot = await bare.connection.handler!('advisor/get', { args: {} }, new AbortController().signal, bare.connection.peer)
    expect(bareGot.ok).toBe(true)
    if (bareGot.ok) {
      const config = (bareGot.value as { config: ResolvedAdvisorConfig }).config
      expect(config.disabledReason).toContain('unknown config key "bogus"')
      // Absent keys are omitted, never present-as-undefined (wire boundary).
      expect('proseFallback' in config).toBe(false)
      // defaultEnabled is NOT one of those conditional keys: the fallback
      // seeds it (schema default true) and the wire always includes it.
      expect(config.defaultEnabled).toBe(true)
    }
  })

  // -------------------------------------------------------------------------
  // Model capability endpoint (plan dsh-advisor-reasoning-effort T2)
  // -------------------------------------------------------------------------

  it('serves the declared reasoning efforts in adapter order through /api/advisor/modelReasoning (T2)', async () => {
    // The adapter's declared efforts (least → greatest) pass through
    // untouched; an absent `description` is OMITTED, not
    // present-as-undefined (the typertGateway result validation rejects
    // undefined values).
    const resolveModelInfo = vi.fn(async () => ({
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium', description: 'Balanced' },
          { id: 'high', name: 'High' },
        ],
      },
    }))
    const { connection } = await composeGatewayHarness(undefined, resolveModelInfo)
    const result = await connection.handler!(
      'advisor/modelReasoning',
      { args: { provider: 'deepseek', model: 'deepseek-chat' } },
      new AbortController().signal,
      connection.peer,
    )
    expect(result).toEqual({
      ok: true,
      value: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium', description: 'Balanced' },
          { id: 'high', name: 'High' },
        ],
      },
    })
  })

  it('answers a tagged data error through the wire when no resolver is injected (never a wire failure, T2)', async () => {
    // A gateway without the capability resolver stays inert in DATA (ok:true +
    // plugin-domain tag) — the same shape the session endpoints use, so the
    // card can render "unavailable" instead of an RPC failure.
    const { connection } = await composeGatewayHarness()
    const result = await connection.handler!(
      'advisor/modelReasoning',
      { args: { provider: 'deepseek', model: 'deepseek-chat' } },
      new AbortController().signal,
      connection.peer,
    )
    expect(result).toEqual({
      ok: true,
      value: { error: { tag: 'advisor/model-reasoning-unavailable', message: expect.any(String) } },
    })
  })

  it('carries reasoningEffort on set and through a get round-trip (reasoningEffort key, T2)', async () => {
    const { connection } = await composeGatewayHarness()
    const signal = new AbortController().signal

    const setResult = await connection.handler!(
      'advisor/set',
      { args: { patch: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } } },
      signal,
      connection.peer,
    )
    expect(setResult.ok).toBe(true)
    if (setResult.ok) {
      expect(setResult.value).toMatchObject({ config: { reasoningEffort: 'high' } })
    }

    const got = await connection.handler!('advisor/get', { args: {} }, signal, connection.peer)
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.value).toMatchObject({ config: { reasoningEffort: 'high' } })
  })

  it("reads an emptied reasoningEffort back as absent ('' = automatic, T2)", async () => {
    const { connection } = await composeGatewayHarness({ reasoningEffort: 'high' })
    const signal = new AbortController().signal

    // The reasoningEffort key is persisted as the raw text the operator wrote; an empty
    // value means AUTOMATIC (config.ts RD-1), so the wire omits it rather than
    // carrying a present-as-empty key the renderer would print as a blank value.
    const cleared = await connection.handler!(
      'advisor/set',
      { args: { patch: { reasoningEffort: '' } } },
      signal,
      connection.peer,
    )
    expect(cleared.ok).toBe(true)
    if (cleared.ok) expect(cleared.value).not.toMatchObject({ config: { reasoningEffort: expect.anything() } })

    const got = await connection.handler!('advisor/get', { args: {} }, signal, connection.peer)
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.value).not.toMatchObject({ config: { reasoningEffort: expect.anything() } })
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
    provideRemoteAccess(ctx)
    ctx.provide('sessions', {} as never)
    ctx.provide('agents', { get: () => undefined } as never)
    ctx.provide('llm', { stream: async () => {} } as never)
    const entry = new MemoryEntryConfig(entryConfig({ systemPrompt: 'entry prompt', immuneTurns: 5 }))
    await provideSettingsDouble(ctx, entry)
    await ctx.plugin(harnessAdvisorPlugin(), entry.config)
    await vi.waitFor(() => {
      expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' })
    })

    const before = await ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'get', args: {}, peer: ownerPeer(ctx),
    }) as { config: ResolvedAdvisorConfig }
    expect(before.config).toEqual({
      enabled: false,
      systemPrompt: 'entry prompt',
      immuneTurns: 5,
      maxDeltaMessages: 60,
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
      disabledReason: expect.any(String),
    })

    // The set child may activate a tick after the plugin loads; the waitFor
    // retries the transient settings-unavailable failure.
    await vi.waitFor(async () => {
      const result = await ctx.typertGateway.invoke({
        namespace: 'advisor',
        method: 'set',
        args: { patch: { provider: 'deepseek', model: 'deepseek-chat' } },
        peer: ownerPeer(ctx),
      }) as { config: ResolvedAdvisorConfig }
      expect(result.config.enabled).toBe(true)
      expect(result.config.provider).toBe('deepseek')
      expect(result.config.model).toBe('deepseek-chat')
    })

    const after = await ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'get', args: {}, peer: ownerPeer(ctx),
    }) as { config: ResolvedAdvisorConfig }
    expect(after.config).toEqual({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'entry prompt',
      immuneTurns: 5,
      maxDeltaMessages: 60,
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
    })
  })

  it('serves advisor/modelReasoning through the injected app-root resolver (T2 apply wiring)', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    provideRemoteAccess(ctx)
    ctx.provide('sessions', {} as never)
    ctx.provide('agents', { get: () => undefined } as never)
    // The app-root llm carries the capability API `apply` injects as the
    // gateway's resolver (a partial llm double would leave the endpoint inert).
    ctx.provide('llm', {
      stream: async () => {},
      resolveModelInfo: async () => ({
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
      }),
    } as never)
    const entry = new MemoryEntryConfig(entryConfig({ systemPrompt: 'entry prompt' }))
    await provideSettingsDouble(ctx, entry)
    await ctx.plugin(harnessAdvisorPlugin(), entry.config)
    await vi.waitFor(() => expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' }))

    const result = await ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'modelReasoning', args: { provider: 'deepseek', model: 'deepseek-chat' }, peer: ownerPeer(ctx),
    })
    expect(result).toEqual({
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
    })
  })

  it('a second plugin instance is deduped: one advisor service, no loud error, dispatch stays unambiguous (multi-fiber)', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    provideRemoteAccess(ctx)
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
    const result = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'get', args: {}, peer: ownerPeer(ctx) })
    expect(result).toMatchObject({ config: { enabled: false } })
  })
})

// ---------------------------------------------------------------------------
// ⑧ capability endpoint arms (plan dsh-advisor-reasoning-effort T2)
// ---------------------------------------------------------------------------

describe('AdvisorConfigGateway.modelReasoning (capability endpoint arms)', () => {
  /** A gateway over a complete pair, with the capability resolver under test. */
  function gatewayWith(
    resolveModelInfo?: AdvisorModelInfoResolver,
    logger?: AdvisorGatewayLogger,
  ): AdvisorConfigGateway {
    const ctx = new Context()
    const entry = entryConfig({ provider: 'deepseek', model: 'deepseek-chat' })
    return new AdvisorConfigGateway(
      ctx,
      installAdvisorSettings(ctx, entry),
      () => undefined,
      resolveModelInfo,
      logger,
    )
  }

  const pair: [string, string] = ['deepseek', 'deepseek-chat']

  it('returns the declared efforts in the adapter order, omitting an absent description', async () => {
    // RD-2: least → greatest is the adapter's order, and that is the order the
    // selector must show; the runtime picks `efforts[0]` for the automatic arm,
    // so a reordered list would change what "automatic" sends.
    const gateway = gatewayWith(async () => ({
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'medium', name: 'Medium', description: 'Balanced' },
          { id: 'high', name: 'High' },
        ],
      },
    }))
    expect(await gateway.modelReasoning(...pair)).toEqual({
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'medium', name: 'Medium', description: 'Balanced' },
        { id: 'high', name: 'High' },
      ],
    })
  })

  it('answers unavailable when the model declares no reasoning metadata', async () => {
    const gateway = gatewayWith(async () => ({}))
    expect(await gateway.modelReasoning(...pair)).toEqual({
      error: { tag: 'advisor/model-reasoning-unavailable', message: expect.stringContaining('declares no reasoning') },
    })
  })

  it('answers unavailable on an empty efforts declaration (same verdict the runtime reaches)', async () => {
    // `reasoning: { efforts: [] }` offers nothing selectable — the runtime
    // omits the option (RD-2), so the endpoint must not report a ready list.
    const gateway = gatewayWith(async () => ({ reasoning: { efforts: [] } }))
    expect(await gateway.modelReasoning(...pair)).toEqual({
      error: { tag: 'advisor/model-reasoning-unavailable', message: expect.stringContaining('declares no reasoning') },
    })
  })

  it('answers failed with a generic message, logging the resolver detail instead of leaking it on the wire', async () => {
    const warn = vi.fn()
    const gateway = gatewayWith(async () => {
      throw new Error('unknown route: internal-adapter-detail')
    }, { warn })
    await expect(gateway.modelReasoning(...pair)).resolves.toEqual({
      error: { tag: 'advisor/model-reasoning-failed', message: 'advisor: model capability lookup failed' },
    })
    expect(warn).toHaveBeenCalledWith('advisor: model capability lookup failed', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      error: expect.any(Error),
    })
  })

  it('drops malformed declared efforts and coerces an empty name to the id', async () => {
    // Adapter data is untrusted: an entry without a usable string id is
    // ignored (including a null element) and an empty name falls back to the
    // id, so the selector can never render a nameless or unselectable option.
    const entries = [
      { id: '', name: 'Nameless' },
      { id: 'low', name: '' },
      { id: 'high', name: 'High', description: 'Great' },
      { name: 'No id' },
      null,
    ] as unknown as readonly AdvisorModelReasoningEffortWire[]
    const gateway = gatewayWith(async () => ({ reasoning: { efforts: entries } }))
    expect(await gateway.modelReasoning(...pair)).toEqual({
      efforts: [
        { id: 'low', name: 'low' },
        { id: 'high', name: 'High', description: 'Great' },
      ],
    })
  })

  it('answers unavailable when every declared effort filters out', async () => {
    const entries = [null, { id: '' }] as unknown as readonly AdvisorModelReasoningEffortWire[]
    const gateway = gatewayWith(async () => ({ reasoning: { efforts: entries } }))
    expect(await gateway.modelReasoning(...pair)).toEqual({
      error: { tag: 'advisor/model-reasoning-unavailable', message: expect.stringContaining('declares no reasoning') },
    })

    // A declaration that is not a list at all is the same verdict — this arm
    // must never throw out of the endpoint.
    const notAList = gatewayWith(async () => ({
      reasoning: { efforts: 5 as unknown as readonly AdvisorModelReasoningEffortWire[] },
    }))
    expect(await notAList.modelReasoning(...pair)).toEqual({
      error: { tag: 'advisor/model-reasoning-unavailable', message: expect.stringContaining('declares no reasoning') },
    })
  })

  it('bounds a hung capability lookup with the 60 s deadline (W-1: tagged failure, never a throw)', async () => {
    // The resolver ignores its signal and never settles: signal threading
    // alone would hang the query forever (the card's effort select stays
    // auto-only until a reload), so the race against the deadline signal is
    // what makes the bound real.
    const hang: AdvisorModelInfoResolver = () => new Promise(() => {})
    const resolveModelInfo = vi.fn(hang)
    const gateway = gatewayWith(resolveModelInfo)
    vi.useFakeTimers()
    try {
      const pending = gateway.modelReasoning(...pair)
      await vi.advanceTimersByTimeAsync(59_000)
      let settled = false
      void pending.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false) // before the deadline: still resolving
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(pending).resolves.toEqual({
        error: {
          tag: 'advisor/model-reasoning-failed',
          message: expect.stringContaining('timed out after 60000ms'),
        },
      })
      // One lookup, no retry — with the deadline signal threaded into it.
      expect(resolveModelInfo).toHaveBeenCalledTimes(1)
      expect(resolveModelInfo).toHaveBeenCalledWith('deepseek', 'deepseek-chat', expect.any(AbortSignal))
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers unavailable when the gateway holds no injected resolver', async () => {
    const gateway = gatewayWith()
    expect(await gateway.modelReasoning(...pair)).toEqual({
      error: { tag: 'advisor/model-reasoning-unavailable', message: expect.stringContaining('unavailable') },
    })
  })

  it('rejects an empty, blank or whitespace-bearing pair without invoking the resolver', async () => {
    const resolveModelInfo = vi.fn(async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }))
    const gateway = gatewayWith(resolveModelInfo)
    for (const [provider, model] of [['', 'deepseek-chat'], ['deepseek', '   '], ['deep seek', 'm']] as const) {
      expect(await gateway.modelReasoning(provider, model)).toEqual({
        error: { tag: 'advisor/model-reasoning-unavailable', message: expect.any(String) },
      })
    }
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })
})
