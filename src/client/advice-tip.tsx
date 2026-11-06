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
 * Dismissal is keyed on the server's per-delivery id, not on severity+text:
 * the same review outcome re-delivered on a later turn must render again even
 * when the client poll never observed the inter-turn `null` window. The poll
 * runs unconditionally (not only while `advice === null`) so newer deliveries
 * and turn-boundary clears are observed in-page, without waiting for a
 * focus/reconnect signal.
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
  const [dismissed, setDismissed] = useState<number | null>(null)

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

  if (advice === null || advice.deliveryId === dismissed) return null
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
        onClick={() => { setDismissed(advice.deliveryId) }}
      >
        ×
      </button>
    </div>
  )
}
