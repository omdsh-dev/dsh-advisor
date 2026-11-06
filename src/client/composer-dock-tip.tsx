/**
 * Next-prompt suggestion dock tip (plan dsh-advisor-next-prompt-n12 task 3;
 * reworked into the dock-tip form by plan dsh-advisor-next-prompt-e2e-n13):
 * the occupant registered into the shell-declared `conversation.composer.dock`
 * list slot — the host's sanctioned ambient seat BELOW the composer card
 * (`div[data-composer-dock]`, a sibling of `div[data-composer-card]`). The
 * previous in-composer overlay form fought the host composer (placeholder
 * stacking, attachment overlap, edge fusion); the tip form has zero overlap
 * with any composer geometry. Pressing ArrowRight still fills the draft.
 *
 * Render gate: the tip renders ONLY while a suggestion waits
 * (`suggestion !== null`) on an EMPTY draft (`draft === ''`) in the plain
 * phase (`phase === 'plain'`). Any other state renders nothing.
 *
 * Fill contract: two accept gestures share one gated fill path — a
 * document-level CAPTURE-phase keydown intercepts ONLY a bare ArrowRight
 * (alt/ctrl/meta/shift all false) whose target is the
 * no-focus surface (document/body/html — nothing focused) or inside the
 * composer card (the composer's own editor lives inside
 * `div[data-composer-card]`; the tip sits OUTSIDE the card now, so the card
 * is located in the document rather than via the component's own root), and
 * a click ANYWHERE on the tip row fills identically. Any FOCUSED element
 * elsewhere — tree nodes, buttons, menus, editables — keeps native
 * ArrowRight semantics (qc2 F-001). The render gate itself is re-validated
 * INSIDE the shared fill path at event time against the latest render's
 * input snapshot: in the
 * React commit→passive-effect window a non-empty draft (or a moved phase)
 * passes through natively, no preventDefault, no fill — the listener that
 * is still mounted cannot replace user-typed text (qc2 F-002). On
 * intercept: `preventDefault()` (keydown only), then
 * `inputActions.setDraft(suggestion)`,
 * then the optimistic local clear (suggestion → null) so the tip
 * disappears the moment the draft fills.
 *
 * Fetch discipline: fetch on mount, on every consumed refresh-signal epoch
 * bump (connection/reset + window focus ride the plugin's shared debounced
 * plane), and through an idle poll (`NEXT_PROMPT_IDLE_POLL_MS`) that runs
 * ONLY while the surface is idle (no suggestion, empty draft, plain phase)
 * and stops otherwise. Every response settles through the controller's
 * request fence; a failure latches `unavailable` (renders nothing, no
 * retry storm — the next signal or scheduled poll is the next attempt).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { NEXT_PROMPT_IDLE_POLL_MS } from './next-prompt-store.ts'
import type { AdvisorSuggestionController, AdvisorSuggestionState } from './next-prompt-store.ts'
import { ADVICE_IDLE_POLL_MS } from './advice-store.ts'
import type { AdvisorAdviceController, AdvisorAdviceState } from './advice-store.ts'
import styles from './next-prompt.module.css'

/** How long a freshly delivered advisor note occupies the single dock row. */
export const ADVICE_TIP_MS = 2_000

/**
 * Injected dependencies of {@link ComposerDockTip} (slot `inject`, built
 * per session binding by the registration's inject factory). The `hooks`
 * compartment carries the bare snapshot sources; the renderer binds each as
 * a `use<Name>` selector hook the component consumes.
 */
export interface ComposerDockTipInjected {
  /** The session this occurrence is bound to (framework-resolved). */
  readonly sessionId: string
  /** The per-session suggestion controller (one per binding). */
  readonly suggestionController: AdvisorSuggestionController
  /** The per-session delivered-advice controller (one per binding). */
  readonly adviceController: AdvisorAdviceController
  /** Bare snapshot sources the renderer binds as selector hooks. */
  readonly hooks: {
    /** The per-session suggestion snapshot. */
    readonly snapshot: SnapshotStore<AdvisorSuggestionState>
    /** The per-session delivered-advice snapshot. */
    readonly adviceSnapshot: SnapshotStore<AdvisorAdviceState>
    /** Refresh-signal epoch (bumped on connection reset / window focus). */
    readonly refreshSignal: SnapshotStore<{ epoch: number }>
  }
}

/**
 * Props the renderer binds for the dock tip: the session-scoped runtime share
 * (whose SessionStandardProps supply the input machine's draft/phase state
 * and the public `inputActions.setDraft` fill verb), the
 * framework-synthesized `t` seat for the declared `settings.advisor`
 * namespace, and the registrant's per-binding business face.
 */
