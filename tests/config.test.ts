/**
 * T2 — config schema & validation (explicit model gate, spec §5 / S4).
 *
 * Contract under test:
 * - The exported schemastery `Config` schema (the cordis Loader path) applies
 *   defaults (`immuneTurns` 3, `maxDeltaMessages` 60, `systemPrompt` "") and
 *   enforces types/bounds (int ≥ 0). All five live fields are `.volatile()`:
 *   `Config(raw)` resolves them to `{ get() }` references (the loader's
 *   no-remount edit channel), and the reads below go through
 *   `unwrapAdvisorConfig` — the same unwrapping the runtime does before the
 *   gate.
 * - `resolveAdvisorConfig(raw)` never throws for the gate scenario: there is
 *   no config-level `enabled` key (2026-09-26 — the plugin-row toggle is the
 *   switch), so when `provider`/`model` is missing or empty it resolves to a
 *   disabled-with-reason config (no model call); a complete pair resolves
 *   enabled.
 * - Unknown config keys are rejected (strict schema) — with ONE tolerated
 *   legacy exception: the 2026-09-26-removed `enabled` key is accepted and
 *   silently dropped (2026-09-27 user ruling — a stored profile still
 *   carrying it loads cleanly instead of being rejected; the row toggle
 *   replaced it, the dead value is never read and never re-persisted).
 */

import { describe, expect, it } from 'vitest'
import { Config, resolveAdvisorConfig, unwrapAdvisorConfig } from '../src/config'

describe('schema defaults (cordis Loader path, spec §5.1)', () => {
  it('resolves every live field to a volatile reference (the no-remount edit channel)', () => {
    // 0.1.7-rc.1: `.volatile()` makes the loader commit edits into the running
    // fiber's references. A resolved field must duck-type as `{ get() }` —
    // every runtime read (unwrapAdvisorConfig → the gate) depends on it.
    const resolved: Record<string, unknown> = Config({})
    for (const key of ['provider', 'model', 'systemPrompt', 'immuneTurns', 'maxDeltaMessages']) {
      expect(typeof (resolved[key] as { get?: unknown }).get, key).toBe('function')
    }
  })

  it('applies defaults for an empty config', () => {
    expect(unwrapAdvisorConfig(Config({}))).toEqual({
      systemPrompt: '',
      immuneTurns: 3,
      maxDeltaMessages: 60,
    })
  })

  it('keeps explicit values over defaults', () => {
    expect(unwrapAdvisorConfig(Config({
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'custom reviewer prompt',
      immuneTurns: 5,
      maxDeltaMessages: 10,
    }))).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'custom reviewer prompt',
      immuneTurns: 5,
      maxDeltaMessages: 10,
    })
  })

  it('rejects non-number / non-string values', () => {
    // `as never` — inputs are intentionally invalid; runtime must reject them.
    expect(() => Config({ immuneTurns: '3' as never })).toThrow()
    expect(() => Config({ systemPrompt: 42 as never })).toThrow()
    expect(() => Config({ provider: 7 as never })).toThrow()
  })

  it('treats null as absent (schemastery nullable input → default)', () => {
    expect(unwrapAdvisorConfig(Config({ maxDeltaMessages: null })).maxDeltaMessages).toBe(60)
  })

  it('enforces integer ≥ 0 bounds; 0 = unbounded is allowed', () => {
    expect(() => Config({ immuneTurns: -1 })).toThrow()
    expect(() => Config({ immuneTurns: 2.5 })).toThrow()
    expect(() => Config({ maxDeltaMessages: -1 })).toThrow()
    expect(() => Config({ maxDeltaMessages: 1.5 })).toThrow()
    expect(unwrapAdvisorConfig(Config({ maxDeltaMessages: 0 })).maxDeltaMessages).toBe(0)
    expect(unwrapAdvisorConfig(Config({ immuneTurns: 0 })).immuneTurns).toBe(0)
  })
})

