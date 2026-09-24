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

import { useState, type ReactNode } from 'react'
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
  // The staged pin selection is LOCAL user input (never seeded from the
  // snapshot — the effective pair is displayed as text above; a stale host
  // pair must not look like staged edits).
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')

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
              onChange={(event) => { setModel(event.target.value) }}
            >
              <option value="">{t('modelPlaceholder')}</option>
              {(directoryState.modelsByProvider[provider] ?? []).map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
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
              onClick={() => { void controller.setSessionModel(provider, model) }}
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
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t(open ? 'sessionCollapse' : 'sessionExpand')}
        onClick={() => { if (open) setOpen(false); else openAdvisor() }}
      >
        {t('sessionTrigger')}
      </button>
      {open
        ? (
            <div className={styles.panel} role="dialog" aria-label={t('sessionModelHeading')}>
              <p className={styles.panelHeading}>{t('sessionModelHeading')}</p>
              {directoryState.providers.length === 0 && directoryState.status === 'ready' && !state.unavailable
                ? <p className={styles.mutedLine}>{t('noProviders')}</p>
                : null}
              {body}
            </div>
          )
        : null}
    </div>
  )
}
