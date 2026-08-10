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
 * T4: the per-session advisor runtime — queue each rendered delta, drain
 * asynchronously via `ctx.llm.stream` (system prompt + delta, `purpose` left
 * unset, KD-5), extract `{note, severity}` (KD-2), and apply the failure
 * policy (retry-light → drop, 3-drop backlog flush, quota pause, permanent
 * halt — never park the primary). The emission guard (T5) gates extracted
 * notes before delivery; the delivery router (T6) routes accepted notes into
 * the primary agent (nit → inject, concern/blocker → steer, immuneTurns
 * cooldown, KD-4 agent map). Commands (T7) land in T7–T8.
 *
 * @module dsh-advisor
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveAdvisorConfig } from './config'
import type { AdvisorConfig } from './config'
import { SessionTranscriptObserver } from './transcript'
import type { Delta } from './transcript'
import { AdvisorRuntime } from './advisor-runtime'
import type { AdviceNote } from './advisor-runtime'
import { AdvisorDelivery } from './delivery'
import { DEFAULT_ADVISOR_SYSTEM_PROMPT } from './prompts'

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

  // T3+T4: per-session transcript observation wired into one advisor runtime
  // per session. On each stepped reviewable turn/end a bounded markdown delta
  // is rendered and queued on the session's runtime; the runtime drains it
  // asynchronously through `ctx.llm.stream`, gates the extracted `AdviceNote`
  // through the T5 emission guard (inside the runtime, between extraction and
  // delivery), and hands accepted notes to `onNote` (T6 routes them).
  // T6: the delivery router. Owns the KD-4 per-session agent map (keyed by
  // agent.id === session.id, maintained on agent/created / agent/disposed
  // below), the severity → channel mapping (nit → inject; concern/blocker →
  // steer), and the immuneTurns cooldown (spec §6). Accepted notes from the
  // runtime's onNote are routed here; missing agent → drop + log (KD-4).
  const delivery = new AdvisorDelivery({
    immuneTurns: resolved.immuneTurns,
    // Registry fallback (KD-4): covers agents published before this plugin
    // loaded, whose `agent/created` was never observed. The delivery module is
    // session-id-string-typed; the registry key is the branded SessionId.
    lookupAgent: (sessionId: string) => ctx.agents.get(sessionId as SessionId),
    logger: ctx.logger('advisor'),
  })

  const runtimes = new Map<string, AdvisorRuntime>()
  const ensureRuntime = (sessionId: string): AdvisorRuntime => {
    let runtime = runtimes.get(sessionId)
    if (runtime !== undefined) return runtime
    // The explicit gate (T2) guarantees provider + model when enabled — the
    // runtime is only ever created after the `!resolved.enabled` early return.
    runtime = new AdvisorRuntime({
      provider: resolved.provider!,
      model: resolved.model!,
      systemPrompt: resolved.systemPrompt || DEFAULT_ADVISOR_SYSTEM_PROMPT,
      llm: ctx.llm,
      onNote: (note: AdviceNote) => {
        // Accepted notes only — the runtime's emission guard (T5) already
        // filtered suppressed ones. T6 routes the accepted note to the primary
        // agent (inject/steer); delivery throws stay contained in the runtime
        // path (T4 F1), so a failing agent can only drop its own advice.
        const channel = delivery.route(sessionId, note)
        ctx.logger('advisor').debug('advice note delivered', {
          sessionId,
          severity: note.severity,
          channel,
        })
      },
    })
    runtimes.set(sessionId, runtime)
    return runtime
  }
  const disposeRuntime = (sessionId: string): void => {
    const runtime = runtimes.get(sessionId)
    if (runtime === undefined) return
    runtimes.delete(sessionId)
    runtime.dispose()
  }

  const observer = new SessionTranscriptObserver({
    maxDeltaMessages: resolved.maxDeltaMessages,
    onSteppedTurnEnd: (sessionId: string) => {
      // One completed stepped primary turn — decrement the immuneTurns
      // cooldown (T6, spec §6). Fires before the delta render, so the note
      // this very turn produces is routed with the decremented cooldown.
      delivery.onSteppedTurnEnd(sessionId)
    },
    onRewrite: (sessionId: string) => {
      // KD-5: a compaction / surface rewrite resets the immuneTurns latch.
      delivery.reset(sessionId)
    },
    onDelta: (sessionId: string, delta: Delta) => {
      // Lazy creation fallback covers agents that existed before this plugin
      // loaded (their `agent/created` was never observed); `agent/created`
      // below creates eagerly for the common path.
      ensureRuntime(sessionId).enqueue(delta)
    },
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    observer.handleEvent(session.id, session.events, event)
  })
  // Per-session runtime lifecycle. Spec KD-5(c) pins `agent/disposed`;
  // `session/disposed` is the store-level pair (both are idempotent — a
  // runtime is disposed at most once, whichever signal lands first). `agent/created`
  // creates the runtime eagerly (plan T4) and registers the agent in the
  // KD-4 delivery map (T6); the observer fallback covers pre-existing agents
  // (KD-4-style robustness).
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    ensureRuntime(agent.id)
    delivery.registerAgent(agent)
  })
  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    observer.disposeSession(agent.id)
    disposeRuntime(agent.id)
    delivery.unregisterAgent(agent.id)
  })
  ctx.on('session/disposed', (session: Session) => {
    observer.disposeSession(session.id)
    disposeRuntime(session.id)
    delivery.unregisterAgent(session.id)
  })
}
