/**
 * Benchmark: DeltaRenderer delivered-prefix fingerprint cost (audit finding 004).
 *
 * `DeltaRenderer.update()` recomputes an O(prefix) message-id fingerprint on
 * every call — the defensive replay check over the delivered prefix
 * (`src/transcript.ts:280`) plus the tail assignment (`:290`) — so a long
 * session pays two full-prefix hashes per event batch. This bench measures
 * both hot paths through the real public API at realistic session sizes and
 * feeds the spec-004 Task 1 STOP gate: if the fingerprint work on the
 * incremental append path stays well below ~1 ms/op at N=2000 on this
 * machine, the plan closes as a documented no-op (no optimization warranted).
 *
 * - (a) full fingerprint: a no-op `update()` at cursor N (the delivered log
 *   is unchanged) recomputes `fingerprintOf` twice over all N events — the
 *   replay check (:280) and the tail assignment (:290) — with zero
 *   append/render work. This is an upper bound on the fingerprint work of
 *   any single update, including the hot append path.
 * - (b) incremental append: cursor rewind to N-1 (`seedTo`, O(1)) then
 *   `update()` appends the final event. The rewind clears the cached
 *   fingerprint, so this measures the append path with ONE full recompute
 *   (the :290 tail assignment; the :280 defensive check is skipped — the
 *   cold-cache case, e.g. right after seed-on-enable). The hot steady state
 *   additionally pays one more full recompute, which (a) already isolates.
 *
 * Synthetic logs alternate user/assistant surface events with deterministic
 * 16-char message ids, mirroring the factories in tests/transcript.test.ts
 * (that module cannot be imported here — it registers suites on load). An
 * all-message log is the worst case for the hash: every event contributes a
 * 16-char id instead of a short `e${index}` fallback.
 *
 * Run: pnpm exec vitest bench --run tests/bench-fingerprint.bench.ts
 * Verdict (audit 004, STOP gate applied): at N=2000 the full-prefix
 * recompute measured 0.57–0.64 ms/op and the incremental append path
 * 0.28–0.32 ms/op — both well below the 1 ms threshold, so no optimization
 * is warranted (documented no-op; numbers re-run on 2026-08-15 on an M1 Max
 * with Node 24 / vitest 3.2.7).
 */
import { bench, describe } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SurfaceOp } from '@deepseek-ai/dsh-session'
import { DeltaRenderer } from '../src/transcript'

interface EventSpec {
  type: string
  data: unknown
  surfaceOp?: SurfaceOp
}

/** Number events contiguously from seq 0 and cast to the SessionEvent union. */
function buildEvents(specs: readonly EventSpec[]): SessionEvent[] {
  return specs.map((spec, index) => {
    const event: Record<string, unknown> = {
      type: spec.type,
      seq: index,
      time: 1_000 + index,
      data: spec.data,
    }
    if (spec.surfaceOp !== undefined) event.surfaceOp = spec.surfaceOp
    return event as unknown as SessionEvent
  })
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

/**
 * A log of `count` surface events (alternating user/assistant) whose message
 * ids are deterministic 16-char strings — the fingerprint hot case.
 */
function messageLog(count: number): SessionEvent[] {
  const specs: EventSpec[] = []
  const width = String(count).length
  for (let index = 0; index < count; index++) {
    // 16-char id: `m` + zero-padded seq + filler (ids never repeat for
    // count < 100_000, so the hash input is stable across rebuilds).
    const id = `m${String(index).padStart(width, '0')}${'x'.repeat(15 - width)}`
    if (index % 2 === 0) {
      const source: MessageSource = { kind: 'user' }
      specs.push({
        type: 'user/message',
        data: { id: MessageId(id), role: 'user', content: [text('m')], source },
        surfaceOp: 'append',
      })
    } else {
      specs.push({
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: MessageId(id),
            role: 'assistant',
            content: [text('m')],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
        surfaceOp: 'append',
      })
    }
  }
  return buildEvents(specs)
}

describe('DeltaRenderer fingerprint hot path', () => {
  for (const n of [500, 2000, 10000]) {
    const events = messageLog(n)

    // (a) Full fingerprint cost of one update. The renderer is warmed once at
    // module scope (cursor N + cached fingerprint); every timed call is then a
    // no-op update that recomputes `fingerprintOf` over all N events twice.
    const fullRenderer = new DeltaRenderer()
    fullRenderer.update(events)
    bench(`(a) full fingerprint recompute, N=${n}`, () => {
      fullRenderer.update(events)
    })

    // (b) Incremental append at cursor N-1: O(1) seedTo rewind + the append
    // update (one fingerprint recompute over the full N prefix + one message
    // append/render). See the file header for the cold-cache caveat.
    const appendRenderer = new DeltaRenderer()
    bench(`(b) incremental append of 1 event, N=${n}`, () => {
      appendRenderer.seedTo(n - 1)
      appendRenderer.update(events)
    })
  }
})
