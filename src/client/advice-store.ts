/**
 * Delivered-advice tip controller (this change). One instance per session
 * scope binding: it fetches the LAST advice note the delivery router accepted
 * (`/api/advisor/advice`) so the composer dock can surface one visible tip —
 * the durable injected message itself stays context-only in the transcript.
 *
 * Wire contract (src/gateway.ts, `getAdvice`): `{ advice: { severity, note,
 * deliveryId } | null }` on success; plugin-domain tagged errors ride in
 * RETURNED data — `advisor/rejected` (empty/invalid sessionId) and
 * `advisor/unavailable` (no elected owner on the serving fiber) — never a
 * thrown coded failure.
 *
 * Polling mirrors the next-prompt controller: fetch on mount, on every
 * consumed refresh-signal epoch, and through an unconditional idle poll (a
 * note being shown does not stop it: the server clears at the turn boundary
 * and later delivers new ids, both of which only a refetch can observe). A
 * newer fetch fences an older settle (`requestSeq`).
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The tip's idle-poll cadence (same plane as the suggestion tip). */
export const ADVICE_IDLE_POLL_MS = 30_000

/** Severity of one delivered advice note. */
export type AdviceSeverity = 'nit' | 'concern' | 'blocker'

/** One visible advice note. */
export interface AdvisorAdvice {
  readonly severity: AdviceSeverity
  readonly note: string
  /** Per-delivery identity; the tip keys its dismissal on this. */
  readonly deliveryId: number
}

/** The advice tip's snapshot. */
export interface AdvisorAdviceState {
  /** idle → pending (fetch in flight) → ready; every failure latches unavailable. */
  status: 'idle' | 'pending' | 'ready' | 'unavailable'
  /** The last delivered note for this session; null = nothing to show. */
  advice: AdvisorAdvice | null
}

/** The wire payload of `/api/advisor/advice` (client mirror of the gateway face). */
type AdvisorAdviceRpcPayload =
  | { advice: { severity: AdviceSeverity; note: string; deliveryId: number } | null }
  | { error: { tag: string; message: string } }

/** Per-session advice controller (one per slot binding). */
export class AdvisorAdviceController {
  readonly sessionId: string
  readonly store: SnapshotStore<AdvisorAdviceState> = createSnapshotStore<AdvisorAdviceState>({
    status: 'idle',
    advice: null,
  })
  private requestSeq = 0
  private lastSignal: number | undefined

  constructor(sessionId: string, private readonly rpc: ClientConnectionRpc) {
    this.sessionId = sessionId
  }

  /** Record the refresh-signal epoch and report whether it is NEW. */
  takeSignal(epoch: number): boolean {
    if (this.lastSignal === epoch) return false
    this.lastSignal = epoch
    return true
  }

  /** Fetch the stored advice; every failure renders nothing until the next poll. */
  async fetch(): Promise<void> {
    const seq = ++this.requestSeq
    this.store.update((s) => { s.status = 'pending' })
    let payload: AdvisorAdviceRpcPayload | undefined
    try {
      const result = await this.rpc.call('/api', 'advisor/advice', { args: { sessionId: this.sessionId } })
      if (result.ok) payload = result.value as AdvisorAdviceRpcPayload
    } catch {
      // Transport failure → payload stays undefined (unavailable below).
    }
    if (seq !== this.requestSeq) return
    if (
      payload !== undefined
      && typeof payload === 'object'
      && payload !== null
      && 'advice' in payload
    ) {
      const advice = payload.advice
      const valid = advice !== null
        && typeof advice === 'object'
        && (advice.severity === 'nit' || advice.severity === 'concern' || advice.severity === 'blocker')
        && typeof advice.note === 'string'
        && advice.note.length > 0
        && Number.isInteger(advice.deliveryId)
        && advice.deliveryId >= 1
      this.store.update((s) => {
        s.status = 'ready'
        s.advice = valid
          ? { severity: advice.severity, note: advice.note, deliveryId: advice.deliveryId }
          : null
      })
      return
    }
    this.store.update((s) => {
      s.status = 'unavailable'
      s.advice = null
    })
  }
}
