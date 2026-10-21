/**
 * T1 (plan dsh-advisor-settings-gateway-n5) — host-side `advisor` config
 * gateway: the `/api/advisor/get` + `/api/advisor/set` Remote endpoints, the
 * B2 per-session model endpoints, and the T2 read-only
 * `/api/advisor/modelReasoning` capability query (plan
 * dsh-advisor-reasoning-effort).
 *
 * Transport: the typertGateway `/api` interceptor is the single host-wide RPC
 * slot (a plugin must NOT `connection.rpc.intercept('/api')` again — it would
 * throw). Instead this service declares a typertGateway binding (via the
 * `TypertRemoteService` base) plus `@Remote` method markers; the gateway's SRC
 * discovery (`claimsEndpoint` — `ctx.reflect.props` + `remoteMethods`) claims
 * `/api/advisor/get` and `/api/advisor/set`, and the payload contract is
 * exactly one plain-object `args` field whose keys are the method parameter
 * names (`get()` → `{ args: {} }`; `set(patch)` → `{ args: { patch } }`).
 *
 * Data: `get` reads the `AdvisorSettingsBridge` source — the same live entry
 * config the runtime reads (volatile references unwrapped), resolved through
 * the `resolveAdvisorConfig` hard gate (the SSOT for enabled-without-pair
 * disabled-with-reason). `set` validates the patch against the `Config`
 * schema first (unknown-key rejection unchanged — the settings service itself
 * is non-strict and would accept the unknown key), then writes the advisor
 * ENTRY config in-process via `settings.update(ADVISOR_SETTINGS_NAMESPACE, ...)`
 * (dsh 0.1.7-rc.1: the namespace key IS the profile entry id — the bundle row
 * id `advisor` — and the write lands through the config editor into the
 * Loader, which commits the volatile fields and emits `loader/volatile-update`,
 * re-applying the runtime through the bridge with no restart), and returns
 * the new composed value.
 *
 * The settings service is OPTIONAL (no settings service → the bridge source
 * stays the entry, `get` still works; `set` fails with a clear error — KD-G5
 * fallback). The gateway captures the service through a conditional
 * `ctx.inject(['settings'], ...)` child, because `ctx.settings` is only
 * resolvable from a fiber that declares it.
 *
 * The returned config is normalized to the typertGateway JSON wire boundary:
 * absent keys (provider/model/disabledReason, and proseFallback when the raw
 * entry omits it on the S1 containment path) are OMITTED,
 * never present-as-undefined (the gateway's result validation rejects
 * undefined values). No `maxTokens` key is carried anymore (2026-10-18
 * ruling: the model-side budget is removed; a stored `maxTokens` line is
 * tolerated and dropped by the resolver).
 *
 * @module dsh-advisor/gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import type SettingsForms from '@deepseek-ai/dsh-settings'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { ADVISOR_SETTINGS_NAMESPACE } from './settings.js'
import type { AdvisorSettingsBridge } from './settings.js'
import { parseModelPair } from './commands.js'
import type { AdvisorModelSource } from './commands.js'
import { resolveAdvisorConfig } from './config.js'
import type { AdvisorConfig, ResolvedAdvisorConfig } from './config.js'

/** Patch shape accepted by `advisor.set` — any subset of the config keys. */
export type AdvisorConfigPatch = Partial<AdvisorConfig>

// ---------------------------------------------------------------------------
// Session model surface (B2 — issue #88 web session control)
// ---------------------------------------------------------------------------

/** An atomic reviewer-route pair on the wire (JSON-safe; never undefined-valued). */
export interface AdvisorPairWire {
  readonly provider: string
  readonly model: string
}

/**
 * The authoritative per-session advisor snapshot (spec §5.3) — the wire value
 * of `advisor/getSession` and of a successful `advisor/setSessionModel`.
 * Absent optional keys are OMITTED (the typertGateway result validation
 * rejects undefined values), never present-as-undefined:
 *
 * - `modelOverride` — the session's pinned atomic pair; omitted while the
 *   session inherits the global defaults;
 * - `modelSource` — where the effective route comes from (`session` = the
 *   pin, `global` = the composed global pair); present iff an effective pair
 *   exists at all;
 * - `effectiveModel` — the effective route; omitted when neither level has a
 *   complete pair;
 * - `disabledReason` — the S4 explicit-gate reason when it blocks.
 */
export interface AdvisorSessionSnapshotWire {
  readonly sessionId: string
  readonly enabled: boolean
  /** Live-session lifetime marker (spec §5.3 — the snapshot is never durable). */
  readonly lifetime: 'live-session'
  readonly modelOverride?: AdvisorPairWire
  readonly modelSource?: AdvisorModelSource
  readonly effectiveModel?: AdvisorPairWire
  readonly disabledReason?: string
}

