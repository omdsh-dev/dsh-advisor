/**
 * Advisor settings section (task-2 skeleton): mounts the page store on first
 * render, shows the load status, and renders an empty placeholder until task 3
 * lands the full form (enabled switch, configured-provider/model selectors,
 * required-gate, Apply). CSS-free on purpose — task 2 keeps the bundle
 * contract minimal (no CSS-modules loader yet); task 3 introduces styling.
 */

import type { ReactNode } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { AdvisorSettingsState, AdvisorSettingsStore } from './advisor-store.ts'
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

function Loaded({ injected }: { injected: AdvisorSectionInjected }): ReactNode {
  const { controller, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    return (
      <div>
        <h2>{t('title')}</h2>
        <p>{`${t('loadFailed')}: ${state.error ?? ''}`}</p>
        <button type="button" onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  return (
    <div>
      <h2>{t('title')}</h2>
      <p>{t('intro')}</p>
      <p>{t('skeleton')}</p>
    </div>
  )
}
