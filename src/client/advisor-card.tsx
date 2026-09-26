/**
 * Advisor settings card (plan dsh-advisor-plugin-config-card-ux, task 1;
 * flat rebuild 2026-09-26 — plan dsh-advisor-web-config-flat-n10): the card
 * registered into the Plugins page's `plugins.bundle.config` keyed slot (key
 * `dsh-advisor` — the bundle's package name the page dispatches). It keeps
 * the n5 gateway channel — the store reads/writes the advisor config through
 * `/api/advisor/get` + `/api/advisor/set` (KD-G3) — while the layout is the
 * official settings-page language: NO collapsible box. The page already
 * renders the plugin title/description above the card (the `locale/*.json`
 * meta files the host resolves per UI language), so the fields tile directly
 * beneath it: provider select, model select (ALWAYS rendered — there is no
 * enable checkbox to gate them; the config-level `enabled` switch was removed
 * and the plugin-row toggle is the master switch), system-prompt textarea,
 * and the paired `immuneTurns`/`maxDeltaMessages` numbers; then the footer
 * with the failed message + Discard/Save carrying the upstream disabled
 * semantics — save = `!dirty || invalid || saving`, discard = `!dirty ||
 * saving` (KD-U1, Global Constraints). Save additionally carries `!writable`
 * and the store refuses writes outright in read-only environments (W-1, qc2
 * fix wave) — see the disabled-term comment in the ready branch. The former
 * collapsible chrome (header button, rotating chevron, dirty "unsaved" pill,
 * card-local disclosure state) is gone with the switch it mirrored: nothing
 * is hidden, so nothing needs disclosure state, and the readOnly / saved /
 * error / namespaceUnavailable notices are flat and always-on (the derived-
 * open semantics they used to ride — AC-1/AC-3 — have no surface left).
 *
 * The form behavior is unchanged from the card-form plan: provider/model
 * selects limited to the system-configured providers and their models
 * (KD-S2), the required-pair gate (KD-S4, also enforced in the store), and
 * Save writing the advisor config through the gateway channel (store →
 * `connection.rpc.call('/api', 'advisor/set', { patch })`). Discard rewinds
 * the draft to the last-known host config (client-side only — no gateway
 * write). The textarea's placeholder IS the built-in reviewer prompt
 * (`DEFAULT_ADVISOR_SYSTEM_PROMPT` — same-package import, a pure string
 * constant the bundler inlines; SSOT stays `src/prompts.ts`), so the field
 * shows exactly what an empty prompt inherits; the "leave empty" hint rides
 * below it.
 *
 * Presentation follows the official settings-form values via
 * `advisor-card.module.css` (12px field padding, 0.5px hairline separators,
 * 34px inputs, dark solid Save) — every color resolves through a
 * `--dsw-alias-*` token so the card adapts to the light/dark theme.
 *
 * A stored provider/model that is no longer among the current options
 * surfaces warning copy (`staleProvider`/`staleModel`) instead of blocking
 * Save: the user keeps the stored value (it still applies as stored) or
 * reselects — the host gate rejects truly invalid configurations on write.
 * Clearing a number input leaves the field empty; the store then omits that
 * key from the apply patch (the stored value stays unchanged).
 *
 * Degraded/error states keep the flat layout (KD-U3): the config-channel
 * notice or the load error + retry render as always-on blocks — a card that
 * cannot render its form shows that state on every render, including through
 * a background refresh of a degraded card (the store's latched `degraded`
 * keeps the notice up while `status === 'loading'`, qc1 S-2 fix wave).
 * When the last load could not reach the `advisor.get` gateway endpoint (the
 * gateway channel is down or not ready on this host), the form is replaced
 * by the `namespaceUnavailable` notice and Save is never offered, so the
 * page never presents a writable-looking editor whose writes the host would
 * refuse (KD-G5). Note: without a settings service the gateway's `get` still
 * succeeds (entry fallback — the form renders), while `set` fails with a
 * clear "settings service is unavailable" error; the notice covers channel
 * unreachability, not the no-settings-service case.
 */

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ApplyFailure, AdvisorSettingsState, AdvisorSettingsStore } from './advisor-store.ts'
import { DEFAULT_ADVISOR_SYSTEM_PROMPT } from '../prompts.ts'
import styles from './advisor-card.module.css'

/** Injected dependencies of {@link AdvisorCard} (slot `inject`). The `hooks`
 * compartment carries the bare snapshot store; the slot renderer binds it to
 * the `useSnapshot` selector hook the component consumes (host renderer contract). */
export interface AdvisorCardInjected {
  /** The card store (loaded on mount, refreshed on pushed invalidations). */
  controller: AdvisorSettingsStore
  /** Bare snapshot source the renderer binds as `useSnapshot`. */
  hooks: {
    snapshot: SnapshotStore<AdvisorSettingsState>
  }
}

/**
 * Props the renderer binds for the card: the `plugins.bundle.config` runtime
 * share (the owner passes the `view` the page asks for — this seat is
 * `page`-only), the framework-synthesized `t` seat for the declared
 * `settings.advisor` namespace (KD-1 — `t` is NOT part of the inject face),
 * and the registrant's business face.
 */
