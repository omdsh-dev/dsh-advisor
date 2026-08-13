/**
 * T7 — slash commands (spec §2 S5, §6 status surface, §8.5 KD-5 seed-on-enable).
 *
 * One `/advisor` command is registered (through {@link registerAdvisorCommands})
 * with four forms:
 *
 * - `/advisor`           — toggle the per-session override (on ↔ off);
 * - `/advisor on`        — enable the advisor for this session;
 * - `/advisor off`       — disable the advisor for this session;
 * - `/advisor status`    — report the per-session status surface;
 * - anything else        — usage text.
 *
 * Toggle/on/off are **session-scoped and ephemeral**: they drive a per-session
 * override flag (`AdvisorSessionOverrides`) that the runtime gate consults as
 * `override ?? config.enabled`, so no command ever touches the persisted
 * config (spec §4 mapping — matches omp `/advisor` semantics). Enabling a
 * session whose config has no provider/model starts no model call: the S4
 * explicit gate (spec §5.2) still applies, and the status/on text explains
 * the disabled-with-reason.
 *
 * The module is cordis-free (pure parse + render + registration contract), so
 * it is unit-testable with a fake command registry and a fake controller;
 * `index.ts` binds it into the plugin through the conditional
 * `ctx.inject(['commands'], ...)` child (commands must NOT join the top-level
 * inject list — T1 fix).
 *
 * @module dsh-advisor/commands
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AdvisorRuntimeStatus } from './advisor-runtime.js'

// ---------------------------------------------------------------------------
// Command parse
// ---------------------------------------------------------------------------

/** The parsed form of the exact text following `/advisor`. */
export type AdvisorCommand =
  | { readonly kind: 'toggle' }
  | { readonly kind: 'on' }
  | { readonly kind: 'off' }
  | { readonly kind: 'status' }
  | { readonly kind: 'usage' }

/**
 * Parse the text following `/advisor` (the dsh `parseCommand` split already
 * yields `rawInput` including the separator whitespace, e.g. `' on'` for
 * `/advisor on`). Subcommands match exactly after trimming — same
 * case-sensitivity as dsh command names; anything else is a usage error.
 */
export function parseAdvisorCommand(rawInput: string): AdvisorCommand {
  const argument = rawInput.trim()
  if (argument === '') return { kind: 'toggle' }
  if (argument === 'on') return { kind: 'on' }
  if (argument === 'off') return { kind: 'off' }
  if (argument === 'status') return { kind: 'status' }
  return { kind: 'usage' }
}

// ---------------------------------------------------------------------------
// Per-session override mechanism (session-scoped, ephemeral)
// ---------------------------------------------------------------------------

/**
 * The per-session override consulted by the runtime gate as
 * `override ?? config.enabled`. `/advisor on|off|toggle` write here — the
 * persisted config is never modified. The map is keyed by session id and
 * entries live for the session lifetime (`index.ts` clears them on
 * `agent/disposed` / `session/disposed`).
 */
export class AdvisorSessionOverrides {
  private readonly overrides = new Map<string, boolean>()

  constructor(private configEnabled: boolean) {}

  /** Effective switch for one session: `override ?? config.enabled`. */
  effective(sessionId: string): boolean {
    return this.overrides.get(sessionId) ?? this.configEnabled
  }

  /**
   * Update the config-level fallback switch (live config — settings onChange,
   * plan dsh-advisor-settings-n2 T1). Sessions with an explicit override keep
   * it; every other session follows the new switch, so a Settings-page edit
   * takes effect for new sessions without touching the override mechanism.
   */
  setConfigEnabled(enabled: boolean): void {
    this.configEnabled = enabled
  }

  /** Set the override for one session. */
  set(sessionId: string, enabled: boolean): void {
    this.overrides.set(sessionId, enabled)
  }

  /** Remove a session's override, falling back to the config switch. */
  clear(sessionId: string): void {
    this.overrides.delete(sessionId)
  }
}

// ---------------------------------------------------------------------------
// Status surface (spec §6 — `/advisor status`)
// ---------------------------------------------------------------------------

/**
 * Per-session status snapshot consumed by `/advisor status`. Built by the
 * wiring (`index.ts`) from the resolved config, the session's runtime, and
 * the override state.
 */
export interface AdvisorSessionStatus {
  /** Effective switch for this session (`override ?? config.enabled`). */
  readonly enabled: boolean
  /**
   * Present iff the session is effectively enabled but the S4 explicit gate
   * blocks model calls (provider/model missing or empty) — disabled-with-
   * reason (spec §5.2).
   */
  readonly disabledReason?: string
  /** Configured provider route (shown even while disabled — spec §5.2). */
  readonly provider?: string
  /** Configured model id (shown even while disabled — spec §5.2). */
  readonly model?: string
  /** The session's runtime status; `disabled` when no runtime exists. */
  readonly runtimeStatus: AdvisorRuntimeStatus
  /** Deltas waiting to be drained (bounded backlog, spec §6). */
  readonly pendingCount: number
  /** Epoch-ms of the last accepted note; undefined before the first (T4). */
  readonly lastActivityAt?: number
}

/**
 * Render the status surface. Kept minimal and truthful: state, the S4 reason
 * when the gate blocks, the resolved provider/model, the runtime status with
 * the pending count, and the last accepted-note activity (ISO, or `never`).
 */
