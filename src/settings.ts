/**
 * T1 (plan dsh-advisor-settings-n2) — host-side `advisor` settings namespace
 * + live source wiring.
 *
 * The plugin-row config (the `entry` passed to the plugin's `apply`) is the
 * composition BASE of the `advisor` settings namespace: when a dsh settings
 * service is mounted, its user layer is layered on top (schema defaults →
 * base → user layer) and the runtime reads the live resolved value through
 * the bridge's `source` thunk — the same source-thunk pattern as dsh's
 * `agent-default-model`. Without a settings service the conditional
 * `ctx.inject(['settings'], ...)` child never activates and the source is
 * exactly the entry: behavior identical to today.
 *
 * The hard gate is untouched: the source returns the RAW composed config and
 * every consumer passes it through `resolveAdvisorConfig` — the SSOT for the
 * enabled-without-pair disabled-with-reason resolution (no model call).
 *
 * The namespace does NOT join the apiproxy configuration-client boundary on
 * current upstream dsh builds: the host's `exposedNamespaces()` unions only
 * model-provider namespaces plus its own product namespaces (locale /
 * permission / ui-conversation / ui-theme / ui-onboarding / agent-presets) —
 * there is no registration-level opt-in in upstream dsh (verified against the
 * pristine 20da39e snapshot; `SettingsRegisterOptions` has no
 * `exposeToWebClients` key). The advisor namespace is therefore always absent
 * from `settings.describe` on the web configuration boundary — but the web
 * card reaches the config through the TypertRemoteService channel instead (plan
 * dsh-advisor-settings-gateway-n5: `AdvisorConfigGateway` claims
 * `/api/advisor/get` + `/api/advisor/set`, and the client calls
 * `connection.rpc.call('/api', …)`; the in-process `ctx.settings.update`
 * behind `set` carries no exposed-namespace check — the allowlist gate exists
 * only in the apiproxy wire layer). The unexposed-namespace notice is now
 * only the KD-G5 fallback (gateway unreachable). No host patch is applied or
 * required for the plugin to function — the runtime reads the entry config
 * exactly as before.
 *
 * @module dsh-advisor/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { Config } from './config'
import type { AdvisorConfig } from './config'

/** The `advisor` settings namespace (registered when a settings service exists). */
export const ADVISOR_SETTINGS_NAMESPACE = settingsNamespace('advisor')

/**
 * Mirror of @deepseek-ai/dsh-settings' `isUnloading` guard (its
 * `installSettingsSection` skips source/listener work while the plugin fiber
 * is unloading or disposed). The library compares `ctx.fiber.state` against
 * `FiberState.DISPOSED` / `FiberState.UNLOADING`; the const enum is erased at
 * runtime, so the vendored numeric values (4 / 5) are mirrored here.
 */
function isUnloading(ctx: Context): boolean {
  const state = (ctx as unknown as { fiber?: { state?: number } }).fiber?.state
  return state === 4 || state === 5
}

/**
 * The live configuration source for the runtime.
 *
 * `source()` returns the RAW composed config (schema defaults → plugin-row
 * base → settings user layer); consumers pass it through
 * `resolveAdvisorConfig` — the hard gate stays the SSOT. `onChange` registers
 * a callback that re-applies derived state whenever the composed value changes
 * (attach, committed change, or detach back to the entry). The contract is
 * `(cb) => void` per the plan: the listener set is owned by the consumer's
 * plugin closure for its lifetime, and the detach path is handled by the
 * inject child's disposer (the `installSettingsSection` contract), so no
 * per-listener disposer is returned (qc1 S-3 — a discarded disposer would
 * invite misuse).
 */
export interface AdvisorSettingsBridge {
  source(): AdvisorConfig
  onChange(callback: () => void): void
}

/**
 * Install the `advisor` settings namespace and wire the live source.
 *
 * Mirrors the dsh `agent-default-model` pattern exactly (the dsh-settings
 * `installSettingsSection` contract): the registration rides a conditional
 * `ctx.inject(['settings'], ...)` child, so with no settings service the
 * source stays the entry config. `setSource` swaps the authoritative thunk
 * (the settings scope's resolved value while attached); `onChange` fires at
 * attach, on committed changes, and at detach. The registration carries NO
 * `exposeToWebClients` option — upstream dsh (pristine 20da39e) has no such
 * registration-level opt-in (its `exposedNamespaces()` unions model-provider
 * plus product namespaces only), so the advisor namespace stays off the
 * apiproxy web configuration boundary on every current dsh build. Web clients
 * reach the config through the TypertRemoteService channel instead (plan
 * dsh-advisor-settings-gateway-n5 — `/api/advisor/get` + `/api/advisor/set`);
 * the in-process settings service is the write target behind the gateway's
 * `set`. (A previous iteration believed the opt-in existed upstream and
 * declared it here; that conclusion was a circular verification against a
 * locally-modified staging tree — the option does not exist in upstream types
 * and has been removed.)
 *
 * qc1 W-5 (multi-fiber dedupe): the host composes several dsh-advisor fibers,
 * and this runs on EVERY instance — but `Settings.register` fails loud on a
 * duplicate namespace (`settings namespace "advisor" is already registered`).
 * The register call runs inside the conditional inject child, so the duplicate
 * error surfaces ASYNCHRONOUSLY there (an outer try/catch around a library
 * `installSettingsSection` call cannot see it) — this child body wraps the
 * register instead. A deduped instance logs (debug) and keeps the
 * entry-source fallback: its `source` thunk is only ever swapped by a
 * SUCCESSFUL registration's setSource hook, so the ALREADY-REGISTERED
 * instance owns the live namespace. The reviewer's settings wiring (the
 * `bridge.onChange` live re-apply in `index.ts`) is the concern — it only
 * re-applies when the reviewer's own bridge attached to the live scope; in
 * practice the reviewer is the first apply, whose inject child registers
 * first.
 */
export function installAdvisorSettings(ctx: Context, entry: AdvisorConfig): AdvisorSettingsBridge {
  const listeners = new Set<() => void>()
  let source = (): AdvisorConfig => entry
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  ctx.inject(['settings'], (sctx) => {
    let scope: SettingsScope<AdvisorConfig> | undefined
    try {
      scope = sctx.settings.register(ADVISOR_SETTINGS_NAMESPACE, Config, {
        base: entry,
        // No `exposeToWebClients` here: the option does not exist in upstream
        // dsh (verified against pristine 20da39e — `SettingsRegisterOptions`
        // has no such key, and the host's `exposedNamespaces()` unions only
        // model-provider plus product namespaces). The namespace stays off
        // the apiproxy web configuration boundary; web clients reach the
        // config through the TypertRemoteService channel (advisor/get +
        // advisor/set), and the runtime reads the entry exactly as it would
        // without a settings service.
      })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already registered')) throw error
      ctx.logger('advisor').debug('settings namespace already registered — entry-source fallback (multi-fiber dedupe)')
      return
    }
    // Mirrors installSettingsSection: the source thunk reads the scope's live
    // resolved value while attached, and the detach disposer falls back to the
    // entry when the settings service goes away (skipped during unload).
    source = () => scope.get()
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return
      source = () => entry
      notify()
    })
    notify()
    scope.watch(() => {
      if (isUnloading(ctx)) return
      notify()
    })
  })
  return {
    source: (): AdvisorConfig => source(),
    onChange: (callback: () => void): void => {
      listeners.add(callback)
    },
  }
}
