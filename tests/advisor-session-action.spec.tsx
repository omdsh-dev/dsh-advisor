// @vitest-environment jsdom
/**
 * Advisor session header action (B2, issue #88) — component behavior over a
 * scripted wire face, mirroring the advisor-card spec (preloaded stores +
 * @testing-library/react; the dev-time `bindSnapshotSelector` stand-in reads
 * the current snapshot per render, so assertions after a store mutation
 * re-render explicitly).
 *
 * Contract under test:
 * ① the CLOSED action is neutral: the plugin name only — no model label, no
 *    panel (no false continuous-sync claim).
 * ② open is a refresh point: clicking fetches `/api/advisor/getSession` and
 *    the panel renders the authoritative snapshot (effective pair, source
 *    badge, live-session lifetime, gate/off notices).
 * ③ an unavailable surface renders the notice and offers NO write controls
 *    (never a global-write fallback) and only ever calls the session
 *    endpoints.
 * ④ pin flow: staged provider/model selects (from the shared directory,
 *    read-only) drive `setSessionModel` with `{ sessionId, selection }`; the
 *    returned snapshot renders.
 * ⑤ reset flow: **Use global default** fires `selection: null` and is
 *    disabled while the session inherits (nothing to reset).
 * ⑥ reconnect/focus signal: bumping the refresh epoch while open refetches.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientConnectionRpc, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { fakeSchema } from './support/schema-ops'
import { AdvisorSessionAction } from '../src/client/advisor-session'
import type { AdvisorSessionActionProps } from '../src/client/advisor-session'
import { AdvisorSessionModelController, AdvisorSettingsStore } from '../src/client/advisor-store'
import type { AdvisorSettingsState } from '../src/client/advisor-store'
import { en } from '../src/client/locales'

afterEach(cleanup)

/**
 * Dev-time stand-in for the renderer's hooks binding (see the card spec
 * header note): a selector hook reading the current snapshot per render.
 */
function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> {
  return (sel) => sel(w.getSnapshot())
}

/** The synthesized `t` seat: the en dictionary plus `{name}` substitution. */
const t = ((key: string, params?: Record<string, unknown>): string => {
  let text: string = en[key as keyof typeof en] ?? key
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}) as AdvisorSessionActionProps['t']

/** One scripted RPC: records the call and parks the response until settled. */
class ScriptedRpc {
  calls: Array<{ channel: string; method: string; args: unknown }> = []
  private resolvers: Array<(result: RpcResult<unknown>) => void> = []

  call(channel: string, method: string, payload: { args: unknown }): Promise<RpcResult<unknown>> {
    this.calls.push({ channel, method, args: payload.args })
    return new Promise((resolve) => { this.resolvers.push(resolve) })
  }

  settle(result: RpcResult<unknown>): void {
    this.resolvers.shift()!(result)
  }

  last(): { channel: string; method: string; args: unknown } {
    return this.calls[this.calls.length - 1]!
  }
}

function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

/** The directory state the shared card store would expose (preloaded). */
function directoryStore(): AdvisorSettingsStore {
  const directory = new AdvisorSettingsStore({} as never, {} as never, fakeSchema())
  directory.store.update((s: AdvisorSettingsState) => {
    s.status = 'ready'
    s.providers = [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], configured: true }]
    s.modelsByProvider = { deepseek: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }
  })
  return directory
}

interface Harness {
  rpc: ScriptedRpc
  epoch: ReturnType<typeof createSnapshotStore<{ epoch: number }>>
  controller: AdvisorSessionModelController
  props: AdvisorSessionActionProps
}

function harness(snapshot: unknown): Harness {
  const rpc = new ScriptedRpc()
  const controller = new AdvisorSessionModelController('sess-1', rpc as unknown as ClientConnectionRpc)
  const epoch = createSnapshotStore<{ epoch: number }>({ epoch: 0 })
  const directory = directoryStore()
  const props = {
    sessionId: 'sess-1',
    controller,
    directory,
    useSnapshot: bindSnapshotSelector(controller.store),
    useRefreshSignal: bindSnapshotSelector(epoch),
    useDirectory: bindSnapshotSelector(directory.store),
    // The conversation/global standard seats are never read by this
    // component — never-called stubs (the card-spec stub pattern).
    useConversation: (() => undefined) as never,
    useInput: (() => undefined) as never,
    inputActions: {} as never,
    useWorkspaces: (() => undefined) as never,
    t,
  } as AdvisorSessionActionProps
  return { rpc, epoch, controller, props }
}


