// @vitest-environment jsdom
/**
 * Advisor settings card (plan dsh-advisor-plugin-config-card-ux, task 1;
 * flat rebuild 2026-09-26 — plan dsh-advisor-web-config-flat-n10) — component
 * behavior over a scripted wire face (fake `settings`/`llm` api for the
 * provider directory + a fake connection RPC caller for the `advisor` gateway
 * channel), mirroring the dsh-private ui-models component specs (preloaded
 * store + @testing-library/react). The layout is the official settings-page
 * language: NO collapsible box. The page renders the plugin title/description
 * above the card (the locale meta files), so the fields tile directly —
 * provider select, model select (ALWAYS rendered: the config-level `enabled`
 * switch is gone, the row toggle is the switch), system-prompt textarea
 * (placeholder = the built-in reviewer prompt), the proseFallback checkbox and
 * the number inputs (immuneTurns / maxDeltaMessages / maxTokens) —
 * then the footer with the failed message + Discard/Save (upstream disabled
 * semantics: save = `!dirty || invalid || saving`, discard = `!dirty ||
 * saving`; save additionally carries `!writable`). Degraded / error states
 * render their notice/error + retry as always-on flat blocks (KD-U3, AC-3) —
 * there is no derived-open disclosure left, so nothing can hide them.
 *
 * The advisor config is NOT part of `settings.describe` — the card
 * reads/writes it through `rpc.call('/api', 'advisor/get' | 'advisor/set')`
 * (KD-G3). The fake rpc carries the effective config and applies patches the
 * way the host gateway does (merge → return the new composed config).
 *
 * Registration surface (KD-1): `apply` registers the card into the
 * `plugins.bundle.config` keyed slot ledger (key 'dsh-advisor' — the bundle
 * package name the Plugins page dispatches, locale 'settings.advisor') with a
 * business-face-only inject (controller + the `hooks.snapshot` store — no
 * `t`); the old `settings.section` advisor registration is gone, so the
 * section ledger never holds an advisor entry (nav removal regression).
 *
 * Note on the dev-time `bindSnapshotSelector` stand-in: the host renderer
 * binds the card's `hooks.snapshot` store to its `useSnapshot` prop inside
 * ui-renderer (not importable from a spec); the stub here reproduces the
 * same hook shape by reading the current snapshot per render (no uSES
 * subscription), so assertions after a store mutation re-render the card
 * explicitly (`rerender`), exactly like the ui-models specs do.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ClientConnectionRpc, RpcResult,
} from '@deepseek-ai/dsh-client-connection/client'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm/types'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { fakeSchema } from './support/schema-ops'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { AdvisorCard } from '../src/client/advisor-card'
import type { AdvisorCardProps } from '../src/client/advisor-card'
import { AdvisorSettingsStore, refreshIfLoaded } from '../src/client/advisor-store'
import type { AdvisorConfigView, AdvisorSettingsState, AdvisorStoreRemote } from '../src/client/advisor-store'
import { apply, inject } from '../src/client/index'
import { en, zh } from '../src/client/locales'
import { DEFAULT_ADVISOR_SYSTEM_PROMPT } from '../src/prompts'

afterEach(cleanup)

/** Real settings schema service (immutable path writers under test). */
const schema = fakeSchema()

/**
 * Dev-time stand-in for the renderer's hooks binding (see the header note):
 * a selector hook reading the current snapshot per render, no subscription.
 */
function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> {
  return (sel) => sel(w.getSnapshot())
}

// The synthesized `t` seat's key domain is the namespace dictionary union
// plus the shared `common` vocabulary; the specs only ever call the card's
// own keys, so the en-lookup casts the key.
const t: AdvisorCardProps['t'] = key => en[key as keyof typeof en]

/**
 * Full card props the renderer would bind: the registrant's business inject
 * face (controller + useSnapshot), the framework-synthesized `t` seat, and the
 * owner's `view` — ui-plugin-manager renders `plugins.bundle.config` with
 * `view: 'page'` only. The global standard seat (`useWorkspaces` — merged
 * into GlobalStandardProps by ui-conversation, whose SlotMap types this
 * program pulls for the B2 session-header registration) is a never-called
 * stub: the card never reads it.
 */
function cardProps(controller: AdvisorSettingsStore, useSnapshot: SnapshotSelectorHook<AdvisorSettingsState>): AdvisorCardProps {
  return {
    controller,
    useSnapshot,
    t,
    view: 'page',
    useWorkspaces: (() => undefined) as never,
  }
}

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One gateway RPC success (the channel returns the unwrapped result, not the envelope). */
function okResult<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