export function advisorStatusText(status: AdvisorSessionStatus): string {
  const lines: string[] = []
  lines.push(status.enabled ? 'Advisor: enabled' : 'Advisor: disabled')
  if (status.disabledReason !== undefined) lines.push(`Reason: ${status.disabledReason}`)
  if (status.provider && status.model) {
    lines.push(`Model: ${status.provider}/${status.model}`)
  }
  const pending = status.pendingCount > 0 ? ` (${status.pendingCount} pending)` : ''
  lines.push(`Runtime: ${status.runtimeStatus}${pending}`)
  lines.push(`Last activity: ${status.lastActivityAt === undefined ? 'never' : new Date(status.lastActivityAt).toISOString()}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Controller + registration
// ---------------------------------------------------------------------------

/**
 * The session-scoped operations the `/advisor` handler drives. Implemented by
 * the wiring (`index.ts`) against the observer, the per-session runtimes, and
 * the resolved config; faked in unit tests.
 */
export interface AdvisorCommandController {
  /**
   * Apply the session override and start/stop the session's runtime:
   * enabling seeds the observer cursor to the current transcript length
   * (KD-5 — no full-history replay) and resumes/creates the runtime; disabling
   * disposes the runtime (aborts the in-flight call, drops the backlog).
   * @param sessionLength - current transcript length, used for the KD-5 seed.
   */
  setEnabled(sessionId: string, enabled: boolean, sessionLength?: number): void
  /** Snapshot the per-session status surface. */
  getStatus(sessionId: string): AdvisorSessionStatus
}

/** Minimal command registry surface (satisfied by the dsh `CommandService`). */
export interface AdvisorCommandRegistry {
  register(definition: CommandDefinition): () => void
}

/** Usage text for an unknown `/advisor` subcommand. */
export const USAGE = [
  'Usage: /advisor [on|off|status]',
  '  /advisor          toggle the advisor for this session',
  '  /advisor on       enable the advisor for this session',
  '  /advisor off      disable the advisor for this session',
  '  /advisor status   show per-session advisor status (state, model, runtime, pending, last activity)',
].join('\n')

/**
 * "Enabled" outcome text — mentions the S4 gate when it blocks model calls.
 * Callers pass the status AFTER the override flip, so the caveat appears when
 * the flip itself is what trips the gate (qc2 W-2 / qc3 I-2 — the pre-flip
 * status cannot know the gate yet: the gate only fires when enabled).
 */
function enableText(status: AdvisorSessionStatus): string {
  if (status.disabledReason === undefined) return 'Advisor on for this session.'
  return `Advisor on for this session — but no model call can start: ${status.disabledReason}`
}

/** Build the `/advisor` handler bound to one controller. */
function createAdvisorCommandHandler(controller: AdvisorCommandController) {
  return (invocation: CommandInvocation): CommandResult => {
    const sessionId = invocation.agent.session.id
    switch (parseAdvisorCommand(invocation.rawInput).kind) {
      case 'toggle': {
        const before = controller.getStatus(sessionId)
        const next = !before.enabled
        // The KD-5 seed length is only meaningful when enabling.
        controller.setEnabled(sessionId, next, next ? invocation.agent.session.events.length : undefined)
        if (!next) return { kind: 'success', text: 'Advisor off for this session.' }
        // Post-flip status: the reply carries the S4 gate caveat when the
        // toggle-to-on flip trips the gate (qc2 W-2 / qc3 I-2).
        return { kind: 'success', text: enableText(controller.getStatus(sessionId)) }
      }
      case 'on': {
        const before = controller.getStatus(sessionId)
        // Recovery routing (qc1/qc2/qc3 W-1/I-4): an effectively-enabled
        // session whose runtime is halted/quota-paused must reach `setEnabled`
        // (which resumes/rebuilds it) — a plain "already on" would be a dead
        // end, since the only resume call site sits behind the enable path.
        const needsRecovery = before.enabled
          && (before.runtimeStatus === 'halted' || before.runtimeStatus === 'quota_exhausted')
        if (before.enabled && !needsRecovery) {
          return { kind: 'success', text: 'Advisor is already on for this session.' }
        }
        controller.setEnabled(sessionId, true, invocation.agent.session.events.length)
        // Reply from the POST-flip status: when the override flip trips the
        // S4 gate (config-off + missing provider/model), the reply must say
        // the advisor did not start and why, not a bare "Advisor on" (qc2
        // W-2 / qc3 I-2).
        return { kind: 'success', text: enableText(controller.getStatus(sessionId)) }
      }
      case 'off': {
        const before = controller.getStatus(sessionId)
        if (!before.enabled) return { kind: 'success', text: 'Advisor is already off for this session.' }
        controller.setEnabled(sessionId, false)
        return { kind: 'success', text: 'Advisor off for this session.' }
      }
      case 'status':
        return { kind: 'success', text: advisorStatusText(controller.getStatus(sessionId)) }
      case 'usage':
        return { kind: 'success', text: USAGE }
    }
  }
}

/**
 * Register the `/advisor` command with a command registry (the dsh
 * `CommandService`, or a fake in tests). Called from the plugin's conditional
 * `ctx.inject(['commands'], ...)` child — the command exists only when a
 * registry is composed.
 * @returns the registry disposer (the inject child owns its lifetime).
 */
export function registerAdvisorCommands(
  registry: AdvisorCommandRegistry,
  controller: AdvisorCommandController,
): () => void {
  return registry.register({
    name: 'advisor',
    description: 'Toggle, enable, disable, or inspect the per-session advisor',
    input: { hint: '[on|off|status]' },
    handler: createAdvisorCommandHandler(controller),
  })
}
