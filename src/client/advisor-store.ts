/**
 * Advisor settings page store (plan dsh-advisor-settings-n2, task 3). One
 * snapshot over the wire faces the section renders from; the host stays the
 * single fact source — every mutation writes through the wire (`settings.mutate`
 * path ops with `expectedRevision`) and the page re-renders from the next
 * describe, pushed or refetched.
 *
 * The join mirrors the ui-models Models page (store.ts):
 * - **configured** provider = its settings namespace resolves AND its profile
 *   resolves (`settingsPath` empty → whole section, else `getPath` on the
 *   namespace value);
 * - **model options** = the provider profile's declared `models` first
 *   (KD-S2), else the `llm.models` catalog group for that provider, else
 *   empty options + a reason (guidance copy lives in the section);
 * - the **draft** is seeded from the RESOLVED advisor config (schema defaults
 *   → composition base → user layer) so the form always shows the effective
 *   configuration; Apply writes only the changed keys as set/unset path ops
 *   against the STORED user section (the ProviderEditor pathOps pattern), with
 *   `expectedRevision` from the last describe guarding against stale writes.
 *   Clearing a provider/model whose value the resolved seed pins (composition
 *   base, user layer, or both) stores an explicit `''` override — an `unset`
 *   would merely restore the pinned value, and an already-stored `''` override
 *   is left untouched so the clear stays stable across later applies. Clearing
 *   a number input (immuneTurns/maxDeltaMessages) leaves the field empty and
 *   omits the key from the ops: the stored value stays unchanged.
 */

import type {
  ConfigurableProviderView, IApiClient, ModelProviderGroup, SettingsNamespaceView,
  SettingsPathOpView,
} from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { deletePath, getPath, hasPath, setPath } from '@deepseek-ai/dsh-client-schema-form'

/**
 * The advisor settings namespace this form edits (mirror of the host-side
 * `settingsNamespace('advisor')` in src/settings.ts — kept as a local string
 * constant because the client bundle may not value-import the node-side
 * module or `@deepseek-ai/dsh-settings`).
 */
export const ADVISOR_NAMESPACE = 'advisor'

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
  | { kind: 'conflict' }
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
  modelsByProvider: ReadonlyMap<string, readonly ModelOption[]>
  /** Empty-options reason per provider route (KD-S2 guidance). */
  modelsEmptyReason: ReadonlyMap<string, ModelsEmptyReason>
  /** Namespace views by ns, for the provider join. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /** The advisor namespace view, when registered. */
  advisorView: SettingsNamespaceView | undefined
  /** The form draft (seeded from the resolved config; never re-seeded by refreshes). */
  draft: AdvisorDraft
  /** Apply lifecycle feedback. */
  applyState: ApplyState
}

/** The schema-defaulted advisor config used when no namespace/view resolves. */
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

/** The draft a namespace view resolves to (defaults → base → user layer). */
function draftOf(view: SettingsNamespaceView | undefined): AdvisorDraft {
  const value = view?.value
  const prompt = getPath(value, ['systemPrompt'])
  return {
    enabled: getPath(value, ['enabled']) === true,
    provider: stringField(getPath(value, ['provider'])),
    model: stringField(getPath(value, ['model'])),
    systemPrompt: typeof prompt === 'string' ? prompt : '',
    immuneTurns: numberField(getPath(value, ['immuneTurns']), 3),
    maxDeltaMessages: numberField(getPath(value, ['maxDeltaMessages']), 60),
  }
}

