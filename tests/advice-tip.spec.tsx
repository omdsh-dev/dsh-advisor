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

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AdvisorAdviceTip, type AdvisorAdviceTipProps } from '../src/client/advice-tip'
import { ADVICE_IDLE_POLL_MS, type AdvisorAdviceController, type AdvisorAdviceState } from '../src/client/advice-store'
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
  epoch: ReturnType<typeof createSnapshotStore<{ epoch: number }>>
  controller: { takeSignal: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> }
  props: AdvisorAdviceTipProps
} {
  const store = createSnapshotStore<AdvisorAdviceState>({ status: 'ready', advice: { ...NOTE } })
  const epoch = createSnapshotStore<{ epoch: number }>({ epoch: 0 })
  const controller = { takeSignal: vi.fn((): boolean => true), fetch: vi.fn(async () => {}) }
  const props = {
    sessionId: 'sess-1',
    controller: controller as unknown as AdvisorAdviceController,
    useSnapshot: bindSnapshotSelector(store),
    useRefreshSignal: bindSnapshotSelector(epoch),
    t,
  } as AdvisorAdviceTipProps
  return { store, epoch, controller, props }
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

  it('fetches on mount and again on a refresh-signal epoch bump', async () => {
    const { props, epoch, controller } = harness()
    const view = render(<AdvisorAdviceTip {...props} />)
    await waitFor(() => expect(controller.fetch).toHaveBeenCalledTimes(1))
    epoch.update((s) => { s.epoch += 1 })
    view.rerender(<AdvisorAdviceTip {...props} />)
    await waitFor(() => expect(controller.fetch).toHaveBeenCalledTimes(2))
  })

  it('polls on the shared cadence even while a note is shown', () => {
    vi.useFakeTimers()
    try {
      const { props, controller } = harness()
      render(<AdvisorAdviceTip {...props} />)
      expect(controller.fetch).toHaveBeenCalledTimes(1) // mount fetch
      act(() => { vi.advanceTimersByTime(ADVICE_IDLE_POLL_MS) })
      expect(controller.fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
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
