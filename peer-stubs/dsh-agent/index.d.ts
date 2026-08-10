/**
 * Type-only shim for the `@deepseek-ai/dsh-agent` seam consumed by dsh-advisor.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this declaration mirrors exactly the consumed surface of the seam — the
 * public `Agent` handle (id / status / session / inject / steer), the
 * `ctx.agents` registry augmentation, and the `agent/created` +
 * `agent/disposed` cordis events — pinned to dsh-private commit b8343cb
 * (2026-08-09 snapshot). Keep in sync when the dsh-private baseline moves.
 * (`Session` / `SessionId` come from the `@deepseek-ai/dsh-session` peer
 * stub; `UserMessage` from `@deepseek-ai/dsh-llm`.)
 */

import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** An agent's lifecycle state. */
export type AgentStatus = 'idle' | 'running'

/** Public live-agent handle (consumed surface only). */
export interface Agent {
  /** The single identity shared with the session. */
  readonly id: SessionId
  /** The current lifecycle state. */
  readonly status: AgentStatus
  /** The live session this agent drives; its log is the durable source of truth. */
  readonly session: Session
  /**
   * Submit steering for the nearest step. An idle driver starts a turn; a
   * running driver consumes it at its next step boundary.
   */
  steer(message: UserMessage): void
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: UserMessage): void
  /**
   * Queue model-facing context for the next pre-step without waking the
   * driver (the advice delivery channel: nit → inject, concern/blocker →
   * steer).
   */
  inject(message: UserMessage): void
}

/** Agent service (`ctx.agents`): tracks live agents (consumed surface: `get`). */
export interface AgentRegistry {
  /** Look up a live agent. */
  get(id: SessionId): Agent | undefined
  /** All live agents, in registration order. */
  list(): Agent[]
}

declare module 'cordis' {
  interface Context {
    agents: AgentRegistry
  }

  interface Events {
    /** A fully configured agent and live session were published. */
    'agent/created'(payload: { agent: Agent }): void
    /** An agent left the registry. */
    'agent/disposed'(payload: { agent: Agent }): void
  }
}
