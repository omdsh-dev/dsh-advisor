/**
 * dsh-advisor plugin configuration contract (spec §5 / S4).
 *
 * The exported schemastery `Config` schema is what the cordis Loader uses to
 * validate the plugin row config: it applies defaults (`enabled` false,
 * `immuneTurns` 3, `maxDeltaMessages` 60, `systemPrompt` "") and enforces
 * types/bounds (integers ≥ 0). `resolveAdvisorConfig(raw)` additionally
 * enforces the explicit model gate: when `enabled` is true but `provider` or
 * `model` is missing or empty, it resolves to a disabled-with-reason config —
 * the advisor never starts a model call (hard gate, not a warning).
 *
 * @module dsh-advisor/config
 */

import z from '@deepseek-ai/schemastery'

/** Raw plugin row config after Loader defaults — spec §5.1. */
export interface AdvisorConfig {
  /** Master switch; default false. */
  readonly enabled: boolean
  /** Provider route; REQUIRED (non-empty) when enabled. */
  readonly provider?: string
  /** Model id; REQUIRED (non-empty) when enabled. */
  readonly model?: string
  /** Optional system prompt override; "" = built-in reviewer prompt (T4). */
  readonly systemPrompt: string
  /** Cooldown after a delivered interrupt; integer ≥ 0, default 3. */
  readonly immuneTurns: number
  /** Delta window; integer ≥ 0, default 60, 0 = unbounded (KD-3). */
  readonly maxDeltaMessages: number
}

/** Config after the explicit model gate (spec §5.2) — consumed by T4/T6. */
export interface ResolvedAdvisorConfig {
  readonly enabled: boolean
  readonly provider?: string
  readonly model?: string
  readonly systemPrompt: string
  readonly immuneTurns: number
  readonly maxDeltaMessages: number
  /** Present iff the advisor is disabled by the explicit model gate. */
  readonly disabledReason?: string
}

/**
 * Complete configuration key set for strict unknown-key rejection. The
 * schemastery object resolver merges unknown keys by default (strict flag is
 * never passed by the cordis Loader), so the resolver rejects them explicitly
 * — same pattern as `resolveSessionTitleLlmConfig` in the dsh repo.
 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'provider',
  'model',
  'systemPrompt',
  'immuneTurns',
  'maxDeltaMessages',
])

/**
 * Loader schema (strict): defaults + type/bounds validation for the plugin
 * row config. The explicit gate is intentionally NOT here — `provider`/`model`
 * stay optional so an enabled-without-pair config validates and then resolves
 * to disabled-with-reason instead of failing to load.
 *
 * Type note: left to inference (`Schema<ObjectS, ObjectT>`), so calling the
 * schema accepts partial input (each key optional, `| null`) and yields the
 * fully-defaulted output — matching schemastery's runtime semantics.
 */
export const Config = z.object({
  enabled: z.boolean().default(false),
  provider: z.string(),
  model: z.string(),
  systemPrompt: z.string().default(''),
  immuneTurns: z.number().step(1).min(0).default(3),
  maxDeltaMessages: z.number().step(1).min(0).default(60),
})

function isNonEmptyString(value: string | undefined): value is string {
  // Trim before checking: a whitespace-only value ("   ") is empty in effect
  // and must trip the explicit gate (spec §5.2 "missing or empty"; qc2 W-3 /
  // qc3 I-3 — a strict superset of dsh's own `length === 0` check).
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Resolve the raw config into the runtime contract.
 *
 * - Rejects unknown keys (strict schema, spec §5.2) and non-object input.
 * - Applies the explicit model gate (S4): `enabled: true` with `provider` or
 *   `model` missing/empty → disabled-with-reason, never throws, no model call.
 * - `provider`/`model` are ignored while disabled.
 */
export function resolveAdvisorConfig(raw: unknown): ResolvedAdvisorConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-advisor: configuration must be a plain object')
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`dsh-advisor: unknown config key "${key}"`)
    }
  }
  const config = Config(raw)
  // schemastery passes nullable input (null) through for fields without a
  // default — normalize to undefined so the resolved contract is null-free
  // and the gate treats null exactly like a missing value.
  const normalized: AdvisorConfig = {
    ...config,
    provider: config.provider ?? undefined,
    model: config.model ?? undefined,
  }
  if (!normalized.enabled) return normalized
  const missing: string[] = []
  if (!isNonEmptyString(normalized.provider)) missing.push('provider')
  if (!isNonEmptyString(normalized.model)) missing.push('model')
  if (missing.length === 0) return normalized
  const disabledReason = missing.length === 2
    ? 'enabled but provider and model are missing — configure both to enable the advisor'
    : `enabled but ${missing[0]} is missing or empty — configure provider and model`
  return { ...normalized, enabled: false, disabledReason }
}
