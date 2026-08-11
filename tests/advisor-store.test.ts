/**
 * Advisor settings store (plan dsh-advisor-settings-gateway-n5, task 2) —
 * store unit tests over a scripted wire face (fake `settings`/`llm` api for
 * the provider directory + a fake connection RPC caller for the `advisor`
 * gateway channel).
 *
 * Contract under test (brief Step 1 + 4):
 * ① providers join: a provider whose profile resolves (namespace exists +
 *    profile path resolves) enters the option list; an unconfigured one
 *    (missing profile or missing namespace) does not.
 * ② model options: profile-declared `models` win; else the `llm.models`
 *    catalog group for that provider; neither → empty options + a reason.
 * ③ Apply gate (KD-S4): enabled + missing provider/model → blocked with the
 *    gate failure; disabled → provider/model may be empty and the apply lands.
 * ④ gateway patch semantics: the advisor config is read/written over
 *    `rpc.call('/api', 'advisor/get'|'advisor/set')` — a minimal patch
 *    (changed keys only) against the last-read config; a cleared
 *    provider/model the seed pins becomes an explicit '' override; a cleared
 *    number field is omitted; an empty patch reports saved without a call; a
 *    plain rpc failure surfaces the message (no conflict branch — the gateway
 *    merge has no revision guard).
 * ⑤ gateway availability (KD-G5): get success → advisorPresent; get failure
 *    (ok:false or transport throw) → advisorPresent=false with status 'ready'
 *    (the section shows the config-channel notice — never a hard load error).
 * ⑥ invalidations: `refreshIfLoaded` refetches a loaded store and skips an
 *    idle (never-loaded) one.
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  ClientConnectionRpc, ConfigurableProviderView, IApiClient, ModelProviderGroup,
  RpcResponse, RpcResult, SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import { AdvisorSettingsStore, refreshIfLoaded } from '../src/client/advisor-store'
import type { AdvisorConfigView, AdvisorDraft } from '../src/client/advisor-store'

/** One unary wire response (provider directory calls). */
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: 'r' as never, result: { ok: true, value } }
}

/** One unary wire failure (provider directory calls). */
function fail<T>(message: string): RpcResponse<T> {
  return {
    rpcId: 'r' as never,
    result: { ok: false, error: { code: 'settings-rejected', message, details: { ns: 'advisor' as string } } },
  }
}

/** One gateway RPC success (the channel returns the unwrapped result). */
function okResult<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

