/**
 * Dev-time minimal functional stand-in for `@deepseek-ai/dsh-session` — the
 * event-sourced session vocabulary and surface layer consumed by dsh-advisor:
 * `Session` / `SessionEvent` / `SessionId` / `SurfaceOp` types, the
 * `session/event` + `session/disposed` cordis augmentations, and the pure
 * surface helpers `foldSurface`, `deriveEventMessage`, `isSurfaceEvent`, and
 * `findLastMessageTurnEnd` (the incremental fold + stepped-turn gate the
 * transcript renderer drives).
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface of the dsh-private
 * `packages/core/session` seam and implements just enough behavior for
 * real-composition tests: the canonical append/replace surface fold and the
 * per-event message projection rules. Pinned to dsh-private commit b8343cb
 * (2026-08-09 snapshot). Keep in sync when the dsh-private baseline moves.
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, CallId, LlmFailure, StreamChunk, TokenUsage, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-llm'
import { Service } from 'cordis'
import type { Context } from 'cordis'

/** Identifies one session in the store (and its persistence artifacts). */
export type SessionId = Branded<'SessionId'>

/** Brand a string as a {@link SessionId}. */
export function SessionId(id: string): SessionId {
  return id as SessionId
}

/** Immutable validated storage metadata, kept outside the conversation event log. */
export interface SessionHeader {
  /** On-disk format version, stamped from {@link SESSION_FORMAT_VERSION}. */
  readonly version: number
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId
  /** How many leading events were inherited through a seed. */
  readonly seedLength?: number
  /** Coarse product classification for a session created as a subagent child. */
  readonly origin?: 'subagent'
  /** Delegation depth: absent (zero) for a top-level session. */
  readonly delegationDepth?: number
}

/** Why a turn ended. Merge-extensible sum type (consumed surface: `kind`). */
export interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  aborted: { kind: 'aborted'; reason: { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason: string } | { kind: 'disposed' } | { kind: 'legacy' } }
  blocked: { kind: 'blocked' }
  error: { kind: 'error'; error: LlmFailure }
  'max-tokens': { kind: 'max-tokens' }
  interrupted: { kind: 'interrupted' }
}

/** The union over {@link TurnEndReasonMap} — why a turn ended. */
export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]

/** One entry in an agent's todo list — the unit of the `todo/write` event's whole-list snapshot. */
export interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. */
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. (Consumed subset — the advisor
 * reads the boundary/turn/step events, the message-producing surface events,
 * and matches unknown `compact/*` log-only events by `type` string.)
 */
export interface SessionEventMap {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  'user/message': UserMessage
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  'assistant/message': { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  'tool/result': { turn: number; step: number; message: ToolResultMessage; error?: { name: string; code: string }; meta?: unknown }
  'todo/write': { todos: TodoItem[] }
  'request/header': { header: unknown; reason: 'initial' | 'resume' | 'change' }
  'request/context': { provider: string; model: string; contextWindow?: number }
  'session/end-seed': Record<string, never>
}

/** The appendable event-type keys of {@link SessionEventMap}, plugin-merged extensions included. */
export type SessionEventType = keyof SessionEventMap

/** The subset of {@link SessionEventType} values whose events produce LLM messages. */
export type SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'

/** How a session event entered the ordered surface. */
export type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }

/**
 * One immutable entry in the session log — a discriminated union over `type`,
 * so `switch (event.type)` narrows `event.data` without casts. Surface
 * metadata is conditional: it only exists on surface-event variants.
 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: number
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
  } & (K extends SurfaceEventType
    ? {
        /** Seq numbers of earlier events this one cites as sources. */
        sourceEventSeqs?: number[]
        /** How this event entered the surface; absent for non-surface events. */
        surfaceOp?: SurfaceOp
      }
    : object)
}[T]

/** A {@link SessionEvent} that is **on** the ordered surface (`surfaceOp` guaranteed present). */
export type SurfaceEvent = SessionEvent<SurfaceEventType> & { surfaceOp: SurfaceOp }

/** An event-sourced session: an append-only log of {@link SessionEvent}s (consumed surface). */
export interface Session {
  /** The session identity, derived from its durable header's single copy. */
  readonly id: SessionId
  /** Detached, deep-frozen creation metadata. */
  readonly header: SessionHeader
  /** An immutable snapshot of the append-only event log. */
  readonly events: readonly SessionEvent[]
  /** The next event's sequence number — always the log length. */
  readonly seq: number
  /** The first seq appended IN THIS PROCESS: the length of the constructor seed. */
  readonly firstLiveSeq: number
}

