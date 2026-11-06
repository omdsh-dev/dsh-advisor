// @vitest-environment jsdom
/**
 * Delivered-advice dock tip (`src/client/advice-tip.tsx`).
 *
 * Contract: a retained note renders under the composer with its severity; the
 * dismiss control hides it; and the turn boundary (the host clears the note)
 * resets that local dismissal so the SAME note re-delivered on a later turn is
 * visible again — the BUG-01 regression this test pins.
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

const NOTE = { severity: 'concern' as const, note: 'cap the retries' }

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

  it('resets the dismissal at the turn boundary so an identical note re-delivers visibly', () => {
    const { store, props } = harness()
    const view = render(<AdvisorAdviceTip {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.adviceDismiss }))
    expect(screen.queryByText(NOTE.note)).toBeNull()

    // The next human turn: the host clears its retained note (advice → null).
    store.update((s) => { s.advice = null })
    view.rerender(<AdvisorAdviceTip {...props} />)
    expect(screen.queryByText(NOTE.note)).toBeNull()

    // A later delivery of the identical note must be visible again.
    store.update((s) => { s.advice = { ...NOTE } })
    view.rerender(<AdvisorAdviceTip {...props} />)
    expect(screen.getByText(NOTE.note)).toBeTruthy()
  })
})
