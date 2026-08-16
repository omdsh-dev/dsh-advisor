/**
 * T1 (plan dsh-advisor-tui-client-n8) — the dsh-tui client seam:
 * `installTuiClient` + the `tuiCommandTrees` /advisor provider (src/tui.ts).
 *
 * Contract under test (AC-1):
 * ① With a `tuiCommandTrees` service — `installTuiClient` registers exactly
 *    one provider with root `'advisor'`, zh + en descriptions are non-empty
 *    strings, and the disposer returned by the inject child is exactly the
 *    stub registry's `register` return value (no wrapping).
 * ② The provider's children contract: `children(['advisor'])` returns the
 *    four subcommand completion nodes (`on|off|status|config`) each carrying
 *    name + description + zh/en descriptions; `children(['advisor', <sub>])`
 *    → `[]` (leaves have no deeper completion — the TUI asks at depth 2);
 *    `children([])` / unknown roots → `[]`, never throws.
 * ③ No `tuiCommandTrees` service → `installTuiClient` completes without
 *    error and registers nothing.
 * ④ Wiring-level (src/index.ts `apply`): the provider is requested only on
 *    the single-reviewer (claiming) fiber — a non-claiming apply returns
 *    before the wiring and must not ask for the service. The globalThis
 *    claim itself is untouched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index'
import { ADVISOR_TUI_ROOT, installTuiClient } from '../src/tui'
import type { TuiCommandTreeProvider } from '../src/tui'
import type { AdvisorConfig } from '../src/config'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Full plugin-row config shape (the `apply` wiring test only needs a valid entry). */
function entryConfig(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    enabled: false,
    systemPrompt: '',
    immuneTurns: 3,
    maxDeltaMessages: 60,
    ...overrides,
  }
}

/** Stub `tuiCommandTrees` registry mirroring the dsh-TUI host contract
 * (`src/dsh-adapter/command-trees.ts`): `register` enforces the root regex
 * `^[a-z][a-z0-9_-]*$` and throws on a duplicate root, and returns a
 * disposer. Records every provider so tests can inspect the registered tree. */
class StubCommandTrees {
  readonly providers: TuiCommandTreeProvider[] = []

  constructor(private readonly disposer: () => void = vi.fn()) {}

  register(provider: TuiCommandTreeProvider): () => void {
    if (!/^[a-z][a-z0-9_-]*$/.test(provider.root)) {
      throw new Error(`invalid command tree root: ${provider.root}`)
    }
    if (this.providers.some((p) => p.root === provider.root)) {
      throw new Error(`command tree root already registered: ${provider.root}`)
    }
    this.providers.push(provider)
    return this.disposer
  }
}

/** Stub ctx whose `inject` immediately activates the callback with the given
 * services (the dsh-TUI service map shape) and captures its return value. */
function activateCtx(services: Record<string, unknown>): { ctx: Context; injected: () => boolean; returned: () => unknown } {
  let activated = false
  let returned: unknown
  const ctx = {
    inject(_names: readonly string[], callback: (tctx: Record<string, unknown>) => unknown): void {
      activated = true
      returned = callback(services)
    },
  } as unknown as Context
  return {
    ctx,
    injected: () => activated,
    returned: () => returned,
  }
}

// ---------------------------------------------------------------------------
// ① registration with a tuiCommandTrees service
// ---------------------------------------------------------------------------

describe('installTuiClient — registration (AC-1)', () => {
  it('registers exactly one provider with root advisor and non-empty zh/en descriptions', () => {
    const trees = new StubCommandTrees()
    const { ctx, injected } = activateCtx({ tuiCommandTrees: trees })

    installTuiClient(ctx)

    expect(injected()).toBe(true)
    expect(trees.providers).toHaveLength(1)
    const provider = trees.providers[0]!
    expect(provider.root).toBe(ADVISOR_TUI_ROOT)
    expect(provider.descriptions?.zh).toBeTruthy()
    expect(provider.descriptions?.en).toBeTruthy()
  })

  it('the inject child returns the registry disposer untouched', () => {
    const dispose = vi.fn()
    const trees = new StubCommandTrees(dispose)
    const { ctx, returned } = activateCtx({ tuiCommandTrees: trees })

    installTuiClient(ctx)

    expect(returned()).toBe(dispose)
  })
})

