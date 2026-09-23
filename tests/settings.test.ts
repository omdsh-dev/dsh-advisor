/**
 * T1 (plan dsh-advisor-settings-n2) — live source wiring over the entry
 * config's volatile fields.
 *
 * Contract under test (`installAdvisorSettings`, src/settings.ts):
 * ① Plain-value entry (integration harness form — no loader resolution) —
 *    the source is exactly the entry config and the value still passes
 *    through the `resolveAdvisorConfig` hard gate (SSOT unchanged).
 * ② Volatile-reference entry — `source()` unwraps every `{ get() }`
 *    reference into the plain contract; the snapshot is live (each call
 *    re-reads the references).
 * ③ A committed edit (references written, then `loader/volatile-update`
 *    emitted — the loader double in `support/memory-settings.ts`) is
 *    reflected in `source()` and fires `onChange`; the event carries the
 *    changed paths and the listener sees the ALREADY-committed values.
 * ④ Hard gate regression: enabled without provider/model still resolves to
 *    disabled-with-reason (no model call).
 * ⑤ Unknown config keys ride along and are still rejected by the hard gate;
 *    the entry id stays the exact `advisor` literal.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryEntryConfig, mutableReference } from './support/memory-settings'
import { ADVISOR_SETTINGS_NAMESPACE, installAdvisorSettings } from '../src/settings'
import { resolveAdvisorConfig } from '../src/config'
import type { AdvisorConfig } from '../src/config'

/** Full entry (plugin-row) config shape, merged over the schema defaults. */
function entryConfig(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    enabled: false,
    systemPrompt: '',
    immuneTurns: 3,
    maxDeltaMessages: 60,
    ...overrides,
  }
}

/** Emit the loader's committed-volatile-values event the way the loader does. */
function emitVolatileUpdate(ctx: Context, paths: string[][]): void {
  ;(ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit(
    'loader/volatile-update',
    paths,
  )
}

// ---------------------------------------------------------------------------
// ① plain-value entry (no loader resolution — the entry IS the source)
// ---------------------------------------------------------------------------

describe('plain-value entry (integration harness form, behavior identical to today)', () => {
  it('bridge.source() is exactly the entry config', () => {
    const ctx = new Context()
    const entry = entryConfig({ enabled: true, provider: 'deepseek', model: 'deepseek-chat', immuneTurns: 5 })
    const bridge = installAdvisorSettings(ctx, entry)
    expect(bridge.source()).toEqual(entry)
    // The source still passes through the hard gate — the SSOT is unchanged.
    expect(resolveAdvisorConfig(bridge.source())).toEqual({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: '',
      immuneTurns: 5,
      maxDeltaMessages: 60,
    })
  })

  it('stays on the entry even after a tick (no volatile update ever arrives)', async () => {
    const ctx = new Context()
    const entry = entryConfig()
    const bridge = installAdvisorSettings(ctx, entry)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridge.source()).toEqual(entry)
  })
})

// ---------------------------------------------------------------------------
// ② volatile references are unwrapped into the plain contract
// ---------------------------------------------------------------------------

describe('volatile-reference entry (source() unwraps { get() } references)', () => {
  it('source() returns the plain-valued config behind the references', () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ enabled: true, provider: 'deepseek', model: 'deepseek-chat', immuneTurns: 5 }))
    const bridge = installAdvisorSettings(ctx, entry.config)
    expect(bridge.source()).toEqual({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: '',
      immuneTurns: 5,
      maxDeltaMessages: 60,
    })
    // The unwrapped snapshot passes the hard gate like any plain entry.
    expect(resolveAdvisorConfig(bridge.source()).enabled).toBe(true)
  })

  it('source() is live: every call re-reads the references (no snapshot staleness)', () => {
    const ctx = new Context()
    const provider = mutableReference<string | undefined>(undefined)
    const bridge = installAdvisorSettings(ctx, {
      enabled: false,
      provider: provider,
      systemPrompt: '',
      immuneTurns: 3,
      maxDeltaMessages: 60,
    })
    expect(bridge.source().provider).toBeUndefined()
    provider.set('deepseek')
    expect(bridge.source().provider).toBe('deepseek')
  })
})

// ---------------------------------------------------------------------------
// ③ committed volatile edit → new values + onChange
// ---------------------------------------------------------------------------

describe('loader/volatile-update commit (source reflects the write, onChange fires)', () => {
  it('after a commit the source returns the new value and every listener fired once', () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ systemPrompt: 'entry prompt', immuneTurns: 5 }))
    const bridge = installAdvisorSettings(ctx, entry.config)
    const listener = vi.fn()
    bridge.onChange(listener)
    const second = vi.fn()
    bridge.onChange(second)

    // Loader-style commit: values are written BEFORE the event dispatches, so
    // the listener observes the committed state (not a pending one).
    entry.commit(ctx, { enabled: true, provider: 'deepseek', model: 'deepseek-chat' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(bridge.source()).toEqual({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      // entry values the patch did not touch are kept
      systemPrompt: 'entry prompt',
      immuneTurns: 5,
      maxDeltaMessages: 60,
    })
    // The composed value still passes the hard gate (enabled + pair → enabled).
    expect(resolveAdvisorConfig(bridge.source()).enabled).toBe(true)
  })

  it('an event for an unrelated path still notifies (owning-fiber events are already scoped), listeners added late fire too', () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig())
    const bridge = installAdvisorSettings(ctx, entry.config)
    const early = vi.fn()
    bridge.onChange(early)

    emitVolatileUpdate(ctx, [['someOtherField']])
    expect(early).toHaveBeenCalledTimes(1)

    const late = vi.fn()
    bridge.onChange(late)
    entry.commit(ctx, { maxDeltaMessages: 10 })
    expect(late).toHaveBeenCalledTimes(1)
    expect(early).toHaveBeenCalledTimes(2)
    expect(bridge.source().maxDeltaMessages).toBe(10)
  })

  it('an unknown-key commit rides into the source as a plain value (gate sees it)', () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig())
    const bridge = installAdvisorSettings(ctx, entry.config)
    entry.commit(ctx, { bogus: 1 })
    expect(() => resolveAdvisorConfig(bridge.source())).toThrow(/unknown config key "bogus"/)
  })
})

// ---------------------------------------------------------------------------
// ④ hard gate regression through the live source
// ---------------------------------------------------------------------------

describe('hard gate regression (resolveAdvisorConfig stays the SSOT)', () => {
  it('a volatile-enabled entry without provider/model still resolves to disabled-with-reason', () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig())
    const bridge = installAdvisorSettings(ctx, entry.config)

    entry.commit(ctx, { enabled: true })

    const resolved = resolveAdvisorConfig(bridge.source())
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toMatch(/provider and model are missing/)
  })

  it('a committed empty provider trips the gate (no model call)', () => {
    const ctx = new Context()
    const entry = new MemoryEntryConfig(entryConfig({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' }))
    const bridge = installAdvisorSettings(ctx, entry.config)

    // The edit overrides the provider with an empty value — the gate must
    // catch the now-incomplete pair (spec §5.2 "missing or empty").
    entry.commit(ctx, { provider: '' })
    const resolved = resolveAdvisorConfig(bridge.source())
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// ⑤ entry id literal
// ---------------------------------------------------------------------------

describe('entry id', () => {
  it('stays the exact `advisor` literal (the bundle row id — cordis.patch.yml)', () => {
    expect(ADVISOR_SETTINGS_NAMESPACE).toBe('advisor')
  })
})
