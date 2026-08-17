/**
 * T1 (plan dsh-advisor-tui-settings-n9) — the dsh-tui settings-section seam:
 * `installTuiSettingsSection` + the `tuiSettingsSections` Advisor section
 * (src/tui-settings.ts).
 *
 * Contract under test (AC-1 + AC-3):
 * ① With a `tuiSettingsSections` service — `installTuiSettingsSection`
 *    registers exactly one section whose `ns` equals
 *    `ADVISOR_SETTINGS_NAMESPACE` ('advisor'); title + zh/en descriptions
 *    are non-empty strings; the disposer returned by the inject child is
 *    exactly the stub registry's `register` return value (no wrapping).
 * ② The section's fields: the five expected kinds in display order
 *    (`enabled` boolean, `provider`/`model` text,
 *    `immuneTurns`/`maxDeltaMessages` number), each with a non-empty `path`,
 *    `label`, and zh/en `hint`/`hintDescriptions`; `systemPrompt` is NOT
 *    among the field paths.
 * ③ Field-path ↔ §5.1 schema alignment (regression pin): every field `path`
 *    is a single-element array whose key is a §5.1 `AdvisorConfig` key, and
 *    the exact allowed set is {enabled, provider, model, immuneTurns,
 *    maxDeltaMessages} — `systemPrompt` is the only §5.1 key intentionally
 *    absent (single-line TUI text input would truncate a multi-line prompt).
 * ④ No `tuiSettingsSections` service → `installTuiSettingsSection` completes
 *    without error and registers nothing.
 * ⑤ A duplicate-ns registration is contained: debug log + no-op disposer,
 *    no throw (mirrors the sibling tuiCommandTrees/typert/settings
 *    optional-registration pattern).
 * ⑥ Wiring-level (src/index.ts `apply`): the section is requested only on
 *    the single-reviewer (claiming) fiber — a non-claiming apply returns
 *    before the wiring and must not ask for the service. The globalThis
 *    reviewer claim is reset between cases (as tui-client.test.ts does).
 * ⑦ Wiring-level coupling pin (S-001, QC fix wave): on the claiming apply the
 *    section registration is requested under the shared service constant
 *    `TUI_SETTINGS_SECTIONS`, and the `/advisor config` readback's live probe
 *    (`ctx.get`) reads the SAME constant — registration condition and hint
 *    truthfulness are driven by one service key.
 * ⑧ Behavioral dispose (S-1, QC fix wave): the stub's `register` returns a
 *    REAL removal disposer (mirroring the upstream contract — deletes the
 *    section and notifies), and invoking the disposer returned by
 *    `installTuiSettingsSection` withdraws the section from the registry.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index'
import { ADVISOR_TUI_SETTINGS_NS, TUI_SETTINGS_SECTIONS, installTuiSettingsSection } from '../src/tui-settings'
import type { TuiSettingsSection } from '../src/tui-settings'
import { ADVISOR_SETTINGS_NAMESPACE } from '../src/settings'
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

/**
 * The exact §5.1 `AdvisorConfig` keys the TUI section must cover, in display
 * order. The `keyof AdvisorConfig` annotation is the compile-time regression
 * pin: a field key drifting off the schema stops typechecking; the runtime
 * assertions below pin the exact allowed set (`systemPrompt` intentionally
 * absent).
 */
const TUI_FIELD_KEYS: readonly (keyof AdvisorConfig)[] = [
  'enabled',
  'provider',
  'model',
  'immuneTurns',
  'maxDeltaMessages',
]

/** Stub `tuiSettingsSections` registry mirroring the dsh-TUI host contract
 * (`src/dsh-adapter/settings-sections.ts`): `register` enforces the ns regex
 * `^[a-z][a-z0-9_-]*$` and throws on a duplicate ns (`... is already
 * registered`). By default the returned disposer is a REAL removal disposer
 * mirroring the upstream contract (deletes the section from the registry and
 * records the removal — the upstream "deletes + notifies"); a custom disposer
 * may be injected for disposer-passthrough assertions. Records every section
 * so tests can inspect the registered section; `section(ns)` mirrors the
 * upstream lookup. */
class StubSettingsSections {
  readonly sections: TuiSettingsSection[] = []
  /** ns of every section removed through a returned disposer (the upstream
   * "notify" analog — deletion is the observable, removal is recorded). */
  readonly removals: string[] = []

  constructor(private readonly disposer?: () => void) {}

  /** The registered section for `ns`, or undefined when absent. */
  section(ns: string): TuiSettingsSection | undefined {
    return this.sections.find((s) => s.ns === ns)
  }

