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
 * ③ Apply gate (KD-S4): a missing provider/model blocks the apply with the
 *    gate failure — the gate is UNCONDITIONAL now (no config-level `enabled`
 *    switch since 2026-09-26; the pair is the on/off state).
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
 * ⑧ proseFallback draft field (issue #102 settings sync): the key seeds
 *    from the resolved config (effective default false when the wire omits
 *    it), toggles, and rides the always-list patch semantics (edited keys
 *    are written, untouched keys never churn). The maxTokens field is gone
 *    with the 2026-10-18 budget ruling — the draft carries no budget key.
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
    autoGenerate: true,
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
    autoGenerate: true,
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

/** llm-empty: whole-section profile resolving to an empty section (no models anywhere). */
function emptyNs(): SettingsNamespaceView {
  return { ns: 'llm-empty', autoGenerate: true, schema: {}, value: {}, applies: 'live', secrets: [], revision: 0 }
}

/** llm-emptylist: whole-section profile declaring an EMPTY models list (profile wins, no fallback). */
function emptylistNs(): SettingsNamespaceView {
  return { ns: 'llm-emptylist', autoGenerate: true, schema: {}, value: { models: [] }, applies: 'live', secrets: [], revision: 0 }
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
  modelReasoning: ReturnType<typeof vi.fn>
}

/**
 * Build the scripted wire. `config: null` = the gateway channel is down (get
 * fails) — the C-1/KD-G5 notice path. The fake `set` merges the patch into
 * the effective config exactly like the host gateway (merge → new composed
 * config), so a follow-up get/seed reflects the write. `reasoning` maps a
 * `${provider}\u0000${model}` key to the T2 capability payload served for
 * `advisor/modelReasoning` (absent key → the tagged unavailable error);
 * `reasoningHandler` overrides the record with a custom call-through (deferred
 * resolutions, transport failures).
 */
function scriptedApi(options: {
  config?: AdvisorConfigView | null
  namespaces?: SettingsNamespaceView[]
  entries?: LlmConfigurableProvider[]
  groups?: ModelCatalog['groups']
  writable?: boolean
  reasoning?: Record<string, unknown>
  reasoningHandler?: (args: { provider: string; model: string }) => RpcResult<unknown> | Promise<RpcResult<unknown>>
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
  const modelReasoning = vi.fn((payload: { args: { provider: string; model: string } }) => {
    if (options.reasoningHandler !== undefined) {
      return Promise.resolve(options.reasoningHandler(payload.args))
    }
    const key = `${payload.args.provider}\u0000${payload.args.model}`
    const response = options.reasoning?.[key]
      ?? { error: { tag: 'advisor/model-reasoning-unavailable', message: `test: ${key} declares no reasoning efforts` } }
    return Promise.resolve(okResult(response))
  })
  const call = vi.fn((channel: string, endpoint: string, payload: unknown) => {
    if (channel !== '/api') throw new Error(`test: unexpected channel ${channel}`)
    if (endpoint === 'advisor/get') return get()
    if (endpoint === 'advisor/set') return set(payload as { args: { patch: Record<string, unknown> } })
    if (endpoint === 'advisor/modelReasoning') return modelReasoning(payload as { args: { provider: string; model: string } })
    throw new Error(`test: unexpected endpoint ${endpoint}`)
  })
  return {
    remote: {
      llm: { listConfigurableProviders },
      settings: { describe },
      session: { modelCatalog },
    },
    rpc: { call } as unknown as ClientConnectionRpc,
    call, get, set, describe, listConfigurableProviders, modelCatalog, modelReasoning,
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
      provider: 'deepseek-official',
      model: 'ds-a',
      systemPrompt: '',
      immuneTurns: 3,
      maxDeltaMessages: 60,
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
    })
  })

  it('seeds the draft from the effective config regardless of layer origin (base+user already folded by the host)', async () => {
    // The gateway returns the RESOLVED config — the composition base / user
    // layer split is host-side and invisible here: the form shows the
    // effective values so the fields never lie about what runs. The wire
    // `enabled` stays a read-only fact (the draft cannot write it).
    const { remote, rpc } = scriptedApi({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
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

describe('apply gate (KD-S4 — the pair is required, unconditionally)', () => {
  it('blocks Apply with no provider, naming the gate failure', async () => {
    const { remote, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    await store.apply()
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error') {
      expect(applyState.failure.kind).toBe('gate')
      if (applyState.failure.kind === 'gate') expect(applyState.failure.reason).toBe('provider')
    }
    expect(set).not.toHaveBeenCalled()
  })

  it('blocks Apply with a provider but no model', async () => {
    const { remote, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setProvider('deepseek-official')
    await store.apply()
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error' && applyState.failure.kind === 'gate') {
      expect(applyState.failure.reason).toBe('model')
    }
    expect(set).not.toHaveBeenCalled()
  })

  it('lands the apply once the pair is complete', async () => {
    const { remote, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setProvider('deepseek-official')
    store.setModel('ds-a')
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

  it('blocks a cleared pair the seed pins at the gate (no clear write from the card)', async () => {
    // The seed pins the values; the unconditional KD-S4 gate (no enable switch
    // since 2026-09-26) refuses an incomplete pair, so the '' override the
    // patch layer supports is a DIRTY-DERIVATION fact, never a card-issued
    // write: clearing the provider marks the form dirty (a save would be
    // needed) and the apply is refused until the pair is complete again.
    const { remote, rpc, set } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setProvider('') // clears the provider AND the invalidated model
    expect(store.store.getSnapshot().dirty).toBe(true)
    await store.apply()
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error' && applyState.failure.kind === 'gate') {
      expect(applyState.failure.reason).toBe('provider')
    }
    expect(set).not.toHaveBeenCalled()
  })

  it('keeps earlier writes stable across a second apply (no churn)', async () => {
    // Apply 1 stores the systemPrompt edit; a later apply with a DIFFERENT
    // edit must not re-emit the already-stored key — after the reload the get
    // returns the stored value, the seed no longer differs, and the second
    // patch carries only the new key.
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: 'entry', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setSystemPrompt('edited')
    await store.apply() // Apply 1: stores the systemPrompt edit
    let payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch.systemPrompt).toBe('edited')

    // Apply 2 with a different edit (immuneTurns) carries no systemPrompt
    // key: nothing differs anymore, so nothing is re-written.
    store.setImmuneTurns(9)
    await store.apply()
    const setCalls = call.mock.calls.filter(callArgs => callArgs[1] === 'advisor/set')
    payload = setCalls[1]?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ immuneTurns: 9 })
  })

  it('a cleared provider nothing pins stays clean (nothing stored → no op) and the gate still refuses the apply', async () => {
    // The config does not pin provider/model at all: clearing them writes
    // nothing — there is no stored value to remove (the old unset branch is
    // unreachable through the gateway: the returned config IS the effective
    // view). The unconditional KD-S4 gate then refuses the pairless apply.
    const { remote, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setProvider('')
    expect(store.store.getSnapshot().dirty).toBe(false)
    await store.apply()
    expect(set).not.toHaveBeenCalled()
    const { applyState } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error' && applyState.failure.kind === 'gate') {
      expect(applyState.failure.reason).toBe('provider')
    }
  })

  it('omits a cleared number field from the patch (empty input = leave unchanged)', async () => {
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 5, maxDeltaMessages: 60 },
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
    const { remote, rpc, set } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
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
    store.setProvider('deepseek-official')
    store.setModel('ds-a') // fires the modelReasoning capability call synchronously
    // The Once is registered AFTER the edits so it targets the set call, not
    // the load's get call or the setModel-triggered capability call.
    call.mockRejectedValueOnce(new Error('transport down'))
    await store.apply()
    const { applyState, draft } = store.store.getSnapshot()
    expect(applyState.kind).toBe('error')
    if (applyState.kind === 'error' && applyState.failure.kind === 'message') {
      expect(applyState.failure.message).toBe('transport down')
    }
    // The in-progress draft survives (nothing was written, nothing re-seeded).
    expect(draft.provider).toBe('deepseek-official')
    expect(draft.model).toBe('ds-a')
    expect(describe).toHaveBeenCalledTimes(1)
  })
})

describe('proseFallback draft field (issue #102 settings sync)', () => {
  it('seeds the field from the resolved config (KD-I2)', async () => {
    const { remote, rpc } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60, proseFallback: true },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(draftOf(store).proseFallback).toBe(true)
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it('seeds the effective default (false) when the wire omits the key, staying clean', async () => {
    // A wire without the key is a REAL shape, not a pre-#102 relic: the
    // gateway's S1 containment fallback mirrors a raw entry that omits it
    // (the resolver never ran, so no schema default filled it). The seed
    // shows the effective default and the form opens
    // clean (draft === seed, no invented diff).
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(draftOf(store).proseFallback).toBe(false)
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it('carries no maxTokens draft field (2026-10-18 ruling — the budget is gone from every surface)', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect('maxTokens' in draftOf(store)).toBe(false)
  })

  it('toggles proseFallback in the draft (dirty vs the seed, clean when reverted)', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(draftOf(store).proseFallback).toBe(false)
    store.setProseFallback(true)
    expect(draftOf(store).proseFallback).toBe(true)
    expect(store.store.getSnapshot().dirty).toBe(true)
    store.setProseFallback(false) // back to the seed value → empty diff → clean
    expect(draftOf(store).proseFallback).toBe(false)
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it('writes an edited proseFallback key through the always list', async () => {
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60, proseFallback: false },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setProseFallback(true)
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ proseFallback: true })
  })

  it('keeps an untouched proseFallback out of a partial apply (no churn)', async () => {
    // The always list diffs the key on EVERY apply: an untouched key equals
    // the seed and stays out of the patch (the minimal-patch contract holds).
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60, proseFallback: true },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setSystemPrompt('edited')
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ systemPrompt: 'edited' })
  })
})

