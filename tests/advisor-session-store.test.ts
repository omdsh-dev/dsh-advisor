/**
 * Advisor session model controller (B2, issue #88) — store unit tests over a
 * scripted wire face (fake connection RPC caller for the session gateway
 * channel).
 *
 * Contract under test:
 * ① refresh commits the authoritative snapshot (`advisor/getSession`, args
 *    `{ sessionId }` — the controller's OWN binding, never another's).
 * ② binding/order fence: a monotonic request seq discards a superseded
 *    settle — a stale refresh response can neither overwrite a newer write
 *    nor mutate a different session's controller (structural binding fence).
 * ③ outcome mapping: `advisor/unavailable` / `advisor/session-unknown` tags
 *    and transport failures latch `unavailable`; `advisor/rejected`-class
 *    tags keep the surface usable with the message shown; a snapshot commit
 *    clears the latch and the error.
 * ④ writes: `setSessionModel` sends `{ sessionId, selection: {provider,
 *    model} }`; `resetSessionModel` sends `selection: null`; both commit the
 *    returned snapshot. An unavailable menu REFUSES the write with no rpc
 *    call (never falls back to the global `advisor/set` channel).
 * ⑤ refresh signal consumption is idempotent per epoch (open fetch + the
 *    reconnect/focus watcher never double-fetch the same epoch).
 */

