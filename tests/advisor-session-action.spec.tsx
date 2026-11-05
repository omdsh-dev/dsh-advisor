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
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConnectionRpc, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { fakeSchema } from './support/schema-ops'
import { AdvisorSessionAction, computePopoverPosition } from '../src/client/advisor-session'
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

describe('computePopoverPosition (viewport clamp, issue #141)', () => {
  const viewport = { width: 1280, height: 800 }
  const panel = { width: 300, height: 200 }

  it('right-aligns the panel under the trigger when everything fits', () => {
    expect(computePopoverPosition({
      anchor: { left: 400, top: 40, right: 460, bottom: 64 },
      panel, viewport, gap: 6, margin: 8,
    })).toEqual({ left: 160, top: 70 })
  })

  it('clamps to the left viewport margin when the anchor sits near the left edge', () => {
    expect(computePopoverPosition({
      anchor: { left: 20, top: 40, right: 80, bottom: 64 },
      panel, viewport, gap: 6, margin: 8,
    })).toEqual({ left: 8, top: 70 })
  })

  it('clamps to the right viewport margin when right-aligned would overflow', () => {
    expect(computePopoverPosition({
      anchor: { left: 1240, top: 40, right: 1300, bottom: 64 },
      panel, viewport, gap: 6, margin: 8,
    })).toEqual({ left: 972, top: 70 })
  })

  it('clamps vertically so the panel never overflows the viewport bottom', () => {
    expect(computePopoverPosition({
      anchor: { left: 400, top: 726, right: 460, bottom: 750 },
      panel, viewport, gap: 6, margin: 8,
    })).toEqual({ left: 160, top: 592 })
  })

  it('never returns a negative offset when the panel is larger than the viewport', () => {
    // 1280×800 viewport, 1500×2000 panel: the naive upper clamp
    // (viewport − size − margin) lands below the margin, and plain
    // min(max(natural, margin), upper) would paint the panel off-screen.
    expect(computePopoverPosition({
      anchor: { left: 20, top: 40, right: 80, bottom: 64 },
      panel: { width: 1500, height: 2000 },
      viewport, gap: 6, margin: 8,
    })).toEqual({ left: 8, top: 8 })
  })
})

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

  it('the panel portals into document.body so the column overflow cannot clip it', () => {
    const { props } = harness(ok(SESSION_SNAPSHOT))
    render(<AdvisorSessionAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    expect(screen.getByRole('dialog').parentElement).toBe(document.body)
  })

  it('the portalled dialog stays wired to the trigger: aria-controls + focus hand-off', () => {
    // The portal severed the pre-portal DOM sibling path (Tab from the
    // trigger used to reach the panel); the wiring must restore it.
    // jsdom focuses regardless of CSS visibility; real browsers refuse to
    // focus a hidden element. Stub focus() to enforce the browser rule so
    // the timing (focus only after the panel commits visible) is proven.
    const originalFocus = HTMLElement.prototype.focus
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if ((this.style?.visibility ?? 'visible') === 'hidden') return
      originalFocus.call(this, options)
    })
    try {
      const { props } = harness(ok(SESSION_SNAPSHOT))
      render(<AdvisorSessionAction {...props} />)
      const trigger = screen.getByRole('button', { name: en.sessionExpand })
      // Closed: the panel (the id's owner) does not exist yet, so the
      // trigger must not advertise a dangling IDREF.
      expect(trigger.getAttribute('aria-controls')).toBeNull()
      fireEvent.click(trigger)
      const panel = screen.getByRole('dialog')
      expect(panel.id).not.toBe('')
      expect(trigger.getAttribute('aria-controls')).toBe(panel.id)
      // Focus moves into the panel on open and returns to the trigger on close.
      expect(document.activeElement).toBe(panel)
      fireEvent.click(screen.getByRole('button', { name: en.sessionCollapse }))
      expect(document.activeElement).toBe(trigger)
      // Closed again: the reference must go away with the panel.
      expect(trigger.getAttribute('aria-controls')).toBeNull()
    } finally {
      focusSpy.mockRestore()
    }
  })

  it('a closed first mount never steals page focus', () => {
    // The return-focus path must fire on open→close transitions only: focus
    // an external element, mount the component closed, and require focus to
    // stay put. Without that guard the first mount takes the close path and
    // pulls focus into the closed trigger.
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    try {
      const { props } = harness(ok(SESSION_SNAPSHOT))
      render(<AdvisorSessionAction {...props} />)
      expect(document.activeElement).toBe(outside)
    } finally {
      outside.remove()
    }
  })

  it('a reopen after close is measured and visible again (the skip-unchanged ref must not strand it hidden)', () => {
    const { props } = harness(ok(SESSION_SNAPSHOT))
    render(<AdvisorSessionAction {...props} />)
    const trigger = screen.getByRole('button', { name: en.sessionExpand })
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog').style.visibility).toBe('visible')
    fireEvent.click(screen.getByRole('button', { name: en.sessionCollapse }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog').style.visibility).toBe('visible')
  })

  it('re-clamps the open panel when async content growth changes its measured height', async () => {
    // jsdom measures nothing: drive the geometry the layout effect reads.
    // Scope the stub to the dialog panel (role="dialog") so a measurement
    // taken from the wrong element reads 0 and fails the assertions.
    let panelHeight = 80
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'dialog' ? panelHeight : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'dialog' ? 300 : 0
    })
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 250 })
    // The size-change channel the panel relies on (jsdom has no
    // ResizeObserver): contract-mirror stub — each instance records the
    // element it was asked to observe, and growth is reported only through
    // instances that actually observed the panel. Deleting
    // `observer.observe(panel)` in production leaves no matching instance,
    // the growth below is never reported, and this test goes red.
    const observed: Array<{ callback: () => void; element: Element }> = []
    vi.stubGlobal('ResizeObserver', class {
      #callback: () => void
      constructor(callback: () => void) { this.#callback = callback }
      observe(element: Element): void { observed.push({ callback: this.#callback, element }) }
      unobserve(): void {}
      disconnect(): void {}
    })
    // First-paint contract: the panel mounts `visibility: hidden` and turns
    // visible only once the layout effect has measured and clamped it.
    // React applies style through the CSSStyleDeclaration accessor, so a
    // prototype spy observes the hidden → visible order. Every write is
    // recorded with its declaration so the assertion can scope to the panel
    // — an unrelated element's write must not satisfy it.
    const appliedVisibilities: Array<{ decl: CSSStyleDeclaration; value: string }> = []
    const styleProto = Object.getPrototypeOf(document.createElement('div').style) as CSSStyleDeclaration
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(styleProto, 'visibility')
    if (visibilityDescriptor !== undefined && visibilityDescriptor.set !== undefined) {
      const { set: setVisibility, get: getVisibility } = visibilityDescriptor
      Object.defineProperty(styleProto, 'visibility', {
        set(this: CSSStyleDeclaration, value: string) {
          appliedVisibilities.push({ decl: this, value })
          setVisibility.call(this, value)
        },
        get: getVisibility,
        configurable: true,
      })
    }
    try {
      const { props, rpc, controller } = harness(ok(SESSION_SNAPSHOT))
      const view = render(<AdvisorSessionAction {...props} />)
      const trigger = screen.getByRole('button', { name: en.sessionExpand })
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        left: 400, top: 40, right: 460, bottom: 64, width: 60, height: 24, x: 400, y: 40, toJSON: () => ({}),
      } as DOMRect)

      fireEvent.click(trigger)
      const panel = screen.getByRole('dialog')
      // Open at height 80 under a 250px viewport: natural top 70 fits the
      // bottom clamp (250 − 80 − 8 = 162), so it applies as-is — measured
      // and visible.
      expect(panel.style.top).toBe('70px')
      expect(panel.style.visibility).toBe('visible')

      // The snapshot settles (loading → loaded body) and the panel grows to
      // 200; the position must re-clamp to 250 − 200 − 8 = 42 — without any
      // resize or scroll event.
      rpc.settle(ok(SESSION_SNAPSHOT))
      await settled({ controller })
      view.rerender(<AdvisorSessionAction {...props} />)
      panelHeight = 200
      observed.filter((entry) => entry.element === panel).forEach((entry) => { entry.callback() })
      await waitFor(() => { expect(panel.style.top).toBe('42px') })
      expect(panel.style.visibility).toBe('visible')
      const panelVisibilities = appliedVisibilities
        .filter((entry) => entry.decl === panel.style)
        .map((entry) => entry.value)
      expect(panelVisibilities.slice(0, 2)).toEqual(['hidden', 'visible'])
    } finally {
      if (visibilityDescriptor !== undefined) {
        Object.defineProperty(styleProto, 'visibility', visibilityDescriptor)
      }
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
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
