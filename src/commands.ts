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
 * - `/advisor config`    — show the composed advisor config (settings readback);
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
  | { readonly kind: 'config' }
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
  if (argument === 'config') return { kind: 'config' }
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
// Config surface (`/advisor config` — plan dsh-advisor-tui-client-n8 T2)
// ---------------------------------------------------------------------------

/**
 * Composed-config surface consumed by `/advisor config`. **Session-less by
 * design**: the wiring builds it from the same resolved config the web card
 * reads (`/api/advisor/get` — schema defaults → plugin-row base → settings
 * user layer, with the hard gate applied), so a per-session `/advisor off`
 * override can never misreport settings.yaml. Runtime state stays owned by
 * the status surface (`AdvisorSessionStatus`); config and status are separate.
 */
export interface AdvisorComposedConfig {
  /** Config-level composed switch — NOT the per-session override. */
  readonly enabled: boolean
  /** Present iff the composed config is disabled by the explicit gate. */
  readonly disabledReason?: string
  /** Composed provider route (shown even while disabled — spec §5.2). */
  readonly provider?: string
  /** Composed model id (shown even while disabled — spec §5.2). */
  readonly model?: string
  /** Cooldown after a delivered interrupt (spec §6). */
  readonly immuneTurns: number
  /** Delta window; 0 = unbounded (KD-3). */
  readonly maxDeltaMessages: number
  /** True when the composed config carries a custom system prompt ("" = unset). */
  readonly systemPromptSet: boolean
  /**
   * First line of the system prompt, truncated to ≤ 80 chars (empty when
   * unset — the `<default>` marker is the renderer's job).
   */
  readonly systemPromptSummary: string
  /**
   * Whether the dsh-tui `tuiSettingsSections` seam is mounted (dsh-tui ≥
   * v0.8.0) — a RENDERER INPUT for the edit hint, computed LIVE at render
   * time by the wiring (`ctx.get('tuiSettingsSections') !== undefined`, plan
   * dsh-advisor-tui-settings-n9 T2). An environment signal, never derived
   * from the per-session override; it does not change the resolved-config
   * read. When true the hint lists the TUI `/settings` screen as a write
   * path; when false the n8 hint (profile patch layer + settings.yaml) is
   * shown unchanged.
   */
  readonly tuiSettingsAvailable: boolean
}

/**
 * First line of a system prompt, truncated to ≤ 80 chars with a trailing
 * ellipsis when the first line is longer — the TUI one-liner readback, never
 * a full dump (AC-2). Empty when the prompt is unset ('' → the renderer shows
 * `<default>`).
 */
export function summarizeSystemPrompt(prompt: string): string {
  // CRLF prompts (schema allows any string) leave a trailing \r on the first
  // line — strip it as a line-ending artifact, not content (qc2 F-3).
  const firstLine = (prompt.split('\n')[0] ?? '').replace(/\r$/, '')
  if (firstLine.length <= 80) return firstLine
  return `${firstLine.slice(0, 79)}…`
}

/**
 * Render the composed config surface. Mirrors the status renderer's minimal
 * line style; the edit hint points at the operator edit paths — when the TUI
 * `tuiSettingsSections` seam is mounted (dsh-tui ≥ v0.8.0) the TUI `/settings`
 * Advisor section is listed FIRST, followed by the profile patch layer + the
 * shared `$DSH_HOME/settings.yaml` `advisor:` section the web card writes;
 * otherwise only the two file paths (n8 text, byte-identical).
 */
export function advisorConfigText(config: AdvisorComposedConfig): string {
  const lines: string[] = []
  lines.push(config.enabled ? 'Advisor config: enabled' : 'Advisor config: disabled')
  if (config.provider && config.model) {
    lines.push(`Model: ${config.provider}/${config.model}`)
  }
  lines.push(`immuneTurns: ${config.immuneTurns}`)
  lines.push(`maxDeltaMessages: ${config.maxDeltaMessages === 0 ? 'unbounded' : config.maxDeltaMessages}`)
  // The set-vs-default signal is systemPromptSet, NOT the summary: a custom
  // prompt whose first line is empty (e.g. '\nsecond line') summarizes to ''
  // but must still read as set, not <default> (qc2 F-3).
  lines.push(
    !config.systemPromptSet
      ? 'systemPrompt: <default>'
      : config.systemPromptSummary === ''
        ? 'systemPrompt: "(empty first line)"'
        : `systemPrompt: "${config.systemPromptSummary}"`,
  )
  if (config.disabledReason !== undefined) lines.push(`Reason: ${config.disabledReason}`)
  lines.push('')
  // T2 (plan dsh-advisor-tui-settings-n9): truthful edit hint. The TUI
  // `/settings` screen is a real write path only while the `tuiSettingsSections`
  // seam is mounted — the renderer branch follows the LIVE
  // `tuiSettingsAvailable` input the wiring supplies at render time; the
  // absent-seam text is the n8 line, byte-identical.
  lines.push(
    config.tuiSettingsAvailable
      ? 'Edit: TUI /settings screen (Advisor section, dsh-tui ≥ v0.8.0) or ~/.dsh/profiles/<profile>/cordis.patch.yml (plugin row) or $DSH_HOME/settings.yaml (advisor: section)'
      : 'Edit: ~/.dsh/profiles/<profile>/cordis.patch.yml (plugin row) or $DSH_HOME/settings.yaml (advisor: section)',
  )
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
  /** Snapshot the composed config surface (session-less settings readback). */
  getConfig(): AdvisorComposedConfig
}

/** Minimal command registry surface (satisfied by the dsh `CommandService`). */
export interface AdvisorCommandRegistry {
  register(definition: CommandDefinition): () => void
}

/** Usage text for an unknown `/advisor` subcommand. */
export const USAGE = [
  'Usage: /advisor [on|off|status|config]',
  '  /advisor          toggle the advisor for this session',
  '  /advisor on       enable the advisor for this session',
  '  /advisor off      disable the advisor for this session',
  '  /advisor status   show per-session advisor status (state, model, runtime, pending, last activity)',
  '  /advisor config   show the composed advisor config (settings readback)',
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
      case 'config':
        // Session-less readback: the composed config, never the session state.
        return { kind: 'success', text: advisorConfigText(controller.getConfig()) }
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
    input: { hint: '[on|off|status|config]' },
    handler: createAdvisorCommandHandler(controller),
  })
}
