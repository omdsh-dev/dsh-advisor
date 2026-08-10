// @vitest-environment jsdom
/**
 * Advisor settings section (plan dsh-advisor-settings-n2, task 3) — component
 * behavior over a scripted wire face, mirroring the dsh-private ui-models
 * component specs (preloaded store + @testing-library/react).
 *
 * Note on the dev-time `bindSnapshotSelector` stand-in: the stub web-react
 * hook reads the current snapshot per render (no uSES subscription), so
 * assertions after a store mutation re-render the section explicitly
 * (`rerender`), exactly like the ui-models specs do.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConfigurableProviderView, IApiClient, ModelProviderGroup, RpcResponse,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { AdvisorSection } from '../src/client/advisor-section'
import type { AdvisorSectionInjected, AdvisorSectionProps } from '../src/client/advisor-section'
import { AdvisorSettingsStore } from '../src/client/advisor-store'
import { en } from '../src/client/locales'

afterEach(cleanup)

const t: AdvisorSectionInjected['t'] = key => en[key]

function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: 'r' as never, result: { ok: true, value } }
}

function fail<T>(message: string, code: 'settings-rejected' | 'settings-conflict' = 'settings-rejected'): RpcResponse<T> {
  return { rpcId: 'r' as never, result: { ok: false, error: { code, message, details: {} } } }
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

function advisorView(overrides: {
  user?: Record<string, unknown>
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
    ns: 'advisor', schema: {}, value,
    ...(user !== undefined ? { user } : {}),
    applies: 'live', secrets: [], revision: overrides.revision ?? 0,
  }
}

interface Scripted {
  api: Pick<IApiClient, 'settings' | 'llm'>
  describe: ReturnType<typeof vi.fn>
  mutate: ReturnType<typeof vi.fn>
  models: ReturnType<typeof vi.fn>
}

function scriptedApi(options: {
  advisor?: SettingsNamespaceView | null
  namespaces?: SettingsNamespaceView[]
  entries?: ConfigurableProviderView[]
  groups?: ModelProviderGroup[]
  writable?: boolean
} = {}): Scripted {
  const others = options.namespaces ?? [deepseekNs(), piAiNs()]
  const entries = options.entries ?? [DEEPSEEK, OPENAI, ZOMBIE]
  // `advisor: null` = the host describe does not expose the namespace (the
  // C-1 exposure boundary) — absent from the namespaces list entirely.
  let currentAdvisor = options.advisor === undefined ? advisorView() : options.advisor
  const describe = vi.fn(() => Promise.resolve(ok({
    writable: options.writable ?? true,
    hasDocument: false,
    namespaces: currentAdvisor === null ? others : [...others, currentAdvisor],
  })))
  const models = vi.fn(() => Promise.resolve(ok({ groups: options.groups ?? [], failures: [] })))
  const mutate = vi.fn((payload: { ns: string; ops: SettingsPathOpView[]; expectedRevision?: number }) => {
    if (currentAdvisor === null) throw new Error('test: mutate on an absent advisor namespace')
    const user: Record<string, unknown> = { ...(currentAdvisor.user as Record<string, unknown> | undefined) }
    for (const op of payload.ops) {
      if (op.op === 'set') user[op.path[0]] = op.value
      else delete user[op.path[0]]
    }
    const next: SettingsNamespaceView = {
      ...currentAdvisor, user,
      value: { ...currentAdvisor.value as Record<string, unknown>, ...user },
      revision: currentAdvisor.revision + 1,
    }
    currentAdvisor = next
    return Promise.resolve(ok(next))
  })
  return {
    api: {
      settings: { describe, update: vi.fn(), replace: vi.fn(), mutate },
      llm: { providers: vi.fn(() => Promise.resolve(ok({ providers: entries }))), models, discoverModels: vi.fn() },
    } as unknown as Pick<IApiClient, 'settings' | 'llm'>,
    describe, mutate, models,
  }
}

/** Preload the store, then render the section (ui-models spec pattern). */
async function mountSection(options: Parameters<typeof scriptedApi>[0] = {}) {
  const scripted = scriptedApi(options)
  const controller = new AdvisorSettingsStore(scripted.api)
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
    // 'zombie' is stored in the user layer but its profile does not resolve,
    // so it never enters the configured provider option list.
    const { view, injected } = await mountSection({
      advisor: advisorView({
        user: { enabled: true, provider: 'zombie', model: 'y' },
        value: { enabled: true, provider: 'zombie', model: 'y', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
      }),
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
      advisor: advisorView({
        user: { enabled: true, provider: 'deepseek-official', model: 'ds-c' },
        value: { enabled: true, provider: 'deepseek-official', model: 'ds-c', systemPrompt: '', immuneTurns: 3, maxDeltaMessages: 60 },
      }),
    })
    // load() kicks the model resolution for the stored provider; wait for it.
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider.get('deepseek-official')?.length).toBe(2)
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
      expect(controller.store.getSnapshot().modelsByProvider.get('deepseek-official')?.length).toBe(2)
    })
    view.rerender(<AdvisorSection {...injected} />)
    const modelSelect = screen.getByLabelText(en.model) as HTMLSelectElement
    expect(within(modelSelect).getAllByRole('option').map(option => option.textContent)).toContain('DeepSeek A')
    expect(screen.queryByText(en.noModels)).toBeNull()
    // A provider with no models anywhere → guidance copy.
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'openai' } })
    view.rerender(<AdvisorSection {...injected} />)
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider.get('openai')).toBeUndefined()
      expect(controller.store.getSnapshot().modelsEmptyReason.has('openai')).toBe(true)
    })
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.getByText(en.noModels)).toBeTruthy()
  })

  it('applies the full flow and shows the saved feedback with the mutate payload', async () => {
    const { view, controller, scripted, injected } = await mountSection()
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorSection {...injected} />)
    // The model select only enables once its options resolve.
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider.get('deepseek-official')?.length).toBe(2)
    })
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'ds-b' } })
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => expect(scripted.mutate).toHaveBeenCalled())
    expect(scripted.mutate).toHaveBeenCalledWith({
      ns: 'advisor',
      ops: expect.arrayContaining([
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['provider'], value: 'deepseek-official' },
        { op: 'set', path: ['model'], value: 'ds-b' },
      ]),
      expectedRevision: 0,
    })
    await waitFor(() => expect(controller.store.getSnapshot().applyState.kind).toBe('saved'))
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.getByRole('status').textContent).toBe(en.saved)
  })

  it('shows the wire failure message when Apply is rejected', async () => {
    const { view, controller, scripted, injected } = await mountSection()
    scripted.mutate.mockReturnValueOnce(Promise.resolve(fail('host refused')))
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorSection {...injected} />)
    // The model select only enables once its options resolve.
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider.get('deepseek-official')?.length).toBe(2)
    })
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'ds-a' } })
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => expect(controller.store.getSnapshot().applyState.kind).toBe('error'))
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.getByText('host refused')).toBeTruthy()
  })

  it('shows the conflict copy and lets the user re-apply after a settings-conflict', async () => {
    const { view, controller, scripted, injected } = await mountSection()
    scripted.mutate.mockReturnValueOnce(Promise.resolve(fail('stale', 'settings-conflict')))
    fireEvent.click(screen.getByLabelText(en.enabled))
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.change(screen.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    view.rerender(<AdvisorSection {...injected} />)
    // The model select only enables once its options resolve.
    await waitFor(() => {
      expect(controller.store.getSnapshot().modelsByProvider.get('deepseek-official')?.length).toBe(2)
    })
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'ds-a' } })
    view.rerender(<AdvisorSection {...injected} />)
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => expect(controller.store.getSnapshot().applyState.kind).toBe('error'))
    view.rerender(<AdvisorSection {...injected} />)
    expect(screen.getByText(en.conflict)).toBeTruthy()
    // The conflict re-sync leaves the form editable for a retry.
    expect((screen.getByRole('button', { name: en.apply }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('resets the draft on Cancel', async () => {
    const { view, controller, injected } = await mountSection({
      advisor: advisorView({ user: { enabled: true, provider: 'deepseek-official', model: 'ds-a' } }),
    })
    const prompt = screen.getByLabelText(en.systemPrompt) as HTMLTextAreaElement
    fireEvent.change(prompt, { target: { value: 'edited' } })
    fireEvent.change(screen.getByLabelText(en.immuneTurns), { target: { value: '9' } })
    view.rerender(<AdvisorSection {...injected} />)
    expect((screen.getByLabelText(en.systemPrompt) as HTMLTextAreaElement).value).toBe('edited')
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    view.rerender(<AdvisorSection {...injected} />)
    expect((screen.getByLabelText(en.systemPrompt) as HTMLTextAreaElement).value).toBe('')
    expect((screen.getByLabelText(en.immuneTurns) as HTMLInputElement).value).toBe('3')
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

  it('shows the unexposed-namespace notice and never offers Apply when the advisor view is absent', async () => {
    // A host build that does not expose the advisor namespace (the C-1
    // exposure boundary): the form must not present defaults + a writable
    // Apply that the host would refuse — the notice replaces it.
    await mountSection({ advisor: null })
    expect(screen.getByText(en.namespaceUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.apply })).toBeNull()
    expect(screen.queryByRole('button', { name: en.cancel })).toBeNull()
    expect(screen.queryByLabelText(en.enabled)).toBeNull()
    expect(screen.queryByLabelText(en.provider)).toBeNull()
  })

  it('renders the load failure with a working retry', async () => {
    const scripted = scriptedApi()
    scripted.describe.mockRejectedValueOnce(new Error('transport down'))
    const controller = new AdvisorSettingsStore(scripted.api)
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
