/**
 * Session observer + bounded delta renderer (spec §2 S2, §4 mapping table,
 * §6 self-review exclusion, §8.3 KD-3, §8.5 KD-5).
 *
 * `DeltaRenderer` is the pure transcript core: a cursor over the session event
 * log plus a fingerprint of the delivered prefix. `update(events)` extracts
 * the newly appended messages, excludes advisor-source messages (self-review
 * guard), and renders a role-annotated markdown delta bounded by the
 * `maxDeltaMessages` window. A prefix rewrite — a `compact/*` event, a
 * `user/message` with `surfaceOp.op === 'replace'`, or a fingerprint mismatch
 * (defensive fallback) — resets the cursor and replays the full post-rewrite
 * surface on the next update.
 *
 * `SessionTranscriptObserver` is the per-session wiring unit: it owns one
 * `DeltaRenderer` per session id and dispatches `session/event` tuples to
 * them. It has TWO trigger modes (KD-N4-5):
 *
 * 1. **turn/end** (standard turn-driven sessions): renders only on a stepped
 *    `turn/end` whose `reason.kind` is reviewable (`completed` | `max-tokens`
 *    | `error`; spec §4 — skip `aborted`/`blocked`/`interrupted`, i.e. do not
 *    critique user-cut-short turns). Byte-identical behavior — the original
 *    single-trigger path.
 * 2. **agent reply complete** (harness/agentic sessions, which never emit
 *    `turn/end`): fires on human-input arrival (`user/message` with
 *    `source.kind === 'user'`, or `agent/inbox/spliced` whose `inserted`
 *    carries a message with `source.kind === 'user'` — inbox-spliced input
 *    may commit as that event first and never re-emit as `user/message`).
 *    Non-user inbox splices (the advisor's own inject/steer deliveries,
 *    workspace/tool/empty splices) never trigger (C-1 self-trigger fix).
 *    Before rendering,
 *    a read-only predicate checks for an unreviewed non-advisor
 *    `assistant/message` since the renderer cursor; on a miss the cursor is
 *    untouched (the first user input of a session neither triggers nor
 *    advances). Append-type triggers pass `events` minus the trigger itself
 *    (the arriving input opens the next round); rewrite-type triggers
 *    (compact summary replace) pass the full log to trigger the KD-5 replay.
 *    Both modes share the same renderer/cursor, so the cursor advance dedupes
 *    (one delta per completed round), and both call `onSteppedTurnEnd` (the
 *    immuneTurns countdown — T6) before rendering.
 *
 * **Mode latch**: once a session has produced ANY `turn/end` event
 * (reviewable or not), the new gate sleeps for it — the session is a
 * standard turn-driven one and keeps verbatim behavior, including spec §4
 * skip-aborted (a cut-short first turn's unreviewed increment must not be
 * supplementarily reviewed by the new gate). Harness/agentic sessions never
 * emit `turn/end`, so their latch never arms.
 *
 * It also exposes the T6 delivery hooks: `onSteppedTurnEnd` (one completed
 * stepped primary turn — the immuneTurns countdown) and `onRewrite` (a
 * compact/replace event — the KD-5 latch reset). `index.ts` binds the cordis
 * `session/event` / `session/disposed` / `agent/disposed` listeners into an
 * instance of this class.
 *
 * @module dsh-advisor/transcript
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import {
  deriveEventMessage,
  foldSurface,
  isSurfaceEvent,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isAdvisorMessage } from './kinds'

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** One incremental transcript delta handed to the advisor runtime (T4). */
export interface Delta {
  /** Role-annotated markdown of the new (or replayed) transcript messages. */
  readonly markdown: string
  /**
   * Whether more transcript content is expected to follow the same logical
   * update. dsh closes a turn with `turn/end` (all its steps are done), so a
   * delta rendered at a stepped `turn/end` is always complete — `false` for
   * the MVP (see the task-3 report for the rationale).
   */
  readonly willContinue: boolean
}

/** Options for one {@link DeltaRenderer}. */
export interface DeltaRendererOptions {
  /**
   * Bounded message window (spec §8.3 KD-3): keep the most recent N messages
   * and prepend the truncation marker when a rendered delta would exceed N;
   * `0` = unbounded. Default 60.
   */
  readonly maxDeltaMessages: number
}