/** One gateway RPC failure (business rejection or transport fold). */
function failResult(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/** The wire config the gateway returns when nothing is configured. */
function defaultConfig(): AdvisorConfigView {
  return { enabled: false, systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 }
}

/** A complete, gate-passing wire config (the pair is required — no switch). */
function pairedConfig(): AdvisorConfigView {
  return { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 }
}

const DEEPSEEK: LlmConfigurableProvider = {
  provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [],
}
const OPENAI: LlmConfigurableProvider = {
  provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'],
}
const ZOMBIE: LlmConfigurableProvider = {
  provider: 'zombie', displayName: 'zombie', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zombie'],
}

function deepseekNs(): SettingsNamespaceView {
  return {
    ns: 'llm-deepseek', autoGenerate: true, schema: {}, applies: 'live', secrets: [], revision: 0,
    value: {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'ds-a', name: 'DeepSeek A' }, { id: 'ds-b', name: 'DeepSeek B' }],
    },
  }
}

function piAiNs(): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai', autoGenerate: true, schema: {}, applies: 'live', secrets: [], revision: 0,
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
  }
}

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
 * A scripted wire face: the Remote assembly's `settings.describe` carries
 * ONLY the provider namespaces (the advisor namespace is off the exposed set
 * — the gateway channel replaces it), and the fake `rpc.call` serves the
 * `advisor/get` + `advisor/set` endpoints against a mutable effective config.
 * `config: null` = the gateway is unreachable (get fails) — the C-1/KD-G5
 * notice path.
 */
