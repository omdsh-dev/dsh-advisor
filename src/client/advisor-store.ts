/**
 * Advisor settings page store (plan dsh-advisor-settings-gateway-n5, task 2).
 * One snapshot over the wire faces the section renders from; the host stays the
 * single fact source — every mutation writes through the host `advisor` config
 * gateway (`connection.rpc.call('/api', 'advisor/get' | 'advisor/set', …)`),
 * and the page re-renders from the next get, pushed or refetched.
 *
 * Data-source split (KD-G3):
 * - the **advisor config** reads/writes ride the gateway RPC channel
 *   (`/api/advisor/get` returns `{ config }`, `/api/advisor/set` accepts
 *   `{ patch }` and returns the new composed config) — the `advisor` settings
 *   namespace is NOT on the apiproxy exposed-namespaces whitelist, so the
 *   old `api.settings.describe`/`mutate` path is dead for it and the gateway
 *   is the only web-visible channel (host side: `src/gateway.ts`, `@Remote`
 *   get/set against the live `AdvisorSettingsBridge` source);
 * - the **provider/model directory** stays on `api.settings.describe` /
 *   `api.llm.*` (the `llm-deepseek` namespaces ARE in the exposed set).
 *
 * The returned config is the RESOLVED config (through the host hard gate):
 * absent keys (provider/model/disabledReason) are omitted by the wire
 * normalization, never present-as-undefined — the draft seeds treat them as
 * missing. Apply diffs the draft against the last-read config (the seed) and
 * sends only the changed keys as the `{ patch }`; clearing a provider/model
 * the seed pins stores an explicit `''` override (the gateway merge cannot
 * express an unset, and the resolver treats `''` as absent). Clearing a number
 * input leaves the field empty and omits the key from the patch.
 *
 * The join mirrors the ui-models Models page (store.ts):
 * - **configured** provider = its settings namespace resolves AND its profile
 *   resolves (`settingsPath` empty → whole section, else `getPath` on the
 *   namespace value);
 * - **model options** = the provider profile's declared `models` first
 *   (KD-S2), else the `llm.models` catalog group for that provider, else
 *   empty options + a reason (guidance copy lives in the section);
 * - the **draft** is seeded from the RESOLVED advisor config so the form
 *   always shows the effective configuration (KD-G5: `advisor.get` failure →
 *   the section shows the config-channel notice instead of a writable-looking
 *   form — never a hard load error, and never Apply).
 */

