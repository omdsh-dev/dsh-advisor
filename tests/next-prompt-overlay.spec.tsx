// @vitest-environment jsdom
/**
 * Next-prompt suggestion dock tip (plan dsh-advisor-next-prompt-n12 task 3;
 * dock-tip rework plan dsh-advisor-next-prompt-e2e-n13) — component behavior
 * over a scripted wire face, mirroring the advisor-session-action spec
 * (preloaded stores + @testing-library/react; the dev-time
 * `bindSnapshotSelector` stand-in reads the current snapshot per render, so
 * assertions after a store mutation re-render explicitly).
 *
 * The occupant registers into the shell-declared `conversation.composer.dock`
 * list slot, which the host renders inside `div[data-composer-dock]` — a
 * SIBLING of `div[data-composer-card]`, below the card — so the tests mount
 * that real geometry (card and tip side by side). The card marker is the
 * fill-target boundary: a keydown whose target sits inside the composer card
 * is the composer's own editor (the fill target); an
 * input/textarea/contenteditable elsewhere keeps native semantics.
 *
 * Contract under test (brief behavior contract, one case per bullet):
 * ① render gate: tip renders ONLY when suggestion !== null && draft === ''
 *    && phase === 'plain'; otherwise nothing renders, and a fill attempt
 *    intercepts nothing (the fill handler re-validates this gate — see ③).
 * ② tip presentation: the localized prefix, the suggestion text, and the
 *    accept control render on one row (the ✦ glyph is presentational). The
 *    row is a `role="status"` live region (aria-live polite), so the
 *    suggestion's arrival is announced without focus.
 * ③ ArrowRight fill: a document-level capture-phase keydown intercepts ONLY
 *    a bare ArrowRight (no modifiers) whose target is the no-focus surface
 *    (document/body — nothing focused) or inside the composer card; a
 *    focused element elsewhere (tree node, button, editable) keeps native
 *    semantics. The render gate is re-validated INSIDE the handler against
 *    the latest input snapshot (the commit→passive-effect window must not
 *    fill over user-typed text). On intercept: preventDefault +
 *    inputActions.setDraft(suggestion).
 * ④ fill clears local state optimistically (suggestion → null) so the tip
 *    disappears the moment the draft fills.
 * ⑤ fetch points: mount; every consumed refresh-signal epoch bump; and the
 *    30 s idle poll that runs ONLY while idle (fake-timer case proves the
 *    timer is cleared when a suggestion arrives).
 * ⑥ failure: transport/business failure → status 'unavailable', renders
 *    nothing, no retry storm — the next signal (or scheduled poll) is the
 *    next attempt. A contract-violating PRIMITIVE payload settles
 *    `unavailable` the same way (never an unhandled TypeError — round 2).
 * ⑦ row click-to-fill (dock-tip rework): clicking ANYWHERE on the tip row
 *    routes through the SAME gated fill path as ArrowRight —
 *    setDraft(suggestion) + optimistic clear; once the render gate is
 *    violated (non-empty draft) the row is gone and a click is a no-op
 *    (no fill, nothing consumed).
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConnectionRpc, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ADVICE_TIP_MS, ComposerDockTip } from '../src/client/composer-dock-tip'
import type { ComposerDockTipProps } from '../src/client/composer-dock-tip'
import styles from '../src/client/next-prompt.module.css'
import { AdvisorSuggestionController, NEXT_PROMPT_IDLE_POLL_MS } from '../src/client/next-prompt-store'
import { AdvisorAdviceController } from '../src/client/advice-store'
import { en } from '../src/client/locales'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/**
 * Dev-time stand-in for the renderer's hooks binding (see the session-action
 * spec header note): a selector hook reading the current snapshot per render.
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
}) as ComposerDockTipProps['t']

function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

/**
 * One scripted RPC for the `/api/advisor/suggestion` channel. `auto` mode
 * resolves every call with the current `reply` immediately (the fake-timer
 * poll case); the default parks each call until `settle` (the component
 * cases), mirroring the session-action spec's ScriptedRpc.
 */