describe('explicit model gate (S4 / spec §5.2)', () => {
  it('resolves to disabled-with-reason by default (no provider/model)', () => {
    // No config-level switch since 2026-09-26: the gate keys purely on the
    // pair, so the defaulted config is disabled-with-reason, not silently off.
    const resolved = resolveAdvisorConfig({})
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toBeTruthy()
    expect(resolved.systemPrompt).toBe('')
    expect(resolved.immuneTurns).toBe(3)
    expect(resolved.maxDeltaMessages).toBe(60)
  })

  it('resolves to disabled-with-reason when only provider is set', () => {
    const resolved = resolveAdvisorConfig({ provider: 'deepseek' })
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toBeTruthy()
  })

  it('resolves to disabled-with-reason when only model is set', () => {
    const resolved = resolveAdvisorConfig({ model: 'deepseek-chat' })
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toBeTruthy()
  })

  it('treats empty provider or model as missing (gate requires both)', () => {
    expect(resolveAdvisorConfig({ provider: '', model: 'm' }).enabled).toBe(false)
    expect(resolveAdvisorConfig({ provider: 'p', model: '' }).enabled).toBe(false)
    expect(resolveAdvisorConfig({ provider: '', model: '' }).enabled).toBe(false)
  })

  it('treats whitespace-only provider/model as missing (trim before the gate, qc2 W-3 / qc3 I-3)', () => {
    expect(resolveAdvisorConfig({ provider: ' ', model: 'm' }).enabled).toBe(false)
    expect(resolveAdvisorConfig({ provider: 'p', model: '   ' }).enabled).toBe(false)
    expect(resolveAdvisorConfig({ provider: ' \t ', model: '  ' }).enabled).toBe(false)
    const resolved = resolveAdvisorConfig({ provider: ' ', model: 'm' })
    expect(resolved.disabledReason).toBeTruthy()
  })

  it('treats null provider/model as missing (normalized before the gate)', () => {
    expect(resolveAdvisorConfig({ provider: null, model: 'm' }).enabled).toBe(false)
    expect(resolveAdvisorConfig({ provider: null, model: null }).enabled).toBe(false)
    const resolved = resolveAdvisorConfig({ provider: null, model: 'm' })
    expect(resolved.disabledReason).toBeTruthy()
  })

  it('never throws for the gate scenario', () => {
    expect(() => resolveAdvisorConfig({})).not.toThrow()
    expect(() => resolveAdvisorConfig({ provider: 'p' })).not.toThrow()
  })

  it('resolves enabled when both provider and model are present', () => {
    const resolved = resolveAdvisorConfig({
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    expect(resolved.enabled).toBe(true)
    expect(resolved.provider).toBe('deepseek')
    expect(resolved.model).toBe('deepseek-chat')
    expect(resolved.disabledReason).toBeUndefined()
  })

  it('preserves defaults and explicit values in the resolved config', () => {
    expect(resolveAdvisorConfig({
      provider: 'p',
      model: 'm',
      systemPrompt: 'custom',
      immuneTurns: 5,
      maxDeltaMessages: 0,
    })).toEqual({
      enabled: true,
      provider: 'p',
      model: 'm',
      systemPrompt: 'custom',
      immuneTurns: 5,
      maxDeltaMessages: 0,
    })
  })
})

describe('strict schema — unknown keys rejected (spec §5.2)', () => {
  it('rejects unknown keys on a pairless config', () => {
    expect(() => resolveAdvisorConfig({ bogus: 1 }))
      .toThrow(/unknown config key "bogus"/)
  })

  it('rejects unknown keys on a config with a valid pair', () => {
    expect(() => resolveAdvisorConfig({ provider: 'p', model: 'm', extra: true }))
      .toThrow(/unknown config key "extra"/)
  })

  it('tolerates and drops the legacy `enabled` key (2026-09-27 ruling — stored profiles load cleanly)', () => {
    // The migration surface: a stored profile still carrying `enabled:` is
    // accepted but IGNORED (the row toggle replaced it) — the value never
    // influences the resolution, which keys purely on the pair.
    const withPair = resolveAdvisorConfig({ enabled: true, provider: 'p', model: 'm' })
    expect(withPair.enabled).toBe(true)
    expect(withPair.provider).toBe('p')
    expect(withPair.disabledReason).toBeUndefined()
    // Any legacy value on a pairless config still resolves through the pair
    // gate — the dead switch cannot turn the advisor on or off.
    for (const legacyValue of [true, false]) {
      const resolved = resolveAdvisorConfig({ enabled: legacyValue })
      expect(resolved.enabled).toBe(false)
      expect(resolved.disabledReason).toMatch(/provider and model are missing/)
    }
    // The legacy key is stripped from the snapshot: `source()` and every
    // downstream consumer (and any snapshot-derived write) never carry it.
    expect(unwrapAdvisorConfig(Config({ enabled: true, provider: 'p' }))).toEqual({
      provider: 'p',
      systemPrompt: '',
      immuneTurns: 3,
      maxDeltaMessages: 60,
    })
  })

  it('rejects non-object config input', () => {
    expect(() => resolveAdvisorConfig('nope')).toThrow()
    expect(() => resolveAdvisorConfig(null)).toThrow()
    expect(() => resolveAdvisorConfig([1, 2])).toThrow()
  })
})
