/**
 * T1 (plan dsh-advisor-settings-gateway-n5) — host-side `advisor` config
 * gateway: the `/api/advisor/get` + `/api/advisor/set` Remote endpoints.
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
 * absent keys (provider/model/disabledReason) are OMITTED, never
 * present-as-undefined (the gateway's result validation rejects undefined
 * values).
 *
 * @module dsh-advisor/gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import type SettingsForms from '@deepseek-ai/dsh-settings'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
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
   * @param ctx - owning context (the plugin fiber's ctx inside `apply`).
   * @param bridge - the same `AdvisorSettingsBridge` the runtime reads, so
   *   get/set always operate on the live composed config.
   * @param sessionControl - lazy access to the elected owner's session face
   *   (B2); defaults to "absent" so a direct construction without the wiring
   *   keeps the session endpoints cleanly unavailable.
   */
  constructor(ctx: Context, bridge: AdvisorSettingsBridge, sessionControl: () => AdvisorSessionGatewayFace | undefined = () => undefined) {
    super(ctx, 'advisor')
    this.bridge = bridge
    this.sessionControl = sessionControl
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
   * Validate a config patch and write it to the advisor ENTRY config (live —
   * the Loader commits the volatile fields and the runtime re-applies through
   * the bridge `onChange`; no restart needed).
   * @param patch - any subset of the config keys; unknown keys are rejected
   *   by the `Config` schema before anything is written.
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
    // Wire normalization (QC tri M-2): JSON cannot carry undefined, so a
    // null-valued key is a third-party client's way of saying "absent" — the
    // resolver already treats null as missing on read, but the raw entry
    // config must not store it. Drop null values before the write (an
    // all-null patch is a no-op, like the empty patch above).
    const normalized = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== null),
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
   * latches (systemPrompt / immuneTurns / maxDeltaMessages) instead of
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
        disabledReason: error instanceof Error ? error.message : String(error),
      }
    }
    // typertGateway wire boundary: absent keys are omitted, never
    // present-as-undefined (the result validator rejects undefined values).
    const wire: Record<string, unknown> = {
      enabled: config.enabled,
      systemPrompt: config.systemPrompt,
      immuneTurns: config.immuneTurns,
      maxDeltaMessages: config.maxDeltaMessages,
    }
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
    ],
  }
}