export type ComposerDockTipProps =
  PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'settings.advisor'>
  & InjectFace<ComposerDockTipInjected>
  & SessionStandardProps

/**
 * Whether one keydown event is the fill trigger: a bare ArrowRight (no
 * modifiers) whose target sits in the NO-FOCUS surface or inside the
 * composer card. The card boundary is resolved in the DOCUMENT — the tip
 * lives in the dock BELOW the card (a `div[data-composer-dock]` sibling), so
 * unlike the overlay form the component's own root can no longer anchor the
 * `closest` walk. The resident composer's card is unique per conversation
 * view, so one document lookup finds it; a target within THAT card is the
 * composer's own editor surface. Outside the card, the interceptor claims
 * only the surface a browser targets when NO element has focus (document /
 * body / html): every FOCUSED element elsewhere — tree nodes, buttons,
 * menus, editables — keeps its native ArrowRight semantics (qc2 F-001
 * narrowed the previous draft that hijacked any focused non-editable
 * target).
 */
function isFillTrigger(event: KeyboardEvent): boolean {
  if (event.key !== 'ArrowRight') return false
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  const target = event.target
  if (!(target instanceof Element)) return true // no target element (e.g. dispatched on document) → no-focus surface
  const card = document.querySelector('[data-composer-card]')
  if (card !== null && card.contains(target)) return true
  // Outside the card: only the no-focus surface (nothing focused) fills.
  // A focused element is always its own keydown target, so any specific
  // focused element — editable or not — falls through to native behavior.
  return target === document.body || target === document.documentElement
}

/**
 * Render the composer dock tip. The dock holds exactly ONE row, and the
 * component owns the arbitration: a freshly delivered advisor note takes the
 * row for {@link ADVICE_TIP_MS} and then yields to the per-turn suggestion
 * (the resting state). The two rows can never render together.
 * @param props - slot-delivered injected dependencies and the synthesized seats.
 * @returns the dock-tip occupant, or nothing.
 */
