/**
 * dsh-advisor plugin configuration contract (spec §5 / S4).
 *
 * The exported schemastery `Config` schema is what the cordis Loader uses to
 * validate the plugin row config: it applies defaults (`immuneTurns` 3,
 * `maxDeltaMessages` 60, `systemPrompt` "", `maxTokens` 768,
 * `proseFallback` false) and enforces types/bounds (integers ≥ 0; maxTokens
 * 128..16384). All seven live fields are declared `.volatile()`:
 * the Loader commits edits to them into the running fiber's references WITHOUT
 * a remount (dsh 0.1.7-rc.1 — the settings.yaml user layer is gone), so
 * `apply` receives each field as a `{ get() }` reference and every read must
 * unwrap it first — {@link unwrapAdvisorConfig}, which tolerates plain values
 * too (integration harnesses pass plain objects).
 *
 * `resolveAdvisorConfig(raw)` additionally enforces the explicit model gate.
 * There is NO config-level `enabled` key (2026-09-26 user ruling: the
 * plugin-row enable/disable toggle IS the switch, so a config key would be
 * redundant) — the gate keys purely on the pair: `provider` AND `model`
 * non-empty → enabled; otherwise it resolves to a disabled-with-reason config
 * — the advisor never starts a model call (hard gate, not a warning). The
 * volatile unwrap happens BEFORE the gate: an unwrapped reference object is
 * truthy, so the provider/model reads would silently pass the gate on the
 * reference objects themselves. A legacy `enabled` key arriving in a raw
 * config (a stored profile predating the removal) is TOLERATED and silently
 * dropped — accepted but never persisted or read (2026-09-27 user ruling:
 * the stored row must not reject the plugin); every other unknown key is
 * still rejected (spec §5.2 strict schema).
 *
 * @module dsh-advisor/config
 */

import z from '@deepseek-ai/schemastery'

/** Raw plugin row config after Loader defaults — spec §5.1. */
export interface AdvisorConfig {
  /** Provider route; REQUIRED (non-empty) for the advisor to run. */
  readonly provider?: string
  /** Model id; REQUIRED (non-empty) for the advisor to run. */
  readonly model?: string
  /** Optional system prompt override; "" = built-in reviewer prompt (T4). */
  readonly systemPrompt: string
  /** Cooldown after a delivered interrupt; integer ≥ 0, default 3. */
  readonly immuneTurns: number
  /** Delta window; integer ≥ 0, default 60, 0 = unbounded (KD-3). */
  readonly maxDeltaMessages: number
  /**
   * Token budget for one advisor call; integer 128..16384, default 768
   * (KD-I1, issue #102 — the 2026-09-29 user-directed supersession of KD-6's
   * code invariant: a thinking model behind a third-party gateway can exhaust
   * a fixed budget on reasoning and come back empty, so the operator raises
   * the budget via Settings instead). Optional in the raw contract: the
   * schema default (768) fills it on the Loader path and plain-object entries
   * may omit it — the runtime falls back to `ADVISOR_MAX_TOKENS`
   * (src/advisor-runtime.ts), keeping the default behavior byte-identical.
   */
  readonly maxTokens?: number
  /**
   * Opt-in prose fallback (KD-I2, issue #102): when true, a reply with no
   * parseable JSON frame but non-empty text is delivered as a `nit` note
   * (trimmed, surrounding fence stripped, capped at the note-char bound)
   * instead of being dropped. JSON-frame priority is unchanged — the fallback
   * applies ONLY when no frame was found. Optional in the raw contract: the
   * schema default (false) fills it on the Loader path and plain-object
   * entries may omit it — the runtime falls back to false (the KD-2 drop
   * semantics), keeping the default behavior byte-identical.
   */
  readonly proseFallback?: boolean
}

/** Config after the explicit model gate (spec §5.2) — consumed by T4/T6. */
export interface ResolvedAdvisorConfig {
  /**
   * Post-gate switch: true iff the pair is complete — NOT a config key (the
   * row toggle is the switch; a session `/advisor off` override flips this
   * to false downstream, `src/index.ts` `safeEffective`).
   */
  readonly enabled: boolean
  readonly provider?: string
  readonly model?: string
  readonly systemPrompt: string
  readonly immuneTurns: number
  readonly maxDeltaMessages: number
  /** Token budget (KD-I1); absent on plain-object entries → runtime default 768. */
  readonly maxTokens?: number
  /** Prose fallback switch (KD-I2); absent on plain-object entries → runtime default false. */
  readonly proseFallback?: boolean
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
  'provider',
  'model',
  'systemPrompt',
  'immuneTurns',
  'maxDeltaMessages',
  'maxTokens',
  'proseFallback',
])

/**
 * Removed config keys the strict unknown-key rejection TOLERATES — accepted
 * into a raw config but stripped from every snapshot/write so they are never
 * read and never re-persisted. Only the 2026-09-26-removed `enabled` lives
 * here: the plugin-row enable/disable toggle replaced the config-level master
 * switch, and stored profiles still carrying `enabled: false/true` must load
 * cleanly instead of being rejected (2026-09-27 user ruling — the stored line
 * is simply ignored; no compatibility surface beyond dropping the dead key).
 * Every other unknown key stays a hard reject (spec §5.2).
 */
