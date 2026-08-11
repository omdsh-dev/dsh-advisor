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
 * The namespace joins the configuration-client boundary through the upstream
 * registration opt-in: `exposeToWebClients: true` makes the registration
 * descriptor report `exposed: true`, and on dsh ≥ the 20da39e snapshot the
 * host's `exposedNamespaces()` unions exactly those namespaces — so no host
 * allowlist patch is required there. The shipped
 * `patches/@deepseek-ai+dsh-host-apiproxy@0.0.1.patch` remains only as a
 * compatibility shim for older hosts that lack the mechanism (its retirement
 * is a separate follow-up, gated on runtime verification).
 *
 * @module dsh-advisor/settings
 */

import type { Context } from 'cordis'
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
 * attach, on committed changes, and at detach. The registration opts into the
 * configuration-client boundary (`exposeToWebClients: true` — the upstream
 * registration-level opt-in, threaded through `installSettingsSection`'s
 * hooks; no host allowlist patch needed on dsh ≥ the 20da39e snapshot).
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
        // Registration-level opt-in: the descriptor reports `exposed: true`,
        // and the host's `exposedNamespaces()` (dsh ≥ the 20da39e snapshot)
        // unions such namespaces into the configuration-client boundary — no
        // host allowlist patch required there (older hosts keep the shim
        // patch; retirement is a separate follow-up).
        exposeToWebClients: true,
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
