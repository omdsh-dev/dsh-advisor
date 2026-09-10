/**
 * Advisor source identity + the predicate every consumer keys off (spec §6).
 *
 * Advisor-injected messages enter the session as user-role messages carrying
 * the **classified first-party** `plugin` arm:
 * `source = { kind: 'plugin', plugin: ADVISOR_PLUGIN_ID, ... }` (see
 * {@link AdvisorSource}). The delta renderer (T3) and the delivery router (T6)
 * both key off this shape via {@link isAdvisorMessage}:
 *
 * - **Self-review exclusion (spec §6):** every message carrying the advisor's
 *   classified `plugin` arm is excluded from subsequent advisor deltas (the
 *   renderer filters it via {@link isAdvisorMessage}), so the advisor does not
 *   read back advice it injected under this shape. **Corollary of the durable
 *   rule below:** moving a plugin-owned identifier out of `source.kind` costs
 *   the recognizability of notes already persisted under the old identity — it
 *   orphans the exclusion for those notes. A note written before this
 *   migration carries the legacy custom kind (`kind: 'advisor'`), is therefore
 *   no longer matched by the predicate, and re-enters the advisor delta on any
 *   full-surface replay (compaction, a non-append `surfaceOp`, or a
 *   delivered-prefix fingerprint mismatch — `src/transcript.ts` `update()`
 *   resets and `rebuild()` re-folds the surviving surface from 0, skipping
 *   only what the predicate still matches), exactly once per replay. Accepted
 *   and bounded: no data loss, advisor-side self-review pollution only — the
 *   price of migrating a source identity, not a defect to be papered over.
 * - **Delivery tagging (T6):** `createUserMessage({ ..., source: ... })` marks
 *   injected advice so it is visible in the session stream yet excluded from
 *   later deltas.
 *
 * The plugin's identity must live in `source.plugin`, **never** in
 * `source.kind`: `kind` is a first-party vocabulary frozen per session-format
 * generation, and the V2→V3 edge refuses a whole log whose `kind` it cannot
 * classify (`cannot safely transform unclassified message source`). A custom
 * `kind` is therefore not a persistence extension point — only the `plugin`
 * arm is cross-generation-safe.
 *
 * @module dsh-advisor/kinds
 */

import type { ContextFormed, Message } from '@deepseek-ai/dsh-llm'

/**
 * The plugin identity carried by every advisor-injected message.
 *
 * **Persisted key, not a free-to-rename internal id.** This literal is written
 * into session logs as `source.plugin` on every injected note, so it is part of
 * the durable on-disk format rather than a name this plugin may revalue:
 * changing it orphans the self-review exclusion (spec §6) for notes already
 * persisted. That is not hypothetical, it is this migration's own record: the
 * shape before it was `{ kind: 'advisor' }` with no `plugin` member at all, so
 * every note persisted then is already orphaned this way, and revaluing the
 * literal again would repeat it. A replay trigger resets the renderer cursor
 * and `rebuild()` re-filters the replayed log through {@link isAdvisorMessage},
 * so a historical note written under the old identity stops matching and the
 * advisor reads its own injected advice back as primary transcript.
 * `tests/delivery.test.ts` pins the literal value for exactly that reason — so
 * a rename fails a test instead of the already-written logs.
 *
 * The bare `advisor` id is deliberate (PM decision on QC2-F-001 — the suggested
 * rename to a namespaced `dsh-advisor` was declined): it matches the plugin's
 * identity everywhere else — the bundle row `id: advisor` (`cordis.patch.yml`),
 * the `advisor` settings namespace (`ADVISOR_SETTINGS_NAMESPACE`), the gateway
 * service key, and the `/advisor` command name — so a different id here would
 * split that identity and change the user-visible shell label for no durable
 * gain.
 */
export const ADVISOR_PLUGIN_ID = 'advisor' as const

/**
 * Source shape of an advisor-injected message: the classified first-party
 * `plugin` arm, owned by this plugin, **pinned** to the one context form the
 * advisor actually declares. `Extract<ContextFormed, { form: 'notice' }>`
 * contributes the form-owned `summary` and refuses the other arms (`snapshot`,
 * `instructions`, `catalog`, `relay`, `recall`, undeclared), so the type states
 * the shape the delivery module writes instead of merely permitting it; no
 * plugin-owned payload is ever added beside these members.
 */
export type AdvisorSource = {
  readonly kind: 'plugin'
  readonly plugin: typeof ADVISOR_PLUGIN_ID
} & Extract<ContextFormed, { readonly form: 'notice' }>

/** True when a message was injected by the advisor itself. */
export function isAdvisorMessage(message: Message): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === ADVISOR_PLUGIN_ID
}
