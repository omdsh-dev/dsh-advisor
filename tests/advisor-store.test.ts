/**
 * Advisor settings store (plan dsh-advisor-settings-n2, task 3) — store unit
 * tests over a scripted wire face (fake `settings`/`llm` api mirroring the
 * dsh-client-connection stub shapes).
 *
 * Contract under test (brief Step 1):
 * ① providers join: a provider whose profile resolves (namespace exists +
 *    profile path resolves) enters the option list; an unconfigured one
 *    (missing profile or missing namespace) does not.
 * ② model options: profile-declared `models` win; else the `llm.models`
 *    catalog group for that provider; neither → empty options + a reason.
 * ③ Apply gate (KD-S4): enabled + missing provider/model → blocked with the
 *    gate failure; disabled → provider/model may be empty and the apply lands.
 * ④ mutate ops: set/unset paths against the stored user section and
 *    `expectedRevision` from the last describe; a `settings-conflict` result
 *    surfaces the conflict failure and re-syncs.
 * ⑤ invalidations: `refreshIfLoaded` refetches a loaded store and skips an
 *    idle (never-loaded) one.
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  ConfigurableProviderView, IApiClient, ModelProviderGroup, RpcResponse,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-client-connection/client'
import { AdvisorSettingsStore, refreshIfLoaded } from '../src/client/advisor-store'
import type { AdvisorDraft } from '../src/client/advisor-store'

/** One unary wire response. */
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: 'r' as never, result: { ok: true, value } }
}

/** One unary wire failure (default code: a plain settings rejection). */
function fail<T>(message: string, code: 'settings-rejected' | 'settings-conflict' = 'settings-rejected'): RpcResponse<T> {
  return { rpcId: 'r' as never, result: { ok: false, error: { code, message, details: {} } } }
}

const DEEPSEEK: ConfigurableProviderView = {
  provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true,
}
const OPENAI: ConfigurableProviderView = {
  provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true,
}
/** Profile path resolves to nothing in its namespace → not configured. */
const ZOMBIE: ConfigurableProviderView = {
  provider: 'zombie', displayName: 'zombie', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zombie'], active: false,
}
/** Whole-section provider whose settings namespace does not exist → not configured. */
const ORPHAN: ConfigurableProviderView = {
  provider: 'orphan', displayName: 'orphan', settingsNs: 'llm-orphan', settingsPath: [], active: true,
}
/** Whole-section provider whose section resolves but declares no models anywhere. */
const EMPTY: ConfigurableProviderView = {
  provider: 'empty', displayName: 'empty', settingsNs: 'llm-empty', settingsPath: [], active: true,
}
/** Whole-section provider whose profile declares an EMPTY models list. */
const EMPTYLIST: ConfigurableProviderView = {
  provider: 'emptylist', displayName: 'emptylist', settingsNs: 'llm-emptylist', settingsPath: [], active: true,
}