/** Default delta window (KD-3). */
export const DEFAULT_MAX_DELTA_MESSAGES = 60

/** Marker line prepended when a rendered delta omits earlier messages (KD-3). */
export const TRUNCATION_MARKER = '… <earlier messages omitted>'

const SESSION_UPDATE_HEADING = '### Session update'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Whether an event resets the incremental fold (KD-5 triggers, superset). */
function isRewriteEvent(event: SessionEvent): boolean {
  // compact/start | compact/summary | compact/end | compact/prune — log-only
  // events declared by @deepseek-ai/dsh-compact (not in this package's
  // dependency closure; matched by type string, per the plan's
  // implementation-time verification item 3).
  if (event.type.startsWith('compact/')) return true
  // Any surface event that replaced a range (the compaction summary
  // `user/message`, or a tool/result content rewrite) invalidates the
  // incremental append fold: a rewrite must rebuild the surface from scratch.
  // Superset of KD-5's `user/message` replace — a replace on any surface
  // type resets, which keeps the fold correct for every rewrite dsh can emit.
  if (!isSurfaceEvent(event)) return false
  return event.surfaceOp !== 'append'
}

/**
 * Fingerprint of the delivered log prefix (`events[0..length)`): the message
 * identities derived from those events. A hidden rewrite of delivered history
 * changes those identities, so a mismatch forces a reset + full replay.
 *
 * In dsh, events are immutable and append-only — every real rewrite arrives
 * as a visible `compact/*` or replace event (the authoritative triggers), so
 * this check is the defensive fallback the spec describes.
 *
 * simplify: O(length) per update over the delivered prefix. A rolling hash
 * over a bounded suffix would bound the cost if sessions grow very large; the
 * authoritative rewrite triggers already reset without this check.
 */
function fingerprintOf(events: readonly SessionEvent[], length: number): string {
  let hash = 0
  for (let index = 0; index < length; index++) {
    const message = deriveEventMessage(events[index]!)
    const id = message?.id ?? `e${index}`
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0
    }
  }
  return hash.toString(36)
}

/** Visible text of one content block (tool-result content is unwrapped). */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'tool-result':
      return block.content.map(blockText).join('\n')
    default:
      // reasoning / tool-call / unknown extensions carry no rendered text here.
      return ''
  }
}

/**
 * Render one message as a role-annotated markdown entry: `**user:**` /
 * `**agent:**` labels (spec §4), assistant text plus tool calls (tool intent),
 * tool results tagged `[tool result]`, reasoning excluded (MVP).
 */
function renderMessage(message: Message): string {
  if (message.role === 'user') {
    const value = message.content.map(blockText).filter((part) => part.length > 0).join('\n')
    if (message.source.kind === 'tool') {
      return value.length > 0 ? `**user**: [tool result] ${value}` : '**user**: [tool result] <empty>'
    }
    return value.length > 0 ? `**user**: ${value}` : '**user**: <empty>'
  }
  const parts: string[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push(block.text)
        break
      case 'tool-call':
        parts.push(`- tool call: ${block.name}(${block.arguments})`)
        break
      case 'reasoning':
        break // reasoning excluded in the MVP delta
      default:
        break
    }
  }
  return parts.length > 0 ? `**agent**: ${parts.join('\n')}` : '**agent**: <empty>'
}

/**
 * Find the latest closed turn that entered at least one model step, ignoring
 * balanced no-step turns produced by rejection, empty input, or cancellation.
 * Vendored locally: `@deepseek-ai/dsh-session` removed this export in the
 * 20260811 snapshot (packages/core/session/src/index.ts) — no replacement
 * was provided, and the event vocabulary it scans (`step/start`, `turn/end`)
 * is unchanged, so the original semantics carry over verbatim.
 * @param events - session events, or an owned suffix, to inspect.
 * @returns the latest matching turn end, or `undefined`.
 */
