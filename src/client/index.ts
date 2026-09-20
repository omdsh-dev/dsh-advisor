/**
 * Advisor settings plugin, browser half. Registers the Advisor card into the
 * shell-declared `plugins.bundle.config` keyed slot (the Plugins page's
 * per-bundle configuration seat — key `dsh-advisor`, the bundle's package name
 * the page dispatches, rendered on the bundle's own page between its
 * description and its rows). The card's store joins the settings namespaces
 * and the provider directory through the connection wire, and keeps fresh on
 * pushed invalidations. Export discipline: the client half value-imports ONLY the
 * frozen platform module table (CLIENT_EXTERNALS: react /
 * `@deepseek-ai/cordis` / ui-slots / ui-primitives / the documented
 * `@deepseek-ai/dsh-client-store` exemption); every other
 * `@deepseek-ai/*` import is type-only (erased at build) — values arrive via
 * cordis injection (`ctx.get('connection')`, slot inject faces, the
 * `settingsSchema` service). Mirrors the ui-models reference entry.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the Plugins page's config card slot SlotMap merge (the
// 'plugins.bundle.config' entry — this half's registration target, declared by
// ui-plugin-manager). Same empty type-only import pattern as the old
// ui-settings one: it loads the module's types (the ./client entry re-exports
// the slot-contract merge) without any value import.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-settings' Context merge (ctx.settingsSchema — the
// home of the immutable schema path writers the store needs).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the client Remote assembly's Context merge (ctx.remote)
// and the generated namespace surface (remote.llm / remote.settings /
// remote.session — the alpha.2 replacement for the removed `connection.api`
// wire face the store previously read the provider directory from).
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-llm/remote'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
// Type-only: pulls the forwarded-Host-event selection (the legal key set of
// `ctx.remote.$on` — API_REMOTE_FORWARDED_EVENTS in @deepseek-ai/dsh-api-remotes):
// `settings/document-updated` + `llm/adapters-updated` below.
import type {} from '@deepseek-ai/dsh-api-remotes/types'
// Type-only: pulls the renderer's Context merge (ctx.slots — the SlotRegistry
// seat the card registers into; the seat moved from dsh-client-runtime to the
// ui-renderer in the alpha.2 line).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
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

/**
 * The bundle's package name — the key the Plugins page dispatches
 * `plugins.bundle.config` with (ui-plugin-manager's `PackageDetail` renders the
 * entry with `entryKey = pkg.name`). Spelled as a literal for the same reason
 * the settings namespace is: `package.json` sits outside the client bundle's
 * module graph.
 */
const BUNDLE_NAME = 'dsh-advisor'

// `refreshIfLoaded` lives next to the store (pure controller helper): refetch
// the page snapshot only after its first load — an unopened Advisor card must
// not fetch on background invalidations. Re-exported here to keep the client
// entry's value surface stable across the task-2 skeleton.
export { refreshIfLoaded } from './advisor-store.ts'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-plugin-manager's apply (its `plugins` main-panel entry), whose activation
 * order relative to this one is NOT constrained; registration depends on the
 * slot through `slots.inject()`.
 *
 * rc.1 dotted-namespace contract: each client Remote namespace is a
 * child-fiber service named `remote.<ns>` (upstream `remoteServiceKey`), and
 * the traceable proxy forwards `ctx.remote.llm` / `.settings` / `.session`
 * to those context properties — consumers MUST declare the dotted names
 * here or the fiber walk throws `cannot get property "remote.llm" without
 * inject`. `remote` stays for the `$on` invalidation face; `connection` for
 * the `connection.rpc` gateway channel. Reference shape:
 * ../deepseek-harness/packages/client/ui-settings-models/src/client/index.ts.
 */
export const inject = ['slots', 'locale', 'connection', 'settingsSchema', 'remote', 'remote.llm', 'remote.settings', 'remote.session']