/**
 * Plugin-domain error tags carried in RETURNED DATA (`{ error: { tag,
 * message } }`) — never new RemoteError codes (dsh's failure vocabulary stays
 * frozen) and never a thrown coded failure for these business outcomes:
 *
 * - `advisor/session-unknown` — the target session is not (or no longer)
 *   live; rejected without allocating any state;
 * - `advisor/unavailable` — this gateway fiber holds no elected owner (no
 *   controller face); the endpoints stay inert rather than guessing;
 * - `advisor/rejected` — the selection failed pair validation (nothing was
 *   written);
 * - `advisor/failed` — the pre-commit `resolveModelInfo` validation failed
 *   (previous selection untouched);
 * - `advisor/superseded` — a newer set/reset superseded the attempt;
 * - `advisor/cancelled` — the attempt was cancelled before commit.
 */
export type AdvisorSessionErrorTag =
  | 'advisor/session-unknown'
  | 'advisor/unavailable'
  | 'advisor/rejected'
  | 'advisor/failed'
  | 'advisor/superseded'
  | 'advisor/cancelled'

/** One `advisor/getSession` / `advisor/setSessionModel` result: snapshot or tagged data error. */
export type AdvisorSessionRpcResult =
  | { readonly snapshot: AdvisorSessionSnapshotWire }
  | { readonly error: { readonly tag: AdvisorSessionErrorTag; readonly message: string } }

/** Build one tagged data error (keeps every call site's shape identical). */
export function advisorSessionError(tag: AdvisorSessionErrorTag, message: string): AdvisorSessionRpcResult {
  return { error: { tag, message } }
}

// ---------------------------------------------------------------------------
// Model capability surface (plan dsh-advisor-reasoning-effort T2)
// ---------------------------------------------------------------------------

