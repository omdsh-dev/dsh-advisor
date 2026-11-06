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
  /** Narrow one result to its advice payload (the error arm is not expected here). */
  function adviceOf(result: AdvisorAdviceRpcResult): { severity: string; note: string; deliveryId: number } | null {
    return 'advice' in result ? result.advice : null
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
    // Clock-seeded, not a counter that restarts at 0 on every process boot.
    expect(Number.isInteger(advice!.deliveryId)).toBe(true)
    expect(advice!.deliveryId).toBeGreaterThan(1)
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

  it('keeps delivery ids increasing across a restart (clock-seeded, never reused)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const before = deliver('nit', 'before restart')
      const beforeId = before.getLastNote('sess-1')!.deliveryId
      vi.setSystemTime(2_000)
      const after = deliver('nit', 'after restart')
      const afterId = after.getLastNote('sess-1')!.deliveryId
      expect(beforeId).toBeGreaterThan(1)
      expect(afterId).toBeGreaterThan(beforeId)
    } finally {
      vi.useRealTimers()
    }
  })
})