export function ComposerDockTip(props: ComposerDockTipProps): ReactNode {
  const {
    suggestionController, adviceController, useSnapshot, useAdviceSnapshot,
    useRefreshSignal, useInput, inputActions, t,
  } = props
  const state = useSnapshot((s) => s)
  const adviceState = useAdviceSnapshot((s) => s)
  const epoch = useRefreshSignal((s) => s.epoch)
  const input = useInput((s) => s)
  const suggestion = state.suggestion
  const advice = adviceState.advice
  const draft = input.draft
  const phase = input.phase
  // The flash state: the delivery id currently occupying the single row.
  const [flashId, setFlashId] = useState<number | null>(null)
  const [dismissedId, setDismissedId] = useState<number | null>(null)
  const lastFlashed = useRef<number | null>(null)
  // A newly observed delivery takes the row for 2 s; the same id never
  // re-flashes on a later poll. Depend on the ID (not the fresh store object a
  // poll produces) so a same-id refresh cannot clear the pending hide timer.
  const deliveryId = advice?.deliveryId ?? null
  useEffect(() => {
    if (deliveryId === null) {
      lastFlashed.current = null
      setFlashId(null)
      return
    }
    if (deliveryId === dismissedId) {
      setFlashId(null)
      return
    }
    if (deliveryId === lastFlashed.current) return
    lastFlashed.current = deliveryId
    setFlashId(deliveryId)
    const timer = window.setTimeout(() => {
      setFlashId((current) => (current === deliveryId ? null : current))
    }, ADVICE_TIP_MS)
    return () => { window.clearTimeout(timer) }
  }, [deliveryId, dismissedId])
  const adviceVisible = flashId !== null && advice !== null
    && advice.deliveryId === flashId && advice.deliveryId !== dismissedId
  // The render gate: a suggestion waits on an empty draft in the plain phase,
  // and the transient advice note wins the row while its 2 s flash runs.
  const suggestionVisible = !adviceVisible && suggestion !== null && draft === '' && phase === 'plain'

  // Fetch on mount and on every consumed refresh-signal epoch bump
  // (connection/reset + window focus ride the plugin's shared debounced
  // plane). takeSignal is idempotent per epoch, so a re-render never
  // double-fetches; the mount run IS the first fetch (no epoch consumed yet).
  useEffect(() => {
    if (suggestionController.takeSignal(epoch)) void suggestionController.fetch()
    if (adviceController.takeSignal(epoch)) void adviceController.fetch()
  }, [suggestionController, adviceController, epoch])

  // Idle poll: armed ONLY while idle (no suggestion, empty draft, plain
  // phase); any other state clears the timer (contract ⑤ — the fake-timer
  // spec proves the timer is gone once a suggestion arrives).
  const idle = suggestion === null && draft === '' && phase === 'plain'
  useEffect(() => {
    if (!idle) return
    const timer = window.setInterval(() => { void suggestionController.fetch() }, NEXT_PROMPT_IDLE_POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [suggestionController, idle])

  // Advice poll: unconditional, so a new delivery and the turn-boundary clear
  // are both observed in-page.
  useEffect(() => {
    const timer = window.setInterval(() => { void adviceController.fetch() }, ADVICE_IDLE_POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [adviceController])

  // The input snapshot as the latest render read it, re-written on every
  // render (the render itself just consumed the store through useInput).
  // The keydown handler below reads THIS at event time: in the React
  // commit→passive-effect window a draft/phase update is already committed
  // and rendered while the previous listener is still mounted, and the
  // handler's closure can be a render behind — this ref is not (qc2 F-002).
  const inputRef = useRef(input)
  inputRef.current = input

  // The shared gated fill path behind BOTH accept gestures (ArrowRight, and
  // a click anywhere on the tip row). The render gate is re-validated
  // against the CURRENT input snapshot at event time — a fill never
  // replaces user-typed text or crosses a non-plain phase (qc2 F-002) —
  // then the draft fills with the suggestion and the tip clears
  // optimistically (contract ④). Returns whether the fill ran; the keydown
  // interceptor preventDefaults only on true, so a violated gate keeps
  // native semantics.
  const fillFromSuggestion = useCallback((): boolean => {
    if (suggestion === null) return false
    const current = inputRef.current
    if (current.draft !== '' || current.phase !== 'plain') return false
    inputActions.setDraft(suggestion)
    suggestionController.consume()
    return true
  }, [suggestionController, inputActions, suggestion])

  // Document-level capture-phase fill listener. Mounted while a suggestion
  // waits; the RENDER gate (empty draft, plain phase) is re-validated inside
  // the shared fill path at event time, so the listener surviving the commit→
  // passive-effect teardown window can never fill over user-typed text
  // (qc2 F-002).
  useEffect(() => {
    if (suggestion === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isFillTrigger(event)) return
      if (!fillFromSuggestion()) return // violated gate → native ArrowRight semantics
      event.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [fillFromSuggestion])

  if (adviceVisible) {
    return (
      <div
        className={styles.tip}
        data-advisor-tip=""
        data-advisor-advice=""
        data-severity={advice.severity}
        role="status"
        aria-live="polite"
      >
        <span className={styles.tipGlyph} data-advice-glyph="" aria-hidden="true">◆</span>
        <span className={styles.tipPrefix}>{t('advicePrefix')}:</span>
        <span className={styles.adviceSeverity}>{advice.severity}</span>
        <span className={styles.tipText}>{advice.note}</span>
        <button
          type="button"
          className={styles.adviceDismiss}
          aria-label={t('adviceDismiss')}
          title={t('adviceDismiss')}
          onClick={() => {
            setDismissedId(advice.deliveryId)
            setFlashId(null)
          }}
        >
          ×
        </button>
      </div>
    )
  }
  if (!suggestionVisible || suggestion === null) return null
  return (
    // role="status" + aria-live="polite" make the suggestion ANNOUNCED:
    // assistive tech hears what the suggestion is when it arrives, without
    // focus. The whole row is the accept click target (the row-level
    // onClick routes through the SAME gated fill path as ArrowRight); the
    // trailing control is a passive accept AFFORDANCE, not a nested button
    // — a second interactive descendant inside a live region would just
    // double the announcements.
    // `data-advisor-tip` is the CSS scoping hook: next-prompt.module.css
    // stretches the host dock only when it `:has` this marker, so other
    // composer docks (no tip) keep the host's centered fit-content layout.
    <div className={styles.tip} data-advisor-tip="" role="status" aria-live="polite" onClick={() => { fillFromSuggestion() }}>
      <span className={styles.tipGlyph} aria-hidden="true">✦</span>
      <span className={styles.tipPrefix}>{t('nextPromptPrefix')}:</span>
      <span className={styles.tipText}>{suggestion}</span>
      <span className={styles.tipAccept}>{t('nextPromptAccept')}</span>
    </div>
  )
}
