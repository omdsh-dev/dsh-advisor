/**
 * T7 — slash commands (`/advisor` on/off/status/toggle), spec §2 S5.
 *
 * Contract under test:
 * - `parseAdvisorCommand(rawInput)` — the parse of the exact text following
 *   `/advisor` (the dsh `parseCommand` split yields `rawInput` including the
 *   separator whitespace): '' → toggle, 'on' → on, 'off' → off, 'status' →
 *   status, anything else → usage.
 * - `AdvisorSessionOverrides` — the session-scoped, ephemeral override
 *   mechanism (`override ?? config.enabled`) the runtime gate consults;
 *   toggle/on/off are session-scoped and never touch the persisted config.
 * - `registerAdvisorCommands` — the registration function (one `/advisor`
 *   definition whose handler drives the controller). The conditional
 *   `ctx.inject(['commands'], ...)` activation lives in index.ts and is
 *   exercised here at the registration-function level, per the brief.
 * - Handler semantics: toggle flips the override; on/off flip the runtime
 *   gate; an unknown subcommand returns the usage text; the status text
 *   carries the model + runtime state, and the S4 disabled-with-reason when
 *   the explicit gate blocks model calls.
 */

import { describe, expect, it } from 'vitest'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AdvisorSessionOverrides,
  USAGE,
  advisorConfigText,
  advisorStatusText,
  parseAdvisorCommand,
  registerAdvisorCommands,
  summarizeSystemPrompt,
} from '../src/commands'
import type {
  AdvisorCommandController,
  AdvisorCommandRegistry,
  AdvisorComposedConfig,
  AdvisorSessionStatus,
} from '../src/commands'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Minimal fake `Agent` — the handler only reads `agent.session.id`/events. */
function fakeAgent(sessionId = 'session-1'): Agent {
  return { session: { id: sessionId, events: [] } } as unknown as Agent
}

/** Invoke one handler with the exact dsh `CommandInvocation` shape. */
function invoke(handler: CommandDefinition['handler'], rawInput: string, sessionId = 'session-1'): CommandResult {
  const invocation: CommandInvocation = {
    commandId: CommandId('cmd-test-1'),
    agent: fakeAgent(sessionId),
    rawInput,
    signal: new AbortController().signal,
  }
  const result = handler(invocation)
  if (result instanceof Promise) throw new Error('test: handler must be synchronous')
  return result
}

/** Baseline status with the required fields filled in. */
function baseStatus(overrides: Partial<AdvisorSessionStatus> = {}): AdvisorSessionStatus {
  return { enabled: false, runtimeStatus: 'disabled', pendingCount: 0, ...overrides }
}

/** Baseline composed config with the required fields filled in. */
function baseConfig(overrides: Partial<AdvisorComposedConfig> = {}): AdvisorComposedConfig {
  return {
    enabled: false,
    immuneTurns: 3,
    maxDeltaMessages: 60,
    systemPromptSet: false,
    systemPromptSummary: '',
    ...overrides,
  }
}

/** Stateful fake controller — records setEnabled calls and mirrors state. */
class FakeController implements AdvisorCommandController {
  status: AdvisorSessionStatus
  config: AdvisorComposedConfig
  readonly setCalls: Array<{ sessionId: string; enabled: boolean; sessionLength?: number }> = []

  constructor(status: AdvisorSessionStatus, config?: AdvisorComposedConfig) {
    this.status = status
    this.config = config ?? baseConfig()
  }

  getStatus(_sessionId: string): AdvisorSessionStatus {
    return this.status
  }

  getConfig(): AdvisorComposedConfig {
    return this.config
  }

  setEnabled(sessionId: string, enabled: boolean, sessionLength?: number): void {
    this.setCalls.push({ sessionId, enabled, sessionLength })
    this.status = { ...this.status, enabled }
  }
}