function findLastMessageTurnEnd(
  events: readonly SessionEvent[],
): SessionEvent<'turn/end'> | undefined {
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

// ---------------------------------------------------------------------------
// DeltaRenderer
// ---------------------------------------------------------------------------

/**
 * Cursor + fingerprint bookkeeping over one session's event log.
 *
 * The renderer consumes the session event log (the full `session.events`
 * snapshot on each call — the cordis wiring passes the live log). It keeps:
 * - `cursor` — how many log events are consumed (seqs are contiguous from 0,
 *   so this equals the next unprocessed seq);
 * - `surface` / `messages` — the current ordered surface of derived
 *   non-advisor messages (seqs + messages), maintained incrementally for
 *   appends and rebuilt from a full fold after a reset;
 * - `deliveredFingerprint` — fingerprint of the delivered prefix, detecting a
 *   hidden rewrite;
 * - `droppedPrefix` — whether messages before the bounded window were dropped
 *   (drives the truncation marker on replay renders).
 */
export class DeltaRenderer {
  private maxDeltaMessages: number
  private cursor = 0
  private readonly surface: number[] = []
  private readonly messages = new Map<number, Message>()
  private deliveredFingerprint: string | undefined
  private droppedPrefix = false

  constructor(options?: Partial<DeltaRendererOptions>) {
    this.maxDeltaMessages = options?.maxDeltaMessages ?? DEFAULT_MAX_DELTA_MESSAGES
  }

  /**
   * Update the bounded message window (live config — settings onChange, plan
   * dsh-advisor-settings-n2 T1). Existing fold state is kept; the new bound
   * applies from the next render on.
   */
  setMaxDeltaMessages(value: number): void {
    this.maxDeltaMessages = value
  }

  /**
   * Process a session event log snapshot and return the next delta, or
   * `undefined` when no new (renderable) content was appended.
   *
   * `skipLast` treats the final log event as excluded — the arriving trigger
   * of an append-type review (qc3 F1): equivalent to the caller slicing
   * `events.slice(0, events.length - 1)` WITHOUT the O(full-log) shallow copy
   * the reply-complete gate used to pay on every review. The excluded event
   * must be the last log entry (the wiring guarantees it).
   *
   * - Detects a reset: a rewrite event (`compact/*`, replace surface op) in
   *   the unconsumed portion, a shorter log than the cursor, or a delivered
   *   prefix whose fingerprint changed. On reset the cursor rewinds to 0 and
   *   the full post-rewrite surface is replayed (bounded by KD-3).
   * - Otherwise appends the new events, extracts their messages (advisor
   *   excluded), and renders only those (incremental delta).
   */
  update(events: readonly SessionEvent[], skipLast = false): Delta | undefined {
    const effectiveLength = skipLast ? events.length - 1 : events.length
    let replay = effectiveLength < this.cursor
    if (!replay) {
      const fresh = events.slice(this.cursor, effectiveLength)
      replay = fresh.some(isRewriteEvent)
    }
    if (!replay && this.cursor > 0 && this.deliveredFingerprint !== undefined) {
      replay = fingerprintOf(events, this.cursor) !== this.deliveredFingerprint
    }
    let added: Message[] = []
    if (replay) {
      this.reset()
      this.rebuild(events, effectiveLength)
    } else {
      added = this.append(events, this.cursor, effectiveLength)
    }
    this.cursor = effectiveLength
    this.deliveredFingerprint = fingerprintOf(events, this.cursor)
    return replay ? this.renderSurface() : this.renderTail(added)
  }

  /**
   * Full reset: rewind the cursor to 0 and drop all fold state. The next
   * `update` replays the whole current surface (bounded). Also the KD-5
   * reset surface for emission-guard / immuneTurns latches (T5/T6 hook into
   * the same session lifecycle).
   */
  reset(): void {
    this.cursor = 0
    this.surface.length = 0
    this.messages.clear()
    this.deliveredFingerprint = undefined
    this.droppedPrefix = false
  }

  /**
   * Seed the cursor to `length` (KD-5 seed-on-enable): skip existing history
   * — the next update renders only events at/after `length` (no full-history
   * replay, matching omp).
   */
  seedTo(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`dsh-advisor: seedTo length must be a non-negative safe integer, got ${String(length)}`)
    }
    this.reset()
    this.cursor = length
  }

  /**
   * Read-only predicate for the agentic reply-complete gate (KD-N4-5): does an
   * unreviewed non-advisor `assistant/message` increment exist since the
   * cursor? Scans the unconsumed log tail with the same derivation the
   * renderer uses (an empty-content `assistant/message` derives no message, so
   * it does not count) and excludes advisor-source messages (self-review
   * guard, spec §6). NEVER mutates state — a blind `update()` here would
   * pre-advance the cursor and lose the user prompt from the first
   * standard-session turn/end delta, so the caller only calls `update()` when
   * this returns true.
   */
  hasUnreviewedAssistant(events: readonly SessionEvent[]): boolean {
    for (let index = this.cursor; index < events.length; index++) {
      const event = events[index]!
      if (event.type !== 'assistant/message') continue
      const message = deriveEventMessage(event)
      if (message !== null && !isAdvisorMessage(message)) return true
    }
    return false
  }

  /** Rebuild the fold from a full log (post-reset replay, bounded to `length`). */
  private rebuild(events: readonly SessionEvent[], length: number): void {
    const folded = foldSurface(events.slice(0, length))
    for (const seq of folded.nodes) {
      const message = deriveEventMessage(events[seq]!)
      if (message === null || isAdvisorMessage(message)) continue
      this.surface.push(seq)
      this.messages.set(seq, message)
    }
    if (this.maxDeltaMessages > 0 && this.surface.length > this.maxDeltaMessages) {
      const dropped = this.surface.splice(0, this.surface.length - this.maxDeltaMessages)
      for (const seq of dropped) this.messages.delete(seq)
      this.droppedPrefix = true
    }
  }

  /** Incrementally fold new events in `[start, end)` (guaranteed append-only) and return added messages. */
  private append(events: readonly SessionEvent[], start: number, end: number): Message[] {
    const added: Message[] = []
    for (let index = start; index < end; index++) {
      const event = events[index]!
      const message = deriveEventMessage(event)
      if (message === null || isAdvisorMessage(message)) continue
      this.surface.push(event.seq)
      this.messages.set(event.seq, message)
      added.push(message)
      if (this.maxDeltaMessages > 0 && this.surface.length > this.maxDeltaMessages) {
        const removed = this.surface.shift()!
        this.messages.delete(removed)
        this.droppedPrefix = true
      }
    }
    return added
  }

  /** Render the newly appended messages (incremental delta). */
  private renderTail(added: readonly Message[]): Delta | undefined {
    if (this.maxDeltaMessages > 0 && added.length > this.maxDeltaMessages) {
      return this.render(added.slice(-this.maxDeltaMessages), true)
    }
    return this.render(added, false)
  }

  /** Render the current surface in full (post-reset replay, bounded). */
  private renderSurface(): Delta | undefined {
    const messages: Message[] = []
    for (const seq of this.surface) {
      const message = this.messages.get(seq)
      if (message !== undefined) messages.push(message)
    }
    return this.render(messages, this.droppedPrefix)
  }

  private render(messages: readonly Message[], omitted: boolean): Delta | undefined {
    if (messages.length === 0) return undefined
    const lines: string[] = [SESSION_UPDATE_HEADING]
    if (omitted) lines.push(TRUNCATION_MARKER)
    for (const message of messages) lines.push(renderMessage(message))
    return { markdown: lines.join('\n\n'), willContinue: false }
  }
}

