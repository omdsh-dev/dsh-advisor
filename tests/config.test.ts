/**
 * T2 — config schema & validation (explicit model gate, spec §5 / S4).
 *
 * Contract under test:
 * - The exported schemastery `Config` schema (the cordis Loader path) applies
 *   defaults (`enabled` false, `immuneTurns` 3, `maxDeltaMessages` 60,
 *   `systemPrompt` "") and enforces types/bounds (int ≥ 0).
 * - `resolveAdvisorConfig(raw)` never throws for the gate scenario: when
 *   `enabled` is true but `provider`/`model` is missing or empty it resolves
 *   to a disabled-with-reason config (no model call).
 * - Unknown config keys are rejected (strict schema).
 */

import { describe, expect, it } from 'vitest'
import { Config, resolveAdvisorConfig } from '../src/config'

describe('schema defaults (cordis Loader path, spec §5.1)', () => {
  it('applies defaults for an empty config', () => {
    expect(Config({})).toEqual({
      enabled: false,
      systemPrompt: '',
      immuneTurns: 3,
      maxDeltaMessages: 60,
    })
  })

  it('keeps explicit values over defaults', () => {
    expect(Config({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'custom reviewer prompt',
      immuneTurns: 5,
      maxDeltaMessages: 10,
    })).toEqual({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'custom reviewer prompt',
      immuneTurns: 5,
      maxDeltaMessages: 10,
    })
  })

  it('rejects non-boolean / non-number / non-string values', () => {
    // `as never` — inputs are intentionally invalid; runtime must reject them.
    expect(() => Config({ enabled: 'yes' as never })).toThrow()
    expect(() => Config({ immuneTurns: '3' as never })).toThrow()
    expect(() => Config({ systemPrompt: 42 as never })).toThrow()
    expect(() => Config({ provider: 7 as never })).toThrow()
  })

  it('treats null as absent (schemastery nullable input → default)', () => {
    expect(Config({ maxDeltaMessages: null }).maxDeltaMessages).toBe(60)
    expect(Config({ enabled: null }).enabled).toBe(false)
  })

  it('enforces integer ≥ 0 bounds; 0 = unbounded is allowed', () => {
    expect(() => Config({ immuneTurns: -1 })).toThrow()
    expect(() => Config({ immuneTurns: 2.5 })).toThrow()
    expect(() => Config({ maxDeltaMessages: -1 })).toThrow()
    expect(() => Config({ maxDeltaMessages: 1.5 })).toThrow()
    expect(Config({ maxDeltaMessages: 0 }).maxDeltaMessages).toBe(0)
    expect(Config({ immuneTurns: 0 }).immuneTurns).toBe(0)
  })
})

describe('explicit model gate (S4 / spec §5.2)', () => {
  it('is disabled by default without provider/model (no reason)', () => {
    const resolved = resolveAdvisorConfig({})
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toBeUndefined()
    expect(resolved.systemPrompt).toBe('')
    expect(resolved.immuneTurns).toBe(3)
    expect(resolved.maxDeltaMessages).toBe(60)
  })

  it('resolves to disabled-with-reason when enabled without provider/model', () => {
    const resolved = resolveAdvisorConfig({ enabled: true })
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toBeTruthy()
  })

  it('resolves to disabled-with-reason when only provider is set', () => {
    const resolved = resolveAdvisorConfig({ enabled: true, provider: 'deepseek' })
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toBeTruthy()
  })

  it('resolves to disabled-with-reason when only model is set', () => {
    const resolved = resolveAdvisorConfig({ enabled: true, model: 'deepseek-chat' })
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toBeTruthy()
  })

  it('treats empty provider or model as missing (gate requires both)', () => {
    expect(resolveAdvisorConfig({ enabled: true, provider: '', model: 'm' }).enabled).toBe(false)
    expect(resolveAdvisorConfig({ enabled: true, provider: 'p', model: '' }).enabled).toBe(false)
    expect(resolveAdvisorConfig({ enabled: true, provider: '', model: '' }).enabled).toBe(false)
  })

  it('treats null provider/model as missing (normalized before the gate)', () => {
    expect(resolveAdvisorConfig({ enabled: true, provider: null, model: 'm' }).enabled).toBe(false)
    expect(resolveAdvisorConfig({ enabled: true, provider: null, model: null }).enabled).toBe(false)
    const resolved = resolveAdvisorConfig({ enabled: true, provider: null, model: 'm' })
    expect(resolved.disabledReason).toBeTruthy()
  })

  it('never throws for the gate scenario', () => {
    expect(() => resolveAdvisorConfig({ enabled: true })).not.toThrow()
    expect(() => resolveAdvisorConfig({ enabled: true, provider: 'p' })).not.toThrow()
  })

  it('resolves enabled when both provider and model are present', () => {
    const resolved = resolveAdvisorConfig({
      enabled: true,
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
      enabled: true,
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

  it('ignores provider/model while disabled (gate not applied)', () => {
    const resolved = resolveAdvisorConfig({ enabled: false, provider: 'p', model: 'm' })
    expect(resolved.enabled).toBe(false)
    expect(resolved.disabledReason).toBeUndefined()
    expect(resolved.provider).toBe('p')
    expect(resolved.model).toBe('m')
  })
})

describe('strict schema — unknown keys rejected (spec §5.2)', () => {
  it('rejects unknown keys when disabled', () => {
    expect(() => resolveAdvisorConfig({ enabled: false, bogus: 1 }))
      .toThrow(/unknown config key "bogus"/)
  })

  it('rejects unknown keys when enabled with a valid pair', () => {
    expect(() => resolveAdvisorConfig({ enabled: true, provider: 'p', model: 'm', extra: true }))
      .toThrow(/unknown config key "extra"/)
  })

  it('rejects non-object config input', () => {
    expect(() => resolveAdvisorConfig('nope')).toThrow()
    expect(() => resolveAdvisorConfig(null)).toThrow()
    expect(() => resolveAdvisorConfig([1, 2])).toThrow()
  })
})
