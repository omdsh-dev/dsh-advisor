/**
 * dsh advisor plugin — a per-session reviewer model (port of the omp
 * "advisor" subsystem). Observes the primary transcript, reviews each stepped
 * turn with an explicitly configured model, and injects severity-ranked
 * advice (nit/concern/blocker) without polluting or recursively reviewing
 * itself.
 *
 * T1 scaffold: declares the Cordis plugin entry (`name`/`inject`/`apply`).
 * The runtime wiring (config gate, session observation, advisor call,
 * emission guard, delivery, commands) lands in T2–T8.
 *
 * @module dsh-advisor
 */

import type { Context } from 'cordis'

export const name = 'dsh-advisor'

/** Services the advisor consumes; the row loads once all are available. */
export const inject = ['sessions', 'agents', 'llm']

export function apply(ctx: Context) {
  // T2: load + validate config (explicit provider/model gate — no model call
  // without both).
  // T3: subscribe session/event; render bounded deltas per session.
  // T4: advisor runtime (ctx.llm.stream + JSON-frame note extraction).
  // T5/T6: emission guard + inject/steer delivery with immuneTurns cooldown.
  // T7: /advisor commands.
  ctx.logger('advisor').debug('dsh-advisor loaded (T1 scaffold)')
}
