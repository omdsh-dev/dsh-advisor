/**
 * Advisor source identity + the predicate every consumer keys off (spec §6).
 *
 * Advisor-injected messages enter the session as user-role messages carrying
 * this plugin's OWN source kind (dsh 0.1.7-rc.1): `source = { kind: 'advisor',
 * form: 'notice', summary }` (see {@link AdvisorSource}). The delta renderer
 * (T3) and the delivery router (T6) both key off this shape via
 * {@link isAdvisorMessage}:
 *
 * - **Self-review exclusion (spec §6):** every message carrying the advisor's
 *   own kind is excluded from subsequent advisor deltas (the renderer filters
 *   it via {@link isAdvisorMessage}), so the advisor does not read back advice
 *   it injected under this shape.
 * - **Delivery tagging (T6):** `createUserMessage({ ..., source: ... })` marks
 *   injected advice so it is visible in the session stream yet excluded from
 *   later deltas.
 *
 * **Identity history — why the predicate matches two kinds.** `source.kind` is
 * a per-producer vocabulary, merge-extended into dsh-llm's `MessageSourceMap`
 * ("each producer declares its own kind in its own module"), NOT the frozen
 * first-party word list this file used to document: the V3→V4 format edge
 * (dsh-session-format-v3-to-v4) PRESERVES direct source kinds, so a
 * producer-owned kind is the persistence-safe identity. The advisor wrote two
 * earlier shapes, and logs carrying both stay openable, so the exclusion must
 * recognize them:
 *
 * - `{ kind: 'plugin', plugin: 'advisor', ... }` — the 0.1.6 note. V4 refuses
 *   a bare `plugin` kind on WRITE, and a V3 log is migrated IN MEMORY on open
 *   (never rewritten to disk; the advisor does not migrate logs): 'advisor' is
 *   neither a renamed nor a released producer, so the migration rewrites the
 *   kind to `plugin:advisor` and drops the `plugin` member. Matching the bare
 *   `plugin` arm would only widen the false-positive surface.
 * - `{ kind: 'advisor' }` — the prehistoric note (no `plugin` member at all).
 *   A direct kind rides through the same migration edge untouched, so these
 *   notes re-enter the match — this FIXES the once-accepted orphaning of that
 *   generation's exclusion (a full-surface replay re-folds the log through
 *   {@link isAdvisorMessage}, which used to let those notes back in).
 *
 * Both legacy shapes only ever appear on READ (migrated V3 logs); the advisor
 * itself now writes only `kind: 'advisor'`.
 *
 * @module dsh-advisor/kinds
 */

import type { ContextFormed, Message } from '@deepseek-ai/dsh-llm'

/**
 * Claim the advisor's producer kind in dsh-llm's source map (declaration
 * merging, the documented extension point — same precedent as dsh-tools'
 * `tool-registry` and dsh-agent's `model-selection`). The kind is owned by
 * this module and pinned to the one context form the advisor declares.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    advisor: { kind: 'advisor' } & ContextFormed
  }
}

/**
 * The producer identity of every advisor-injected message.
 *
 * **Persisted key, not a free-to-rename internal id.** This literal is written
 * into session logs as `source.kind` on every injected note (and matched
 * against the migrated `plugin:<id>` kind of 0.1.6-era notes), so it is part
 * of the durable on-disk format rather than a name this plugin may revalue:
 * changing it orphans the self-review exclusion (spec §6) for notes already
 * persisted — the exact cost this migration chain has paid twice (see the
 * module doc). A replay trigger resets the renderer cursor and `rebuild()`
 * re-filters the replayed log through {@link isAdvisorMessage}, so a
 * historical note written under a since-revalued identity stops matching and
 * the advisor reads its own injected advice back as primary transcript.
 * `tests/delivery.test.ts` pins the literal value for exactly that reason —
 * so a rename fails a test instead of the already-written logs.
 *
 * The bare `advisor` id is deliberate (PM decision on QC2-F-001 — the suggested
 * rename to a namespaced `dsh-advisor` was declined): it matches the plugin's
 * identity everywhere else — the bundle row `id: advisor` (`cordis.patch.yml`,
 * which is also the settings entry id), the gateway service key, and the
 * `/advisor` command name — so a different id here would split that identity
 * and change the user-visible shell label for no durable gain.
 */
export const ADVISOR_PLUGIN_ID = 'advisor' as const

/**
 * Source shape of an advisor-injected message: this plugin's own producer
 * kind, **pinned** to the one context form the advisor actually declares.
 * `Extract<ContextFormed, { form: 'notice' }>` contributes the form-owned
 * `summary` and refuses the other arms (`snapshot`, `instructions`, `catalog`,
 * `relay`, `recall`, undeclared), so the type states the shape the delivery
 * module writes instead of merely permitting it; no plugin-owned payload is
 * ever added beside these members.
 */
export type AdvisorSource = {
  readonly kind: typeof ADVISOR_PLUGIN_ID
} & Extract<ContextFormed, { readonly form: 'notice' }>

/**
 * True when a message was injected by the advisor itself.
 *
 * Matches the kind the advisor writes today (`advisor`) AND the migrated
 * 0.1.6-era note (`plugin:advisor` — the V3→V4 in-memory migration of
 * `{ kind: 'plugin', plugin: 'advisor' }`); the prehistoric direct
 * `{ kind: 'advisor' }` note is covered by the first arm. The bare `plugin`
 * arm is NOT matched: V4 refuses it on write and migrates it on read, so it
 * can no longer appear in any openable log. The kind comparison goes through
 * a relaxed string view — `MessageSource`'s discriminated union has no
 * `plugin`-prefixed arm after the merge, and comparing the closed union
 * directly would be the TS2367 dead-check this repo must not paper over.
 */
export function isAdvisorMessage(message: Message): boolean {
  const kind = (message.source as { kind?: string }).kind
  return kind === ADVISOR_PLUGIN_ID || kind === `plugin:${ADVISOR_PLUGIN_ID}`
}
