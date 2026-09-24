/**
 * B2 (issue #88) — the per-session model gateway surface:
 * `/api/advisor/getSession` + `/api/advisor/setSessionModel`.
 *
 * Contract under test:
 * ① Unit (scripted face): `getSession` relays to the elected owner's face;
 *    a gateway without an owner answers `advisor/unavailable` in data; a
 *    malformed selection answers `advisor/rejected` WITHOUT touching the
 *    face; `selection: null` routes to the reset arm; the pair reaches the
 *    face trimmed (same rules as the command face).
 * ② Composed (real `apply` wiring): the explicit typert registration claims
 *    both endpoints; `getSession` returns the authoritative snapshot with the
 *    `lifetime: 'live-session'` marker (shape pinned); a pinned pair reports
 *    `modelOverride` + `modelSource: 'session'` and satisfies a pairless
 *    global default; reset re-inherits and reports the gate-blocked state
 *    truthfully when the global default has no pair — all without touching
 *    the GLOBAL config (`advisor/get` unchanged; `advisor/set` stays the only
 *    global writer).
 * ③ Session binding: unknown/disposed targets answer
 *    `advisor/session-unknown` WITHOUT starting the pre-commit validation
 *    (the `resolveModelInfo` spy is never called — no generation is
 *    allocated for a dead target) and without state changes.
 * ④ Writes route through the B1 controller: a set whose lookup succeeds
 *    commits through the controller's fencing (the resolveModelInfo spy is
 *    called exactly once) and the returned snapshot reflects the commit.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryEntryConfig, harnessAdvisorPlugin } from './support/memory-settings'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { installAdvisorSettings } from '../src/settings'
import { AdvisorConfigGateway } from '../src/gateway'
import type { AdvisorSessionGatewayFace, AdvisorSessionRpcResult, AdvisorSessionSnapshotWire } from '../src/gateway'
import type { AdvisorConfig } from '../src/config'

// n4 QC F-6: the single-reviewer guard is process-global; the composed tests
// mount the real plugin, so the flag must reset between cases.
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

/** One scripted face outcome. */
function snapshot(result: AdvisorSessionSnapshotWire): AdvisorSessionRpcResult {
  return { snapshot: result }
}

// ---------------------------------------------------------------------------
// ① unit: gateway behavior over a scripted face
// ---------------------------------------------------------------------------

