/**
 * Delivery routing (spec §2 S3, §4 mapping row, §6 delivery semantics,
 * §8.4 KD-4) — the advice delivery channel into the primary agent.
 *
 * One {@link AdvisorDelivery} exists per plugin load and owns:
 *
 * - **The KD-4 per-session agent map**: keyed by `agent.id` (=== `session.id`),
 *   maintained by `index.ts` on `agent/created` / `agent/disposed`, with a
 *   registry fallback (`ctx.agents.get(session.id)`, injected as
 *   `lookupAgent`) that covers agents published before this plugin loaded.
 *   A missing agent at delivery time drops the note with a log — advisory
 *   only, never throw, never stall.
 * - **Severity routing (spec §6)**: nit → `agent.inject` (non-waking, consumed
 *   at the next pre-step boundary); concern/blocker → `agent.steer` (waking —
 *   an idle driver starts a turn, a running driver consumes at its next step
 *   boundary).
 * - **The immuneTurns cooldown (spec §6)**: after a concern/blocker is actually
 *   steered, the next `immuneTurns` stepped primary turns must complete before
 *   another interrupting note may steer; interrupting notes inside the window
 *   downgrade to inject. The fence arms only on a real steer delivery; the
 *   observer's `onSteppedTurnEnd` / `onRewrite` hooks (T3 wiring) drive the
 *   countdown and the KD-5 reset.
 *
 * Message shape (spec §6): a user-role message via `createUserMessage` whose
 * source carries the distinct `kind === 'advisor'` (the plugin's
 * `MessageSourceMap` merge extension, src/kinds.ts) and whose content is
 * self-describing `[advisor:{severity}] {note}` — the only cue the primary
 * model gets about how to treat it ("weigh, don't blindly obey" spirit).
 *
 * Delivery is synchronous and fire-and-forget; the runtime path (T4 F1) is
 * what contains a throwing `inject`/`steer` — this module lets agent-method
 * throws propagate to that containment seam.
 *
 * @module dsh-advisor/delivery
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { ADVISOR_SOURCE_KIND } from './kinds'
import type { AdviceNote, AdviceSeverity } from './advisor-runtime'

/** The channel one accepted note is delivered on (spec §6). */
export type DeliveryChannel = 'inject' | 'steer'

/** Minimal `Agent` surface the delivery router drives (spec §4, KD-4). */
export interface AdvisorDeliveryAgent {
  /** `Agent.id` — equals the session id by construction (KD-4). */
  readonly id: string
  /** Non-waking: queue model-facing context for the next pre-step (spec §6). */
  inject(message: UserMessage): void
  /** Waking: submit steering for the nearest step (spec §6). */
  steer(message: UserMessage): void
}

/** Logger seam (cordis `ctx.logger('advisor')` satisfies it; console works too). */
export interface AdvisorDeliveryLogger {
  debug(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** Options for one {@link AdvisorDelivery}. */
export interface AdvisorDeliveryOptions {
  /** immuneTurns cooldown length (config, default 3, ≥ 0). */
  readonly immuneTurns: number
  /**
   * KD-4 registry fallback (`ctx.agents.get(sessionId)`) — resolves agents
   * published before this plugin loaded, whose `agent/created` was never
   * observed. Absent → the map alone is authoritative.
   */
  readonly lookupAgent?: (sessionId: string) => AdvisorDeliveryAgent | undefined
  readonly logger?: AdvisorDeliveryLogger
}

/**
 * Build the advisor message for one note (spec §6): a user-role message whose
 * source carries the distinct advisor kind and whose content is self-describing
 * `[advisor:{severity}] {note}`.
 */
export function buildAdvisorMessage(note: AdviceNote): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `[advisor:${note.severity}] ${note.note}` }],
    source: { kind: ADVISOR_SOURCE_KIND },
  })
}

/** True when a note interrupts the primary (concern/blocker — spec §6). */
function isInterrupting(severity: AdviceSeverity): boolean {
  return severity === 'concern' || severity === 'blocker'
}

