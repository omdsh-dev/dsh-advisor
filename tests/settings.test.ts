/**
 * T1 (plan dsh-advisor-settings-n2) — host-side settings namespace + live
 * source wiring.
 *
 * Contract under test (`installAdvisorSettings`, src/settings.ts):
 * ① No settings service (plain cordis ctx, no `settings` injection) — the
 *    source thunk falls back to the entry config (the plugin-row config),
 *    behavior identical to today, and the value still passes through the
 *    `resolveAdvisorConfig` hard gate (SSOT unchanged).
 * ② With a settings service mounted — the settings service's `installSection` registers the
 *    `advisor` namespace: `describe` exposes it, the schema is the `Config`
 *    schema, the composition `base` is the entry config.
 * ③ A user-layer write (enabled/provider/model) is reflected live in the
 *    source thunk: the composed value layers schema defaults → base → user,
 *    so base defaults the user did not override are kept.
 * ④ Hard gate regression: settings-enabled without provider/model still
 *    resolves to disabled-with-reason (no model call).
 * ⑤ Unknown config keys from the settings layer are still rejected by the
 *    hard gate.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemorySettings } from './support/memory-settings'
import { ADVISOR_SETTINGS_NAMESPACE, installAdvisorSettings } from '../src/settings'
import { Config, resolveAdvisorConfig } from '../src/config'
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

/** Wait until the conditional `ctx.inject(['settings'], ...)` child registered the namespace. */
async function waitRegistered(ctx: Context): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.settings.describe().some((d) => d.ns === ADVISOR_SETTINGS_NAMESPACE)).toBe(true)
  })
}

// ---------------------------------------------------------------------------
// ① no settings service → entry fallback
// ---------------------------------------------------------------------------

describe('no settings service (entry fallback, behavior identical to today)', () => {
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

  it('stays on the entry even after a tick (no settings service ever mounts)', async () => {
    const ctx = new Context()
    const entry = entryConfig()
    const bridge = installAdvisorSettings(ctx, entry)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridge.source()).toEqual(entry)
  })
})

// ---------------------------------------------------------------------------
// ② registration visible via describe
// ---------------------------------------------------------------------------

describe('with a settings service (namespace registration)', () => {
  it('registers the advisor namespace; describe exposes ns, Config schema, base, live value', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ systemPrompt: 'entry prompt', immuneTurns: 5 })
    const bridge = installAdvisorSettings(ctx, entry)

    await waitRegistered(ctx)
    const descriptor = ctx.settings.describe().find((d) => d.ns === ADVISOR_SETTINGS_NAMESPACE)!
    expect(descriptor).toBeDefined()
    // The registered schema IS the Config schema (serialized).
    expect(descriptor.schema).toEqual(Config.toJSON())
    // The plugin-row config is the composition base layer.
    expect(descriptor.base).toEqual(entry)
    expect(descriptor.applies).toBe('live')
    // No `exposeToWebClients` opt-in: upstream dsh (pristine 20da39e) has no
    // such registration option (`SettingsRegisterOptions` lacks the key), so
    // the advisor namespace stays off the web configuration boundary — the
    // client section shows the config-row notice. Registration itself is all
    // the runtime depends on; nothing is asserted about web exposure.
    // The source now reads the scope's resolved value (entry-composed).
    expect(bridge.source()).toEqual(entry)
  })

  it('duplicate registration fails loud (namespace is unique)', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const entry = entryConfig()
    installAdvisorSettings(ctx, entry)
    await waitRegistered(ctx)
    expect(() => ctx.settings.register(ADVISOR_SETTINGS_NAMESPACE, Config, { base: entry }))
      .toThrow(/already registered/)
  })

  it('a second install on the same context is deduped: no loud error, entry-source fallback (qc1 W-5)', async () => {
    const ctx = new Context()
    const errors: unknown[] = []
    const debugs: unknown[] = []
    const levels = {
      error: (message: unknown) => { errors.push(message) },
      warn: () => {},
      info: () => {},
      debug: (message: unknown) => { debugs.push(message) },
    }
    // Callable logger: `ctx.logger('advisor')` returns a named logger object,
    // while cordis logs a failed inject-child activation through the direct
    // `ctx.logger.error(...)` method — both must be captured.
    ctx.logger = Object.assign(() => ({ ...levels }), levels) as never
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' })
    const first = installAdvisorSettings(ctx, entry)
    await waitRegistered(ctx)

    // Second install on the SAME context — the namespace is already
    // registered. dsh-settings register fails loud on duplicates, so
    // installAdvisorSettings must dedupe: the register error surfaces inside
    // the conditional inject child (async — an outer try/catch cannot see
    // it); the child catches it, logs (debug), and the second bridge keeps
    // the entry-source fallback while the first owns the live scope.
    const second = installAdvisorSettings(ctx, entryConfig())
    await vi.waitFor(() => {
      expect(debugs.some((message) => String(message).includes('already registered'))).toBe(true)
    })

    expect(errors).toEqual([]) // no loud `settings namespace "advisor" is already registered` error
    expect(second.source()).toEqual(entryConfig())
    expect(first.source()).toEqual(entry)
    expect(ctx.settings.describe().filter((d) => d.ns === ADVISOR_SETTINGS_NAMESPACE)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// ③ user-layer write → source reflects the composed value
// ---------------------------------------------------------------------------

describe('user-layer writes (schema defaults → base → user composition)', () => {
  it('the source thunk reflects the write live, keeping base defaults the user did not override', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ systemPrompt: 'entry prompt', immuneTurns: 5 })
    const bridge = installAdvisorSettings(ctx, entry)
    await waitRegistered(ctx)

    await ctx.settings.update(ADVISOR_SETTINGS_NAMESPACE, {
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
    })

    expect(bridge.source()).toEqual({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      // base defaults the user layer did not override are kept
      systemPrompt: 'entry prompt',
      immuneTurns: 5,
      maxDeltaMessages: 60,
    })
    // The composed value still passes the hard gate (enabled + pair → enabled).
    expect(resolveAdvisorConfig(bridge.source()).enabled).toBe(true)
  })

  it('an update changing only one key leaves the other base values intact', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ immuneTurns: 3, maxDeltaMessages: 60 })
    const bridge = installAdvisorSettings(ctx, entry)
    await waitRegistered(ctx)

    await ctx.settings.update(ADVISOR_SETTINGS_NAMESPACE, { maxDeltaMessages: 10 })
    expect(bridge.source()).toEqual({
      enabled: false,
      systemPrompt: '',
      immuneTurns: 3,
      maxDeltaMessages: 10,
    })
  })

  it('replace({}) re-inherits the base layer (reset path)', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ systemPrompt: 'entry prompt' })
    const bridge = installAdvisorSettings(ctx, entry)
    await waitRegistered(ctx)

    await ctx.settings.update(ADVISOR_SETTINGS_NAMESPACE, { enabled: true, provider: 'p', model: 'm' })
    expect(bridge.source().enabled).toBe(true)

    await ctx.settings.replace(ADVISOR_SETTINGS_NAMESPACE, {})
    expect(bridge.source()).toEqual(entry)
  })
})