class SuggestionRpc {
  calls: Array<{ channel: string; method: string; args: unknown }> = []
  reply: RpcResult<unknown> = ok({ suggestion: null })
  auto = false
  private resolvers: Array<(result: RpcResult<unknown>) => void> = []

  call(channel: string, method: string, payload: { args: unknown }): Promise<RpcResult<unknown>> {
    this.calls.push({ channel, method, args: payload.args })
    if (this.auto) return Promise.resolve(this.reply)
    return new Promise((resolve) => { this.resolvers.push(resolve) })
  }

  settle(result: RpcResult<unknown>): void {
    this.resolvers.shift()!(result)
  }

  last(): { channel: string; method: string; args: unknown } {
    return this.calls[this.calls.length - 1]!
  }
}

/** The per-session input state the composer's SessionStandardProps publish. */
interface TestInputState {
  draft: string
  phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
}

interface Harness {
  rpc: SuggestionRpc
  adviceRpc: SuggestionRpc
  epoch: ReturnType<typeof createSnapshotStore<{ epoch: number }>>
  input: ReturnType<typeof createSnapshotStore<TestInputState>>
  controller: AdvisorSuggestionController
  adviceController: AdvisorAdviceController
  setDraft: ReturnType<typeof vi.fn>
  props: ComposerDockTipProps
}

function harness(): Harness {
  const rpc = new SuggestionRpc()
  const adviceRpc = new SuggestionRpc()
  adviceRpc.auto = true
  adviceRpc.reply = ok({ advice: null })
  const controller = new AdvisorSuggestionController('sess-1', rpc as unknown as ClientConnectionRpc)
  const adviceController = new AdvisorAdviceController('sess-1', adviceRpc as unknown as ClientConnectionRpc)
  const epoch = createSnapshotStore<{ epoch: number }>({ epoch: 0 })
  const input = createSnapshotStore<TestInputState>({ draft: '', phase: 'plain' })
  const setDraft = vi.fn()
  const props = {
    sessionId: 'sess-1',
    suggestionController: controller,
    adviceController,
    useSnapshot: bindSnapshotSelector(controller.store),
    useAdviceSnapshot: bindSnapshotSelector(adviceController.store),
    useRefreshSignal: bindSnapshotSelector(epoch),
    useInput: bindSnapshotSelector(input),
    // The composer's public input actions; only setDraft is read.
    inputActions: { setDraft } as never,
    // The conversation/global standard seats are never read — never-called
    // stubs (the session-action spec stub pattern).
    useConversation: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
    t,
  } as ComposerDockTipProps
  return { rpc, adviceRpc, epoch, input, controller, adviceController, setDraft, props }
}

/**
 * The real dock geometry: the composer card (`div[data-composer-card]`,
 * optionally holding the editor / other card content) and the dock container
 * (`div[data-composer-dock]`) as siblings — the tip renders BELOW the card,
 * outside it.
 */
function ComposerStack(props: { card?: React.ReactNode; children: React.ReactNode }): React.ReactNode {
  return (
    <div>
      <div data-composer-card="true">{props.card}</div>
      <div data-composer-dock="true">{props.children}</div>
    </div>
  )
}

const SUGGESTION = 'Try the /advisor command'

/** Render + settle one suggestion so the tip is on screen (cases ①–④). */
async function mountWithSuggestion(h: Harness): Promise<ReturnType<typeof render>> {
  const view = render(
    <ComposerStack>
      <ComposerDockTip {...h.props} />
    </ComposerStack>,
  )
  await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
  h.rpc.settle(ok({ suggestion: SUGGESTION }))
  await waitFor(() => expect(h.controller.store.getSnapshot().status).toBe('ready'))
  view.rerender(
    <ComposerStack>
      <ComposerDockTip {...h.props} />
    </ComposerStack>,
  )
  return view
}