/** One adapter-declared reasoning effort on the wire (JSON-safe projection). */
export interface AdvisorModelReasoningEffortWire {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/**
 * The `LlmResolvedModelInfo.reasoning` slice the capability endpoint serves.
 * Structural (no dsh import): the gateway reads exactly `efforts` — the
 * adapter's `defaultEffort` is deliberately NOT projected, since the runtime's
 * "automatic" is `efforts[0]` and nothing consumes the adapter default — and
 * the wiring that passes `LlmRuntime.resolveModelInfo` over is typechecked
 * against this shape at the assignment site.
 */
export interface AdvisorModelReasoningInfo {
  /** Declared efforts, least → greatest — the adapter's order, preserved. */
  readonly efforts: readonly AdvisorModelReasoningEffortWire[]
}

/**
 * Minimal model-metadata lookup the gateway drives (satisfied by
 * `LlmRuntime.resolveModelInfo`). OPTIONAL: a gateway constructed without one
 * (no app-root llm on this fiber) stays inert — the endpoint answers
 * `advisor/model-reasoning-unavailable` instead of guessing.
 */
export type AdvisorModelInfoResolver = (
  provider: string,
  model: string,
  signal?: AbortSignal,
) => Promise<{ readonly reasoning?: AdvisorModelReasoningInfo }>

/**
 * Plugin-domain error tags for the READ-ONLY capability query
 * (`advisor/modelReasoning`), carried in RETURNED DATA like the session tags —
 * never new RemoteError codes and never a thrown coded failure:
 *
 * - `advisor/model-reasoning-unavailable` — there is nothing to answer with:
 *   the provider/model pair is malformed, this gateway holds no resolver, or
 *   the model declares no selectable reasoning effort;
 * - `advisor/model-reasoning-failed` — the lookup itself failed (adapter
 *   throw, unknown route).
 */
export type AdvisorModelReasoningErrorTag =
  | 'advisor/model-reasoning-unavailable'
  | 'advisor/model-reasoning-failed'

/** One `advisor/modelReasoning` result: the declared efforts, or a tagged data error. */
export type AdvisorModelReasoningResult =
  | AdvisorModelReasoningInfo
  | { readonly error: { readonly tag: AdvisorModelReasoningErrorTag; readonly message: string } }

/**
 * Logger seam for the capability endpoint's failure diagnostics (cordis
 * `ctx.logger('advisor')` satisfies it). OPTIONAL: a gateway constructed
 * without one answers the same generic wire message and simply logs nothing.
 */
export interface AdvisorGatewayLogger {
  warn(message: string, ...args: unknown[]): void
}

/** Build one tagged capability error (keeps every arm's shape identical). */
function modelReasoningError(tag: AdvisorModelReasoningErrorTag, message: string): AdvisorModelReasoningResult {
  return { error: { tag, message } }
}

/**
 * Whole-lookup deadline for one capability query (W-1): the SAME 60 s norm the
 * command face applies to its model validation (`src/commands.ts`
 * `ADVISOR_MODEL_VALIDATION_TIMEOUT_MS`) and the runtime applies to one
 * `llm.stream` call (`src/advisor-runtime.ts` `callTimeoutMs`).
 */
const ADVISOR_MODEL_REASONING_TIMEOUT_MS = 60_000

/** Capability-owned code stamped onto the deadline's TimeoutReason. */
const ADVISOR_MODEL_REASONING_TIMEOUT = 'ADVISOR_MODEL_REASONING_TIMEOUT'

/**
 * Race one lookup against the deadline signal (the same shape as the command
 * face's `raceSignal`, `src/index.ts`): settle with the lookup's value, or
 * `'aborted'` when the signal aborts first. `deadline()` only NOTIFIES through
 * its signal, so a resolver whose lookup ignores cancellation would otherwise
 * hang the query past the bound — the race makes the 60 s limit real for the
 * caller regardless of resolver behavior.
 */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise<T | 'aborted'>((resolve, reject) => {
    const onAbort = (): void => resolve('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * The elected owner's session face — implemented by the wiring (`index.ts`)
 * against the SAME `AdvisorCommandController` the `/advisor model` commands
 * drive (spec §5.3: one controller, no second state store, no divergence
 * between the command face and the web face). The gateway consults it lazily
 * per request: only the reviewer-claiming fiber assigns it, so a gateway on a
 * non-owner fiber stays inert (`advisor/unavailable`) instead of guessing.
 */
export interface AdvisorSessionGatewayFace {
  /** Authoritative snapshot for one live session (unknown → tagged error). */
  getSession(sessionId: string): AdvisorSessionRpcResult
  /** Validate + commit a pair through the command controller (same fencing). */
  setSessionModel(sessionId: string, provider: string, model: string): Promise<AdvisorSessionRpcResult>
  /** Drop the pin and re-inherit (selection: null); never touches the enable override. */
  resetSessionModel(sessionId: string): AdvisorSessionRpcResult
}

// ---------------------------------------------------------------------------
// Next-prompt suggestion surface (plan dsh-advisor-next-prompt-n12, T2)
// ---------------------------------------------------------------------------

/**
 * Plugin-domain error tags for the READ-ONLY suggestion query
 * (`advisor/suggestion`), carried in RETURNED DATA like the session tags —
 * never new RemoteError codes and never a thrown coded failure:
 *
 * - `advisor/rejected` — the request is malformed (empty/non-string
 *   sessionId); nothing was consulted;
 * - `advisor/unavailable` — this gateway fiber holds no elected owner (no
 *   suggestion face); the endpoint stays inert rather than guessing.
 */
export type AdvisorSuggestionErrorTag =
  | 'advisor/rejected'
  | 'advisor/unavailable'

/**
 * One `advisor/suggestion` result: the stored single-line suggestion
 * (`suggestion: null` = nothing stored or the feature is off), or a tagged
 * data error. Read-only: later tasks rely on the endpoint being idempotent
 * and side-effect-free.
 */
export type AdvisorSuggestionRpcResult =
  | { readonly suggestion: string | null }
  | { readonly error: { readonly tag: AdvisorSuggestionErrorTag; readonly message: string } }

/**
 * The elected owner's suggestion face — implemented by the wiring
 * (`index.ts`) against the SAME `NextPromptManager` the transcript observer
 * feeds (one state store, no divergence). The gateway consults it lazily per
 * request, mirroring the `sessionControl` pattern; a gateway on a non-owner
 * fiber answers `advisor/unavailable` in data and stays inert.
 */
export interface AdvisorSuggestionFace {
  /** The stored suggestion for one session (`{ suggestion: null }` when none). */
  getSuggestion(sessionId: string): AdvisorSuggestionRpcResult
}

/**
 * The host-side `advisor` config gateway (`/api/advisor/get` +
 * `/api/advisor/set`). Registered as the cordis service key `'advisor'`
 * (namespace defaults to the service key). The `TypertRemoteService` base is
 * kept ONLY for its `typertRemote` binding — the typertGateway's dispatch
 * `validateBinding` requires the visible binding on the live service (a pure
 * instance property, no module-private state). Endpoints are registered
 * EXPLICITLY through `ctx.typert.register(advisorTypertContribution())`
 * (see `apply` in `src/index.ts`) instead of the `@Remote` SRC markers:
 * SRC discovery reads `remoteMethods()` — a module-private WeakMap in
 * `@deepseek-ai/dsh-typert-protocol` — so a locally-linked plugin whose
 * peers resolve outside the host installation never shares that table with
 * the host typertGateway (zero claimed endpoints, `/api/advisor/*` 404).
 * The explicit `TypertRegistry.register` path writes the invocation
 * descriptors into `ctx.typert.local`, which `claimsEndpoint` checks FIRST,
 * so claim + dispatch work regardless of module identity.
 */
export class AdvisorConfigGateway extends TypertRemoteService {
  private readonly bridge: AdvisorSettingsBridge
  /** The live settings service once the optional inject child activates. */
  private settings: SettingsForms | undefined
  /**
   * The elected owner's session face, resolved LAZILY per request. The
   * reviewer-claiming fiber assigns it after its controller exists (the
   * gateway is constructed before the single-reviewer claim); a `undefined`
   * answer means this fiber owns the service key but not the reviewer role —
   * the session endpoints answer `advisor/unavailable` in data and stay
   * inert (no second controller, no surviving-fiber promotion).
   */
  private readonly sessionControl: () => AdvisorSessionGatewayFace | undefined
  /**
   * The read-only model capability lookup (T2). Absent → the
   * `/api/advisor/modelReasoning` endpoint answers
   * `advisor/model-reasoning-unavailable` in data and stays inert.
   */
  private readonly resolveModelInfo: AdvisorModelInfoResolver | undefined
  /**
   * The failure-diagnostic logger (T2 hardening). Absent → the endpoint still
   * answers the same generic wire message, unlogged.
   */
  private readonly logger: AdvisorGatewayLogger | undefined
  /**
   * The elected owner's suggestion face (plan dsh-advisor-next-prompt-n12,
   * T2), resolved LAZILY per request like `sessionControl`. Absent → the
   * `/api/advisor/suggestion` endpoint answers `advisor/unavailable` in data
   * and stays inert.
   */
  private readonly suggestionFace: () => AdvisorSuggestionFace | undefined

  /**
   * @param ctx - owning context (the plugin fiber's ctx inside `apply`).
   * @param bridge - the same `AdvisorSettingsBridge` the runtime reads, so
   *   get/set always operate on the live composed config.
   * @param sessionControl - lazy access to the elected owner's session face
   *   (B2); defaults to "absent" so a direct construction without the wiring
   *   keeps the session endpoints cleanly unavailable.
   * @param resolveModelInfo - the app-root `LlmRuntime.resolveModelInfo`
   *   lookup the capability endpoint drives (T2); defaults to "absent" for the
   *   same reason — the endpoint then reports unavailable, never throws.
   * @param logger - diagnostic sink for the capability lookup's failure detail
   *   (never put on the wire); optional so existing constructions keep working.
   * @param suggestionFace - lazy access to the elected owner's suggestion
   *   face (plan dsh-advisor-next-prompt-n12, T2); defaults to "absent" so a
   *   direct construction without the wiring keeps the suggestion endpoint
   *   cleanly unavailable.
   */
  constructor(
    ctx: Context,
    bridge: AdvisorSettingsBridge,
    sessionControl: () => AdvisorSessionGatewayFace | undefined = () => undefined,
    resolveModelInfo?: AdvisorModelInfoResolver,
    logger?: AdvisorGatewayLogger,
    suggestionFace: () => AdvisorSuggestionFace | undefined = () => undefined,
  ) {
    super(ctx, 'advisor')
    this.bridge = bridge
    this.sessionControl = sessionControl
    this.resolveModelInfo = resolveModelInfo
    this.logger = logger
    this.suggestionFace = suggestionFace
    // The settings service is optional (no settings → entry fallback). The
    // inject child activates only when a settings service is composed, mirroring
    // installAdvisorSettings' conditional child; the returned disposer mirrors
    // its detach path — when the settings service goes away, the write channel
    // is gone with it, and `set` must fail cleanly (KD-G5) instead of holding a
    // stale service reference.
    ctx.inject(['settings'], (sctx) => {
      this.settings = sctx.settings
      return () => {
        this.settings = undefined
      }
    })
  }

  /**
   * Read the current composed config (schema defaults → entry base → settings
   * user layer) through the hard gate.
   * @returns the resolved config (incl. disabledReason when the gate blocks).
   */
  get(): { config: ResolvedAdvisorConfig } {
    return { config: this.readConfig() }
  }

  /**
   * B2 — the authoritative snapshot for one live session
   * (`/api/advisor/getSession`, args `{ sessionId }`). Read-only: never
   * allocates override state (the snapshot rides the wiring's `sessionStatus`
   * readback). Unknown/disposed targets answer `advisor/session-unknown`
   * without touching the controller; a gateway without an elected owner
   * answers `advisor/unavailable`. Business outcomes live in the returned
   * data (plugin-domain tags) — nothing here throws coded failures and the
   * dsh failure vocabulary stays frozen.
   */
  getSession(sessionId: string): AdvisorSessionRpcResult {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return advisorSessionError('advisor/rejected', 'advisor: getSession requires a non-empty sessionId')
    }
    const face = this.sessionControl()
    if (face === undefined) {
      return advisorSessionError('advisor/unavailable', 'advisor: the session control surface is not owned by this gateway — no elected owner on this fiber')
    }
    return face.getSession(sessionId)
  }

  /**
   * B2 — set (or reset) the per-session reviewer route for one live session
   * (`/api/advisor/setSessionModel`, args `{ sessionId, selection }`).
   * `selection: null` = reset (re-inherit the CURRENT global defaults; never
   * touches the enable override). A non-null selection must be the atomic
   * `{ provider, model }` pair and passes the SAME validation as the command
   * face (`parseModelPair` — spec §5.3); the write itself routes through the
   * elected owner's `AdvisorCommandController` (`setModel`/`resetModel`), so
   * pre-commit `resolveModelInfo` validation (60 s, cancellable, no retry),
   * per-session generation fencing, and the route-change semantics are
   * INHERITED, not reimplemented. Unknown/disposed targets are rejected
   * BEFORE the controller runs — no generation is allocated for a dead
   * session. Returns the post-commit snapshot on success.
   */
  async setSessionModel(sessionId: string, selection: unknown): Promise<AdvisorSessionRpcResult> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return advisorSessionError('advisor/rejected', 'advisor: setSessionModel requires a non-empty sessionId')
    }
    const face = this.sessionControl()
    if (face === undefined) {
      return advisorSessionError('advisor/unavailable', 'advisor: the session control surface is not owned by this gateway — no elected owner on this fiber')
    }
    // Reset arm: the wire selection is null (JSON has no undefined).
    if (selection === null) return face.resetSessionModel(sessionId)
    // Set arm: validate the atomic pair shape BEFORE touching the controller
    // (a malformed selection must not allocate a generation). Non-object and
    // extra-field shapes read as absent keys → the same incomplete-pair
    // rejection the command face reports.
    const pair = typeof selection === 'object' && selection !== null
      ? (selection as { provider?: unknown; model?: unknown })
      : {}
    const validated = parseModelPair(pair.provider, pair.model)
    if (!validated.ok) return advisorSessionError('advisor/rejected', `advisor: ${validated.reason}`)
    return face.setSessionModel(sessionId, validated.provider, validated.model)
  }

  /**
   * T2 (plan dsh-advisor-next-prompt-n12) — the READ-ONLY next-prompt
   * suggestion query (`/api/advisor/suggestion`, args `{ sessionId }`): the
   * single-line suggestion the manager stored for the session's next turn.
   * Read-only and side-effect-free (later tasks rely on idempotence) — the
   * wire method name `suggestion` aliases this implementation member
   * (`advisorTypertContribution`). Malformed requests answer
   * `advisor/rejected`; a gateway without an elected owner answers
   * `advisor/unavailable`. Business outcomes live in the returned data
   * (plugin-domain tags) — nothing here throws coded failures.
   */
  getSuggestion(sessionId: string): AdvisorSuggestionRpcResult {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return {
        error: { tag: 'advisor/rejected', message: 'advisor: getSuggestion requires a non-empty sessionId' },
      }
    }
    const face = this.suggestionFace()
    if (face === undefined) {
      return {
        error: {
          tag: 'advisor/unavailable',
          message: 'advisor: the suggestion surface is not owned by this gateway — no elected owner on this fiber',
        },
      }
    }
    return face.getSuggestion(sessionId)
  }

