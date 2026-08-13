/**
 * Advisor settings plugin, browser half. Registers the `advisor` card into
 * the shell-declared `settings.plugin.item` slot (the "插件配置" settings
 * page — id `advisor`, order 30, after the upstream bash / agent-loop /
 * web-search cards). The card's store joins the settings namespaces and the
 * provider directory through the connection wire, and keeps fresh on pushed
 * invalidations. Export discipline: the client half value-imports ONLY the
 * frozen platform module table (CLIENT_EXTERNALS: react /
 * @deepseek-ai/cordis / ui-slots / web-react / ui-primitives /
 * schema-form / the documented `@deepseek-ai/dsh-client-runtime/client`
 * exemption); every other `@deepseek-ai/*` import is type-only (erased at
 * build) — values arrive via cordis injection (`ctx.get('connection')`, slot
 * inject faces). Mirrors the ui-models reference entry.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: pulls the plugin-config card slot's SlotMap merge (the
// 'settings.plugin.item' entry — this half's registration target). Same empty
// type-only import pattern as the old ui-settings one: it loads the module's
// types (the ./client entry re-exports the slot-contract merge) without any
// value import.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AdvisorCard } from './advisor-card.tsx'
import { AdvisorSettingsStore, refreshIfLoaded } from './advisor-store.ts'
import { en, zh, type AdvisorKey } from './locales.ts'

export type { AdvisorCardInjected, AdvisorCardProps } from './advisor-card.tsx'
export type { AdvisorKey } from './locales.ts'
export type {
  AdvisorDraft, AdvisorSettingsState, AdvisorSettingsStore, ApplyFailure, ApplyState,
  ModelOption, ModelsEmptyReason, ProviderOption,
} from './advisor-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Advisor settings card copy. */
    'settings.advisor': AdvisorKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.advisor'

// `refreshIfLoaded` lives next to the store (pure controller helper): refetch
// the page snapshot only after its first load — an unopened Advisor card must
// not fetch on background invalidations. Re-exported here to keep the client
// entry's value surface stable across the task-2 skeleton.
export { refreshIfLoaded } from './advisor-store.ts'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-plugin-config's apply, whose activation order relative to this one is
 * NOT constrained; registration depends on the slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the Advisor card once the `settings.plugin.item` declaration is on
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

  // Pushed invalidations converge the open surface without polling. The
  // 20260811 dsh snapshot removed the `settings/changed` / `models/changed`
  // host passthroughs from the client runtime Events vocabulary (no
  // replacement exists there), so convergence rides `connection/reset` — a
  // connection reset invalidates the whole client state (the upstream
  // `dsh-client-ui-settings` scope uses the same signal). Same-host config
  // changes land via the page's own load path. A burst of resets coalesces
  // into a single refetch via the microtask debounce — events in separate
  // ticks each trigger a load, and `refreshIfLoaded` keeps an unopened card
  // idle.
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

  // KD-1: the card registers into the plugin-config page's card slot with the
  // upstream card shape — generator + `yield`, `locale: NS`, and an inject
  // face carrying ONLY the business surface (controller + useSnapshot). The
  // typed `t` seat is synthesized by the renderer from `locale: NS`
  // (PropsLocale<'settings.advisor'>), exactly like the upstream three cards;
  // the old `settings.section` registration (the side-bar "Advisor" nav) is
  // removed — deleting the section registration deletes the nav entry.
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'advisor',
      order: 30, // bash 0 / agent-loop 10 / web-search 20 / advisor 30
      locale: NS,
      inject: () => ({ controller, useSnapshot }),
    }, AdvisorCard)
  })
}