describe('next-prompt dock tip (plan dsh-advisor-next-prompt-n12, task 3; dock-tip rework e2e-n13)', () => {
  it('fetches the suggestion and the advice on mount', async () => {
    const h = harness()
    render(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    expect(h.rpc.last()).toEqual({
      channel: '/api',
      method: 'advisor/suggestion',
      args: { sessionId: 'sess-1' },
    })
    await waitFor(() => expect(h.adviceRpc.calls).toHaveLength(1))
    expect(h.adviceRpc.last()).toEqual({
      channel: '/api',
      method: 'advisor/advice',
      args: { sessionId: 'sess-1' },
    })
  })

  it('renders the prefix, the suggestion text, and the accept control when a suggestion waits on an empty plain draft', async () => {
    const h = harness()
    await mountWithSuggestion(h)
    // Row copy: localized prefix + colon, the suggestion, the accept
    // affordance — one line under the card.
    expect(screen.getByText(`${en.nextPromptPrefix}:`)).toBeTruthy()
    expect(screen.getByText(SUGGESTION)).toBeTruthy()
    expect(screen.getByText(en.nextPromptAccept)).toBeTruthy()
    // The leading glyph is presentational (aria-hidden) — the live region's
    // text is the announcement, the glyph is decoration.
    expect(screen.getByText('✦').getAttribute('aria-hidden')).toBe('true')
    // The tip ROW is the live region: the suggestion is announced politely
    // when it arrives, without ever taking focus.
    const live = screen.getByRole('status')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toContain(SUGGESTION)
  })

  it('carries the tip module class on the visible tip row', async () => {
    const h = harness()
    const view = await mountWithSuggestion(h)
    // The one-line tip is styled by next-prompt.module.css on the ROW, so
    // the element on screen must actually carry that module class — only
    // then do the flex layout, ellipsis, and hover styles apply.
    expect(typeof styles.tip).toBe('string')
    expect(screen.getByRole('status').className).toContain(styles.tip)
    // The CSS gate that confines the dock stretch to THIS dock keys on the
    // marker attribute, so the visible tip row must actually carry it.
    expect(screen.getByRole('status').hasAttribute('data-advisor-tip')).toBe(true)
    // Gate-bound: once the render gate breaks, no row exists to carry it.
    h.input.update((s) => { s.draft = 'typed' })
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders nothing while the draft is non-empty or the phase is not plain, and intercepts nothing', async () => {
    const h = harness()
    const view = await mountWithSuggestion(h)

    // A non-empty draft: no tip, and the keydown listener is unmounted —
    // a bare ArrowRight keeps its native semantics (nothing prevented).
    h.input.update((s) => { s.draft = 'partial' })
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(screen.queryByText(SUGGESTION)).toBeNull()
    expect(fireEvent.keyDown(document, { key: 'ArrowRight' })).toBe(true)
    expect(h.setDraft).not.toHaveBeenCalled()

    // Back to an empty draft but a claimed phase: still no tip.
    h.input.update((s) => { s.draft = ''; s.phase = 'claimed' })
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(screen.queryByText(SUGGESTION)).toBeNull()
    expect(fireEvent.keyDown(document, { key: 'ArrowRight' })).toBe(true)
    expect(h.setDraft).not.toHaveBeenCalled()
  })

  it('fills the draft on a bare ArrowRight and clears the suggestion optimistically', async () => {
    const h = harness()
    const view = await mountWithSuggestion(h)

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(h.setDraft).toHaveBeenCalledTimes(1)
    expect(h.setDraft).toHaveBeenCalledWith(SUGGESTION)
    expect(event.defaultPrevented).toBe(true)
    // The optimistic clear: the store suggestion is null immediately, so the
    // tip disappears the moment the draft fills (no tip on the next render).
    await waitFor(() => expect(h.controller.store.getSnapshot().suggestion).toBeNull())
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(screen.queryByText(SUGGESTION)).toBeNull()
  })

  it('fills the draft when the tip row is clicked and clears the suggestion optimistically', async () => {
    const h = harness()
    const view = await mountWithSuggestion(h)

    // Row click-to-fill (⑦): a click ANYWHERE on the row routes through the
    // SAME gated fill path as ArrowRight — setDraft(suggestion), then the
    // optimistic clear. Click on the row itself (not a nested control — the
    // accept control is a passive affordance).
    fireEvent.click(screen.getByRole('status'))
    expect(h.setDraft).toHaveBeenCalledTimes(1)
    expect(h.setDraft).toHaveBeenCalledWith(SUGGESTION)
    await waitFor(() => expect(h.controller.store.getSnapshot().suggestion).toBeNull())
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(screen.queryByText(SUGGESTION)).toBeNull()
  })

  it('makes a click a no-op once the render gate is violated (the tip is gone)', async () => {
    const h = harness()
    const view = await mountWithSuggestion(h)

    // The gate breaks (the user typed): the row leaves the DOM with it, so
    // the click surface no longer exists. Any click landing where the tip
    // used to be — or on the composer card — is a plain no-op: no fill,
    // nothing consumed (⑦ violated-gate case; a click carries no
    // preventDefault contract).
    h.input.update((s) => { s.draft = 'user-typed' })
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(view.container.querySelector('[data-composer-card]')!)
    expect(h.setDraft).not.toHaveBeenCalled()
    expect(h.controller.store.getSnapshot().suggestion).toBe(SUGGESTION)
  })

  it('keeps native semantics for modifier keys, other keys, and editables outside the composer card', async () => {
    const h = harness()
    await mountWithSuggestion(h)

    // Any modifier keeps the native browser behavior (no prevent, no fill).
    for (const mods of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true, ...mods })
      document.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    // Other keys are never intercepted.
    const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
    document.dispatchEvent(left)
    expect(left.defaultPrevented).toBe(false)
    expect(h.setDraft).not.toHaveBeenCalled()

    // A focused editable OUTSIDE the composer card keeps native semantics:
    // pressing ArrowRight there fills nothing.
    render(<div contentEditable data-testid="elsewhere" />)
    expect(fireEvent.keyDown(screen.getByTestId('elsewhere'), { key: 'ArrowRight' })).toBe(true)
    expect(h.setDraft).not.toHaveBeenCalled()
  })

  it('keeps native ArrowRight on a focused button outside the card, and still fills for a target inside it', async () => {
    const h = harness()
    const view = render(
      <ComposerStack card={<button data-testid="card-button" />}>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok({ suggestion: SUGGESTION }))
    await waitFor(() => expect(h.controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(
      <ComposerStack card={<button data-testid="card-button" />}>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )

    // A focused plain button OUTSIDE the card keeps its native ArrowRight
    // semantics (tree nodes / menus / buttons navigate): no preventDefault,
    // no fill (qc2 F-001 counter-case).
    render(<button data-testid="elsewhere-button" />)
    const outside = screen.getByTestId('elsewhere-button')
    outside.focus()
    expect(document.activeElement).toBe(outside)
    expect(fireEvent.keyDown(outside, { key: 'ArrowRight' })).toBe(true)
    expect(h.setDraft).not.toHaveBeenCalled()

    // The SAME kind of focused target INSIDE the card is the composer's own
    // surface: intercepted exactly as before (qc2 F-001 counter-case pair).
    const inside = screen.getByTestId('card-button')
    inside.focus()
    expect(fireEvent.keyDown(inside, { key: 'ArrowRight' })).toBe(false)
    expect(h.setDraft).toHaveBeenCalledTimes(1)
    expect(h.setDraft).toHaveBeenCalledWith(SUGGESTION)
  })

  it('re-validates the render gate at handler time: a draft that just became non-empty passes ArrowRight through natively', async () => {
    const h = harness()
    const view = await mountWithSuggestion(h)

    // The stale window (qc2 F-002): the fill listener is mounted, and the
    // input snapshot has moved on (the user typed) while the effect teardown
    // trails the commit. The handler must re-read the CURRENT snapshot and
    // pass the key through — no preventDefault, no fill, nothing consumed.
    h.input.update((s) => { s.draft = 'user-typed' })
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(screen.queryByText(SUGGESTION)).toBeNull()
    const stale = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    document.dispatchEvent(stale)
    expect(stale.defaultPrevented).toBe(false)
    expect(h.setDraft).not.toHaveBeenCalled()
    expect(h.controller.store.getSnapshot().suggestion).toBe(SUGGESTION)

    // Gate restored: the SAME still-mounted listener fills again — the skip
    // above came from the re-validated gate, not from a missing listener.
    h.input.update((s) => { s.draft = '' })
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    const fill = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    document.dispatchEvent(fill)
    expect(fill.defaultPrevented).toBe(true)
    expect(h.setDraft).toHaveBeenCalledWith(SUGGESTION)
  })

  it('treats the composer card editor as the fill target (a keydown inside the card intercepts)', async () => {
    const h = harness()
    // The editor element sits INSIDE the composer card while the tip renders
    // in the dock BELOW it — exactly where the host mounts them.
    const view = render(
      <ComposerStack card={<div contentEditable data-testid="editor" />}>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok({ suggestion: SUGGESTION }))
    await waitFor(() => expect(h.controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(
      <ComposerStack card={<div contentEditable data-testid="editor" />}>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(fireEvent.keyDown(screen.getByTestId('editor'), { key: 'ArrowRight' })).toBe(false)
    expect(h.setDraft).toHaveBeenCalledTimes(1)
    expect(h.setDraft).toHaveBeenCalledWith(SUGGESTION)
  })

  it('refetches on every consumed refresh-signal epoch bump, idempotently per epoch', async () => {
    const h = harness()
    const view = render(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok({ suggestion: null }))
    await waitFor(() => expect(h.controller.store.getSnapshot().status).toBe('ready'))

    // Rerenders without a bump never refetch (the epoch is consumed once).
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(h.rpc.calls).toHaveLength(1)

    // The bump (connection reset / window focus ride the shared plane) →
    // exactly one new fetch for the new epoch.
    h.epoch.update((s) => { s.epoch += 1 })
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(2))
    expect(h.rpc.last().method).toBe('advisor/suggestion')
  })

  it('polls at the idle interval only while idle and stops once a suggestion arrives', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.rpc.auto = true
    const view = render(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    // Mount fetch flushed (advanceTimersByTimeAsync awaits the settled
    // microtasks — testing-library's waitFor never runs under fake timers).
    await vi.advanceTimersByTimeAsync(0)
    expect(h.controller.store.getSnapshot().status).toBe('ready')
    expect(h.rpc.calls).toHaveLength(1)

    // Idle (suggestion null + empty draft + plain phase): the 30 s poll runs.
    await vi.advanceTimersByTimeAsync(NEXT_PROMPT_IDLE_POLL_MS)
    expect(h.rpc.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(NEXT_PROMPT_IDLE_POLL_MS)
    expect(h.rpc.calls).toHaveLength(3)

    // The next poll's reply carries a suggestion: the tip appears and the
    // poll timer is CLEARED — no further ticks while the suggestion waits.
    h.rpc.reply = ok({ suggestion: SUGGESTION })
    await vi.advanceTimersByTimeAsync(NEXT_PROMPT_IDLE_POLL_MS)
    expect(h.controller.store.getSnapshot().suggestion).toBe(SUGGESTION)
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(h.rpc.calls).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(NEXT_PROMPT_IDLE_POLL_MS * 2)
    expect(h.rpc.calls).toHaveLength(4)
  })

  it('maps a failure to unavailable: renders nothing with no retry storm until the next signal', async () => {
    const h = harness()
    const view = render(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok({ error: { tag: 'advisor/unavailable', message: 'no suggestion face on this host' } }))
    await waitFor(() => expect(h.controller.store.getSnapshot().status).toBe('unavailable'))
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    // Nothing renders for an unavailable surface.
    expect(view.container.textContent).toBe('')
    // The keydown listener is unmounted too: a bare ArrowRight is native.
    expect(fireEvent.keyDown(document, { key: 'ArrowRight' })).toBe(true)
    expect(h.setDraft).not.toHaveBeenCalled()

    // No retry storm: rerenders (and the settled failure itself) never
    // trigger a new fetch — only the next consumed signal does.
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(h.rpc.calls).toHaveLength(1)
    h.epoch.update((s) => { s.epoch += 1 })
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(2))
  })

  it('settles a contract-violating primitive payload to unavailable (no unhandled TypeError)', async () => {
    // Round 2: a primitive `result.value` (a broken peer) must take the SAME
    // malformed-payload path as every other failure shape — the shape check
    // guards with typeof/null instead of throwing on `'suggestion' in x`.
    const h = harness()
    render(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok(42 as unknown))
    await waitFor(() => expect(h.controller.store.getSnapshot().status).toBe('unavailable'))
    expect(h.controller.store.getSnapshot().suggestion).toBeNull()
  })
})


describe('composer dock tip: one-row advice/suggestion arbitration', () => {
  const NOTE = 'cap the retries'

  /** Put one delivered note into the advice store (as the poll/face would). */
  function deliver(h: Harness, deliveryId: number, note = NOTE): void {
    h.adviceController.store.update((s) => {
      s.status = 'ready'
      s.advice = { severity: 'concern', note, deliveryId }
    })
  }

  async function mount(h: Harness): Promise<ReturnType<typeof render>> {
    const view = render(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    await waitFor(() => expect(h.adviceController.store.getSnapshot().status).toBe('ready'))
    return view
  }

  it('shows a fresh advice note for 2 s and then drops the row', async () => {
    const h = harness()
    const view = await mount(h)
    vi.useFakeTimers()
    deliver(h, 1)
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(screen.getByText(NOTE)).toBeTruthy()
    act(() => { vi.advanceTimersByTime(ADVICE_TIP_MS - 1) })
    expect(screen.getByText(NOTE)).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  it('never renders both rows: the advice flash takes the row, then the suggestion returns', async () => {
    const h = harness()
    const view = await mountWithSuggestion(h)
    await waitFor(() => expect(h.adviceController.store.getSnapshot().status).toBe('ready'))
    vi.useFakeTimers()
    deliver(h, 1)
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(screen.getByText(NOTE)).toBeTruthy()
    expect(screen.queryByText(SUGGESTION)).toBeNull()
    act(() => { vi.advanceTimersByTime(ADVICE_TIP_MS) })
    expect(screen.getByText(SUGGESTION)).toBeTruthy()
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  it('does not fill from an invisible suggestion while the advice note occupies the row', async () => {
    const h = harness()
    const view = await mountWithSuggestion(h)
    await waitFor(() => expect(h.adviceController.store.getSnapshot().status).toBe('ready'))
    vi.useFakeTimers()
    deliver(h, 1)
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(screen.getByText(NOTE)).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(h.setDraft).not.toHaveBeenCalled()

    // Once the flash yields the row back, the suggestion is visible again and
    // the same gesture fills normally.
    act(() => { vi.advanceTimersByTime(ADVICE_TIP_MS) })
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(h.setDraft).toHaveBeenCalledWith(SUGGESTION)
  })

  it('re-flashes a NEW delivery id, and the same id stays dismissed', async () => {
    const h = harness()
    const view = await mount(h)
    const rerender = (): void => {
      view.rerender(
        <ComposerStack>
          <ComposerDockTip {...h.props} />
        </ComposerStack>,
      )
    }
    vi.useFakeTimers()
    deliver(h, 1)
    rerender()
    expect(screen.getByText(NOTE)).toBeTruthy()
    act(() => { vi.advanceTimersByTime(ADVICE_TIP_MS) })
    expect(screen.queryByText(NOTE)).toBeNull()

    // Same id on a later render (a new store object from the poll) stays hidden.
    rerender()
    expect(screen.queryByText(NOTE)).toBeNull()

    // A new delivery id flashes again.
    deliver(h, 2)
    rerender()
    expect(screen.getByText(NOTE)).toBeTruthy()
  })

  it('dismiss hides the advice flash immediately and lets the suggestion take the row', async () => {
    const h = harness()
    const view = await mountWithSuggestion(h)
    await waitFor(() => expect(h.adviceController.store.getSnapshot().status).toBe('ready'))
    deliver(h, 1)
    view.rerender(
      <ComposerStack>
        <ComposerDockTip {...h.props} />
      </ComposerStack>,
    )
    expect(screen.getByText(NOTE)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.adviceDismiss }))
    expect(screen.queryByText(NOTE)).toBeNull()
    expect(screen.getByText(SUGGESTION)).toBeTruthy()
  })
})
