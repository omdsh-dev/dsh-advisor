/**
 * Bridge-level settings test double for the 0.1.7-rc.1 volatile entry-config
 * model (the retired `MemorySettings` provider stood in for a `SettingsProvider`
 * base class + user layers — both are gone: dsh-settings is now the form
 * service `SettingsForms` and a plugin's editable config is its OWN entry).
 *
 * A plugin's six live fields (`.volatile()` in `src/config.ts`) are committed
 * by the cordis Loader into the running fiber's references — frozen cosmokit
 * `Volatile` objects (`{ get() }`) whose values only the Loader can update —
 * and every commit is announced by `loader/volatile-update`, emitted to the
 * owning fiber AFTER the new values are readable. This module rebuilds that
 * pipeline at the bridge level with test-owned references:
 *
 * - {@link MemoryEntryConfig} — the entry config `apply` receives: known
 *   fields are mutable `{ get() / set() }` references; `commit()` plays the
 *   Loader's part (write the values, then emit the event with the changed
 *   paths). Unknown keys are stored as plain values, exactly like a key the
 *   non-strict schemastery object merge lets through.
 * - {@link harnessAdvisorPlugin} — composes the REAL plugin module against a
 *   {@link MemoryEntryConfig}: the module's `Config` schema is dropped so
 *   cordis hands `apply` the already-resolved entry untouched (the harness IS
 *   the loader stand-in; the real schemastery resolution of a plain row —
 *   frozen references and all — is covered by the integration suite, which
 *   loads the untouched module through `ctx.plugin`).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AdvisorConfig, VolatileAdvisorConfig } from '../../src/config'
import * as advisorPlugin from '../../src/index'

/** A test-owned volatile reference: the `{ get() }` protocol the runtime
 * duck-types, plus the `set` seam standing in for the Loader's commit
 * (`updateVolatile` — the real reference is frozen and symbol-keyed). */
export interface MutableReference<T> {
  get(): T
  set(next: T): void
}

export function mutableReference<T>(initial: T): MutableReference<T> {
  let current = initial
  return {
    get: () => current,
    set: (next) => {
      current = next
    },
  }
}

/**
 * The advisor entry config as the loader would resolve it, but with
 * harness-owned references so a test can drive a live edit.
 */
export class MemoryEntryConfig {
  /** The object to hand to the plugin (`apply`'s config / `ctx.plugin` config). */
  readonly config: VolatileAdvisorConfig

  private readonly record: Record<string, unknown> = {}
  private readonly refs = new Map<string, MutableReference<unknown>>()

  constructor(initial: AdvisorConfig) {
    for (const [key, value] of Object.entries(initial)) {
      const ref = mutableReference(value)
      this.refs.set(key, ref)
      this.record[key] = ref
    }
    this.config = this.record as unknown as VolatileAdvisorConfig
  }

  /**
   * Play the Loader's volatile commit: write every patched value into its
   * reference, THEN emit `loader/volatile-update` with the changed paths —
   * the real event fires only after the values are committed, so awaiting a
   * microtask turn after `commit` is the settle point for the bridge's
   * `onChange` re-apply (the emission is synchronous).
   */
  commit(ctx: Context, patch: Record<string, unknown>): void {
    const paths: string[][] = []
    for (const [key, value] of Object.entries(patch)) {
      const ref = this.refs.get(key)
      // An unknown key is never schema-declared, hence never a reference —
      // it rides the entry as a plain value (non-strict schemastery merge).
      if (ref === undefined) this.record[key] = value
      else ref.set(value)
      paths.push([key])
    }
    ;(ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit(
      'loader/volatile-update',
      paths,
    )
  }
}

/**
 * The real plugin module minus its `Config` schema: cordis validates the
 * config through `runtime.Config` when present (`resolveConfig`), so dropping
 * it makes `ctx.plugin(harnessAdvisorPlugin(), entry.config)` hand the
 * already-resolved volatile-reference entry straight to `apply` — the
 * stand-in for the Loader's own resolution. `name`/`inject` carry over
 * unchanged.
 */
export function harnessAdvisorPlugin(): {
  name: string
  inject: readonly string[]
  apply(ctx: Context, config: unknown): void
} {
  return {
    name: advisorPlugin.name,
    inject: advisorPlugin.inject,
    apply: advisorPlugin.apply as (ctx: Context, config: unknown) => void,
  }
}