/**
 * Fake controller that models the real S4 gate re-derivation: flipping the
 * override on for a config that lacks provider/model keeps the session
 * gate-blocked (enabled: false + disabledReason) in the POST-flip status —
 * the exact qc2 W-2 / qc3 I-2 trigger, where the pre-flip status has no
 * reason yet (the gate only fires when enabled).
 */
class GateTripController extends FakeController {
  constructor() {
    super(baseStatus({ enabled: false }))
  }

  override setEnabled(sessionId: string, enabled: boolean, sessionLength?: number): void {
    this.setCalls.push({ sessionId, enabled, sessionLength })
    this.status = enabled
      ? baseStatus({
        enabled: false,
        disabledReason: 'enabled but provider and model are missing — configure both to enable the advisor',
      })
      : baseStatus({ enabled: false })
  }
}

/** Fake command registry — captures registered definitions. */
class FakeRegistry implements AdvisorCommandRegistry {
  readonly definitions: CommandDefinition[] = []

  register(definition: CommandDefinition): () => void {
    this.definitions.push(definition)
    return () => {}
  }
}

/** Register the advisor commands against a fake registry and return the handler. */
function registerAndGetHandler(controller: AdvisorCommandController): CommandDefinition['handler'] {
  const registry = new FakeRegistry()
  registerAdvisorCommands(registry, controller)
  expect(registry.definitions).toHaveLength(1)
  return registry.definitions[0]!.handler
}

// ---------------------------------------------------------------------------
// parseAdvisorCommand
// ---------------------------------------------------------------------------

describe('parseAdvisorCommand (parse of the text after /advisor)', () => {
  it('no argument → toggle', () => {
    expect(parseAdvisorCommand('')).toEqual({ kind: 'toggle' })
    // rawInput includes the separator whitespace; a bare "/advisor" yields ''
    // and "/advisor " yields ' '.
    expect(parseAdvisorCommand(' ')).toEqual({ kind: 'toggle' })
    expect(parseAdvisorCommand('   ')).toEqual({ kind: 'toggle' })
  })

  it('"on" / "off" / "status" / "config", tolerating separator whitespace', () => {
    expect(parseAdvisorCommand(' on')).toEqual({ kind: 'on' })
    expect(parseAdvisorCommand('on')).toEqual({ kind: 'on' })
    expect(parseAdvisorCommand('off ')).toEqual({ kind: 'off' })
    expect(parseAdvisorCommand(' status')).toEqual({ kind: 'status' })
    expect(parseAdvisorCommand('config')).toEqual({ kind: 'config' })
    expect(parseAdvisorCommand(' config')).toEqual({ kind: 'config' })
    expect(parseAdvisorCommand('config ')).toEqual({ kind: 'config' })
  })

  it('anything else → usage (exact match, like dsh command names)', () => {
    expect(parseAdvisorCommand('banana')).toEqual({ kind: 'usage' })
    expect(parseAdvisorCommand('on extra')).toEqual({ kind: 'usage' })
    expect(parseAdvisorCommand('status please')).toEqual({ kind: 'usage' })
    expect(parseAdvisorCommand('STATUS')).toEqual({ kind: 'usage' })
    expect(parseAdvisorCommand('config extra')).toEqual({ kind: 'usage' })
    expect(parseAdvisorCommand('CONFIG')).toEqual({ kind: 'usage' })
  })
})

// ---------------------------------------------------------------------------
// AdvisorSessionOverrides — the override mechanism
// ---------------------------------------------------------------------------

