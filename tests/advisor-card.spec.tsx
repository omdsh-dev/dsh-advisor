// @vitest-environment jsdom
/**
 * Advisor settings card (plan dsh-advisor-plugin-config-card-ux, task 1) —
 * component behavior over a scripted wire face (fake `settings`/`llm` api for
 * the provider directory + a fake connection RPC caller for the `advisor`
 * gateway channel), mirroring the dsh-private ui-models component specs
 * (preloaded store + @testing-library/react). This spec extends the
 * card-form suite (plan dsh-advisor-plugin-config-card) with the upstream
 * PluginCard chrome contract (plan dsh-advisor-plugin-config-card-ux, KD-U1):
 * the card is a collapsible box — a header button (name over description,
 * dirty "unsaved" pill, rotating chevron, aria-expanded/aria-label), a
 * divider under the header, then the form content and a footer with the
 * failed message + Discard/Save (upstream disabled semantics: save =
 * `!dirty || invalid || saving`, discard = `!dirty || saving`). Degraded /
 * error / loading states keep the same chrome and put the notice/error +
 * retry in the body (KD-U3, AC-3) — the documented divergence from
 * upstream's unavailable→nothing.
 *
 * The advisor config is NOT part of `settings.describe` — the card
 * reads/writes it through `rpc.call('/api', 'advisor/get' | 'advisor/set')`
 * (KD-G3). The fake rpc carries the effective config and applies patches the
 * way the host gateway does (merge → return the new composed config).
 *
 * Registration surface (KD-1): `apply` registers the card into the
 * `settings.plugin.item` keyed slot ledger (key 'advisor' — the settings
 * namespace the card edits, locale 'settings.advisor') with a
 * business-face-only inject (controller + the `hooks.snapshot` store — no
 * `t`); the old
 * `settings.section` advisor registration is gone, so the section ledger
 * never holds an advisor entry (nav removal regression).
 *
 * Note on the dev-time `bindSnapshotSelector` stand-in: the rc.8 renderer
 * binds the card's `hooks.snapshot` store to its `useSnapshot` prop inside
 * ui-renderer (not importable from a spec); the stub here reproduces the
 * same hook shape by reading the current snapshot per render (no uSES
 * subscription), so assertions after a store mutation re-render the card
 * explicitly (`rerender`), exactly like the ui-models specs do.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ClientConnectionRpc, ConfigurableProviderView, IApiClient, ModelProviderGroup,
  RpcResponse, RpcResult, SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { fakeSchema } from './support/schema-ops'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { AdvisorCard } from '../src/client/advisor-card'
import type { AdvisorCardProps } from '../src/client/advisor-card'
import { AdvisorSettingsStore, refreshIfLoaded } from '../src/client/advisor-store'
import type { AdvisorConfigView, AdvisorSettingsState } from '../src/client/advisor-store'
import { apply } from '../src/client/index'
import { en, zh } from '../src/client/locales'

afterEach(cleanup)

/** Real rc.8 settings schema service (immutable path writers under test). */
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
 * face (controller + useSnapshot), the framework-synthesized `t` seat, and
 * the runtime's global seat (session-list / workspace-list selector hooks —
 * every slot component receives them; the specs never exercise them).
 */
function cardProps(controller: AdvisorSettingsStore, useSnapshot: SnapshotSelectorHook<AdvisorSettingsState>): AdvisorCardProps {
  return {
    controller,
    useSnapshot,
    t,
    useSessions: undefined as never,
    useWorkspaces: undefined as never,
  }
}

function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: 'r' as never, result: { ok: true, value } }
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

const DEEPSEEK: ConfigurableProviderView = {
  provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true,
}
const OPENAI: ConfigurableProviderView = {
  provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true,
}
const ZOMBIE: ConfigurableProviderView = {
  provider: 'zombie', displayName: 'zombie', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zombie'], active: false,
}

function deepseekNs(): SettingsNamespaceView {
  return {
    ns: 'llm-deepseek', schema: {}, applies: 'live', secrets: [], revision: 0,
    value: {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'ds-a', name: 'DeepSeek A' }, { id: 'ds-b', name: 'DeepSeek B' }],
    },
  }
}

function piAiNs(): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai', schema: {}, applies: 'live', secrets: [], revision: 0,
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
  }
}