/** One gateway RPC failure. */
function failResult(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/** The wire config the gateway returns when nothing is configured. */
function defaultConfig(): AdvisorConfigView {
  return { enabled: false, systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 }
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

const CATALOG: ModelProviderGroup[] = [
  { id: 'openai', name: 'openai', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
  { id: 'empty', name: 'empty', models: [] },
]

/** A scripted wire face: provider directory via api, advisor config via rpc. */
interface Scripted {
  api: Pick<IApiClient, 'settings' | 'llm'>
  rpc: ClientConnectionRpc
  call: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  describe: ReturnType<typeof vi.fn>
  providers: ReturnType<typeof vi.fn>
  models: ReturnType<typeof vi.fn>
}

/**
 * Build the scripted wire. `config: null` = the gateway channel is down (get
 * fails) — the C-1/KD-G5 notice path. The fake `set` merges the patch into
 * the effective config exactly like the host gateway (merge → new composed
 * config), so a follow-up get/seed reflects the write.
 */
function scriptedApi(options: {
  config?: AdvisorConfigView | null
  namespaces?: SettingsNamespaceView[]
  entries?: ConfigurableProviderView[]
  groups?: ModelProviderGroup[]
  writable?: boolean
} = {}): Scripted {
  const others = options.namespaces ?? [deepseekNs(), piAiNs()]
  const entries = options.entries ?? [DEEPSEEK, OPENAI, ZOMBIE, ORPHAN, EMPTY, EMPTYLIST]
  let current = options.config === undefined ? defaultConfig() : options.config
  const describe = vi.fn(() => Promise.resolve(ok({
    writable: options.writable ?? true,
    hasDocument: false,
    namespaces: others,
  })))
  const providers = vi.fn(() => Promise.resolve(ok({ providers: entries })))
  const models = vi.fn(() => Promise.resolve(ok({ groups: options.groups ?? CATALOG, failures: [] })))
  const get = vi.fn(() => Promise.resolve(
    current === null
      ? failResult('advisor gateway is not ready')
      : okResult({ config: current }),
  ))
  const set = vi.fn((payload: { args: { patch: Record<string, unknown> } }) => {
    if (current === null) throw new Error('test: set on an unavailable gateway')
    current = { ...current, ...payload.args.patch }
    return Promise.resolve(okResult({ config: current }))
  })
  const call = vi.fn((channel: string, endpoint: string, payload: unknown) => {
    if (channel !== '/api') throw new Error(`test: unexpected channel ${channel}`)
    if (endpoint === 'advisor/get') return get()
    if (endpoint === 'advisor/set') return set(payload as { args: { patch: Record<string, unknown> } })
    throw new Error(`test: unexpected endpoint ${endpoint}`)
  })
  return {
    api: {
      settings: { describe, update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
      llm: { providers, models, discoverModels: vi.fn() },
    } as unknown as Pick<IApiClient, 'settings' | 'llm'>,
    rpc: { call } as unknown as ClientConnectionRpc,
    call, get, set, describe, providers, models,
  }
}

function draftOf(store: AdvisorSettingsStore): AdvisorDraft {
  return store.store.getSnapshot().draft
}

describe('providers join (KD-S2 configured determination)', () => {
  it('lists only providers whose profile resolves; excludes missing profiles and missing namespaces', async () => {
    const { api, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
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
    const { api, rpc } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(api, rpc)
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

  it('seeds the draft from the effective config regardless of layer origin (base+user already folded by the host)', async () => {
    // The gateway returns the RESOLVED config — the composition base / user
    // layer split is host-side and invisible here: the form shows the
    // effective values so the toggle is not off while the advisor is running.
    const { api, rpc } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20 },
    })
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    expect(draftOf(store).enabled).toBe(true)
    expect(draftOf(store).provider).toBe('deepseek-official')
    expect(draftOf(store).model).toBe('ds-a')
    expect(draftOf(store).systemPrompt).toBe('entry')
    expect(draftOf(store).immuneTurns).toBe(7)
    expect(draftOf(store).maxDeltaMessages).toBe(20)
  })

  it('treats absent provider/model keys as missing (wire normalization)', async () => {
    // The wire omits absent keys (never present-as-undefined): the seed must
    // read them as missing, not invent defaults that would trip the gate.
    const { api, rpc } = scriptedApi({
      config: { enabled: false, systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    expect(draftOf(store).provider).toBeUndefined()
    expect(draftOf(store).model).toBeUndefined()
    expect(draftOf(store).enabled).toBe(false)
  })
})

describe('model options (KD-S2 profile-first, catalog fallback)', () => {
  it('uses the provider profile models and never calls the catalog', async () => {
    const { api, rpc, models } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    await store.ensureModels('deepseek-official')
    const { modelsByProvider } = store.store.getSnapshot()
    expect(modelsByProvider['deepseek-official']?.map(model => model.id)).toEqual(['ds-a', 'ds-b'])
    expect(models).not.toHaveBeenCalled()
  })

  it('falls back to the llm.models catalog group when the profile declares none', async () => {
    const { api, rpc, models } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    await store.ensureModels('openai')
    const { modelsByProvider } = store.store.getSnapshot()
    expect(modelsByProvider['openai']?.map(model => model.id)).toEqual(['gpt-4o'])
    expect(models).toHaveBeenCalledTimes(1)
  })

  it('caches the catalog: a second provider needs no second llm.models call', async () => {
    const { api, rpc, models } = scriptedApi({
      namespaces: [piAiNs(), emptyNs()],
      entries: [OPENAI, EMPTY],
    })
    const store = new AdvisorSettingsStore(api, rpc)
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
    const { api, rpc, models } = scriptedApi({
      namespaces: [piAiNs(), emptyNs()],
      entries: [OPENAI, EMPTY],
    })
    models.mockReturnValueOnce(deferred)
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    const first = store.ensureModels('openai')
    const second = store.ensureModels('empty')
    deferredResolve(ok({ groups: CATALOG, failures: [] }))
    await Promise.all([first, second])
    expect(models).toHaveBeenCalledTimes(1)
    expect(store.store.getSnapshot().modelsByProvider['openai']?.map(model => model.id)).toEqual(['gpt-4o'])
  })

  it('does not cache a transient catalog failure: a later provider refetches', async () => {
    const { api, rpc, models } = scriptedApi({
      namespaces: [piAiNs(), emptyNs()],
      entries: [OPENAI, EMPTY],
    })
    models.mockReturnValueOnce(Promise.resolve(fail('catalog down')))
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    // First resolution hits a failing catalog fetch: the provider gets the
    // empty-options reason, but the failure is NOT cached at catalog level.
    await store.ensureModels('openai')
    expect(store.store.getSnapshot().modelsEmptyReason['openai']).toBe('unavailable')
    // The next provider's resolution refetches and sees the recovered catalog.
    await store.ensureModels('empty')
    expect(models).toHaveBeenCalledTimes(2)
    expect(store.store.getSnapshot().modelsEmptyReason['empty']).toBe('catalog-empty')
  })

  it('marks empty options with a reason when neither source has models', async () => {
    const { api, rpc } = scriptedApi({
      namespaces: [deepseekNs(), piAiNs(), emptyNs(), emptylistNs()],
    })
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    await store.ensureModels('empty')     // profile has no models field; catalog group empty
    await store.ensureModels('emptylist') // profile declares an empty models list (profile wins)
    await store.ensureModels('zombie')    // not configured — nothing offered
    const { modelsByProvider, modelsEmptyReason } = store.store.getSnapshot()
    expect(modelsByProvider['empty'] ?? []).toEqual([])
    expect(modelsEmptyReason['empty']).toBe('catalog-empty')
    expect(modelsByProvider['emptylist'] ?? []).toEqual([])
    expect(modelsEmptyReason['emptylist']).toBe('profile-empty')
    expect(Object.hasOwn(modelsByProvider, 'zombie')).toBe(false)
    expect(Object.hasOwn(modelsEmptyReason, 'zombie')).toBe(false)
  })
})

describe('apply gate (KD-S4 required-when-enabled)', () => {
  it('blocks Apply when enabled with no provider, naming the gate failure', async () => {
    const { api, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setEnabled(true)
    await store.apply()
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error') {
      expect(applyState.failure.kind).toBe('gate')
      if (applyState.failure.kind === 'gate') expect(applyState.failure.reason).toBe('provider')
    }
    expect(set).not.toHaveBeenCalled()
  })

  it('blocks Apply when enabled with a provider but no model', async () => {
    const { api, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setEnabled(true)
    store.setProvider('deepseek-official')
    await store.apply()
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error' && applyState.failure.kind === 'gate') {
      expect(applyState.failure.reason).toBe('model')
    }
    expect(set).not.toHaveBeenCalled()
  })

  it('allows empty provider/model while disabled and lands the apply', async () => {
    const { api, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setImmuneTurns(5)
    await store.apply()
    expect(set).toHaveBeenCalledTimes(1)
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('saved')
  })
})

describe('apply patch + seed (gateway channel semantics)', () => {
  it('writes only the changed keys as a patch against the last-read config', async () => {
    const { api, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setModel('ds-b')
    await store.apply()
    expect(call).toHaveBeenCalledWith('/api', 'advisor/set', {
      args: { patch: { model: 'ds-b' } },
    })
  })

  it('overrides a config-pinned provider/model with explicit empty values when cleared', async () => {
    // The seed pins the values through the effective config; the explicit ''
    // override is used because the gateway merge cannot express an unset (the
    // host resolver treats '' as absent — the clear stays stable).
    const { api, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    // The KD-S4 gate forbids Apply while enabled with empty provider/model,
    // so the clear path is exercised with the switch off (values are then
    // ignored by the host gate).
    store.setEnabled(false)
    store.setProvider('')
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ enabled: false, provider: '', model: '' })
  })

  it('keeps a base-clearing override stable across a second apply (no churn)', async () => {
    // Apply 1 stores the explicit '' override; a later apply with a DIFFERENT
    // edit must not re-emit the cleared keys — after the reload the get omits
    // the '' override (the resolver treats it as absent), so the seed no
    // longer pins provider/model and the second patch carries neither.
    const { api, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setEnabled(false)
    store.setProvider('')
    await store.apply() // Apply 1: stores the provider '' / model '' overrides
    let payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch.provider).toBe('')

    // Apply 2 with a different edit (immuneTurns) carries no provider/model
    // key: nothing pins them anymore, so nothing is written.
    store.setImmuneTurns(9)
    await store.apply()
    const setCalls = call.mock.calls.filter(callArgs => callArgs[1] === 'advisor/set')
    payload = setCalls[1]?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ immuneTurns: 9 })
  })

  it('omits the patch for a cleared provider/model nothing pins (nothing stored → no op)', async () => {
    // The config does not pin provider/model at all: clearing them writes
    // nothing — there is no stored value to remove (the old unset branch is
    // unreachable through the gateway: the returned config IS the effective
    // view).
    const { api, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setProvider('')
    await store.apply()
    expect(set).not.toHaveBeenCalled()
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
  })

  it('omits a cleared number field from the patch (empty input = leave unchanged)', async () => {
    const { api, rpc, call } = scriptedApi({
      config: { enabled: false, systemPrompt: '', immuneTurns: 5, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setImmuneTurns(undefined)
    store.setSystemPrompt('edited')
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ systemPrompt: 'edited' })
  })

  it('reports saved without a gateway call when the patch is empty', async () => {
    const { api, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    await store.apply() // no edits at all → nothing to write
    expect(set).not.toHaveBeenCalled()
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
  })

  it('adopts the returned config as the new seed after a successful apply', async () => {
    const { api, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setModel('ds-b')
    await store.apply()
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
    expect(store.store.getSnapshot().draft.model).toBe('ds-b')
    // A second apply diff-cleans against the returned config (the reload
    // re-seeds from the same effective config).
    store.setModel('ds-a')
    await store.apply()
    const setCalls = call.mock.calls.filter(callArgs => callArgs[1] === 'advisor/set')
    expect(setCalls).toHaveLength(2)
    const payload = setCalls[1]?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ model: 'ds-a' })
  })

  it('surfaces a plain rpc rejection without re-syncing', async () => {
    const { api, rpc, describe, set } = scriptedApi()
    set.mockReturnValueOnce(Promise.resolve(failResult('host refused')))
    const store = new AdvisorSettingsStore(api, rpc)
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
    // The gateway merge has no revision guard: a failure is a plain message,
    // the form stays for retry, and no reload re-syncs (describe stays at 1).
    expect(describe).toHaveBeenCalledTimes(1)
  })

  it('surfaces a transport throw from the set call as a message failure, keeping the form, without re-syncing', async () => {
    // The transport itself rejects (network down mid-write): the catch branch
    // folds the thrown message into the apply state — the form keeps the
    // edits for a retry and no reload re-syncs.
    const { api, rpc, describe, call } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    // The Once is registered AFTER load so it targets the set call, not the
    // load's get call.
    call.mockRejectedValueOnce(new Error('transport down'))
    store.setEnabled(true)
    store.setProvider('deepseek-official')
    store.setModel('ds-a')
    await store.apply()
    const { applyState, draft } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error' && applyState.failure.kind === 'message') {
      expect(applyState.failure.message).toBe('transport down')
    }
    // The in-progress draft survives (nothing was written, nothing re-seeded).
    expect(draft.enabled).toBe(true)
    expect(draft.provider).toBe('deepseek-official')
    expect(draft.model).toBe('ds-a')
    expect(describe).toHaveBeenCalledTimes(1)
  })
})

describe('invalidations (refreshIfLoaded)', () => {
  it('refetches a loaded store', async () => {
    const { api, rpc, describe } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    expect(describe).toHaveBeenCalledTimes(1)
    refreshIfLoaded(store)
    await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(2))
  })

  it('skips a never-loaded (idle) store', async () => {
    const { api, rpc, describe } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    refreshIfLoaded(store)
    expect(describe).not.toHaveBeenCalled()
  })

  it('keeps an in-progress draft across a refresh (no re-seed)', async () => {
    const { api, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setImmuneTurns(9)
    refreshIfLoaded(store)
    await vi.waitFor(() => expect(store.store.getSnapshot().status).toBe('ready'))
    expect(draftOf(store).immuneTurns).toBe(9)
  })
})

describe('resetDraft (Cancel)', () => {
  it('re-seeds the draft from the latest config', async () => {
    const { api, rpc } = scriptedApi({
      config: { enabled: true, provider: 'x', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setProvider('')
    store.setSystemPrompt('changed')
    store.resetDraft()
    expect(draftOf(store).provider).toBe('x')
    expect(draftOf(store).systemPrompt).toBe('')
  })
})

describe('model option refresh on invalidation (qc1 W-1 / qc3 S-1)', () => {
  it('a reload after models/changed re-resolves a previously-resolved provider with the NEW options', async () => {
    const { api, rpc, models } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    await store.ensureModels('openai')
    expect(store.store.getSnapshot().modelsByProvider['openai']?.map(model => model.id)).toEqual(['gpt-4o'])
    expect(models).toHaveBeenCalledTimes(1)

    // The catalog changes on the host (a model added on the Models page).
    models.mockReturnValueOnce(Promise.resolve(ok({
      groups: [{ id: 'openai', name: 'openai', models: [{ id: 'gpt-5', name: 'GPT-5' }] }],
      failures: [],
    })))

    // The invalidation path (refreshIfLoaded → load()) clears the per-provider
    // caches + catalog; the next resolution must see the fresh options.
    await store.load()
    await store.ensureModels('openai')
    expect(store.store.getSnapshot().modelsByProvider['openai']?.map(model => model.id)).toEqual(['gpt-5'])
    expect(models).toHaveBeenCalledTimes(2)
  })

  it('clears the per-provider caches on every load, even when the stored provider did not change', async () => {
    const { api, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setProvider('openai')
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().modelsByProvider['openai']?.map(model => model.id)).toEqual(['gpt-4o'])
    })

    // A plain reload (settings/changed) drops the resolved options; the
    // select re-resolves on demand — nothing is store-lifetime anymore.
    await store.load()
    expect(Object.hasOwn(store.store.getSnapshot().modelsByProvider, 'openai')).toBe(false)
    expect(Object.hasOwn(store.store.getSnapshot().modelsEmptyReason, 'openai')).toBe(false)
  })

  it('abandons a catalog fetch started before an invalidation and refetches fresh data', async () => {
    type CatalogPayload = { groups: ModelProviderGroup[]; failures: unknown[] }
    let deferredResolve!: (value: RpcResponse<CatalogPayload>) => void
    const deferred = new Promise<RpcResponse<CatalogPayload>>((resolve) => { deferredResolve = resolve })
    const { api, rpc, models } = scriptedApi({
      namespaces: [piAiNs()],
      entries: [OPENAI],
    })
    // Fetch A hangs; fetch B (after the invalidation) sees the NEW catalog.
    models.mockReturnValueOnce(deferred)
    models.mockReturnValueOnce(Promise.resolve(ok({
      groups: [{ id: 'openai', name: 'openai', models: [{ id: 'gpt-5', name: 'GPT-5' }] }],
      failures: [],
    })))
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    const first = store.ensureModels('openai')
    // The models/changed invalidation arrives while fetch A is in flight.
    await store.load()
    // The stale fetch resolves with the OLD group AFTER the invalidation.
    deferredResolve(ok({
      groups: [{ id: 'openai', name: 'openai', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] }],
      failures: [],
    }))
    await first
    // The stale result was dropped; the resolution loop refetched fresh.
    expect(store.store.getSnapshot().modelsByProvider['openai']?.map(model => model.id)).toEqual(['gpt-5'])
    expect(models).toHaveBeenCalledTimes(2)
  })
})

describe('gateway availability (KD-G5 — advisorPresent)', () => {
  it('tracks advisorPresent true when the advisor/get endpoint succeeds', async () => {
    const { api, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(true)
    expect(state.status).toBe('ready')
  })

  it('tracks advisorPresent false when the gateway get fails (ok:false) without failing the page', async () => {
    // Gateway down (no settings service / channel unreachable): the provider
    // directory still loads — the section shows the config-channel notice.
    const { api, rpc } = scriptedApi({ config: null })
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(false)
    expect(state.status).toBe('ready')
  })

  it('tracks advisorPresent false when the gateway get throws (transport down) without failing the page', async () => {
    const { api, rpc, get } = scriptedApi()
    get.mockRejectedValueOnce(new Error('transport down'))
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(false)
    expect(state.status).toBe('ready')
    expect(state.providers.length).toBeGreaterThan(0) // directory survived
  })
})

describe('post-apply reload failure (qc3 N-1)', () => {
  it('keeps the saved feedback when the reload after a successful set fails', async () => {
    const { api, rpc, describe, set } = scriptedApi()
    // First describe (initial load) resolves; the post-apply reload fails.
    describe.mockReturnValueOnce(Promise.resolve(ok({
      writable: true,
      hasDocument: false,
      namespaces: [deepseekNs(), piAiNs()],
    })))
    describe.mockReturnValueOnce(Promise.resolve(fail('transport down')))
    const store = new AdvisorSettingsStore(api, rpc)
    await store.load()
    store.setImmuneTurns(5)
    await store.apply()
    expect(set).toHaveBeenCalledTimes(1)
    const state = store.store.getSnapshot()
    // The write landed and the saved feedback is set BEFORE the reload — the
    // failed reload must not mask it (the section renders it alongside the
    // error + retry).
    expect(state.applyState.kind).toBe('saved')
    expect(state.status).toBe('error')
  })
})