/**
 * Register the Advisor card once the `plugins.bundle.config` declaration is on
 * the ledger, wire its store to the connection, and keep it fresh on every
 * pushed invalidation (settings or provider topology).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'advisor: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  // The store reads/writes the advisor config over the connection's generic
  // RPC channel (the host gateway `/api/advisor/get` + `/api/advisor/set`);
  // the provider/model directory rides the client Remote assembly (`remote`
  // — injected above; KD-G3; the dotted `remote.llm` / `remote.settings` /
  // `remote.session` namespaces are declared in `inject` per the rc.1
  // dotted-namespace contract).
  const controller = new AdvisorSettingsStore(ctx.remote, connection.rpc, ctx.settingsSchema)

  // Pushed invalidations converge the open surface without polling. Two
  // planes feed the shared microtask debounce:
  // - `connection/reset` (ctx.on): a connection reset invalidates the whole
  //   client state (the upstream `dsh-client-ui-settings` scope uses the same
  //   signal — its `SettingsScopeBinder` also subscribes to the remote
  //   settings event below);
  // - the granular Host invalidation events forwarded to the client remote
  //   face (`ctx.remote.$on`; legal key set = `API_REMOTE_FORWARDED_EVENTS`
  //   in @deepseek-ai/dsh-api-remotes): `settings/document-updated` (a
  //   settings namespace document changed on the host — e.g. a provider
  //   section edited on the Models page) and `llm/adapters-updated`
  //   (provider/model topology mutation — e.g. a model added on the Models
  //   page). The 20260811 dsh snapshot removed the old `settings/changed` /
  //   `models/changed` host passthroughs from the client runtime Events
  //   vocabulary; the forwarded-event allowlist is their replacement (plan
  //   003 / status R3 — restores same-host live convergence without a
  //   reconnect).
  // `remote` is injected above (the client Remote assembly is the store's
  // provider-directory wire, so it is a hard registration dependency; its
  // dotted namespace services `remote.llm` / `remote.settings` /
  // `remote.session` are declared in `inject` — rc.1 dotted-namespace
  // contract). A burst of invalidations coalesces into a single refetch via
  // the microtask debounce — events in separate ticks each trigger a load,
  // and `refreshIfLoaded` keeps an unopened card idle.
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
    const disposers: Array<() => void> = [ctx.on('connection/reset', refresh)]
    // Deliberately unfiltered: the store reads the whole settings surface
    // (provider directory + all namespaces + advisor config), so a
    // namespace filter (upstream SettingsScopeBinder applies one) would
    // miss provider-section changes; the microtask debounce + load()'s
    // generation guard bound the cost.
    disposers.push(ctx.remote.$on('settings/document-updated', refresh))
    disposers.push(ctx.remote.$on('llm/adapters-updated', refresh))
    return () => { for (const dispose of disposers) dispose() }
  }, 'advisor: pushed invalidations')

  // KD-1: the card registers into the Plugins page's bundle-config seat with
  // the upstream config-entry shape — generator + `yield`, `locale: NS`, and
  // an inject face carrying ONLY the business surface (controller +
  // useSnapshot). The typed `t` seat is synthesized by the renderer from
  // `locale: NS` (PropsLocale<'settings.advisor'>), exactly like the upstream
  // cards. The seat moved in the 0.1.6-alpha.2 line: the 0.1.5-rc.2
  // `settings.plugin.item` keyed slot (key = the settings namespace the card
  // edits) is gone, and the Plugins page (ui-plugin-manager) now declares
  // `plugins.bundle.config` (key = the bundle's package name) plus
  // `plugins.row.config` (key = `<package name>#<row id>`). A bundle's own
  // configuration belongs in one of those two; this bundle ships one row, and
  // its card edits the whole bundle's `advisor` configuration, so the
  // bundle-level seat is the faithful migration. The old `settings.section`
  // registration (the side-bar "Advisor" nav) stays removed.
  ctx.slots.inject('plugins.bundle.config', function* () {
    yield ctx.slots.register({
      name: 'plugins.bundle.config',
      // Keyed slot: the key is the bundle package name the page dispatches
      // (`entryKey = pkg.name` in ui-plugin-manager's PackageDetail). Keyed
      // entries declare no `id`/`order` — there is one entry per bundle page.
      key: BUNDLE_NAME,
      locale: NS,
      // Hooks compartment: the renderer binds `hooks.snapshot` to the
      // component's `useSnapshot` selector hook (the old web-react
      // bindSnapshotSelector call is gone with that package).
      inject: () => ({ controller, hooks: { snapshot: controller.store } }),
    }, AdvisorCard)
  })
}