  /**
   * T2 (plan dsh-advisor-reasoning-effort) — the READ-ONLY capability query
   * (`/api/advisor/modelReasoning`, args `{ provider, model }`): the efforts
   * the resolved model DECLARES, in the adapter's least → greatest order. The
   * settings card's effort selector reads THIS instead of a client-side
   * catalog: a profile-declared model has no catalog entry, so a second source
   * would drift from what the runtime can send.
   *
   * Never throws — every unanswerable arm is a tagged data error, so a
   * capability query can never fail the settings card. The success value
   * omits an absent `description` (the typertGateway result validation
   * rejects undefined values). The lookup is bounded by a 60 s deadline
   * (W-1): a hung resolver settles as `advisor/model-reasoning-failed`
   * naming the timeout, never an unbounded wait.
   */
  async modelReasoning(provider: string, model: string): Promise<AdvisorModelReasoningResult> {
    // The SAME pair validation as the command face and the session endpoints
    // (one source — `parseModelPair`); a malformed pair cannot name a route.
    const pair = parseModelPair(provider, model)
    if (!pair.ok) return modelReasoningError('advisor/model-reasoning-unavailable', `advisor: ${pair.reason}`)
    const resolve = this.resolveModelInfo
    if (resolve === undefined) {
      return modelReasoningError(
        'advisor/model-reasoning-unavailable',
        'advisor: model capability lookup is unavailable — this gateway holds no resolver for this fiber',
      )
    }
    // W-1: bound the lookup by the capability-lookup norm (60 s) and thread
    // the deadline signal into the resolver. The lookup is ALSO raced against
    // the signal, so a hung adapter that ignores cancellation settles here at
    // the deadline instead of leaving the card's effort select auto-only until
    // a reload. No upstream signal: the deadline is the only abort source.
    using deadlineHandle = deadline(undefined, ADVISOR_MODEL_REASONING_TIMEOUT_MS, ADVISOR_MODEL_REASONING_TIMEOUT)
    const signal = deadlineHandle.signal
    let info: { readonly reasoning?: AdvisorModelReasoningInfo } | 'aborted'
    try {
      info = await raceSignal(resolve(pair.provider, pair.model, signal), signal)
    } catch (error) {
      // The resolver's own message stays OFF the wire (adapter internals are
      // not client data); the caller only needs the tag, the detail goes to
      // the gateway logger.
      this.logger?.warn(
        'advisor: model capability lookup failed',
        { provider: pair.provider, model: pair.model, error },
      )
      return modelReasoningError('advisor/model-reasoning-failed', 'advisor: model capability lookup failed')
    }
    if (info === 'aborted') {
      return modelReasoningError(
        'advisor/model-reasoning-failed',
        `advisor: model capability lookup timed out after ${ADVISOR_MODEL_REASONING_TIMEOUT_MS}ms`,
      )
    }
    // No reasoning metadata (or an empty declaration) = nothing selectable:
    // the same verdict the runtime reaches (RD-2), so the card can never offer
    // an effort the runtime would silently replace with the smallest one.
    // The declaration is adapter data: entries without a usable id are
    // dropped and a missing/empty name falls back to the id, so the selector
    // can never render a nameless or unselectable option; a declaration that
    // filters empty — or is not a list at all — takes the same branch as an
    // absent one (this arm must never throw).
    const effortList = info?.reasoning?.efforts
    const declared = (Array.isArray(effortList) ? effortList : []).filter(
      (entry) => typeof entry?.id === 'string' && entry.id.length > 0,
    )
    if (declared[0] === undefined) {
      return modelReasoningError(
        'advisor/model-reasoning-unavailable',
        `advisor: ${pair.provider}/${pair.model} declares no reasoning efforts`,
      )
    }
    return {
      efforts: declared.map(({ id, name, description }) => ({
        id,
        name: typeof name === 'string' && name.length > 0 ? name : id,
        ...(description === undefined ? {} : { description }),
      })),
    }
  }

