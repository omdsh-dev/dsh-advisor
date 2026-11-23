/**
 * Next-prompt suggestion controller (plan dsh-advisor-next-prompt-n12,
 * task 3). One instance per session scope binding: it polls/fetches the
 * single-line next-prompt suggestion the reviewer stored for the session's
 * next turn (`/api/advisor/suggestion`, T2) and exposes it through a
 * uSES-safe snapshot store the ghost overlay renders from.
 *
 * Wire contract (src/gateway.ts, T2): `{ suggestion: string | null }` on
 * success; plugin-domain tagged errors ride in RETURNED data —
 * `advisor/rejected` (empty/invalid sessionId) and `advisor/unavailable`
 * (no elected owner on the serving fiber) — never a thrown coded failure.
 * Every failure shape (tagged error, `ok:false` transport fold, malformed
 * payload, or a throw) settles `status: 'unavailable'` with
 * `suggestion: null`: the ghost renders nothing and the NEXT fetch point
 * (consumed refresh signal or scheduled idle poll) is the next attempt —
 * the controller never retries on its own.
 *
 * Ordering is fenced by a monotonic `requestSeq` (the same generation-fence
 * shape as `AdvisorSessionModelController`): a newer fetch supersedes an
 * unresolved older one, whose settle is discarded wholesale — a late
 * response can never overwrite a newer answer.
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * The idle-poll cadence: while the surface is idle (no suggestion, empty
 * draft, plain phase) the overlay refetches at this interval; any other
 * state clears the timer (the component owns the schedule).
 */
export const NEXT_PROMPT_IDLE_POLL_MS = 30_000

/** The ghost overlay's snapshot. */
export interface AdvisorSuggestionState {
  /** idle → pending (fetch in flight) → ready; every failure latches unavailable. */
  status: 'idle' | 'pending' | 'ready' | 'unavailable'
  /** The stored suggestion for this session; null = nothing to show. */
  suggestion: string | null
}

/** The wire payload of `/api/advisor/suggestion` (client mirror of T2). */
type AdvisorSuggestionRpcPayload =
  | { suggestion: string | null }
  | { error: { tag: string; message: string } }

/**
 * Per-session suggestion controller (one per session scope binding — the
 * slot renderer memoizes the inject face, so the instance lives and dies
 * with the binding and every fetch carries its own sessionId).
 */
export class AdvisorSuggestionController {
  readonly sessionId: string

  /** The snapshot the ghost overlay renders from (uSES-safe store). */
  readonly store: SnapshotStore<AdvisorSuggestionState> = createSnapshotStore<AdvisorSuggestionState>({
    status: 'idle',
    suggestion: null,
  })

  /** Fence token: a newer fetch makes every older settle stale. */
  private requestSeq = 0
  /** A locally accepted/dismissed value stays hidden across polls until the host clears it. */
  private consumedText: string | null = null

  /**
   * A submission starts a new suggestion generation. The host input machine
   * exposes `submitting` before returning to plain; this boundary, unlike a
   * focus/reconnect signal, distinguishes identical text on consecutive turns.
   * Fence in-flight polls from the preceding turn at the same time.
   */
  beginTurn(): void {
    this.requestSeq += 1
    this.consumedText = null
    this.store.update((s) => {
      s.status = 'idle'
      s.suggestion = null
    })
  }

  /** Last consumed refresh-signal epoch (reconnect / focus bumps). */
  private lastSignal: number | undefined

  constructor(sessionId: string, private readonly rpc: ClientConnectionRpc) {
    this.sessionId = sessionId
  }

  /**
   * Record the refresh-signal epoch and report whether it is NEW. Idempotent
   * per epoch, so a re-render never double-fetches (the same plane the
   * session header action consumes).
   */
  takeSignal(epoch: number): boolean {
    if (this.lastSignal === epoch) return false
    this.lastSignal = epoch
    return true
  }

  /**
   * Fetch the stored suggestion (`/api/advisor/suggestion`). A stale settle
   * (a newer fetch superseded this one) is discarded wholesale. Success →
   * `ready` + the suggestion (an empty/absent string normalizes to null —
   * nothing to show); every failure shape (tagged `advisor/rejected` /
   * `advisor/unavailable`, `ok:false`, malformed payload, or a throw) →
   * `unavailable` + suggestion null. Never throws.
   */
  async fetch(): Promise<void> {
    const seq = ++this.requestSeq
    this.store.update((s) => { s.status = 'pending' })
    let payload: AdvisorSuggestionRpcPayload | undefined
    try {
      const result = await this.rpc.call('/api', 'advisor/suggestion', { args: { sessionId: this.sessionId } })
      if (result.ok) payload = result.value as AdvisorSuggestionRpcPayload
    } catch {
      // Transport failure → payload stays undefined (unavailable below).
    }
    if (seq !== this.requestSeq) return
    // The object guard keeps the shape check inside the documented
    // every-malformed-payload path: a contract-violating PRIMITIVE payload
    // (`'suggestion' in 42` would throw TypeError) settles `unavailable`
    // like every other malformed shape, never an unhandled rejection.
    if (
      payload !== undefined
      && typeof payload === 'object'
      && payload !== null
      && 'suggestion' in payload
    ) {
      const suggestion = typeof payload.suggestion === 'string' && payload.suggestion.length > 0
        ? payload.suggestion
        : null
      if (suggestion === null) this.consumedText = null
      this.store.update((s) => {
        s.status = 'ready'
        s.suggestion = suggestion === this.consumedText ? null : suggestion
      })
      return
    }
    // Tagged error, transport fold, malformed payload, or a throw: the
    // surface renders nothing; the next consumed signal / scheduled poll is
    // the next attempt (no self-retry, no storm).
    this.store.update((s) => {
      s.status = 'unavailable'
      s.suggestion = null
    })
  }

  /**
   * Clear the suggestion after the ghost filled the draft (the optimistic
   * side of the fill): the ghost disappears the moment the draft fills, and
   * the next converging fetch is harmless (the host still owns the stored
   * suggestion until the session's next turn consumes it).
   */
  consume(): void {
    this.consumedText = this.store.getSnapshot().suggestion
    this.store.update((s) => {
      s.status = 'ready'
      s.suggestion = null
    })
  }
}