// ---------------------------------------------------------------------------
// ④ hard gate regression through the live source
// ---------------------------------------------------------------------------

describe('hard gate regression (resolveAdvisorConfig stays the SSOT)', () => {
  it('settings-enabled without provider/model still resolves to disabled-with-reason', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const bridge = installAdvisorSettings(ctx, entryConfig())
    await waitRegistered(ctx)

    await ctx.settings.update(ADVISOR_SETTINGS_NAMESPACE, { enabled: true })

    const resolved = resolveAdvisorConfig(bridge.source())
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toMatch(/provider and model are missing/)
  })

  it('a user-layer write that empties a base provider trips the gate (no model call)', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' })
    const bridge = installAdvisorSettings(ctx, entry)
    await waitRegistered(ctx)

    // The user layer overrides the base provider with an empty value — the
    // gate must catch the now-incomplete pair (spec §5.2 "missing or empty").
    await ctx.settings.update(ADVISOR_SETTINGS_NAMESPACE, { provider: '' })
    const resolved = resolveAdvisorConfig(bridge.source())
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toBeTruthy()
  })

  it('replace({}) re-inherits the base layer — the base pair is never silently dropped', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const entry = entryConfig({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' })
    const bridge = installAdvisorSettings(ctx, entry)
    await waitRegistered(ctx)

    // Composition semantics (same as dsh): a wholesale reset re-inherits the
    // composition base, so the enabled base pair keeps the gate open.
    await ctx.settings.replace(ADVISOR_SETTINGS_NAMESPACE, { enabled: true })
    expect(resolveAdvisorConfig(bridge.source()).enabled).toBe(true)
    expect(resolveAdvisorConfig(bridge.source()).provider).toBe('deepseek')
  })
})

// ---------------------------------------------------------------------------
// ⑤ unknown keys still rejected
// ---------------------------------------------------------------------------

describe('unknown config keys (strict rejection unchanged)', () => {
  it('an unknown key written to the user layer is still rejected by the hard gate', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const bridge = installAdvisorSettings(ctx, entryConfig())
    await waitRegistered(ctx)

    await ctx.settings.update(ADVISOR_SETTINGS_NAMESPACE, { bogus: 1 })
    expect(() => resolveAdvisorConfig(bridge.source())).toThrow(/unknown config key "bogus"/)
  })

  it('the namespace id is the exact `advisor` kebab-case brand', () => {
    expect(ADVISOR_SETTINGS_NAMESPACE).toBe('advisor')
  })
})
