/**
 * Dev-time minimal functional stand-in for `@deepseek-ai/dsh-commands` — the
 * plugin-owned human-command registry consumed by dsh-advisor: the
 * `CommandDefinition` / `CommandInvocation` / `CommandResult` /
 * `CommandDescriptor` / `ParsedCommand` types, the `CommandId` brand, the
 * `ctx.commands` cordis augmentation, and a minimal registry runtime
 * (`parseCommand` + `register` / `list` / `find` / `execute`).
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface of the dsh-private
 * `packages/interaction/commands` seam and implements just enough runtime
 * behavior for real-composition tests. Pinned to dsh-private commit b8343cb
 * (2026-08-09 snapshot). Keep in sync when the dsh-private baseline moves.
 * (`Agent` comes from the `@deepseek-ai/dsh-agent` peer stub.)
 */

import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-llm'

/** Pairs one command execution's lifecycle records with each other. */
export type CommandId = Branded<'CommandId'>

/** Brand a string as a {@link CommandId}. */
export function CommandId(id: string): CommandId {
  return id as CommandId
}

/** Immutable metadata for a command's optional unstructured input. */
export interface CommandInputDescriptor {
  /** Placeholder shown before the user supplies free-form input. */
  readonly hint: string
}

/** Invocation passed to one registered command handler. */
export interface CommandInvocation {
  /** Pairing id already written to this invocation's `command/run` event. */
  readonly commandId: CommandId
  /** Exact agent whose human-facing surface received the command. */
  readonly agent: Agent
  /** Exact text following the registered command name, including separator whitespace. */
  readonly rawInput: string
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal: AbortSignal
}

/** Expected command outcome rendered directly by the dispatching UI. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
  | { readonly kind: 'error'; readonly text: string }

/** One settled command execution: the handler's normalized result plus the lifecycle pairing id. */
export interface CommandExecution {
  /** Pairing id carried by this execution's lifecycle events. */
  readonly commandId: CommandId
  /** The handler's normalized outcome. */
  readonly result: CommandResult
}

/** Plugin-owned command registration. */
export interface CommandDefinition {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: CommandInputDescriptor
  /** Whether `command/run` records `rawInput`. Defaults to true. */
  readonly recordInput?: boolean
  /** Execute against the receiving agent without sending the command to the model. */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** Handler-free immutable command view returned to UI adapters. */
export interface CommandDescriptor {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: CommandInputDescriptor
}

/** Syntactically valid slash command before registry resolution. */
export interface ParsedCommand {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Exact text following the command name. */
  readonly rawInput: string
}

/**
 * Parse an exact slash command without normalizing its trailing input.
 * @returns The parsed command, or `undefined` when the line is not a command.
 */
export function parseCommand(line: string): ParsedCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (match === null) return undefined
  return { name: match[1]!, rawInput: line.slice(match[0].length) }
}

declare module 'cordis' {
  interface Context {
    commands: CommandService
  }
}

/**
 * Human-command registry (global layer only — agent-scoped shadowing is
 * outside the consumed surface).
 */
export class CommandService extends Service {
  private readonly definitions = new Map<string, CommandDefinition>()
  private commandSeq = 0

  constructor(ctx: Context) {
    super(ctx, 'commands')
  }

  /**
   * Register a command definition.
   * @returns the exact effect disposer that unregisters this definition.
   */
  register(definition: CommandDefinition): () => void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`command "${definition.name}" is already registered`)
    }
    this.definitions.set(definition.name, definition)
    return () => {
      this.definitions.delete(definition.name)
    }
  }

  /** List the name-sorted descriptors of every registered command. */
  list(_agent: Agent): readonly CommandDescriptor[] {
    return [...this.definitions.values()]
      .map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.input === undefined ? {} : { input: command.input }),
      }))
      .sort((left, right) => left.name < right.name ? -1 : 1)
  }

  /** Resolve one effective command definition. */
  find(_agent: Agent, name: string): CommandDefinition | undefined {
    return this.definitions.get(name)
  }

  /**
   * Parse and execute a known command without sending it to the model.
   * @returns the settled execution, or `undefined` when syntax or name does not resolve.
   */
  async execute(agent: Agent, line: string, signal: AbortSignal): Promise<CommandExecution | undefined> {
    const parsed = parseCommand(line)
    if (parsed === undefined) return undefined
    const command = this.definitions.get(parsed.name)
    if (command === undefined) return undefined
    if (signal.aborted) throw new Error('command aborted')
    this.commandSeq += 1
    const commandId = CommandId(`stub-${this.commandSeq}`)
    const invocation: CommandInvocation = Object.freeze({
      commandId,
      agent,
      rawInput: parsed.rawInput,
      signal,
    })
    let result: CommandResult
    try {
      result = await command.handler(invocation)
    } catch (error: unknown) {
      result = {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      }
    }
    return Object.freeze({ commandId, result })
  }
}

/**
 * Service-class default export matching the real package shape (a cordis
 * Loader mounts a class plugin via its constructor).
 */
export default CommandService