interface Scripted {
  api: Pick<IApiClient, 'settings' | 'llm'>
  rpc: ClientConnectionRpc
  call: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  describe: ReturnType<typeof vi.fn>
  models: ReturnType<typeof vi.fn>
}

/**
 * A scripted wire face: `settings.describe` carries ONLY the provider
 * namespaces (the advisor namespace is off the exposed set — the gateway
 * channel replaces it), and the fake `rpc.call` serves the `advisor/get` +
 * `advisor/set` endpoints against a mutable effective config. `config: null`
 * = the gateway is unreachable (get fails) — the C-1/KD-G5 notice path.
 */
function scriptedApi(options: {
  config?: AdvisorConfigView | null
  namespaces?: SettingsNamespaceView[]
  entries?: ConfigurableProviderView[]
  groups?: ModelProviderGroup[]
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
  const models = vi.fn(() => Promise.resolve(ok({ groups: options.groups ?? [], failures: [] })))
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
      llm: { providers: vi.fn(() => Promise.resolve(ok({ providers: entries }))), models, discoverModels: vi.fn() },
    } as unknown as Pick<IApiClient, 'settings' | 'llm'>,
    rpc: { call } as unknown as ClientConnectionRpc,
    call, get, set, describe, models,
  }
}

/** Preload the store, then render the card (ui-models spec pattern). */
async function mountCard(options: Parameters<typeof scriptedApi>[0] = {}, preload = true) {
  const scripted = scriptedApi(options)
  const controller = new AdvisorSettingsStore(scripted.api, scripted.rpc, schema)
  if (preload) await controller.load()
  const props = cardProps(controller, bindSnapshotSelector(controller.store))
  const view = render(<AdvisorCard {...props} />)
  return { view, controller, scripted, props }
}

/**
 * The card's header disclosure button. The accessible name is the upstream
 * aria-label — `collapse/expand: title` — which flips with the open state.
 */
function headerButton(open: boolean): HTMLElement {
  const label = `${open ? en.collapse : en.expand}: ${en.title}`
  return screen.getByRole('button', { name: new RegExp(`^${label}$`) })
}

/** Toggle the card open/closed through its header button. */
function toggleCard(): void {
  const button = screen.getByRole('button', {
    name: new RegExp(`^(${en.expand}|${en.collapse}): ${en.title}$`),
  })
  fireEvent.click(button)
}

/**
 * A minimal fake of the client slots service + context for the registration
 * ledger test: `inject(name, generator)` runs the generator and records every
 * `register` call (the real runtime does the same through ctx.effect), and
 * `ctx.get('connection')` serves the scripted wire face. The optional
 * `remote` service mirrors the client assembly's forwarded Host invalidation
 * face (plan 003: `ctx.remote.$on` with `settings/document-updated` +
 * `llm/adapters-updated`, probe of API_REMOTE_FORWARDED_EVENTS in
 * @deepseek-ai/dsh-api-remotes rc.8) — `withRemote: false` simulates a shell
 * that never mounted the service (graceful-degrade path). Everything else
 * the plugin's apply touches (locale register, connection/reset) is recorded
 * but inert.
 */
