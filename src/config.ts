/**
 * dsh-advisor plugin configuration contract (spec §5 / S4).
 *
 * The exported schemastery `Config` schema is what the cordis Loader uses to
 * validate the plugin row config: it applies defaults (`enabled` false,
 * `immuneTurns` 3, `maxDeltaMessages` 60, `systemPrompt` "") and enforces
 * types/bounds (integers ≥ 0). All six live fields are declared `.volatile()`:
 * the Loader commits edits to them into the running fiber's references WITHOUT
 * a remount (dsh 0.1.7-rc.1 — the settings.yaml user layer is gone), so
 * `apply` receives each field as a `{ get() }` reference and every read must
 * unwrap it first — {@link unwrapAdvisorConfig}, which tolerates plain values
 * too (integration harnesses pass plain objects).
 *
 * `resolveAdvisorConfig(raw)` additionally enforces the explicit model gate:
 * when `enabled` is true but `provider` or `model` is missing or empty, it
 * resolves to a disabled-with-reason config — the advisor never starts a model
 * call (hard gate, not a warning). The volatile unwrap happens BEFORE the gate:
 * an unwrapped reference object is truthy, so the enabled/provider/model reads
 * would silently pass the gate on the reference objects themselves.
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
 * Volatile (dsh 0.1.7-rc.1): every field is a LIVE field. The Loader commits
 * edits into the running fiber's references without remounting the plugin
 * (same pattern as dsh `agent-default-model`), so flat, always-present fields
 * are exactly what the settings forms surface. `.volatile()` requires a fixed
 * object path with no enclosing volatile field — this flat schema qualifies.
 *
 * Type note: left to inference (`Schema<ObjectS, ObjectT>`), so calling the
 * schema accepts partial input (each key optional, `| null`) and yields the
 * fully-defaulted output — matching schemastery's runtime semantics. With
 * `.volatile()` the output type of each field is the reference shape; the
 * resolver reads through {@link unwrapAdvisorConfig}, keeping this module's
 * exported contracts plain-valued.
 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  provider: z.string().volatile(),
  model: z.string().volatile(),
  systemPrompt: z.string().default('').volatile(),
  immuneTurns: z.number().step(1).min(0).default(3).volatile(),
  maxDeltaMessages: z.number().step(1).min(0).default(60).volatile(),
})

function isNonEmptyString(value: string | undefined): value is string {
  // Trim before checking: a whitespace-only value ("   ") is empty in effect
  // and must trip the explicit gate (spec §5.2 "missing or empty"; qc2 W-3 /
  // qc3 I-3 — a strict superset of dsh's own `length === 0` check).
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * The entry config as the runtime hands it to `apply` (dsh 0.1.7-rc.1): every
 * field declared `.volatile()` arrives as a cosmokit `Volatile` reference —
 * a `{ get() }` object the Loader commits live edits into — instead of the
 * bare value. Deliberately loose (`unknown` value side): the reference vs.
 * plain distinction is a runtime duck-type, not a static one, and plain
 * values remain legal input (integration harnesses never resolve through the
 * Loader).
 */
export interface VolatileAdvisorConfig {
  readonly enabled: unknown
  readonly provider?: unknown
  readonly model?: unknown
  readonly systemPrompt: unknown
  readonly immuneTurns: unknown
  readonly maxDeltaMessages: unknown
}

/**
 * Read one volatile field: unwrap the `{ get() }` reference the Loader hands
 * over, pass plain values through. Duck-typed on purpose — cosmokit's
 * reference protocol is structural (`{ get }`), and importing the cosmokit
 * types would add an undeclared dependency for one member.
 */
function unwrapReference<T>(value: unknown): T {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

/**
 * Snapshot the live entry config into a plain {@link AdvisorConfig}: every
 * schema-declared field is read through its volatile reference (or taken as
 * the plain value it is on non-Loader paths), and `null` — which schemastery
 * passes through for fields without a default — is normalized to `undefined`
 * so the resolved contract is null-free and the gate treats null exactly like
 * a missing value. Keys outside the schema ride along untouched (the
 * schemastery object resolver merges unknown keys through; they are never
 * volatile-declared, so they are never references) — the hard gate's
 * unknown-key rejection must keep seeing them.
 *
 * This is a snapshot read, NOT a validation: the result is the RAW composed
 * config `resolveAdvisorConfig` consumes.
 */
export function unwrapAdvisorConfig(raw: VolatileAdvisorConfig): AdvisorConfig {
  const { enabled, provider, model, systemPrompt, immuneTurns, maxDeltaMessages, ...rest } = raw
  return {
    ...rest,
    enabled: unwrapReference<boolean>(enabled),
    provider: unwrapReference<string | undefined>(provider) ?? undefined,
    model: unwrapReference<string | undefined>(model) ?? undefined,
    systemPrompt: unwrapReference<string>(systemPrompt),
    immuneTurns: unwrapReference<number>(immuneTurns),
    maxDeltaMessages: unwrapReference<number>(maxDeltaMessages),
  }
}

/**
 * Resolve the raw config into the runtime contract.
 *
 * - Rejects unknown keys (strict schema, spec §5.2) and non-object input.
 * - Applies the explicit model gate (S4): `enabled: true` with `provider` or
 *   `model` missing/empty → disabled-with-reason, never throws, no model call.
 * - `provider`/`model` are ignored while disabled.
 *
 * The volatile unwrap happens FIRST (before any gate read): a reference
 * object is truthy regardless of the value behind it, so gating on the raw
 * volatile fields would silently enable the advisor on `{ get() }` objects.
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
  // Config(raw) resolves each `.volatile()` field to its reference; unwrap
  // into the plain contract the gate (and every consumer) reads.
  const normalized = unwrapAdvisorConfig(Config(raw))
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