/** Runtime counterpart of the message-producing event union. */
const SURFACE_EVENT_TYPES = new Set<string>([
  'user/message',
  'assistant/message',
  'tool/result',
])

/** Narrow an event to a surface-eligible event carrying its required marker. */
export function isSurfaceEvent(event: SessionEvent): event is SurfaceEvent {
  if (!SURFACE_EVENT_TYPES.has(event.type)) return false
  return (event as { surfaceOp?: unknown }).surfaceOp !== undefined
}

/**
 * Project a single event into the LLM message it derives to, or null when it
 * produces none — a non-surface event (boundary, chunk, log-only record) or
 * an empty-content assistant/message (which exists only to host usage).
 */
export function deriveEventMessage(event: SessionEvent): Message | null {
  switch (event.type) {
    case 'user/message':
      return event.data
    case 'assistant/message': {
      // Skip an empty-content assistant/message: it exists only to host a
      // max-tokens step's usage and must not inject a content-less assistant
      // turn into the provider transcript.
      if (event.data.message.content.length === 0) return null
      return event.data.message
    }
    case 'tool/result':
      return event.data.message
    default:
      // A non-surface event (boundary, chunk, log-only record) projects to no
      // message. Merge-extensible union: no assertNever here.
      return null
  }
}

/** One replacement operation observed while folding a session surface. */
export interface SurfaceFoldReplacement {
  /** Seq of the event that replaced the prior surface range. */
  seq: number
  /** Declared inclusive start seq of the replaced surface range. */
  start: number
  /** Declared inclusive end seq of the replaced surface range. */
  end: number
  /** Actual surface entries removed by the operation, in surface order. */
  shadowedSeqs: number[]
}

/** Complete result of replaying the surface operations in a session log. */
export interface SurfaceFoldResult {
  /** Current surface event sequences in model-visible order. */
  nodes: number[]
  /** Replacement operations in event order. */
  replacements: SurfaceFoldReplacement[]
}

/**
 * Replay a complete session log through the canonical surface fold: appends
 * push the event seq onto the surface tail; positional replaces shadow the
 * declared range with the replacing node.
 */
export function foldSurface(events: readonly SessionEvent[]): SurfaceFoldResult {
  const nodes: number[] = []
  const replacements: SurfaceFoldReplacement[] = []
  for (const event of events) {
    if (!isSurfaceEvent(event)) continue
    if (event.surfaceOp === 'append') {
      nodes.push(event.seq)
      continue
    }
    const { start, end } = event.surfaceOp
    const startIdx = nodes.indexOf(start)
    if (startIdx === -1) {
      throw new Error(`surface replace: start seq ${start} not found in surface`)
    }
    const endIdx = nodes.indexOf(end)
    if (endIdx === -1) {
      throw new Error(`surface replace: end seq ${end} not found in surface`)
    }
    if (startIdx > endIdx) {
      throw new Error(`surface replace: start seq ${start} (index ${startIdx}) is after end seq ${end} (index ${endIdx})`)
    }
    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    replacements.push({ seq: event.seq, start, end, shadowedSeqs })
  }
  return { nodes, replacements }
}

/**
 * Find the latest closed turn that entered at least one model step, ignoring
 * balanced no-step turns produced by rejection, empty input, or cancellation.
 */
export function findLastMessageTurnEnd(events: readonly SessionEvent[]): SessionEvent<'turn/end'> | undefined {
  const steppedTurns = new Set<number>()
  let latest: SessionEvent<'turn/end'> | undefined
  for (const event of events) {
    if (event.type === 'step/start') {
      steppedTurns.add(event.data.turn)
      continue
    }
    if (event.type === 'turn/end' && steppedTurns.delete(event.data.turn)) latest = event
  }
  return latest
}

declare module 'cordis' {
  interface Context {
    sessions: SessionStore
  }

  interface Events {
    /** Post-commit, fire-and-forget append feed. */
    'session/event'(session: Session, event: SessionEvent): void
    /** Emitted once when an announced session leaves the store. */
    'session/disposed'(session: Session): void
  }
}

/** In-memory session store (`ctx.sessions`) — type surface only in this stub. */
export class SessionStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  /** Look up a live session. */
  get(_id: SessionId): Session | undefined {
    return undefined
  }

  /** All live sessions, in creation order. */
  list(): Session[] {
    return []
  }
}

export default SessionStore
