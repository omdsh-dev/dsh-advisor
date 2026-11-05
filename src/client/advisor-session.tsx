/**
 * Advisor session header action (B2 — issue #88 web session control): the
 * entry registered into the shell-declared `conversation.session.header.actions`
 * list slot (title-adjacent Session actions — NOT the singleton
 * primary-model slot, NOT the root plugin card; the global card stays
 * global-only). The slot is session-scoped, so the framework resolves the
 * bound SessionId into the inject factory (src/client/index.ts), which builds
 * ONE {@link AdvisorSessionModelController} per session scope binding — the
 * renderer memoizes that face per (entry × session binding), so the instance
 * lives and dies with the binding and every fetch/write carries its own
 * sessionId (a late response for an old binding can never render another
 * session's state).
 *
 * The control shows the authoritative session snapshot — the effective
 * reviewer pair, its source (`session`/`global`), the live-session lifetime,
 * the effective switch, and the S4 gate reason when blocked — and supports
 * set (provider + model, staged through the shared provider directory) and
 * **Use global default** (reset). It rides ONLY the plugin session endpoints
 * (`/api/advisor/getSession` + `/api/advisor/setSessionModel`); when the
 * surface is unavailable the menu renders a notice and offers NO writes — it
 * never falls back to the global `advisor/set` channel.
 *
 * Fetch discipline: fetch on menu open, on binding change (a new binding gets
 * a fresh controller whose first open fetches), and on refresh signals while
 * open (connection reset / window focus — the epoch store bumps, the watcher
 * refetches). Every response settles through the controller's request fence,
 * so a superseded (stale) response is discarded wholesale. NO push-event
 * contract, NO polling: an open menu is a refreshable snapshot, and the
 * closed trigger is NEUTRAL — the plugin name only, never a model label
 * falsely claiming continuous synchronization.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AdvisorSessionMenuState, AdvisorSessionModelController, AdvisorSettingsState, AdvisorSettingsStore } from './advisor-store.ts'
import styles from './advisor-session.module.css'

/**
 * Injected dependencies of {@link AdvisorSessionAction} (slot `inject`,
 * built per session binding by the registration's inject factory). The
 * `hooks` compartment carries the bare snapshot sources; the renderer binds
 * each as a `use<Name>` selector hook the component consumes.
 */
export interface AdvisorSessionActionInjected {
  /** The session this occurrence is bound to (framework-resolved). */
  readonly sessionId: string
  /** The per-session session-model controller (one per binding). */
  readonly controller: AdvisorSessionModelController
  /** The shared provider/model directory (READ-only reuse of the card's store). */
  readonly directory: AdvisorSettingsStore
  /** Bare snapshot sources the renderer binds as selector hooks. */
  readonly hooks: {
    /** The per-session menu snapshot. */
    readonly snapshot: SnapshotStore<AdvisorSessionMenuState>
    /** Refresh-signal epoch (bumped on connection reset / window focus). */
    readonly refreshSignal: SnapshotStore<{ epoch: number }>
    /** The shared provider/model directory state. */
    readonly directory: SnapshotStore<AdvisorSettingsState>
  }
}

/**
 * Props the renderer binds for the action: the session-scoped runtime share
 * (the slot's owner is a marker — no owner-specific values), the
 * framework-synthesized `t` seat for the declared `settings.advisor`
 * namespace, and the registrant's per-binding business face.
 */
export type AdvisorSessionActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.advisor'>
  & InjectFace<AdvisorSessionActionInjected>

/**
 * Measured rects of the popover geometry. `anchor` is the trigger's viewport
 * rect; `panel`/`viewport` are plain sizes. Pure so the clamp contract is
 * unit-testable (issue #141).
 */
export interface PopoverGeometry {
  anchor: { left: number; top: number; right: number; bottom: number }
  panel: { width: number; height: number }
  viewport: { width: number; height: number }
  gap: number
  margin: number
}

/**
 * Clamp the panel to the viewport: right-aligned under the trigger (matching
 * the pre-portal geometry), pushed inside `margin` on whichever edge the
 * natural position would cross. The outer `Math.max(margin, …)` guarantees
 * only that the top-left corner lands inside `margin` and never a negative
 * offset — even when the panel itself is larger than the viewport (the
 * inner upper bound would then be below `margin`); it does NOT keep an
 * oversized panel fully on-screen. Vertical containment comes from the CSS
 * `max-height` cap on `.panel`.
 */
export function computePopoverPosition({ anchor, panel, viewport, gap, margin }: PopoverGeometry): { left: number; top: number } {
  const left = Math.max(
    margin,
    Math.min(anchor.right - panel.width, viewport.width - panel.width - margin),
  )
  const top = Math.max(
    margin,
    Math.min(anchor.bottom + gap, viewport.height - panel.height - margin),
  )
  return { left, top }
}

