/**
 * Delivered-advice dock tip (this change): the visible surface for the
 * reviewer's advice. The durable injected message is context-only in the
 * transcript, so without this row a delivered nit/concern/blocker had no
 * visible effect in the web UI. The tip shows the LAST delivered note under
 * the composer, with its severity, until the user dismisses it or a new human
 * turn starts (the host-side state clears on `onUserTurnStart`).
 *
 * Seat: the shell-declared `conversation.composer.dock` list slot — the same
 * sanctioned ambient row the next-prompt tip uses (a sibling of the composer
 * card, so it never overlaps the placeholder or attachments).
 *
 * Dismissal is per delivery, not per text: the server clears its retained note
 * on the next human turn (`delivery.clearLastNote`), and the tip must drop the
 * local dismissal at that same boundary — otherwise an identical note
 * re-delivered next turn would stay hidden. The poll runs unconditionally (not
 * only while `advice === null`) so the clear is observed in-page, without
 * waiting for a focus/reconnect signal.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ADVICE_IDLE_POLL_MS } from './advice-store.js'
import type { AdvisorAdviceController, AdvisorAdviceState } from './advice-store.js'
import styles from './advice-tip.module.css'

/** Per-binding injected dependencies of {@link AdvisorAdviceTip}. */
export interface AdvisorAdviceTipInjected {
  /** The session this occurrence is bound to (framework-resolved). */
  readonly sessionId: string
  /** The per-session advice controller (one per binding). */
  readonly controller: AdvisorAdviceController
  readonly hooks: {
    readonly snapshot: SnapshotStore<AdvisorAdviceState>
    readonly refreshSignal: SnapshotStore<{ epoch: number }>
  }
}

/** Props of the dock occupant: runtime seats, locale, and the injected face. */
export type AdvisorAdviceTipProps =
  PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'settings.advisor'>
  & InjectFace<AdvisorAdviceTipInjected>
  & SessionStandardProps

/** Identity of one note, so a dismissed note does not return on the next poll. */
function adviceKey(advice: { severity: string; note: string } | null): string | null {
  return advice === null ? null : `${advice.severity}\u0000${advice.note}`
}

/**
 * Render the last delivered advice as one ambient row under the composer.
 * @param props - slot-delivered injected dependencies and the synthesized seats.
 * @returns the advice tip, or nothing while no note waits (or after dismissal).
 */
export function AdvisorAdviceTip(props: AdvisorAdviceTipProps): ReactNode {
  const { controller, useSnapshot, useRefreshSignal, t } = props
  const state = useSnapshot((s) => s)
  const epoch = useRefreshSignal((s) => s.epoch)
  const advice = state.advice
  const key = adviceKey(advice)
  const [dismissed, setDismissed] = useState<string | null>(null)

  // Mount/focus/reconnect fetch, idempotent per epoch.
  useEffect(() => {
    if (controller.takeSignal(epoch)) void controller.fetch()
  }, [controller, epoch])

  // Poll on the shared cadence whether or not a note is shown: the server
  // clears the note on the next human turn, and only a refetch can observe it.
  useEffect(() => {
    const timer = window.setInterval(() => { void controller.fetch() }, ADVICE_IDLE_POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [controller])

  // Turn boundary: the host cleared its retained note, so the local dismissal
  // no longer applies. Without this reset, dismissing a note once would hide
  // every identical note re-delivered after a later turn.
  useEffect(() => {
    if (advice === null) setDismissed(null)
  }, [advice])

  if (advice === null || key === dismissed) return null
  return (
    <div className={styles.tip} data-advisor-advice="" data-severity={advice.severity} role="status" aria-live="polite">
      <span className={styles.glyph} aria-hidden="true">◆</span>
      <span className={styles.prefix}>{t('advicePrefix')}:</span>
      <span className={styles.severity}>{advice.severity}</span>
      <span className={styles.text}>{advice.note}</span>
      <button
        type="button"
        className={styles.dismiss}
        aria-label={t('adviceDismiss')}
        title={t('adviceDismiss')}
        onClick={() => { setDismissed(key) }}
      >
        ×
      </button>
    </div>
  )
}
