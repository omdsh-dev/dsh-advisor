/**
 * Advisor settings plugin, browser half. Registers the `advisor` nav entry
 * into the shell-declared `settings.section` slot. The section's store joins
 * the settings namespaces and the provider directory through the connection
 * wire, and keeps fresh on pushed invalidations. Export discipline: the
 * client half value-imports ONLY the frozen platform module table
 * (CLIENT_EXTERNALS: react / cordis / ui-slots / web-react / ui-primitives /
 * schema-form / the documented `@deepseek-ai/dsh-client-runtime/client`
 * exemption); every other `@deepseek-ai/*` import is type-only (erased at
 * build) — values arrive via cordis injection (`ctx.get('connection')`, slot
 * inject faces). Mirrors the ui-models reference entry.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AdvisorSection } from './advisor-section.tsx'
import type { AdvisorSectionInjected } from './advisor-section.tsx'
import { AdvisorSettingsStore } from './advisor-store.ts'
import { en, zh, type AdvisorKey } from './locales.ts'

export type { AdvisorSectionInjected, AdvisorSectionProps } from './advisor-section.tsx'
export type { AdvisorKey } from './locales.ts'
export type { AdvisorSettingsState, AdvisorSettingsStore } from './advisor-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Advisor settings section copy. */
    'settings.advisor': AdvisorKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.advisor'

/**
 * Refetch the page snapshot only after its first load: an unopened Advisor
 * page must not fetch on background invalidations.
 * @param controller - the page store.
 */
export function refreshIfLoaded(controller: AdvisorSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on each slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the Advisor section once the `settings.section` declaration is on
 * the ledger, wire its store to the connection, and keep it fresh on every
 * pushed invalidation (settings or provider topology).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'advisor: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new AdvisorSettingsStore(connection.api)
  const useSnapshot = bindSnapshotSelector(controller.store)
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as AdvisorSectionInjected['t']
  const injected = (): AdvisorSectionInjected => ({
    controller,
    useSnapshot,
    t,
  })

  // Pushed invalidations converge the open surface without polling: any
  // settings or provider-topology change refetches once the page loaded.
  ctx.effect(() => {
    const refresh = (): void => { refreshIfLoaded(controller) }
    const disposers = [
      ctx.on('settings/changed', refresh),
      ctx.on('models/changed', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'advisor: pushed invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'advisor',
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, AdvisorSection))
}