// ---------------------------------------------------------------------------
// SessionTranscriptObserver — per-session wiring unit
// ---------------------------------------------------------------------------

/** Callback contract for {@link SessionTranscriptObserver}. */
export interface SessionObserverOptions {
  /** Bounded delta window (KD-3); forwarded to every per-session renderer. */
  readonly maxDeltaMessages: number
  /** Invoked once per stepped reviewable turn/end with the rendered delta. */
  readonly onDelta: (sessionId: string, delta: Delta) => void
  /**
   * Invoked once per stepped reviewable turn/end (the same gate as `onDelta`),
   * before the delta is rendered — the delivery module (T6) counts completed
   * primary turns here to decrement its immuneTurns cooldown (spec §6).
   */
  readonly onSteppedTurnEnd?: (sessionId: string) => void
  /**
   * Invoked when a rewrite event is observed (`compact/*` or a non-append
   * surface op) — the delivery module (T6) clears its immuneTurns latch here
   * (KD-5 reset triggers). Fires before the turn gate: a rewrite can arrive
   * outside a turn/end.
   */
  readonly onRewrite?: (sessionId: string) => void
}

/** `turn/end` reasons the advisor reviews (spec §4 — skip cut-short turns). */
const REVIEWABLE_TURN_END_KINDS: ReadonlySet<string> = new Set(['completed', 'max-tokens', 'error'])

