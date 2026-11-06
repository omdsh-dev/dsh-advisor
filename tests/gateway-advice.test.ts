/**
 * The delivered-advice tip endpoint (`/api/advisor/advice`) and its face.
 *
 * The durable injected message is context-only in the chat, so the web tip
 * reads the same delivery event through this read-only face. Contract:
 * ① `getAdvice` relays to the elected owner's face; a malformed request is
 *    `advisor/rejected` without touching the face; no owner is
 *    `advisor/unavailable` in data.
 * ② `advisorAdviceFace` keeps the SESSION-SCOPED gate: a disabled session
 *    answers `{ advice: null }` even with a retained note (no leak past
 *    `/advisor off`), and the retained note is the last routed one.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installAdvisorSettings } from '../src/settings'
import { AdvisorConfigGateway, type AdvisorAdviceFace, type AdvisorAdviceRpcResult } from '../src/gateway'
import type { AdvisorConfig, ResolvedAdvisorConfig } from '../src/config'
import { AdvisorDelivery, advisorAdviceFace } from '../src/delivery'

/** Full entry (plugin-row) config shape, merged over the schema defaults. */
function entryConfig(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    systemPrompt: '',
    immuneTurns: 3,
    maxDeltaMessages: 60,
    ...overrides,
  }
}

/** The session-scoped effective-config shape the wiring's factory receives. */
const effective = (overrides: Partial<ResolvedAdvisorConfig> = {}): ResolvedAdvisorConfig => ({
  enabled: true,
  provider: 'deepseek',
  model: 'deepseek-chat',
  systemPrompt: '',
  immuneTurns: 3,
  maxDeltaMessages: 60,
  nextPrompt: true,
  defaultEnabled: true,
  ...overrides,
})

describe('advisor advice endpoint (unit, scripted face)', () => {
  function scripted(face: AdvisorAdviceFace): AdvisorConfigGateway {
    const ctx = new Context()
    return new AdvisorConfigGateway(
      ctx,
      installAdvisorSettings(ctx, entryConfig()),
      () => undefined,
      undefined,
      undefined,
      undefined,
      () => face,
    )
  }

  it('relays the last delivered note to the elected owner face', () => {
    const getAdvice = vi.fn((): AdvisorAdviceRpcResult => ({ advice: { severity: 'concern', note: 'cap the retries', deliveryId: 3 } }))
    const gateway = scripted({ getAdvice })
    expect(gateway.getAdvice('sess-1')).toEqual({ advice: { severity: 'concern', note: 'cap the retries', deliveryId: 3 } })
    expect(getAdvice).toHaveBeenCalledWith('sess-1')
  })

  it('rejects an empty or non-string sessionId as advisor/rejected WITHOUT touching the face', () => {
    const getAdvice = vi.fn((): AdvisorAdviceRpcResult => ({ advice: null }))
    const gateway = scripted({ getAdvice })
    for (const bad of [undefined, 42, '']) {
      expect(gateway.getAdvice(bad as never)).toEqual({
        error: { tag: 'advisor/rejected', message: expect.any(String) },
      })
    }
    expect(getAdvice).not.toHaveBeenCalled()
  })

  it('answers advisor/unavailable in data when no elected owner exists on this fiber', () => {
    const ctx = new Context()
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entryConfig()))
    expect(gateway.getAdvice('sess-1')).toEqual({
      error: { tag: 'advisor/unavailable', message: expect.stringContaining('no elected owner') },
    })
  })
})

