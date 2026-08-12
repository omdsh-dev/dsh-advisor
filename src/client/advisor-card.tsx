/**
 * Advisor settings card (plan dsh-advisor-plugin-config-card-ux, task 1): the
 * card registered into the "插件配置" settings page's `settings.plugin.item`
 * slot (id `advisor`, order 30). It keeps the n5 gateway channel — the store
 * reads/writes the advisor config through `/api/advisor/get` +
 * `/api/advisor/set` (KD-G3) — while the card chrome is rebuilt to replicate
 * the upstream `PluginCard` contract (self-drawn: the upstream client value
 * face exports no reusable card). The chrome: a collapsible box whose header
 * is a button stacking the plugin name over its description, with a dirty
 * "unsaved" pill and a rotating chevron (`IconChevronDownOutline14` from
 * ui-primitives), `aria-expanded`/`aria-label` like the upstream header; a
 * divider under the header; then the form content; then a footer with the
 * failed message + Discard/Save carrying the upstream disabled semantics —
 * save = `!dirty || invalid || saving`, discard = `!dirty || saving` (KD-U1,
 * Global Constraints). Disclosure is card-local state: which card a user has
 * open is a reading gesture, and staged edits outlive collapsing — the pill
 * rides the header (upstream rationale).
 *
 * The full form is unchanged from the card-form plan: `enabled` switch
 * (default off), `provider`/`model` select boxes limited to the
 * system-configured providers and their models (KD-S2), the
 * required-when-enabled gate (KD-S4, also enforced in the store), the
 * `systemPrompt` textarea, the `immuneTurns`/`maxDeltaMessages` number
 * inputs, and Save writing the advisor config through the gateway channel
 * (store → `connection.rpc.call('/api', 'advisor/set', { patch })`). Discard
 * rewinds the draft to the last-known host config (client-side only — no
 * gateway write).
 *
 * Presentation follows `PluginCard.module.css` shape via
 * `advisor-card.module.css` — every color resolves through a `--dsw-alias-*`
 * token so the card adapts to the light/dark theme.
 *
 * A stored provider/model that is no longer among the current options
 * surfaces warning copy (`staleProvider`/`staleModel`) instead of blocking
 * Save: the user keeps the stored value (it still applies as stored) or
 * reselects — the host gate rejects truly invalid configurations on write.
 * Clearing a number input leaves the field empty; the store then omits that
 * key from the apply patch (the stored value stays unchanged).
 *
 * Degraded/error/loading states keep the same card chrome (KD-U3): the
 * header always renders title+description+chevron, and the body carries the
 * config-channel notice or the load error + retry (AC-3 — the documented
 * divergence from upstream, whose unavailable card renders nothing). A card
 * that cannot render its form starts open so the notice/error stays visible.
 * When the last load could not reach the `advisor.get` gateway endpoint (the
 * gateway channel is down or not ready on this host), the form is replaced
 * by the `namespaceUnavailable` notice and Save is never offered, so the
 * page never presents a writable-looking editor whose writes the host would
 * refuse (KD-G5). Note: without a settings service the gateway's `get` still
 * succeeds (entry fallback — the form renders), while `set` fails with a
 * clear "settings service is unavailable" error; the notice covers channel
 * unreachability, not the no-settings-service case.
 */

