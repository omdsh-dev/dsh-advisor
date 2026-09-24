/**
 * T7 — slash commands (spec §2 S5, §6 status surface, §8.5 KD-5 seed-on-enable,
 * §5.3 session model override).
 *
 * One `/advisor` command is registered (through {@link registerAdvisorCommands})
 * with these forms:
 *
 * - `/advisor`           — toggle the per-session override (on ↔ off);
 * - `/advisor on`        — enable the advisor for this session;
 * - `/advisor off`       — disable the advisor for this session;
 * - `/advisor status`    — report the per-session status surface;
 * - `/advisor config`    — show the composed advisor config (global defaults);
 * - `/advisor model`     — show the effective reviewer route + source;
 * - `/advisor model set <provider> <model>` — pin an atomic pair for the
 *   invoking session only (validated via `resolveModelInfo`, 60 s, no retry);
 * - `/advisor model reset` — re-inherit the current global defaults;
 * - anything else        — usage text.
 *
 * All forms are **session-scoped and ephemeral**: they drive per-session
 * overrides ({@link AdvisorSessionOverrides} — the enable flag and the
 * runtime-only atomic model pair, fenced by per-session generations) that the
 * runtime gate and the effective resolver consult, so no command ever touches
 * the persisted config (spec §4 mapping, §5.3 — matches omp `/advisor`
 * semantics). Enabling a session whose effective route has no complete pair
 * starts no model call: the S4 explicit gate (spec §5.2) applies AFTER session
 * resolution, and the status/on text explains the disabled-with-reason.
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
import type { Agent } from '@deepseek-ai/dsh-agent'
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
  | { readonly kind: 'model'; readonly sub: AdvisorModelCommand }
  | { readonly kind: 'usage' }

/**
 * The parsed form of the text following `/advisor model` (spec §5.3 B1
 * surface): bare → show, `set <provider> <model>` → set (parsed by
 * {@link parseModelSetArgs}), `reset` → reset, anything else → model usage.
 */
export type AdvisorModelCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'set'; readonly args: string }
  | { readonly kind: 'reset' }
  | { readonly kind: 'usage' }

/**
 * Parse the text following `/advisor model`. `set` keeps its RAW remainder —
 * the atomic-pair validation ({@link parseModelSetArgs}) owns it, because the
 * set flow reports a precise rejection reason in the command reply.
 */
export function parseAdvisorModelCommand(rawInput: string): AdvisorModelCommand {
  const argument = rawInput.trim()
  if (argument === '') return { kind: 'show' }
  if (argument === 'reset') return { kind: 'reset' }
  if (argument === 'set' || argument.startsWith('set ') || argument.startsWith('set\t')) {
    return { kind: 'set', args: argument.slice('set'.length).trim() }
  }
  return { kind: 'usage' }
}

/**
 * The result of parsing `/advisor model set` arguments into the atomic pair
 * (spec §5.3 pair validation).
 */