  /**
   * Validate a config patch and write it to the advisor ENTRY config (live —
   * the Loader commits the volatile fields and the runtime re-applies through
   * the bridge `onChange`; no restart needed).
   * @param patch - any subset of the config keys; unknown keys are rejected
   *   by the `Config` schema before anything is written. The legacy `enabled`
   *   key is the one tolerated exception (config.ts LEGACY_KEYS): it passes
   *   validation but is STRIPPED from the write payload — accepted, never
   *   persisted.
   * @returns the NEW composed config after the write.
   * @throws when the patch fails `Config` validation, or when no settings
   *   service is composed (KD-G5: the write channel is unavailable).
   */
  async set(patch: AdvisorConfigPatch): Promise<{ config: ResolvedAdvisorConfig }> {
    // Unknown-key rejection + type/bounds validation. The settings service
    // schema is non-strict (unknown keys merge through), so the explicit
    // reject happens here, before the write — same strictness as the Loader.
    resolveAdvisorConfig(patch)
    // S2: an empty patch is a no-op — return the current composed value
    // without a pointless settings round-trip.
    if (Object.keys(patch).length === 0) return { config: this.readConfig() }
    const settings = this.settings
    if (settings === undefined) {
      // Remote failure vocabulary (dsh 0.1.2-alpha.2): the gateway dispatch
      // encodes thrown RemoteError onto the wire unchanged, so the card
      // receives a coded RemoteFailure instead of an ad-hoc Error shape.
      throw new RemoteError('gateway/internal', 'advisor: settings service is unavailable — configuration cannot be written', {})
    }
    // Wire normalization (QC tri M-2) + legacy strip (2026-09-27): JSON
    // cannot carry undefined, so a null-valued key is a third-party client's
    // way of saying "absent" — the resolver already treats null as missing on
    // read, but the raw entry config must not store it. The schema-removed
    // `enabled` rides the same drop: the resolver TOLERATES it in a patch
    // (config.ts LEGACY_KEYS — stored profiles must load cleanly), but the
    // dead key must never be re-persisted here — the plugin-row toggle
    // replaced it, so writing it back would resurrect a switch nothing reads.
    // An all-null / enabled-only patch is a no-op, like the empty patch above.
    const normalized = Object.fromEntries(
      Object.entries(patch).filter(([key, value]) => key !== 'enabled' && value !== null),
    )
    if (Object.keys(normalized).length === 0) return { config: this.readConfig() }
    // The `ns` argument is the PROFILE ENTRY id — the advisor bundle row id
    // (`cordis.patch.yml`), not a registered namespace (0.1.7-rc.1 has no
    // registration; entries with volatile fields surface automatically). The
    // write goes through the config editor into the Loader, which commits the
    // volatile references and emits `loader/volatile-update` — the bridge
    // onChange re-apply closes the loop before this promise settles.
    await settings.update(ADVISOR_SETTINGS_NAMESPACE, normalized)
    return { config: this.readConfig() }
  }