/** True when a `turn/end` event carries a reviewable end reason. */
export function isReviewableTurnEnd(event: SessionEvent): boolean {
  return event.type === 'turn/end' && REVIEWABLE_TURN_END_KINDS.has(event.data.reason.kind)
}

/**
 * True when an event is a human-input arrival — the trigger of the agentic
 * reply-complete gate (KD-N4-5).
 *
 * - `user/message` with `source.kind === 'user'` — the primary signal: a
 *   direct human prompt (the queued message claimed for a step).
 * - `agent/inbox/spliced` — the fallback: inbox-spliced input commits as
 *   this log-only event first and may never re-emit as `user/message`
 *   (the merged `SessionEventMap` entry comes from the dsh-agent peer, per
 *   the `compact/*` precedent). Payload-discriminated (C-1 fix): the event
 *   only triggers when `inserted` is non-empty and carries at least one
 *   message whose `source.kind === 'user'`. Every other inbox mutation is
 *   excluded — the advisor's OWN inject/steer deliveries (source.kind
 *   `advisor`), workspace-context sync (`workspace-instructions`),
 *   tool-result splicing (`tool`), and claim/clear splices (empty
 *   `inserted`) must not self-trigger the review gate.
 *
 * Synthetic/injected user-role messages (tool results, advisor notes,
 * workspace context) carry other `source.kind` values and never trigger.
 */
export function isHumanInputEvent(event: SessionEvent): boolean {
  if (event.type === 'user/message') return event.data.source.kind === 'user'
  if (event.type === 'agent/inbox/spliced') {
    return event.data.inserted.some((message) => message.source.kind === 'user')
  }
  return false
}

/**
 * One renderer per session id, driven by `session/event` tuples. Cordis-free,
 * so the wiring logic is unit-testable; `index.ts` binds the cordis listeners
 * into an instance and forwards `session.events` (the live log).
 */
export class SessionTranscriptObserver {
  private readonly renderers = new Map<string, DeltaRenderer>()
  /** seedTo lengths issued before a session's renderer existed (KD-5 enable). */
  private readonly pendingSeeds = new Map<string, number>()
  /**
   * Mode latch (KD-N4-5): sessions that have produced ANY `turn/end` event.
   * Once a session emits `turn/end` it is a standard turn-driven session —
   * the new agentic reply-complete gate sleeps for it (verbatim behavior,
   * including spec §4 skip-aborted: a cut-short first turn's unreviewed
   * increment must not be supplementarily reviewed). Agentic/harness
   * sessions never emit `turn/end`, so they never latch and the new gate
   * stays active. Per-session; cleared on dispose.
   */
  private readonly turnEndSessions = new Set<string>()
  /** Bounded delta window (KD-3); forwarded to every per-session renderer. */
  private maxDeltaMessages: number

  constructor(private readonly options: SessionObserverOptions) {
    this.maxDeltaMessages = options.maxDeltaMessages
  }

  /**
   * Update the bounded delta window (live config — settings onChange, plan
   * dsh-advisor-settings-n2 T1): the observer default AND every live
   * per-session renderer, so existing sessions pick up the new bound without
   * losing their fold state.
   */
  setMaxDeltaMessages(value: number): void {
    this.maxDeltaMessages = value
    for (const renderer of this.renderers.values()) renderer.setMaxDeltaMessages(value)
  }