function scriptedApi(options: {
  config?: AdvisorConfigView | null
  namespaces?: SettingsNamespaceView[]
  entries?: LlmConfigurableProvider[]
  groups?: ModelCatalog['groups']
  writable?: boolean
} = {}): Scripted {
  const others = options.namespaces ?? [deepseekNs(), piAiNs()]
  const entries = options.entries ?? [DEEPSEEK, OPENAI, ZOMBIE]
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
    groups: options.groups ?? [],
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

/** Preload the store, then render the card (ui-models spec pattern). */
async function mountCard(options: Parameters<typeof scriptedApi>[0] = {}, preload = true) {
  const scripted = scriptedApi(options)
  const controller = new AdvisorSettingsStore(scripted.remote, scripted.rpc, schema)
  if (preload) await controller.load()
  const props = cardProps(controller, bindSnapshotSelector(controller.store))
  const view = render(<AdvisorCard {...props} />)
  return { view, controller, scripted, props }
}

/**
 * A minimal fake of the client slots service + context for the registration
 * ledger test: `inject(name, generator)` runs the generator and records every
 * `register` call (the real runtime does the same through ctx.effect), and
 * `ctx.get('connection')` serves the scripted wire face. The `remote` service
 * mirrors the client assembly's generated namespace surface + forwarded Host
 * invalidation face (plan 003: `ctx.remote.$on` with
 * `settings/document-updated` + `llm/adapters-updated`, probe of
 * API_REMOTE_FORWARDED_EVENTS in @deepseek-ai/dsh-api-remotes). Everything
 * else the plugin's apply touches (locale register, connection/reset) is
 * recorded but inert.
 */
function fakeRuntime(scripted: Scripted) {
  interface LedgerRow { name: string; options: Record<string, unknown>; component: unknown }
  const ledger: Record<string, LedgerRow[]> = {}
  const disposers: Array<() => void> = []
  const effectDisposers: Array<() => void> = []
  const locales: Record<string, unknown> = {}
  const resetHandlers = new Set<() => void>()
  const remoteHandlers: Record<string, Set<() => void>> = {}
  // The generated namespace surface (rc.1 dotted contract): each Remote
  // namespace is a child-fiber service named `remote.<ns>` (upstream
  // `remoteServiceKey`), so the fixture provides them as separate dotted
  // services — the declared injects resolve exactly like production. The
  // assembly face forwards `remote.llm` etc. to the dotted services (mirror
  // of the traceable proxy: `ctx.remote.llm` → `ctx['remote.llm']`).
  const services: Record<string, unknown> = {
    'remote.llm': { listConfigurableProviders: scripted.listConfigurableProviders },
    'remote.settings': { describe: scripted.describe },
    'remote.session': { modelCatalog: scripted.modelCatalog },
  }
  const remote = {
    $on: (event: string, handler: () => void): (() => void) => {
      ;(remoteHandlers[event] ??= new Set()).add(handler)
      return () => { remoteHandlers[event]?.delete(handler) }
    },
    get llm() { return services['remote.llm'] },
    get settings() { return services['remote.settings'] },
    get session() { return services['remote.session'] },
  }
  const slots = {
    register: (options: Record<string, unknown>, component: unknown): (() => void) => {
      const name = options.name as string
      ;(ledger[name] ??= []).push({ name, options, component })
      return () => {}
    },
    inject: (name: string, callback: () => Iterable<() => void>): (() => void) => {
      // The runtime iterates the generator transactionally; the yields are
      // the register disposers. The register calls themselves already filled
      // the ledger.
      for (const dispose of callback()) disposers.push(dispose)
      return () => { for (const dispose of disposers.splice(0)) dispose() }
    },
  }
  const ctx = {
    settingsSchema: schema,
    slots,
    remote,
    locale: {
      register: (ns: string, dict: unknown): (() => void) => {
        locales[ns] = dict
        return () => { delete locales[ns] }
      },
      bind: (): never => { throw new Error('test: apply must not bind t — the card t seat comes from PropsLocale') },
    },
    get: (key: string): unknown => {
      if (key === 'connection') return { rpc: scripted.rpc }
      return services[key]
    },
    effect: (fn: () => unknown): (() => void) => {
      const disposer = fn()
      const stop = typeof disposer === 'function' ? disposer as () => void : () => {}
      effectDisposers.push(stop)
      return stop
    },
    on: (event: string, handler: () => void): (() => void) => {
      if (event !== 'connection/reset') throw new Error(`test: unexpected event ${event}`)
      resetHandlers.add(handler)
      return () => { resetHandlers.delete(handler) }
    },
  }
  /** Fire one forwarded Host event into the remote subscription table. */
  const fireRemote = (event: string): void => {
    for (const handler of remoteHandlers[event] ?? []) handler()
  }
  return { ctx, ledger, locales, resetHandlers, remoteHandlers, effectDisposers, fireRemote }
}

describe('AdvisorCard registration (plugins.bundle.config)', () => {
  it('declares the dotted remote namespace injects (rc.1 contract)', () => {
    // Regression pin (upstream apply.client.spec.ts asserts the array
    // literally): each client Remote namespace is a child-fiber service
    // named `remote.<ns>`; without the dotted names the fiber walk throws
    // `cannot get property "remote.llm" without inject` at card load.
    expect(inject).toEqual([
      'slots', 'locale', 'connection', 'settingsSchema', 'remote',
      'remote.llm', 'remote.settings', 'remote.session',
    ])
  })

  it('registers the advisor card and leaves no advisor entry in settings.section', () => {
    const scripted = scriptedApi()
    const { ctx, ledger, locales } = fakeRuntime(scripted)
    apply(ctx as unknown as ClientContext)

    // The card ledger holds exactly one advisor card.
    const cards = ledger['plugins.bundle.config'] ?? []
    expect(cards).toHaveLength(1)
    // Keyed slot: `key` is the bundle package name the Plugins page
    // dispatches (`entryKey = pkg.name`); the old list-slot `id` / `order`
    // options must be absent.
    expect(cards[0].options.key).toBe('dsh-advisor')
    expect(cards[0].options).not.toHaveProperty('id')
    expect(cards[0].options).not.toHaveProperty('order')
    expect(cards[0].options.locale).toBe('settings.advisor')
    expect(cards[0].component).toBe(AdvisorCard)
    // Inject face carries the business surface only — the typed `t` seat is
    // synthesized by the renderer from `locale:` (KD-1), never injected.
    const face = (cards[0].options.inject as () => object)()
    expect(typeof (face as { controller: unknown }).controller).toBe('object')
    // Hooks compartment: the bare store rides `hooks.snapshot` and the
    // renderer binds it to the component's `useSnapshot` selector hook.
    const hooks = (face as { hooks: { snapshot: unknown } }).hooks
    expect(typeof hooks.snapshot).toBe('object')
    expect(typeof (hooks.snapshot as { subscribe: unknown }).subscribe).toBe('function')
    expect(face).not.toHaveProperty('useSnapshot')
    expect(face).not.toHaveProperty('t')

    // The old section registration is gone (nav removal regression): the
    // section ledger holds no advisor entry at all.
    const sections = ledger['settings.section'] ?? []
    expect(sections.some(entry => entry.options.id === 'advisor')).toBe(false)
    expect(sections).toHaveLength(0)

    // The dictionary namespace registers with the en/zh pair.
    expect(locales['settings.advisor']).toEqual({ zh, en })
  })
})

describe('AdvisorCard invalidation refresh (plan 003 / residual R3)', () => {
  /** Run apply, then hand back the injected controller (the open card surface). */
  function applyAndController(scripted: Scripted) {
    const runtime = fakeRuntime(scripted)
    apply(runtime.ctx as unknown as ClientContext)
    const cards = runtime.ledger['plugins.bundle.config'] ?? []
    const inject = cards[0].options.inject as () => object
    const face = inject() as { controller: AdvisorSettingsStore }
    return { ...runtime, controller: face.controller }
  }

  it('subscribes both granular remote events and refreshes a loaded store, coalescing bursts', async () => {
    const scripted = scriptedApi()
    const { controller, remoteHandlers, resetHandlers, fireRemote } = applyAndController(scripted)

    // Dual-plane registration: both forwarded Host events on the remote face
    // plus the connection/reset fallback (the 20260811 vocabulary removal
    // note — plan 003 probe: API_REMOTE_FORWARDED_EVENTS).
    expect(remoteHandlers['settings/document-updated']?.size).toBe(1)
    expect(remoteHandlers['llm/adapters-updated']?.size).toBe(1)
    expect(resetHandlers.size).toBe(1)

    // First load (the card opens) — then a same-host burst of invalidations
    // (e.g. the Models page edits a provider section AND a model) coalesces
    // into ONE refetch via the microtask debounce.
    await controller.load()
    expect(scripted.describe).toHaveBeenCalledTimes(1)
    fireRemote('settings/document-updated')
    fireRemote('llm/adapters-updated')
    await vi.waitFor(() => expect(scripted.describe).toHaveBeenCalledTimes(2))

    // A later, separately-ticked granular event (a new model added on the
    // Models page) refreshes again — each event keeps its own refresh.
    fireRemote('llm/adapters-updated')
    await vi.waitFor(() => expect(scripted.describe).toHaveBeenCalledTimes(3))
    fireRemote('settings/document-updated')
    await vi.waitFor(() => expect(scripted.describe).toHaveBeenCalledTimes(4))

    // The connection/reset plane refreshes too when the remote service IS
    // mounted — reset and granular events both converge under a
    // remote-present assembly (dual-plane lock).
    for (const handler of resetHandlers) handler()
    await vi.waitFor(() => expect(scripted.describe).toHaveBeenCalledTimes(5))
  })

  it('does not fetch before the first load (an unopened card stays idle)', async () => {
    const scripted = scriptedApi()
    const { fireRemote } = applyAndController(scripted)
    fireRemote('settings/document-updated')
    fireRemote('llm/adapters-updated')
    await Promise.resolve()
    expect(scripted.describe).not.toHaveBeenCalled()
  })

  it('empties the remote/reset handler sets when the effect disposer runs (teardown)', () => {
    const scripted = scriptedApi()
    const { effectDisposers, remoteHandlers, resetHandlers } = applyAndController(scripted)

    // Precondition: both planes are registered before teardown.
    expect(remoteHandlers['settings/document-updated']?.size).toBe(1)
    expect(remoteHandlers['llm/adapters-updated']?.size).toBe(1)
    expect(resetHandlers.size).toBe(1)

    // Run the effect disposer (apply teardown) — every registration leaves
    // the subscription tables, so later host events reach no handler.
    for (const dispose of effectDisposers) dispose()

    expect(remoteHandlers['settings/document-updated']?.size ?? 0).toBe(0)
    expect(remoteHandlers['llm/adapters-updated']?.size ?? 0).toBe(0)
    expect(resetHandlers.size).toBe(0)
  })
})

describe('AdvisorCard flat layout (official settings-page language)', () => {
  it('tiles the form directly: no header, no disclosure, no enable checkbox', async () => {
    const { view } = await mountCard()
    // Flat: the fields render without any interaction — no disclosure chrome
    // of any kind (nothing to expand), no enable checkbox (the config-level
    // switch is gone; the row toggle is the switch), and provider/model are
    // ALWAYS present.
    expect(view.container.querySelector('[aria-expanded]')).toBeNull()
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
    expect(screen.getByLabelText(en.model)).toBeTruthy()
    expect(screen.getByLabelText(en.systemPrompt)).toBeTruthy()
    expect(screen.getByLabelText(en.immuneTurns)).toBeTruthy()
    expect(screen.getByLabelText(en.maxDeltaMessages)).toBeTruthy()
    expect(screen.getByLabelText(en.maxTokens)).toBeTruthy()
    expect(screen.getByLabelText(en.proseFallback)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.save })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.discard })).toBeTruthy()
    // The hint under the textarea carries the leave-empty contract; the new
    // issue #102 fields carry their tuning hints.
    expect(screen.getByText(en.systemPromptHint)).toBeTruthy()
    expect(screen.getByText(en.maxTokensHint)).toBeTruthy()
    expect(screen.getByText(en.proseFallbackHint)).toBeTruthy()
    // The proseFallback toggle is the ONLY checkbox (the config-level
    // `enabled` switch is gone — the row toggle is the master switch).
    expect(view.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
  })

  it('renders nothing while the first load is in flight (no chrome to hold the space)', async () => {
    const { view, controller, props } = await mountCard({}, false)
    // Idle → the mount triggers load() and the flat card renders null until
    // the snapshot settles (KD-U3's empty body died with the chrome).
    expect(view.container.textContent).toBe('')
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
  })

  it('disables Save and Discard when clean, enables both once the draft is dirty', async () => {
    // A gate-passing seed (complete pair): the dirty terms are the only
    // blockers, so the upstream semantics are observable in isolation.
    const { view, props } = await mountCard({ config: pairedConfig() })
    // Clean (no edits): neither action is offered (upstream semantics —
    // save = !dirty || invalid || saving; discard = !dirty || saving).
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: en.discard }) as HTMLButtonElement).disabled).toBe(true)
    // One staged edit → both actions become available.
    fireEvent.change(screen.getByLabelText(en.systemPrompt), { target: { value: 'review terser' } })
    view.rerender(<AdvisorCard {...props} />)
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: en.discard }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the placeholder as the built-in reviewer prompt (SSOT src/prompts.ts)', async () => {
    await mountCard()
    const prompt = screen.getByLabelText(en.systemPrompt) as HTMLTextAreaElement
    expect(prompt.placeholder).toBe(DEFAULT_ADVISOR_SYSTEM_PROMPT)
    expect(prompt.placeholder).toContain('independent reviewer')
    // The hint below spells out the leave-empty contract.
    expect(screen.getByText(en.systemPromptHint)).toBeTruthy()
  })
})

