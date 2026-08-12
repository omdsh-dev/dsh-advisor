/**
 * Advisor settings card (plan dsh-advisor-plugin-config-card, task 2): the
 * card registered into the "插件配置" settings page's `settings.plugin.item`
 * slot (id `advisor`, order 30). It keeps the n5 gateway channel — the store
 * reads/writes the advisor config through `/api/advisor/get` +
 * `/api/advisor/set` (KD-G3) — and the n3 design language; only the
 * registration surface changed (section → card, KD-1/KD-2).
 *
 * The full form: `enabled` switch (default off), `provider`/`model` select
 * boxes limited to the system-configured providers and their models (KD-S2),
 * the required-when-enabled gate (KD-S4, also enforced in the store), the
 * `systemPrompt` textarea, the `immuneTurns`/`maxDeltaMessages` number inputs,
 * and Apply writing the advisor config through the gateway channel (store →
 * `connection.rpc.call('/api', 'advisor/set', { patch })`). Discard rewinds
 * the draft to the last-known host config (client-side only — no gateway
 * write). The card chrome (title/description/save/discard) is self-drawn in
 * the plugin's own design language (KD-4): the upstream plugin-config client
 * value face exports no reusable card components.
 *
 * Presentation: the settings-panel design language via
 * `advisor-card.module.css` — the card column, the form grouped in one
 * outlined surface, 32px fields with the shared select chevron, capsule
 * Save/Discard, and 12/18 hint tones. Every color resolves through a
 * `--dsw-alias-*` token so the card adapts to the light/dark theme.
 *
 * A stored provider/model that is no longer among the current options
 * surfaces warning copy (`staleProvider`/`staleModel`) instead of blocking
 * Apply: the user keeps the stored value (it still applies as stored) or
 * reselects — the host gate rejects truly invalid configurations on write.
 * Clearing a number input leaves the field empty; the store then omits that
 * key from the apply patch (the stored value stays unchanged).
 *
 * When the last load could not reach the `advisor.get` gateway endpoint (the
 * gateway channel is down or not ready on this host), the form is replaced by
 * the `namespaceUnavailable` notice and Apply is never offered, so the page
 * never presents a writable-looking editor whose writes the host would refuse
 * (KD-G5). Note: without a settings service the gateway's `get` still
 * succeeds (entry fallback — the form renders), while `set` fails with a
 * clear "settings service is unavailable" error; the notice covers channel
 * unreachability, not the no-settings-service case.
 */

import type { ReactNode } from 'react'
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
 * Render the advisor card inside the plugin-config section.
 * @param props - slot-delivered injected dependencies and the synthesized t seat.
 * @returns the card.
 */
export function AdvisorCard(props: AdvisorCardProps): ReactNode {
  const { controller, useSnapshot, t } = props
  const state = useSnapshot(snapshot => snapshot)

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
  if (state.status === 'error') {
    // A post-apply reload failure must not mask a landed write: the saved
    // feedback renders alongside the error + retry.
    return (
      <li className={styles['card']}>
        <h3 className={styles['title']}>{t('title')}</h3>
        {state.applyState.kind === 'saved' ? <p className={styles['savedNotice']} role="status">{t('saved')}</p> : null}
        <p className={styles['error']}>{`${t('loadFailed')}: ${state.error ?? ''}`}</p>
        <div className={styles['editorActions']}>
          <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
            {t('retry')}
          </button>
        </div>
      </li>
    )
  }
  if (state.status !== 'ready') return <li className={styles['card']}><h3 className={styles['title']}>{t('title')}</h3></li>

  // KD-G5 (the n2-era C-1 mitigation): when the last load could not reach the
  // `advisor.get` gateway endpoint (gateway not ready / channel down), the
  // form would present defaults + a writable-looking Apply that can only fail
  // with a host refusal — render the explicit notice instead and never offer
  // Apply. qc3 N-1 mirrors here too: a post-apply reload that loses the
  // gateway must not mask a landed write — the saved line renders alongside
  // the notice.
  if (!state.advisorPresent) {
    return (
      <li className={styles['card']}>
        <h3 className={styles['title']}>{t('title')}</h3>
        <p className={styles['intro']}>{t('intro')}</p>
        {state.applyState.kind === 'saved' ? <p className={styles['savedNotice']} role="status">{t('saved')}</p> : null}
        <p className={styles['notice']} role="status">{t('namespaceUnavailable')}</p>
      </li>
    )
  }

  const { draft, providers, writable, applyState } = state
  const providerEmpty = draft.provider === undefined
  const modelEmpty = draft.model === undefined
  // KD-S4: enabled + missing provider/model blocks Apply and shows the hints.
  const gateFailed = draft.enabled && (providerEmpty || modelEmpty)
  const saving = applyState.kind === 'saving'
  const busy = !writable || saving
  const selectedModels = draft.provider === undefined
    ? []
    : state.modelsByProvider[draft.provider] ?? []
  const modelsEmpty = draft.provider !== undefined && Object.hasOwn(state.modelsEmptyReason, draft.provider)
  // Stored values that are no longer among the current options: warn instead
  // of silently dropping them; Apply stays enabled (keep or reselect).
  const providerStale = draft.provider !== undefined
    && !providers.some(option => option.provider === draft.provider)
  const modelStale = !providerStale && draft.model !== undefined
    && selectedModels.length > 0
    && !selectedModels.some(option => option.id === draft.model)
  const errorText = applyState.kind === 'error' ? failureCopy(applyState.failure, t) : undefined

  return (
    <li className={styles['card']}>
      <h3 className={styles['title']}>{t('title')}</h3>
      <p className={styles['intro']}>{t('intro')}</p>
      {!writable ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
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
        {errorText === undefined ? null : <p className={styles['error']} role="alert">{errorText}</p>}
        <div className={styles['editorActions']}>
          <button type="button" className={styles['secondaryButton']} disabled={busy} onClick={() => { controller.discard() }}>
            {t('discard')}
          </button>
          <button type="button" className={styles['primaryButton']} disabled={busy || gateFailed} onClick={() => { void controller.apply() }}>
            {saving ? t('applying') : t('apply')}
          </button>
        </div>
      </div>
    </li>
  )
}
