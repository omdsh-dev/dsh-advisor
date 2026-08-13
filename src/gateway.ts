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
 * Data: `get` reads the `AdvisorSettingsBridge` source — the same live
 * composed config the runtime reads (schema defaults → plugin-row base →
 * settings user layer), resolved through the `resolveAdvisorConfig` hard gate
 * (the SSOT for enabled-without-pair disabled-with-reason). `set` validates
 * the patch against the `Config` schema first (unknown-key rejection
 * unchanged — the settings service itself is non-strict and would accept the
 * unknown key), then writes the USER layer in-process via
 * `ctx.settings.update` (no exposed-namespace gate on the in-process write —
 * the wire-level `exposedNamespaces()` check only guards the apiproxy path),
 * and returns the new composed value.
 *
 * The settings service is OPTIONAL (no settings service → the bridge source
 * stays the entry, `get` still works; `set` fails with a clear error — KD-G5
 * fallback). The gateway captures the service through a conditional
 * `ctx.inject(['settings'], ...)` child (the same activation pattern as
 * `installAdvisorSettings`), because `ctx.settings` is only resolvable from a
 * fiber that declares it.
 *
 * The returned config is normalized to the typertGateway JSON wire boundary:
 * absent keys (provider/model/disabledReason) are OMITTED, never
 * present-as-undefined (the gateway's result validation rejects undefined
 * values).
 *
 * @module dsh-advisor/gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { ADVISOR_SETTINGS_NAMESPACE } from './settings.js'
import type { AdvisorSettingsBridge } from './settings.js'
import { resolveAdvisorConfig } from './config.js'
import type { AdvisorConfig, ResolvedAdvisorConfig } from './config.js'

/** Patch shape accepted by `advisor.set` — any subset of the config keys. */
export type AdvisorConfigPatch = Partial<AdvisorConfig>

/**
 * The host-side `advisor` config gateway (`/api/advisor/get` +
 * `/api/advisor/set`). Registered as the cordis service key `'advisor'`
 * (namespace defaults to the service key), so the typertGateway SRC discovery
 * claims the `advisor/<method>` endpoints.
 */
export class AdvisorConfigGateway extends TypertRemoteService {
  private readonly bridge: AdvisorSettingsBridge
  /** The live settings service once the optional inject child activates. */
  private settings: SettingsProvider | undefined

  /**
   * @param ctx - owning context (the plugin fiber's ctx inside `apply`).
   * @param bridge - the same `AdvisorSettingsBridge` the runtime reads, so
   *   get/set always operate on the live composed config.
   */
  constructor(ctx: Context, bridge: AdvisorSettingsBridge) {
    super(ctx, 'advisor')
    this.bridge = bridge
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
  @Remote('get')
  get(): { config: ResolvedAdvisorConfig } {
    return { config: this.readConfig() }
  }

  /**
   * Validate a config patch and write it to the settings USER layer (live —
   * the runtime re-applies through the bridge `onChange`; no restart needed).
   * @param patch - any subset of the config keys; unknown keys are rejected
   *   by the `Config` schema before anything is written.
   * @returns the NEW composed config after the write.
   * @throws when the patch fails `Config` validation, or when no settings
   *   service is composed (KD-G5: the write channel is unavailable).
   */
  @Remote('set')
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
      throw new Error('advisor: settings service is unavailable — configuration cannot be written')
    }
    // Wire normalization (QC tri M-2): JSON cannot carry undefined, so a
    // null-valued key is a third-party client's way of saying "absent" — the
    // resolver already treats null as missing on read, but the raw user layer
    // must not store it. Drop null values before the write (an all-null patch
    // is a no-op, like the empty patch above).
    const normalized = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== null),
    )
    if (Object.keys(normalized).length === 0) return { config: this.readConfig() }
    await settings.update(ADVISOR_SETTINGS_NAMESPACE, normalized)
    return { config: this.readConfig() }
  }

  /**
   * Resolve the live composed config through the hard gate. Containment
   * (qc2 W-1): a user layer the resolver rejects (e.g. an unknown key that
   * survived the non-strict settings schema) resolves to disabled-with-reason
   * carrying the message — the gateway never fails the RPC on a bad user
   * layer, and gate semantics hold (no model call can start). S1: when the
   * raw source is still readable, the fallback seeds its scalar latches
   * (systemPrompt / immuneTurns / maxDeltaMessages) instead of hardcoded
   * defaults, so an invalid layer only drops the offending keys.
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