  register(section: TuiSettingsSection): () => void {
    const ns = section.ns.trim()
    if (!/^[a-z][a-z0-9_-]*$/u.test(ns)) {
      throw new TypeError(`invalid TUI settings-section namespace: ${section.ns}`)
    }
    if (this.sections.some((s) => s.ns === ns)) {
      throw new Error(`TUI settings section "${ns}" is already registered`)
    }
    this.sections.push(section)
    if (this.disposer !== undefined) return this.disposer
    // Real removal disposer (upstream contract: deletes + notifies).
    return () => {
      const index = this.sections.findIndex((s) => s.ns === ns)
      if (index >= 0) this.sections.splice(index, 1)
      this.removals.push(ns)
    }
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
// ① registration with a tuiSettingsSections service
// ---------------------------------------------------------------------------

describe('installTuiSettingsSection — registration (AC-1)', () => {
  it('registers exactly one section with ns advisor and non-empty title + zh/en descriptions', () => {
    const sections = new StubSettingsSections()
    const { ctx, injected } = activateCtx({ tuiSettingsSections: sections })

    installTuiSettingsSection(ctx)

    expect(injected()).toBe(true)
    expect(sections.sections).toHaveLength(1)
    const section = sections.sections[0]!
    // The section ns REUSES the shared namespace brand — a mismatched ns
    // would silently render the section "unavailable" in the host screen.
    expect(section.ns).toBe(ADVISOR_SETTINGS_NAMESPACE)
    // The test-friendly alias stays in sync with the shared constant.
    expect(ADVISOR_TUI_SETTINGS_NS).toBe('advisor')
    expect(ADVISOR_TUI_SETTINGS_NS).toBe(ADVISOR_SETTINGS_NAMESPACE)
    expect(section.title).toBeTruthy()
    expect(section.descriptions?.zh).toBeTruthy()
    expect(section.descriptions?.en).toBeTruthy()
  })

  it('the inject child returns the registry disposer untouched', () => {
    const dispose = vi.fn()
    const sections = new StubSettingsSections(dispose)
    const { ctx, returned } = activateCtx({ tuiSettingsSections: sections })

    installTuiSettingsSection(ctx)

    expect(returned()).toBe(dispose)
  })

  it('invoking the returned disposer withdraws the section from the registry (behavioral, S-1)', () => {
    // The default stub disposer is a REAL removal disposer (upstream contract:
    // deletes the section + notifies) — the fiber's withdraw path must leave
    // no stale entry behind, not just "not throw".
    const sections = new StubSettingsSections()
    const { ctx, returned } = activateCtx({ tuiSettingsSections: sections })

    installTuiSettingsSection(ctx)

    expect(sections.section(ADVISOR_SETTINGS_NAMESPACE)).toBeDefined()
    const disposer = returned() as () => void
    expect(typeof disposer).toBe('function')
    disposer()
    expect(sections.section(ADVISOR_SETTINGS_NAMESPACE)).toBeUndefined()
    expect(sections.sections).toHaveLength(0)
    expect(sections.removals).toEqual(['advisor'])
  })
})

// ---------------------------------------------------------------------------
// ② + ③ the section's fields: kinds, display order, zh/en copy, schema pins
// ---------------------------------------------------------------------------

describe('section fields — five §5.1 keys, display order, zh/en copy (AC-1)', () => {
  function registeredSection(): TuiSettingsSection {
    const sections = new StubSettingsSections()
    const { ctx } = activateCtx({ tuiSettingsSections: sections })
    installTuiSettingsSection(ctx)
    expect(sections.sections).toHaveLength(1)
    return sections.sections[0]!
  }

  it('declares the five fields with the expected kinds in display order', () => {
    const fields = registeredSection().fields

    expect(fields.map((field) => field.path)).toEqual(TUI_FIELD_KEYS.map((key) => [key]))
    expect(fields.map((field) => field.kind)).toEqual(['boolean', 'text', 'text', 'number', 'number'])
  })

  it('every field carries a non-empty path, label, and zh/en hint + hintDescriptions; systemPrompt is absent', () => {
    const fields = registeredSection().fields

    expect(fields.map((field) => field.path[0])).not.toContain('systemPrompt')
    for (const field of fields) {
      expect(field.path.length).toBeGreaterThan(0)
      expect(field.label).toBeTruthy()
      expect(field.hint).toBeTruthy()
      expect(field.hintDescriptions?.zh).toBeTruthy()
      expect(field.hintDescriptions?.en).toBeTruthy()
    }
  })

  it('field paths align with the §5.1 schema: single-element keys, exact allowed set (regression pin)', () => {
    const fields = registeredSection().fields

    const keys = fields.map((field) => field.path)
    for (const path of keys) {
      expect(path).toHaveLength(1)
      expect(TUI_FIELD_KEYS).toContain(path[0])
    }
    // No §5.1 config key is silently unreachable from the TUI section except
    // systemPrompt — assert the exact allowed set.
    expect(new Set(keys.map(([key]) => key!))).toEqual(new Set(TUI_FIELD_KEYS))
  })
})

// ---------------------------------------------------------------------------
// ④ no service → no-op
// ---------------------------------------------------------------------------

describe('installTuiSettingsSection — no tuiSettingsSections service (AC-3)', () => {
  it('completes without error, activates the inject child, and registers nothing', () => {
    const { ctx, injected, returned } = activateCtx({})

    expect(() => installTuiSettingsSection(ctx)).not.toThrow()

    // The conditional child ran (it is the standard inject position) but the
    // absent service made it a clean no-op: nothing registered, no disposer.
    expect(injected()).toBe(true)
    expect(returned()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ⑤ duplicate-ns containment
// ---------------------------------------------------------------------------

describe('installTuiSettingsSection — duplicate-ns containment (AC-1)', () => {
  it('a duplicate-ns registration is contained: debug log + no-op disposer, no throw (multi-fiber dedupe)', () => {
    // Another fiber already registered the 'advisor' section (multi-fiber
    // duplication is observed in the host) — the duplicate-ns throw must NOT
    // propagate out of the inject child. Mirrors the sibling tuiCommandTrees/
    // typert/settings optional-registration pattern.
    const sections = new StubSettingsSections()
    sections.register({ ns: 'advisor', title: 'Advisor', fields: [] })
    const debug = vi.fn()
    const { ctx, injected, returned } = activateCtx({
      tuiSettingsSections: sections,
      logger: () => ({ debug }),
    })

    expect(() => installTuiSettingsSection(ctx)).not.toThrow()

    expect(injected()).toBe(true)
    // No second section is recorded; the child returns a no-op disposer and
    // the dedupe is logged at debug level.
    expect(sections.sections).toHaveLength(1)
    expect(returned()).toEqual(expect.any(Function))
    expect(debug).toHaveBeenCalledWith('advisor tui settings section already registered — no section on this fiber (multi-fiber dedupe)')
  })
})

// ---------------------------------------------------------------------------
// ⑥ wiring — apply registers only on the claiming reviewer fiber
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

  /** Extended apply()-shaped ctx for the S-001 coupling pin: records inject
   * requests AND live `ctx.get` probe keys, and activates the `commands`
   * child against a capturing registry so the `/advisor config` readback
   * (whose `getConfig` runs the seam probe) can actually be invoked. */
  function makeProbeApplyCtx(
    injectKeys: string[],
    probeKeys: string[],
    definitions: Array<{ handler: (invocation: unknown) => unknown }>,
  ): Context {
    return {
      inject: (names: readonly string[], child?: (tctx: unknown) => unknown) => {
        injectKeys.push(...names)
        if (names.includes('commands') && child !== undefined) {
          child({
            commands: {
              register: (d: { handler: (invocation: unknown) => unknown }) => {
                definitions.push(d)
                return () => {}
              },
            },
          })
        }
      },
      get: (name: string) => {
        probeKeys.push(name)
        return undefined
      },
      logger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
      reflect: { provide: () => {} },
      effect: () => {},
      on: () => {},
      agents: { get: () => undefined },
    } as unknown as Context
  }

  it('a non-claiming apply (claim already held) never requests tuiSettingsSections', () => {
    ;(globalThis as Record<string, unknown>)['__dshAdvisorReviewer__'] = true
    const injectKeys: string[] = []
    const ctx = makeApplyStubCtx(injectKeys)

    apply(ctx, entryConfig())

    expect(injectKeys).not.toContain(TUI_SETTINGS_SECTIONS)
    // Same guard also skips the commands child — the whole reviewer-only
    // wiring block is bypassed on a non-claiming fiber.
    expect(injectKeys).not.toContain('commands')
  })

  it('the claiming apply requests tuiSettingsSections next to the commands child', () => {
    const injectKeys: string[] = []
    const ctx = makeApplyStubCtx(injectKeys)

    apply(ctx, entryConfig())

    expect(injectKeys).toContain(TUI_SETTINGS_SECTIONS)
    expect(injectKeys).toContain('commands')
  })

  it('pins registration request key === probe key === TUI_SETTINGS_SECTIONS (S-001)', () => {
    // The T1 registration condition (the `tuiSettingsSections` inject request)
    // and the T2 hint truthfulness probe (`ctx.get` inside `getConfig`) are
    // driven by ONE service key. Exercise both through the real wiring: the
    // claiming apply must request the section under the shared constant, and
    // running the `/advisor config` readback must probe the SAME constant —
    // the registration condition and the hint are coupled by construction.
    const injectKeys: string[] = []
    const probeKeys: string[] = []
    const definitions: Array<{ handler: (invocation: unknown) => unknown }> = []
    const ctx = makeProbeApplyCtx(injectKeys, probeKeys, definitions)

    apply(ctx, entryConfig())

    // Registration request key: the shared constant (claiming path).
    expect(injectKeys).toContain(TUI_SETTINGS_SECTIONS)
    // Probe key: run the composed-config readback → getConfig probes the
    // seam LIVE via `ctx.get` — same constant the registration used.
    expect(definitions).toHaveLength(1)
    definitions[0]!.handler({ rawInput: 'config', agent: { session: { id: 'session-1' } } })
    expect(probeKeys).toContain(TUI_SETTINGS_SECTIONS)
  })
})