  /**
   * Resolve the live entry config through the hard gate. Containment
   * (qc2 W-1): an entry config the resolver rejects (e.g. an unknown key
   * that survived the non-strict schemastery object merge) resolves to
   * disabled-with-reason carrying the message — the gateway never fails the
   * RPC on a bad config, and gate semantics hold (no model call can start).
   * S1: when the raw source is still readable, the fallback seeds its scalar
   * latches (systemPrompt / immuneTurns / maxDeltaMessages /
   * proseFallback / reasoningEffort / nextPrompt / defaultEnabled) instead of
   * hardcoded defaults, so an invalid config only drops the offending keys.
   */
  private readConfig(): ResolvedAdvisorConfig {
    let config: ResolvedAdvisorConfig
    try {
      config = resolveAdvisorConfig(this.bridge.source())
    } catch (error) {
      let raw: AdvisorConfig | undefined
      try {
        raw = this.bridge.source()
      } catch {
        // unreadable source — fall back to the schema defaults below
      }
      config = {
        enabled: false,
        systemPrompt: raw?.systemPrompt ?? '',
        immuneTurns: raw?.immuneTurns ?? 3,
        maxDeltaMessages: raw?.maxDeltaMessages ?? 60,
        proseFallback: raw?.proseFallback,
        // The resolver never ran on this arm, so the RD-1 empty = automatic
        // normalization (config.ts) is mirrored here: a raw empty/blank value
        // must not surface as a present-as-empty key.
        reasoningEffort: raw?.reasoningEffort?.trim() || undefined,
        // T1 (plan dsh-advisor-next-prompt-n12): the resolved contract types
        // nextPrompt as a plain boolean — an absent raw key means the schema
        // default (true; enabled:false already blocks every prediction call).
        nextPrompt: raw?.nextPrompt ?? true,
        // GitHub issue #124: same containment rule for the session default —
        // an absent raw key keeps the schema default (true), so the S1
        // fallback never invents the opt-in behavior.
        defaultEnabled: raw?.defaultEnabled ?? true,
        disabledReason: error instanceof Error ? error.message : String(error),
      }
    }
    // typertGateway wire boundary: absent keys are omitted, never
    // present-as-undefined (the result validator rejects undefined values).
    // Key census (qc1 W-1, issue #102; T2 plan dsh-advisor-reasoning-effort;
    // T1 plan dsh-advisor-next-prompt-n12; GitHub issue #124): NINE persisted
    // keys — the live `CONFIG_KEYS` set in src/config.ts: systemPrompt,
    // immuneTurns, maxDeltaMessages, proseFallback, reasoningEffort, provider,
    // model, nextPrompt, defaultEnabled. The scalar pair (provider/model) and
    // reasoningEffort are omitted while unset; the schema-defaulted booleans
    // (proseFallback, nextPrompt, defaultEnabled) ride every resolved get.
    // Plus TWO non-persisted live fields: `enabled`/`disabledReason` (the gate
    // state, never stored). No maxTokens key since the 2026-10-18 ruling
    // (budget removed).
    const wire: Record<string, unknown> = {
      enabled: config.enabled,
      systemPrompt: config.systemPrompt,
      immuneTurns: config.immuneTurns,
      maxDeltaMessages: config.maxDeltaMessages,
    }
    if (config.proseFallback !== undefined) wire.proseFallback = config.proseFallback
    if (config.reasoningEffort !== undefined) wire.reasoningEffort = config.reasoningEffort
    // T1 (plan dsh-advisor-next-prompt-n12): a persisted key whose resolver
    // normalizes it to a plain boolean (the schema default fills true), so it
    // rides every resolved get without a gate.
    wire.nextPrompt = config.nextPrompt
    // GitHub issue #124: always included, like nextPrompt — the resolved
    // contract always carries the plain boolean (schema default true; the S1
    // fallback seeds the raw/default value).
    wire.defaultEnabled = config.defaultEnabled
    if (config.provider !== undefined) wire.provider = config.provider
    if (config.model !== undefined) wire.model = config.model
    if (config.disabledReason !== undefined) wire.disabledReason = config.disabledReason
    return wire as unknown as ResolvedAdvisorConfig
  }
}