import type {
  ClientConnectionRpc, ConfigurableProviderView, IApiClient, ModelProviderGroup,
  SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { deletePath, getPath, setPath } from '@deepseek-ai/dsh-client-schema-form'

/**
 * The wire `config` value the host gateway returns — mirror of the node-side
 * `ResolvedAdvisorConfig` (src/config.ts). Kept as a local structural type
 * because the client bundle may not value-import the node-side module: the
 * wire normalization omits absent keys (provider/model/disabledReason are
 * simply missing from the JSON), so every optional key reads as undefined.
 */
export interface AdvisorConfigView {
  /** Master switch; the resolved value (false while the gate blocks). */
  enabled: boolean
  /** Provider route; absent when unset. */
  provider?: string
  /** Model id; absent when unset. */
  model?: string
  /** System prompt override ('' = built-in reviewer prompt). */
  systemPrompt: string
  /** Cooldown after a delivered interrupt; integer ≥ 0. */
  immuneTurns: number
  /** Delta window; integer ≥ 0, 0 = unbounded. */
  maxDeltaMessages: number
  /** Present iff the advisor is disabled by the explicit model gate. */
  disabledReason?: string
}

/** One provider row the section offers (configured providers only, KD-S2). */
export interface ProviderOption {
  /** Provider route id. */
  provider: string
  /** Human-readable provider name. */
  displayName: string
  /** Settings namespace whose section configures this provider. */
  settingsNs: string
  /** Path from that section's root to the provider's profile object. */
  settingsPath: readonly string[]
  /** Whether the profile resolves (always true inside the option list). */
  configured: boolean
}

/** One model option offered for a provider. */
export interface ModelOption {
  id: string
  name: string
  description?: string
}

/** Why a provider offers no model options (KD-S2 empty case → guidance copy). */
export type ModelsEmptyReason =
  /** The resolved profile declares an (empty) `models` list — profile wins. */
  | 'profile-empty'
  /** No profile models; the catalog group exists but is empty. */
  | 'catalog-empty'
  /** No profile models; the catalog has no group for this provider. */
  | 'unavailable'

/** The user-layer draft the form edits (all six config keys). */
export interface AdvisorDraft {
  /** Master switch; default false. */
  enabled: boolean
  /** Provider route; required (non-empty) when enabled. */
  provider?: string
  /** Model id; required (non-empty) when enabled. */
  model?: string
  /** Optional system prompt override; '' = built-in reviewer prompt. */
  systemPrompt: string
  /** Cooldown after a delivered interrupt; integer ≥ 0, default 3. Cleared input → undefined (left unchanged on apply). */
  immuneTurns?: number
  /** Delta window; integer ≥ 0, default 60, 0 = unbounded. Cleared input → undefined (left unchanged on apply). */
  maxDeltaMessages?: number
}

/** Why an Apply failed (copy keys resolve in the section; raw text passes through). */
export type ApplyFailure =
  | { kind: 'gate'; reason: 'provider' | 'model' }
  | { kind: 'message'; message: string }

/** Apply lifecycle feedback the form renders. */
export type ApplyState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; failure: ApplyFailure }

/** Page snapshot. */
export interface AdvisorSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; write failures stay in the apply state. */
  error: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Configured provider options (KD-S2: configured providers only). */
  providers: readonly ProviderOption[]
  /** Model options per provider route, once resolved. */
  modelsByProvider: Readonly<Record<string, readonly ModelOption[]>>
  /** Empty-options reason per provider route (KD-S2 guidance). */
  modelsEmptyReason: Readonly<Record<string, ModelsEmptyReason>>
  /** Namespace views by ns, for the provider join. */
  namespaces: Readonly<Record<string, SettingsNamespaceView>>
  /**
   * Whether the `advisor.get` gateway endpoint was reachable on the last load
   * (KD-G3/G5): success = a writable form; failure (gateway not ready, no
   * settings service on the host) = the section shows the config-channel
   * notice instead of a writable-looking form and never offers Apply.
   */
  advisorPresent: boolean
  /** The form draft (seeded from the resolved config; never re-seeded by refreshes). */
  draft: AdvisorDraft
  /** Apply lifecycle feedback. */
  applyState: ApplyState
}

/** The schema-defaulted advisor config used when no config resolves. */
function defaultDraft(): AdvisorDraft {
  return { enabled: false, systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 }
}

/** A non-empty string field (whitespace-only reads as absent, mirroring the hard gate). */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** A bounded integer field (int ≥ 0) with a schema-default fallback. */
function numberField(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
}

/**
 * The draft a resolved gateway config resolves to. Absent keys (the wire
 * normalization omits provider/model/disabledReason) read as missing — the
 * seed never invents values the host does not pin.
 */
function draftOfConfig(config: AdvisorConfigView | undefined): AdvisorDraft {
  return {
    enabled: config?.enabled === true,
    provider: stringField(config?.provider),
    model: stringField(config?.model),
    systemPrompt: typeof config?.systemPrompt === 'string' ? config.systemPrompt : '',
    immuneTurns: numberField(config?.immuneTurns, 3),
    maxDeltaMessages: numberField(config?.maxDeltaMessages, 60),
  }
}

/** KD-S4 client-form gate: enabled requires a non-empty provider and model. */
function gateFailure(draft: AdvisorDraft): 'provider' | 'model' | undefined {
  if (!draft.enabled) return undefined
  if (draft.provider === undefined) return 'provider'
  if (draft.model === undefined) return 'model'
  return undefined
}