import { useState, type ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { ApplyFailure, AdvisorSettingsState, AdvisorSettingsStore } from './advisor-store.ts'
import styles from './advisor-card.module.css'

/** Injected dependencies of {@link AdvisorCard} (slot `inject`). */
export interface AdvisorCardInjected {
  /** The card store (loaded on mount, refreshed on pushed invalidations). */
  controller: AdvisorSettingsStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<AdvisorSettingsState>
}

/**
 * Props the renderer binds for the card: the `settings.plugin.item` runtime
 * share (empty owner props), the framework-synthesized `t` seat for the
 * declared `settings.advisor` namespace (KD-1 — `t` is NOT part of the inject
 * face), and the registrant's business face.
 */
export type AdvisorCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.advisor'>
  & InjectFace<AdvisorCardInjected>

/** Copy for an apply failure; the gate failure renders as the inline hints instead. */
function failureCopy(failure: ApplyFailure, t: AdvisorCardProps['t']): string | undefined {
  switch (failure.kind) {
    case 'gate': return undefined
    case 'message': return failure.message
  }
}

/**
 * Render the advisor card inside the plugin-config section, replicating the
 * upstream PluginCard chrome (KD-U1): a collapsible `<li>` with a header
 * button (name over description, dirty pill, rotating chevron, aria) and,
 * when open, a divided body holding the readOnly notice, the form, and the
 * footer (failed message + Discard/Save).
 * @param props - slot-delivered injected dependencies and the synthesized t seat.
 * @returns the card.
 */
export function AdvisorCard(props: AdvisorCardProps): ReactNode {
  const { controller, useSnapshot, t } = props
  const state = useSnapshot(snapshot => snapshot)
  // Disclosure is card-local state (upstream rationale). A card that cannot
  // render its form — a load error, or an unreachable gateway — starts open
  // so the notice/error + retry stay visible (KD-U3/AC-3); the form card
  // starts collapsed.
  const [open, setOpen] = useState(() => state.status === 'error' || !state.advisorPresent)

  // Load-on-mount (KD-3): the plugin-config page mounts the card lazily when
  // the user opens the settings panel, so the first mount triggers the first
  // gateway load — same idle→load() pattern the section used.
  // Loop-guard invariant (qc3 N-1): load() synchronously flips status
  // idle→loading BEFORE its first await (advisor-store.ts load() — the first
  // store.update, no await in between), which is what terminates this mount
  // trigger: the re-render reads 'loading' and the idle branch no longer
  // fires, so there is no loop — and a StrictMode double render sees the
  // already-flipped snapshot, so there is no duplicate fetch. Do NOT
  // restructure into a useEffect: a deps-`[]` effect would refetch on every
  // remount, changing the load-once semantics.
  if (state.status === 'idle') void controller.load()

  const title = t('title')
  const header = (
    <button
      type="button"
      className={styles['header']}
      aria-expanded={open}
      aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
      onClick={() => { setOpen(!open) }}
    >
      <span className={styles['headText']}>
        <span className={styles['name']}>{title}</span>
        <span className={styles['description']}>{t('intro')}</span>
      </span>
      {state.dirty ? <span className={styles['pending']}>{t('unsaved')}</span> : null}
      <IconChevronDownOutline14
        className={open ? `${styles['chevron']} ${styles['chevronOpen']}` : styles['chevron']}
      />
    </button>
  )

  let body: ReactNode
  if (state.status === 'error') {
    // A post-apply reload failure must not mask a landed write: the saved
    // feedback renders alongside the error + retry.
    body = (
      <div className={styles['body']}>
        {state.applyState.kind === 'saved' ? <p className={styles['savedNotice']} role="status">{t('saved')}</p> : null}
        <p className={styles['error']}>{`${t('loadFailed')}: ${state.error ?? ''}`}</p>
        <div className={styles['footer']}>
          <button type="button" className={styles['discard']} onClick={() => { void controller.load() }}>
            {t('retry')}
          </button>
        </div>
      </div>
    )
  } else if (!state.advisorPresent) {
    // KD-G5 (the n2-era C-1 mitigation): when the last load could not reach
    // the `advisor.get` gateway endpoint (gateway not ready / channel down),
    // the form would present defaults + a writable-looking Save that can only
    // fail with a host refusal — render the explicit notice in the card body
    // instead and never offer Save. qc3 N-1 mirrors here too: a post-apply
    // reload that loses the gateway must not mask a landed write — the saved
    // line renders alongside the notice.
    body = (
      <div className={styles['body']}>
        {state.applyState.kind === 'saved' ? <p className={styles['savedNotice']} role="status">{t('saved')}</p> : null}
        <p className={styles['notice']} role="status">{t('namespaceUnavailable')}</p>
        <div className={styles['footer']}>
          <button type="button" className={styles['discard']} onClick={() => { void controller.load() }}>
            {t('retry')}
          </button>
        </div>
      </div>
    )
  } else if (state.status === 'ready') {
    const { draft, providers, writable, applyState } = state
    const providerEmpty = draft.provider === undefined
    const modelEmpty = draft.model === undefined
    // KD-S4: enabled + missing provider/model blocks Save and shows the hints.
    const gateFailed = draft.enabled && (providerEmpty || modelEmpty)
    const saving = applyState.kind === 'saving'
    const busy = !writable || saving
    const selectedModels = draft.provider === undefined
      ? []
      : state.modelsByProvider[draft.provider] ?? []
    const modelsEmpty = draft.provider !== undefined && Object.hasOwn(state.modelsEmptyReason, draft.provider)
    // Stored values that are no longer among the current options: warn instead
    // of silently dropping them; Save stays enabled once the draft is dirty
    // (keep or reselect).
    const providerStale = draft.provider !== undefined
      && !providers.some(option => option.provider === draft.provider)
    const modelStale = !providerStale && draft.model !== undefined
      && selectedModels.length > 0
      && !selectedModels.some(option => option.id === draft.model)
    const errorText = applyState.kind === 'error' ? failureCopy(applyState.failure, t) : undefined
    // Upstream disabled semantics (Global Constraints): save = !dirty ||
    // invalid || saving; discard = !dirty || saving. In a read-only
    // environment the fields are disabled, so the draft cannot become dirty
    // and both actions stay disabled through the !dirty term.
    const saveDisabled = !state.dirty || gateFailed || saving
    const discardDisabled = !state.dirty || saving
    body = (
      <div className={styles['body']}>
        {!writable ? <p className={styles['readOnly']} role="status">{t('readOnly')}</p> : null}
        {applyState.kind === 'saved' ? <p className={styles['savedNotice']} role="status">{t('saved')}</p> : null}
        <div className={styles['form']}>
          <div className={styles['checkboxRow']}>
            <label htmlFor="advisor-enabled" className={styles['checkLabel']}>{t('enabled')}</label>
            <input
              id="advisor-enabled"
              type="checkbox"
              className={styles['checkbox']}
              checked={draft.enabled}
              disabled={busy}
              onChange={(event) => { controller.setEnabled(event.target.checked) }}
            />
          </div>
          {draft.enabled
            ? (
              <fieldset className={styles['fieldset']}>
                <div className={styles['field']}>
                  <label htmlFor="advisor-provider" className={styles['fieldLabel']}>{t('provider')}</label>
                  <select
                    id="advisor-provider"
                    aria-label={t('provider')}
                    className={`${styles['input']} ${styles['selectInput']}`}
                    value={draft.provider ?? ''}
                    disabled={busy}
                    onChange={(event) => { controller.setProvider(event.target.value) }}
                  >
                    <option value="">{t('providerPlaceholder')}</option>
                    {providers.map(option => (
                      <option key={option.provider} value={option.provider}>{option.displayName}</option>
                    ))}
                  </select>
                  {providers.length === 0 ? <p className={styles['hint']}>{t('noProviders')}</p> : null}
                  {providerEmpty ? <p className={styles['warnHint']}>{t('providerRequired')}</p> : null}
                  {providerStale ? <p className={styles['hint']}>{t('staleProvider')}</p> : null}
                </div>
                <div className={styles['field']}>
                  <label htmlFor="advisor-model" className={styles['fieldLabel']}>{t('model')}</label>
                  <select
                    id="advisor-model"
                    aria-label={t('model')}
                    className={`${styles['input']} ${styles['selectInput']}`}
                    value={draft.model ?? ''}
                    disabled={busy || draft.provider === undefined || selectedModels.length === 0}
                    onChange={(event) => { controller.setModel(event.target.value) }}
                  >
                    <option value="">{t('modelPlaceholder')}</option>
                    {selectedModels.map(option => (
                      <option key={option.id} value={option.id}>{option.name}</option>
                    ))}
                  </select>
                  {modelsEmpty ? <p className={styles['hint']}>{t('noModels')}</p> : null}
                  {modelStale ? <p className={styles['hint']}>{t('staleModel')}</p> : null}
                  {!providerEmpty && modelEmpty ? <p className={styles['warnHint']}>{t('modelRequired')}</p> : null}
                </div>
              </fieldset>
            )
            : null}
          <div className={styles['field']}>
            <label htmlFor="advisor-system-prompt" className={styles['fieldLabel']}>{t('systemPrompt')}</label>
            <textarea
              id="advisor-system-prompt"
              aria-label={t('systemPrompt')}
              placeholder={t('systemPromptPlaceholder')}
              className={styles['textarea']}
              value={draft.systemPrompt}
              disabled={busy}
              onChange={(event) => { controller.setSystemPrompt(event.target.value) }}
            />
          </div>
          <div className={styles['numberFields']}>
            <div className={styles['field']}>
              <label htmlFor="advisor-immune-turns" className={styles['fieldLabel']}>{t('immuneTurns')}</label>
              <input
                id="advisor-immune-turns"
                aria-label={t('immuneTurns')}
                className={styles['input']}
                type="number"
                min={0}
                step={1}
                value={draft.immuneTurns ?? ''}
                disabled={busy}
                onChange={(event) => {
                  controller.setImmuneTurns(event.target.value === '' ? undefined : Number(event.target.value))
                }}
              />
            </div>
            <div className={styles['field']}>
              <label htmlFor="advisor-max-delta-messages" className={styles['fieldLabel']}>{t('maxDeltaMessages')}</label>
              <input
                id="advisor-max-delta-messages"
                aria-label={t('maxDeltaMessages')}
                className={styles['input']}
                type="number"
                min={0}
                step={1}
                value={draft.maxDeltaMessages ?? ''}
                disabled={busy}
                onChange={(event) => {
                  controller.setMaxDeltaMessages(event.target.value === '' ? undefined : Number(event.target.value))
                }}
              />
            </div>
          </div>
        </div>
        <div className={styles['footer']}>
          {errorText === undefined ? null : <p className={styles['failed']} role="status">{errorText}</p>}
          <button
            type="button"
            className={styles['discard']}
            disabled={discardDisabled}
            onClick={() => { controller.discard() }}
          >
            {t('discard')}
          </button>
          <button
            type="button"
            className={styles['save']}
            disabled={saveDisabled}
            onClick={() => { void controller.apply() }}
          >
            {t(saving ? 'saving' : 'save')}
          </button>
        </div>
      </div>
    )
  } else {
    // Loading (or the idle→loading transition): the header alone — an open
    // card shows an empty body (KD-U3).
    body = <div className={styles['body']} />
  }

  return (
    <li className={open ? `${styles['card']} ${styles['cardOpen']}` : styles['card']}>
      {header}
      {open ? body : null}
    </li>
  )
}