const LEGACY_KEYS: ReadonlySet<string> = new Set([
  'enabled',
])

/**
 * Loader schema (strict): defaults + type/bounds validation for the plugin
 * row config. The explicit gate is intentionally NOT here — `provider`/`model`
 * stay optional so a pairless config validates and then resolves to
 * disabled-with-reason instead of failing to load. There is no `enabled`
 * field: the plugin-row enable/disable toggle is the master switch, and a
 * stored `enabled:` key is tolerated and dropped by the resolver
 * ({@link LEGACY_KEYS}) — never read, never persisted.
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
  provider: z.string().volatile(),
  model: z.string().volatile(),
  systemPrompt: z.string().default('').volatile(),
  immuneTurns: z.number().step(1).min(0).default(3).volatile(),
  maxDeltaMessages: z.number().step(1).min(0).default(60).volatile(),
  maxTokens: z.number().step(1).min(128).max(16384).default(768).volatile(),
  proseFallback: z.boolean().default(false).volatile(),
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
  readonly provider?: unknown
  readonly model?: unknown
  readonly systemPrompt: unknown
  readonly immuneTurns: unknown
  readonly maxDeltaMessages: unknown
  /** Optional like {@link AdvisorConfig.maxTokens}: plain entries may omit it; the Loader path always carries it. */
  readonly maxTokens?: unknown
  /** Optional like {@link AdvisorConfig.proseFallback}: plain entries may omit it; the Loader path always carries it. */
  readonly proseFallback?: unknown
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
 * a missing value. Legacy keys ({@link LEGACY_KEYS}) are STRIPPED before the
 * rest-spread: the schema-removed `enabled` may arrive on a stored profile
 * (or an integration entry), and the snapshot must never carry it — no
 * consumer reads it and no snapshot-derived write can re-persist it. Every
 * other key outside the schema rides along untouched (the schemastery object
 * resolver merges unknown keys through; they are never volatile-declared, so
 * they are never references) — the hard gate's unknown-key rejection must
 * keep seeing them.
 *
 * This is a snapshot read, NOT a validation: the result is the RAW composed
 * config `resolveAdvisorConfig` consumes.
 */
export function unwrapAdvisorConfig(raw: VolatileAdvisorConfig): AdvisorConfig {
  // The raw side is loose on purpose: the schema-removed `enabled` is not a
  // VolatileAdvisorConfig member but can arrive on any plain entry — the cast
  // widens only to let the destructure strip it.
  const { enabled, provider, model, systemPrompt, immuneTurns, maxDeltaMessages, maxTokens, proseFallback, ...rest } =
    raw as VolatileAdvisorConfig & { readonly enabled?: unknown }
  return {
    ...rest,
    provider: unwrapReference<string | undefined>(provider) ?? undefined,
    model: unwrapReference<string | undefined>(model) ?? undefined,
    systemPrompt: unwrapReference<string>(systemPrompt),
    immuneTurns: unwrapReference<number>(immuneTurns),
    maxDeltaMessages: unwrapReference<number>(maxDeltaMessages),
    maxTokens: unwrapReference<number | undefined>(maxTokens),
    proseFallback: unwrapReference<boolean | undefined>(proseFallback),
  }
}

/**
 * Resolve the raw config into the runtime contract.
 *
 * - Rejects unknown keys (strict schema, spec §5.2) and non-object input.
 *   The 2026-09-26-removed `enabled` is the ONE tolerated exception
 *   ({@link LEGACY_KEYS}): a stored profile still carrying it loads cleanly,
 *   the key is stripped from the snapshot and never persisted (2026-09-27
 *   user ruling — the row toggle replaced it; ignoring the stored line is the
 *   whole migration surface). Every other unknown key is still a hard reject.
 * - Applies the explicit model gate (S4): `provider` or `model` missing/empty
 *   → disabled-with-reason, never throws, no model call. Both present →
 *   `enabled: true` (the post-gate flag).
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
    if (!CONFIG_KEYS.has(key) && !LEGACY_KEYS.has(key)) {
      throw new Error(`dsh-advisor: unknown config key "${key}"`)
    }
  }
  // Config(raw) resolves each `.volatile()` field to its reference; unwrap
  // into the plain contract the gate (and every consumer) reads.
  const normalized = unwrapAdvisorConfig(Config(raw))
  const missing: string[] = []
  if (!isNonEmptyString(normalized.provider)) missing.push('provider')
  if (!isNonEmptyString(normalized.model)) missing.push('model')
  if (missing.length === 0) return { ...normalized, enabled: true }
  const disabledReason = missing.length === 2
    ? 'provider and model are missing — configure both to enable the advisor'
    : `${missing[0]} is missing or empty — configure provider and model`
  return { ...normalized, enabled: false, disabledReason }
}