// ---------------------------------------------------------------------------
// ② children contract
// ---------------------------------------------------------------------------

describe('provider children — completion tree (AC-1)', () => {
  function registeredProvider(): TuiCommandTreeProvider {
    const trees = new StubCommandTrees()
    const { ctx } = activateCtx({ tuiCommandTrees: trees })
    installTuiClient(ctx)
    expect(trees.providers).toHaveLength(1)
    return trees.providers[0]!
  }

  it("children(['advisor']) returns the four subcommand nodes with name + description + zh/en descriptions", () => {
    const provider = registeredProvider()

    const nodes = provider.children(['advisor'])

    expect(nodes.map((node) => node.name)).toEqual(['on', 'off', 'status', 'config'])
    for (const node of nodes) {
      expect(node.description).toBeTruthy()
      expect(node.descriptions?.zh).toBeTruthy()
      expect(node.descriptions?.en).toBeTruthy()
    }
  })

  it('children at depth 2 (a subcommand leaf) returns [] — no deeper completion', () => {
    const provider = registeredProvider()
    for (const sub of ['on', 'off', 'status', 'config'] as const) {
      expect(provider.children(['advisor', sub])).toEqual([])
    }
  })

  it('children([]) and unknown roots return [] without throwing', () => {
    const provider = registeredProvider()
    expect(provider.children([])).toEqual([])
    expect(provider.children(['other'])).toEqual([])
    expect(() => provider.children(['other', 'x'])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// ③ no service → no-op
// ---------------------------------------------------------------------------

describe('installTuiClient — no tuiCommandTrees service (AC-1)', () => {
  it('completes without error, activates the inject child, and registers nothing', () => {
    const { ctx, injected, returned } = activateCtx({})

    expect(() => installTuiClient(ctx)).not.toThrow()

    // The conditional child ran (it is the standard inject position) but the
    // absent service made it a clean no-op: nothing registered, no disposer.
    expect(injected()).toBe(true)
    expect(returned()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ④ wiring — apply registers only on the claiming reviewer fiber
// ---------------------------------------------------------------------------

describe('apply wiring — reviewer-claim gating (AC-1)', () => {
  // The single-reviewer claim is process-global; reset between cases
  // (production keeps first-claim-wins; integration.test.ts does the same).
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__dshAdvisorReviewer__']
  })

  /** Minimal apply()-shaped ctx: records inject requests WITHOUT activating
   * them (no services), and no-ops the remaining surfaces `apply` touches
   * before the reviewer guard (logger / reflect.provide / effect / on). */
  function makeApplyStubCtx(injectKeys: string[]): Context {
    return {
      inject: (names: readonly string[]) => {
        injectKeys.push(...names)
      },
      logger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
      reflect: { provide: () => {} },
      effect: () => {},
      on: () => {},
      agents: { get: () => undefined },
    } as unknown as Context
  }

  it('a non-claiming apply (claim already held) never requests tuiCommandTrees', () => {
    ;(globalThis as Record<string, unknown>)['__dshAdvisorReviewer__'] = true
    const injectKeys: string[] = []
    const ctx = makeApplyStubCtx(injectKeys)

    apply(ctx, entryConfig())

    expect(injectKeys).not.toContain('tuiCommandTrees')
    // Same guard also skips the commands child — the whole reviewer-only
    // wiring block is bypassed on a non-claiming fiber.
    expect(injectKeys).not.toContain('commands')
  })

  it('the claiming apply requests tuiCommandTrees next to the commands child', () => {
    const injectKeys: string[] = []
    const ctx = makeApplyStubCtx(injectKeys)

    apply(ctx, entryConfig())

    expect(injectKeys).toContain('tuiCommandTrees')
    expect(injectKeys).toContain('commands')
  })
})