describe('AdvisorCard', () => {
  it('loads on mount when the store has not loaded yet (status idle → load)', async () => {
    // The plugin-config page mounts the card lazily; the first mount must
    // trigger the first gateway load (KD-3), not wait for a manual refresh.
    const { scripted, controller } = await mountCard({}, false)
    await waitFor(() => expect(scripted.get).toHaveBeenCalled())
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
  })

  it('shows the gateway notice without any click when get fails (KD-G5, always-on)', async () => {
    // The gateway channel is down: the card must not present defaults + a
    // writable Save that the host would refuse — the flat notice replaces the
    // form on every render (AC-3: no interaction, no disclosure to hide it).
    const { view, controller, props } = await mountCard({ config: null }, false)
    await waitFor(() => {
      expect(controller.store.getSnapshot().status).toBe('ready')
      expect(controller.store.getSnapshot().advisorPresent).toBe(false)
    })
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
    expect(screen.queryByLabelText(en.provider)).toBeNull()
    // Retry is the only action.
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
  })

  it('keeps the degraded notice visible through a background refresh (qc1 S-2)', async () => {
    // A pushed invalidation refresh flips a degraded card to status 'loading';
    // the store's latched `degraded` keeps the notice up for the refresh
    // window — there is no disclosure left, so the flat branch derives from
    // the latch exactly as before.
    const scripted = scriptedApi({ config: null })
    const controller = new AdvisorSettingsStore(scripted.remote, scripted.rpc, schema)
    await controller.load() // settled degraded: ready + advisorPresent=false
    const view = render(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()

    // The invalidation refresh: hold the gateway get pending so the snapshot
    // stays 'loading' while we assert the notice visibility.
    let releaseGet!: (value: RpcResult<{ config: AdvisorConfigView }>) => void
    scripted.get.mockReturnValueOnce(
      new Promise<RpcResult<{ config: AdvisorConfigView }>>((resolve) => { releaseGet = resolve }),
    )
    refreshIfLoaded(controller)
    // load() flipped status synchronously; the latch keeps the notice up.
    expect(controller.store.getSnapshot().status).toBe('loading')
    view.rerender(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()

    // The refresh settles back to degraded: the notice persists.
    releaseGet(failResult('advisor gateway is not ready') as RpcResult<{ config: AdvisorConfigView }>)
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
  })

  it('recovers from the degraded notice straight to the flat form when the gateway comes back', async () => {
    const scripted = scriptedApi({ config: null })
    const controller = new AdvisorSettingsStore(scripted.remote, scripted.rpc, schema)
    await controller.load()
    const view = render(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    // The gateway recovers: the healthy form renders without any interaction
    // (no disclosure state could have latched it away — the chrome is gone).
    scripted.get.mockImplementation(() => Promise.resolve(okResult({ config: defaultConfig() })))
    await controller.load()
    view.rerender(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.queryByText(en.namespaceUnavailable)).toBeNull()
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
    expect(screen.getByLabelText(en.model)).toBeTruthy()
  })

  it('holds the mounted form through a background refresh (fields disabled, no unmount blink)', async () => {
    const { controller, scripted, props, view } = await mountCard({ config: pairedConfig() })
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
    // Hold the refresh's gateway get pending: the snapshot flips to 'loading'
    // while the last settled providers/draft stay in place.
    let releaseGet!: (value: RpcResult<{ config: AdvisorConfigView }>) => void
    scripted.get.mockReturnValueOnce(
      new Promise<RpcResult<{ config: AdvisorConfigView }>>((resolve) => { releaseGet = resolve }),
    )
    refreshIfLoaded(controller)
    expect(controller.store.getSnapshot().status).toBe('loading')
    view.rerender(<AdvisorCard {...props} />)
    // The form did NOT unmount for the refresh window: the provider select is
    // still in the document and disabled for the hold.
    expect((screen.getByLabelText(en.provider) as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByLabelText(en.model)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.save })).toBeTruthy()
    // The refresh settles: the form returns to interactive.
    releaseGet(okResult({ config: pairedConfig() }))
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<AdvisorCard {...props} />)
    expect((screen.getByLabelText(en.provider) as HTMLSelectElement).disabled).toBe(false)
  })

  it('keeps the saved notice visible through the post-apply reload window', async () => {
    const { controller, scripted, props, view } = await mountCard({ config: pairedConfig() })
    // The post-apply reload's get hangs: apply() sets 'saved' BEFORE the
    // reload, and the store keeps applyState through the loading window —
    // the hold branch must keep both the notice and the form mounted.
    let releaseGet!: (value: RpcResult<{ config: AdvisorConfigView }>) => void
    scripted.get.mockReturnValueOnce(
      new Promise<RpcResult<{ config: AdvisorConfigView }>>((resolve) => { releaseGet = resolve }),
    )
    controller.setModel('ds-b')
    const applying = controller.apply()
    await waitFor(() => {
      expect(controller.store.getSnapshot().applyState.kind).toBe('saved')
      expect(controller.store.getSnapshot().status).toBe('loading')
    })
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByRole('status').textContent).toBe(en.saved)
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
    expect((screen.getByLabelText(en.provider) as HTMLSelectElement).disabled).toBe(true)
    // The reload settles: healthy ready again, the landed feedback still up.
    releaseGet(okResult({ config: { ...pairedConfig(), model: 'ds-b' } }))
    await applying
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByRole('status').textContent).toBe(en.saved)
  })

  it('renders the provider/model selects unconditionally and blocks Save with the gate copy', async () => {
    const { view, props } = await mountCard()
    // No enable toggle to flip — the selects are always here, and the
    // unconditional KD-S4 gate blocks Save while the pair is incomplete.
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
    expect(screen.getByLabelText(en.model)).toBeTruthy()
    // Progressive hints: the provider hint leads while both are missing; the
    // model hint appears once a provider is chosen.
    expect(screen.getByText(en.providerRequired)).toBeTruthy()
    expect(screen.queryByText(en.modelRequired)).toBeNull()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists only configured providers from the store join', async () => {
    await mountCard()
    const select = screen.getByLabelText(en.provider) as HTMLSelectElement
    const labels = within(select).getAllByRole('option').map(option => option.textContent)
    expect(labels).toContain('DeepSeek')
    expect(labels).toContain('openai')
    expect(labels).not.toContain('zombie')
  })

  it('shows the no-configured-providers guidance when the join is empty', async () => {
    await mountCard({ entries: [ZOMBIE] })
    expect(screen.getByText(en.noProviders)).toBeTruthy()
  })

  it('warns when the stored provider is no longer among the configured options', async () => {
    // 'zombie' is stored in the effective config but its profile does not
    // resolve, so it never enters the configured provider option list.
    const { view, props } = await mountCard({
      config: { enabled: true, provider: 'zombie', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    expect(screen.getByText(en.staleProvider)).toBeTruthy()
    // The warning does not gate the save: once an edit is staged the save is
    // enabled even while the provider is stale (keep or reselect — the
    // upstream contract disables a clean form's save).
    fireEvent.change(screen.getByLabelText(en.systemPrompt), { target: { value: 'x' } })
    view.rerender(<AdvisorCard {...props} />)
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(false)
    // Reselecting a valid provider clears the warning.
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.queryByText(en.staleProvider)).toBeNull()
  })

  it('warns when the stored model is no longer offered by the chosen provider', async () => {
    const { controller, props, view } = await mountCard({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-c', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    // load() kicks the model resolution for the stored provider; wait for it.
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['deepseek-official']?.length).toBe(2)
    })
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByText(en.staleModel)).toBeTruthy()
    expect(screen.queryByText(en.staleProvider)).toBeNull()
  })

  it('links the model select to the chosen provider and shows guidance when it has no models', async () => {
    const { controller, props, view } = await mountCard()
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorCard {...props} />)
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['deepseek-official']?.length).toBe(2)
    })
    view.rerender(<AdvisorCard {...props} />)
    const modelSelect = screen.getByLabelText(en.model) as HTMLSelectElement
    expect(within(modelSelect).getAllByRole('option').map(option => option.textContent)).toContain('DeepSeek A')
    expect(screen.queryByText(en.noModels)).toBeNull()
    // A provider with no models anywhere → guidance copy.
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'openai' } })
    view.rerender(<AdvisorCard {...props} />)
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['openai']).toBeUndefined()
      expect(Object.hasOwn(controller.store.getSnapshot().modelsEmptyReason, 'openai')).toBe(true)
    })
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByText(en.noModels)).toBeTruthy()
  })

  it('applies the full flow and shows the saved feedback with the gateway set payload', async () => {
    const { controller, scripted, props, view } = await mountCard()
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorCard {...props} />)
    // The model select only enables once its options resolve.
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['deepseek-official']?.length).toBe(2)
    })
    view.rerender(<AdvisorCard {...props} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'ds-b' } })
    view.rerender(<AdvisorCard {...props} />)
    // The staged edits above enable the save (!dirty no longer blocks the
    // upstream terms) — the click writes through the gateway channel.
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    // The write is a minimal patch over the gateway channel: only the changed
    // keys (the new pair — there is no `enabled` key to write); the untouched
    // scalars stay out.
    expect(scripted.call).toHaveBeenCalledWith('/api', 'advisor/set', {
      args: { patch: { provider: 'deepseek-official', model: 'ds-b' } },
    })
    await waitFor(() => expect(controller.store.getSnapshot().applyState.kind).toBe('saved'))
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByRole('status').textContent).toBe(en.saved)
    // Card chrome: the footer renders the Save/Discard pair (the upstream
    // contract this card replicates).
    expect(screen.getByRole('button', { name: en.discard })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('disables the Discard control while a save is in flight', async () => {
    // F-7 (qc3 N-3): the upstream disabled semantics (discard = !dirty ||
    // saving) pins the N-2 invariant — Discard is disabled while the gateway
    // write is pending, so a mid-apply discard cannot be triggered from the
    // UI.
    const { controller, scripted, props, view } = await mountCard()
    let release!: (value: RpcResult<{ config: AdvisorConfigView }>) => void
    scripted.set.mockReturnValueOnce(new Promise<RpcResult<{ config: AdvisorConfigView }>>((resolve) => { release = resolve }))
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorCard {...props} />)
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['deepseek-official']?.length).toBe(2)
    })
    view.rerender(<AdvisorCard {...props} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'ds-a' } })
    view.rerender(<AdvisorCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    view.rerender(<AdvisorCard {...props} />)
    // Save in flight (the set promise is still pending): the Discard control
    // is disabled alongside Save.
    expect((screen.getByRole('button', { name: en.discard }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: en.saving }) as HTMLButtonElement).disabled).toBe(true)
    // Release the write; the flow completes to saved.
    release(okResult({ config: pairedConfig() }))
    await waitFor(() => expect(controller.store.getSnapshot().applyState.kind).toBe('saved'))
  })

  it('discards the draft edits back to the last-known host config', async () => {
    // The store seed pins provider+model; the user edits the provider —
    // discard must rewind the draft to the seed (no gateway write).
    const { controller, scripted, props, view } = await mountCard({
      config: pairedConfig(),
    })
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'openai' } })
    view.rerender(<AdvisorCard {...props} />)
    expect(controller.store.getSnapshot().draft.provider).toBe('openai')
    // The discard button is disabled while the form is clean (!dirty ||
    // saving); the edit above makes the draft dirty, enabling the click that
    // rewinds the draft.
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    view.rerender(<AdvisorCard {...props} />)
    expect(controller.store.getSnapshot().draft.provider).toBe('deepseek-official')
    expect(controller.store.getSnapshot().draft.model).toBe('ds-a')
    // Discard is a client-side rewind — no gateway write happened.
    expect(scripted.set).not.toHaveBeenCalled()
  })

  it('reads the config through the advisor/get endpoint on load', async () => {
    const { scripted } = await mountCard()
    expect(scripted.call).toHaveBeenCalledWith('/api', 'advisor/get', { args: {} })
  })

  it('shows the wire failure message when Save is rejected', async () => {
    const { controller, scripted, props, view } = await mountCard()
    scripted.set.mockReturnValueOnce(Promise.resolve(failResult('host refused')))
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorCard {...props} />)
    // The model select only enables once its options resolve.
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['deepseek-official']?.length).toBe(2)
    })
    view.rerender(<AdvisorCard {...props} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'ds-a' } })
    view.rerender(<AdvisorCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(controller.store.getSnapshot().applyState.kind).toBe('error'))
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByText('host refused')).toBeTruthy()
    // The gateway merge has no revision guard: a plain rejection keeps the
    // form editable for a retry — the save stays enabled while the draft is
    // dirty (the dirty derivation enables it; a clean form's save is
    // disabled by the upstream contract).
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps a cleared number input empty instead of forcing 0', async () => {
    const { props, view } = await mountCard()
    const input = screen.getByLabelText(en.immuneTurns) as HTMLInputElement
    expect(input.value).toBe('3')
    fireEvent.change(input, { target: { value: '' } })
    view.rerender(<AdvisorCard {...props} />)
    expect((screen.getByLabelText(en.immuneTurns) as HTMLInputElement).value).toBe('')
    // The other number input behaves the same.
    const delta = screen.getByLabelText(en.maxDeltaMessages) as HTMLInputElement
    fireEvent.change(delta, { target: { value: '' } })
    view.rerender(<AdvisorCard {...props} />)
    expect((screen.getByLabelText(en.maxDeltaMessages) as HTMLInputElement).value).toBe('')
    // So does the maxTokens input (issue #102).
    const tokens = screen.getByLabelText(en.maxTokens) as HTMLInputElement
    expect(tokens.value).toBe('768')
    fireEvent.change(tokens, { target: { value: '' } })
    view.rerender(<AdvisorCard {...props} />)
    expect((screen.getByLabelText(en.maxTokens) as HTMLInputElement).value).toBe('')
  })

  it('renders maxTokens/proseFallback with the effective defaults and edits both through the store (issue #102)', async () => {
    const { controller, props, view } = await mountCard({ config: pairedConfig() })
    // maxTokens seeds the effective budget (768 when the wire omits it) with
    // the KD-I1 bounds on the input; proseFallback renders the schema default.
    const maxTokens = screen.getByLabelText(en.maxTokens) as HTMLInputElement
    expect(maxTokens.type).toBe('number')
    expect(maxTokens.value).toBe('768')
    expect(maxTokens.getAttribute('min')).toBe('128')
    expect(maxTokens.getAttribute('max')).toBe('16384')
    const toggle = screen.getByLabelText(en.proseFallback) as HTMLInputElement
    expect(toggle.type).toBe('checkbox')
    expect(toggle.checked).toBe(false)
    // Editing maxTokens flows through the store (draft + input value).
    fireEvent.change(maxTokens, { target: { value: '4096' } })
    view.rerender(<AdvisorCard {...props} />)
    expect(controller.store.getSnapshot().draft.maxTokens).toBe(4096)
    expect((screen.getByLabelText(en.maxTokens) as HTMLInputElement).value).toBe('4096')
    // Toggling proseFallback flips the draft boolean.
    fireEvent.click(screen.getByLabelText(en.proseFallback))
    view.rerender(<AdvisorCard {...props} />)
    expect(controller.store.getSnapshot().draft.proseFallback).toBe(true)
    expect((screen.getByLabelText(en.proseFallback) as HTMLInputElement).checked).toBe(true)
    // Both edits stage a dirty draft — Save is enabled (upstream terms).
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the read-only notice flat and disables writes when the settings provider is read-only', async () => {
    await mountCard({ writable: false })
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText(en.provider) as HTMLSelectElement).disabled).toBe(true)
  })

  it('shows the config-channel notice flat and never offers Save when the gateway is unreachable', async () => {
    // The gateway channel is down (get fails — no settings service on the
    // host, or the channel is unreachable): the card must not present
    // defaults + a writable Save that the host would refuse — the notice
    // replaces it (KD-G5, the n2-era C-1 mitigation), rendered as an
    // always-on flat block (KD-U3/AC-3).
    const { view } = await mountCard({ config: null })
    const notice = screen.getByText(en.namespaceUnavailable)
    expect(notice).toBeTruthy()
    expect(notice.textContent).not.toMatch(/not exposed|未暴露/)
    expect(notice.textContent).toMatch(/not available|not ready|unavailable/i)
    expect(notice.textContent).toContain('cordis.patch.yml')
    expect(notice.textContent).toContain('config:')
    expect(notice.textContent).toContain('/advisor')
    expect(notice.textContent).toMatch(/only toggles the advisor per session/i)
    expect(notice.textContent).toMatch(/cannot supply provider\/model/i)
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
    expect(screen.queryByRole('button', { name: en.discard })).toBeNull()
    // No checkbox input exists anywhere (the enable toggle is gone).
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull()
    expect(screen.queryByLabelText(en.provider)).toBeNull()
  })

  it('mirrors the config-channel guidance in zh (plugin config row + toggle-only /advisor)', () => {
    expect(zh.namespaceUnavailable).toContain('cordis.patch.yml')
    expect(zh.namespaceUnavailable).toContain('config:')
    expect(zh.namespaceUnavailable).toContain('/advisor')
    expect(zh.namespaceUnavailable).toMatch(/开关/)
    expect(zh.namespaceUnavailable).toMatch(/无法提供|不能提供/)
    expect(zh.namespaceUnavailable).toMatch(/通道|网关/)
  })

  it('keeps the saved feedback next to the notice when the post-apply reload loses the gateway', async () => {
    // qc3 N-1 mirrors into the notice branch: a landed write whose
    // post-apply reload can no longer reach the gateway must still show the
    // saved line — the notice explains the channel is down, the write is not
    // silently masked.
    const scripted = scriptedApi()
    // get call 1 (initial load) succeeds with a gate-passing pair; the
    // post-apply reload get fails.
    scripted.get.mockImplementationOnce(() => Promise.resolve(okResult({ config: pairedConfig() })))
    scripted.get.mockImplementationOnce(() => Promise.resolve(failResult('advisor gateway is not ready')))
    const controller = new AdvisorSettingsStore(scripted.remote, scripted.rpc, schema)
    await controller.load()
    controller.setModel('ds-b') // a real edit so the patch is non-empty
    await controller.apply()
    render(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByText(en.saved)).toBeTruthy()
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
  })

  it('renders the load failure flat with a working retry that recovers the form', async () => {
    const scripted = scriptedApi()
    scripted.describe.mockRejectedValueOnce(new Error('transport down'))
    const controller = new AdvisorSettingsStore(scripted.remote, scripted.rpc, schema)
    await controller.load()
    const view = render(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByText(`${en.loadFailed}: transport down`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    // The recovered healthy card renders its flat form directly.
    expect(screen.queryByText(`${en.loadFailed}:`)).toBeNull()
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
    expect(screen.getByLabelText(en.model)).toBeTruthy()
  })
})