describe('nextPrompt draft field (plan dsh-advisor-next-prompt-n12, task 3)', () => {
  it('seeds the field from the resolved config; an absent wire key reads the true default', async () => {
    // src/config.ts normalizes nextPrompt through z.boolean().default(true)
    // — the resolved wire carries the boolean, and a containment fallback
    // that omitted the key still reads the default (never undefined).
    const absent = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const absentStore = new AdvisorSettingsStore(absent.remote, absent.rpc, schema)
    await absentStore.load()
    expect(draftOf(absentStore).nextPrompt).toBe(true)
    expect(absentStore.store.getSnapshot().dirty).toBe(false)

    const explicit = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60, nextPrompt: false },
    })
    const explicitStore = new AdvisorSettingsStore(explicit.remote, explicit.rpc, schema)
    await explicitStore.load()
    expect(draftOf(explicitStore).nextPrompt).toBe(false)
    expect(explicitStore.store.getSnapshot().dirty).toBe(false)
  })

  it('toggles nextPrompt in the draft (dirty vs the seed, clean when reverted)', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(draftOf(store).nextPrompt).toBe(true)
    store.setNextPrompt(false)
    expect(draftOf(store).nextPrompt).toBe(false)
    expect(store.store.getSnapshot().dirty).toBe(true)
    store.setNextPrompt(true) // back to the seed value → empty diff → clean
    expect(draftOf(store).nextPrompt).toBe(true)
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it('writes an edited nextPrompt key through the always list', async () => {
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60, nextPrompt: true },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setNextPrompt(false)
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ nextPrompt: false })
  })

  it('keeps an untouched nextPrompt out of a partial apply (no churn)', async () => {
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60, nextPrompt: true },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setSystemPrompt('edited')
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ systemPrompt: 'edited' })
  })

  it('round-trips a non-default false through save and reload', async () => {
    // The fixture gateway merges the patch and returns the composed config
    // (the host contract): the stored false survives save → reload, and the
    // reloaded draft stays clean against the new seed.
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setNextPrompt(false)
    await store.apply()
    expect(call.mock.calls.some(callArgs => callArgs[1] === 'advisor/set')).toBe(true)
    await store.load() // reload reads the merged config back
    expect(draftOf(store).nextPrompt).toBe(false)
    expect(store.store.getSnapshot().dirty).toBe(false)
  })
})

