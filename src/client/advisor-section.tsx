/**
 * Advisor settings section (plan dsh-advisor-settings-n5, task 2): the full
 * form — `enabled` switch (default off), `provider`/`model` select boxes
 * limited to the system-configured providers and their models (KD-S2), the
 * required-when-enabled gate (KD-S4, also enforced in the store), the
 * `systemPrompt` textarea, the `immuneTurns`/`maxDeltaMessages` number inputs,
 * and Apply writing the advisor config through the host gateway channel
 * (store → `connection.rpc.call('/api', 'advisor/set', { patch })`).
 *
 * Presentation: the settings-panel design language (ModelsSection
 * vocabulary) via `advisor-section.module.css` — the section column, the form
 * grouped in one outlined card, 32px fields with the shared select chevron,
 * capsule Apply, and 12/18 hint tones. Every color resolves through a
 * `--dsw-alias-*` token so the section adapts to the light/dark theme.
 *
 * A stored provider/model that is no longer among the current options
 * surfaces warning copy (`staleProvider`/`staleModel`) instead of blocking
 * Apply: the user keeps the stored value (it still applies as stored) or
 * reselects — the host gate rejects truly invalid configurations on write.
 * Clearing a number input leaves the field empty; the store then omits that
 * key from the apply patch (the stored value stays unchanged).
 *
 * When the last load could not reach the `advisor.get` gateway endpoint (the
 * gateway is not ready on this host — no settings service, or the channel is
 * down), the form is replaced by the `namespaceUnavailable` notice and Apply
 * is never offered, so the page never presents a writable-looking editor
 * whose writes the host would refuse (KD-G5, the n2-era C-1 mitigation).
 */

import type { ReactNode } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { ApplyFailure, AdvisorSettingsState, AdvisorSettingsStore } from './advisor-store.ts'
import type { en } from './locales.ts'
import styles from './advisor-section.module.css'

/** Injected dependencies of {@link AdvisorSection} (slot `inject`). */
export interface AdvisorSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: AdvisorSettingsStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<AdvisorSettingsState>
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type AdvisorSectionProps = Partial<AdvisorSectionInjected>

/**
 * Render the Advisor section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function AdvisorSection(props: AdvisorSectionProps): ReactNode {
  const { controller, useSnapshot, t } = props
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  return <Loaded injected={{ controller, useSnapshot, t }} />
}

/** Copy for an apply failure; the gate failure renders as the inline hints instead. */
function failureCopy(failure: ApplyFailure, t: AdvisorSectionInjected['t']): string | undefined {
  switch (failure.kind) {
    case 'gate': return undefined
    case 'message': return failure.message
  }
}

function Loaded({ injected }: { injected: AdvisorSectionInjected }): ReactNode {
  const { controller, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    // A post-apply reload failure must not mask a landed write: the saved
    // feedback renders alongside the error + retry (qc3 N-1).
    return (
      <div className={styles['section']}>
        <h2 className={styles['title']}>{t('title')}</h2>
        {state.applyState.kind === 'saved' ? <p className={styles['savedNotice']} role="status">{t('saved')}</p> : null}
        <p className={styles['error']}>{`${t('loadFailed')}: ${state.error ?? ''}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }
  if (state.status !== 'ready') return <h2 className={styles['title']}>{t('title')}</h2>

  // KD-G5 (the n2-era C-1 mitigation): when the last load could not reach the
  // `advisor.get` gateway endpoint (gateway not ready / channel down), the
  // form would present defaults + a writable-looking Apply that can only fail
  // with a host refusal — render the explicit notice instead and never offer
  // Apply. qc3 N-1 mirrors here too: a post-apply reload that loses the
  // gateway must not mask a landed write — the saved line renders alongside
  // the notice.
  if (!state.advisorPresent) {
    return (
      <div className={styles['section']}>
        <h2 className={styles['title']}>{t('title')}</h2>
        <p className={styles['intro']}>{t('intro')}</p>
        {state.applyState.kind === 'saved' ? <p className={styles['savedNotice']} role="status">{t('saved')}</p> : null}
        <p className={styles['notice']} role="status">{t('namespaceUnavailable')}</p>
      </div>
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
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {!writable ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {applyState.kind === 'saved' ? <p className={styles['savedNotice']} role="status">{t('saved')}</p> : null}
      <div className={styles['card']}>
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
          <button type="button" className={styles['primaryButton']} disabled={busy || gateFailed} onClick={() => { void controller.apply() }}>
            {saving ? t('applying') : t('apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