/** Popover placement constants (the old CSS `100% + 6px` offset; 8px screen margin). */
const POPOVER_GAP = 6
const POPOVER_MARGIN = 8

/**
 * Render the session header's Advisor action: a neutral trigger plus, when
 * open, a popover panel holding the refreshable snapshot and the pin/reset
 * controls.
 * @param props - slot-delivered injected dependencies and the synthesized t seat.
 * @returns the action.
 */
export function AdvisorSessionAction(props: AdvisorSessionActionProps): ReactNode {
  const { controller, directory, useSnapshot, useRefreshSignal, useDirectory, t } = props
  const state = useSnapshot((s) => s)
  const epoch = useRefreshSignal((s) => s.epoch)
  const directoryState = useDirectory((s) => s)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // First paint hides the panel at 0,0 (mirroring the host's ContextMeter):
  // the layout effect then measures and pins the clamped position before
  // paint, so no unpositioned frame is ever visible.
  const [position, setPosition] = useState<{ left: number; top: number; visibility: CSSProperties['visibility'] }>({ left: 0, top: 0, visibility: 'hidden' })
  const panelId = useId()
  // Open→close transitions only: guards the return-focus path so the first
  // mount (closed) never steals page focus.
  const wasOpenRef = useRef(false)
  // Last measured geometry: resize/scroll/observer ticks skip setPosition
  // while nothing changed. Reset on close so a reopen always re-applies
  // `visible` (never strands the panel behind a stale skip).
  const lastMeasuredRef = useRef<{ left: number; top: number; width: number; height: number; visibility: CSSProperties['visibility'] } | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      if (wasOpenRef.current) triggerRef.current?.focus()
      wasOpenRef.current = false
      lastMeasuredRef.current = null
      setPosition({ left: 0, top: 0, visibility: 'hidden' })
      return
    }
    wasOpenRef.current = true
    const update = (): void => {
      const trigger = triggerRef.current
      const panel = panelRef.current
      if (trigger === null || panel === null) return
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      const next: { left: number; top: number; width: number; height: number; visibility: CSSProperties['visibility'] } = {
        ...computePopoverPosition({
          anchor: trigger.getBoundingClientRect(),
          panel: { width, height },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          gap: POPOVER_GAP,
          margin: POPOVER_MARGIN,
        }),
        width,
        height,
        visibility: 'visible',
      }
      const last = lastMeasuredRef.current
      if (last === null || last.left !== next.left || last.top !== next.top || last.width !== next.width || last.height !== next.height || last.visibility !== next.visibility) {
        lastMeasuredRef.current = next
        setPosition({ left: next.left, top: next.top, visibility: next.visibility })
      }
    }
    update()
    // Async snapshot/directory loads grow the panel's height while `open`
    // stays true; re-clamp whenever the measured size actually changes.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    if (panelRef.current !== null) observer?.observe(panelRef.current)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])
  // The portal severed the DOM sibling relationship the pre-portal panel
  // relied on for keyboard order: move focus into the panel once it is
  // actually visible (browsers refuse to focus a visibility:hidden panel,
  // and the measuring effect above commits `visible` only in a later
  // layout pass). Runs once per open; position re-clamps on scroll/resize
  // do not re-fire it because `visibility` never changes while open.
  const focusHandedOffRef = useRef(false)
  useLayoutEffect(() => {
    if (!open || position.visibility !== 'visible' || focusHandedOffRef.current) return
    focusHandedOffRef.current = true
    panelRef.current?.focus({ preventScroll: true })
  }, [open, position.visibility])
  useLayoutEffect(() => {
    if (!open) focusHandedOffRef.current = false
  }, [open])
  // The staged pin selection is LOCAL user input — the provider/model are
  // never seeded from the snapshot (the effective pair is displayed as text
  // above; a stale host pair must not look like staged edits). The staged
  // EFFORT is the one exception (issue #142, PR #144 review): a session
  // pinned to the effective pair pre-selects its pinned effort so
  // re-pinning without touching the select never drops the pin. A user
  // edit always wins over the seed.
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  // The staged effort rides the staged pair: '' = inherit the global value
  // (the select's first option); reset on every provider/model transition
  // and reloaded through loadReasoning (issue #142).
  const [effort, setEffort] = useState('')
  /** True once the user touches the effort select — seeding must stand down. */
  const effortEditedRef = useRef(false)
  /** The pair whose options were last resolved (dedupes the open-time load). */
  const lastReasoningKeyRef = useRef('')

  // Seed the staged effort from the pinned override and resolve the pinned
  // model's declared efforts (the pinned id must be a selectable option).
  // Runs whenever the snapshot or the staged pair changes; a user edit
  // (effortEditedRef) suppresses the seed until the next pair transition.
  // The load is gated on the STAGED pair matching the effective one: a pair
  // the user has staged past must never be superseded by this load (QC1-W2
  // — it would bump reasoningSeq and discard the staged lookup).
  const snapshotForSeed = state.snapshot
  useEffect(() => {
    if (effortEditedRef.current) return
    const effective = snapshotForSeed?.effectiveModel
    const pinnedEffort = snapshotForSeed?.reasoningEffortOverride
    const stagedMatchesEffective = effective !== undefined
      && provider === effective.provider
      && model === effective.model
    setEffort(stagedMatchesEffective && pinnedEffort !== undefined ? pinnedEffort : '')
    if (stagedMatchesEffective && pinnedEffort !== undefined && effective !== undefined) {
      const key = `${effective.provider}/${effective.model}`
      if (key !== lastReasoningKeyRef.current) {
        lastReasoningKeyRef.current = key
        void controller.loadReasoning(effective.provider, effective.model)
      }
    }
  }, [snapshotForSeed, provider, model, controller])

  // Open is a refresh point (fetch on menu open): every open refetches and
  // marks the current signal epoch consumed, so the watcher below does not
  // double-fire for the same epoch. The provider directory (shared with the
  // global card) loads on first need — READ-only; the session surface never
  // writes through it.
  const openAdvisor = (): void => {
    setOpen(true)
    controller.takeSignal(epoch)
    void controller.refresh()
    if (directoryState.status === 'idle') void directory.load()
  }
  // Refresh-signal watcher (fetch on reconnect / focus while open):
  // takeSignal is idempotent per epoch, so a re-render never double-fetches —
  // same render-time guarded-side-effect shape as the card's idle load.
  if (open && controller.takeSignal(epoch)) void controller.refresh()

  const snapshot = state.snapshot
  const busy = state.pending
  const pinned = snapshot?.modelSource === 'session'

  let body: ReactNode
  if (state.unavailable) {
    // Unavailable surface: notice only — NO staged controls, NO writes (and
    // never a fallback to the global advisor/set channel). A later successful
    // refresh (reopen / signal) recovers the menu.
    body = <p className={styles.notice} role="status">{t('sessionUnavailable')}</p>
  } else if (snapshot === null) {
    body = <p className={styles.mutedLine} role="status">{t('sessionLoading')}</p>
  } else {
    const pair = snapshot.effectiveModel !== undefined
      ? `${snapshot.effectiveModel.provider}/${snapshot.effectiveModel.model}`
      : undefined
    // ONE `Effort:` line from the recorded resolution, with the same source
    // wording as `/advisor status` — rendered only when the snapshot carries
    // both the record and the effective route it names; the surface never
    // invents a value (issue #142, AC2/AC6).
    let effortLine: string | null = null
    if (snapshot.reasoningEffort !== undefined && snapshot.effectiveModel !== undefined) {
      const route = `${snapshot.effectiveModel.provider}/${snapshot.effectiveModel.model}`
      const record = snapshot.reasoningEffort
      switch (record.source) {
        case 'pending':
          effortLine = t('sessionEffortPending')
          break
        case 'configured':
          // The runtime records WHERE the configured effort came from
          // (issue #142): name the origin when present, else stay neutral —
          // same label set as the `/advisor status` surface.
          effortLine = `${record.effective} ${
            record.origin === 'session'
              ? t('sessionEffortConfiguredSession')
              : record.origin === 'global'
                ? t('sessionEffortConfiguredGlobal')
                : t('sessionEffortConfigured')
          }`
          break
        case 'auto':
          effortLine = `${record.effective} ${t('sessionEffortAuto', { route })}`
          break
        case 'fallback-undeclared':
          effortLine = `${record.effective} ${t('sessionEffortFallback', { configured: record.configured ?? '', route })}`
          break
        case 'none':
          effortLine = t('sessionEffortNone', { route })
          break
        default:
          effortLine = null
      }
    }
    body = (
      <>
        {snapshot.enabled ? null : <p className={styles.notice}>{t('sessionAdvisorOff')}</p>}
        {snapshot.disabledReason !== undefined
          ? <p className={styles.notice}>{t('sessionGateBlocked', { reason: snapshot.disabledReason })}</p>
          : null}
        <p className={styles.routeLine}>
          {pair === undefined ? t('sessionNoPair') : pair}
          {pair !== undefined && snapshot.modelSource !== undefined
            ? (
                <span className={styles.sourceBadge}>
                  {t(snapshot.modelSource === 'session' ? 'sessionSourceSession' : 'sessionSourceGlobal')}
                </span>
              )
            : null}
        </p>
        {effortLine !== null ? <p className={styles.routeLine}>{t('sessionEffort')}: {effortLine}</p> : null}
        <p className={styles.mutedLine}>{t('sessionLifetime')}</p>
        {state.error !== null ? <p className={styles.error} role="status">{state.error}</p> : null}
        <div className={styles.controls}>
          <div className={styles.selectRow}>
            <select
              aria-label={t('provider')}
              className={styles.select}
              value={provider}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value
                setProvider(next)
                setModel('')
                setEffort('')
                effortEditedRef.current = false
                if (next !== '') void directory.ensureModels(next)
              }}
            >
              <option value="">{t('providerPlaceholder')}</option>
              {directoryState.providers.map((option) => (
                <option key={option.provider} value={option.provider}>{option.displayName}</option>
              ))}
            </select>
            <select
              aria-label={t('model')}
              className={styles.select}
              value={model}
              disabled={busy || provider === '' || (directoryState.modelsByProvider[provider]?.length ?? 0) === 0}
              onChange={(event) => {
                const next = event.target.value
                setModel(next)
                // A new model re-inherits the effort; its declared ids reload
                // through the shared capability endpoint (no lookup without
                // a chosen model).
                setEffort('')
                effortEditedRef.current = false
                if (next !== '') {
                  lastReasoningKeyRef.current = `${provider}/${next}`
                  void controller.loadReasoning(provider, next)
                }
              }}
            >
              <option value="">{t('modelPlaceholder')}</option>
              {(directoryState.modelsByProvider[provider] ?? []).map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          </div>
          <div className={styles.selectRow}>
            {/* Inherit global + the declared ids of the currently selected
                model. Disabled while a lookup is loading or no model is
                chosen; a failed lookup keeps the select usable on the last
                known options. */}
            <select
              aria-label={t('sessionEffort')}
              className={styles.select}
              value={effort}
              disabled={busy || provider === '' || model === '' || state.reasoningStatus === 'loading'}
              onChange={(event) => {
                effortEditedRef.current = true
                setEffort(event.target.value)
              }}
            >
              <option value="">{t('sessionEffortInherit')}</option>
              {state.reasoningEfforts.map((option) => (
                <option key={option.id} value={option.id}>{option.name || option.id}</option>
              ))}
            </select>
          </div>
          {provider !== '' && (directoryState.modelsByProvider[provider]?.length ?? 0) === 0
            ? <p className={styles.mutedLine}>{t('noModels')}</p>
            : null}
          <div className={styles.actions}>
            {/* Reset is offered only while a pin exists — an inheriting
                session has nothing to reset, and disabling says so truthfully. */}
            <button
              type="button"
              className={styles.reset}
              disabled={busy || !pinned}
              onClick={() => { void controller.resetSessionModel() }}
            >
              {t('sessionReset')}
            </button>
            <button
              type="button"
              className={styles.pin}
              disabled={busy || provider === '' || model === ''}
              onClick={() => { void controller.setSessionModel(provider, model, effort === '' ? undefined : effort) }}
            >
              {busy ? t('sessionPending') : t('sessionPinAction')}
            </button>
          </div>
        </div>
      </>
    )
  }

  return (
    <div className={styles.anchor}>
      {/* Neutral closed label: the plugin name only — a closed action claims
          no model and no continuous synchronization. */}
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-haspopup="dialog"
        /* Only advertise the id while the panel exists — a closed trigger
           pointing at a missing element is a dangling IDREF. */
        aria-controls={open ? panelId : undefined}
        aria-label={t(open ? 'sessionCollapse' : 'sessionExpand')}
        onClick={() => { if (open) setOpen(false); else openAdvisor() }}
      >
        {t('sessionTrigger')}
      </button>
      {open
        ? createPortal(
            // The panel lives on document.body (position: fixed, z-index
            // 1100) so the host conversation column's overflow: hidden can
            // never crop it, however far the header action sits toward the
            // column's left edge (issue #141).
            <div
              ref={panelRef}
              id={panelId}
              className={styles.panel}
              role="dialog"
              aria-label={t('sessionModelHeading')}
              // tabIndex=-1: the dialog is a focus target (focus moves here on
              // open) but stays out of the sequential Tab order.
              tabIndex={-1}
              style={{ left: position.left, top: position.top, visibility: position.visibility }}
            >
              <p className={styles.panelHeading}>{t('sessionModelHeading')}</p>
              {directoryState.providers.length === 0 && directoryState.status === 'ready' && !state.unavailable
                ? <p className={styles.mutedLine}>{t('noProviders')}</p>
                : null}
              {body}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