describe('defaultEnabled draft field (GitHub issue #124)', () => {
  it('seeds true when the wire omits the key and false when it carries an explicit false', async () => {
    // src/config.ts normalizes defaultEnabled to a plain boolean (schema
    // default true); a containment wire that omitted the key still seeds the
    // default rather than inventing the opt-in behavior.
    const absent = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const absentStore = new AdvisorSettingsStore(absent.remote, absent.rpc, schema)
    await absentStore.load()
    expect(draftOf(absentStore).defaultEnabled).toBe(true)
    expect(absentStore.store.getSnapshot().dirty).toBe(false)

    const explicit = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60, defaultEnabled: false },
    })
    const explicitStore = new AdvisorSettingsStore(explicit.remote, explicit.rpc, schema)
    await explicitStore.load()
    expect(draftOf(explicitStore).defaultEnabled).toBe(false)
    expect(explicitStore.store.getSnapshot().dirty).toBe(false)
  })

  it('toggles defaultEnabled in the draft (dirty vs the seed, clean when reverted)', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(draftOf(store).defaultEnabled).toBe(true)
    store.setDefaultEnabled(false)
    expect(draftOf(store).defaultEnabled).toBe(false)
    expect(store.store.getSnapshot().dirty).toBe(true)
    store.setDefaultEnabled(true) // back to the seed value → empty diff → clean
    expect(draftOf(store).defaultEnabled).toBe(true)
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it('writes an edited defaultEnabled key through the always list', async () => {
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60, defaultEnabled: true },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setDefaultEnabled(false)
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ defaultEnabled: false })
  })

  it('round-trips a non-default false through save and reload', async () => {
    const { remote, rpc } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setDefaultEnabled(false)
    await store.apply()
    await store.load() // reload reads the merged config back
    expect(draftOf(store).defaultEnabled).toBe(false)
    expect(store.store.getSnapshot().dirty).toBe(false)
  })

  it('keeps an untouched defaultEnabled out of a partial apply (no churn)', async () => {
    const { remote, rpc, call } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60, defaultEnabled: false },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setSystemPrompt('edited')
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ systemPrompt: 'edited' })
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
    expect(state.draft).toEqual({ systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 })
    // Gateway recovers: the next load seeds the ACTUAL config.
    await store.load()
    state = store.store.getSnapshot()
    expect(state.advisorPresent).toBe(true)
    expect(state.draft).toEqual({
      provider: 'deepseek-official', model: 'ds-a',
      systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20,
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
    })
  })
})