describe('AdvisorSessionOverrides (per-session override ?? config.enabled)', () => {
  it('defaults to the config switch when no override is set', () => {
    expect(new AdvisorSessionOverrides(false).effective('s1')).toBe(false)
    expect(new AdvisorSessionOverrides(true).effective('s1')).toBe(true)
  })

  it('an override flips the effective switch for that session only', () => {
    const overrides = new AdvisorSessionOverrides(false)
    overrides.set('s1', true)
    expect(overrides.effective('s1')).toBe(true)
    expect(overrides.effective('s2')).toBe(false) // other sessions untouched
  })

  it('clear removes the override, falling back to the config switch', () => {
    const overrides = new AdvisorSessionOverrides(true)
    overrides.set('s1', false)
    expect(overrides.effective('s1')).toBe(false)
    overrides.clear('s1')
    expect(overrides.effective('s1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// registerAdvisorCommands — registration function contract
// ---------------------------------------------------------------------------

describe('registerAdvisorCommands (registration function, brief: test directly)', () => {
  it('registers one /advisor definition whose handler returns a CommandResult', () => {
    const registry = new FakeRegistry()
    registerAdvisorCommands(registry, new FakeController(baseStatus()))
    expect(registry.definitions).toHaveLength(1)
    const definition = registry.definitions[0]!
    expect(definition.name).toBe('advisor')
    expect(definition.description.length).toBeGreaterThan(0)
    expect(definition.input?.hint.length).toBeGreaterThan(0)
    expect(typeof definition.handler).toBe('function')
    expect(invoke(definition.handler, 'status').kind).toBe('success')
  })

  it('returns the registry disposer (unregister)', () => {
    const registry = new FakeRegistry()
    let disposed = false
    registry.register = () => () => { disposed = true }
    const disposer = registerAdvisorCommands(registry, new FakeController(baseStatus()))
    disposer()
    expect(disposed).toBe(true)
  })

  it('registry input.hint lists config (the TUI / row hint)', () => {
    const registry = new FakeRegistry()
    registerAdvisorCommands(registry, new FakeController(baseStatus()))
    const hint = registry.definitions[0]!.input?.hint
    expect(hint).toBe('[on|off|status|config]')
    expect(hint).toContain('config')
  })
})

// ---------------------------------------------------------------------------
// USAGE — the unknown-subcommand fallback lists config
// ---------------------------------------------------------------------------

describe('USAGE (unknown-subcommand fallback)', () => {
  it('header and subcommand list include config', () => {
    expect(USAGE).toContain('Usage: /advisor [on|off|status|config]')
    expect(USAGE).toContain('  /advisor config   show the composed advisor config (settings readback)')
  })
})

// ---------------------------------------------------------------------------
// Handler semantics — toggle / on / off
// ---------------------------------------------------------------------------

describe('/advisor handler — toggle / on / off flip the runtime gate', () => {
  it('toggle flips the override (off → on)', () => {
    const controller = new FakeController(baseStatus({ enabled: false }))
    const handler = registerAndGetHandler(controller)
    const result = invoke(handler, '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Advisor on')
    // enabling passes the current transcript length for the KD-5 seed
    expect(controller.setCalls.at(-1)).toEqual({ sessionId: 'session-1', enabled: true, sessionLength: 0 })
    expect(controller.status.enabled).toBe(true)
  })

  it('toggle flips the override (on → off)', () => {
    const controller = new FakeController(baseStatus({ enabled: true }))
    const handler = registerAndGetHandler(controller)
    const result = invoke(handler, '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Advisor off')
    expect(controller.setCalls.at(-1)).toEqual({ sessionId: 'session-1', enabled: false })
    expect(controller.status.enabled).toBe(false)
  })

  it('on / off flip the runtime gate through the controller', () => {
    const controller = new FakeController(baseStatus({ enabled: false }))
    const handler = registerAndGetHandler(controller)
    invoke(handler, ' on')
    expect(controller.setCalls.at(-1)?.enabled).toBe(true)
    invoke(handler, ' off')
    expect(controller.setCalls.at(-1)?.enabled).toBe(false)
  })

  it('toggle/on pass the current transcript length for the KD-5 seed', () => {
    const controller = new FakeController(baseStatus({ enabled: false }))
    const handler = registerAndGetHandler(controller)
    invoke(handler, ' on')
    expect(controller.setCalls.at(-1)?.sessionLength).toBe(0) // fake agent has 0 events
  })

  it('on is idempotent when already on; off when already off', () => {
    const controller = new FakeController(baseStatus({ enabled: true }))
    const handler = registerAndGetHandler(controller)
    const onResult = invoke(handler, ' on')
    expect(onResult.text).toContain('already on')
    const offController = new FakeController(baseStatus({ enabled: false }))
    const offHandler = registerAndGetHandler(offController)
    const offResult = invoke(offHandler, ' off')
    expect(offResult.text).toContain('already off')
    expect(controller.setCalls).toHaveLength(0)
    expect(offController.setCalls).toHaveLength(0)
  })

  it('on with a config lacking provider/model reports the S4 gate reason', () => {
    const controller = new FakeController(baseStatus({
      enabled: false,
      disabledReason: 'enabled but provider and model are missing — configure both to enable the advisor',
    }))
    const handler = registerAndGetHandler(controller)
    const result = invoke(handler, ' on')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('no model call can start')
    expect(result.text).toContain('configure both to enable the advisor')
  })

  it('on reply carries the S4 gate caveat when the override flip itself trips the gate (qc2 W-2 / qc3 I-2)', () => {
    // Config off + no provider/model: the pre-flip status has NO reason (the
    // gate only fires when enabled) — the reply must be derived from the
    // POST-flip status, which re-derives the disabled-with-reason.
    const controller = new GateTripController()
    const handler = registerAndGetHandler(controller)
    const result = invoke(handler, ' on')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('no model call can start')
    expect(result.text).toContain('configure both to enable the advisor')
    expect(controller.setCalls).toHaveLength(1)
  })

  it('toggle-to-on reply carries the S4 gate caveat when the flip trips the gate', () => {
    const controller = new GateTripController()
    const handler = registerAndGetHandler(controller)
    const result = invoke(handler, '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('no model call can start')
    expect(controller.setCalls).toHaveLength(1)
  })

  it('on reaches setEnabled (recovery) when the runtime is halted or quota-paused (qc1/qc2/qc3 W-1/I-4)', () => {
    // "already on" would be a dead end for these states — the 'on' handler
    // must route them into setEnabled so the controller can resume/rebuild.
    const halted = new FakeController(baseStatus({ enabled: true, runtimeStatus: 'halted' }))
    const haltedHandler = registerAndGetHandler(halted)
    const haltedResult = invoke(haltedHandler, ' on')
    expect(haltedResult.text).not.toContain('already on')
    expect(halted.setCalls.at(-1)).toEqual({ sessionId: 'session-1', enabled: true, sessionLength: 0 })

    const quota = new FakeController(baseStatus({ enabled: true, runtimeStatus: 'quota_exhausted' }))
    const quotaHandler = registerAndGetHandler(quota)
    const quotaResult = invoke(quotaHandler, ' on')
    expect(quotaResult.text).not.toContain('already on')
    expect(quota.setCalls.at(-1)).toEqual({ sessionId: 'session-1', enabled: true, sessionLength: 0 })
  })
})

// ---------------------------------------------------------------------------
// Status surface
// ---------------------------------------------------------------------------

describe('advisorStatusText (the /advisor status surface, spec §6)', () => {
  it('reports state + model + runtime status + pending count + last activity', () => {
    const text = advisorStatusText({
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o',
      runtimeStatus: 'running',
      pendingCount: 2,
      lastActivityAt: new Date('2026-08-10T11:20:00Z').getTime(),
    })
    expect(text).toContain('enabled')
    expect(text).toContain('openai/gpt-4o')
    expect(text).toContain('running')
    expect(text).toContain('2 pending')
    expect(text).toContain('2026-08-10T11:20:00.000Z')
  })

  it('shows disabled-with-reason when the S4 gate blocks model calls', () => {
    const text = advisorStatusText({
      enabled: true,
      disabledReason: 'enabled but provider and model are missing — configure both to enable the advisor',
      runtimeStatus: 'disabled',
      pendingCount: 0,
    })
    expect(text).toContain('disabled')
    expect(text).toContain('configure both to enable the advisor')
  })

  it('renders "never" before the first accepted note', () => {
    const text = advisorStatusText({ enabled: false, runtimeStatus: 'disabled', pendingCount: 0 })
    expect(text).toContain('disabled')
    expect(text).toContain('never')
  })

  it('status subcommand returns the status text with model + state', () => {
    const controller = new FakeController(baseStatus({
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o',
      runtimeStatus: 'running',
      pendingCount: 1,
    }))
    const handler = registerAndGetHandler(controller)
    const result = invoke(handler, 'status')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('gpt-4o')
    expect(result.text).toContain('running')
    expect(result.text).toContain('1 pending')
  })
})

// ---------------------------------------------------------------------------
// Config surface (plan dsh-advisor-tui-client-n8 T2 — `/advisor config`)
// ---------------------------------------------------------------------------

describe('advisorConfigText (the /advisor config surface, composed session-less readback)', () => {
  it('renders every field of an enabled config with a custom prompt', () => {
    const text = advisorConfigText(baseConfig({
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o',
      immuneTurns: 3,
      maxDeltaMessages: 60,
      systemPromptSet: true,
      systemPromptSummary: 'You are a terse reviewer.',
    }))
    expect(text).toContain('Advisor config: enabled')
    expect(text).toContain('Model: openai/gpt-4o')
    expect(text).toContain('immuneTurns: 3')
    expect(text).toContain('maxDeltaMessages: 60')
    expect(text).toContain('systemPrompt: "You are a terse reviewer."')
    expect(text).toContain('Edit: ~/.dsh/profiles/<profile>/cordis.patch.yml (plugin row) or $DSH_HOME/settings.yaml (advisor: section)')
  })

  it('renders maxDeltaMessages 0 as unbounded', () => {
    const text = advisorConfigText(baseConfig({ enabled: true, maxDeltaMessages: 0 }))
    expect(text).toContain('maxDeltaMessages: unbounded')
    expect(text).not.toContain('maxDeltaMessages: 0')
  })

  it('renders <default> when the system prompt is unset', () => {
    const text = advisorConfigText(baseConfig({ enabled: true }))
    expect(text).toContain('systemPrompt: <default>')
    expect(text).not.toContain('systemPrompt: "')
  })

  it('renders a non-default marker when the prompt is SET but its first line is empty (qc2 F-3)', () => {
    // systemPrompt '\nsecond line' is set (schema allows any string) yet its
    // summary is '' — the marker must follow systemPromptSet, NOT the empty
    // summary, or a custom prompt would be misreported as the default.
    const text = advisorConfigText(baseConfig({ enabled: true, systemPromptSet: true, systemPromptSummary: '' }))
    expect(text).toContain('systemPrompt: "(empty first line)"')
    expect(text).not.toContain('systemPrompt: <default>')
  })

  it('renders disabled-with-reason when the gate blocks, without a Model line', () => {
    const text = advisorConfigText(baseConfig({
      disabledReason: 'enabled but provider and model are missing — configure both to enable the advisor',
    }))
    expect(text).toContain('Advisor config: disabled')
    expect(text).toContain('Reason: enabled but provider and model are missing — configure both to enable the advisor')
    expect(text).not.toContain('Model:')
    expect(text).toContain('systemPrompt: <default>')
  })

  it('omits the Model line unless BOTH provider and model are present', () => {
    const onlyProvider = advisorConfigText(baseConfig({ enabled: true, provider: 'openai' }))
    expect(onlyProvider).not.toContain('Model:')
    const onlyModel = advisorConfigText(baseConfig({ enabled: true, model: 'gpt-4o' }))
    expect(onlyModel).not.toContain('Model:')
  })

  it('omits the Reason line when there is no gate reason', () => {
    const text = advisorConfigText(baseConfig({ enabled: true }))
    expect(text).not.toContain('Reason:')
  })

  it('always ends with the edit hint (both edit paths)', () => {
    const text = advisorConfigText(baseConfig())
    expect(text).toContain('Edit: ~/.dsh/profiles/<profile>/cordis.patch.yml (plugin row)')
    expect(text).toContain('or $DSH_HOME/settings.yaml (advisor: section)')
  })
})

describe('summarizeSystemPrompt (first line, ≤ 80 chars, never a full dump)', () => {
  it('empty prompt → empty summary', () => {
    expect(summarizeSystemPrompt('')).toBe('')
  })

  it('takes only the first line of a multi-line prompt', () => {
    expect(summarizeSystemPrompt('first line\nsecond line\nthird')).toBe('first line')
  })

  it('strips a trailing CR from a CRLF first line (qc2 F-3)', () => {
    expect(summarizeSystemPrompt('first line\r\nsecond line')).toBe('first line')
    // The CR is a line-ending artifact, not content — an 80-char CRLF first
    // line stays under the ellipsis threshold after stripping.
    expect(summarizeSystemPrompt(`${'x'.repeat(80)}\r\nsecond`)).toBe('x'.repeat(80))
  })

  it('keeps a short first line unchanged', () => {
    expect(summarizeSystemPrompt('You are a terse reviewer.')).toBe('You are a terse reviewer.')
    // Exactly 80 chars — no ellipsis.
    expect(summarizeSystemPrompt('x'.repeat(80))).toBe('x'.repeat(80))
  })

  it('truncates a first line longer than 80 chars to 80 chars with an ellipsis', () => {
    const long = 'x'.repeat(100)
    const summary = summarizeSystemPrompt(long)
    expect(summary).toBe(`${'x'.repeat(79)}…`)
    expect(summary.length).toBe(80)
  })
})

describe('/advisor config subcommand (handler dispatch)', () => {
  it('routes config to getConfig and returns the rendered text without touching setEnabled', () => {
    const controller = new FakeController(
      baseStatus({ enabled: true, provider: 'openai', model: 'gpt-4o' }),
      baseConfig({ enabled: true, provider: 'openai', model: 'gpt-4o', systemPromptSet: true, systemPromptSummary: 'Be brief.' }),
    )
    const handler = registerAndGetHandler(controller)
    const result = invoke(handler, 'config')
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toBe(advisorConfigText(controller.getConfig()))
      expect(result.text).toContain('Advisor config: enabled')
      expect(result.text).toContain('Be brief.')
    }
    expect(controller.setCalls).toHaveLength(0)
  })

  it('config render is session-less: a per-session override (status) never leaks into it', () => {
    // The session override is OFF (status disabled) while the composed config
    // is ON — the readback must report the composed value, not the session
    // state (config-vs-status separation; web-card /api/advisor/get parity).
    const controller = new FakeController(
      baseStatus({ enabled: false }),
      baseConfig({ enabled: true, provider: 'openai', model: 'gpt-4o' }),
    )
    const handler = registerAndGetHandler(controller)
    const result = invoke(handler, 'config')
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('Advisor config: enabled')
      expect(result.text).toContain('Model: openai/gpt-4o')
      expect(result.text).not.toContain('Advisor config: disabled')
      expect(result.text).not.toContain('Runtime:')
    }
    expect(controller.setCalls).toHaveLength(0)
  })

  it('config with an unknown subcommand still renders USAGE', () => {
    const controller = new FakeController(baseStatus())
    const handler = registerAndGetHandler(controller)
    const result = invoke(handler, 'config extra')
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toBe(USAGE)
    expect(controller.setCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

describe('/advisor unknown subcommand', () => {
  it('returns the usage text without touching the controller', () => {
    const controller = new FakeController(baseStatus())
    const handler = registerAndGetHandler(controller)
    const result = invoke(handler, 'banana')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Usage: /advisor')
    expect(result.text).toBe(USAGE)
    expect(controller.setCalls).toHaveLength(0)
  })
})