/** Profile-declared models (the provider's `models` directory), when the profile has one. */
function profileModels(profile: unknown): readonly ModelOption[] | undefined {
  const models = getPath(profile, ['models'])
  if (!Array.isArray(models)) return undefined
  return models.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return []
    const model = entry as { id?: unknown; name?: unknown; description?: unknown }
    if (typeof model.id !== 'string' || model.id.length === 0) return []
    return [{
      id: model.id,
      name: typeof model.name === 'string' ? model.name : model.id,
      ...typeof model.description === 'string' ? { description: model.description } : {},
    }]
  })
}

/**
 * The advisor settings page controller (one per settings surface).
 */
export class AdvisorSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<AdvisorSettingsState> = createSnapshotStore<AdvisorSettingsState>({
    status: 'idle',
    error: null,
    writable: false,
    providers: [],
    modelsByProvider: {},
    modelsEmptyReason: {},
    namespaces: {},
    advisorPresent: false,
    draft: defaultDraft(),
    applyState: { kind: 'idle' },
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /** Host-scoped model catalog; cached only on success (a transient failure stays uncached and is refetched). */
  private catalog: ModelProviderGroup[] | undefined

  /** In-flight host-scoped catalog fetch; one promise shared across providers. */
  private catalogPromise: Promise<void> | undefined

  /**
   * Bumped by every successful load(): an in-flight catalog fetch started
   * before a bump is stale (the models/changed invalidation that triggered
   * the reload happened mid-fetch) and caches nothing (qc1 W-1 / qc3 S-1).
   */
  private catalogGeneration = 0

  /** In-flight model resolutions (one per provider). */
  private inflightModels = new Set<string>()

  /** The draft is seeded once (first load); refreshes never clobber edits. */
  private draftSeeded = false

  /** The resolved advisor config at the last get/apply (patch diff baseline). */
  private seed: AdvisorDraft = defaultDraft()

  /**
   * @param api - the wire face (settings/llm domains) for the provider/model
   *   directory (the advisor namespace is NOT on that wire).
   * @param rpc - the connection's generic RPC caller for the host gateway
   *   channel (`/api`), injected from the connection handle.
   */
  constructor(
    private readonly api: Pick<IApiClient, 'settings' | 'llm'>,
    private readonly rpc: ClientConnectionRpc,
  ) {}

  /**
   * Refresh the whole page snapshot: the provider directory and the settings
   * namespaces in parallel, then the advisor config over the gateway channel,
   * then the provider join and the draft seed. A provider-directory failure
   * keeps the last good rows and surfaces the error; an `advisor.get` failure
   * is NOT a page error (KD-G5 — the section shows the config-channel notice,
   * the provider directory stays usable). The draft is seeded only on the
   * first load — pushed refreshes never discard in-progress edits (mirror the
   * ProviderEditor draft lifetime).
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ConfigurableProviderView[]
    let writable: boolean
    let views: SettingsNamespaceView[]
    try {
      const [providersResponse, settingsResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.api.settings.describe({}),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
      providers = providersResponse.result.value.providers
      writable = settingsResponse.result.value.writable
      views = settingsResponse.result.value.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    if (generation !== this.generation) return

    // The advisor config rides the gateway channel, NOT describe (the
    // namespace is off the apiproxy whitelist). A get failure — transport
    // down, gateway not ready, no settings service on the host — resolves to
    // advisorPresent=false (config-channel notice), never a hard load error.
    let config: AdvisorConfigView | undefined
    try {
      const getResult = await this.rpc.call('/api', 'advisor/get', { args: {} })
      if (getResult.ok) {
        config = (getResult.value as { config: AdvisorConfigView }).config
      }
    } catch {
      // Unreachable channel → same notice path (KD-G5 fallback).
    }
    if (generation !== this.generation) return

    const namespaces: Record<string, SettingsNamespaceView> = Object.fromEntries(
      views.map(view => [view.ns, view]),
    )
    const options: ProviderOption[] = []
    for (const entry of providers) {
      const namespace = namespaces[entry.settingsNs]
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || getPath(namespace.value, entry.settingsPath) !== undefined)
      if (!configured) continue
      options.push({
        provider: entry.provider,
        displayName: entry.displayName,
        settingsNs: entry.settingsNs,
        settingsPath: entry.settingsPath,
        configured,
      })
    }
    this.seed = draftOfConfig(config)
    if (!this.draftSeeded) {
      this.store.update((s) => { s.draft = this.seed })
      this.draftSeeded = true
    }
    // Invalidation refresh (qc1 W-1 / qc3 S-1): a pushed settings/changed or
    // models/changed must re-resolve model options from the fresh directory —
    // the per-provider model caches and the host-scoped catalog are
    // store-lifetime otherwise, and `ensureModels` early-returns once a
    // provider has resolved. The catalog-level in-flight guard + success-only
    // failure caching stay; the end-of-load `ensureModels(selected)` below
    // then re-resolves the stored provider's options on every invalidation
    // without clobbering in-progress draft edits (the draft is seeded once).
    this.catalogGeneration += 1
    this.catalog = undefined
    this.catalogPromise = undefined
    this.inflightModels.clear()
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.writable = writable
      s.providers = options
      s.namespaces = namespaces
      s.advisorPresent = config !== undefined
      s.modelsByProvider = {}
      s.modelsEmptyReason = {}
    })
    // Model options for the provider already selected by the stored config,
    // so a freshly opened form shows the options without interaction.
    const selected = this.seed.provider
    if (selected !== undefined && options.some(option => option.provider === selected)) {
      void this.ensureModels(selected)
    }
  }

  /**
   * Resolve the model options for one provider (KD-S2): profile-declared
   * `models` win; otherwise the `llm.models` catalog group for that provider;
   * neither → empty options + a reason. The host-scoped catalog is fetched at
   * most once (concurrent first resolutions share one in-flight fetch) and
   * cached only on success. No-op for unconfigured providers.
   * @param provider - provider route id.
   * @returns nothing; the snapshot carries the outcome.
   */
  async ensureModels(provider: string): Promise<void> {
    if (this.inflightModels.has(provider)) return
    const state = this.store.getSnapshot()
    if (Object.hasOwn(state.modelsByProvider, provider) || Object.hasOwn(state.modelsEmptyReason, provider)) return
    const option = state.providers.find(candidate => candidate.provider === provider)
    if (option === undefined) return // not a configured provider — nothing to offer
    const namespace = state.namespaces[option.settingsNs]
    const profile = namespace !== undefined ? getPath(namespace.value, option.settingsPath) : undefined
    const declared = profileModels(profile)
    if (declared !== undefined) {
      this.store.update((s) => {
        if (declared.length > 0) {
          s.modelsByProvider = { ...s.modelsByProvider, [provider]: declared }
        } else {
          s.modelsEmptyReason = { ...s.modelsEmptyReason, [provider]: 'profile-empty' }
        }
      })
      return
    }
    this.inflightModels.add(provider)
    try {
      // Resolve from the catalog, re-looping when a load() invalidated the
      // catalog mid-flight (qc1 W-1 / qc3 S-1): a fetch started before the
      // invalidation is stale and must not cache stale/empty data — the
      // generation check below detects it and starts a fresh fetch.
      let group: ModelProviderGroup | undefined
      for (;;) {
        if (this.catalog === undefined) {
          // One shared in-flight fetch: concurrent first resolutions for
          // different providers must not double-call llm.models.
          if (this.catalogPromise === undefined) {
            const fetch = this.fetchCatalog()
            const tracked = fetch.finally(() => {
              // Only the owner clears the slot: a load() may have replaced
              // the promise (invalidation during a fetch), and the stale
              // finally must not clobber the newer one.
              if (this.catalogPromise === tracked) this.catalogPromise = undefined
            })
            this.catalogPromise = tracked
          }
          const generation = this.catalogGeneration
          await this.catalogPromise
          if (generation !== this.catalogGeneration) continue // stale mid-flight → refetch fresh
        }
        group = this.catalog?.find(candidate => candidate.id === provider)
        break
      }
      const options = group?.models ?? []
      this.store.update((s) => {
        if (options.length > 0) {
          s.modelsByProvider = { ...s.modelsByProvider, [provider]: options }
        } else {
          const reason: ModelsEmptyReason = group === undefined ? 'unavailable' : 'catalog-empty'
          s.modelsEmptyReason = { ...s.modelsEmptyReason, [provider]: reason }
        }
      })
    } finally {
      this.inflightModels.delete(provider)
    }
  }

  /**
   * Fetch the host-scoped model catalog. A failure (wire rejection or throw)
   * leaves the cache empty so the next resolution refetches — a transient
   * failure is never sticky for the store lifetime. A fetch started before a
   * load() bumped `catalogGeneration` is stale (the invalidation that caused
   * the reload happened mid-fetch) and caches nothing.
   */
  private async fetchCatalog(): Promise<void> {
    const generation = this.catalogGeneration
    try {
      const response = await this.api.llm.models({})
      if (generation !== this.catalogGeneration) return
      this.catalog = response.result.ok ? response.result.value.groups : undefined
    } catch {
      if (generation === this.catalogGeneration) this.catalog = undefined
    }
  }

  /** Set the enabled switch (gate fields become required while on). */
  setEnabled(enabled: boolean): void {
    this.setField('enabled', enabled)
  }

  /** Set or clear the provider ('' clears); switches invalidate the chosen model. */
  setProvider(provider: string): void {
    const trimmed = provider.trim()
    this.store.update((s) => {
      const draft = s.draft as unknown as Record<string, unknown>
      const withoutProvider = trimmed.length === 0
        ? deletePath(draft, ['provider'])
        : setPath(draft, ['provider'], trimmed)
      // A provider switch invalidates the previously chosen model.
      s.draft = deletePath(withoutProvider, ['model']) as unknown as AdvisorDraft
      s.applyState = { kind: 'idle' }
    })
    if (trimmed.length > 0) void this.ensureModels(trimmed)
  }

  /** Set or clear the model ('' clears). */
  setModel(model: string): void {
    const trimmed = model.trim()
    if (trimmed.length === 0) this.clearField('model')
    else this.setField('model', trimmed)
  }

  /** Set the system prompt override. */
  setSystemPrompt(prompt: string): void {
    this.setField('systemPrompt', prompt)
  }

  /** Set the immune-turns cooldown (int ≥ 0; non-numeric input keeps the current value; undefined clears → omitted from patch). */
  setImmuneTurns(value: number | undefined): void {
    if (value === undefined) {
      this.clearField('immuneTurns')
      return
    }
    this.setField('immuneTurns', this.clampInt(value, this.store.getSnapshot().draft.immuneTurns ?? 0))
  }

  /** Set the delta-message window (int ≥ 0; non-numeric input keeps the current value; undefined clears → omitted from patch). */
  setMaxDeltaMessages(value: number | undefined): void {
    if (value === undefined) {
      this.clearField('maxDeltaMessages')
      return
    }
    this.setField('maxDeltaMessages', this.clampInt(value, this.store.getSnapshot().draft.maxDeltaMessages ?? 0))
  }

  /** Cancel: re-seed the draft from the latest resolved config and clear feedback. */
  resetDraft(): void {
    this.store.update((s) => {
      s.draft = this.seed
      s.applyState = { kind: 'idle' }
    })
  }

  /**
   * Validate the draft (KD-S4 gate), then write the changed keys as a config
   * patch through the gateway channel (`/api/advisor/set`). Any failure
   * (business rejection or transport) surfaces the message failure and keeps
   * the form for retry — the gateway merge has no revision guard, so the old
   * settings-conflict branch is replaced by plain error handling (KD-G3).
   * Nothing to write → the apply reports saved without a call.
   * @returns nothing; the apply state carries the outcome.
   */
  async apply(): Promise<void> {
    const state = this.store.getSnapshot()
    const gate = gateFailure(state.draft)
    if (gate !== undefined) {
      this.store.update((s) => {
        s.applyState = { kind: 'error', failure: { kind: 'gate', reason: gate } }
      })
      return
    }
    const patch = this.patchFor(state.draft)
    if (Object.keys(patch).length === 0) {
      this.store.update((s) => { s.applyState = { kind: 'saved' } })
      return
    }
    this.store.update((s) => { s.applyState = { kind: 'saving' } })
    try {
      const result = await this.rpc.call('/api', 'advisor/set', { args: { patch } })
      if (!result.ok) {
        this.store.update((s) => {
          s.applyState = { kind: 'error', failure: { kind: 'message', message: result.error.message } }
        })
        return
      }
      // The write landed: adopt the returned composed config as the new seed
      // so a follow-up apply diff-cleans against the fresh value even if the
      // reload below fails.
      this.seed = draftOfConfig((result.value as { config: AdvisorConfigView }).config)
      // qc3 N-1: the saved feedback is set BEFORE the reload — a reload
      // failure (status 'error') must not mask the landed write; the section
      // renders the saved line alongside the error+retry view.
      this.store.update((s) => { s.applyState = { kind: 'saved' } })
      await this.load()
    } catch (error) {
      this.store.update((s) => {
        s.applyState = {
          kind: 'error',
          failure: { kind: 'message', message: error instanceof Error ? error.message : String(error) },
        }
      })
    }
  }

  /**
   * The minimal config patch making the effective config match the draft —
   * only keys whose value differs from the last-read seed are sent, so a
   * stale read never clobbers concurrent changes to untouched keys and base
   * (plugin-row) values stay in place. A cleared provider/model the seed pins
   * becomes an explicit `''` override (the gateway merge cannot express an
   * unset, and the resolver treats '' as absent); a cleared number field is
   * omitted (the stored value stays unchanged).
   */
  private patchFor(draft: AdvisorDraft): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    const always = ['enabled', 'systemPrompt', 'immuneTurns', 'maxDeltaMessages'] as const
    for (const key of always) {
      const next = draft[key]
      // A cleared number input (undefined) means "leave the stored value
      // unchanged": omit the key from the patch instead of writing 0.
      if (next === undefined) continue
      if (JSON.stringify(this.seed[key]) !== JSON.stringify(next)) {
        patch[key] = next
      }
    }
    for (const key of ['provider', 'model'] as const) {
      const next = draft[key]
      if (next !== undefined) {
        if (JSON.stringify(this.seed[key]) !== JSON.stringify(next)) {
          patch[key] = next
        }
      } else if (this.seed[key] !== undefined) {
        // The resolved seed pins the value (composition base and/or user
        // layer): the gateway merge has no unset, so the explicit empty-string
        // override is the reliable clear — the host resolver treats '' as
        // absent and the next get omits the key, keeping the clear stable
        // across later applies.
        patch[key] = ''
      }
      // else: nothing resolves the key → nothing stored, no op.
    }
    return patch
  }

  /** Edit one always-present draft field via the schema-form path writer. */
  private setField(key: string, value: unknown): void {
    this.store.update((s) => {
      s.draft = setPath(s.draft as unknown as Record<string, unknown>, [key], value) as unknown as AdvisorDraft
      s.applyState = { kind: 'idle' }
    })
  }

  /** Remove one optional draft field via the schema-form path writer. */
  private clearField(key: string): void {
    this.store.update((s) => {
      s.draft = deletePath(s.draft as unknown as Record<string, unknown>, [key]) as unknown as AdvisorDraft
      s.applyState = { kind: 'idle' }
    })
  }

  private clampInt(value: number, fallback: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
  }
}

/**
 * Refetch the page snapshot only after its first load: an unopened Advisor
 * page must not fetch on background invalidations.
 * @param controller - the page store.
 */
export function refreshIfLoaded(controller: AdvisorSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}