/** llm-deepseek: whole-section profile declaring a models catalog (schema default). */
function deepseekNs(): SettingsNamespaceView {
  return {
    ns: 'llm-deepseek',
    schema: {},
    value: {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [
        { id: 'ds-a', name: 'DeepSeek A' },
        { id: 'ds-b', name: 'DeepSeek B' },
      ],
    },
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

/** llm-pi-ai: dict-of-profiles; openai resolves, zombie does not. */
function piAiNs(): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

/** llm-empty: whole-section profile resolving to an empty section (no models anywhere). */
function emptyNs(): SettingsNamespaceView {
  return { ns: 'llm-empty', schema: {}, value: {}, applies: 'live', secrets: [], revision: 0 }
}

/** llm-emptylist: whole-section profile declaring an EMPTY models list (profile wins, no fallback). */
function emptylistNs(): SettingsNamespaceView {
  return { ns: 'llm-emptylist', schema: {}, value: { models: [] }, applies: 'live', secrets: [], revision: 0 }
}

/** The advisor namespace view; user layer is optional (absent = no user section). */
function advisorView(overrides: {
  user?: Record<string, unknown>
  base?: Record<string, unknown>
  value?: Record<string, unknown>
  revision?: number
} = {}): SettingsNamespaceView {
  const user = overrides.user
  const value = overrides.value ?? {
    ...(user !== undefined ? { ...user } : {}),
    enabled: user?.enabled ?? false,
    systemPrompt: user?.systemPrompt ?? '',
    immuneTurns: user?.immuneTurns ?? 3,
    maxDeltaMessages: user?.maxDeltaMessages ?? 60,
  }
  return {
    ns: 'advisor',
    schema: {},
    value,
    ...(overrides.base !== undefined ? { base: overrides.base } : {}),
    ...(user !== undefined ? { user } : {}),
    applies: 'live',
    secrets: [],
    revision: overrides.revision ?? 0,
  }
}

const CATALOG: ModelProviderGroup[] = [
  { id: 'openai', name: 'openai', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
  { id: 'empty', name: 'empty', models: [] },
]

/** A scripted wire face whose advisor user section mutates with each mutate. */
interface Scripted {
  api: Pick<IApiClient, 'settings' | 'llm'>
  describe: ReturnType<typeof vi.fn>
  mutate: ReturnType<typeof vi.fn>
  providers: ReturnType<typeof vi.fn>
  models: ReturnType<typeof vi.fn>
}

function scriptedApi(options: {
  advisor: SettingsNamespaceView
  namespaces?: SettingsNamespaceView[]
  entries?: ConfigurableProviderView[]
  groups?: ModelProviderGroup[]
  writable?: boolean
}): Scripted {
  const others = options.namespaces ?? [deepseekNs(), piAiNs()]
  const entries = options.entries ?? [DEEPSEEK, OPENAI, ZOMBIE, ORPHAN, EMPTY, EMPTYLIST]
  let currentAdvisor = options.advisor
  const describe = vi.fn(() => Promise.resolve(ok({
    writable: options.writable ?? true,
    hasDocument: false,
    namespaces: [...others, currentAdvisor],
  })))
  const providers = vi.fn(() => Promise.resolve(ok({ providers: entries })))
  const models = vi.fn(() => Promise.resolve(ok({ groups: options.groups ?? CATALOG, failures: [] })))
  const mutate = vi.fn((payload: { ns: string; ops: SettingsPathOpView[]; expectedRevision?: number }) => {
    const user: Record<string, unknown> = { ...(currentAdvisor.user as Record<string, unknown> | undefined) }
    for (const op of payload.ops) {
      if (op.op === 'set') user[op.path[0]] = op.value
      else delete user[op.path[0]]
    }
    const next: SettingsNamespaceView = {
      ...currentAdvisor,
      user,
      value: { ...currentAdvisor.value as Record<string, unknown>, ...user },
      revision: currentAdvisor.revision + 1,
    }
    currentAdvisor = next
    return Promise.resolve(ok(next))
  })
  return {
    api: {
      settings: { describe, update: vi.fn(), replace: vi.fn(), mutate },
      llm: { providers, models, discoverModels: vi.fn() },
    } as unknown as Pick<IApiClient, 'settings' | 'llm'>,
    describe, mutate, providers, models,
  }
}

function draftOf(store: AdvisorSettingsStore): AdvisorDraft {
  return store.store.getSnapshot().draft
}

describe('providers join (KD-S2 configured determination)', () => {
  it('lists only providers whose profile resolves; excludes missing profiles and missing namespaces', async () => {
    const { api } = scriptedApi({ advisor: advisorView() })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    const { providers: options } = store.store.getSnapshot()
    const routes = options.map(option => option.provider)
    expect(routes).toEqual(['deepseek-official', 'openai'])
    expect(routes).not.toContain('zombie') // profile does not resolve
    expect(routes).not.toContain('orphan') // namespace missing
    expect(options[0]?.configured).toBe(true)
    expect(options[0]?.settingsNs).toBe('llm-deepseek')
  })

  it('seeds the draft from the resolved advisor config on first load', async () => {
    const { api } = scriptedApi({
      advisor: advisorView({
        user: { enabled: true, provider: 'deepseek-official', model: 'ds-a' },
        revision: 3,
      }),
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    expect(draftOf(store)).toEqual({
      enabled: true,
      provider: 'deepseek-official',
      model: 'ds-a',
      systemPrompt: '',
      immuneTurns: 3,
      maxDeltaMessages: 60,
    })
  })

  it('seeds the draft from the composition base when the user layer is absent', async () => {
    // The plugin-row config is the namespace base; without a user section the
    // form must still show the effective (base) values so the toggle is not
    // off while the advisor is actually running.
    const { api } = scriptedApi({
      advisor: advisorView({
        base: { enabled: true, provider: 'deepseek-official', model: 'ds-a' },
        value: {
          enabled: true, provider: 'deepseek-official', model: 'ds-a',
          systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60,
        },
      }),
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    expect(draftOf(store).enabled).toBe(true)
    expect(draftOf(store).provider).toBe('deepseek-official')
    expect(draftOf(store).model).toBe('ds-a')
  })
})

describe('model options (KD-S2 profile-first, catalog fallback)', () => {
  it('uses the provider profile models and never calls the catalog', async () => {
    const { api, models } = scriptedApi({ advisor: advisorView() })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    await store.ensureModels('deepseek-official')
    const { modelsByProvider } = store.store.getSnapshot()
    expect(modelsByProvider.get('deepseek-official')?.map(model => model.id)).toEqual(['ds-a', 'ds-b'])
    expect(models).not.toHaveBeenCalled()
  })

  it('falls back to the llm.models catalog group when the profile declares none', async () => {
    const { api, models } = scriptedApi({ advisor: advisorView() })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    await store.ensureModels('openai')
    const { modelsByProvider } = store.store.getSnapshot()
    expect(modelsByProvider.get('openai')?.map(model => model.id)).toEqual(['gpt-4o'])
    expect(models).toHaveBeenCalledTimes(1)
  })

  it('caches the catalog: a second provider needs no second llm.models call', async () => {
    const { api, models } = scriptedApi({
      advisor: advisorView(),
      namespaces: [piAiNs(), emptyNs()],
      entries: [OPENAI, EMPTY],
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    await store.ensureModels('openai')
    await store.ensureModels('empty')
    expect(models).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight catalog fetch across concurrent providers', async () => {
    type CatalogPayload = { groups: ModelProviderGroup[]; failures: unknown[] }
    let deferredResolve!: (value: RpcResponse<CatalogPayload>) => void
    const deferred = new Promise<RpcResponse<CatalogPayload>>((resolve) => {
      deferredResolve = resolve
    })
    const { api, models } = scriptedApi({
      advisor: advisorView(),
      namespaces: [piAiNs(), emptyNs()],
      entries: [OPENAI, EMPTY],
    })
    models.mockReturnValueOnce(deferred)
    const store = new AdvisorSettingsStore(api)
    await store.load()
    const first = store.ensureModels('openai')
    const second = store.ensureModels('empty')
    deferredResolve(ok({ groups: CATALOG, failures: [] }))
    await Promise.all([first, second])
    expect(models).toHaveBeenCalledTimes(1)
    expect(store.store.getSnapshot().modelsByProvider.get('openai')?.map(model => model.id)).toEqual(['gpt-4o'])
  })

  it('does not cache a transient catalog failure: a later provider refetches', async () => {
    const { api, models } = scriptedApi({
      advisor: advisorView(),
      namespaces: [piAiNs(), emptyNs()],
      entries: [OPENAI, EMPTY],
    })
    models.mockReturnValueOnce(Promise.resolve(fail('catalog down')))
    const store = new AdvisorSettingsStore(api)
    await store.load()
    // First resolution hits a failing catalog fetch: the provider gets the
    // empty-options reason, but the failure is NOT cached at catalog level.
    await store.ensureModels('openai')
    expect(store.store.getSnapshot().modelsEmptyReason.get('openai')).toBe('unavailable')
    // The next provider's resolution refetches and sees the recovered catalog.
    await store.ensureModels('empty')
    expect(models).toHaveBeenCalledTimes(2)
    expect(store.store.getSnapshot().modelsEmptyReason.get('empty')).toBe('catalog-empty')
  })

  it('marks empty options with a reason when neither source has models', async () => {
    const { api } = scriptedApi({
      advisor: advisorView(),
      namespaces: [deepseekNs(), piAiNs(), emptyNs(), emptylistNs()],
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    await store.ensureModels('empty')     // profile has no models field; catalog group empty
    await store.ensureModels('emptylist') // profile declares an empty models list (profile wins)
    await store.ensureModels('zombie')    // not configured — nothing offered
    const { modelsByProvider, modelsEmptyReason } = store.store.getSnapshot()
    expect(modelsByProvider.get('empty') ?? []).toEqual([])
    expect(modelsEmptyReason.get('empty')).toBe('catalog-empty')
    expect(modelsByProvider.get('emptylist') ?? []).toEqual([])
    expect(modelsEmptyReason.get('emptylist')).toBe('profile-empty')
    expect(modelsByProvider.has('zombie')).toBe(false)
    expect(modelsEmptyReason.has('zombie')).toBe(false)
  })
})

describe('apply gate (KD-S4 required-when-enabled)', () => {
  it('blocks Apply when enabled with no provider, naming the gate failure', async () => {
    const { api, mutate } = scriptedApi({ advisor: advisorView() })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setEnabled(true)
    await store.apply()
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error') {
      expect(applyState.failure.kind).toBe('gate')
      if (applyState.failure.kind === 'gate') expect(applyState.failure.reason).toBe('provider')
    }
    expect(mutate).not.toHaveBeenCalled()
  })

  it('blocks Apply when enabled with a provider but no model', async () => {
    const { api, mutate } = scriptedApi({ advisor: advisorView() })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setEnabled(true)
    store.setProvider('deepseek-official')
    await store.apply()
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error' && applyState.failure.kind === 'gate') {
      expect(applyState.failure.reason).toBe('model')
    }
    expect(mutate).not.toHaveBeenCalled()
  })

  it('allows empty provider/model while disabled and lands the apply', async () => {
    const { api, mutate } = scriptedApi({ advisor: advisorView() })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setImmuneTurns(5)
    await store.apply()
    expect(mutate).toHaveBeenCalledTimes(1)
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('saved')
  })
})

describe('apply ops + expectedRevision (mutate path ops)', () => {
  it('writes only the changed keys as set/unset path ops with the describe revision', async () => {
    const { api, mutate } = scriptedApi({
      advisor: advisorView({
        user: {
          enabled: true, provider: 'deepseek-official', model: 'ds-a',
          systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60,
        },
        revision: 7,
      }),
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setModel('ds-b')
    await store.apply()
    expect(mutate).toHaveBeenCalledWith({
      ns: 'advisor',
      ops: [{ op: 'set', path: ['model'], value: 'ds-b' }],
      expectedRevision: 7,
    })
  })

  it('overrides a stored (user-pinned) provider/model with explicit empty values when cleared', async () => {
    // The seed pins the values through the user layer; the explicit '' override
    // is used instead of an `unset` so the clear stays stable regardless of
    // what the composition base pins underneath.
    const { api, mutate } = scriptedApi({
      advisor: advisorView({
        user: { enabled: true, provider: 'x', model: 'y' },
        revision: 2,
      }),
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    // The KD-S4 gate forbids Apply while enabled with empty provider/model,
    // so the clear path is exercised with the switch off (values are then
    // ignored by the host gate).
    store.setEnabled(false)
    store.setProvider('')
    await store.apply()
    const payload = mutate.mock.calls[0]?.[0] as { ops: SettingsPathOpView[] }
    expect(payload.ops).toContainEqual({ op: 'set', path: ['enabled'], value: false })
    expect(payload.ops).toContainEqual({ op: 'set', path: ['provider'], value: '' })
    expect(payload.ops).toContainEqual({ op: 'set', path: ['model'], value: '' })
    expect(payload.ops.some(op => op.op === 'unset' && op.path[0] === 'provider')).toBe(false)
    expect(payload.ops.some(op => op.op === 'set' && op.path[0] === 'provider' && op.value !== '')).toBe(false)
  })

  it('clears a double-pinned provider/model (base and user both hold it) with an explicit empty override', async () => {
    // Both the composition base and the stored user layer pin 'x': an `unset`
    // would only remove the user layer and restore the base pin, so clearing
    // must store the explicit '' override (review Important-1 case B).
    const { api, mutate } = scriptedApi({
      advisor: advisorView({
        base: { enabled: true, provider: 'x', model: 'y' },
        user: { enabled: true, provider: 'x', model: 'y' },
        value: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
        revision: 3,
      }),
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setEnabled(false)
    store.setProvider('')
    await store.apply()
    const payload = mutate.mock.calls[0]?.[0] as { ops: SettingsPathOpView[] }
    expect(payload.ops).toContainEqual({ op: 'set', path: ['provider'], value: '' })
    expect(payload.ops).toContainEqual({ op: 'set', path: ['model'], value: '' })
    expect(payload.ops.some(op => op.op === 'unset' && op.path[0] === 'provider')).toBe(false)
  })

  it('keeps a base-clearing override stable across a second apply (no unset churn)', async () => {
    // Apply 1 stores the explicit '' override; a later apply with a DIFFERENT
    // edit must not emit an `unset` for the cleared key (which would restore
    // the base pin and re-oscillate) nor re-emit the '' set (review
    // Important-1 case A).
    const { api, mutate } = scriptedApi({
      advisor: advisorView({
        base: { enabled: true, provider: 'x', model: 'y' },
        value: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
        revision: 1,
      }),
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setEnabled(false)
    store.setProvider('')
    await store.apply() // Apply 1: stores the provider '' / model '' overrides
    let payload = mutate.mock.calls[0]?.[0] as { ops: SettingsPathOpView[] }
    expect(payload.ops).toContainEqual({ op: 'set', path: ['provider'], value: '' })

    // Apply 2 with a different edit (immuneTurns) carries no provider/model
    // op: the override is already stored and must not be torn down.
    store.setImmuneTurns(9)
    await store.apply()
    payload = mutate.mock.calls[1]?.[0] as { ops: SettingsPathOpView[] }
    expect(payload.ops).toContainEqual({ op: 'set', path: ['immuneTurns'], value: 9 })
    expect(payload.ops.some(op => op.path[0] === 'provider')).toBe(false)
    expect(payload.ops.some(op => op.path[0] === 'model')).toBe(false)
  })

  it('unsets a stored provider/model the resolved view does not pin (defensive branch)', async () => {
    // A user-layer value the resolved view drops (host projection) means the
    // seed does not pin it, so clearing emits an `unset` — nothing would
    // restore the value afterwards.
    const { api, mutate } = scriptedApi({
      advisor: advisorView({
        user: { enabled: false, provider: 'x', model: 'y' },
        value: { enabled: false, systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
        revision: 2,
      }),
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setProvider('')
    await store.apply()
    const payload = mutate.mock.calls[0]?.[0] as { ops: SettingsPathOpView[] }
    expect(payload.ops).toContainEqual({ op: 'unset', path: ['provider'] })
    expect(payload.ops).toContainEqual({ op: 'unset', path: ['model'] })
    expect(payload.ops.some(op => op.op === 'set' && op.path[0] === 'provider')).toBe(false)
  })

  it('omits a cleared number field from the ops (empty input = leave unchanged)', async () => {
    const { api, mutate } = scriptedApi({
      advisor: advisorView({
        user: { enabled: false, immuneTurns: 5, maxDeltaMessages: 60, systemPrompt: '' },
        revision: 1,
      }),
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setImmuneTurns(undefined)
    store.setSystemPrompt('edited')
    await store.apply()
    const payload = mutate.mock.calls[0]?.[0] as { ops: SettingsPathOpView[] }
    expect(payload.ops).toContainEqual({ op: 'set', path: ['systemPrompt'], value: 'edited' })
    expect(payload.ops.some(op => op.path[0] === 'immuneTurns')).toBe(false)
    expect(payload.ops.some(op => op.path[0] === 'maxDeltaMessages')).toBe(false)
  })

  it('overrides a base-pinned provider/model with explicit empty values when cleared', async () => {
    // The values come from the composition base (no user layer): an `unset`
    // would restore them, so clearing stores an explicit '' override that the
    // host gate treats as empty.
    const { api, mutate } = scriptedApi({
      advisor: advisorView({
        base: { enabled: true, provider: 'x', model: 'y' },
        value: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
        revision: 5,
      }),
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setEnabled(false)
    store.setProvider('')
    await store.apply()
    const payload = mutate.mock.calls[0]?.[0] as { ops: SettingsPathOpView[] }
    expect(payload.ops).toContainEqual({ op: 'set', path: ['provider'], value: '' })
    expect(payload.ops).toContainEqual({ op: 'set', path: ['model'], value: '' })
    expect(payload.ops.some(op => op.op === 'unset' && op.path[0] === 'provider')).toBe(false)
  })

  it('advances the revision after a successful apply and re-syncs the draft', async () => {
    const { api, mutate } = scriptedApi({
      advisor: advisorView({
        user: { enabled: true, provider: 'deepseek-official', model: 'ds-a' },
        revision: 1,
      }),
    })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setModel('ds-b')
    await store.apply()
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
    expect(store.store.getSnapshot().draft.model).toBe('ds-b')
    // A second apply carries the revision the first mutate returned.
    store.setModel('ds-a')
    await store.apply()
    const payload = mutate.mock.calls[1]?.[0] as { expectedRevision?: number }
    expect(payload.expectedRevision).toBe(2)
  })

  it('surfaces a settings-conflict result and re-syncs via a reload', async () => {
    const { api, describe, mutate } = scriptedApi({ advisor: advisorView({ revision: 4 }) })
    mutate.mockReturnValueOnce(Promise.resolve(fail('stale revision', 'settings-conflict')))
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setEnabled(true)
    store.setProvider('deepseek-official')
    store.setModel('ds-a')
    await store.apply()
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error') expect(applyState.failure.kind).toBe('conflict')
    expect(describe).toHaveBeenCalledTimes(2) // initial load + conflict re-sync
  })

  it('surfaces a plain wire rejection without re-syncing', async () => {
    const { api, describe, mutate } = scriptedApi({ advisor: advisorView() })
    mutate.mockReturnValueOnce(Promise.resolve(fail('host refused')))
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setEnabled(true)
    store.setProvider('deepseek-official')
    store.setModel('ds-a')
    await store.apply()
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error' && applyState.failure.kind === 'message') {
      expect(applyState.failure.message).toBe('host refused')
    }
    expect(describe).toHaveBeenCalledTimes(1)
  })
})

describe('invalidations (refreshIfLoaded)', () => {
  it('refetches a loaded store', async () => {
    const { api, describe } = scriptedApi({ advisor: advisorView() })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    expect(describe).toHaveBeenCalledTimes(1)
    refreshIfLoaded(store)
    await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(2))
  })

  it('skips a never-loaded (idle) store', async () => {
    const { api, describe } = scriptedApi({ advisor: advisorView() })
    const store = new AdvisorSettingsStore(api)
    refreshIfLoaded(store)
    expect(describe).not.toHaveBeenCalled()
  })

  it('keeps an in-progress draft across a refresh (no re-seed)', async () => {
    const { api } = scriptedApi({ advisor: advisorView() })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setImmuneTurns(9)
    refreshIfLoaded(store)
    await vi.waitFor(() => expect(store.store.getSnapshot().status).toBe('ready'))
    expect(draftOf(store).immuneTurns).toBe(9)
  })
})

describe('resetDraft (Cancel)', () => {
  it('re-seeds the draft from the latest view', async () => {
    const { api } = scriptedApi({ advisor: advisorView({ user: { enabled: true, provider: 'x' }, revision: 1 }) })
    const store = new AdvisorSettingsStore(api)
    await store.load()
    store.setProvider('')
    store.setSystemPrompt('changed')
    store.resetDraft()
    expect(draftOf(store).provider).toBe('x')
    expect(draftOf(store).systemPrompt).toBe('')
  })
})