export type ModelSetArgs =
  | { readonly ok: true; readonly provider: string; readonly model: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate one structured `{provider, model}` pair (spec §5.3 pair validation):
 * both values must be strings that are non-empty after outer trim, with no
 * whitespace INSIDE either identifier (the same rules `parseModelSetArgs`
 * enforces for the CLI form — one validation source shared by the command face
 * and the web gateway face, so the two surfaces can never diverge). Outer
 * whitespace is trimmed; case is retained; model ids containing `/` are fine
 * (`/` is not whitespace). Never throws — every rejection carries a
 * user-facing reason.
 */
export function parseModelPair(provider: unknown, model: unknown): ModelSetArgs {
  if (typeof provider !== 'string' || typeof model !== 'string') {
    return { ok: false, reason: 'incomplete pair — provider and model are both required' }
  }
  const trimmedProvider = provider.trim()
  const trimmedModel = model.trim()
  if (trimmedProvider === '' || trimmedModel === '') {
    return { ok: false, reason: 'incomplete pair — provider and model are both required' }
  }
  if (/\s/.test(trimmedProvider) || /\s/.test(trimmedModel)) {
    return { ok: false, reason: 'invalid pair — provider and model must not contain whitespace' }
  }
  return { ok: true, provider: trimmedProvider, model: trimmedModel }
}

/**
 * Validate `/advisor model set <provider> <model>` arguments (spec §5.3):
 * exactly two arguments; outer whitespace trimmed; case retained; blank or
 * partial pairs, extra fields (a third argument), and whitespace-containing
 * identifiers rejected. Separate args are what allow model ids containing
 * `/`. Never throws — every rejection carries a user-facing reason.
 */
export function parseModelSetArgs(rawArgs: string): ModelSetArgs {
  const args = rawArgs.trim().split(/\s+/).filter((arg) => arg.length > 0)
  if (args.length === 0) {
    return { ok: false, reason: 'usage: /advisor model set <provider> <model>' }
  }
  if (args.length === 1) {
    return { ok: false, reason: `incomplete pair — provider and model are both required (got only "${args[0]}")` }
  }
  if (args.length > 2) {
    return { ok: false, reason: `too many arguments — the pair is exactly <provider> <model> (got ${args.length})` }
  }
  // The split cannot leave whitespace inside a token; the shared validator is
  // still the single authority for the pair shape (B2 web face parity).
  return parseModelPair(args[0]!, args[1]!)
}

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
  if (argument === 'model' || argument.startsWith('model ') || argument.startsWith('model\t')) {
    return { kind: 'model', sub: parseAdvisorModelCommand(argument.slice('model'.length)) }
  }
  return { kind: 'usage' }
}

// ---------------------------------------------------------------------------
// Per-session override mechanism (session-scoped, ephemeral)
// ---------------------------------------------------------------------------

/**
 * The runtime-only reviewer model override for one session (spec §5.3) — an
 * **atomic** `{ provider, model }` pair. It never merges with the global
 * pair (no half-pairs) and is never persisted: it lives in memory for the
 * live-session lifetime and is cleared by reset, dispose, owner teardown,
 * cold resume, or restart.
 */
export interface AdvisorModelPair {
  readonly provider: string
  readonly model: string
}

/**
 * Where a session's effective reviewer route comes from (spec §5.3):
 * `session` = a pinned `AdvisorModelPair`, `global` = the composed global
 * advisor pair.
 */
export type AdvisorModelSource = 'session' | 'global'

/**
 * The per-session overrides consulted by the runtime gate and the effective
 * resolver (`src/index.ts`):
 *
 * - enable: `override ?? config.enabled` (`/advisor on|off|toggle`);
 * - model: the complete session pair ?? the composed global pair — the pair
 *   is atomic, so the two levels are never merged (spec §5.3);
 * - generation: a per-session counter that fences async model work — a newer
 *   set/reset supersedes unresolved older work, and dispose/owner teardown
 *   (which wipe the counter) can never be undone by a delayed completion.
 *
 * Nothing here touches the persisted config. All maps are keyed by session id
 * and hold only LIVE sessions' state: `clear` runs on `agent/disposed` /
 * `session/disposed`, `clearModel` runs on reset (an emptied entry is
 * removed), and `disposeAll` runs on owner teardown — state stays
 * O(live overrides), with no historical SessionId accumulation and no
 * TTL/GC job.
 */
export class AdvisorSessionOverrides {
  private readonly enables = new Map<string, boolean>()
  private readonly models = new Map<string, AdvisorModelPair>()
  private readonly generations = new Map<string, number>()

  constructor(private configEnabled: boolean) {}

