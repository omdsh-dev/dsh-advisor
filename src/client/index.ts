/**
 * Advisor settings plugin, browser half. Registers the `advisor` nav entry
 * into the shell-declared `settings.section` slot. The section's store joins
 * the settings namespaces and the provider directory through the connection
 * wire, and keeps fresh on pushed invalidations. Export discipline: the
 * client half value-imports ONLY the frozen platform module table
 * (CLIENT_EXTERNALS: react / @deepseek-ai/cordis / ui-slots / web-react / ui-primitives /
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
// Type-only: pulls the plugin-config card slot's SlotMap merge (the
// 'settings.plugin.item' entry — the Task-2 registration target). Same empty
// type-only import pattern as ui-settings: it loads the module's types (the
// ./client entry re-exports the slot-contract merge) without any value import.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-config/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AdvisorSection } from './advisor-section.tsx'
import type { AdvisorSectionInjected } from './advisor-section.tsx'
import { AdvisorSettingsStore, refreshIfLoaded } from './advisor-store.ts'
import { en, zh, type AdvisorKey } from './locales.ts'

export type { AdvisorSectionInjected, AdvisorSectionProps } from './advisor-section.tsx'
export type { AdvisorKey } from './locales.ts'
export type {
  AdvisorDraft, AdvisorSettingsState, AdvisorSettingsStore, ApplyFailure, ApplyState,
  ModelOption, ModelsEmptyReason, ProviderOption,
} from './advisor-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Advisor settings section copy. */
    'settings.advisor': AdvisorKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.advisor'

// `refreshIfLoaded` lives next to the store (pure controller helper): refetch
// the page snapshot only after its first load — an unopened Advisor page must
// not fetch on background invalidations. Re-exported here to keep the client
// entry's value surface stable across the task-2 skeleton.
export { refreshIfLoaded } from './advisor-store.ts'

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
  // The store reads/writes the advisor config over the connection's generic
  // RPC channel (the host gateway `/api/advisor/get` + `/api/advisor/set`);
  // the provider/model directory still rides `connection.api` (KD-G3).
  const controller = new AdvisorSettingsStore(connection.api, connection.rpc)
  const useSnapshot = bindSnapshotSelector(controller.store)
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as AdvisorSectionInjected['t']
  const injected = (): AdvisorSectionInjected => ({
    controller,
    useSnapshot,
    t,
  })

  // Pushed invalidations converge the open surface without polling. The
  // 20260811 dsh snapshot removed the `settings/changed` / `models/changed`
  // host passthroughs from the client runtime Events vocabulary (no
  // replacement exists there), so convergence rides `connection/reset` — a
  // connection reset invalidates the whole client state (the upstream
  // `dsh-client-ui-settings` scope uses the same signal). Same-host config
  // changes land via the page's own load path. A burst of resets coalesces
  // into a single refetch via the microtask debounce (qc3 N-2) — events in
  // separate ticks each trigger a load, and `refreshIfLoaded` keeps an
  // unopened page idle.
  ctx.effect(() => {
    let pending = false
    const refresh = (): void => {
      if (pending) return
      pending = true
      queueMicrotask(() => {
        pending = false
        refreshIfLoaded(controller)
      })
    }
    const disposers = [ctx.on('connection/reset', refresh)]
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
