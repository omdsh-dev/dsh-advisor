// @vitest-environment jsdom
/**
 * Delivered-advice dock tip (`src/client/advice-tip.tsx`).
 *
 * Contract: a retained note renders under the composer with its severity; the
 * dismiss control hides it; and dismissal is keyed on the delivery id, so the
 * SAME text re-delivered on a later turn is visible again even when the client
 * never observed the inter-turn `null` window — the BUG-01 regression this
 * test pins (the review's per-delivery-epoch alternative).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AdvisorAdviceTip, type AdvisorAdviceTipProps } from '../src/client/advice-tip'
import type { AdvisorAdviceController, AdvisorAdviceState } from '../src/client/advice-store'
import { en } from '../src/client/locales'

afterEach(cleanup)

/** Dev-time stand-in for the renderer's hook binding (see the session-action spec). */
function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> {
  return (sel) => sel(w.getSnapshot())
}

const t = ((key: string): string => en[key as keyof typeof en] ?? key) as AdvisorAdviceTipProps['t']

const NOTE = { severity: 'concern' as const, note: 'cap the retries', deliveryId: 1 }

function harness(): {
  store: ReturnType<typeof createSnapshotStore<AdvisorAdviceState>>
  props: AdvisorAdviceTipProps
} {
  const store = createSnapshotStore<AdvisorAdviceState>({ status: 'ready', advice: { ...NOTE } })
  const epoch = createSnapshotStore<{ epoch: number }>({ epoch: 0 })
  const controller = { takeSignal: () => false, fetch: vi.fn(async () => {}) } as unknown as AdvisorAdviceController
  const props = {
    sessionId: 'sess-1',
    controller,
    useSnapshot: bindSnapshotSelector(store),
    useRefreshSignal: bindSnapshotSelector(epoch),
    t,
  } as AdvisorAdviceTipProps
  return { store, props }
}

describe('AdvisorAdviceTip', () => {
  it('renders the note with its severity and clears it on dismiss', () => {
    const { props } = harness()
    render(<AdvisorAdviceTip {...props} />)
    expect(screen.getByText('Advisor:')).toBeTruthy()
    expect(screen.getByText('concern')).toBeTruthy()
    expect(screen.getByText(NOTE.note)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.adviceDismiss }))
    expect(screen.queryByText(NOTE.note)).toBeNull()
  })

  it('renders an identical note again on a NEW delivery id, even without observing the null window', () => {
    const { store, props } = harness()
    const view = render(<AdvisorAdviceTip {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.adviceDismiss }))
    expect(screen.queryByText(NOTE.note)).toBeNull()

    // The poll misses the turn-boundary clear: the store goes straight from the
    // dismissed delivery to the same text under a NEW delivery id.
    store.update((s) => { s.advice = { ...NOTE, deliveryId: 2 } })
    view.rerender(<AdvisorAdviceTip {...props} />)
    expect(screen.getByText(NOTE.note)).toBeTruthy()

    // The same delivery id stays dismissed (no resurrection within one delivery).
    fireEvent.click(screen.getByRole('button', { name: en.adviceDismiss }))
    view.rerender(<AdvisorAdviceTip {...props} />)
    expect(screen.queryByText(NOTE.note)).toBeNull()
  })
})