/**
 * Per-plugin delivery router: severity → channel, the KD-4 agent map, and the
 * immuneTurns cooldown. Cordis-free, so the routing logic is unit-testable.
 */
export class AdvisorDelivery {
  private immuneTurns: number
  private readonly lookupAgent: (sessionId: string) => AdvisorDeliveryAgent | undefined
  private readonly logger: AdvisorDeliveryLogger
  /** KD-4 per-session agent map, keyed by `agent.id` (=== session.id). */
  private readonly agents = new Map<string, AdvisorDeliveryAgent>()
  /**
   * immuneTurns latch: remaining stepped primary turns before an interrupting
   * note may steer again (spec §6). A present entry > 0 means armed; the entry
   * is removed when the countdown exhausts.
   */
  private readonly cooldown = new Map<string, number>()

  constructor(options: AdvisorDeliveryOptions) {
    this.immuneTurns = options.immuneTurns
    this.lookupAgent = options.lookupAgent ?? (() => undefined)
    this.logger = options.logger ?? console
  }

  /** KD-4: register an agent on `agent/created` (keyed by `agent.id`). */
  registerAgent(agent: AdvisorDeliveryAgent): void {
    this.agents.set(agent.id, agent)
  }

  /** KD-4: drop an agent — and its cooldown with the session — on `agent/disposed`. */
  unregisterAgent(sessionId: string): void {
    this.agents.delete(sessionId)
    this.cooldown.delete(sessionId)
  }

  /**
   * Update the immuneTurns cooldown length (live config — settings onChange,
   * plan dsh-advisor-settings-n2 T1). The fence is re-armed with the new
   * length on the next real steer; the per-session cooldown countdown itself
   * is untouched, so the delivery semantics (spec §6) never change mid-window.
   */
  setImmuneTurns(value: number): void {
    this.immuneTurns = value
  }

  /**
   * One completed stepped primary turn (observer `onSteppedTurnEnd`): decrement
   * the immuneTurns countdown. The latch is removed at zero, so the next
   * interrupting note steers again. Total — never throws.
   */
  onSteppedTurnEnd(sessionId: string): void {
    const remaining = this.cooldown.get(sessionId)
    if (remaining === undefined || remaining <= 0) return
    if (remaining <= 1) this.cooldown.delete(sessionId)
    else this.cooldown.set(sessionId, remaining - 1)
  }

  /**
   * KD-5 reset trigger: a compaction / surface rewrite clears the immuneTurns
   * latch — the session state is being rewritten, so the cooldown's turn-count
   * basis no longer applies. Total — never throws.
   */
  reset(sessionId: string): void {
    this.cooldown.delete(sessionId)
  }

  /**
   * Route one accepted advice note (spec §6, KD-4).
   *
   * Resolves the primary agent via the map, falling back to the registry; a
   * missing agent drops the note with a log (advisory only — never throw,
   * never stall). nit → inject; concern/blocker → steer, unless the
   * immuneTurns fence is armed, in which case they downgrade to inject.
   *
   * @returns the channel delivered on, or `undefined` when dropped (no agent).
   */
  route(sessionId: string, note: AdviceNote): DeliveryChannel | undefined {
    const agent = this.agents.get(sessionId) ?? this.lookupAgent(sessionId)
    if (agent === undefined) {
      this.logger.warn('advisor: note dropped — no agent for session', {
        sessionId,
        severity: note.severity,
      })
      return undefined
    }
    const message = buildAdvisorMessage(note)
    const cooldown = this.cooldown.get(sessionId) ?? 0
    if (isInterrupting(note.severity) && cooldown <= 0) {
      // A real steer delivery arms the fence (spec §6). Armed before the call:
      // a failed steer delivery still counts as an attempted interrupt, keeping
      // a throwing agent out of the noise loop — and a downgraded or dropped
      // note never reaches this branch, so the fence never arms on one.
      if (this.immuneTurns > 0) this.cooldown.set(sessionId, this.immuneTurns)
      agent.steer(message)
      return 'steer'
    }
    agent.inject(message)
    return 'inject'
  }
}
