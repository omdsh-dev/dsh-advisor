/**
 * Delivered-advice tip controller (`src/client/advice-store.ts`).
 *
 * Wire contract under test: a valid `{ advice: { severity, note } }` payload
 * serves the note; every malformed shape (unknown severity, empty/non-string
 * note, tagged `{ error }`, `ok: false`) settles `unavailable` with nothing to
 * show; and a newer fetch fences an older settle so a late response can never
 * overwrite a newer answer.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ClientConnectionRpc, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { AdvisorAdviceController } from '../src/client/advice-store'

function controllerWith(call: (payload: { args: unknown }) => Promise<RpcResult<unknown>>): {
  controller: AdvisorAdviceController
  rpc: { call: ReturnType<typeof vi.fn> }
} {
  const rpc = { call: vi.fn((_channel: string, _method: string, payload: { args: unknown }) => call(payload)) }
  return { controller: new AdvisorAdviceController('sess-1', rpc as unknown as ClientConnectionRpc), rpc }
}

const ok = (value: unknown): RpcResult<unknown> => ({ ok: true, value })
const fail: RpcResult<unknown> = { ok: false, error: { code: 'transport', message: 'offline', details: {} } }

describe('AdvisorAdviceController', () => {
  it('serves a valid delivered note and reads the per-session endpoint', async () => {
    const { controller, rpc } = controllerWith(async () => ok({ advice: { severity: 'concern', note: 'cap the retries' } }))
    await controller.fetch()
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', advice: { severity: 'concern', note: 'cap the retries' } })
    expect(rpc.call).toHaveBeenCalledWith('/api', 'advisor/advice', { args: { sessionId: 'sess-1' } })
  })

  it('normalizes every malformed advice shape to nothing to show', async () => {
    const bad = [
      { advice: { severity: 'info', note: 'x' } },
      { advice: { severity: 'nit', note: '' } },
      { advice: { severity: 'nit', note: 42 } },
      { advice: null },
    ]
    for (const value of bad) {
      const { controller } = controllerWith(async () => ok(value))
      await controller.fetch()
      expect(controller.store.getSnapshot(), JSON.stringify(value)).toEqual({ status: 'ready', advice: null })
    }
  })

  it('treats a contract-violating primitive payload as unavailable', async () => {
    const { controller } = controllerWith(async () => ok('not-an-object'))
    await controller.fetch()
    expect(controller.store.getSnapshot()).toEqual({ status: 'unavailable', advice: null })
  })

  it('treats ok:false and tagged { error } payloads as unavailable', async () => {
    for (const result of [fail, ok({ error: { tag: 'advisor/unavailable', message: 'no owner' } })]) {
      const { controller } = controllerWith(async () => result)
      await controller.fetch()
      expect(controller.store.getSnapshot()).toEqual({ status: 'unavailable', advice: null })
    }
  })

  it('discards a late settle superseded by a newer fetch', async () => {
    const resolvers: Array<(result: RpcResult<unknown>) => void> = []
    const { controller } = controllerWith(() => new Promise<RpcResult<unknown>>((resolve) => { resolvers.push(resolve) }))
    const first = controller.fetch()
    const second = controller.fetch()
    resolvers[1]!(ok({ advice: { severity: 'nit', note: 'newer' } }))
    await second
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', advice: { severity: 'nit', note: 'newer' } })
    resolvers[0]!(ok({ advice: { severity: 'blocker', note: 'stale' } }))
    await first
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', advice: { severity: 'nit', note: 'newer' } })
  })
})
