// @vitest-environment jsdom
/**
 * Advisor settings card (plan dsh-advisor-plugin-config-card, task 2) —
 * component behavior over a scripted wire face (fake `settings`/`llm` api for
 * the provider directory + a fake connection RPC caller for the `advisor`
 * gateway channel), mirroring the dsh-private ui-models component specs
 * (preloaded store + @testing-library/react). This is the card-form
 * successor of the n5 advisor-section spec: the section component is removed
 * and the card registers into `settings.plugin.item` instead.
 *
 * The advisor config is NOT part of `settings.describe` — the card
 * reads/writes it through `rpc.call('/api', 'advisor/get' | 'advisor/set')`
 * (KD-G3). The fake rpc carries the effective config and applies patches the
 * way the host gateway does (merge → return the new composed config).
 *
 * Registration surface (KD-1): `apply` registers the card into the
 * `settings.plugin.item` slot ledger (id 'advisor', order 30, locale
 * 'settings.advisor') with a business-face-only inject (controller +
 * useSnapshot — no `t`); the old `settings.section` advisor registration is
 * gone, so the section ledger never holds an advisor entry (nav removal
 * regression).
 *
 * Note on the dev-time `bindSnapshotSelector` stand-in: the stub web-react
 * hook reads the current snapshot per render (no uSES subscription), so
 * assertions after a store mutation re-render the card explicitly
 * (`rerender`), exactly like the ui-models specs do.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ClientConnectionRpc, ConfigurableProviderView, IApiClient, ModelProviderGroup,
  RpcResponse, RpcResult, SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector, type SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { AdvisorCard } from '../src/client/advisor-card'
import type { AdvisorCardProps } from '../src/client/advisor-card'
import { AdvisorSettingsStore } from '../src/client/advisor-store'
import type { AdvisorConfigView, AdvisorSettingsState } from '../src/client/advisor-store'
import { apply } from '../src/client/index'
import { en, zh } from '../src/client/locales'

afterEach(cleanup)

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
  const controller = new AdvisorSettingsStore(scripted.api, scripted.rpc)
  if (preload) await controller.load()
  const props = cardProps(controller, bindSnapshotSelector(controller.store))
  const view = render(<AdvisorCard {...props} />)
  return { view, controller, scripted, props }
}

/**
 * A minimal fake of the client slots service + context for the registration
 * ledger test: `inject(name, generator)` runs the generator and records every
 * `register` call (the real runtime does the same through ctx.effect), and
 * `ctx.get('connection')` serves the scripted wire face. Everything else the
 * plugin's apply touches (locale register, connection/reset) is recorded but
 * inert.
 */
function fakeRuntime(scripted: Scripted) {
  interface LedgerRow { name: string; options: Record<string, unknown>; component: unknown }
  const ledger: Record<string, LedgerRow[]> = {}
  const disposers: Array<() => void> = []
  const locales: Record<string, unknown> = {}
  const resetHandlers = new Set<() => void>()
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
    slots,
    locale: {
      register: (ns: string, dict: unknown): (() => void) => {
        locales[ns] = dict
        return () => { delete locales[ns] }
      },
      bind: (): never => { throw new Error('test: apply must not bind t — the card t seat comes from PropsLocale') },
    },
    get: (key: string): unknown => (key === 'connection' ? { api: scripted.api, rpc: scripted.rpc } : undefined),
    effect: (fn: () => unknown): (() => void) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer as () => void : () => {}
    },
    on: (event: string, handler: () => void): (() => void) => {
      if (event !== 'connection/reset') throw new Error(`test: unexpected event ${event}`)
      resetHandlers.add(handler)
      return () => { resetHandlers.delete(handler) }
    },
  }
  return { ctx, ledger, locales, resetHandlers }
}