  /** Effective switch for one session: `override ?? config.enabled`. */
  effective(sessionId: string): boolean {
    return this.enables.get(sessionId) ?? this.configEnabled
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

  /** Set the enable override for one session. */
  set(sessionId: string, enabled: boolean): void {
    this.enables.set(sessionId, enabled)
  }

  /** The session's pinned model pair, or `undefined` when it inherits. */
  model(sessionId: string): AdvisorModelPair | undefined {
    return this.models.get(sessionId)
  }

  /** Commit the (already validated) atomic pair for one session. */
  setModel(sessionId: string, pair: AdvisorModelPair): void {
    this.models.set(sessionId, pair)
  }

  /**
   * Remove a session's model pin (reset-to-inherit). @returns `true` when a
   * pin was actually removed — `false` means the session was already
   * inheriting (a reset no-op).
   */
  clearModel(sessionId: string): boolean {
    return this.models.delete(sessionId)
  }

  /**
   * Bump and return the session's model-work generation — the fence token an
   * async validation captures; any later `beginModelGeneration` (a newer
   * set/reset) or any state wipe makes the captured value stale.
   */
  beginModelGeneration(sessionId: string): number {
    const next = (this.generations.get(sessionId) ?? 0) + 1
    this.generations.set(sessionId, next)
    return next
  }

  /** The session's current model-work generation (0 before the first). */
  modelGeneration(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0
  }

  /** Sessions holding ANY per-session override state (enable and/or pair). */
  overrideSessionIds(): IterableIterator<string> {
    return new Set([...this.enables.keys(), ...this.models.keys()]).keys()
  }

  /**
   * Drop ALL per-session state for one session (enable + pair + generation) —
   * the `agent/disposed` / `session/disposed` cleanup. Wiping the generation
   * invalidates any in-flight validation for the session (captured values are
   * ≥ 1 and can never again match the post-clear default 0).
   */
  clear(sessionId: string): void {
    this.enables.delete(sessionId)
    this.models.delete(sessionId)
    this.generations.delete(sessionId)
  }

  /**
   * Owner teardown: wipe every session's state. Pending validations for any
   * session become stale exactly like a per-session `clear` — a delayed
   * completion can never commit after the owner is gone.
   */
  disposeAll(): void {
    this.enables.clear()
    this.models.clear()
    this.generations.clear()
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
  /**
   * Where the reported route comes from (spec §5.3) — present iff
   * `provider`/`model` are: `session` = the session's pinned pair,
   * `global` = the composed global advisor pair.
   */
  readonly modelSource?: AdvisorModelSource
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
    // Spec §5.3: the status reports the EFFECTIVE route, labeled by source.
    const source = status.modelSource === 'session' ? 'session override' : 'global default'
    lines.push(`Model: ${status.provider}/${status.model} (${source})`)
  }
  const pending = status.pendingCount > 0 ? ` (${status.pendingCount} pending)` : ''
  lines.push(`Runtime: ${status.runtimeStatus}${pending}`)
  lines.push(`Last activity: ${status.lastActivityAt === undefined ? 'never' : new Date(status.lastActivityAt).toISOString()}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Model surface (`/advisor model` — spec §5.3, the B1 command face)
// ---------------------------------------------------------------------------

/** Validation deadline for one `/advisor model set` lookup (60 s — matches
 * the runtime's whole-call deadline default, `src/advisor-runtime.ts`). */
export const ADVISOR_MODEL_VALIDATION_TIMEOUT_MS = 60_000

/** The effective reviewer route for one session (spec §5.3). */
export interface AdvisorModelRoute {
  readonly provider?: string
  readonly model?: string
  /** `session` when the effective pair is the session's pin, else `global`. */
  readonly source: AdvisorModelSource
}

/** Outcome of one `/advisor model set` attempt (spec §5.3 validation + fencing). */
export type AdvisorSetModelOutcome =
  | { readonly kind: 'committed'; readonly status: AdvisorSessionStatus }
  | { readonly kind: 'unchanged'; readonly status: AdvisorSessionStatus }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'gone' }

/** Outcome of one `/advisor model reset`. */
export type AdvisorResetModelOutcome =
  | { readonly kind: 'reset'; readonly status: AdvisorSessionStatus }
  | { readonly kind: 'noop' }

/**
 * Render the `/advisor model` surface: the effective pair, its source, and
 * the live-session lifetime (spec §5.3 — the reply must name the lifetime).
 */
export function advisorModelText(route: AdvisorModelRoute): string {
  const lines: string[] = []
  if (route.provider && route.model) {
    lines.push(`Model: ${route.provider}/${route.model}`)
    lines.push(
      route.source === 'session'
        ? 'Source: session override — lives for this session; cleared by /advisor model reset, dispose, or restart'
        : 'Source: global default — pin a different route with /advisor model set <provider> <model>',
    )
  } else {
    lines.push('Model: none — the global default has no provider/model')
    lines.push('Set both globally (the /advisor config edit paths) or pin a session pair:')
    lines.push('  /advisor model set <provider> <model>')
  }
  lines.push('Lifetime: this session only — never persisted; a new/forked session inherits the global defaults.')
  return lines.join('\n')
}

/** Render one `/advisor model set` outcome. */
export function modelSetText(outcome: AdvisorSetModelOutcome): string {
  switch (outcome.kind) {
    case 'committed':
      return `Session model pinned: ${outcome.status.provider}/${outcome.status.model} (session override).\n${advisorStatusText(outcome.status)}`
    case 'unchanged':
      return `Session model pinned: ${outcome.status.provider}/${outcome.status.model} — same effective route, runtime untouched.`
    case 'rejected':
      return `Not set: ${outcome.reason}`
    case 'failed':
      return `Model not set — validation failed, previous selection untouched: ${outcome.reason}`
    case 'cancelled':
      return 'Model not set — the command was cancelled; previous selection untouched.'
    case 'superseded':
      return 'Model not set — superseded by a newer /advisor model command.'
    case 'gone':
      return 'Model not set — this session is no longer live.'
  }
}

/** Render one `/advisor model reset` outcome. */
export function modelResetText(outcome: AdvisorResetModelOutcome): string {
  if (outcome.kind === 'noop') {
    return 'No session model pin to reset — this session already inherits the global defaults.'
  }
  return `Session model pin removed — inheriting the global defaults.\n${advisorStatusText(outcome.status)}`
}

// ---------------------------------------------------------------------------
// Config surface (`/advisor config` — plan dsh-advisor-tui-client-n8 T2)
// ---------------------------------------------------------------------------

/**
 * Composed-config surface consumed by `/advisor config`. **Session-less by
 * design**: the wiring builds it from the same resolved config the web card
 * reads (`/api/advisor/get` — the live entry config, with the hard gate
 * applied), so a per-session `/advisor off` override can never misreport the
 * persisted config. Runtime state stays owned by the status surface
 * (`AdvisorSessionStatus`); config and status are separate.
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
   * path; when false the profile patch layer hint is shown unchanged.
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
 * Advisor section is listed FIRST, followed by the profile patch layer
 * (`cordis.patch.yml`, whose `advisor` plugin row carries the volatile live
 * fields); otherwise only the file path.
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
      ? 'Edit: TUI /settings screen (Advisor section, dsh-tui ≥ v0.8.0) or ~/.dsh/profiles/<profile>/cordis.patch.yml (advisor plugin row)'
      : 'Edit: ~/.dsh/profiles/<profile>/cordis.patch.yml (advisor plugin row)',
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
  /** The session's effective reviewer route (pair + source — spec §5.3). */
  getModelRoute(sessionId: string): AdvisorModelRoute
  /**
   * Validate and commit an atomic pair for the INVOKING session (spec §5.3):
   * resolve through the LLM service before commit (60 s deadline, fused with
   * `signal`, cancellable, NO automatic retry — failure leaves the previous
   * selection untouched), fenced by the per-session generation. Never toggles
   * the enable override; never starts a generation call.
   */
  setModel(
    sessionId: string,
    provider: string,
    model: string,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<AdvisorSetModelOutcome>
  /**
   * Drop the session's pin and re-inherit the CURRENT global defaults (never
   * touches the enable override). Synchronous — no validation needed.
   * @param sessionLength - current transcript length, used for the re-seed
   *   when the effective route actually changes.
   */
  resetModel(sessionId: string, sessionLength?: number): AdvisorResetModelOutcome
}

/** Minimal command registry surface (satisfied by the dsh `CommandService`). */
export interface AdvisorCommandRegistry {
  register(definition: CommandDefinition): () => void
}

/** Usage text for an unknown `/advisor` subcommand. */
export const USAGE = [
  'Usage: /advisor [on|off|status|config|model]',
  '  /advisor          toggle the advisor for this session',
  '  /advisor on       enable the advisor for this session',
  '  /advisor off      disable the advisor for this session',
  '  /advisor status   show per-session advisor status (state, model, runtime, pending, last activity)',
  '  /advisor config   show the composed advisor config (global defaults readback)',
  '  /advisor model    show the effective model, its source (session override or global default), and the live-session lifetime',
  '  /advisor model set <provider> <model>',
  '                    pin the reviewer model for this session only (separate args; ids may contain /)',
  '  /advisor model reset',
  '                    drop the session pin and re-inherit the current global defaults',
].join('\n')

/** Usage text for an unknown `/advisor model` subcommand. */
export const MODEL_USAGE = [
  'Usage: /advisor model [set <provider> <model>|reset]',
  '  /advisor model                  show the effective model and its source',
  '  /advisor model set <p> <m>      pin the reviewer model for this session only',
  '  /advisor model reset            re-inherit the current global defaults',
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
  return (invocation: CommandInvocation): CommandResult | Promise<CommandResult> => {
    const sessionId = invocation.agent.session.id
    switch (parseAdvisorCommand(invocation.rawInput).kind) {
      case 'toggle': {
        const before = controller.getStatus(sessionId)
        const next = !before.enabled
        // The KD-5 seed length is only meaningful when enabling.
        controller.setEnabled(sessionId, next, next ? invocation.agent.session.seq : undefined)
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
        controller.setEnabled(sessionId, true, invocation.agent.session.seq)
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
      case 'model':
        return handleModelCommand(controller, sessionId, invocation)
      case 'usage':
        return { kind: 'success', text: USAGE }
    }
  }
}

/**
 * `/advisor model` dispatch (spec §5.3). Only the `set` form is async — it
 * awaits the 60 s `resolveModelInfo` validation before replying with the
 * outcome; show/reset are synchronous.
 */
function handleModelCommand(
  controller: AdvisorCommandController,
  sessionId: string,
  invocation: CommandInvocation,
): CommandResult | Promise<CommandResult> {
  const command = parseAdvisorCommand(invocation.rawInput)
  if (command.kind !== 'model') return { kind: 'success', text: MODEL_USAGE }
  switch (command.sub.kind) {
    case 'show':
      return { kind: 'success', text: advisorModelText(controller.getModelRoute(sessionId)) }
    case 'reset':
      return { kind: 'success', text: modelResetText(controller.resetModel(sessionId, invocation.agent.session.seq)) }
    case 'set': {
      const args = parseModelSetArgs(command.sub.args)
      if (!args.ok) return { kind: 'success', text: modelSetText({ kind: 'rejected', reason: args.reason }) }
      return controller
        .setModel(sessionId, args.provider, args.model, invocation.agent, invocation.signal)
        .then((outcome) => ({ kind: 'success' as const, text: modelSetText(outcome) }))
    }
    case 'usage':
      return { kind: 'success', text: MODEL_USAGE }
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
    description: 'Toggle, enable, disable, inspect, or re-route the per-session advisor',
    input: { hint: '[on|off|status|config|model]' },
    handler: createAdvisorCommandHandler(controller),
  })
}
