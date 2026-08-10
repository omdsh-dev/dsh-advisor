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
 * @module dsh-advisor/settings
 */

import type { Context } from 'cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config } from './config'
import type { AdvisorConfig } from './config'

/** The `advisor` settings namespace (registered when a settings service exists). */
export const ADVISOR_SETTINGS_NAMESPACE = settingsNamespace('advisor')

/**
 * The live configuration source for the runtime.
 *
 * `source()` returns the RAW composed config (schema defaults → plugin-row
 * base → settings user layer); consumers pass it through
 * `resolveAdvisorConfig` — the hard gate stays the SSOT. `onChange` registers
 * a callback that re-applies derived state whenever the composed value changes
 * (attach, committed change, or detach back to the entry). The contract is
 * `(cb) => void` per the plan: the listener set is owned by the consumer's
 * plugin closure for its lifetime, and the detach path is handled by
 * `installSettingsSection`'s own disposer, so no per-listener disposer is
 * returned (qc1 S-3 — a discarded disposer would invite misuse).
 */
export interface AdvisorSettingsBridge {
  source(): AdvisorConfig
  onChange(callback: () => void): void
}

/**
 * Install the `advisor` settings namespace and wire the live source.
 *
 * Mirrors the dsh `agent-default-model` pattern exactly: `installSettingsSection`
 * rides a conditional `ctx.inject(['settings'], ...)` child, so with no
 * settings service the source stays the entry config (its own disposer falls
 * back to `entry` when the service goes away). `setSource` swaps the
 * authoritative thunk (the settings scope's resolved value while attached);
 * `onChange` fires at attach, on committed changes, and at detach.
 */
export function installAdvisorSettings(ctx: Context, entry: AdvisorConfig): AdvisorSettingsBridge {
  const listeners = new Set<() => void>()
  let source = (): AdvisorConfig => entry
  installSettingsSection(ctx, ADVISOR_SETTINGS_NAMESPACE, Config, entry, {
    setSource: (next) => {
      source = next
    },
    onChange: () => {
      for (const listener of [...listeners]) listener()
    },
  })
  return {
    source: (): AdvisorConfig => source(),
    onChange: (callback: () => void): void => {
      listeners.add(callback)
    },
  }
}