describe('AdvisorCard registration (settings.plugin.item)', () => {
  it('registers the advisor card and leaves no advisor entry in settings.section', () => {
    const scripted = scriptedApi()
    const { ctx, ledger, locales } = fakeRuntime(scripted)
    apply(ctx as unknown as ClientContext)

    // The card ledger holds exactly one advisor card.
    const cards = ledger['settings.plugin.item'] ?? []
    expect(cards).toHaveLength(1)
    expect(cards[0].options.id).toBe('advisor')
    expect(cards[0].options.order).toBe(30)
    expect(cards[0].options.locale).toBe('settings.advisor')
    expect(cards[0].component).toBe(AdvisorCard)
    // Inject face carries the business surface only — the typed `t` seat is
    // synthesized by the renderer from `locale:` (KD-1), never injected.
    const face = (cards[0].options.inject as () => object)()
    expect(typeof (face as { controller: unknown }).controller).toBe('object')
    expect(typeof (face as { useSnapshot: unknown }).useSnapshot).toBe('function')
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

describe('AdvisorCard', () => {
  it('renders the enabled switch off by default with the plain fields and no provider/model selects', async () => {
    await mountCard()
    expect(screen.getByText(en.title)).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
    const toggle = screen.getByLabelText(en.enabled) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByLabelText(en.systemPrompt)).toBeTruthy()
    expect(screen.getByLabelText(en.immuneTurns)).toBeTruthy()
    expect(screen.getByLabelText(en.maxDeltaMessages)).toBeTruthy()
    expect(screen.queryByLabelText(en.provider)).toBeNull()
    expect(screen.queryByLabelText(en.model)).toBeNull()
  })

  it('loads on mount when the store has not loaded yet (status idle → load)', async () => {
    // The plugin-config page mounts the card lazily; the first mount must
    // trigger the first gateway load (KD-3), not wait for a manual refresh.
    const { scripted, controller } = await mountCard({}, false)
    await waitFor(() => expect(scripted.get).toHaveBeenCalled())
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
  })

  it('reveals required provider/model selects when enabled and blocks Apply with the gate copy', async () => {
    const { view, props } = await mountCard()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByLabelText(en.enabled)).toBeTruthy()
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
    expect(screen.getByLabelText(en.model)).toBeTruthy()
    // Progressive hints: the provider hint leads while both are missing; the
    // model hint appears once a provider is chosen.
    expect(screen.getByText(en.providerRequired)).toBeTruthy()
    expect(screen.queryByText(en.modelRequired)).toBeNull()
    expect((screen.getByRole('button', { name: en.apply }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists only configured providers from the store join', async () => {
    const { view, props } = await mountCard()
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
    expect(screen.getByText(en.staleProvider)).toBeTruthy()
    // The warning does not block Apply: the user keeps the stored value or
    // reselects (documented in the card header).
    expect((screen.getByRole('button', { name: en.apply }) as HTMLButtonElement).disabled).toBe(false)
    // Reselecting a valid provider clears the warning.
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.queryByText(en.staleProvider)).toBeNull()
  })

  it('warns when the stored model is no longer offered by the chosen provider', async () => {
    const { view, controller, props } = await mountCard({
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
    const { view, controller, props } = await mountCard()
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
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    // The write is a minimal patch over the gateway channel: only the changed
    // keys (enabled + the new pair); the untouched scalars stay out.
    expect(scripted.call).toHaveBeenCalledWith('/api', 'advisor/set', {
      args: { patch: { enabled: true, provider: 'deepseek-official', model: 'ds-b' } },
    })
    await waitFor(() => expect(controller.store.getSnapshot().applyState.kind).toBe('saved'))
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByRole('status').textContent).toBe(en.saved)
    // Card chrome: the discard sibling renders next to Apply (Save-only was
    // the section's choice; the card mirrors the upstream Save/Discard pair).
    expect(screen.getByRole('button', { name: en.discard })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('discards the draft edits back to the last-known host config', async () => {
    // The store seed pins enabled+provider+model; the user edits the provider
    // and toggles enabled off — discard must rewind the draft to the seed (no
    // gateway write).
    const { view, controller, scripted, props } = await mountCard({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-a', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'openai' } })
    view.rerender(<AdvisorCard {...props} />)
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorCard {...props} />)
    expect(controller.store.getSnapshot().draft.enabled).toBe(false)
    expect(controller.store.getSnapshot().draft.provider).toBe('openai')
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

  it('shows the wire failure message when Apply is rejected', async () => {
    const { view, controller, scripted, props } = await mountCard()
    scripted.set.mockReturnValueOnce(Promise.resolve(failResult('host refused')))
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
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => expect(controller.store.getSnapshot().applyState.kind).toBe('error'))
    view.rerender(<AdvisorCard {...props} />)
    expect(screen.getByText('host refused')).toBeTruthy()
    // The gateway merge has no revision guard: a plain rejection keeps the
    // form editable for a retry.
    expect((screen.getByRole('button', { name: en.apply }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the system-prompt placeholder telling the user empty means default', async () => {
    await mountCard()
    const prompt = screen.getByLabelText(en.systemPrompt) as HTMLTextAreaElement
    expect(prompt.placeholder).toBe(en.systemPromptPlaceholder)
  })

  it('keeps a cleared number input empty instead of forcing 0', async () => {
    const { view, props } = await mountCard()
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

  it('shows the read-only notice and disables writes when the settings provider is read-only', async () => {
    await mountCard({ writable: false })
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect((screen.getByRole('button', { name: en.apply }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText(en.enabled) as HTMLInputElement).disabled).toBe(true)
  })

  it('shows the config-channel notice and never offers Apply when the gateway is unreachable', async () => {
    // The gateway channel is down (get fails — no settings service on the
    // host, or the channel is unreachable): the card must not present
    // defaults + a writable Apply that the host would refuse — the notice
    // replaces it (KD-G5, the n2-era C-1 mitigation).
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
    expect(screen.queryByRole('button', { name: en.apply })).toBeNull()
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
    const controller = new AdvisorSettingsStore(scripted.api, scripted.rpc)
    await controller.load()
    controller.setEnabled(true)
    controller.setProvider('deepseek-official')
    controller.setModel('ds-a')
    await controller.apply()
    render(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByText(en.saved)).toBeTruthy()
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.apply })).toBeNull()
  })

  it('renders the load failure with a working retry', async () => {
    const scripted = scriptedApi()
    scripted.describe.mockRejectedValueOnce(new Error('transport down'))
    const controller = new AdvisorSettingsStore(scripted.api, scripted.rpc)
    await controller.load()
    const view = render(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByText(`${en.loadFailed}: transport down`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<AdvisorCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
    expect(screen.getByLabelText(en.enabled)).toBeTruthy()
  })
})
