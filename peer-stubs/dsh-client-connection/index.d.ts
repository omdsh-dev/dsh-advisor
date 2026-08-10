/**
 * Dev-time type-only shim for `@deepseek-ai/dsh-client-connection/client` — the
 * browser wire client types consumed (type-only) by the dsh-advisor client
 * half.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface pinned to dsh-private commit
 * b8343cb (2026-08-09 snapshot): the unary RPC envelope shapes, the settings
 * domain (describe/update/replace/mutate + SettingsNamespaceView /
 * SettingsPathOpView / SettingsSecretView), the llm domain
 * (providers/models/discoverModels + ConfigurableProviderView /
 * ModelProviderGroup / ModelCatalogFailure / DiscoveredModelView), and the
 * `ConnectionHandle` service surface (`api`). No runtime: the client half
 * imports these type-only and the wire value arrives via cordis injection
 * (`ctx.get('connection')`), exactly like the ui-models reference.
 *
 * @module @deepseek-ai/dsh-client-connection/client
 */

/** Message correlation id (opaque string brand). */
export type RpcId = string & { readonly __rpcIdBrand?: never }

/** Signature-layer narrow form, request side. */
export interface RpcRequest<P> {
  rpcId: RpcId
  payload: P
}

/** Error code → details (minimal closed union covering the advisor-consumed codes). */
export type RpcErrorCode =
  | 'bad-request'
  | 'settings-rejected'
  | 'settings-conflict'
  | 'settings-not-exposed'
  | 'internal'

/** One RPC failure: code is the discriminant, details are opaque to the consumer. */
export interface RpcError {
  code: RpcErrorCode
  message: string
  details: unknown
}

/** Business success/failure result: the result slot of a unary response; methods never throw business errors. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

/** Signature-layer narrow form, response side: rpcId always echoes the matching request. */
export interface RpcResponse<T> {
  rpcId: RpcId
  result: RpcResult<T>
}

/** One schema-declared secret slot inside a redacted namespace value. */
export interface SettingsSecretView {
  /** Path from the section root to the removed field. */
  path: string[]
  /** Whether the slot currently holds a value (the value itself never rides). */
  set: boolean
}

/** Wire view of one registered settings namespace. */
export interface SettingsNamespaceView {
  /** Namespace key (`advisor`, `llm-deepseek`, …). */
  ns: string
  /** Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`. */
  schema: unknown
  /** Redacted resolved value (schema defaults → composition base → user layer). */
  value: unknown
  /** Redacted composition base layer, when the registrant declared one. */
  base?: unknown
  /** Redacted raw user section, when one exists; a field's presence here marks it user-overridden. */
  user?: unknown
  /** When the owner applies changes. */
  applies: 'live' | 'restart'
  /** Every schema-declared secret slot with its configured state. */
  secrets: SettingsSecretView[]
  /**
   * Monotonic revision of the raw user section this view was read at. Send it
   * back as `expectedRevision` on a write so a stale editor is refused rather
   * than silently overwriting a concurrent change.
   */
  revision: number
}

/**
 * One path-addressed edit carried by `settings.mutate`. `set` writes the
 * value at the path (creating intermediate objects); `unset` removes it. The
 * empty path addresses the section root.
 */
export type SettingsPathOpView =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/**
 * Settings-domain unary methods (the map keys settings.* of RpcMethodMap).
 * The client face takes the business PAYLOAD directly — the carrier layer
 * mints the RpcId and fills the envelope (mirror of the real
 * `@deepseek-ai/dsh-host-apiproxy/client` IApiClient shape).
 */
export interface SettingsApi {
  /** Describe every registered namespace: redacted layered values plus the serialized schema. */
  describe(payload: {}): Promise<RpcResponse<{
    writable: boolean
    hasDocument: boolean
    namespaces: SettingsNamespaceView[]
  }>>
  /** Merge a patch into one namespace's user layer; responds with the new redacted view. */
  update(payload: { ns: string; patch: object; expectedRevision?: number }): Promise<RpcResponse<SettingsNamespaceView>>
  /** Replace one namespace's user section wholesale — the removal/reset path. */
  replace(payload: { ns: string; section: object; expectedRevision?: number }): Promise<RpcResponse<SettingsNamespaceView>>
  /** Apply path-addressed edits to one namespace's user section, resolved against the section as stored. */
  mutate(
    payload: { ns: string; ops: SettingsPathOpView[]; expectedRevision?: number },
  ): Promise<RpcResponse<SettingsNamespaceView>>
}

/** Wire view of one configurable provider. */
export interface ConfigurableProviderView {
  /** Provider route key (`deepseek-official`, `openai`, …). */
  provider: string
  /** Human-readable name for configuration surfaces. */
  displayName: string
  /** Settings namespace whose section configures this provider. */
  settingsNs: string
  /** Path from that section's root to the provider's profile object (empty = whole section). */
  settingsPath: string[]
  /** Whether the route is currently registered (its models are requestable). */
  active: boolean
  /** Whether the owning adapter knows this route only because configuration declared it. */
  declared?: boolean
}

/** One model entry in a provider group (provider-preferred order). */
export interface ModelCatalogModel {
  /** Provider-owned model id. */
  id: string
  /** Provider-supplied display name. */
  name: string
  /** Optional provider-supplied description. */
  description?: string
}

/** One provider and the models it advertised successfully. */
export interface ModelProviderGroup {
  /** Provider route id used for requests. */
  id: string
  /** Provider display name. */
  name: string
  /** Models in provider-preferred order. */
  models: ModelCatalogModel[]
}

/** A provider whose asynchronous catalog lookup failed. */
export interface ModelCatalogFailure {
  /** Provider route id. */
  id: string
  /** Provider display name. */
  name: string
  /** Lookup failure diagnostic. */
  message: string
}

/** Wire view of one model an interrogated endpoint advertises. */
export interface DiscoveredModelView {
  /** Model id the endpoint accepts. */
  id: string
  /** Human-readable name when the endpoint supplies one. */
  name?: string
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
}

/** Llm-domain unary methods (the map keys llm.* of RpcMethodMap; payload-form, like the settings face). */
export interface LlmApi {
  /** List every configurable provider with its live/dormant state. */
  providers(payload: {}): Promise<RpcResponse<{ providers: ConfigurableProviderView[] }>>
  /** Host-scoped model catalog over every registered provider route. */
  models(payload: {}): Promise<RpcResponse<{ groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] }>>
  /** Interrogate a draft provider endpoint and return the models it advertises. */
  discoverModels(
    payload: {
      settingsNs: string
      provider?: string
      baseURL?: string
      api?: string
      apiKey?: string
    },
    signal?: AbortSignal,
  ): Promise<RpcResponse<{ models: DiscoveredModelView[] }>>
}

/** The shared api client surface (the wire domains the advisor section consumes). */
export interface IApiClient {
  /** Settings domain. */
  settings: SettingsApi
  /** Llm topology domain. */
  llm: LlmApi
}

/** The ctx.connection service surface (the wire root provides it). */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: unknown
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   */
  start(sinks: unknown, config?: unknown): { stop(): void }
}
