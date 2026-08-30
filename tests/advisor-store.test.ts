/**
 * Advisor settings store (plan dsh-advisor-settings-gateway-n5, task 2) —
 * store unit tests over a scripted wire face (fake client Remote assembly —
 * `llm.listConfigurableProviders` / `settings.describe` /
 * `session.modelCatalog` — for the provider directory + a fake connection RPC
 * caller for the `advisor` gateway channel).
 *
 * Contract under test (brief Step 1 + 4):
 * ① providers join: a provider whose profile resolves (namespace exists +
 *    profile path resolves) enters the option list; an unconfigured one
 *    (missing profile or missing namespace) does not.
 * ② model options: profile-declared `models` win; else the
 *    `session.modelCatalog` group for that provider; neither → empty options
 *    + a reason.
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
 *    (the card shows the config-channel notice — never a hard load error).
 * ⑥ invalidations: `refreshIfLoaded` refetches a loaded store and skips an
 *    idle (never-loaded) one.
 * ⑦ discard (T2 store add, T3 review): the card's Discard rewinds the draft to
 *    the last-known seed — pure client-side (no gateway write), the apply diff
 *    after discard is EMPTY (reports saved without calling `advisor/set`),
 *    pending apply feedback (error/saved) resets to idle, a fresh edit after
 *    discard diff-cleans against the restored seed, and the unseeded first-load
 *    path stays pristine (a later recovery still seeds the REAL config).
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  ClientConnectionRpc, RpcResult,
} from '@deepseek-ai/dsh-client-connection/client'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm/types'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { fakeSchema } from './support/schema-ops'
import { AdvisorSettingsStore, refreshIfLoaded } from '../src/client/advisor-store'
import type { AdvisorConfigView, AdvisorDraft, AdvisorStoreRemote } from '../src/client/advisor-store'

/** Real settings schema service (immutable path writers under test). */
const schema = fakeSchema()

/** One Remote assembly success (provider directory calls). */
function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One Remote assembly failure (provider directory calls). */
function fail<T>(message: string): RemoteResult<T> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

