// @vitest-environment jsdom
/**
 * Advisor settings section (plan dsh-advisor-settings-gateway-n5, task 2) —
 * component behavior over a scripted wire face (fake `settings`/`llm` api for
 * the provider directory + a fake connection RPC caller for the `advisor`
 * gateway channel), mirroring the dsh-private ui-models component specs
 * (preloaded store + @testing-library/react).
 *
 * The advisor config is NOT part of `settings.describe` anymore — the section
 * reads/writes it through `rpc.call('/api', 'advisor/get' | 'advisor/set')`
 * (KD-G3). The fake rpc carries the effective config and applies patches the
 * way the host gateway does (merge → return the new composed config).
 *
 * Note on the dev-time `bindSnapshotSelector` stand-in: the stub web-react
 * hook reads the current snapshot per render (no uSES subscription), so
 * assertions after a store mutation re-render the section explicitly
 * (`rerender`), exactly like the ui-models specs do.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ClientConnectionRpc, ConfigurableProviderView, IApiClient, ModelProviderGroup,
  RpcResponse, RpcResult, SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { AdvisorSection } from '../src/client/advisor-section'
import type { AdvisorSectionInjected, AdvisorSectionProps } from '../src/client/advisor-section'
import { AdvisorSettingsStore } from '../src/client/advisor-store'
import type { AdvisorConfigView } from '../src/client/advisor-store'
import { en, zh } from '../src/client/locales'

afterEach(cleanup)

const t: AdvisorSectionInjected['t'] = key => en[key]

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

/** Preload the store, then render the section (ui-models spec pattern). */
async function mountSection(options: Parameters<typeof scriptedApi>[0] = {}) {
  const scripted = scriptedApi(options)
  const controller = new AdvisorSettingsStore(scripted.api, scripted.rpc)
  await controller.load()
  const injected: AdvisorSectionInjected = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    t,
  }
  const view = render(<AdvisorSection {...injected} />)
  return { view, controller, scripted, injected }
}

