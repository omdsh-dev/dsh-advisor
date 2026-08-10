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
 * T3: session observation — subscribe `session/event`, detect stepped
 * `turn/end` (reason.kind ∈ {completed, 'max-tokens', error}, spec §4), drive
 * a per-session bounded delta renderer, and dispose per-session state on
 * `session/disposed` / `agent/disposed` (KD-5).
 * The advisor runtime (queue → llm.stream → note extraction), emission guard,
 * delivery, and commands land in T4–T8.
 *
 * @module dsh-advisor
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveAdvisorConfig } from './config'
import type { AdvisorConfig } from './config'
import { SessionTranscriptObserver } from './transcript'
import type { Delta } from './transcript'

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
  if (!resolved.enabled) return

  // T3: per-session transcript observation. On each stepped reviewable
  // turn/end a bounded markdown delta is rendered; the onDelta seam is where
  // T4's advisor runtime hooks in (queue → llm.stream → note extraction) —
  // for now the delta is only logged at debug level.
  const observer = new SessionTranscriptObserver({
    maxDeltaMessages: resolved.maxDeltaMessages,
    onDelta: (sessionId: string, delta: Delta) => {
      ctx.logger('advisor').debug('rendered transcript delta', {
        sessionId,
        willContinue: delta.willContinue,
        chars: delta.markdown.length,
      })
    },
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    observer.handleEvent(session.id, session.events, event)
  })
  // Per-session renderer lifecycle. Spec KD-5(c) pins `agent/disposed`;
  // `session/disposed` is the store-level pair (both are idempotent — a
  // renderer is deleted at most once, whichever signal lands first).
  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    observer.disposeSession(agent.id)
  })
  ctx.on('session/disposed', (session: Session) => {
    observer.disposeSession(session.id)
  })
}
