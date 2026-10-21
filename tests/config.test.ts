/**
 * T2 — config schema & validation (explicit model gate, spec §5 / S4).
 *
 * Contract under test:
 * - The exported schemastery `Config` schema (the cordis Loader path) applies
 *   defaults (`immuneTurns` 3, `maxDeltaMessages` 60, `systemPrompt` "",
 *   `proseFallback` false) and enforces types/bounds (int ≥ 0). There is NO
 *   `maxTokens` key (2026-10-18 user ruling: the model-side token budget is
 *   removed — output is bounded at extraction by ADVISOR_NOTE_MAX_CHARS).
 *   `reasoningEffort` deliberately has NO
 *   default (an absent value means automatic — the smallest effort the
 *   resolved model declares). All nine live fields are `.volatile()`:
 *   `Config(raw)` resolves them to `{ get() }` references (the loader's
 *   no-remount edit channel), and the reads below go through
 *   `unwrapAdvisorConfig` — the same unwrapping the runtime does before the
 *   gate.
 * - `resolveAdvisorConfig(raw)` never throws for the gate scenario: there is
 *   no config-level `enabled` key (2026-09-26 — the plugin-row toggle is the
 *   switch), so when `provider`/`model` is missing or empty it resolves to a
 *   disabled-with-reason config (no model call); a complete pair resolves
 *   enabled.
 * - Unknown config keys are rejected (strict schema) — with TWO tolerated
 *   legacy exceptions: the 2026-09-26-removed `enabled` key (2026-09-27 user
 *   ruling — the row toggle replaced it, the dead value is never read and
 *   never re-persisted) and the 2026-10-18-removed `maxTokens` key (the
 *   model-side budget is gone; a stored profile still carrying it loads
 *   cleanly, the dead value is never read and never re-persisted).
 */

import { describe, expect, it } from 'vitest'
import { Config, resolveAdvisorConfig, unwrapAdvisorConfig } from '../src/config'

describe('schema defaults (cordis Loader path, spec §5.1)', () => {
  it('resolves every live field to a volatile reference (the no-remount edit channel)', () => {
    // 0.1.7-rc.1: `.volatile()` makes the loader commit edits into the running
    // fiber's references. A resolved field must duck-type as `{ get() }` —
    // every runtime read (unwrapAdvisorConfig → the gate) depends on it.
    const resolved: Record<string, unknown> = Config({})
    for (const key of ['provider', 'model', 'systemPrompt', 'immuneTurns', 'maxDeltaMessages', 'proseFallback', 'nextPrompt', 'defaultEnabled']) {
      expect(typeof (resolved[key] as { get?: unknown }).get, key).toBe('function')
    }
  })

  it('applies defaults for an empty config', () => {
    expect(unwrapAdvisorConfig(Config({}))).toEqual({
      systemPrompt: '',
      immuneTurns: 3,
      maxDeltaMessages: 60,
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
    })
  })

  it('keeps explicit values over defaults', () => {
    expect(unwrapAdvisorConfig(Config({
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'custom reviewer prompt',
      immuneTurns: 5,
      maxDeltaMessages: 10,
      proseFallback: true,
    }))).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'custom reviewer prompt',
      immuneTurns: 5,
      maxDeltaMessages: 10,
      proseFallback: true,
      nextPrompt: true,
      defaultEnabled: true,
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
      proseFallback: true,
    })).toEqual({
      enabled: true,
      provider: 'p',
      model: 'm',
      systemPrompt: 'custom',
      immuneTurns: 5,
      maxDeltaMessages: 0,
      proseFallback: true,
      nextPrompt: true,
      defaultEnabled: true,
    })
  })
})

