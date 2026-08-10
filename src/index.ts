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
 * cooldown, KD-4 agent map). T7: `/advisor` toggle/on/off/status commands
 * (registered through the conditional `ctx.inject(['commands'], ...)` child)
 * drive a per-session override consulted by the runtime gate — the commands
 * start/stop per-session runtimes without touching the persisted config.
 *
 * @module dsh-advisor
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only edge: resolves `ctx.commands` for the optional command child
// (T7 — conditional `ctx.inject(['commands'], ...)` activation).
import type {} from '@deepseek-ai/dsh-commands'
import { resolveAdvisorConfig } from './config'
import type { AdvisorConfig, ResolvedAdvisorConfig } from './config'
import { SessionTranscriptObserver } from './transcript'
import type { Delta } from './transcript'
import { AdvisorRuntime } from './advisor-runtime'
import type { AdviceNote } from './advisor-runtime'
import { AdvisorDelivery } from './delivery'
import { DEFAULT_ADVISOR_SYSTEM_PROMPT } from './prompts'
import { AdvisorSessionOverrides, registerAdvisorCommands } from './commands'
import type { AdvisorCommandController } from './commands'

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

  // T7: the per-session override mechanism — `/advisor on|off|toggle` write
  // here and the runtime gate consults `override ?? config.enabled`, so the
  // commands start/stop per-session runtimes WITHOUT touching the persisted
  // config (spec §4 mapping — omp `/advisor` semantics). Ephemeral: entries
  // are cleared on `agent/disposed` / `session/disposed` below. The explicit
  // S4 gate (spec §5.2) is re-applied per session through the config
  // resolver, which is the SSOT for the disabled-with-reason text.
  const overrides = new AdvisorSessionOverrides(resolved.enabled)
  const effectiveEnabled = (sessionId: string): boolean => overrides.effective(sessionId)
  const effectiveConfig = (sessionId: string): ResolvedAdvisorConfig =>
    resolveAdvisorConfig({ ...config, enabled: effectiveEnabled(sessionId) })

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
  /**
   * Create (or return) the runtime for one session, gated on the effective
   * switch: `undefined` when the session is disabled or the S4 explicit gate
   * blocks model calls (effective enabled without provider/model — spec
   * §5.2). T7's `/advisor on` turns a session on without a config change by
   * flipping the override, which this gate reads.
   */
  const ensureRuntime = (sessionId: string): AdvisorRuntime | undefined => {
    if (!effectiveEnabled(sessionId)) return undefined
    let runtime = runtimes.get(sessionId)
    if (runtime !== undefined) return runtime
    const effective = effectiveConfig(sessionId)
    // The re-resolved config guarantees provider + model when enabled — the
    // runtime is only constructed behind the gate.
    if (!effective.enabled) return undefined
    runtime = new AdvisorRuntime({
      provider: effective.provider!,
      model: effective.model!,
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
      // KD-5: a compaction / surface rewrite resets the immuneTurns latch
      // (delivery) AND the emission-guard dedupe history (runtime) — session
      // state is being rewritten, so both latches' basis no longer applies.
      // T8: guard reset wired through the runtime (T5 ⚠️ follow-through).
      delivery.reset(sessionId)
      runtimes.get(sessionId)?.resetGuard()
    },
    onDelta: (sessionId: string, delta: Delta) => {
      // Lazy creation fallback covers agents that existed before this plugin
      // loaded (their `agent/created` was never observed); `agent/created`
      // below creates eagerly for the common path. The runtime gate drops the
      // delta for sessions that are disabled or S4-gate-blocked (T7).
      ensureRuntime(sessionId)?.enqueue(delta)
    },
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    observer.handleEvent(session.id, session.events, event)
  })
  // Per-session runtime lifecycle. Spec KD-5(c) pins `agent/disposed`;
  // `session/disposed` is the store-level pair (both are idempotent — a
  // runtime is disposed at most once, whichever signal lands first). `agent/created`
  // creates the runtime eagerly (plan T4) when the session is enabled and
  // registers the agent in the KD-4 delivery map (T6); the observer fallback
  // covers pre-existing agents (KD-4-style robustness).
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    ensureRuntime(agent.id)
    delivery.registerAgent(agent)
  })
  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    observer.disposeSession(agent.id)
    disposeRuntime(agent.id)
    delivery.unregisterAgent(agent.id)
    overrides.clear(agent.id)
  })
  ctx.on('session/disposed', (session: Session) => {
    observer.disposeSession(session.id)
    disposeRuntime(session.id)
    delivery.unregisterAgent(session.id)
    overrides.clear(session.id)
  })

  // T7: the `/advisor` command controller — the commands' session-scoped
  // operations against the observer/runtimes above. `/advisor on` seeds the
  // observer cursor to the current transcript length (KD-5 seed-on-enable —
  // no full-history replay) and creates/resumes the session runtime; `/advisor
  // off` disposes it (abort in-flight, drop backlog). The S4 gate reason is
  // re-derived through the config resolver, the SSOT for the disabled-with-
  // reason text (spec §5.2).
  const controller: AdvisorCommandController = {
    setEnabled(sessionId: string, enabled: boolean, sessionLength?: number): void {
      if (effectiveEnabled(sessionId) === enabled) return
      overrides.set(sessionId, enabled)
      if (enabled) {
        // KD-5: seed to the current transcript length — no full replay of
        // history that predates the enable.
        if (sessionLength !== undefined) observer.seedTo(sessionId, sessionLength)
        ensureRuntime(sessionId)?.resume()
      } else {
        disposeRuntime(sessionId)
      }
    },
    getStatus(sessionId: string) {
      const runtime = runtimes.get(sessionId)
      const effective = effectiveConfig(sessionId)
      return {
        enabled: effective.enabled,
        ...(effective.disabledReason === undefined ? {} : { disabledReason: effective.disabledReason }),
        provider: resolved.provider,
        model: resolved.model,
        runtimeStatus: runtime?.status() ?? 'disabled',
        pendingCount: runtime?.pendingCount ?? 0,
        lastActivityAt: runtime?.lastActivity,
      }
    },
  }

  // T7: the command child activates ONLY when a command registry is composed
  // (conditional child activation — `commands` must NOT join the top-level
  // `inject` list, T1 fix). `/advisor` toggle/on/off/status (spec §2 S5).
  ctx.inject(['commands'], (commandCtx) => {
    registerAdvisorCommands(commandCtx.commands, controller)
  })
}