describe('AdvisorSection', () => {
  it('renders nothing before the slot injects its dependencies', () => {
    const uninjected = {} as AdvisorSectionProps
    render(<AdvisorSection {...uninjected} />)
    expect(document.body.textContent).toBe('')
  })

  it('renders the enabled switch off by default with the plain fields and no provider/model selects', async () => {
    await mountSection()
    const toggle = screen.getByLabelText(en.enabled) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByLabelText(en.systemPrompt)).toBeTruthy()
    expect(screen.getByLabelText(en.immuneTurns)).toBeTruthy()
    expect(screen.getByLabelText(en.maxDeltaMessages)).toBeTruthy()
    expect(screen.queryByLabelText(en.provider)).toBeNull()
    expect(screen.queryByLabelText(en.model)).toBeNull()
  })

  it('reveals required provider/model selects when enabled and blocks Apply with the gate copy', async () => {
    const { view, injected } = await mountSection()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.getByLabelText(en.provider)).toBeTruthy()
    expect(screen.getByLabelText(en.model)).toBeTruthy()
    // Progressive hints: the provider hint leads while both are missing; the
    // model hint appears once a provider is chosen.
    expect(screen.getByText(en.providerRequired)).toBeTruthy()
    expect(screen.queryByText(en.modelRequired)).toBeNull()
    expect((screen.getByRole('button', { name: en.apply }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists only configured providers from the store join', async () => {
    const { view, injected } = await mountSection()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorSection {...injected} />)
    const select = screen.getByLabelText(en.provider) as HTMLSelectElement
    const labels = within(select).getAllByRole('option').map(option => option.textContent)
    expect(labels).toContain('DeepSeek')
    expect(labels).toContain('openai')
    expect(labels).not.toContain('zombie')
  })

  it('shows the no-configured-providers guidance when the join is empty', async () => {
    const { view, injected } = await mountSection({ entries: [ZOMBIE] })
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.getByText(en.noProviders)).toBeTruthy()
  })

  it('warns when the stored provider is no longer among the configured options', async () => {
    // 'zombie' is stored in the effective config but its profile does not
    // resolve, so it never enters the configured provider option list.
    const { view, injected } = await mountSection({
      config: { enabled: true, provider: 'zombie', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    expect(screen.getByText(en.staleProvider)).toBeTruthy()
    // The warning does not block Apply: the user keeps the stored value or
    // reselects (documented in the section header).
    expect((screen.getByRole('button', { name: en.apply }) as HTMLButtonElement).disabled).toBe(false)
    // Reselecting a valid provider clears the warning.
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.queryByText(en.staleProvider)).toBeNull()
  })

  it('warns when the stored model is no longer offered by the chosen provider', async () => {
    const { view, controller, injected } = await mountSection({
      config: { enabled: true, provider: 'deepseek-official', model: 'ds-c', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
    })
    // load() kicks the model resolution for the stored provider; wait for it.
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['deepseek-official']?.length).toBe(2)
    })
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.getByText(en.staleModel)).toBeTruthy()
    expect(screen.queryByText(en.staleProvider)).toBeNull()
  })

  it('links the model select to the chosen provider and shows guidance when it has no models', async () => {
    const { view, controller, injected } = await mountSection()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorSection {...injected} />)
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['deepseek-official']?.length).toBe(2)
    })
    view.rerender(<AdvisorSection {...injected} />)
    const modelSelect = screen.getByLabelText(en.model) as HTMLSelectElement
    expect(within(modelSelect).getAllByRole('option').map(option => option.textContent)).toContain('DeepSeek A')
    expect(screen.queryByText(en.noModels)).toBeNull()
    // A provider with no models anywhere → guidance copy.
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'openai' } })
    view.rerender(<AdvisorSection {...injected} />)
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['openai']).toBeUndefined()
      expect(Object.hasOwn(controller.store.getSnapshot().modelsEmptyReason, 'openai')).toBe(true)
    })
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.getByText(en.noModels)).toBeTruthy()
  })

  it('applies the full flow and shows the saved feedback with the gateway set payload', async () => {
    const { view, controller, scripted, injected } = await mountSection()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorSection {...injected} />)
    // The model select only enables once its options resolve.
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['deepseek-official']?.length).toBe(2)
    })
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'ds-b' } })
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => expect(scripted.set).toHaveBeenCalled())
    // The write is a minimal patch over the gateway channel: only the changed
    // keys (enabled + the new pair); the untouched scalars stay out.
    expect(scripted.call).toHaveBeenCalledWith('/api', 'advisor/set', {
      args: { patch: { enabled: true, provider: 'deepseek-official', model: 'ds-b' } },
    })
    await waitFor(() => expect(controller.store.getSnapshot().applyState.kind).toBe('saved'))
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.getByRole('status').textContent).toBe(en.saved)
    // The Cancel button is gone — only Apply renders (user direction: Save only).
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('reads the config through the advisor/get endpoint on load', async () => {
    const { scripted } = await mountSection()
    expect(scripted.call).toHaveBeenCalledWith('/api', 'advisor/get', { args: {} })
  })

  it('shows the wire failure message when Apply is rejected', async () => {
    const { view, controller, scripted, injected } = await mountSection()
    scripted.set.mockReturnValueOnce(Promise.resolve(failResult('host refused')))
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorSection {...injected} />)
    // The model select only enables once its options resolve.
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider['deepseek-official']?.length).toBe(2)
    })
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'ds-a' } })
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => expect(controller.store.getSnapshot().applyState.kind).toBe('error'))
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.getByText('host refused')).toBeTruthy()
    // The gateway merge has no revision guard: a plain rejection keeps the
    // form editable for a retry (the old settings-conflict branch is gone —
    // plain rpc error handling).
    expect((screen.getByRole('button', { name: en.apply }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the system-prompt placeholder telling the user empty means default', async () => {
    await mountSection()
    const prompt = screen.getByLabelText(en.systemPrompt) as HTMLTextAreaElement
    expect(prompt.placeholder).toBe(en.systemPromptPlaceholder)
  })

  it('keeps a cleared number input empty instead of forcing 0', async () => {
    const { view, injected } = await mountSection()
    const input = screen.getByLabelText(en.immuneTurns) as HTMLInputElement
    expect(input.value).toBe('3')
    fireEvent.change(input, { target: { value: '' } })
    view.rerender(<AdvisorSection {...injected} />)
    expect((screen.getByLabelText(en.immuneTurns) as HTMLInputElement).value).toBe('')
    // The other number input behaves the same.
    const delta = screen.getByLabelText(en.maxDeltaMessages) as HTMLInputElement
    fireEvent.change(delta, { target: { value: '' } })
    view.rerender(<AdvisorSection {...injected} />)
    expect((screen.getByLabelText(en.maxDeltaMessages) as HTMLInputElement).value).toBe('')
  })

  it('shows the read-only notice and disables writes when the settings provider is read-only', async () => {
    await mountSection({ writable: false })
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect((screen.getByRole('button', { name: en.apply }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText(en.enabled) as HTMLInputElement).disabled).toBe(true)
  })

  it('shows the config-channel notice and never offers Apply when the gateway is unreachable', async () => {
    // The gateway channel is down (get fails — no settings service on the
    // host, or the channel is unreachable): the form must not present defaults
    // + a writable Apply that the host would refuse — the notice replaces it
    // (KD-G5, the n2-era C-1 mitigation).
    await mountSection({ config: null })
    const notice = screen.getByText(en.namespaceUnavailable)
    expect(notice).toBeTruthy()
    // The copy no longer claims an "unexposed namespace" — it names the
    // unavailable config channel / unready gateway.
    expect(notice.textContent).not.toMatch(/not exposed|未暴露/)
    expect(notice.textContent).toMatch(/not available|not ready|unavailable/i)
    // The plugin config row guidance stays (the working config path in the
    // profile's cordis.patch.yml), and /advisor is still clarified as a
    // per-session toggle only (cannot supply provider/model).
    expect(notice.textContent).toContain('cordis.patch.yml')
    expect(notice.textContent).toContain('config:')
    expect(notice.textContent).toContain('/advisor')
    expect(notice.textContent).toMatch(/only toggles the advisor per session/i)
    expect(notice.textContent).toMatch(/cannot supply provider\/model/i)
    expect(screen.queryByRole('button', { name: en.apply })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.queryByLabelText(en.enabled)).toBeNull()
    expect(screen.queryByLabelText(en.provider)).toBeNull()
  })

  it('mirrors the config-channel guidance in zh (plugin config row + toggle-only /advisor)', () => {
    // The zh dictionary mirrors en; the guidance must carry the same key
    // content: the cordis.patch.yml config row and the /advisor toggle-only
    // clarification (it cannot supply provider/model).
    expect(zh.namespaceUnavailable).toContain('cordis.patch.yml')
    expect(zh.namespaceUnavailable).toContain('config:')
    expect(zh.namespaceUnavailable).toContain('/advisor')
    expect(zh.namespaceUnavailable).toMatch(/开关/)
    expect(zh.namespaceUnavailable).toMatch(/无法提供|不能提供/)
    expect(zh.namespaceUnavailable).toMatch(/通道|网关/)
  })

  it('keeps the saved feedback next to the notice when the post-apply reload loses the gateway', async () => {
    // qc3 N-1 mirrors into the notice branch (M3): a landed write whose
    // post-apply reload can no longer reach the gateway must still show the
    // saved line — the notice explains the channel is down, the write is not
    // silently masked.
    const scripted = scriptedApi()
    // get call 1 (initial load) succeeds; the post-apply reload get fails.
    scripted.get.mockImplementationOnce(() => Promise.resolve(okResult({ config: defaultConfig() })))
    scripted.get.mockImplementationOnce(() => Promise.resolve(failResult('advisor gateway is not ready')))
    const controller = new AdvisorSettingsStore(scripted.api, scripted.rpc)
    await controller.load()
    const injected: AdvisorSectionInjected = {
      controller, useSnapshot: bindSnapshotSelector(controller.store), t,
    }
    controller.setEnabled(true)
    controller.setProvider('deepseek-official')
    controller.setModel('ds-a')
    await controller.apply()
    render(<AdvisorSection {...injected} />)
    expect(screen.getByText(en.saved)).toBeTruthy()
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.apply })).toBeNull()
  })

  it('renders the load failure with a working retry', async () => {
    const scripted = scriptedApi()
    scripted.describe.mockRejectedValueOnce(new Error('transport down'))
    const controller = new AdvisorSettingsStore(scripted.api, scripted.rpc)
    await controller.load()
    const injected: AdvisorSectionInjected = {
      controller, useSnapshot: bindSnapshotSelector(controller.store), t,
    }
    const view = render(<AdvisorSection {...injected} />)
    expect(screen.getByText(`${en.loadFailed}: transport down`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => expect(controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.getByLabelText(en.enabled)).toBeTruthy()
  })
})
