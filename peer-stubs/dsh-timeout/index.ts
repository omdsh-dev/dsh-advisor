/**
 * Dev-time minimal functional stand-in for `@deepseek-ai/dsh-timeout` — the
 * shared timeout arithmetic, signal fusion, and classification consumed by
 * dsh-advisor's per-call deadline (`deadline` + `timeoutOf` + the
 * `TimeoutReason` / `Deadline` shapes).
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface of the dsh-private
 * `packages/util/timeout` seam and implements the exact fuse/classify
 * semantics the advisor runtime's hang-protection tests exercise. Pinned to
 * dsh-private commit b8343cb (2026-08-09 snapshot). Keep in sync when the
 * dsh-private baseline moves.
 */

/** Internal abort reason carrying a capability-owned code and elapsed deadline. */
export class TimeoutReason extends Error {
  override name = 'TimeoutReason'

  constructor(readonly code: string, readonly timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`)
  }
}

/** Largest delay Node schedules without clamping it to one millisecond. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** A deadline signal plus the cleanup that clears its timer (dispose-once). */
export interface Deadline {
  /** Aborts on upstream cancellation OR on timeout (the timeout carries a {@link TimeoutReason}). */
  readonly signal: AbortSignal
  /** Clear the timer. Safe to call once; `using` calls it at scope exit. */
  [Symbol.dispose](): void
}

function assertTimerDelay(timeoutMs: number, name: string): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/**
 * Fuse upstream cancellation with an identifiable timeout. `timeoutMs <= 0` is
 * the internal no-timer sentinel; the returned disposer clears an armed timer.
 * The signal only notifies, so callers must stop their own work.
 */
export function deadline(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): Deadline {
  if (timeoutMs <= 0) {
    // No timeout (background work): forward only the upstream signal, or a
    // never-aborting one when there is no upstream.
    return { signal: upstream ?? new AbortController().signal, [Symbol.dispose]() {} }
  }

  assertTimerDelay(timeoutMs, 'deadline timeoutMs')

  const timer = new AbortController()
  const id = setTimeout(() => { timer.abort(new TimeoutReason(code, timeoutMs)) }, timeoutMs)
  return {
    // AbortSignal.any adopts the reason of whichever source aborts FIRST, so a
    // race resolves to a single cause: timeoutOf() reads TimeoutReason only
    // when the timeout won, and upstream-wins leaves an ordinary abort reason.
    signal: upstream === undefined ? timer.signal : AbortSignal.any([upstream, timer.signal]),
    [Symbol.dispose]() { clearTimeout(id) },
  }
}

/**
 * Recover a timeout reason from a reason-bearing object. Supplying `code`
 * distinguishes this deadline from a nested upstream deadline; a foreign code
 * follows the ordinary cancellation path.
 */
export function timeoutOf(
  x: AbortSignal | { reason?: unknown },
  code?: string,
): TimeoutReason | undefined {
  const reason = (x as { reason?: unknown }).reason
  if (!(reason instanceof TimeoutReason)) return undefined
  if (code !== undefined && reason.code !== code) return undefined
  return reason
}
