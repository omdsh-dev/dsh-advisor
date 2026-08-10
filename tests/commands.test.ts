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
  advisorStatusText,
  parseAdvisorCommand,
  registerAdvisorCommands,
} from '../src/commands'
import type { AdvisorCommandController, AdvisorCommandRegistry, AdvisorSessionStatus } from '../src/commands'

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

/** Stateful fake controller — records setEnabled calls and mirrors state. */
class FakeController implements AdvisorCommandController {
  status: AdvisorSessionStatus
  readonly setCalls: Array<{ sessionId: string; enabled: boolean; sessionLength?: number }> = []

  constructor(status: AdvisorSessionStatus) {
    this.status = status
  }

  getStatus(_sessionId: string): AdvisorSessionStatus {
    return this.status
  }

  setEnabled(sessionId: string, enabled: boolean, sessionLength?: number): void {
    this.setCalls.push({ sessionId, enabled, sessionLength })
    this.status = { ...this.status, enabled }
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

  it('"on" / "off" / "status", tolerating separator whitespace', () => {
    expect(parseAdvisorCommand(' on')).toEqual({ kind: 'on' })
    expect(parseAdvisorCommand('on')).toEqual({ kind: 'on' })
    expect(parseAdvisorCommand('off ')).toEqual({ kind: 'off' })
    expect(parseAdvisorCommand(' status')).toEqual({ kind: 'status' })
  })

  it('anything else → usage (exact match, like dsh command names)', () => {
    expect(parseAdvisorCommand('banana')).toEqual({ kind: 'usage' })
    expect(parseAdvisorCommand('on extra')).toEqual({ kind: 'usage' })
    expect(parseAdvisorCommand('status please')).toEqual({ kind: 'usage' })
    expect(parseAdvisorCommand('STATUS')).toEqual({ kind: 'usage' })
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