import { describe, expect, it } from 'vitest'
import type { ClientConnectionRpc, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { AdvisorSessionModelController } from '../src/client/advisor-store'
import type { AdvisorSessionRpcPayload, AdvisorSessionSnapshotView } from '../src/client/advisor-store'

/** One scripted RPC: records the call and parks the response until settled. */
class ScriptedRpc {
  calls: Array<{ channel: string; method: string; args: unknown }> = []
  private resolvers: Array<(result: RpcResult<unknown>) => void> = []

  call(channel: string, method: string, payload: { args: unknown }): Promise<RpcResult<unknown>> {
    this.calls.push({ channel, method, args: payload.args })
    return new Promise((resolve) => { this.resolvers.push(resolve) })
  }

  /** Settle parked calls in FIFO order. */
  settle(...results: RpcResult<unknown>[]): void {
    for (const result of results) this.resolvers.shift()!(result)
  }

  /** Settle parked calls in LIFO order (settle a newer op before an older one). */
  settleLast(...results: RpcResult<unknown>[]): void {
    for (const result of results) this.resolvers.pop()!(result)
  }

  /** The nth call (0-based). */
  callAt(index: number): { channel: string; method: string; args: unknown } {
    return this.calls[index]!
  }
}

function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

function fail(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function snapshotOf(overrides: Partial<AdvisorSessionSnapshotView> = {}): AdvisorSessionRpcPayload {
  return {
    snapshot: {
      sessionId: 'sess-A',
      enabled: true,
      lifetime: 'live-session',
      ...overrides,
    },
  }
}

describe('advisor session model controller (B2)', () => {
  it('refresh fetches getSession with its own sessionId and commits the snapshot', async () => {
    const rpc = new ScriptedRpc()
    const controller = new AdvisorSessionModelController('sess-A', rpc as unknown as ClientConnectionRpc)
    const pending = controller.refresh()
    expect(rpc.calls).toEqual([
      { channel: '/api', method: 'advisor/getSession', args: { sessionId: 'sess-A' } },
    ])
    rpc.settle(ok(snapshotOf({
      modelOverride: { provider: 'deepseek', model: 'deepseek-chat' },
      modelSource: 'session',
      effectiveModel: { provider: 'deepseek', model: 'deepseek-chat' },
    })))
    await pending
    const state = controller.store.getSnapshot()
    expect(state.phase).toBe('ready')
    expect(state.unavailable).toBe(false)
    expect(state.error).toBeNull()
    expect(state.snapshot?.modelSource).toBe('session')
    expect(state.snapshot?.lifetime).toBe('live-session')
  })

  it('a transport failure latches unavailable; the menu then refuses writes with NO rpc call', async () => {
    const rpc = new ScriptedRpc()
    const controller = new AdvisorSessionModelController('sess-A', rpc as unknown as ClientConnectionRpc)
    const refresh = controller.refresh()
    rpc.settle(fail('channel down'))
    await refresh
    expect(controller.store.getSnapshot().unavailable).toBe(true)

    await controller.setSessionModel('deepseek', 'deepseek-chat')
    const writeCalls = rpc.calls.filter((call) => call.method === 'advisor/setSessionModel')
    expect(writeCalls).toEqual([]) // never falls back to any write channel
    expect(controller.store.getSnapshot().error).toContain('unavailable')
  })

  it('an advisor/unavailable tag latches unavailable; advisor/rejected keeps the surface usable', async () => {
    const rpc = new ScriptedRpc()
    const controller = new AdvisorSessionModelController('sess-A', rpc as unknown as ClientConnectionRpc)
    const refresh = controller.refresh()
    rpc.settle(ok({ error: { tag: 'advisor/unavailable', message: 'no elected owner' } }))
    await refresh
    expect(controller.store.getSnapshot().unavailable).toBe(true)

    // Recovery on the next open/signal: a later refresh with a real snapshot
    // clears the latch.
    const recover = controller.refresh()
    rpc.settle(ok(snapshotOf({})))
    await recover
    expect(controller.store.getSnapshot().unavailable).toBe(false)

    // A business rejection never latches: the message shows, writes stay.
    const rejected = controller.refresh()
    rpc.settle(ok({ error: { tag: 'advisor/rejected', message: 'incomplete pair' } }))
    await rejected
    const state = controller.store.getSnapshot()
    expect(state.unavailable).toBe(false)
    expect(state.error).toBe('incomplete pair')
    const write = controller.setSessionModel('p', 'm')
    rpc.settle(ok(snapshotOf({})))
    await write
    expect(rpc.callAt(rpc.calls.length - 1).method).toBe('advisor/setSessionModel')
  })

  it('a stale refresh response is discarded after a newer write settled (request fence)', async () => {
    const rpc = new ScriptedRpc()
    const controller = new AdvisorSessionModelController('sess-A', rpc as unknown as ClientConnectionRpc)
    const staleRefresh = controller.refresh() // parked first
    const write = controller.setSessionModel('other', 'model-2') // parked second (newer op)
    expect(rpc.calls).toHaveLength(2)
    // The NEWER op settles first (LIFO); the stale refresh settles LAST.
    rpc.settleLast(ok(snapshotOf({
      effectiveModel: { provider: 'other', model: 'model-2' },
      modelOverride: { provider: 'other', model: 'model-2' },
      modelSource: 'session',
    })))
    await write
    rpc.settle(ok(snapshotOf({ effectiveModel: { provider: 'old', model: 'stale' } })))
    await staleRefresh
    const state = controller.store.getSnapshot()
    expect(state.snapshot?.effectiveModel).toEqual({ provider: 'other', model: 'model-2' })
    expect(state.pending).toBe(false)
  })

  it('a late response for one binding never touches another session controller', async () => {
    const rpc = new ScriptedRpc()
    const a = new AdvisorSessionModelController('sess-A', rpc as unknown as ClientConnectionRpc)
    const b = new AdvisorSessionModelController('sess-B', rpc as unknown as ClientConnectionRpc)
    const refreshA = a.refresh()
    const refreshB = b.refresh()
    // Every call carries its OWN binding — no shared session surface.
    expect(rpc.callAt(0).args).toEqual({ sessionId: 'sess-A' })
    expect(rpc.callAt(1).args).toEqual({ sessionId: 'sess-B' })
    rpc.settle(
      ok(snapshotOf({ sessionId: 'sess-A', effectiveModel: { provider: 'x', model: '1' } })),
      ok(snapshotOf({ sessionId: 'sess-B', effectiveModel: { provider: 'y', model: '2' } })),
    )
    await Promise.all([refreshA, refreshB])
    expect(a.store.getSnapshot().snapshot?.effectiveModel).toEqual({ provider: 'x', model: '1' })
    expect(b.store.getSnapshot().snapshot?.effectiveModel).toEqual({ provider: 'y', model: '2' })

    // A late response addressed to B settles into B only; A's late response
    // settles into A only — neither controller ever sees the other's payload
    // (each commits its OWN store from responses carrying its OWN sessionId).
    const lateA = a.refresh()
    const lateB = b.refresh()
    rpc.settleLast(ok(snapshotOf({ sessionId: 'sess-B', modelSource: 'session' })))
    await lateB
    rpc.settle(ok(snapshotOf({ sessionId: 'sess-A', effectiveModel: { provider: 'z', model: '3' } })))
    await lateA
    // B's state came from B's own late response (which carried no pair).
    expect(b.store.getSnapshot().snapshot?.modelSource).toBe('session')
    expect(b.store.getSnapshot().snapshot?.effectiveModel).toBeUndefined()
    // A's state came from A's own late response.
    expect(a.store.getSnapshot().snapshot?.effectiveModel).toEqual({ provider: 'z', model: '3' })
  })

  it('set sends the atomic pair; reset sends selection null; both commit the returned snapshot', async () => {
    const rpc = new ScriptedRpc()
    const controller = new AdvisorSessionModelController('sess-A', rpc as unknown as ClientConnectionRpc)
    const initial = controller.refresh()
    rpc.settle(ok(snapshotOf({})))
    await initial

    const write = controller.setSessionModel('deepseek', 'deepseek-chat')
    rpc.settle(ok(snapshotOf({
      modelOverride: { provider: 'deepseek', model: 'deepseek-chat' },
      modelSource: 'session',
    })))
    await write
    expect(rpc.callAt(rpc.calls.length - 1)).toEqual({
      channel: '/api',
      method: 'advisor/setSessionModel',
      args: { sessionId: 'sess-A', selection: { provider: 'deepseek', model: 'deepseek-chat' } },
    })
    expect(controller.store.getSnapshot().snapshot?.modelSource).toBe('session')

    const reset = controller.resetSessionModel()
    rpc.settle(ok(snapshotOf({ enabled: false, disabledReason: 'no pair' })))
    await reset
    expect(rpc.callAt(rpc.calls.length - 1).args).toEqual({
      sessionId: 'sess-A',
      selection: null,
    })
    // The reset-to-missing-global-pair snapshot (gate-blocked) renders
    // truthfully from the host's answer — no further call is made.
    expect(rpc.calls).toHaveLength(3)
    expect(controller.store.getSnapshot().snapshot?.modelOverride).toBeUndefined()
    expect(controller.store.getSnapshot().snapshot?.disabledReason).toBe('no pair')
  })

  it('takeSignal is idempotent per epoch (open fetch + watcher never double-fetch)', async () => {
    const rpc = new ScriptedRpc()
    const controller = new AdvisorSessionModelController('sess-A', rpc as unknown as ClientConnectionRpc)
    expect(controller.takeSignal(0)).toBe(true)
    expect(controller.takeSignal(0)).toBe(false)
    expect(controller.takeSignal(1)).toBe(true) // reconnect/focus bump
    expect(controller.takeSignal(1)).toBe(false)
  })
})
