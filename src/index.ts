/**
 * dsh advisor plugin — a per-session reviewer model (port of the omp
 * "advisor" subsystem). Observes the primary transcript, reviews each stepped
 * turn with an explicitly configured model, and injects severity-ranked
 * advice (nit/concern/blocker) without polluting or recursively reviewing
 * itself.
 *
 * T1 scaffold: declares the Cordis plugin entry (`name`/`inject`/`apply`).
 * T2: config contract — the Loader schema (`Config`) plus the explicit
 * provider/model gate via `resolveAdvisorConfig` (spec §5 / S4).
 * The runtime wiring (session observation, advisor call, emission guard,
 * delivery, commands) lands in T3–T8.
 *
 * @module dsh-advisor
 */

import type { Context } from 'cordis'
import { resolveAdvisorConfig } from './config'
import type { AdvisorConfig } from './config'

export const name = 'dsh-advisor'

/** Services the advisor consumes; the row loads once all are available. */
export const inject = ['sessions', 'agents', 'llm']

/** Loader schema (schemastery, strict) — validated by the cordis Loader. */
export { Config } from './config'
export type { AdvisorConfig, ResolvedAdvisorConfig } from './config'

export function apply(ctx: Context, config: AdvisorConfig) {
  // T2: load + validate config (explicit provider/model gate — no model call
  // without both). Unknown keys / malformed config throw here, rejecting the
  // plugin row at load; the gate resolves to disabled-with-reason instead.
  const resolved = resolveAdvisorConfig(config)
  ctx.logger('advisor').debug('dsh-advisor loaded', {
    enabled: resolved.enabled,
    disabledReason: resolved.disabledReason,
  })
  // T3: subscribe session/event; render bounded deltas per session.
  // T4: advisor runtime (ctx.llm.stream + JSON-frame note extraction).
  // T5/T6: emission guard + inject/steer delivery with immuneTurns cooldown.
  // T7: /advisor commands.
}