/**
 * The explicit typert contribution for the `advisor` gateway endpoints —
 * registered via `ctx.typert.register(...)` (see `apply` in `src/index.ts`).
 * The descriptors mirror exactly what the former SRC discovery derived from
 * the `@Remote` markers (`src:advisor#<endpoint>` identity shape, direct
 * receiver, JSON wire params with `src-json` codec), so the host
 * typertGateway claim + dispatch behavior is byte-for-byte the same — the
 * only difference is the registration does not depend on the module-private
 * `remoteMethods` marker table, which a locally-linked plugin can never
 * share with the host installation.
 */
export function advisorTypertContribution(): TypertContribution {
  return {
    package: 'dsh-advisor',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      {
        id: 'dsh-advisor#advisor/get',
        service: 'advisor',
        namespace: 'advisor',
        method: 'get',
        invocation: { kind: 'direct' },
        parameters: [],
        result: { mode: 'src-json' },
      },
      {
        id: 'dsh-advisor#advisor/set',
        service: 'advisor',
        namespace: 'advisor',
        method: 'set',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'patch', wire: 'patch', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      },
      // B2 — the per-session model surface (issue #88). Same explicit
      // registration, same direct/src-json dispatch shape; the payload
      // contract stays one plain-object `args` keyed by parameter name
      // (`getSession` → `{ args: { sessionId } }`; `setSessionModel` →
      // `{ args: { sessionId, selection } }`).
      {
        id: 'dsh-advisor#advisor/getSession',
        service: 'advisor',
        namespace: 'advisor',
        method: 'getSession',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      },
      {
        id: 'dsh-advisor#advisor/setSessionModel',
        service: 'advisor',
        namespace: 'advisor',
        method: 'setSessionModel',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } },
          { name: 'selection', wire: 'selection', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      },
      // T2 (plan dsh-advisor-reasoning-effort) — the read-only model
      // capability query. Same explicit registration, same direct/src-json
      // dispatch shape; the payload contract stays one plain-object `args`
      // keyed by parameter name (`modelReasoning` → `{ args: { provider,
      // model } }`). Async (the adapter lookup is awaited), still tag-in-data.
      {
        id: 'dsh-advisor#advisor/modelReasoning',
        service: 'advisor',
        namespace: 'advisor',
        method: 'modelReasoning',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'provider', wire: 'provider', source: 'json', codec: { mode: 'src-json' } },
          { name: 'model', wire: 'model', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      },
      // T2 (plan dsh-advisor-next-prompt-n12) — the read-only next-prompt
      // suggestion query. Same explicit registration, same direct/src-json
      // dispatch shape; the payload contract stays one plain-object `args`
      // keyed by parameter name (`suggestion` → `{ args: { sessionId } }`).
      // The wire method name `suggestion` aliases the implementation member
      // `getSuggestion` (InvocationDescriptor.implementation), keeping the
      // endpoint noun-shaped on `/api/advisor/suggestion` while the class
      // member keeps its accessor-style name. Synchronous, tag-in-data.
      {
        id: 'dsh-advisor#advisor/suggestion',
        service: 'advisor',
        namespace: 'advisor',
        method: 'suggestion',
        implementation: 'getSuggestion',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      },
    ],
  }
}
