/**
 * T1 (plan dsh-advisor-settings-n2) — live source wiring over the plugin
 * entry's volatile config fields.
 *
 * dsh 0.1.7-rc.1 retired the settings user layer (`settings.yaml` is imported
 * into the profile and renamed `.imported`; dsh-settings became the form
 * service `SettingsForms` over profile entries). A plugin's editable config is
 * now its OWN entry config: the fields the schema declares `.volatile()` are
 * committed by the cordis Loader into the running fiber's references WITHOUT a
 * remount (`src/config.ts` marks all six live fields volatile).
 *
 * This module is the read side of that pipeline. `apply` receives the entry
 * config with each volatile field as a `{ get() }` reference; the bridge
 * snapshots it through `unwrapAdvisorConfig` (per-field `.get()`, plain
 * values tolerated), so `source()` always returns the RAW plain-valued config
 * the hard gate reads. `onChange` rides the Loader's `loader/volatile-update`
 * event — emitted to the OWNING fiber only, after the committed values are
 * readable through the references — so every committed edit re-applies derived
 * state exactly when the new values are visible.
 *
 * There is no registration step anymore: with ≥ 1 volatile field the entry
 * appears in `settings.describe()` automatically (`autoGenerate` defaults to
 * true), so the old `ctx.inject(['settings'])` registration child, its
 * `installSection` contract, and the multi-fiber 'already registered' dedupe
 * are all gone — every fiber builds its own bridge, and the owning-fiber event
 * filter keeps each bridge pointed at its own entry's edits.
 *
 * The hard gate is untouched: the source returns the RAW config and every
 * consumer passes it through `resolveAdvisorConfig` — the SSOT for the
 * enabled-without-pair disabled-with-reason resolution (no model call).
 *
 * The write side rides the same entry id: the gateway (`src/gateway.ts`)
 * writes through `settings.update(ADVISOR_SETTINGS_NAMESPACE, ...)` — the
 * entry id IS the bundle row id `advisor` (`cordis.patch.yml`) — which lands
 * in the profile via the config editor, commits through the Loader, and closes
 * the loop back into this bridge's `onChange`.
 *
 * @module dsh-advisor/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { unwrapAdvisorConfig } from './config.js'
import type { AdvisorConfig, VolatileAdvisorConfig } from './config.js'

/**
 * The advisor settings entry id — the bundle row id (`cordis.patch.yml:5`),
 * which is also the `settings.update` / `settings.describe` key and the
 * gateway service key. (Pre-0.1.7 this constant was a registered settings
 * namespace; it now names the plugin's own profile entry.)
 */
export const ADVISOR_SETTINGS_NAMESPACE = 'advisor'

/**
 * The live configuration source for the runtime.
 *
 * `source()` returns the RAW entry config snapshot (volatile references
 * unwrapped, `null` normalized to `undefined`); consumers pass it through
 * `resolveAdvisorConfig` — the hard gate stays the SSOT. `onChange` registers
 * a callback that re-applies derived state whenever the Loader commits a
 * volatile edit to this entry (`loader/volatile-update`, owning-fiber
 * filtered). The contract is `(cb) => void` per the plan: the listener set is
 * owned by the consumer's plugin closure for its lifetime, and the event
 * subscription lives and dies with the fiber, so no per-listener disposer is
 * returned (qc1 S-3 — a discarded disposer would invite misuse).
 */
export interface AdvisorSettingsBridge {
  source(): AdvisorConfig
  onChange(callback: () => void): void
}

/**
 * Structural mirror of the cordis-plugin-loader event declaration
 * (`loader/volatile-update`) — the loader is not (and must not become) a peer
 * dependency, so the subscription goes through a local structural cast, the
 * same pattern as the `tuiSettingsSections` seam. Drift window: a host rename
 * of the event would silently stop delivering updates (the entry config would
 * freeze at its load-time values); re-verify against the loader types when
 * bumping the dsh line.
 */
interface VolatileUpdateContext {
  on(event: 'loader/volatile-update', listener: (paths: readonly (readonly string[])[]) => void): unknown
}

/**
 * Wire the live source over the entry config's volatile references.
 *
 * `entry` is the config object `apply` received — on a Loader composition the
 * six schema-declared fields are `{ get() }` references; plain-object entries
 * (integration harnesses) work identically. The bridge holds the ENTRY, not a
 * snapshot, so every `source()` call reads the references' CURRENT values and
 * the returned config is live from the first read. `onChange` fires on every
 * `loader/volatile-update` dispatched to this fiber — the Loader emits it only
 * after the new values are committed, so a listener reading `source()` sees
 * the committed state (no follow-up read needed).
 */
export function installAdvisorSettings(ctx: Context, entry: VolatileAdvisorConfig): AdvisorSettingsBridge {
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  ;(ctx as unknown as VolatileUpdateContext).on('loader/volatile-update', () => notify())
  return {
    source: (): AdvisorConfig => unwrapAdvisorConfig(entry),
    onChange: (callback: () => void): void => {
      listeners.add(callback)
    },
  }
}