describe('defaultEnabled — persisted session default (GitHub issue #124)', () => {
  it('defaults to true in the Loader schema and on BOTH resolver arms', () => {
    expect(unwrapAdvisorConfig(Config({})).defaultEnabled).toBe(true)
    // Enabled arm (pair complete).
    const enabled = resolveAdvisorConfig({ provider: 'p', model: 'm' })
    expect(enabled.enabled).toBe(true)
    expect(enabled.defaultEnabled).toBe(true)
    // Disabled-with-reason arm (pair gate) — the boolean is still present.
    const gated = resolveAdvisorConfig({})
    expect(gated.enabled).toBe(false)
    expect(gated.disabledReason).toBeTruthy()
    expect(gated.defaultEnabled).toBe(true)
  })

  it('carries an explicit false as a plain boolean on both gate arms', () => {
    expect(unwrapAdvisorConfig(Config({ defaultEnabled: false })).defaultEnabled).toBe(false)
    const enabled = resolveAdvisorConfig({ provider: 'p', model: 'm', defaultEnabled: false })
    expect(enabled.enabled).toBe(true) // defaultEnabled does not close the pair gate
    expect(enabled.defaultEnabled).toBe(false)
    const gated = resolveAdvisorConfig({ defaultEnabled: false })
    expect(gated.enabled).toBe(false)
    expect(gated.defaultEnabled).toBe(false)
  })

  it('rejects near-miss keys — defaultEnabled is a NEW key, exact-matched, not a legacy key', () => {
    expect(() => resolveAdvisorConfig({ defaultEnableds: true }))
      .toThrow(/unknown config key "defaultEnableds"/)
    expect(() => resolveAdvisorConfig({ provider: 'p', model: 'm', DefaultEnabled: true }))
      .toThrow(/unknown config key "DefaultEnabled"/)
    // Schema type enforcement too: only a boolean validates.
    expect(() => Config({ defaultEnabled: 'yes' as never })).toThrow()
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
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
    })
  })

  it('tolerates and drops the legacy `maxTokens` key (2026-10-18 ruling — stored profiles load cleanly)', () => {
    // Same migration surface as `enabled`: a stored profile still carrying a
    // `maxTokens:` line (e.g. the operator's live workaround value 5128) is
    // accepted but IGNORED — the budget is gone, the value never influences
    // the resolution and is stripped from the snapshot.
    const withPair = resolveAdvisorConfig({ maxTokens: 5128, provider: 'p', model: 'm' })
    expect(withPair.enabled).toBe(true)
    expect('maxTokens' in withPair).toBe(false)
    expect(unwrapAdvisorConfig(Config({ maxTokens: 5128, provider: 'p' }))).toEqual({
      provider: 'p',
      systemPrompt: '',
      immuneTurns: 3,
      maxDeltaMessages: 60,
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
    })
  })

  it('tolerates and drops BOTH legacy keys at once (dual-legacy stored profile loads cleanly)', () => {
    // The worst realistic migration surface: a stored profile still carrying
    // `enabled:` AND `maxTokens:` alongside every live key. Both dead values
    // are ignored (resolution keys purely on the pair) and neither key ever
    // reaches the snapshot.
    const withPair = resolveAdvisorConfig({
      enabled: false,
      maxTokens: 5128,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'custom reviewer prompt',
      immuneTurns: 5,
      maxDeltaMessages: 10,
      proseFallback: true,
      reasoningEffort: 'high',
    })
    expect(withPair.enabled).toBe(true)
    expect(withPair.provider).toBe('deepseek')
    expect(withPair.model).toBe('deepseek-chat')
    // `enabled` here is the DERIVED pair-gate verdict, not the legacy value.
    expect('maxTokens' in withPair).toBe(false)
    expect(unwrapAdvisorConfig(Config({
      enabled: false,
      maxTokens: 5128,
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'custom reviewer prompt',
      immuneTurns: 5,
      maxDeltaMessages: 10,
      proseFallback: true,
      reasoningEffort: 'high',
    }))).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      systemPrompt: 'custom reviewer prompt',
      immuneTurns: 5,
      maxDeltaMessages: 10,
      proseFallback: true,
      reasoningEffort: 'high',
      nextPrompt: true,
      defaultEnabled: true,
    })
  })

  it('keeps legacy-key matching exact — case/typo near-misses stay hard rejects', () => {
    // LEGACY_KEYS matching is exact: only `enabled` and `maxTokens` are
    // tolerated. A casing or underscore variant is an unknown key (spec §5.2
    // strict schema unchanged).
    expect(() => resolveAdvisorConfig({ provider: 'p', model: 'm', maxtoken: 5128 }))
      .toThrow(/unknown config key "maxtoken"/)
    expect(() => resolveAdvisorConfig({ provider: 'p', model: 'm', max_token: 5128 }))
      .toThrow(/unknown config key "max_token"/)
  })

  it('rejects non-object config input', () => {
    expect(() => resolveAdvisorConfig('nope')).toThrow()
    expect(() => resolveAdvisorConfig(null)).toThrow()
    expect(() => resolveAdvisorConfig([1, 2])).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Output-resilience keys — proseFallback (issue #102, KD-I2)
// ---------------------------------------------------------------------------

describe('output-resilience keys — proseFallback (issue #102, KD-I2)', () => {
  it('defaults proseFallback to false', () => {
    const resolved = unwrapAdvisorConfig(Config({}))
    expect(resolved.proseFallback).toBe(false)
  })

  it('treats null as absent for the key (schemastery nullable input → default)', () => {
    expect(unwrapAdvisorConfig(Config({ proseFallback: null })).proseFallback).toBe(false)
  })

  it('passes configured values through the volatile unwrap', () => {
    expect(unwrapAdvisorConfig(Config({ proseFallback: true }))).toMatchObject({
      proseFallback: true,
    })
  })

  it('keeps unknown-key rejection strict with near-miss keys (a typo stays a hard reject)', () => {
    // The exact key set matters: a typo'd near-miss must not slip through
    // (spec §5.2 strict schema unchanged) — and the removed `maxTokens` key
    // is a TOLERATED legacy drop, not a legal key.
    expect(() => resolveAdvisorConfig({ provider: 'p', model: 'm', proseFallbacks: true }))
      .toThrow(/unknown config key "proseFallbacks"/)
  })

  it('accepts the key on a resolved config (Loader path → explicit gate)', () => {
    const resolved = resolveAdvisorConfig({ provider: 'p', model: 'm', proseFallback: true })
    expect(resolved.enabled).toBe(true)
    expect(resolved.proseFallback).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Reasoning effort key — reasoningEffort (plan dsh-advisor-reasoning-effort, T1)
// ---------------------------------------------------------------------------

describe('reasoningEffort key (plan dsh-advisor-reasoning-effort, T1)', () => {
  it('resolves an absent key to undefined (= automatic: the model\'s smallest declared effort)', () => {
    expect(unwrapAdvisorConfig(Config({})).reasoningEffort).toBeUndefined()
    expect(resolveAdvisorConfig({ provider: 'p', model: 'm' }).reasoningEffort).toBeUndefined()
  })

  it('passes a configured effort id through the volatile unwrap unchanged', () => {
    expect(unwrapAdvisorConfig(Config({ reasoningEffort: 'high' })).reasoningEffort).toBe('high')
    expect(resolveAdvisorConfig({ provider: 'p', model: 'm', reasoningEffort: 'low' })).toMatchObject({
      enabled: true,
      reasoningEffort: 'low',
    })
  })

  it('normalizes an empty / whitespace-only value to undefined (empty = automatic)', () => {
    expect(unwrapAdvisorConfig(Config({ reasoningEffort: '' })).reasoningEffort).toBeUndefined()
    expect(unwrapAdvisorConfig(Config({ reasoningEffort: '   ' })).reasoningEffort).toBeUndefined()
    expect(resolveAdvisorConfig({ provider: 'p', model: 'm', reasoningEffort: '' }).reasoningEffort).toBeUndefined()
  })

  it('trims padding around a configured effort id (it must match the model\'s declared id exactly)', () => {
    expect(unwrapAdvisorConfig(Config({ reasoningEffort: ' high ' })).reasoningEffort).toBe('high')
  })

  it('keeps unknown-key rejection strict with the new key in CONFIG_KEYS (near-miss + wrong type stay rejects)', () => {
    expect(() => resolveAdvisorConfig({ provider: 'p', model: 'm', reasoningEfforts: 'high' }))
      .toThrow(/unknown config key "reasoningEfforts"/)
    expect(() => resolveAdvisorConfig({ provider: 'p', model: 'm', reasoningEffort: 3 as never }))
      .toThrow()
  })
})

// ---------------------------------------------------------------------------
// Next-prompt key — nextPrompt (plan dsh-advisor-next-prompt-n12, T1)
// ---------------------------------------------------------------------------

describe('nextPrompt key (plan dsh-advisor-next-prompt-n12, T1)', () => {
  it('defaults to true (the schema default fills it on the Loader path)', () => {
    const unwrapped = unwrapAdvisorConfig(Config({}))
    expect(unwrapped.nextPrompt).toBe(true)
    // Volatile like every other live field: the Loader commits edits into the
    // running fiber's `{ get() }` reference — the no-remount edit channel the
    // runtime unwrap depends on.
    const resolved: Record<string, unknown> = Config({})
    expect(typeof (resolved.nextPrompt as { get?: unknown }).get).toBe('function')
    // The resolver (the runtime's SSOT read) carries the default too.
    expect(resolveAdvisorConfig({ provider: 'p', model: 'm' }).nextPrompt).toBe(true)
  })

  it('round-trips a configured false through the schema and the resolver (get/resolve)', () => {
    expect(unwrapAdvisorConfig(Config({ nextPrompt: false })).nextPrompt).toBe(false)
    const resolved = resolveAdvisorConfig({ provider: 'p', model: 'm', nextPrompt: false })
    expect(resolved.enabled).toBe(true)
    expect(resolved.nextPrompt).toBe(false)
    // Null input behaves like absent — the default (true) fills it.
    expect(unwrapAdvisorConfig(Config({ nextPrompt: null })).nextPrompt).toBe(true)
  })

  it('keeps unknown-key rejection strict with the new key in CONFIG_KEYS (near-miss + wrong type stay rejects)', () => {
    // A typo'd near-miss must not slip through just because `nextPrompt` is
    // now legal (spec §5.2 strict schema unchanged).
    expect(() => resolveAdvisorConfig({ provider: 'p', model: 'm', nextPrompts: true }))
      .toThrow(/unknown config key "nextPrompts"/)
    expect(() => resolveAdvisorConfig({ provider: 'p', model: 'm', nextPrompt: 'yes' as never }))
      .toThrow()
  })
})