/** Wait until the controller's in-flight op settled (store reached steady state). */
async function settled(h: { controller: AdvisorSessionModelController }): Promise<void> {
  await waitFor(() => {
    const state = h.controller.store.getSnapshot()
    expect(state.phase === 'ready' && !state.pending).toBe(true)
  })
}

const SESSION_SNAPSHOT = {
  snapshot: {
    sessionId: 'sess-1',
    enabled: true,
    lifetime: 'live-session' as const,
    modelSource: 'global' as const,
    effectiveModel: { provider: 'deepseek', model: 'deepseek-chat' },
  },
}

describe('advisor session header action (B2)', () => {
  it('the closed action is neutral: plugin name only, no model label, no panel', () => {
    const { props } = harness(ok(SESSION_SNAPSHOT))
    render(<AdvisorSessionAction {...props} />)
    const trigger = screen.getByRole('button', { name: en.sessionExpand })
    expect(trigger.textContent).toContain(en.sessionTrigger)
    // No model text anywhere in the closed surface, and no panel.
    expect(screen.queryByText('deepseek/deepseek-chat')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('open is a refresh point: the panel renders pair, source badge, and lifetime', async () => {
    const { props, rpc, controller } = harness(ok(SESSION_SNAPSHOT))
    const view = render(<AdvisorSessionAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(rpc.calls).toHaveLength(1))
    expect(rpc.last()).toEqual({ channel: '/api', method: 'advisor/getSession', args: { sessionId: 'sess-1' } })
    rpc.settle(ok(SESSION_SNAPSHOT))
    await settled({ controller })
    view.rerender(<AdvisorSessionAction {...props} />)
    expect(screen.getByRole('dialog').textContent).toContain('deepseek/deepseek-chat')
    expect(screen.getByRole('dialog').textContent).toContain(en.sessionSourceGlobal)
    expect(screen.getByRole('dialog').textContent).toContain(en.sessionLifetime)
  })

  it('an unavailable surface offers NO writes and never calls another channel', async () => {
    const { props, rpc, controller } = harness(ok({ error: { tag: 'advisor/unavailable', message: 'no elected owner' } }))
    const view = render(<AdvisorSessionAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(rpc.calls).toHaveLength(1))
    rpc.settle(ok({ error: { tag: 'advisor/unavailable', message: 'no elected owner' } }))
    await settled({ controller })
    view.rerender(<AdvisorSessionAction {...props} />)
    // The notice shows; the staged controls and both write actions are gone.
    expect(screen.getByRole('dialog').textContent).toContain(en.sessionUnavailable)
    expect(screen.queryByRole('button', { name: en.sessionPinAction })).toBeNull()
    expect(screen.queryByRole('button', { name: en.sessionReset })).toBeNull()
    expect(screen.queryByLabelText(en.provider)).toBeNull()
    // Only the session read endpoint was ever touched.
    expect(rpc.calls.every((call) => call.method === 'advisor/getSession')).toBe(true)
  })

  it('gate-blocked and disabled snapshots render truthfully', async () => {
    const { props, rpc, controller } = harness(ok(SESSION_SNAPSHOT))
    const view = render(<AdvisorSessionAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(rpc.calls).toHaveLength(1))
    rpc.settle(ok({
      snapshot: {
        sessionId: 'sess-1',
        enabled: false,
        lifetime: 'live-session',
        disabledReason: 'provider and model are missing',
      },
    }))
    await settled({ controller })
    view.rerender(<AdvisorSessionAction {...props} />)
    expect(screen.getByRole('dialog').textContent).toContain(en.sessionAdvisorOff)
    expect(screen.getByRole('dialog').textContent).toContain(t('sessionGateBlocked', { reason: 'provider and model are missing' }))
    expect(screen.getByRole('dialog').textContent).toContain(en.sessionNoPair)
  })

  it('the pin flow stages provider/model from the directory and sends the atomic pair', async () => {
    const { props, rpc, controller } = harness(ok(SESSION_SNAPSHOT))
    const view = render(<AdvisorSessionAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(rpc.calls).toHaveLength(1))
    rpc.settle(ok(SESSION_SNAPSHOT))
    await settled({ controller })
    view.rerender(<AdvisorSessionAction {...props} />)

    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek' } })
    view.rerender(<AdvisorSessionAction {...props} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'deepseek-chat' } })
    view.rerender(<AdvisorSessionAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionPinAction }))
    await waitFor(() => expect(rpc.calls).toHaveLength(2))
    expect(rpc.last()).toEqual({
      channel: '/api',
      method: 'advisor/setSessionModel',
      args: { sessionId: 'sess-1', selection: { provider: 'deepseek', model: 'deepseek-chat' } },
    })
    rpc.settle(ok({
      snapshot: {
        sessionId: 'sess-1',
        enabled: true,
        lifetime: 'live-session',
        modelOverride: { provider: 'deepseek', model: 'deepseek-chat' },
        modelSource: 'session',
        effectiveModel: { provider: 'deepseek', model: 'deepseek-chat' },
      },
    }))
    await settled({ controller })
    view.rerender(<AdvisorSessionAction {...props} />)
    expect(screen.getByRole('dialog').textContent).toContain(en.sessionSourceSession)
  })

  it('Use global default fires selection null and is disabled while inheriting', async () => {
    // Pinned session: the reset is enabled and fires `selection: null`.
    const pinned = {
      snapshot: {
        sessionId: 'sess-1',
        enabled: true,
        lifetime: 'live-session' as const,
        modelOverride: { provider: 'deepseek', model: 'deepseek-chat' },
        modelSource: 'session' as const,
        effectiveModel: { provider: 'deepseek', model: 'deepseek-chat' },
      },
    }
    const { props, rpc, controller } = harness(ok(pinned))
    const view = render(<AdvisorSessionAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(rpc.calls).toHaveLength(1))
    rpc.settle(ok(pinned))
    await settled({ controller })
    view.rerender(<AdvisorSessionAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionReset }))
    await waitFor(() => expect(rpc.calls).toHaveLength(2))
    expect(rpc.last().args).toEqual({ sessionId: 'sess-1', selection: null })

    // Inheriting session (source global) — nothing to reset, the action says so.
    const inheriting = harness(ok(SESSION_SNAPSHOT))
    const inheritingView = render(<AdvisorSessionAction {...inheriting.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(inheriting.rpc.calls).toHaveLength(1))
    inheriting.rpc.settle(ok(SESSION_SNAPSHOT))
    await settled({ controller: inheriting.controller })
    inheritingView.rerender(<AdvisorSessionAction {...inheriting.props} />)
    expect((screen.getAllByRole('button', { name: en.sessionReset }).at(-1) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a refresh-signal bump (reconnect/focus) refetches while open', async () => {
    const { props, rpc, epoch, controller } = harness(ok(SESSION_SNAPSHOT))
    const view = render(<AdvisorSessionAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(rpc.calls).toHaveLength(1))
    rpc.settle(ok(SESSION_SNAPSHOT))
    await settled({ controller })
    view.rerender(<AdvisorSessionAction {...props} />)
    // No bump + rerender → no refetch (the epoch is consumed idempotently).
    view.rerender(<AdvisorSessionAction {...props} />)
    expect(rpc.calls).toHaveLength(1)
    // The bump (connection reset / window focus) → the open menu refetches.
    epoch.update((signal) => { signal.epoch += 1 })
    view.rerender(<AdvisorSessionAction {...props} />)
    await waitFor(() => expect(rpc.calls).toHaveLength(2))
    expect(rpc.last().method).toBe('advisor/getSession')
  })
})