function fakeRuntime(scripted: Scripted, withRemote = true) {
  interface LedgerRow { name: string; options: Record<string, unknown>; component: unknown }
  const ledger: Record<string, LedgerRow[]> = {}
  const disposers: Array<() => void> = []
  const effectDisposers: Array<() => void> = []
  const locales: Record<string, unknown> = {}
  const resetHandlers = new Set<() => void>()
  const remoteHandlers: Record<string, Set<() => void>> = {}
  const remote = {
    $on: (event: string, handler: () => void): (() => void) => {
      ;(remoteHandlers[event] ??= new Set()).add(handler)
      return () => { remoteHandlers[event]?.delete(handler) }
    },
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
    locale: {
      register: (ns: string, dict: unknown): (() => void) => {
        locales[ns] = dict
        return () => { delete locales[ns] }
      },
      bind: (): never => { throw new Error('test: apply must not bind t — the card t seat comes from PropsLocale') },
    },
    get: (key: string): unknown => {
      if (key === 'connection') return { api: scripted.api, rpc: scripted.rpc }
      if (key === 'remote') return withRemote ? remote : undefined
      return undefined
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

describe('AdvisorCard registration (settings.plugin.item)', () => {
  it('registers the advisor card and leaves no advisor entry in settings.section', () => {
    const scripted = scriptedApi()
    const { ctx, ledger, locales } = fakeRuntime(scripted)
    apply(ctx as unknown as ClientContext)

    // The card ledger holds exactly one advisor card.
    const cards = ledger['settings.plugin.item'] ?? []
    expect(cards).toHaveLength(1)
    // rc.8 keyed slot: `key` is the settings namespace the card edits; the
    // old list-slot `id` / `order` options must be absent.
    expect(cards[0].options.key).toBe('advisor')
    expect(cards[0].options).not.toHaveProperty('id')
    expect(cards[0].options).not.toHaveProperty('order')
    expect(cards[0].options.locale).toBe('settings.advisor')
    expect(cards[0].component).toBe(AdvisorCard)
    // Inject face carries the business surface only — the typed `t` seat is
    // synthesized by the renderer from `locale:` (KD-1), never injected.
    const face = (cards[0].options.inject as () => object)()
    expect(typeof (face as { controller: unknown }).controller).toBe('object')
    // rc.8 hooks compartment: the bare store rides `hooks.snapshot` and the
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
  function applyAndController(scripted: Scripted, withRemote = true) {
    const runtime = fakeRuntime(scripted, withRemote)
    apply(runtime.ctx as unknown as ClientContext)
    const cards = runtime.ledger['settings.plugin.item'] ?? []
    const inject = cards[0].options.inject as () => object
    const face = inject() as { controller: AdvisorSettingsStore }
    return { ...runtime, controller: face.controller }
  }

  it('subscribes both granular remote events and refreshes a loaded store, coalescing bursts', async () => {
    const scripted = scriptedApi()
    const { controller, remoteHandlers, resetHandlers, fireRemote } = applyAndController(scripted)

    // Dual-plane registration: both forwarded Host events on the remote face
    // plus the connection/reset fallback (the 20260811 vocabulary removal
    // note — plan 003 probe: API_REMOTE_FORWARDED_EVENTS, rc.8).
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

  it('keeps connection/reset refresh when the remote service is absent (graceful degrade)', async () => {
    const scripted = scriptedApi()
    // A shell that never mounted `remote` must not throw on registration and
    // keeps today's reset-only convergence.
    const { controller, resetHandlers, remoteHandlers } = applyAndController(scripted, false)
    expect(Object.keys(remoteHandlers)).toHaveLength(0)
    expect(resetHandlers.size).toBe(1)

    await controller.load()
    expect(scripted.describe).toHaveBeenCalledTimes(1)
    for (const handler of resetHandlers) handler()
    await vi.waitFor(() => expect(scripted.describe).toHaveBeenCalledTimes(2))
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

describe('AdvisorCard chrome (upstream PluginCard contract)', () => {
  it('renders collapsed by default: the header copy and chevron, no form', async () => {
    const { view, props } = await mountCard()
    // Collapsed: only the header button — name over description + chevron.
    const header = headerButton(false)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.getAttribute('aria-label')).toBe(`${en.expand}: ${en.title}`)
    expect(within(header).getByText(en.title)).toBeTruthy()
    expect(within(header).getByText(en.intro)).toBeTruthy()
    // The chevron rotation is a CSS-module class toggle — jsdom resolves the
    // module to `{}`, so the literal `chevronOpen` class is asserted at the
    // bundle level (client-build.test.ts class-map assertion) and through the
    // substitutes here: the svg presence + aria-expanded + the body toggle
    // (M-1, T1 task review — the class rotation itself is not DOM-assertable
    // in jsdom).
    expect(header.querySelector('svg')).toBeTruthy() // the chevron icon
    expect(screen.queryByLabelText(en.enabled)).toBeNull()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
    expect(screen.queryByRole('button', { name: en.discard })).toBeNull()

    // Expanding reveals the plain fields and the footer actions.
    toggleCard()
    view.rerender(<AdvisorCard {...props} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(headerButton(true).getAttribute('aria-label')).toBe(`${en.collapse}: ${en.title}`)
    const toggle = screen.getByLabelText(en.enabled) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByLabelText(en.systemPrompt)).toBeTruthy()
    expect(screen.getByLabelText(en.immuneTurns)).toBeTruthy()
    expect(screen.getByLabelText(en.maxDeltaMessages)).toBeTruthy()
    expect(screen.queryByLabelText(en.provider)).toBeNull()
    expect(screen.queryByLabelText(en.model)).toBeNull()
  })

  it('flips aria-expanded and toggles the body on repeated header clicks', async () => {
    await mountCard()
    expect(headerButton(false).getAttribute('aria-expanded')).toBe('false')
    toggleCard()
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText(en.enabled)).toBeTruthy()
    toggleCard()
    expect(headerButton(false).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText(en.enabled)).toBeNull()
  })

  it('shows the unsaved pill after an edit and keeps it while collapsed', async () => {
    const { view, props } = await mountCard()
    toggleCard()
    fireEvent.change(screen.getByLabelText(en.systemPrompt), { target: { value: 'review terser' } })
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    // Staged edits outlive collapsing — the pill rides the header (upstream).
    toggleCard()
    expect(screen.getByText(en.unsaved)).toBeTruthy()
  })

  it('clears the unsaved pill after discard', async () => {
    const { view, props } = await mountCard()
    toggleCard()
    fireEvent.change(screen.getByLabelText(en.systemPrompt), { target: { value: 'review terser' } })
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.queryByText(en.unsaved)).toBeNull()
  })

  it('disables Save and Discard when clean, enables both once the draft is dirty', async () => {
    const { view, props } = await mountCard()
    toggleCard()
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
})

describe('AdvisorCard', () => {
  it('loads on mount when the store has not loaded yet (status idle → load)', async () => {
    // The plugin-config page mounts the card lazily; the first mount must
    // trigger the first gateway load (KD-3), not wait for a manual refresh.
    const { scripted, controller } = await mountCard({}, false)
    await waitFor(() => expect(scripted.get).toHaveBeenCalled())
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
  })

  it('starts collapsed on a real first mount (idle store): header only, no body', async () => {
    // I-1 regression (T1 task review): the mount-time snapshot is the store
    // default — 'idle' with advisorPresent=false — and the old mount-time
    // useState initializer read that as "cannot render the form", starting the
    // healthy card OPEN with an empty body. On a real first mount (no
    // preload) the card must render COLLAPSED (AC-1, Task 3 GUI ①): the
    // header button only, aria-expanded=false, no body/form at all.
    await mountCard({}, false)
    const header = headerButton(false)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.getAttribute('aria-label')).toBe(`${en.expand}: ${en.title}`)
    expect(header.querySelector('svg')).toBeTruthy() // the chevron icon
    expect(screen.queryByLabelText(en.enabled)).toBeNull()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
    expect(screen.queryByRole('button', { name: en.discard })).toBeNull()
    expect(screen.queryByText(en.namespaceUnavailable)).toBeNull()
    expect(screen.queryByText(`${en.loadFailed}:`)).toBeNull()
  })

  it('keeps the healthy card collapsed through load; the form appears only on header click', async () => {
    // I-1 regression: a real first mount (idle store) stays collapsed while
    // the load is in flight AND after it resolves to a healthy ready state —
    // the form appears only once the user clicks the header (AC-1).
    const { view, controller, props } = await mountCard({}, false)
    // While the load is in flight: header only, no open empty body (M-2).
    expect(headerButton(false).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText(en.enabled)).toBeNull()
    // The load resolves to ready + advisorPresent → still collapsed (no click
    // yet — the derived open must not follow the load result).
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<AdvisorCard {...props} />)
    expect(headerButton(false).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText(en.enabled)).toBeNull()
    expect(screen.queryByText(en.namespaceUnavailable)).toBeNull()
    // The user's click reveals the form.
    toggleCard()
    view.rerender(<AdvisorCard {...props} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText(en.enabled)).toBeTruthy()
  })

  it('shows the gateway notice open without any click on a real first mount when get fails', async () => {
    // I-1 regression + AC-3: on a real first mount (idle store) whose gateway
    // get fails, the card must end up with the notice body VISIBLE without any
    // interaction (derived open — the notice must appear without a click) —
    // and the header click must NOT hide it (the degraded body is always
    // visible; the documented divergence from upstream's unavailable→nothing).
    const { view, controller, props } = await mountCard({ config: null }, false)
    await waitFor(() => {
      expect(controller.store.getSnapshot().status).toBe('ready')
      expect(controller.store.getSnapshot().advisorPresent).toBe(false)
    })
    view.rerender(<AdvisorCard {...props} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
    // Clicking the header cannot collapse the degraded notice away.
    toggleCard()
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the degraded notice visible through a background refresh (qc1 S-2)', async () => {
    // A pushed invalidation refresh flips a degraded card to status 'loading';
    // the derived open must NOT collapse the AC-3 notice for the refresh
    // window — the store's latched `degraded` holds the disclosure open until
    // the refresh settles back to degraded.
    const scripted = scriptedApi({ config: null })
    const controller = new AdvisorSettingsStore(scripted.api, scripted.rpc, schema)
    await controller.load() // settled degraded: ready + advisorPresent=false
    const view = render(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()

    // The invalidation refresh: hold the gateway get pending so the snapshot
    // stays 'loading' while we assert the notice visibility.
    let releaseGet!: (value: RpcResult<{ config: AdvisorConfigView }>) => void
    scripted.get.mockReturnValueOnce(
      new Promise<RpcResult<{ config: AdvisorConfigView }>>((resolve) => { releaseGet = resolve }),
    )
    refreshIfLoaded(controller)
    // load() flipped status synchronously; the latch keeps the notice open.
    expect(controller.store.getSnapshot().status).toBe('loading')
    view.rerender(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()

    // The refresh settles back to degraded: the notice persists.
    releaseGet(failResult('advisor gateway is not ready') as RpcResult<{ config: AdvisorConfigView }>)
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
  })

  it('does not latch userOpen when the header is clicked while degraded — recovery stays collapsed (qc3 S-1)', async () => {
    // While degraded the derived open is forced true and the header click is
    // a NO-OP: it must not silently toggle userOpen (which would pre-open the
    // recovered form) and aria-expanded must stay true (no false
    // collapse announcement).
    const scripted = scriptedApi({ config: null })
    const controller = new AdvisorSettingsStore(scripted.api, scripted.rpc, schema)
    await controller.load()
    const view = render(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    // Clicking the header while degraded changes nothing.
    toggleCard()
    view.rerender(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(headerButton(true).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    // The gateway recovers: the healthy card must still start collapsed —
    // userOpen stayed false through the degraded clicks.
    scripted.get.mockImplementation(() => Promise.resolve(okResult({ config: defaultConfig() })))
    await controller.load()
    view.rerender(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(headerButton(false).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(en.namespaceUnavailable)).toBeNull()
    expect(screen.queryByLabelText(en.enabled)).toBeNull()
  })

  it('reveals required provider/model selects when enabled and blocks Save with the gate copy', async () => {
    const { view, props } = await mountCard()
    toggleCard()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByLabelText(en.enabled)).toBeTruthy()
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
    expect(screen.getByLabelText(en.model)).toBeTruthy()
    // Progressive hints: the provider hint leads while both are missing; the
    // model hint appears once a provider is chosen.
    expect(screen.getByText(en.providerRequired)).toBeTruthy()
    expect(screen.queryByText(en.modelRequired)).toBeNull()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists only configured providers from the store join', async () => {
    const { view, props } = await mountCard()
    toggleCard()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorCard {...props} />)
    const select = screen.getByLabelText(en.provider) as HTMLSelectElement
    const labels = within(select).getAllByRole('option').map(option => option.textContent)
    expect(labels).toContain('DeepSeek')
    expect(labels).toContain('openai')
    expect(labels).not.toContain('zombie')
  })

  it('shows the no-configured-providers guidance when the join is empty', async () => {
    const { view, props } = await mountCard({ entries: [ZOMBIE] })
    toggleCard()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByText(en.noProviders)).toBeTruthy()
  })

  it('warns when the stored provider is no longer among the configured options', async () => {
    // 'zombie' is stored in the effective config but its profile does not
    // resolve, so it never enters the configured provider option list.
    const { view, props } = await mountCard({
      config: { enabled: true, provider: 'zombie', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    toggleCard()
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
    const { view, controller, props } = await mountCard({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-c', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    toggleCard()
    // load() kicks the model resolution for the stored provider; wait for it.
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['deepseek-official']?.length).toBe(2)
    })
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByText(en.staleModel)).toBeTruthy()
    expect(screen.queryByText(en.staleProvider)).toBeNull()
  })

  it('links the model select to the chosen provider and shows guidance when it has no models', async () => {
    const { view, controller, props } = await mountCard()
    toggleCard()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorCard {...props} />)
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
    const { view, controller, scripted, props } = await mountCard()
    toggleCard()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorCard {...props} />)
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
    // keys (enabled + the new pair); the untouched scalars stay out.
    expect(scripted.call).toHaveBeenCalledWith('/api', 'advisor/set', {
      args: { patch: { enabled: true, provider: 'deepseek-official', model: 'ds-b' } },
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
    const { view, controller, scripted, props } = await mountCard()
    let release!: (value: RpcResult<{ config: AdvisorConfigView }>) => void
    scripted.set.mockReturnValueOnce(new Promise<RpcResult<{ config: AdvisorConfigView }>>((resolve) => { release = resolve }))
    toggleCard()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorCard {...props} />)
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
    release(okResult({ config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 } }))
    await waitFor(() => expect(controller.store.getSnapshot().applyState.kind).toBe('saved'))
  })

  it('discards the draft edits back to the last-known host config', async () => {
    // The store seed pins enabled+provider+model; the user edits the provider
    // and toggles enabled off — discard must rewind the draft to the seed (no
    // gateway write).
    const { view, controller, scripted, props } = await mountCard({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    toggleCard()
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'openai' } })
    view.rerender(<AdvisorCard {...props} />)
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorCard {...props} />)
    expect(controller.store.getSnapshot().draft.enabled).toBe(false)
    expect(controller.store.getSnapshot().draft.provider).toBe('openai')
    // The discard button is disabled while the form is clean (!dirty ||
    // saving); the edits above make the draft dirty, enabling the click that
    // rewinds the draft.
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    view.rerender(<AdvisorCard {...props} />)
    expect(controller.store.getSnapshot().draft.enabled).toBe(true)
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
    const { view, controller, scripted, props } = await mountCard()
    scripted.set.mockReturnValueOnce(Promise.resolve(failResult('host refused')))
    toggleCard()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorCard {...props} />)
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

  it('shows the system-prompt placeholder telling the user empty means default', async () => {
    await mountCard()
    toggleCard()
    const prompt = screen.getByLabelText(en.systemPrompt) as HTMLTextAreaElement
    expect(prompt.placeholder).toBe(en.systemPromptPlaceholder)
  })

  it('keeps a cleared number input empty instead of forcing 0', async () => {
    const { view, props } = await mountCard()
    toggleCard()
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
  })

  it('shows the read-only notice in the body and disables writes when the settings provider is read-only', async () => {
    await mountCard({ writable: false })
    toggleCard()
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText(en.enabled) as HTMLInputElement).disabled).toBe(true)
  })

  it('shows the config-channel notice in the card chrome and never offers Save when the gateway is unreachable', async () => {
    // The gateway channel is down (get fails — no settings service on the
    // host, or the channel is unreachable): the card must not present
    // defaults + a writable Save that the host would refuse — the notice
    // replaces it (KD-G5, the n2-era C-1 mitigation). The card stays visible
    // with the chrome and the notice in the body (KD-U3/AC-3, documented
    // divergence from upstream's unavailable→nothing).
    await mountCard({ config: null })
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
    expect(screen.queryByLabelText(en.enabled)).toBeNull()
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
    // get call 1 (initial load) succeeds; the post-apply reload get fails.
    scripted.get.mockImplementationOnce(() => Promise.resolve(okResult({ config: defaultConfig() })))
    scripted.get.mockImplementationOnce(() => Promise.resolve(failResult('advisor gateway is not ready')))
    const controller = new AdvisorSettingsStore(scripted.api, scripted.rpc, schema)
    await controller.load()
    controller.setEnabled(true)
    controller.setProvider('deepseek-official')
    controller.setModel('ds-a')
    await controller.apply()
    render(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByText(en.saved)).toBeTruthy()
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
  })

  it('renders the load failure in the card chrome with a working retry', async () => {
    const scripted = scriptedApi()
    scripted.describe.mockRejectedValueOnce(new Error('transport down'))
    const controller = new AdvisorSettingsStore(scripted.api, scripted.rpc, schema)
    await controller.load()
    const view = render(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByText(`${en.loadFailed}: transport down`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    // The error body was derived-open while degraded; once the retry recovers
    // the healthy card, the derivation no longer forces it open (I-1 — the
    // disclosure follows userOpen for a healthy card), so the card is
    // collapsed again until the user expands it.
    expect(headerButton(false).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText(en.enabled)).toBeNull()
    // The recovered form is still reachable through the header.
    toggleCard()
    view.rerender(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByLabelText(en.enabled)).toBeTruthy()
  })
})