/** One `session.modelCatalog` success (the store only reads `groups`). */
function catalogOk(groups: ModelCatalog['groups']): RemoteResult<ModelCatalog> {
  return ok({ default: { provider: '', model: '' }, routableProviders: [], groups, failures: [] })
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

const DEEPSEEK: LlmConfigurableProvider = {
  provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [],
}
const OPENAI: LlmConfigurableProvider = {
  provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'],
}
/** Profile path resolves to nothing in its namespace → not configured. */
const ZOMBIE: LlmConfigurableProvider = {
  provider: 'zombie', displayName: 'zombie', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zombie'],
}
/** Whole-section provider whose settings namespace does not exist → not configured. */
const ORPHAN: LlmConfigurableProvider = {
  provider: 'orphan', displayName: 'orphan', settingsNs: 'llm-orphan', settingsPath: [],
}
/** Whole-section provider whose section resolves but declares no models anywhere. */
const EMPTY: LlmConfigurableProvider = {
  provider: 'empty', displayName: 'empty', settingsNs: 'llm-empty', settingsPath: [],
}
/** Whole-section provider whose profile declares an EMPTY models list. */
const EMPTYLIST: LlmConfigurableProvider = {
  provider: 'emptylist', displayName: 'emptylist', settingsNs: 'llm-emptylist', settingsPath: [],
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

const CATALOG: ModelCatalog['groups'] = [
  { id: 'openai', name: 'openai', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
  { id: 'empty', name: 'empty', models: [] },
]

/** A scripted wire face: provider directory via the Remote assembly, advisor config via rpc. */
interface Scripted {
  remote: AdvisorStoreRemote
  rpc: ClientConnectionRpc
  call: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  describe: ReturnType<typeof vi.fn>
  listConfigurableProviders: ReturnType<typeof vi.fn>
  modelCatalog: ReturnType<typeof vi.fn>
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
  entries?: LlmConfigurableProvider[]
  groups?: ModelCatalog['groups']
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
  const listConfigurableProviders = vi.fn(() => Promise.resolve(ok(entries)))
  const modelCatalog = vi.fn(() => Promise.resolve(ok({
    default: { provider: '', model: '' },
    routableProviders: [],
    groups: options.groups ?? CATALOG,
    failures: [],
  } satisfies ModelCatalog)))
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
    remote: {
      llm: { listConfigurableProviders },
      settings: { describe },
      session: { modelCatalog },
    },
    rpc: { call } as unknown as ClientConnectionRpc,
    call, get, set, describe, listConfigurableProviders, modelCatalog,
  }
}

function draftOf(store: AdvisorSettingsStore): AdvisorDraft {
  return store.store.getSnapshot().draft
}

describe('providers join (KD-S2 configured determination)', () => {
  it('lists only providers whose profile resolves; excludes missing profiles and missing namespaces', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc } = scriptedApi({
      config: { enabled: false, systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(draftOf(store).provider).toBeUndefined()
    expect(draftOf(store).model).toBeUndefined()
    expect(draftOf(store).enabled).toBe(false)
  })
})

describe('model options (KD-S2 profile-first, catalog fallback)', () => {
  it('uses the provider profile models and never calls the catalog', async () => {
    const { remote, rpc, modelCatalog } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    await store.ensureModels('deepseek-official')
    const { modelsByProvider } = store.store.getSnapshot()
    expect(modelsByProvider['deepseek-official']?.map(model => model.id)).toEqual(['ds-a', 'ds-b'])
    expect(modelCatalog).not.toHaveBeenCalled()
  })

  it('falls back to the llm.models catalog group when the profile declares none', async () => {
    const { remote, rpc, modelCatalog } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    await store.ensureModels('openai')
    const { modelsByProvider } = store.store.getSnapshot()
    expect(modelsByProvider['openai']?.map(model => model.id)).toEqual(['gpt-4o'])
    expect(modelCatalog).toHaveBeenCalledTimes(1)
  })

  it('caches the catalog: a second provider needs no second llm.models call', async () => {
    const { remote, rpc, modelCatalog } = scriptedApi({
      namespaces: [piAiNs(), emptyNs()],
      entries: [OPENAI, EMPTY],
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    await store.ensureModels('openai')
    await store.ensureModels('empty')
    expect(modelCatalog).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight catalog fetch across concurrent providers', async () => {
    let deferredResolve!: (value: RemoteResult<ModelCatalog>) => void
    const deferred = new Promise<RemoteResult<ModelCatalog>>((resolve) => {
      deferredResolve = resolve
    })
    const { remote, rpc, modelCatalog } = scriptedApi({
      namespaces: [piAiNs(), emptyNs()],
      entries: [OPENAI, EMPTY],
    })
    modelCatalog.mockReturnValueOnce(deferred)
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    const first = store.ensureModels('openai')
    const second = store.ensureModels('empty')
    deferredResolve(ok({ default: { provider: '', model: '' }, routableProviders: [], groups: CATALOG, failures: [] }))
    await Promise.all([first, second])
    expect(modelCatalog).toHaveBeenCalledTimes(1)
    expect(store.store.getSnapshot().modelsByProvider['openai']?.map(model => model.id)).toEqual(['gpt-4o'])
  })

  it('does not cache a transient catalog failure: a later provider refetches', async () => {
    const { remote, rpc, modelCatalog } = scriptedApi({
      namespaces: [piAiNs(), emptyNs()],
      entries: [OPENAI, EMPTY],
    })
    modelCatalog.mockReturnValueOnce(Promise.resolve(fail('catalog down')))
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    // First resolution hits a failing catalog fetch: the provider gets the
    // empty-options reason, but the failure is NOT cached at catalog level.
    await store.ensureModels('openai')
    expect(store.store.getSnapshot().modelsEmptyReason['openai']).toBe('unavailable')
    // The next provider's resolution refetches and sees the recovered catalog.
    await store.ensureModels('empty')
    expect(modelCatalog).toHaveBeenCalledTimes(2)
    expect(store.store.getSnapshot().modelsEmptyReason['empty']).toBe('catalog-empty')
  })

  it('marks empty options with a reason when neither source has models', async () => {
    const { remote, rpc } = scriptedApi({
      namespaces: [deepseekNs(), piAiNs(), emptyNs(), emptylistNs()],
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    // edit must not re-emit the cleared keys — after the reload the get
    // returns the stored '' (the wire may carry it), but the resolver treats
    // '' as absent and the client reads it as missing, so the seed no longer
    // pins provider/model and the second patch carries neither.
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setProvider('')
    await store.apply()
    expect(set).not.toHaveBeenCalled()
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
  })

  it('omits a cleared number field from the patch (empty input = leave unchanged)', async () => {
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: false, systemPrompt: '', immuneTurns: 5, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setImmuneTurns(undefined)
    store.setSystemPrompt('edited')
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ systemPrompt: 'edited' })
  })

  it('reports saved without a gateway call when the patch is empty', async () => {
    const { remote, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    await store.apply() // no edits at all → nothing to write
    expect(set).not.toHaveBeenCalled()
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
    // qc3 S-2: the empty-patch branch recomputes dirty like every other apply
    // outcome — an apply that writes nothing keeps the form clean.
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it('adopts the returned config as the new seed after a successful apply', async () => {
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc, describe, set } = scriptedApi()
    set.mockReturnValueOnce(Promise.resolve(failResult('host refused')))
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc, describe, call } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    const { remote, rpc, describe } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(describe).toHaveBeenCalledTimes(1)
    refreshIfLoaded(store)
    await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(2))
  })

  it('skips a never-loaded (idle) store', async () => {
    const { remote, rpc, describe } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    refreshIfLoaded(store)
    expect(describe).not.toHaveBeenCalled()
  })

  it('keeps an in-progress draft across a refresh (no re-seed)', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setImmuneTurns(9)
    refreshIfLoaded(store)
    await vi.waitFor(() => expect(store.store.getSnapshot().status).toBe('ready'))
    expect(draftOf(store).immuneTurns).toBe(9)
  })
})

describe('model option refresh on invalidation (qc1 W-1 / qc3 S-1)', () => {
  it('a reload after models/changed re-resolves a previously-resolved provider with the NEW options', async () => {
    const { remote, rpc, modelCatalog } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    await store.ensureModels('openai')
    expect(store.store.getSnapshot().modelsByProvider['openai']?.map(model => model.id)).toEqual(['gpt-4o'])
    expect(modelCatalog).toHaveBeenCalledTimes(1)

    // The catalog changes on the host (a model added on the Models page).
    modelCatalog.mockReturnValueOnce(Promise.resolve(catalogOk([
      { id: 'openai', name: 'openai', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
    ])))

    // The invalidation path (refreshIfLoaded → load()) clears the per-provider
    // caches + catalog; the next resolution must see the fresh options.
    await store.load()
    await store.ensureModels('openai')
    expect(store.store.getSnapshot().modelsByProvider['openai']?.map(model => model.id)).toEqual(['gpt-5'])
    expect(modelCatalog).toHaveBeenCalledTimes(2)
  })

  it('clears the per-provider caches on every load, even when the stored provider did not change', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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
    let deferredResolve!: (value: RemoteResult<ModelCatalog>) => void
    const deferred = new Promise<RemoteResult<ModelCatalog>>((resolve) => { deferredResolve = resolve })
    const { remote, rpc, modelCatalog } = scriptedApi({
      namespaces: [piAiNs()],
      entries: [OPENAI],
    })
    // Fetch A hangs; fetch B (after the invalidation) sees the NEW catalog.
    modelCatalog.mockReturnValueOnce(deferred)
    modelCatalog.mockReturnValueOnce(Promise.resolve(catalogOk([
      { id: 'openai', name: 'openai', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
    ])))
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    const first = store.ensureModels('openai')
    // The models/changed invalidation arrives while fetch A is in flight.
    await store.load()
    // The stale fetch resolves with the OLD group AFTER the invalidation.
    deferredResolve(catalogOk([
      { id: 'openai', name: 'openai', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
    ]))
    await first
    // The stale result was dropped; the resolution loop refetched fresh.
    expect(store.store.getSnapshot().modelsByProvider['openai']?.map(model => model.id)).toEqual(['gpt-5'])
    expect(modelCatalog).toHaveBeenCalledTimes(2)
  })
})

describe('gateway availability (KD-G5 — advisorPresent)', () => {
  it('tracks advisorPresent true when the advisor/get endpoint succeeds', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(true)
    expect(state.status).toBe('ready')
  })

  it('tracks advisorPresent false when the gateway get fails (ok:false) without failing the page', async () => {
    // Gateway down (no settings service / channel unreachable): the provider
    // directory still loads — the section shows the config-channel notice.
    const { remote, rpc } = scriptedApi({ config: null })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(false)
    expect(state.status).toBe('ready')
  })

  it('tracks advisorPresent false when the gateway get throws (transport down) without failing the page', async () => {
    const { remote, rpc, get } = scriptedApi()
    get.mockRejectedValueOnce(new Error('transport down'))
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(false)
    expect(state.status).toBe('ready')
    expect(state.providers.length).toBeGreaterThan(0) // directory survived
  })

  it('does not seed the draft from a failed first get, and seeds the REAL config once the gateway recovers (I-1)', async () => {
    // First load: the get fails (gateway not ready). The draft must NOT be
    // seeded with schema defaults NOR marked seeded — otherwise a later Apply
    // (diffed against the recovered real seed) would send a full-default
    // patch and wipe the actual configuration.
    const { remote, rpc, get } = scriptedApi()
    get
      .mockImplementationOnce(() => Promise.resolve(failResult('advisor gateway is not ready')))
      .mockImplementationOnce(() => Promise.resolve(okResult({
        config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20 },
      })))
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    let state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(false)
    // The pristine (unseeded) draft stays the schema defaults — NOT marked
    // seeded, so the next successful load can still seed.
    expect(state.draft).toEqual({ enabled: false, systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 })
    // Gateway recovers: the next load seeds the ACTUAL config.
    await store.load()
    state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(true)
    expect(state.draft).toEqual({
      enabled: true, provider: 'deepseek-official', model: 'ds-a',
      systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20,
    })
  })
})

describe('post-apply reload failure (qc3 N-1)', () => {
  it('keeps the saved feedback when the reload after a successful set fails', async () => {
    const { remote, rpc, describe, set } = scriptedApi()
    // First describe (initial load) resolves; the post-apply reload fails.
    describe.mockReturnValueOnce(Promise.resolve(ok({
      writable: true,
      hasDocument: false,
      namespaces: [deepseekNs(), piAiNs()],
    })))
    describe.mockReturnValueOnce(Promise.resolve(fail('transport down')))
    const store = new AdvisorSettingsStore(remote, rpc, schema)
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

describe('discard (card draft rewind — T2 store add, T3 review)', () => {
  it('rewinds the draft to the last-known host config without any gateway write', async () => {
    const { remote, rpc, set } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setProvider('openai') // a provider switch invalidates the chosen model
    store.setEnabled(false)
    store.setSystemPrompt('edited')
    expect(draftOf(store).provider).toBe('openai')
    expect(draftOf(store).enabled).toBe(false)
    store.discard()
    // The draft is exactly the seed again — every edited key rewound.
    expect(draftOf(store)).toEqual({
      enabled: true, provider: 'deepseek-official', model: 'ds-a',
      systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20,
    })
    // Discard is a client-side rewind — no advisor/set call ever happened.
    expect(set).not.toHaveBeenCalled()
  })

  it('after discard, apply diffs empty and reports saved without a write', async () => {
    // The T3-review-flagged assertion: discard restores the draft to the seed,
    // so a follow-up apply has an EMPTY diff and reports saved WITHOUT calling
    // advisor/set (the host stays the single fact source — nothing to write).
    const { remote, rpc, set } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setEnabled(false)
    store.setProvider('openai')
    store.setSystemPrompt('edited')
    store.discard()
    await store.apply()
    expect(set).not.toHaveBeenCalled()
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
    // The empty apply leaves the rewound draft untouched (no re-seed, no re-write).
    expect(draftOf(store)).toEqual({
      enabled: true, provider: 'deepseek-official', model: 'ds-a',
      systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60,
    })
  })

  it('clears a pending gate-error apply state back to idle', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setEnabled(true) // enabled without provider/model → the KD-S4 gate blocks Apply
    await store.apply()
    expect(store.store.getSnapshot().applyState.kind).toBe('error')
    store.discard()
    expect(store.store.getSnapshot().applyState.kind).toBe('idle')
  })

  it('clears the saved feedback back to idle after a landed apply (discard is a no-op on values)', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setImmuneTurns(5)
    await store.apply()
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
    // Discard right after a landed apply: the values already match the seed
    // (the returned config was adopted), so only the feedback resets.
    store.discard()
    expect(store.store.getSnapshot().applyState.kind).toBe('idle')
    expect(draftOf(store).immuneTurns).toBe(5)
  })

  it('a fresh edit after discard diff-cleans against the restored seed', async () => {
    // Discard restores the diff baseline: a later apply carries ONLY the new
    // edit — the pre-discard model edit must not resurface in the patch.
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setModel('ds-b')  // pre-discard edit
    store.discard()         // rewind → seed (ds-a)
    store.setImmuneTurns(9) // post-discard edit
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ immuneTurns: 9 })
  })

  it('does not corrupt the unseeded draft when discarded before the first successful load', async () => {
    // First load: the get fails (gateway not ready) — the draft is NOT seeded
    // and the card shows the notice (no discard button), but a store-level
    // discard must not mark the draft seeded or invent values: once the
    // gateway recovers, the next load still seeds the REAL config.
    const { remote, rpc, get } = scriptedApi()
    get
      .mockImplementationOnce(() => Promise.resolve(failResult('advisor gateway is not ready')))
      .mockImplementationOnce(() => Promise.resolve(okResult({
        config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20 },
      })))
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(store.store.getSnapshot().advisorPresent).toBe(false)
    store.discard()
    expect(draftOf(store)).toEqual({ enabled: false, systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 })
    await store.load()
    expect(store.store.getSnapshot().advisorPresent).toBe(true)
    expect(draftOf(store)).toEqual({
      enabled: true, provider: 'deepseek-official', model: 'ds-a',
      systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20,
    })
  })
})

describe('dirty derivation (plan dsh-advisor-plugin-config-card-ux, task 2 — KD-U2)', () => {
  it('tracks the dirty lifecycle: clean → edit dirty → discard clean → edit → apply success clean', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    // The store default is clean — no edits staged against any seed.
    expect(store.store.getSnapshot().dirty).toBe(false)
    await store.load()
    expect(store.store.getSnapshot().dirty).toBe(false) // seeded from the config → clean
    store.setSystemPrompt('review terser')
    expect(store.store.getSnapshot().dirty).toBe(true) // a save would write the prompt
    store.discard()
    expect(store.store.getSnapshot().dirty).toBe(false) // draft rewound to the seed → clean
    store.setImmuneTurns(9)
    expect(store.store.getSnapshot().dirty).toBe(true)
    await store.apply()
    // The write landed and the returned config was adopted as the new seed —
    // the draft now matches the host, so a save writes nothing → clean.
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it('keeps a cleared number field clean by itself (patchFor omits it — leave stored value unchanged)', async () => {
    const { remote, rpc } = scriptedApi({
      config: { enabled: false, systemPrompt: '', immuneTurns: 5, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(store.store.getSnapshot().dirty).toBe(false)
    store.setImmuneTurns(undefined) // cleared input → the key is omitted from the patch
    expect(store.store.getSnapshot().dirty).toBe(false)
    // And clearing BOTH number fields stays clean — empty input means
    // "leave the stored value unchanged", never a write.
    store.setMaxDeltaMessages(undefined)
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it("treats a cleared provider the seed pins as dirty (the '' override is a real edit)", async () => {
    const { remote, rpc } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(store.store.getSnapshot().dirty).toBe(false)
    // The KD-S4 gate forbids Apply while enabled with an empty provider/model,
    // so the clear path is exercised with the switch off (values are then
    // ignored by the host gate) — the dirty derivation itself does not care.
    store.setEnabled(false)
    store.setProvider('') // patchFor emits provider: '' → a real write → dirty
    expect(store.store.getSnapshot().dirty).toBe(true)
  })

  it("derives dirty from the '' provider override alone — no enabled toggle needed (M-6 isolation)", async () => {
    // The sibling test calls setEnabled(false) first, which alone makes the
    // patch non-empty ({ enabled: false }) — this variant isolates the
    // ''-provider semantic: NO enabled toggle, only the provider clear, and
    // the seed pins no model, so the resulting patch is exactly
    // { provider: '' } → dirty derives true from that alone.
    const { remote, rpc } = scriptedApi({
      config: { enabled: false, provider: 'deepseek-official', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(store.store.getSnapshot().dirty).toBe(false)
    store.setProvider('') // patchFor emits provider: '' → a real write → dirty
    expect(store.store.getSnapshot().dirty).toBe(true)
  })

  it('keeps dirty false through an unseeded first-load failure and recomputes from the recovered seed', async () => {
    // First load: the get fails (gateway not ready) — nothing seeded, nothing
    // staged: dirty must stay false. Once the gateway recovers, the REAL
    // config seeds the draft and dirty derives clean against it.
    const { remote, rpc, get } = scriptedApi()
    get
      .mockImplementationOnce(() => Promise.resolve(failResult('advisor gateway is not ready')))
      .mockImplementationOnce(() => Promise.resolve(okResult({
        config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20 },
      })))
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    let state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(false)
    expect(state.dirty).toBe(false) // unseeded failure keeps the form clean
    await store.load() // gateway recovers → seeds the ACTUAL config
    state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(true)
    expect(state.dirty).toBe(false) // seeded from the config → clean
  })

  it('returns to clean when an edit reverts to the seed value (empty patch boundary)', async () => {
    // dirty = "a save would write something": an edit that puts the draft
    // back to the seed produces an EMPTY patch → clean (the UI then hides
    // Save/Discard — the store keeps the defense as well).
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setSystemPrompt('review terser')
    expect(store.store.getSnapshot().dirty).toBe(true)
    store.setSystemPrompt('') // back to the seed value → empty patch → clean
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it('keeps the draft dirty when an apply is rejected (the form stays for retry)', async () => {
    // A rejected write leaves the seed untouched: the draft still differs,
    // so dirty stays true and the card keeps Save enabled for the retry.
    const { remote, rpc, set } = scriptedApi()
    set.mockReturnValueOnce(Promise.resolve(failResult('host refused')))
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setEnabled(true)
    store.setProvider('deepseek-official')
    store.setModel('ds-a')
    expect(store.store.getSnapshot().dirty).toBe(true)
    await store.apply()
    expect(store.store.getSnapshot().applyState.kind).toBe('error')
    expect(store.store.getSnapshot().dirty).toBe(true) // no write, no re-seed
  })

  it('a refresh whose host config now matches the draft flips dirty back to false (S-2 pin)', async () => {
    // The claimed direction at advisor-store.ts load(): "A refresh whose host
    // values now match the draft (another session saved) correctly flips
    // dirty back to false." The invalidation test keeps the draft across a
    // refresh but never asserted the dirty recompute — this pins it (qc2 S-2).
    const { remote, rpc, get } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setSystemPrompt('review terser')
    expect(store.store.getSnapshot().dirty).toBe(true)
    // Another session saved the same value on the host: the next refresh's
    // get returns a config EQUAL to the draft → load() re-seeds and derives
    // clean, while the draft itself survives (never re-seeded).
    get.mockReturnValueOnce(Promise.resolve(okResult({
      config: { enabled: false, systemPrompt: 'review terser', immuneTurns: 3, maxDeltaMessages: 60 },
    })))
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.draft.systemPrompt).toBe('review terser') // draft survives the refresh
    expect(state.dirty).toBe(false) // host matches the draft → clean
  })

  it('keeps the draft dirty when the client gate blocks apply (the force-down patch is unreachable from the card) (S-3 pin)', async () => {
    // qc2 S-3 (deferred — plan Risks, 2026-08-12): the host force-down
    // (resolved enabled:false + disabledReason) is reachable only if a patch
    // the client gate would block still reaches the host. This pin documents
    // that such a patch cannot be produced from the card: enabled without
    // provider/model is blocked by the gate BEFORE any write, dirty stays
    // true for the user to complete, and advisor/set is never called.
    const { remote, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setEnabled(true) // enabled + no provider/model → the KD-S4 gate blocks apply
    expect(store.store.getSnapshot().dirty).toBe(true)
    await store.apply()
    const state = store.store.getSnapshot()
    expect(state.applyState.kind).toBe('error')
    if (state.applyState.kind === 'error' && state.applyState.failure.kind === 'gate') {
      expect(state.applyState.failure.reason).toBe('provider')
    }
    expect(state.dirty).toBe(true) // nothing written, nothing re-seeded — the form stays
    expect(set).not.toHaveBeenCalled()
  })

  it('recomputes dirty in the empty-patch apply branch — a stale seed cannot leave the pill lit (qc3 S-2)', async () => {
    // qc3 S-2 belt-and-braces: the empty-patch apply branch must recompute
    // dirty like every other apply outcome. In every UI-reachable flow the
    // patch is empty only when the draft already equals the seed (dirty
    // false), but the M-7 degraded window can leave the SNAPSHOT dirty=true
    // against a stale seed: a get-failure refresh clobbers `this.seed` to
    // defaults while skipping the dirty recompute (config undefined). A
    // programmatic apply in that window would diff EMPTY against the
    // defaulted seed and report saved while the pill stayed lit.
    const { remote, rpc, get, set } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    // Edit the draft back to the schema defaults (enabled off + cleared pair).
    store.setEnabled(false)
    store.setProvider('') // clears the provider AND the invalidated model
    expect(draftOf(store)).toEqual({ enabled: false, systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 })
    expect(store.store.getSnapshot().dirty).toBe(true) // still differs from the pinned seed
    // The degraded refresh: get fails → `seed` clobbers to defaults and the
    // dirty recompute is skipped → the stale window (snapshot dirty=true).
    get.mockImplementationOnce(() => Promise.resolve(failResult('advisor gateway is not ready')))
    await store.load()
    let state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(false)
    expect(state.dirty).toBe(true) // stale — the recompute was skipped
    // The programmatic apply diff-cleans against the (defaulted) seed → empty
    // patch → saved WITHOUT a call, and the recompute clears the stale pill.
    await store.apply()
    state = store.store.getSnapshot()
    expect(set).not.toHaveBeenCalled()
    expect(state.applyState.kind).toBe('saved')
    expect(state.dirty).toBe(false)
  })
})

describe('read-only apply guard (qc2 W-1 — writable flips mid-session)', () => {
  it('refuses to apply when a refresh flipped writable false while edits are staged (advisor/set never called)', async () => {
    // W-1 store pin: the card fix (saveDisabled carries !writable) covers the
    // UI, but a write must never be issued in an environment the UI declares
    // read-only. A mid-session invalidation refresh can return writable=false
    // while staged edits survive — dirty stays true in read-only, and apply()
    // must refuse instead of issuing the write.
    const { remote, rpc, describe, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setSystemPrompt('review terser')
    expect(store.store.getSnapshot().dirty).toBe(true)
    // The invalidation refresh reports the settings service as read-only now
    // (same scripted config — the staged edits still differ from the host).
    describe.mockReturnValueOnce(Promise.resolve(ok({
      writable: false,
      hasDocument: false,
      namespaces: [deepseekNs(), piAiNs()],
    })))
    await store.load()
    let state = store.store.getSnapshot()
    expect(state.writable).toBe(false)
    expect(state.dirty).toBe(true) // the W-1 reachability: dirty survives read-only
    // The store guard refuses the write: an error state, no advisor/set call.
    await store.apply()
    state = store.store.getSnapshot()
    expect(state.applyState.kind).toBe('error')
    if (state.applyState.kind === 'error' && state.applyState.failure.kind === 'message') {
      expect(state.applyState.failure.message).toContain('read-only')
    }
    expect(set).not.toHaveBeenCalled()
  })
})

describe('card scenario (store-level load/save over the gateway channel)', () => {
  it('runs the card round trip: load → edit → apply → edit → discard → apply (empty diff, no write)', async () => {
    // The store-level mirror of the card interaction: a minimal patch lands on
    // the host, the post-apply reload re-reads the composed config, and after
    // a discard the follow-up apply diffs empty (saved-without-call).
    const { remote, rpc, call, get } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(store.store.getSnapshot().advisorPresent).toBe(true)

    // Card edit: enable + pick provider/model → apply writes the minimal patch.
    store.setEnabled(true)
    store.setProvider('deepseek-official')
    store.setModel('ds-b')
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ enabled: true, provider: 'deepseek-official', model: 'ds-b' })
    expect(get).toHaveBeenCalledTimes(2) // initial load + post-apply reload

    // Edit again, then discard: the draft rewinds to the post-apply seed.
    store.setModel('ds-a')
    expect(draftOf(store).model).toBe('ds-a')
    store.discard()
    expect(draftOf(store).model).toBe('ds-b')

    // Apply after discard: nothing differs from the seed → no second write.
    await store.apply()
    expect(call.mock.calls.filter(callArgs => callArgs[1] === 'advisor/set')).toHaveLength(1)
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
  })
})