export type AdvisorCardProps =
  PropsRuntime<'plugins.bundle.config'>
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
 * Render the advisor card inside its bundle's configuration section on the
 * Plugins page — flat: the notices, the form, and the footer tile directly
 * under the page's plugin title/description, with no chrome of our own.
 * @param props - slot-delivered injected dependencies and the synthesized t seat.
 * @returns the card.
 */
export function AdvisorCard(props: AdvisorCardProps): ReactNode {
  const { controller, useSnapshot, t } = props
  const state = useSnapshot(snapshot => snapshot)

  // Load-on-mount (KD-3): the Plugins page mounts the card lazily when the
  // user opens the bundle's page, so the first mount triggers the first
  // gateway load — same idle→load() pattern the settings section used.
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
      <>
        {state.applyState.kind === 'saved' ? <p className={styles['savedNotice']} role="status">{t('saved')}</p> : null}
        <p className={styles['error']}>{`${t('loadFailed')}: ${state.error ?? ''}`}</p>
        <div className={styles['footer']}>
          {/* Retry reuses the `.discard` (secondary/outline) button look — the
              module's only secondary-button style; intentional reuse (qc1
              N-2). */}
          <button type="button" className={styles['discard']} onClick={() => { void controller.load() }}>
            {t('retry')}
          </button>
        </div>
      </>
    )
  }
  // `degraded` is the derived notion (qc1 S-2): while ready it IS
  // `!advisorPresent`; while loading it falls back to the store's LATCHED
  // last-settled degraded state. A background refresh flips status to
  // 'loading' while advisorPresent keeps its stale value, so the latch is
  // what keeps the config-channel notice visible through the refresh window —
  // and it is false on a first mount, so a healthy first load renders
  // nothing yet.
  const degraded = state.status === 'ready' ? !state.advisorPresent : state.degraded
  if (degraded) {
    // KD-G5 (the n2-era C-1 mitigation): when the last load could not reach
    // the `advisor.get` gateway endpoint (gateway not ready / channel down),
    // the form would present defaults + a writable-looking Save that can only
    // fail with a host refusal — render the explicit notice instead and never
    // offer Save. qc3 N-1 mirrors the error branch here too: a post-apply
    // reload that loses the gateway must not mask a landed write — the saved
    // line renders alongside the notice.
    return (
      <>
        {state.applyState.kind === 'saved' ? <p className={styles['savedNotice']} role="status">{t('saved')}</p> : null}
        <p className={styles['notice']} role="status">{t('namespaceUnavailable')}</p>
        <div className={styles['footer']}>
          {/* Retry reuses the `.discard` (secondary/outline) button look — the
              module's only secondary-button style; intentional reuse (qc1
              N-2). */}
          <button type="button" className={styles['discard']} onClick={() => { void controller.load() }}>
            {t('retry')}
          </button>
        </div>
      </>
    )
  }
  if (state.status !== 'ready') {
    // Loading (or the idle→loading transition): nothing yet — the flat card
    // has no header chrome to hold the space (the former empty body died
    // with the chrome).
    return null
  }
  const { draft, providers, writable, applyState } = state
  const providerEmpty = draft.provider === undefined
  const modelEmpty = draft.model === undefined
  // KD-S4: a missing provider/model blocks Save and shows the hints. The
  // gate is UNCONDITIONAL now — the config-level `enabled` switch that used
  // to make it conditional is gone (the row toggle is the switch), so the
  // form can only save a complete pair.
  const gateFailed = providerEmpty || modelEmpty
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
  // and both actions stay disabled through the !dirty term. W-1 (qc2 fix
  // wave): the dirty-implies-writable assumption does NOT hold for this
  // in-place-draft store — a mid-session invalidation refresh can return
  // writable=false while staged edits survive (dirty stays true), so Save
  // additionally carries `!writable` (restoring the pre-plan Apply, which
  // was always disabled when !writable).
  const saveDisabled = !state.dirty || gateFailed || saving || !writable
  // Discard KEEPS `!dirty || saving` BY DESIGN: it is a pure client-side
  // revert to the last-known seed (no gateway write) — disabling it in
  // read-only would strand staged edits the user cannot clear, and the
  // store-side writable guard (advisor-store.ts apply()) makes a read-only
  // write fail cleanly even if it were reached.
  const discardDisabled = !state.dirty || saving
  return (
    <>
      {!writable ? <p className={styles['readOnly']} role="status">{t('readOnly')}</p> : null}
      {applyState.kind === 'saved' ? <p className={styles['savedNotice']} role="status">{t('saved')}</p> : null}
      <div className={styles['form']}>
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
        <div className={styles['field']}>
          <label htmlFor="advisor-system-prompt" className={styles['fieldLabel']}>{t('systemPrompt')}</label>
          <textarea
            id="advisor-system-prompt"
            aria-label={t('systemPrompt')}
            // The placeholder IS the built-in reviewer prompt (SSOT
            // src/prompts.ts): the field shows exactly what an empty prompt
            // inherits, and the hint below carries the leave-empty contract.
            placeholder={DEFAULT_ADVISOR_SYSTEM_PROMPT}
            className={styles['textarea']}
            value={draft.systemPrompt}
            disabled={busy}
            onChange={(event) => { controller.setSystemPrompt(event.target.value) }}
          />
          <p className={styles['hint']}>{t('systemPromptHint')}</p>
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
    </>
  )
}