describe('advisorAdviceFace (session-scoped gate + retention)', () => {
  /**
   * Narrow one result to its advice payload. The error arm is part of the
   * contract, so it throws with its tag/message instead of collapsing to
   * `null` (a regression toward the error path then fails with a named diff,
   * not an opaque TypeError on `advice!`).
   */
  function adviceOf(result: AdvisorAdviceRpcResult): { severity: string; note: string; deliveryId: number } | null {
    if ('error' in result) throw new Error(`unexpected ${result.error.tag}: ${result.error.message}`)
    return result.advice
  }

  function deliver(severity: 'nit' | 'concern' | 'blocker', note: string): AdvisorDelivery {
    const delivery = new AdvisorDelivery({ immuneTurns: 0 })
    delivery.registerAgent({ id: 'sess-1', inject: vi.fn(), steer: vi.fn() })
    delivery.route('sess-1', { severity, note })
    return delivery
  }

  it('serves the last routed note with a clock-seeded delivery id, then clears', () => {
    const delivery = deliver('concern', 'cap the retries')
    const face = advisorAdviceFace(() => effective(), delivery)
    const advice = adviceOf(face.getAdvice('sess-1'))
    expect(advice).toMatchObject({ severity: 'concern', note: 'cap the retries' })
    // The face copies the retained note's id verbatim (the wire identity the
    // tip's dismissal compares).
    expect(advice!.deliveryId).toBe(delivery.getLastNote('sess-1')!.deliveryId)
    delivery.clearLastNote('sess-1')
    expect(face.getAdvice('sess-1')).toEqual({ advice: null })
  })

  it('answers null for a disabled session even with a retained note', () => {
    const delivery = deliver('nit', 'name the helper')
    const face = advisorAdviceFace(() => effective({ enabled: false }), delivery)
    expect(face.getAdvice('sess-1')).toEqual({ advice: null })
  })

  it('serves the NEWEST routed note (last write wins, never an accumulating list)', () => {
    const delivery = new AdvisorDelivery({ immuneTurns: 0 })
    delivery.registerAgent({ id: 'sess-1', inject: vi.fn(), steer: vi.fn() })
    const face = advisorAdviceFace(() => effective(), delivery)
    delivery.route('sess-1', { severity: 'nit', note: 'first note' })
    const first = adviceOf(face.getAdvice('sess-1'))
    delivery.route('sess-1', { severity: 'blocker', note: 'second note' })
    const second = adviceOf(face.getAdvice('sess-1'))
    expect(second).toMatchObject({ severity: 'blocker', note: 'second note' })
    expect(second!.deliveryId).toBe(delivery.getLastNote('sess-1')!.deliveryId)
    expect(second!.deliveryId).toBeGreaterThan(first!.deliveryId)
  })

  it('re-reads the session config per request (no memoization at face construction)', () => {
    const delivery = deliver('concern', 'cap the retries')
    let enabled = true
    const face = advisorAdviceFace(() => effective({ enabled }), delivery)
    const initial = adviceOf(face.getAdvice('sess-1'))
    expect(initial).toMatchObject({ severity: 'concern', note: 'cap the retries' })
    enabled = false
    expect(face.getAdvice('sess-1')).toEqual({ advice: null })
    enabled = true
    expect(face.getAdvice('sess-1')).toEqual({ advice: initial })
  })

  it('allocates unique ids across every instance in the process', () => {
    const first = deliver('nit', 'first instance')
    const second = deliver('concern', 'second instance')
    const firstId = first.getLastNote('sess-1')!.deliveryId
    const secondId = second.getLastNote('sess-1')!.deliveryId
    expect(secondId).toBeGreaterThan(firstId)
  })

  it('seeds a new process above a restart-zero counter (module load time)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      vi.resetModules()
      const before = await import('../src/delivery')
      const a = new before.AdvisorDelivery({ immuneTurns: 0 })
      a.registerAgent({ id: 'sess-1', inject: vi.fn(), steer: vi.fn() })
      a.route('sess-1', { severity: 'nit', note: 'before restart' })
      const beforeId = a.getLastNote('sess-1')!.deliveryId

      vi.setSystemTime(2_000)
      vi.resetModules()
      const after = await import('../src/delivery')
      const b = new after.AdvisorDelivery({ immuneTurns: 0 })
      b.registerAgent({ id: 'sess-1', inject: vi.fn(), steer: vi.fn() })
      b.route('sess-1', { severity: 'nit', note: 'after restart' })
      const afterId = b.getLastNote('sess-1')!.deliveryId

      // Scope: the module seed is wall-clock milliseconds, so a later process
      // starts above 1 and above an earlier process under a monotonic clock.
      // A rewound clock is NOT covered — see the allocator's doc comment.
      expect(beforeId).toBeGreaterThan(1)
      expect(afterId).toBeGreaterThan(beforeId)
    } finally {
      vi.useRealTimers()
      vi.resetModules()
    }
  })
})
