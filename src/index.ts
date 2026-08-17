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
 * T2-tui (plan dsh-advisor-tui-client-n8): `/advisor config` — a session-less
 * readback of the composed `advisor` namespace (same resolved config the web
 * card reads), never the per-session override.
 * T2 (plan dsh-advisor-tui-settings-n9): the readback's edit hint is truthful
 * — `getConfig()` reports `tuiSettingsAvailable` LIVE at render time
 * (`ctx.get('tuiSettingsSections') !== undefined`), so the hint names the TUI
 * `/settings` Advisor section as a write path exactly while the seam is
 * mounted; the readback itself stays session-less and read-only.
 * Settings (plan dsh-advisor-settings-n2): the plugin-row config is the
 * composition base of the `advisor` settings namespace (`src/settings.ts`),
 * read live through the bridge source; committed settings edits re-apply
 * derived state (immuneTurns / maxDeltaMessages / per-session runtimes)
 * without a restart.
 * Config gateway (plan dsh-advisor-settings-gateway-n5): `apply` also
 * registers the host-side `AdvisorConfigGateway` (`src/gateway.ts`) — the
 * `/api/advisor/get` + `/api/advisor/set` endpoints (explicit
 * `ctx.typert.register` contribution — the host typertGateway claims
 * `ctx.typert.local` first, so link-plugin module identity never matters)
 * that make the Settings card truly readable/writable from the web client.
 *
 * @module dsh-advisor
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only edge: resolves `ctx.commands` for the optional command child
// (T7 — conditional `ctx.inject(['commands'], ...)` activation).
import type {} from '@deepseek-ai/dsh-commands'
import { resolveAdvisorConfig } from './config.js'
import type { AdvisorConfig, ResolvedAdvisorConfig } from './config.js'
import { installAdvisorSettings } from './settings.js'
import { AdvisorConfigGateway, advisorTypertContribution } from './gateway.js'
import { SessionTranscriptObserver } from './transcript.js'
import type { Delta } from './transcript.js'
import { AdvisorRuntime } from './advisor-runtime.js'
import type { AdviceNote } from './advisor-runtime.js'
import { AdvisorDelivery } from './delivery.js'
import { DEFAULT_ADVISOR_SYSTEM_PROMPT } from './prompts.js'
import { AdvisorSessionOverrides, registerAdvisorCommands, summarizeSystemPrompt } from './commands.js'
import type { AdvisorCommandController } from './commands.js'
import { installTuiClient } from './tui.js'
import { TUI_SETTINGS_SECTIONS, installTuiSettingsSection } from './tui-settings.js'

export const name = 'dsh-advisor'

/** Services the advisor consumes; the row loads once all are available. */
export const inject = ['sessions', 'agents', 'llm']

/** Loader schema (schemastery, strict) — validated by the cordis Loader. */
export { Config } from './config.js'
export type { AdvisorConfig, ResolvedAdvisorConfig } from './config.js'

/** n4 QC F-6: single-reviewer guard. The host composes multiple dsh-advisor
 * fibers (observed: 3 active); with the global session/event subscription every
 * instance would observe every session and N×-review/N×-call per round. The
 * FIRST apply to claim the reviewer role wires the observer/runtime/delivery
 * and the /advisor commands; later instances attempt the settings registration
 * only (qc1 W-5: it is NOT idempotent — dsh-settings register throws on a
 * duplicate; installAdvisorSettings dedupes it and falls back to the entry
 * source, so the first registration owns the live namespace) and stay inert
 * otherwise. The claim is taken only AFTER the construction-time config gate
 * (qc1 W-4: a rejected first row never leaves the flag claimed) and is
 * released when the claiming fiber is disposed, so a later re-apply/re-mount
 * can take over. The flag rides globalThis so it survives even module-copy
 * divergence. */
const REVIEWER_KEY = '__dshAdvisorReviewer__'
function claimReviewer(): boolean {
  const g = globalThis as Record<string, unknown>
  if (g[REVIEWER_KEY] === true) return false
  g[REVIEWER_KEY] = true
  return true
}