  /**
   * Feed one session event (mirroring the cordis `session/event` listener:
   * `(session, event)` — `events` is the session's live log, `event` the
   * appended event). Renders (and emits via `onDelta`) on either trigger:
   * a stepped `turn/end` with a reviewable reason (standard sessions), or a
   * human-input arrival with an unreviewed assistant increment (agentic
   * sessions — the reply-complete gate, KD-N4-5). The mode latch keeps the
   * second gate dormant for any session that emits `turn/end`.
   */
  handleEvent(sessionId: string, events: readonly SessionEvent[], event: SessionEvent): void {
    // KD-5 reset surface: a rewrite event (compact/*, non-append surface op)
    // clears the delivery immuneTurns latch immediately (T6) — before the turn
    // gate, since a rewrite can arrive outside a turn/end.
    if (isRewriteEvent(event)) this.options.onRewrite?.(sessionId)
    // Mode latch: ANY turn/end marks the session as standard turn-driven. Set
    // before the reviewable check — a non-reviewable (aborted/blocked) end
    // still latches, so the new gate never supplementarily reviews a cut-short
    // round (spec §4).
    if (event.type === 'turn/end') this.turnEndSessions.add(sessionId)
    if (isReviewableTurnEnd(event)) {
      // Stepped-turn gate: the arriving turn/end must be the latest closed turn
      // that entered at least one model step (dsh semantics — no-step turns from
      // rejection / empty input / cancellation are not reviewed).
      const latest = findLastMessageTurnEnd(events)
      if (latest === undefined || latest.seq !== event.seq) return
      // One completed stepped primary turn — the delivery module (T6) counts
      // these to decrement its immuneTurns cooldown. Fires before the render so
      // the note produced by this very turn routes with the decremented value.
      this.options.onSteppedTurnEnd?.(sessionId)
      const delta = this.rendererFor(sessionId).update(events)
      if (delta !== undefined) this.options.onDelta(sessionId, delta)
      return
    }
    // KD-N4-5 reply-complete gate (agentic sessions, no turn/end): fire only
    // on human-input arrival for a session that never latched as standard.
    if (this.turnEndSessions.has(sessionId)) return
    if (!isHumanInputEvent(event)) return
    const renderer = this.rendererFor(sessionId)
    // Read-only predicate — never advances the cursor on a miss: the first
    // user input of a session must not trigger nor advance (a blind update()
    // would pre-advance the cursor and lose the user prompt from the first
    // standard-session turn/end delta).
    if (!renderer.hasUnreviewedAssistant(events)) return
    // One completed reply round — the immuneTurns countdown (T6) fires before
    // the render, same ordering as the turn/end path.
    this.options.onSteppedTurnEnd?.(sessionId)
    // Append-type trigger: the arriving input opens the next round — exclude
    // the trigger event itself so it never enters the delta (the wiring
    // guarantees `event` is the last log entry). skipLast does this WITHOUT
    // the O(full-log) copy the previous `events.slice(0, -1)` paid on every
    // review (qc3 F1). Rewrite-type trigger (compact summary replace): pass
    // the full log so `update()` detects the rewrite and replays the
    // post-rewrite surface (KD-5).
    const delta = isRewriteEvent(event)
      ? renderer.update(events)
      : renderer.update(events, true)
    if (delta !== undefined) this.options.onDelta(sessionId, delta)
  }

  /** Lazy per-session renderer creation, shared by both trigger modes. */
  private rendererFor(sessionId: string): DeltaRenderer {
    let renderer = this.renderers.get(sessionId)
    if (renderer === undefined) {
      renderer = new DeltaRenderer({ maxDeltaMessages: this.maxDeltaMessages })
      const seed = this.pendingSeeds.get(sessionId)
      if (seed !== undefined) {
        renderer.seedTo(seed)
        this.pendingSeeds.delete(sessionId)
      }
      this.renderers.set(sessionId, renderer)
    }
    return renderer
  }

  /** Drop a session's renderer (wiring: `session/disposed` / `agent/disposed`). */
  disposeSession(sessionId: string): void {
    this.renderers.delete(sessionId)
    this.pendingSeeds.delete(sessionId)
    this.turnEndSessions.delete(sessionId)
  }

  /**
   * KD-5 seed-on-enable: skip existing history for a session's renderer.
   * Issued before the renderer exists (e.g. `/advisor on` before the session
   * produced a stepped turn), the seed is remembered and applied on creation.
   */
  seedTo(sessionId: string, length: number): void {
    const renderer = this.renderers.get(sessionId)
    if (renderer === undefined) {
      this.pendingSeeds.set(sessionId, length)
      return
    }
    renderer.seedTo(length)
  }
}