describe('advisor session endpoints (unit, scripted face)', () => {
  function scripted(face: AdvisorSessionGatewayFace): { gateway: AdvisorConfigGateway } {
    const ctx = new Context()
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entryConfig()), () => face)
    return { gateway }
  }

  it('getSession relays to the elected owner face', () => {
    const getSession = vi.fn((): AdvisorSessionRpcResult => snapshot({
      sessionId: 'sess-1', enabled: false, lifetime: 'live-session',
    }))
    const { gateway } = scripted({ getSession, setSessionModel: vi.fn(), resetSessionModel: vi.fn() })
    expect(gateway.getSession('sess-1')).toEqual({
      snapshot: { sessionId: 'sess-1', enabled: false, lifetime: 'live-session' },
    })
    expect(getSession).toHaveBeenCalledWith('sess-1')
  })

  it('answers advisor/unavailable in data when no elected owner exists on this fiber', () => {
    const ctx = new Context()
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entryConfig()))
    expect(gateway.getSession('sess-1')).toEqual({
      error: { tag: 'advisor/unavailable', message: expect.stringContaining('no elected owner') },
    })
  })

  it('answers advisor/unavailable for writes too when no elected owner exists', async () => {
    const ctx = new Context()
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entryConfig()))
    await expect(gateway.setSessionModel('sess-1', null)).resolves.toEqual({
      error: { tag: 'advisor/unavailable', message: expect.any(String) },
    })
  })

  it('rejects a malformed selection as advisor/rejected WITHOUT touching the face', async () => {
    const setSessionModel = vi.fn(async (): Promise<AdvisorSessionRpcResult> => snapshot(undefined as never))
    const resetSessionModel = vi.fn((): AdvisorSessionRpcResult => snapshot(undefined as never))
    const { gateway } = scripted({
      getSession: () => snapshot(undefined as never),
      setSessionModel,
      resetSessionModel,
    })
    for (const bad of [undefined, 42, {}, { provider: 'p' }, { model: 'm' }, { provider: '', model: 'm' }, { provider: 'p x', model: 'm' }]) {
      const result = await gateway.setSessionModel('sess-1', bad)
      expect(result).toEqual({ error: { tag: 'advisor/rejected', message: expect.any(String) } })
    }
    expect(setSessionModel).not.toHaveBeenCalled()
    expect(resetSessionModel).not.toHaveBeenCalled()
  })

  it('routes selection null to the reset arm and a valid pair (trimmed) to the set arm', async () => {
    const setSessionModel = vi.fn(async (): Promise<AdvisorSessionRpcResult> => snapshot(undefined as never))
    const resetSessionModel = vi.fn((): AdvisorSessionRpcResult => snapshot(undefined as never))
    const { gateway } = scripted({
      getSession: () => snapshot(undefined as never),
      setSessionModel,
      resetSessionModel,
    })
    await gateway.setSessionModel('sess-1', null)
    expect(resetSessionModel).toHaveBeenCalledWith('sess-1')
    await gateway.setSessionModel('sess-1', { provider: '  deepseek  ', model: 'deepseek-chat' })
    expect(setSessionModel).toHaveBeenCalledWith('sess-1', 'deepseek', 'deepseek-chat')
    expect(resetSessionModel).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// ② + ③ + ④ composed: real apply wiring through the typertGateway
// ---------------------------------------------------------------------------

/** A minimal live Agent double (the controller reads only id + session.seq). */
function agentDouble(sessionId: string, seq = 7): unknown {
  return { id: sessionId, session: { seq } }
}

interface Harness {
  ctx: Context
  resolveModelInfo: ReturnType<typeof vi.fn>
}

/**
 * Compose the real plugin over a pairless-but-enabled global default: the
 * entry gate blocks (enabled: true without provider/model), which is exactly
 * the state where a session pin must satisfy the gate and a reset must report
 * the blocked state truthfully.
 */
async function compose(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService)
  ctx.provide('sessions', {} as never)
  const resolveModelInfo = vi.fn(async () => ({ provider: 'deepseek', model: 'deepseek-chat' }))
  ctx.provide('agents', { get: (id: string) => (id === 'sess-1' ? agentDouble(id) : undefined) } as never)
  ctx.provide('llm', { stream: async () => {}, resolveModelInfo } as never)
  const entry = new MemoryEntryConfig(entryConfig({ enabled: true }))
  await ctx.plugin(harnessAdvisorPlugin(), entry.config)
  await vi.waitFor(() => {
    expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' })
  })
  return { ctx, resolveModelInfo }
}

describe('composed session endpoints (apply wiring)', () => {
  it('getSession returns the authoritative snapshot; the shape pins lifetime live-session', async () => {
    const { ctx } = await compose()
    const result = await ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'getSession', args: { sessionId: 'sess-1' },
    })
    // Pairless enabled global → the S4 gate resolves to DISABLED-with-reason;
    // no modelSource/effectiveModel keys (the wire omits absent values).
    expect(result).toEqual({
      snapshot: {
        sessionId: 'sess-1',
        enabled: false,
        lifetime: 'live-session',
        disabledReason: expect.any(String),
      },
    })
  })

  it('setSessionModel pins the pair through the controller; the pin satisfies the pairless global gate', async () => {
    const { ctx, resolveModelInfo } = await compose()
    const result = await ctx.typertGateway.invoke({
      namespace: 'advisor',
      method: 'setSessionModel',
      args: { sessionId: 'sess-1', selection: { provider: 'deepseek', model: 'deepseek-chat' } },
    })
    expect(result).toEqual({
      snapshot: {
        sessionId: 'sess-1',
        enabled: true,
        lifetime: 'live-session',
        modelOverride: { provider: 'deepseek', model: 'deepseek-chat' },
        modelSource: 'session',
        effectiveModel: { provider: 'deepseek', model: 'deepseek-chat' },
      },
    })
    // The write rode the B1 controller: exactly one pre-commit validation.
    expect(resolveModelInfo).toHaveBeenCalledTimes(1)
    // A disabled... (enabled) session snapshot no longer carries the gate reason.
    const readback = await ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'getSession', args: { sessionId: 'sess-1' },
    })
    expect(readback).toEqual(result)
  })

  it('reset (selection null) re-inherits and reports the gate-blocked state without a call', async () => {
    const { ctx, resolveModelInfo } = await compose()
    await ctx.typertGateway.invoke({
      namespace: 'advisor',
      method: 'setSessionModel',
      args: { sessionId: 'sess-1', selection: { provider: 'deepseek', model: 'deepseek-chat' } },
    })
    resolveModelInfo.mockClear()
    const result = await ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'setSessionModel', args: { sessionId: 'sess-1', selection: null },
    })
    expect(result).toEqual({
      snapshot: {
        sessionId: 'sess-1',
        enabled: false,
        lifetime: 'live-session',
        disabledReason: expect.any(String),
      },
    })
    // Reset is synchronous — no validation lookup.
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })

  it('the global config stays untouched by the session surface (advisor/get unchanged)', async () => {
    const { ctx } = await compose()
    await ctx.typertGateway.invoke({
      namespace: 'advisor',
      method: 'setSessionModel',
      args: { sessionId: 'sess-1', selection: { provider: 'deepseek', model: 'deepseek-chat' } },
    })
    const global = await ctx.typertGateway.invoke({ namespace: 'advisor', method: 'get', args: {} })
    // The global default has no pair (entry config — resolved to
    // disabled-with-reason) — the session pin never leaked into the entry
    // config, and `advisor/set` stayed the only global writer.
    expect(global).toMatchObject({ config: { enabled: false, disabledReason: expect.any(String) } })
    expect(global).not.toMatchObject({ config: { provider: 'deepseek' } })
  })

  it('rejects unknown/disposed targets as advisor/session-unknown WITHOUT allocating validation work', async () => {
    const { ctx, resolveModelInfo } = await compose()
    const ghostGet = await ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'getSession', args: { sessionId: 'ghost' },
    })
    expect(ghostGet).toEqual({
      error: { tag: 'advisor/session-unknown', message: expect.stringContaining('not live') },
    })
    const ghostSet = await ctx.typertGateway.invoke({
      namespace: 'advisor',
      method: 'setSessionModel',
      args: { sessionId: 'ghost', selection: { provider: 'deepseek', model: 'deepseek-chat' } },
    })
    expect(ghostSet).toEqual({
      error: { tag: 'advisor/session-unknown', message: expect.any(String) },
    })
    // The rejection happened BEFORE the controller ran — no validation lookup
    // (and therefore no generation allocated) for the dead target.
    expect(resolveModelInfo).not.toHaveBeenCalled()
  })

  it('a validation failure surfaces as advisor/failed with the previous state untouched', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    ctx.provide('sessions', {} as never)
    ctx.provide('agents', { get: (id: string) => (id === 'sess-1' ? agentDouble(id) : undefined) } as never)
    const resolveModelInfo = vi.fn(async () => { throw new Error('unknown route') })
    ctx.provide('llm', { stream: async () => {}, resolveModelInfo } as never)
    const entry = new MemoryEntryConfig(entryConfig({ enabled: true }))
    await ctx.plugin(harnessAdvisorPlugin(), entry.config)
    await vi.waitFor(() => expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' }))

    const result = await ctx.typertGateway.invoke({
      namespace: 'advisor',
      method: 'setSessionModel',
      args: { sessionId: 'sess-1', selection: { provider: 'bogus', model: 'nope' } },
    })
    expect(result).toEqual({
      error: { tag: 'advisor/failed', message: expect.stringContaining('unknown route') },
    })
    // The failed write left no pin behind (the pairless gate state again).
    const readback = await ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'getSession', args: { sessionId: 'sess-1' },
    })
    expect(readback).toEqual({
      snapshot: {
        sessionId: 'sess-1',
        enabled: false,
        lifetime: 'live-session',
        disabledReason: expect.any(String),
      },
    })
  })
})
