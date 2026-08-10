/**
 * Advisor settings page store (task-2 skeleton). One snapshot over the wire
 * faces the section renders from; the host stays the single fact source —
 * every mutation writes through the wire and the page re-renders from the
 * next describe, pushed or refetched. Task 3 extends this skeleton into the
 * full provider/settings join (configured-provider options, model options,
 * draft + Apply with path ops and expectedRevision).
 */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Page snapshot (skeleton: load status only; task 3 adds rows/draft facts). */
export interface AdvisorSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the form. */
  error: string | null
}

/**
 * The advisor settings page controller (one per settings surface). The
 * skeleton load round-trips the wire faces the form will consume (settings
 * describe + provider directory) so the status cycle is honest from day one;
 * the data projection itself arrives with task 3.
 */
export class AdvisorSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<AdvisorSettingsState> = createSnapshotStore<AdvisorSettingsState>({
    status: 'idle', error: null,
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the wire face (settings/llm domains).
   */
  constructor(private readonly api: Pick<IApiClient, 'settings' | 'llm'>) {}

  /**
   * Refresh the page snapshot. A failure keeps the last good status and
   * surfaces the error.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    try {
      const [providersResponse, settingsResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.api.settings.describe({}),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    if (generation !== this.generation) return
    this.store.update((s) => { s.status = 'ready'; s.error = null })
  }
}
