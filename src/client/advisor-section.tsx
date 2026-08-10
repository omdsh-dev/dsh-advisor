/**
 * Advisor settings section (plan dsh-advisor-settings-n2, task 3): the full
 * form — `enabled` switch (default off), `provider`/`model` select boxes
 * limited to the system-configured providers and their models (KD-S2), the
 * required-when-enabled gate (KD-S4, also enforced in the store), the
 * `systemPrompt` textarea, the `immuneTurns`/`maxDeltaMessages` number inputs,
 * and Apply/Cancel writing the `advisor` namespace user layer through the
 * store (`settings.mutate` path ops + `expectedRevision`).
 *
 * CSS-free on purpose: the CSS-modules loader + `<style data-plugin>` injection
 * stays deferred until styles are actually needed (the T2 build-script
 * extension point); semantic plain elements keep the bundle contract minimal.
 *
 * A stored provider/model that is no longer among the current options
 * surfaces warning copy (`staleProvider`/`staleModel`) instead of blocking
 * Apply: the user keeps the stored value (it still applies as stored) or
 * reselects — the host gate rejects truly invalid configurations on write.
 * Clearing a number input leaves the field empty; the store then omits that
 * key from the apply ops (the stored value stays unchanged).
 *
 * When the last describe carried no `advisor` namespace view (a host build
 * that does not expose the namespace — the C-1 exposure boundary), the form
 * is replaced by the `namespaceUnavailable` notice and Apply is never
 * offered, so the page never presents a writable-looking editor whose writes
 * the host would refuse (qc2 W-2 / qc1 S-4).
 */

import type { ReactNode } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { ApplyFailure, AdvisorSettingsState, AdvisorSettingsStore } from './advisor-store.ts'
import type { en } from './locales.ts'

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
    case 'conflict': return t('conflict')
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
      <div>
        <h2>{t('title')}</h2>
        {state.applyState.kind === 'saved' ? <p role="status">{t('saved')}</p> : null}
        <p>{`${t('loadFailed')}: ${state.error ?? ''}`}</p>
        <button type="button" onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }
  if (state.status !== 'ready') return <h2>{t('title')}</h2>

  // qc2 W-2 / qc1 S-4 (the C-1 mitigation): when the last describe carried no
  // `advisor` namespace view (host build does not expose it), the form would
  // present defaults + a writable-looking Apply that can only fail with a
  // host refusal — render the explicit notice instead and never offer Apply.
  if (!state.advisorPresent) {
    return (
      <div>
        <h2>{t('title')}</h2>
        <p>{t('intro')}</p>
        <p role="status">{t('namespaceUnavailable')}</p>
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
    : state.modelsByProvider.get(draft.provider) ?? []
  const modelsEmpty = draft.provider !== undefined && state.modelsEmptyReason.has(draft.provider)
  // Stored values that are no longer among the current options: warn instead
  // of silently dropping them; Apply stays enabled (keep or reselect).
  const providerStale = draft.provider !== undefined
    && !providers.some(option => option.provider === draft.provider)
  const modelStale = !providerStale && draft.model !== undefined
    && selectedModels.length > 0
    && !selectedModels.some(option => option.id === draft.model)
  const errorText = applyState.kind === 'error' ? failureCopy(applyState.failure, t) : undefined

  return (
    <div>
      <h2>{t('title')}</h2>
      <p>{t('intro')}</p>
      {!writable ? <p>{t('readOnly')}</p> : null}
      {applyState.kind === 'saved' ? <p role="status">{t('saved')}</p> : null}
      <div>
        <label htmlFor="advisor-enabled">{t('enabled')}</label>
        <input
          id="advisor-enabled"
          type="checkbox"
          checked={draft.enabled}
          disabled={busy}
          onChange={(event) => { controller.setEnabled(event.target.checked) }}
        />
      </div>
      {draft.enabled
        ? (
          <fieldset>
            <div>
              <label htmlFor="advisor-provider">{t('provider')}</label>
              <select
                id="advisor-provider"
                aria-label={t('provider')}
                value={draft.provider ?? ''}
                disabled={busy}
                onChange={(event) => { controller.setProvider(event.target.value) }}
              >
                <option value="">{t('providerPlaceholder')}</option>
                {providers.map(option => (
                  <option key={option.provider} value={option.provider}>{option.displayName}</option>
                ))}
              </select>
              {providers.length === 0 ? <p>{t('noProviders')}</p> : null}
              {providerEmpty ? <p>{t('providerRequired')}</p> : null}
              {providerStale ? <p>{t('staleProvider')}</p> : null}
            </div>
            <div>
              <label htmlFor="advisor-model">{t('model')}</label>
              <select
                id="advisor-model"
                aria-label={t('model')}
                value={draft.model ?? ''}
                disabled={busy || draft.provider === undefined || selectedModels.length === 0}
                onChange={(event) => { controller.setModel(event.target.value) }}
              >
                <option value="">{t('modelPlaceholder')}</option>
                {selectedModels.map(option => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
              {modelsEmpty ? <p>{t('noModels')}</p> : null}
              {modelStale ? <p>{t('staleModel')}</p> : null}
              {!providerEmpty && modelEmpty ? <p>{t('modelRequired')}</p> : null}
            </div>
          </fieldset>
        )
        : null}
      <div>
        <label htmlFor="advisor-system-prompt">{t('systemPrompt')}</label>
        <textarea
          id="advisor-system-prompt"
          aria-label={t('systemPrompt')}
          value={draft.systemPrompt}
          disabled={busy}
          onChange={(event) => { controller.setSystemPrompt(event.target.value) }}
        />
      </div>
      <div>
        <label htmlFor="advisor-immune-turns">{t('immuneTurns')}</label>
        <input
          id="advisor-immune-turns"
          aria-label={t('immuneTurns')}
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
      <div>
        <label htmlFor="advisor-max-delta-messages">{t('maxDeltaMessages')}</label>
        <input
          id="advisor-max-delta-messages"
          aria-label={t('maxDeltaMessages')}
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
      {errorText === undefined ? null : <p role="alert">{errorText}</p>}
      <button type="button" disabled={busy || gateFailed} onClick={() => { void controller.apply() }}>
        {saving ? t('applying') : t('apply')}
      </button>
      <button type="button" disabled={saving} onClick={() => { controller.resetDraft() }}>
        {t('cancel')}
      </button>
    </div>
  )
}