/** The stored user section as a plain record (absent → empty). */
function userOf(view: SettingsNamespaceView | undefined): Record<string, unknown> {
  const user = view?.user
  return typeof user === 'object' && user !== null && !Array.isArray(user)
    ? user as Record<string, unknown>
    : {}
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
    modelsByProvider: new Map(),
    modelsEmptyReason: new Map(),
    namespaces: new Map(),
    advisorView: undefined,
    draft: defaultDraft(),
    applyState: { kind: 'idle' },
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /** Host-scoped model catalog; cached only on success (a transient failure stays uncached and is refetched). */
  private catalog: ModelProviderGroup[] | undefined

  /** In-flight host-scoped catalog fetch; one promise shared across providers. */
  private catalogPromise: Promise<void> | undefined

  /** In-flight model resolutions (one per provider). */
  private inflightModels = new Set<string>()

  /** The draft is seeded once (first load); refreshes never clobber edits. */
  private draftSeeded = false

  /** `expectedRevision` for the next mutate, from the last describe/apply. */
  private expectedRevision = 0

  /** The stored user section at the last describe/apply (ops diff baseline). */
  private lastUser: Record<string, unknown> = {}

  /** The resolved advisor config at the last describe/apply (cleared-base detection). */
  private seed: AdvisorDraft = defaultDraft()

  /**
   * @param api - the wire face (settings/llm domains).
   */
  constructor(private readonly api: Pick<IApiClient, 'settings' | 'llm'>) {}

  /**
   * Refresh the whole page snapshot: the provider directory and the settings
   * namespaces in parallel, then the provider join and the draft seed. A
   * failure keeps the last good rows and surfaces the error. The draft is
   * seeded only on the first load — pushed refreshes never discard in-progress
   * edits (mirror the ProviderEditor draft lifetime).
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

    const namespaces = new Map(views.map(view => [view.ns, view]))
    const advisorView = namespaces.get(ADVISOR_NAMESPACE)
    const options: ProviderOption[] = []
    for (const entry of providers) {
      const namespace = namespaces.get(entry.settingsNs)
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
    this.expectedRevision = advisorView?.revision ?? 0
    this.lastUser = userOf(advisorView)
    this.seed = draftOf(advisorView)
    if (!this.draftSeeded) {
      this.store.update((s) => { s.draft = this.seed })
      this.draftSeeded = true
    }
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.writable = writable
      s.providers = options
      s.namespaces = namespaces
      s.advisorView = advisorView
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
    if (state.modelsByProvider.has(provider) || state.modelsEmptyReason.has(provider)) return
    const option = state.providers.find(candidate => candidate.provider === provider)
    if (option === undefined) return // not a configured provider — nothing to offer
    const namespace = state.namespaces.get(option.settingsNs)
    const profile = namespace !== undefined ? getPath(namespace.value, option.settingsPath) : undefined
    const declared = profileModels(profile)
    if (declared !== undefined) {
      this.store.update((s) => {
        if (declared.length > 0) {
          s.modelsByProvider = new Map(s.modelsByProvider).set(provider, declared)
        } else {
          s.modelsEmptyReason = new Map(s.modelsEmptyReason).set(provider, 'profile-empty')
        }
      })
      return
    }
    this.inflightModels.add(provider)
    try {
      if (this.catalog === undefined) {
        // One shared in-flight fetch: concurrent first resolutions for
        // different providers must not double-call llm.models.
        if (this.catalogPromise === undefined) {
          this.catalogPromise = this.fetchCatalog().finally(() => { this.catalogPromise = undefined })
        }
        await this.catalogPromise
      }
      const group = this.catalog?.find(candidate => candidate.id === provider)
      const options = group?.models ?? []
      this.store.update((s) => {
        if (options.length > 0) {
          s.modelsByProvider = new Map(s.modelsByProvider).set(provider, options)
        } else {
          const reason: ModelsEmptyReason = group === undefined ? 'unavailable' : 'catalog-empty'
          s.modelsEmptyReason = new Map(s.modelsEmptyReason).set(provider, reason)
        }
      })
    } finally {
      this.inflightModels.delete(provider)
    }
  }

  /**
   * Fetch the host-scoped model catalog. A failure (wire rejection or throw)
   * leaves the cache empty so the next resolution refetches — a transient
   * failure is never sticky for the store lifetime.
   */
  private async fetchCatalog(): Promise<void> {
    try {
      const response = await this.api.llm.models({})
      this.catalog = response.result.ok ? response.result.value.groups : undefined
    } catch {
      this.catalog = undefined
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

  /** Set the immune-turns cooldown (int ≥ 0; non-numeric input keeps the current value; undefined clears → omitted from ops). */
  setImmuneTurns(value: number | undefined): void {
    if (value === undefined) {
      this.clearField('immuneTurns')
      return
    }
    this.setField('immuneTurns', this.clampInt(value, this.store.getSnapshot().draft.immuneTurns ?? 0))
  }

  /** Set the delta-message window (int ≥ 0; non-numeric input keeps the current value; undefined clears → omitted from ops). */
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
   * Validate the draft (KD-S4 gate), then write the changed keys as path ops
   * through `settings.mutate` with `expectedRevision` from the last describe.
   * A `settings-conflict` result surfaces the conflict failure and re-syncs
   * (reload) so the user can review and re-apply; any other failure keeps the
   * form for retry. Nothing to write → the apply reports saved without a call.
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
    const ops = this.opsFor(state.draft)
    if (ops.length === 0) {
      this.store.update((s) => { s.applyState = { kind: 'saved' } })
      return
    }
    this.store.update((s) => { s.applyState = { kind: 'saving' } })
    try {
      const response = await this.api.settings.mutate({
        ns: ADVISOR_NAMESPACE,
        ops,
        expectedRevision: this.expectedRevision,
      })
      if (!response.result.ok) {
        const error = response.result.error
        if (error.code === 'settings-conflict') {
          this.store.update((s) => {
            s.applyState = { kind: 'error', failure: { kind: 'conflict' } }
          })
          await this.load() // re-sync the revision and view for a retry
          return
        }
        this.store.update((s) => {
          s.applyState = { kind: 'error', failure: { kind: 'message', message: error.message } }
        })
        return
      }
      // The write landed: adopt the returned view's revision/user/seed so a
      // follow-up apply diff-cleans and carries the fresh revision even if the
      // reload below fails.
      this.expectedRevision = response.result.value.revision
      this.lastUser = userOf(response.result.value)
      this.seed = draftOf(response.result.value)
      await this.load()
      this.store.update((s) => { s.applyState = { kind: 'saved' } })
    } catch (error) {
      this.store.update((s) => {
        s.applyState = {
          kind: 'error',
          failure: { kind: 'message', message: error instanceof Error ? error.message : String(error) },
        }
      })
    }
  }

  /** The minimal set/unset ops making the stored user section match the draft. */
  private opsFor(draft: AdvisorDraft): SettingsPathOpView[] {
    const ops: SettingsPathOpView[] = []
    const always = ['enabled', 'systemPrompt', 'immuneTurns', 'maxDeltaMessages'] as const
    for (const key of always) {
      const stored = this.lastUser[key]
      const next = draft[key]
      // A cleared number input (undefined) means "leave the stored value
      // unchanged": omit the key from the ops instead of writing 0.
      if (next === undefined) continue
      if (JSON.stringify(stored) !== JSON.stringify(next)) {
        ops.push({ op: 'set', path: [key], value: next })
      }
    }
    for (const key of ['provider', 'model'] as const) {
      const next = draft[key]
      if (next !== undefined) {
        const stored = this.lastUser[key]
        if (JSON.stringify(stored) !== JSON.stringify(next)) {
          ops.push({ op: 'set', path: [key], value: next })
        }
      } else if (this.lastUser[key] === '') {
        // The explicit '' override from a previous clear is already stored:
        // leave it untouched. An `unset` here would restore the pinned value
        // and the clear would oscillate on the next apply.
      } else if (this.seed[key] !== undefined) {
        // The resolved seed pins the value (composition base and/or user
        // layer): an `unset` may only remove the user layer and restore the
        // base, so the explicit empty-string override is the reliable clear.
        ops.push({ op: 'set', path: [key], value: '' })
      } else if (hasPath(this.lastUser, [key])) {
        // Nothing resolves the key, yet the user layer holds a value the
        // resolved view does not pin (e.g. dropped by the host projection):
        // an `unset` removes it for good.
        ops.push({ op: 'unset', path: [key] })
      }
    }
    return ops
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