export function apply(ctx: Context, config: AdvisorConfig) {
  // T2: the explicit provider/model gate — no model call without both
  // (spec §5.2). Unknown keys / malformed config throw here, rejecting the
  // plugin row at load; the gate resolves to disabled-with-reason instead.
  //
  // T1-settings (plan dsh-advisor-settings-n2): the plugin-row config is the
  // composition BASE of the `advisor` settings namespace. The runtime reads
  // the LIVE composed value through the bridge source (schema defaults →
  // base → settings user layer); with no settings service the source is
  // exactly `config` — behavior identical to today. The hard gate is applied
  // to every read: `resolveAdvisorConfig` stays the SSOT for the
  // disabled-with-reason resolution.
  const bridge = installAdvisorSettings(ctx, config)
  // n5 (plan dsh-advisor-settings-gateway-n5): the host-side `advisor` config
  // gateway — the `/api/advisor/get` + `/api/advisor/set` endpoints. The
  // endpoints are registered EXPLICITLY through `ctx.typert.register(...)`
  // (NOT the @Remote SRC markers): the host typertGateway checks
  // `ctx.typert.local` FIRST for claim + dispatch, while SRC discovery reads
  // a module-private marker table that a locally-linked plugin can never
  // share with the host installation (link plugins resolve their peers from
  // their real directory, physically separate from the dlx host tree — the
  // observed failure was zero claimed endpoints → `/api/advisor/*` 404).
  // It reads the SAME bridge the runtime reads, so get/set always operate on
  // the live composed config. Multi-fiber dedupe mirrors the settings
  // registration (qc1 W-5): the cordis Service registration fails loud on a
  // duplicate key, so the catch lets the FIRST fiber own the `advisor` service
  // key while later fibers fall back (no gateway) — a later fiber's typert
  // re-registration fails the same way (`already registered`). The
  // registrations are fiber effects (unregistered when this fiber disposes),
  // so a re-apply/re-mount can take over. The instance needs no handle here:
  // the typertGateway dispatches through `ctx.get('advisor')`.
  try {
    new AdvisorConfigGateway(ctx, bridge)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('has been registered')) throw error
    ctx.logger('advisor').debug('advisor gateway already registered — no gateway on this fiber (multi-fiber dedupe)')
  }
  // The typert endpoint registration is OPTIONAL, like the settings service:
  // it activates through a conditional inject child, so compositions without
  // a typert registry (headless/standalone/integration harnesses) keep the
  // advisor runtime working and simply omit the /api endpoints. The child
  // disposer is the registration's own effect disposer, so the endpoints
  // withdraw when this fiber (or the typert service) goes away.
  ctx.inject(['typert'], (tctx) => {
    try {
      return tctx.typert.register(advisorTypertContribution())
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already registered')) throw error
      tctx.logger('advisor').debug('advisor typert endpoints already registered — no endpoints on this fiber (multi-fiber dedupe)')
      return () => {}
    }
  })
  const sourceConfig = (): AdvisorConfig => bridge.source()
  const resolved = (): ResolvedAdvisorConfig => resolveAdvisorConfig(sourceConfig())
  // qc2 W-1 containment: a settings user layer the resolver rejects (e.g. an
  // unknown key survives the non-strict settings schema) must never wedge the
  // live hot path — every read that can run inside an event handler goes
  // through the safe wrappers, which catch resolver throws and return
  // disabled-with-reason carrying the message, so gate semantics hold (no
  // model call can start) and handlers stay functional. The LOAD-TIME
  // plugin-row throw contract is unchanged: construction-time reads below
  // (delivery/observer latches) still use the throwing `resolved()`, so a bad
  // entry rejects the plugin row at load (config.test.ts ⑤).
  const safeFallback = (reason: string): ResolvedAdvisorConfig => {
    // S1 (gateway readConfig parity): when the raw source is still readable,
    // seed the scalar latches from it — an invalid user layer only drops the
    // offending keys, so /advisor config (and /advisor status) never
    // misreport immuneTurns / maxDeltaMessages / systemPrompt vs the web
    // card's /api/advisor/get readback.
    let raw: AdvisorConfig | undefined
    try {
      raw = sourceConfig()
    } catch {
      // unreadable source — fall back to the schema defaults below
    }
    return {
      enabled: false,
      systemPrompt: raw?.systemPrompt ?? '',
      immuneTurns: raw?.immuneTurns ?? 3,
      maxDeltaMessages: raw?.maxDeltaMessages ?? 60,
      disabledReason: reason,
    }
  }
  const safeResolved = (): ResolvedAdvisorConfig => {
    try {
      return resolveAdvisorConfig(sourceConfig())
    } catch (error) {
      return safeFallback(error instanceof Error ? error.message : String(error))
    }
  }
  const safeEffective = (sessionId: string): ResolvedAdvisorConfig => {
    try {
      return resolveAdvisorConfig({ ...sourceConfig(), enabled: effectiveEnabled(sessionId) })
    } catch (error) {
      return safeFallback(error instanceof Error ? error.message : String(error))
    }
  }
  ctx.logger('advisor').debug('dsh-advisor loaded', {
    enabled: safeResolved().enabled,
    disabledReason: safeResolved().disabledReason,
  })

  // T7: the per-session override mechanism — `/advisor on|off|toggle` write
  // here and the runtime gate consults `override ?? config.enabled`, so the
  // commands start/stop per-session runtimes WITHOUT touching the persisted
  // config (spec §4 mapping — omp `/advisor` semantics). Ephemeral: entries
  // are cleared on `agent/disposed` / `session/disposed` below. Seeded with
  // the RAW config switch (not the post-gate `resolved.enabled`): a config-
  // enabled-but-gate-blocked session (enabled without provider/model) then
  // re-derives the disabled-with-reason through the resolver, so `/advisor
  // status` shows the reason (spec §5.2; qc3 I-1) — the gate itself still
  // blocks every runtime (the resolver is the SSOT for the gate).
  const overrides = new AdvisorSessionOverrides(config.enabled)
  const effectiveEnabled = (sessionId: string): boolean => overrides.effective(sessionId)
  // Live-path alias: every consumer reads the effective config through the
  // safe wrapper (qc2 W-1 — a throwing resolver must not break the
  // session/event handler or `/advisor status`).
  const effectiveConfig = (sessionId: string): ResolvedAdvisorConfig => safeEffective(sessionId)

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
    immuneTurns: resolved().immuneTurns,
    // Registry fallback (KD-4): covers agents published before this plugin
    // loaded, whose `agent/created` was never observed. The delivery module is
    // session-id-string-typed; the registry key is the branded SessionId.
    lookupAgent: (sessionId: string) => ctx.agents.get(sessionId as SessionId),
    logger: ctx.logger('advisor'),
  })

  const runtimes = new Map<string, AdvisorRuntime>()
  /**
   * Runtime-affecting signature per session — the values that pin one
   * {@link AdvisorRuntime}: the effective switch, the post-gate enable (S4),
   * and the {provider, model, systemPrompt} triple. Recorded at runtime
   * creation and compared on every settings change (qc3 W-1 / qc1 W-2): only
   * a signature change tears the runtime down — an immuneTurns/
   * maxDeltaMessages-only edit updates the latches in place and keeps every
   * in-flight call and backlog.
   */
  const runtimeSignatures = new Map<string, string>()
  const runtimeSignature = (sessionId: string): string => {
    const effective = safeEffective(sessionId)
    return [
      effectiveEnabled(sessionId) ? 1 : 0,
      effective.enabled ? 1 : 0,
      effective.provider ?? '',
      effective.model ?? '',
      effective.systemPrompt,
    ].join('\u0000')
  }
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
      systemPrompt: safeResolved().systemPrompt || DEFAULT_ADVISOR_SYSTEM_PROMPT,
      // n4 root-cause (host-observed NO_ADAPTER): this plugin's ctx may live in
      // an isolated scope whose local llm service lacks the provider adapters
      // (adapter registrations live on the application root's LlmRuntime). Resolve
      // the llm service from the APPLICATION ROOT so the advisor's model calls
      // reach the registered deepseek-official adapter.
      llm: ((ctx as unknown as { root?: { get?: (k: string) => unknown } }).root?.get?.('llm') as typeof ctx.llm) ?? ctx.llm,
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
    runtimeSignatures.set(sessionId, runtimeSignature(sessionId))
    return runtime
  }
  const disposeRuntime = (sessionId: string): void => {
    const runtime = runtimes.get(sessionId)
    if (runtime === undefined) return
    runtimes.delete(sessionId)
    runtimeSignatures.delete(sessionId)
    runtime.dispose()
  }

  // n4 QC F-6: claim the single-reviewer role HERE — after every
  // construction-time throwing read (the delivery latch above resolves the
  // config and can throw on a rejected row), so a first fiber whose config
  // fails the gate never leaves the flag claimed (qc1 W-4). Non-reviewer
  // instances stop here — observer/runtime/delivery and the /advisor commands
  // are wired only by the single claimed reviewer. The settings registration
  // (installAdvisorSettings above) already ran deduped (qc1 W-5): the first
  // registration owns the live namespace on every composition.
  const reviewer = claimReviewer()
  if (!reviewer) {
    ctx.logger('advisor').debug('non-reviewer instance — observer/runtime/commands skipped (single-reviewer guard)')
    return
  }
  // qc1 W-4: release the claim when THIS (reviewer) fiber is disposed, so a
  // later re-apply/re-mount (plugin-row removal, composition reload, host hot
  // reload) can take over instead of leaving the advisor silently inert for
  // the process lifetime. Registered only on the claiming fiber.
  ctx.effect(() => () => {
    delete (globalThis as Record<string, unknown>)[REVIEWER_KEY]
  }, 'advisor: release reviewer claim')
  const observer = new SessionTranscriptObserver({
    maxDeltaMessages: resolved().maxDeltaMessages,
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

  // `session/event` is scope-filtered: the dsh scope carrier sets a
  // `[Context.filter]` on emitted events — untagged listeners pass, but a
  // tagged listener only receives events whose carrier key is on its own
  // key's ancestor chain (see `packages/core/scope/src/index.ts` scopeTarget).
  // Cordis dispatch skips the filter for global hooks
  // (`hook.global || !filter || filter.call(...)` — `cordis/src/events.ts`
  // dispatch), and the plugin's instances may be composed in isolated scopes
  // (dsh-advisor appears as multiple active fibers, e.g. 3), so `{ global:
  // true }` is required for the observer to receive every session's events
  // regardless of scope placement. Q2=grill-me-locked fix; verified by host
  // test (PM operator step, evidence in iteration guides).
  //
  // The three lifecycle listeners below dispatch through the SAME
  // scope-filtered carrier as `session/event` (dsh-session/dsh-agent
  // `announce`/`emitDisposed`), so they must be `{ global: true }` too (qc3
  // F4): a scoped fiber that observes out-of-scope sessions via the global
  // session/event listener would otherwise create per-session state —
  // renderers, runtimes, cooldowns, overrides — whose dispose events are
  // filtered out, a per-session leak for the host's lifetime. Create/dispose
  // symmetry restored; both dispose listeners are documented idempotent
  // (a runtime is disposed at most once, whichever signal lands first).
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    observer.handleEvent(session.id, session.events, event)
  }, { global: true })
  // Per-session runtime lifecycle. Spec KD-5(c) pins `agent/disposed`;
  // `session/disposed` is the store-level pair (both are idempotent — a
  // runtime is disposed at most once, whichever signal lands first). `agent/created`
  // creates the runtime eagerly (plan T4) when the session is enabled and
  // registers the agent in the KD-4 delivery map (T6); the observer fallback
  // covers pre-existing agents (KD-4-style robustness).
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    ensureRuntime(agent.id)
    delivery.registerAgent(agent)
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    observer.disposeSession(agent.id)
    disposeRuntime(agent.id)
    delivery.unregisterAgent(agent.id)
    overrides.clear(agent.id)
  }, { global: true })
  ctx.on('session/disposed', (session: Session) => {
    observer.disposeSession(session.id)
    disposeRuntime(session.id)
    delivery.unregisterAgent(session.id)
    overrides.clear(session.id)
  }, { global: true })

  // T1-settings live re-apply: construction-time latches (immuneTurns on the
  // delivery, maxDeltaMessages on the observer, systemPrompt + provider/model
  // on each per-session runtime) are re-derived from the NEW source on every
  // committed settings change and re-applied — delivery/observer update in
  // place, per-session runtimes rebuild only when their runtime-affecting
  // signature actually changed (qc3 W-1 / qc1 W-2: an immuneTurns/
  // maxDeltaMessages-only edit must not abort in-flight advisor calls or drop
  // backlogs). The S4 gate is re-applied by the resolver on every read, so a
  // settings edit can never start a gated model call (SSOT unchanged); the
  // config-level fallback switch follows the live source so new sessions pick
  // up a Settings-page `enabled` edit immediately. A settings user layer the
  // resolver rejects (qc2 W-1 — unknown key) stops the advisor without
  // wedging the re-apply path, and the last-good latches stay until the
  // config is repaired.
  bridge.onChange(() => {
    let next: ResolvedAdvisorConfig
    try {
      next = resolveAdvisorConfig(sourceConfig())
    } catch (error) {
      // The raw source is still readable for the switch even when the
      // resolver rejects the composed value; if even that fails, keep the
      // current config-level switch (the gate below still blocks runtimes).
      try {
        overrides.setConfigEnabled(sourceConfig().enabled)
      } catch {
        // unreadable source — the effective switch stays as-is
      }
      for (const sessionId of [...runtimes.keys()]) disposeRuntime(sessionId)
      ctx.logger('advisor').warn('settings change: invalid advisor config — advisor stopped', {
        disabledReason: error instanceof Error ? error.message : String(error),
      })
      return
    }
    delivery.setImmuneTurns(next.immuneTurns)
    observer.setMaxDeltaMessages(next.maxDeltaMessages)
    overrides.setConfigEnabled(sourceConfig().enabled)
    let rebuilt = 0
    for (const sessionId of [...runtimes.keys()]) {
      if (runtimeSignatures.get(sessionId) === runtimeSignature(sessionId)) continue
      disposeRuntime(sessionId)
      ensureRuntime(sessionId)
      rebuilt += 1
    }
    if (rebuilt > 0) {
      ctx.logger('advisor').debug('settings change rebuilt session runtimes', {
        rebuilt,
        provider: next.provider,
        model: next.model,
      })
    }
  })

  // T7: the `/advisor` command controller — the commands' session-scoped
  // operations against the observer/runtimes above. `/advisor on` seeds the
  // observer cursor to the current transcript length (KD-5 seed-on-enable —
  // no full-history replay) and creates/resumes/recoveries the session runtime;
  // `/advisor off` disposes it (abort in-flight, drop backlog). The S4 gate
  // reason is re-derived through the config resolver, the SSOT for the
  // disabled-with-reason text (spec §5.2).
  const controller: AdvisorCommandController = {
    setEnabled(sessionId: string, enabled: boolean, sessionLength?: number): void {
      // Recovery, not just a switch flip: `/advisor on` (and toggle-to-on)
      // must restart a session advisor that is `quota_exhausted` (KD-5 —
      // manual resume, no auto-resume timer) or `halted` (permanent model
      // error — terminal in place, rebuilt fresh here) (qc1/qc2/qc3 W-1/I-4).
      // The override is written only when the effective switch actually
      // changes; enabling an already-effectively-enabled session still routes
      // through the recovery path below instead of early-returning.
      const already = effectiveEnabled(sessionId) === enabled
      if (!already) overrides.set(sessionId, enabled)
      if (!enabled) {
        if (!already) disposeRuntime(sessionId)
        return
      }
      // enabled (newly or already): KD-5 seed — no full-history replay of
      // deltas that predate (or occurred while paused/halted under) the enable.
      if (sessionLength !== undefined) observer.seedTo(sessionId, sessionLength)
      const runtime = ensureRuntime(sessionId)
      if (runtime === undefined) return // S4 explicit gate blocks model calls
      if (runtime.status() === 'halted') {
        // KD-5 halting is terminal in place; `/advisor on` is the manual
        // recovery path — rebuild a fresh runtime (the S4 gate is re-applied
        // by ensureRuntime, so this can never start a gated model call).
        disposeRuntime(sessionId)
        ensureRuntime(sessionId)
      } else {
        runtime.resume() // no-op on 'running'; resumes 'quota_exhausted' (KD-5)
      }
    },
    getStatus(sessionId: string) {
      const runtime = runtimes.get(sessionId)
      const effective = effectiveConfig(sessionId)
      return {
        enabled: effective.enabled,
        ...(effective.disabledReason === undefined ? {} : { disabledReason: effective.disabledReason }),
        provider: safeResolved().provider,
        model: safeResolved().model,
        runtimeStatus: runtime?.status() ?? 'disabled',
        pendingCount: runtime?.pendingCount ?? 0,
        lastActivityAt: runtime?.lastActivity,
      }
    },
    // T2 (plan dsh-advisor-tui-client-n8): the composed-config readback.
    // Session-less BY DESIGN — reads `safeResolved()` (schema defaults →
    // plugin-row base → settings user layer, with the hard gate applied),
    // the SAME bridge source the web card reads through `resolveAdvisorConfig`
    // (`/api/advisor/get` has no session either). NEVER `effectiveConfig`/
    // `safeEffective` here: those bake the per-session `/advisor` override
    // into `enabled`, and a `/advisor off` session toggle must never make
    // the settings readback misreport settings.yaml. Runtime state stays
    // owned by `status`; this read reports config only. Every field comes
    // from that one resolved value; the systemPrompt summary is the first
    // line (≤ 80 chars) of `resolved.systemPrompt`, '' → unset.
    getConfig() {
      const resolved = safeResolved()
      return {
        enabled: resolved.enabled,
        ...(resolved.disabledReason === undefined ? {} : { disabledReason: resolved.disabledReason }),
        provider: resolved.provider,
        model: resolved.model,
        immuneTurns: resolved.immuneTurns,
        maxDeltaMessages: resolved.maxDeltaMessages,
        systemPromptSet: resolved.systemPrompt !== '',
        systemPromptSummary: summarizeSystemPrompt(resolved.systemPrompt),
        // T2 (plan dsh-advisor-tui-settings-n9): the truthful edit-hint input.
        // Computed LIVE at render time — `ctx.get(TUI_SETTINGS_SECTIONS) !==
        // undefined` (architect ruling): the upstream seam supports mid-session
        // mount/unmount via `subscribe()`, so a captured boolean set by the
        // inject child would go stale without extra bookkeeping; `ctx.get` is
        // the minimal truthful observable. An environment signal, NEVER derived
        // from the per-session override — the readback stays session-less and
        // read-only (this read only ever probes service presence).
        //
        // Servability assumption (QC2): a mounted `tuiSettingsSections` seam
        // implies a composed settings service in real dsh-tui profiles (the
        // `/settings` screen requires it), so the hint's "TUI /settings screen
        // (Advisor section)" claim is truthful; in the unreachable
        // seam-without-settings corner the section would render unavailable in
        // the host screen. The probe key is the SHARED
        // `TUI_SETTINGS_SECTIONS` constant (S-001) — the same key the section
        // registration condition uses, so the two cannot drift apart.
        tuiSettingsAvailable: ctx.get(TUI_SETTINGS_SECTIONS) !== undefined,
      }
    },
  }

  // T7: the command child activates ONLY when a command registry is composed
  // (conditional child activation — `commands` must NOT join the top-level
  // `inject` list, T1 fix). `/advisor` toggle/on/off/status (spec §2 S5).
  ctx.inject(['commands'], (commandCtx) => {
    registerAdvisorCommands(commandCtx.commands, controller)
  })

  // T1 (plan dsh-advisor-tui-client-n8): the dsh-tui client seam — the
  // `tuiCommandTrees` /advisor provider (zh/en `/`-menu description +
  // `on|off|status|config` completion). Runs AFTER the single-reviewer
  // claim, so the tree registers at most once per process (duplicate-root
  // registration would throw in the host registry). The inject is
  // conditional like `commands`/`settings`/`typert`: profiles without the
  // `dsh-tui-command-trees` row keep working (clean no-op).
  installTuiClient(ctx)

  // T1 (plan dsh-advisor-tui-settings-n9): the dsh-tui settings-section seam —
  // the `tuiSettingsSections` "Advisor" section (editable `/settings` screen
  // fields: enabled/provider/model/immuneTurns/maxDeltaMessages). Runs AFTER
  // the single-reviewer claim like `installTuiClient`, so the section
  // registers at most once per process (duplicate-ns registration is
  // contained inside the module). The inject is conditional: profiles without
  // the `dsh-tui-settings-sections` row (dsh-tui < v0.8.0, non-TUI hosts)
  // keep working (clean no-op). Order vs `installTuiClient` is irrelevant —
  // independent services; kept adjacent for cohesion.
  installTuiSettingsSection(ctx)
}