describe('post-apply reload failure (qc3 N-1)', () => {
  it('keeps the saved feedback when the reload after a successful set fails', async () => {
    const { remote, rpc, describe, set } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
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
    store.setSystemPrompt('edited')
    expect(draftOf(store).provider).toBe('openai')
    store.discard()
    // The draft is exactly the seed again — every edited key rewound.
    expect(draftOf(store)).toEqual({
      provider: 'deepseek-official', model: 'ds-a',
      systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20,
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
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
    store.setProvider('openai')
    store.setSystemPrompt('edited')
    store.discard()
    await store.apply()
    expect(set).not.toHaveBeenCalled()
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
    // The empty apply leaves the rewound draft untouched (no re-seed, no re-write).
    expect(draftOf(store)).toEqual({
      provider: 'deepseek-official', model: 'ds-a',
      systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60,
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
    })
  })

  it('clears a pending gate-error apply state back to idle', async () => {
    const { remote, rpc } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    await store.apply() // no provider/model → the KD-S4 gate blocks Apply
    await store.apply()
    expect(store.store.getSnapshot().applyState.kind).toBe('error')
    store.discard()
    expect(store.store.getSnapshot().applyState.kind).toBe('idle')
  })

  it('clears the saved feedback back to idle after a landed apply (discard is a no-op on values)', async () => {
    const { remote, rpc } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
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
    // The rewind target is the default (failed-get) seed — the effective
    // defaults view, still inventing NO provider/model (the gate/wipe hazard
    // this pin guards); the recovery below must still seed the REAL config.
    expect(draftOf(store)).toEqual({ systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60, proseFallback: false, nextPrompt: true, defaultEnabled: true })
    await store.load()
    expect(store.store.getSnapshot().advisorPresent).toBe(true)
    expect(draftOf(store)).toEqual({
      provider: 'deepseek-official', model: 'ds-a',
      systemPrompt: 'entry', immuneTurns: 7, maxDeltaMessages: 20,
      proseFallback: false,
      nextPrompt: true,
      defaultEnabled: true,
    })
  })
})

describe('dirty derivation (plan dsh-advisor-plugin-config-card-ux, task 2 — KD-U2)', () => {
  it('tracks the dirty lifecycle: clean → edit dirty → discard clean → edit → apply success clean', async () => {
    const { remote, rpc } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
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
    // The unconditional KD-S4 gate refuses to APPLY a cleared pair, but the
    // dirty derivation itself only diffs the draft against the seed: the
    // clear is a staged edit (a save would be needed once the pair is
    // complete again) and must read dirty.
    store.setProvider('') // patchFor emits provider: '' → a real write → dirty
    expect(store.store.getSnapshot().dirty).toBe(true)
  })

  it("derives dirty from the '' provider override alone (M-6 isolation)", async () => {
    // The sibling test clears a provider whose seed also pins a model; this
    // variant isolates the ''-provider semantic: the seed pins NO model, so
    // the resulting patch is exactly { provider: '' } → dirty derives true
    // from that alone.
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

  it('keeps the draft dirty when the client gate blocks apply (an incomplete pair never writes) (S-3 pin)', async () => {
    // qc2 S-3 (deferred — plan Risks, 2026-08-12), restated for the
    // unconditional gate: the host force-down (resolved enabled:false +
    // disabledReason) is reachable only if a patch the client gate would
    // block still reaches the host. This pin documents that such a patch
    // cannot be produced from the card: an incomplete provider/model pair is
    // blocked by the gate BEFORE any write, dirty stays true for the user to
    // complete, and advisor/set is never called.
    const { remote, rpc, set } = scriptedApi()
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(store.store.getSnapshot().dirty).toBe(false)
    store.setProvider('deepseek-official') // provider set, model still missing → gate blocks
    expect(store.store.getSnapshot().dirty).toBe(true)
    await store.apply()
    const state = store.store.getSnapshot()
    expect(state.applyState.kind).toBe('error')
    if (state.applyState.kind === 'error' && state.applyState.failure.kind === 'gate') {
      expect(state.applyState.failure.reason).toBe('model')
    }
    expect(state.dirty).toBe(true) // nothing written, nothing re-seeded — the form stays
    expect(set).not.toHaveBeenCalled()
  })

  it('recomputes dirty in the empty-patch apply branch — an immediate re-apply after a landed save stays clean (qc3 S-2 restated)', async () => {
    // qc3 S-2 belt-and-braces: the empty-patch apply branch must recompute
    // dirty like every other apply outcome. The original M-7 stale window (a
    // get-failure refresh clobbers the seed to defaults while skipping the
    // dirty recompute) can no longer reach this branch — the defaulted seed
    // pairs with a pairless draft, which the unconditional KD-S4 gate refuses
    // before the patch diff. The surviving reachable path: a draft exactly
    // equal to a pair-pinning seed (right after a landed save), where the
    // empty branch must still recompute and stay clean.
    const { remote, rpc, get, set } = scriptedApi({
      config: { enabled: true, provider: 'x', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    // Edit the draft and apply — the write lands and the returned config
    // (with the pair) is adopted as the seed.
    store.setSystemPrompt('edited')
    await store.apply()
    expect(set).toHaveBeenCalledTimes(1)
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
    expect(store.store.getSnapshot().dirty).toBe(false)
    // An immediate re-apply: the draft equals the adopted seed → EMPTY patch →
    // saved WITHOUT a call, and the branch recomputes dirty (stays clean).
    await store.apply()
    expect(set).toHaveBeenCalledTimes(1)
    const state = store.store.getSnapshot()
    expect(state.applyState.kind).toBe('saved')
    expect(state.dirty).toBe(false)
    expect(draftOf(store).provider).toBe('x') // the draft was never touched
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

    // Card edit: pick provider/model → apply writes the minimal patch.
    store.setProvider('deepseek-official')
    store.setModel('ds-b')
    await store.apply()
    const payload = call.mock.calls.find(callArgs => callArgs[1] === 'advisor/set')?.[2] as { args: { patch: Record<string, unknown> } }
    expect(payload.args.patch).toEqual({ provider: 'deepseek-official', model: 'ds-b' })
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

describe('thinking-effort capability (plan dsh-advisor-reasoning-effort, task 3)', () => {
  const EFFORTS = { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'Deep' }] }
  const KEY = 'deepseek-official\u0000ds-a'
  const PAIRED = { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 }

  it('fetches the capability once for the stored pair after load and caches it by key', async () => {
    const { remote, rpc, modelReasoning } = scriptedApi({ config: { ...PAIRED }, reasoning: { [KEY]: EFFORTS } })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(modelReasoning).toHaveBeenCalledTimes(1)
    expect(modelReasoning).toHaveBeenCalledWith({ args: { provider: 'deepseek-official', model: 'ds-a' } })
    await store.ensureModelReasoning('deepseek-official', 'ds-a') // cached — no refetch
    const state = store.store.getSnapshot()
    expect(state.modelReasoningState[KEY]).toBe('ready')
    expect(state.modelReasoning[KEY]).toEqual(EFFORTS.efforts)
    expect(modelReasoning).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight capability fetch per key', async () => {
    let release!: (value: RpcResult<unknown>) => void
    const gate = new Promise<RpcResult<unknown>>((resolve) => { release = resolve })
    const { remote, rpc, modelReasoning } = scriptedApi({ reasoningHandler: () => gate })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    const first = store.ensureModelReasoning('p', 'm')
    const second = store.ensureModelReasoning('p', 'm')
    expect(modelReasoning).toHaveBeenCalledTimes(1)
    release(okResult({ efforts: [{ id: 'low', name: 'Low' }] }))
    await first
    await second
    expect(store.store.getSnapshot().modelReasoningState['p\u0000m']).toBe('ready')
    expect(store.store.getSnapshot().modelReasoning['p\u0000m']).toEqual([{ id: 'low', name: 'Low' }])
  })

  it('a model switch resolves the new key and keeps the previous key cached', async () => {
    const keyB = 'deepseek-official\u0000ds-b'
    const { remote, rpc, modelReasoning } = scriptedApi({
      config: { ...PAIRED },
      reasoning: { [KEY]: EFFORTS, [keyB]: { efforts: [{ id: 'off', name: 'Off' }] } },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setModel('ds-b')
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().modelReasoningState[keyB]).toBe('ready')
    })
    expect(modelReasoning).toHaveBeenCalledTimes(2)
    const state = store.store.getSnapshot()
    expect(state.modelReasoning[KEY]).toEqual(EFFORTS.efforts)
    expect(state.modelReasoning[keyB]).toEqual([{ id: 'off', name: 'Off' }])
  })

  it('re-resolves the preserved draft pair on a load() invalidation (draft on B, seed on A — R1)', async () => {
    // task-3 review R1: seed A, the draft switches to B, then a pushed
    // invalidation reloads BEFORE the save — the host config still identifies
    // A while the draft intentionally stays on B. The reload clears every
    // capability entry, so load() must re-resolve BOTH the seed pair (the
    // Discard target) and the preserved draft pair.
    const keyB = 'deepseek-official\u0000ds-b'
    const { remote, rpc, modelReasoning } = scriptedApi({
      config: { ...PAIRED },
      reasoning: {
        [KEY]: { efforts: [{ id: 'low', name: 'Low' }] },
        [keyB]: { efforts: [{ id: 'high', name: 'High' }] },
      },
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setModel('ds-b')
    await vi.waitFor(() => {
      expect(store.store.getSnapshot().modelReasoningState[keyB]).toBe('ready')
    })
    expect(draftOf(store).model).toBe('ds-b')

    await store.load()
    await vi.waitFor(() => {
      const state = store.store.getSnapshot()
      expect(state.modelReasoningState[KEY]).toBe('ready')
      expect(state.modelReasoningState[keyB]).toBe('ready')
    })
    expect(draftOf(store).model).toBe('ds-b') // the draft edit survives
    expect(modelReasoning).toHaveBeenCalledTimes(4) // A, B, then A + B again
    const state = store.store.getSnapshot()
    expect(state.modelReasoning[KEY]).toEqual([{ id: 'low', name: 'Low' }])
    expect(state.modelReasoning[keyB]).toEqual([{ id: 'high', name: 'High' }])
  })

  it('marks the capability unavailable on the definitive no-efforts verdict without polluting the options', async () => {
    const { remote, rpc } = scriptedApi({ config: { ...PAIRED } }) // no reasoning record → tagged unavailable
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.modelReasoningState[KEY]).toBe('unavailable')
    expect(Object.hasOwn(state.modelReasoning, KEY)).toBe(false)
  })

  it('latches nothing on a lookup failure: a -failed tag, a transport failure and a throw all leave no state entry', async () => {
    // Only the DEFINITIVE `advisor/model-reasoning-unavailable` tag is a
    // verdict: a failure must not render as a permanent "declares nothing" —
    // the marker is dropped so the next ensureModelReasoning re-probes (the
    // runtime side of this plan never caches a resolution failure either).
    let answer: RpcResult<unknown> = okResult({
      error: { tag: 'advisor/model-reasoning-failed', message: 'capability lookup blew up' },
    })
    const { remote, rpc, modelReasoning } = scriptedApi({
      config: { ...PAIRED },
      reasoningHandler: () => answer,
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.ensureModelReasoning('deepseek-official', 'ds-a')
    expect(modelReasoning).toHaveBeenCalledTimes(1)
    expect(Object.hasOwn(store.store.getSnapshot().modelReasoningState, KEY)).toBe(false)
    expect(Object.hasOwn(store.store.getSnapshot().modelReasoning, KEY)).toBe(false)

    // …so the next probe runs again (nothing latched) and can now resolve.
    answer = okResult({ efforts: [{ id: 'low', name: 'Low' }] })
    await store.ensureModelReasoning('deepseek-official', 'ds-a')
    expect(modelReasoning).toHaveBeenCalledTimes(2)
    expect(store.store.getSnapshot().modelReasoningState[KEY]).toBe('ready')

    const failing = scriptedApi({ config: { ...PAIRED }, reasoningHandler: () => failResult('capability channel down') })
    const store2 = new AdvisorSettingsStore(failing.remote, failing.rpc, schema)
    await store2.ensureModelReasoning('deepseek-official', 'ds-a')
    expect(Object.hasOwn(store2.store.getSnapshot().modelReasoningState, KEY)).toBe(false)
    expect(Object.hasOwn(store2.store.getSnapshot().modelReasoning, KEY)).toBe(false)

    const throwing = scriptedApi({
      config: { ...PAIRED },
      reasoningHandler: () => { throw new Error('capability lookup blew up') },
    })
    const store3 = new AdvisorSettingsStore(throwing.remote, throwing.rpc, schema)
    await store3.ensureModelReasoning('deepseek-official', 'ds-a')
    expect(Object.hasOwn(store3.store.getSnapshot().modelReasoningState, KEY)).toBe(false)
    expect(Object.hasOwn(store3.store.getSnapshot().modelReasoning, KEY)).toBe(false)
  })

  it('load() invalidates the capability caches and refetches the stored pair', async () => {
    const { remote, rpc, modelReasoning } = scriptedApi({ config: { ...PAIRED }, reasoning: { [KEY]: EFFORTS } })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(store.store.getSnapshot().modelReasoningState[KEY]).toBe('ready')
    expect(modelReasoning).toHaveBeenCalledTimes(1)
    await store.load()
    expect(modelReasoning).toHaveBeenCalledTimes(2)
    expect(store.store.getSnapshot().modelReasoningState[KEY]).toBe('ready')
    expect(store.store.getSnapshot().modelReasoning[KEY]).toEqual(EFFORTS.efforts)
  })

  it('a fetch started before a load() invalidation caches nothing (mid-flight staleness)', async () => {
    const pending: Array<(value: RpcResult<unknown>) => void> = []
    const { remote, rpc } = scriptedApi({
      config: { ...PAIRED },
      reasoningHandler: () => new Promise<RpcResult<unknown>>((resolve) => { pending.push(resolve) }),
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(store.store.getSnapshot().modelReasoningState[KEY]).toBe('loading')
    const reloading = store.load()
    await vi.waitFor(() => { expect(pending).toHaveLength(2) })
    // The stale fetch (started before the invalidation) resolves first: it
    // must not cache into the cleared state.
    pending[0]!(okResult({ efforts: [{ id: 'stale', name: 'Stale' }] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(Object.hasOwn(store.store.getSnapshot().modelReasoning, KEY)).toBe(false)
    expect(store.store.getSnapshot().modelReasoningState[KEY]).toBe('loading')
    pending[1]!(okResult({ efforts: [{ id: 'fresh', name: 'Fresh' }] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.store.getSnapshot().modelReasoning[KEY]).toEqual([{ id: 'fresh', name: 'Fresh' }])
    expect(store.store.getSnapshot().modelReasoningState[KEY]).toBe('ready')
    await reloading
  })

  it('a stale settle leaves a successor in-flight marker alone (qc3 S-1)', async () => {
    // Timeline: fetch A is still in flight when load() clears the in-flight
    // map and registers fetch B for the SAME key; A then settles stale and
    // must not clear B's marker. The marker is the invariant under test —
    // B's 'loading' state already forces a later call to return early, so the
    // private dedupe map is read directly (no public readback exists).
    const pending: Array<(value: RpcResult<unknown>) => void> = []
    const { remote, rpc, modelReasoning } = scriptedApi({
      config: { ...PAIRED },
      reasoningHandler: () => new Promise<RpcResult<unknown>>((resolve) => { pending.push(resolve) }),
    })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load() // fetch A — never settles until released below
    const inflight = (store as unknown as { inflightReasoning: Map<string, Promise<void>> }).inflightReasoning
    const fetchA = inflight.get(KEY)
    await store.load() // clears the map, then registers fetch B for the same key
    const fetchB = inflight.get(KEY)
    expect(pending).toHaveLength(2)
    expect(fetchB).not.toBe(fetchA)

    pending[0]!(okResult({ efforts: [{ id: 'stale', name: 'Stale' }] })) // A settles stale
    await fetchA
    expect(inflight.get(KEY)).toBe(fetchB) // B's marker survives A's stale settle

    pending[1]!(okResult({ efforts: [{ id: 'fresh', name: 'Fresh' }] }))
    await fetchB
    expect(modelReasoning).toHaveBeenCalledTimes(2) // no duplicate read-only RPC
    expect(store.store.getSnapshot().modelReasoning[KEY]).toEqual([{ id: 'fresh', name: 'Fresh' }])
  })

  it('seeds the draft reasoningEffort from the resolved config; an absent key reads as automatic', async () => {
    const seeded = scriptedApi({ config: { ...PAIRED, reasoningEffort: 'low' } })
    const store = new AdvisorSettingsStore(seeded.remote, seeded.rpc, schema)
    await store.load()
    expect(draftOf(store).reasoningEffort).toBe('low')

    const plain = scriptedApi({ config: { ...PAIRED } })
    const store2 = new AdvisorSettingsStore(plain.remote, plain.rpc, schema)
    await store2.load()
    expect(draftOf(store2).reasoningEffort).toBeUndefined()
  })

  it('writes an edited reasoningEffort key through the patch', async () => {
    const { remote, rpc, call } = scriptedApi({ config: { ...PAIRED } })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setReasoningEffort('high')
    expect(store.store.getSnapshot().dirty).toBe(true)
    await store.apply()
    expect(call).toHaveBeenCalledWith('/api', 'advisor/set', {
      args: { patch: { reasoningEffort: 'high' } },
    })
  })

  it("writes an explicit '' when the draft clears a seeded reasoningEffort", async () => {
    const { remote, rpc, call } = scriptedApi({ config: { ...PAIRED, reasoningEffort: 'high' } })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    expect(draftOf(store).reasoningEffort).toBe('high')
    store.setReasoningEffort('') // '' = automatic
    expect(store.store.getSnapshot().dirty).toBe(true)
    await store.apply()
    expect(call).toHaveBeenCalledWith('/api', 'advisor/set', {
      args: { patch: { reasoningEffort: '' } },
    })
  })

  it('stays clean when the auto selection matches an unseeded config (no churn)', async () => {
    const { remote, rpc, set } = scriptedApi({ config: { ...PAIRED } })
    const store = new AdvisorSettingsStore(remote, rpc, schema)
    await store.load()
    store.setReasoningEffort('')
    expect(store.store.getSnapshot().dirty).toBe(false)
    await store.apply()
    expect(set).not.toHaveBeenCalled()
    expect(store.store.getSnapshot().applyState.kind).toBe('saved')
  })
})
