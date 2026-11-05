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

import { cleanup, fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react'
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
    // taken from the wrong element reads 0: the first-paint block guards
    // the width-derived `left`, and only the post-growth assertion
    // discriminates height.
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
      // and visible. `left` comes from the width (300px right-aligned to
      // the trigger rect: 460 − 300 = 160), so a wrong-element measurement
      // that reads width 0 cannot satisfy this first-paint assertion.
      expect(panel.style.left).toBe('160px')
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
    // Choosing a model resolves its declared efforts through the shared
    // capability endpoint (issue #142); settle it before the pin write.
    await waitFor(() => expect(rpc.calls).toHaveLength(2))
    expect(rpc.last().method).toBe('advisor/modelReasoning')
    rpc.settle(ok({ efforts: [] }))
    await waitFor(() => expect(controller.store.getSnapshot().reasoningStatus).toBe('ready'))
    fireEvent.click(screen.getByRole('button', { name: en.sessionPinAction }))
    await waitFor(() => expect(rpc.calls).toHaveLength(3))
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

describe('advisor session reasoning effort (issue #142)', () => {
  /** Open the panel and settle the initial snapshot (call 1). */
  async function openPanel(h: Harness): Promise<RenderResult> {
    const view = render(<AdvisorSessionAction {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok(SESSION_SNAPSHOT))
    await settled({ controller: h.controller })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    return view
  }

  /** Stage provider + model (fires the reasoning lookup, the next rpc call). */
  async function stagePair(h: Harness, view: RenderResult): Promise<void> {
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'deepseek-chat' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
  }

  const EFFORTS = { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }

  /** A session pinned to deepseek/deepseek-chat with the effort 'high'. */
  const PINNED_HIGH = {
    snapshot: {
      sessionId: 'sess-1',
      enabled: true,
      lifetime: 'live-session' as const,
      modelOverride: { provider: 'deepseek', model: 'deepseek-chat' },
      modelSource: 'session' as const,
      effectiveModel: { provider: 'deepseek', model: 'deepseek-chat' },
      reasoningEffortOverride: 'high',
    },
  }

  it('the effort select offers Inherit global plus the declared ids of the chosen model', async () => {
    const h = harness(ok(SESSION_SNAPSHOT))
    const view = render(<AdvisorSessionAction {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok(SESSION_SNAPSHOT))
    await settled({ controller: h.controller })
    view.rerender(<AdvisorSessionAction {...h.props} />)

    // No model chosen yet: disabled, inherit-only (the declared ids are
    // unknown until a model is picked).
    const idle = screen.getByLabelText(en.sessionEffort) as HTMLSelectElement
    expect(idle.disabled).toBe(true)
    expect(idle.value).toBe('')
    expect(Array.from(idle.options).map((o) => o.textContent)).toEqual([en.sessionEffortInherit])

    await stagePair(h, view)
    await waitFor(() => expect(h.rpc.calls).toHaveLength(2))
    expect(h.rpc.last()).toEqual({
      channel: '/api', method: 'advisor/modelReasoning', args: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    // The lookup is in flight → the select stays disabled while loading.
    expect((screen.getByLabelText(en.sessionEffort) as HTMLSelectElement).disabled).toBe(true)

    h.rpc.settle(ok(EFFORTS))
    await waitFor(() => expect(h.controller.store.getSnapshot().reasoningStatus).toBe('ready'))
    view.rerender(<AdvisorSessionAction {...h.props} />)
    const select = screen.getByLabelText(en.sessionEffort) as HTMLSelectElement
    expect(select.disabled).toBe(false)
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ['', en.sessionEffortInherit],
      ['low', 'Low'],
      ['high', 'High'],
    ])
  })

  it('a failed lookup for a newly selected model leaves only Inherit global and cannot pin the stale effort', async () => {
    const h = harness(ok(SESSION_SNAPSHOT))
    h.props.directory.store.update((s: AdvisorSettingsState) => {
      s.modelsByProvider = {
        deepseek: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b', name: 'Model B' },
        ],
      }
    })
    const view = await openPanel(h)

    // Stage model A and resolve its efforts; pick A's 'low'.
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'model-a' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    await waitFor(() => expect(h.rpc.calls).toHaveLength(2))
    h.rpc.settle(ok({ efforts: [{ id: 'low', name: 'Low' }] }))
    await waitFor(() => expect(h.controller.store.getSnapshot().reasoningStatus).toBe('ready'))
    view.rerender(<AdvisorSessionAction {...h.props} />)
    fireEvent.change(screen.getByLabelText(en.sessionEffort), { target: { value: 'low' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)

    // Switch to model B: the staged effort re-inherits and the lookup for B
    // FAILS → A's ids must not be present or selectable, and the pin must
    // not carry A's effort under B.
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'model-b' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    await waitFor(() => expect(h.rpc.calls).toHaveLength(3))
    h.rpc.settle(ok({ error: { tag: 'advisor/model-reasoning-failed', message: 'adapter down' } }))
    await waitFor(() => expect(h.controller.store.getSnapshot().reasoningStatus).toBe('unavailable'))
    view.rerender(<AdvisorSessionAction {...h.props} />)

    const select = screen.getByLabelText(en.sessionEffort) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([['', en.sessionEffortInherit]])
    expect(select.value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: en.sessionPinAction }))
    await waitFor(() => expect(h.rpc.calls).toHaveLength(4))
    const args = h.rpc.last().args as { selection: Record<string, unknown> }
    expect(args.selection).toEqual({ provider: 'deepseek', model: 'model-b' })
    expect(Object.hasOwn(args.selection, 'reasoningEffort')).toBe(false)
    h.rpc.settle(ok(SESSION_SNAPSHOT))
    await settled({ controller: h.controller })
  })

  it('clearing the staged model resets the effort back to inherit (no lookup for an empty model)', async () => {
    const h = harness(ok(SESSION_SNAPSHOT))
    const view = await openPanel(h)
    await stagePair(h, view)
    await waitFor(() => expect(h.rpc.calls).toHaveLength(2))
    h.rpc.settle(ok(EFFORTS))
    await waitFor(() => expect(h.controller.store.getSnapshot().reasoningStatus).toBe('ready'))
    view.rerender(<AdvisorSessionAction {...h.props} />)

    fireEvent.change(screen.getByLabelText(en.sessionEffort), { target: { value: 'high' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    expect((screen.getByLabelText(en.sessionEffort) as HTMLSelectElement).value).toBe('high')

    // Clearing the model re-inherits the effort and fires no new lookup.
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: '' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    expect((screen.getByLabelText(en.sessionEffort) as HTMLSelectElement).value).toBe('')
    expect(h.rpc.calls).toHaveLength(2)
  })

  it('pinning sends the chosen effort; inherit omits the reasoningEffort key', async () => {
    const h = harness(ok(SESSION_SNAPSHOT))
    const view = render(<AdvisorSessionAction {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok(SESSION_SNAPSHOT))
    await settled({ controller: h.controller })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    await stagePair(h, view)
    await waitFor(() => expect(h.rpc.calls).toHaveLength(2))
    h.rpc.settle(ok(EFFORTS))
    await waitFor(() => expect(h.controller.store.getSnapshot().reasoningStatus).toBe('ready'))
    view.rerender(<AdvisorSessionAction {...h.props} />)

    fireEvent.change(screen.getByLabelText(en.sessionEffort), { target: { value: 'high' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionPinAction }))
    await waitFor(() => expect(h.rpc.calls).toHaveLength(3))
    expect(h.rpc.last()).toEqual({
      channel: '/api',
      method: 'advisor/setSessionModel',
      args: { sessionId: 'sess-1', selection: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } },
    })
    // The committed pin reports the pinned effort with its origin.
    h.rpc.settle(ok({
      snapshot: {
        ...SESSION_SNAPSHOT.snapshot,
        modelOverride: { provider: 'deepseek', model: 'deepseek-chat' },
        modelSource: 'session' as const,
        reasoningEffortOverride: 'high',
        reasoningEffort: { source: 'configured', effective: 'high', origin: 'session' },
      },
    }))
    await settled({ controller: h.controller })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    expect(screen.getByRole('dialog').textContent).toContain('Effort: high (session override)')

    // Back to inherit → the selection carries NO reasoningEffort key at all
    // (the wire rejects present-as-undefined).
    fireEvent.change(screen.getByLabelText(en.sessionEffort), { target: { value: '' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionPinAction }))
    await waitFor(() => expect(h.rpc.calls).toHaveLength(4))
    const args = h.rpc.last().args as { selection: Record<string, unknown> }
    expect(args.selection).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(Object.hasOwn(args.selection, 'reasoningEffort')).toBe(false)
    h.rpc.settle(ok(SESSION_SNAPSHOT))
    await settled({ controller: h.controller })
  })

  it('a pinned effort pre-selects on the staged pair; re-pinning untouched re-sends it', async () => {
    const h = harness(ok(PINNED_HIGH))
    const view = render(<AdvisorSessionAction {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok(PINNED_HIGH))
    await settled({ controller: h.controller })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    // Open on a pinned session resolves the pinned model's declared efforts
    // (the pinned id must be a selectable option).
    await waitFor(() => expect(h.rpc.calls).toHaveLength(2))
    expect(h.rpc.last().method).toBe('advisor/modelReasoning')
    h.rpc.settle(ok(EFFORTS))
    await waitFor(() => expect(h.controller.store.getSnapshot().reasoningStatus).toBe('ready'))
    view.rerender(<AdvisorSessionAction {...h.props} />)

    // Re-select the same pair: the pinned effort pre-selects (the select
    // must NOT sit on Inherit global — that would silently drop the pin).
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'deepseek-chat' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    await waitFor(() => expect(h.rpc.calls).toHaveLength(3))
    h.rpc.settle(ok(EFFORTS))
    await waitFor(() => expect(h.controller.store.getSnapshot().reasoningStatus).toBe('ready'))
    view.rerender(<AdvisorSessionAction {...h.props} />)
    expect((screen.getByLabelText(en.sessionEffort) as HTMLSelectElement).value).toBe('high')

    // Pin WITHOUT touching the select → the selection carries the effort.
    fireEvent.click(screen.getByRole('button', { name: en.sessionPinAction }))
    await waitFor(() => expect(h.rpc.calls).toHaveLength(4))
    expect(h.rpc.last().args).toEqual({
      sessionId: 'sess-1',
      selection: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    })
    h.rpc.settle(ok(PINNED_HIGH))
    await settled({ controller: h.controller })
  })

  it('a user-edited effort is not overwritten when a refresh settles', async () => {
    const h = harness(ok(PINNED_HIGH))
    const view = render(<AdvisorSessionAction {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok(PINNED_HIGH))
    await settled({ controller: h.controller })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    await waitFor(() => expect(h.rpc.calls).toHaveLength(2))
    h.rpc.settle(ok(EFFORTS))
    await waitFor(() => expect(h.controller.store.getSnapshot().reasoningStatus).toBe('ready'))
    view.rerender(<AdvisorSessionAction {...h.props} />)
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'deepseek-chat' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    await waitFor(() => expect(h.rpc.calls).toHaveLength(3))
    h.rpc.settle(ok(EFFORTS))
    await waitFor(() => expect(h.controller.store.getSnapshot().reasoningStatus).toBe('ready'))
    view.rerender(<AdvisorSessionAction {...h.props} />)

    // The seed pre-selected 'high'; the user overrides it with 'low'.
    expect((screen.getByLabelText(en.sessionEffort) as HTMLSelectElement).value).toBe('high')
    fireEvent.change(screen.getByLabelText(en.sessionEffort), { target: { value: 'low' } })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    expect((screen.getByLabelText(en.sessionEffort) as HTMLSelectElement).value).toBe('low')

    // A refresh settles a snapshot that still pins 'high' — the user's
    // choice must survive (seeding never clobbers a user edit).
    const refresh = h.controller.refresh()
    await waitFor(() => expect(h.rpc.calls).toHaveLength(4))
    h.rpc.settle(ok(PINNED_HIGH))
    await refresh
    await settled({ controller: h.controller })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    expect((screen.getByLabelText(en.sessionEffort) as HTMLSelectElement).value).toBe('low')
  })

  it.each([
    [{ source: 'configured', effective: 'low' }, 'Effort: low (configured)'],
    [{ source: 'configured', effective: 'low', origin: 'global' }, 'Effort: low (global default)'],
    [{ source: 'configured', effective: 'low', origin: 'session' }, 'Effort: low (session override)'],
    [{ source: 'auto', effective: 'low' }, 'Effort: low (auto — smallest declared by deepseek/deepseek-chat)'],
    [{ source: 'fallback-undeclared', effective: 'low', configured: 'medium' }, 'Effort: low (fallback — "medium" is not declared by deepseek/deepseek-chat)'],
    [{ source: 'none' }, 'Effort: not sent — deepseek/deepseek-chat declares no reasoning efforts'],
    [{ source: 'pending' }, 'Effort: pending — resolved on the first review call'],
  ])('renders the effective-effort line for %o with the status wording', async (reasoningEffort, line) => {
    const snapshot = {
      snapshot: {
        sessionId: 'sess-1',
        enabled: true,
        lifetime: 'live-session' as const,
        modelSource: 'global' as const,
        effectiveModel: { provider: 'deepseek', model: 'deepseek-chat' },
        reasoningEffort,
      },
    }
    const h = harness(ok(snapshot))
    const view = render(<AdvisorSessionAction {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok(snapshot))
    await settled({ controller: h.controller })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    expect(screen.getByRole('dialog').textContent).toContain(line)
  })

  it('never invents an effort line when the snapshot carries none', async () => {
    // Effective pair but no recorded resolution → no Effort: line at all.
    const h = harness(ok(SESSION_SNAPSHOT))
    const view = render(<AdvisorSessionAction {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok(SESSION_SNAPSHOT))
    await settled({ controller: h.controller })
    view.rerender(<AdvisorSessionAction {...h.props} />)
    expect(screen.getByRole('dialog').textContent).not.toContain('Effort:')
    view.unmount()

    // Recorded resolution but no effective route (same gate as the status
    // surface: the line names the route) → still no line.
    const noRoute = {
      snapshot: {
        sessionId: 'sess-1',
        enabled: true,
        lifetime: 'live-session' as const,
        reasoningEffort: { source: 'configured', effective: 'low' },
      },
    }
    const h2 = harness(ok(noRoute))
    const view2 = render(<AdvisorSessionAction {...h2.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.sessionExpand }))
    await waitFor(() => expect(h2.rpc.calls).toHaveLength(1))
    h2.rpc.settle(ok(noRoute))
    await settled({ controller: h2.controller })
    view2.rerender(<AdvisorSessionAction {...h2.props} />)
    expect(screen.getByRole('dialog').textContent).not.toContain('Effort:')
  })
})
