/**
 * Advisor source identity + the predicate every consumer keys off (spec §6).
 *
 * Advisor-injected messages enter the session as user-role messages carrying
 * the **classified first-party** `plugin` arm:
 * `source = { kind: 'plugin', plugin: ADVISOR_PLUGIN_ID, ... }` (see
 * {@link AdvisorSource}). The delta renderer (T3) and the delivery router (T6)
 * both key off this shape via {@link isAdvisorMessage}:
 *
 * - **Self-review exclusion (spec §6):** every advisor-source message is
 *   excluded from subsequent advisor deltas, so the advisor never reads its
 *   own injected advice back.
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
 * persisted. A replay trigger resets the renderer cursor and `rebuild()`
 * re-filters the replayed log through {@link isAdvisorMessage}, so a historical
 * note written under the old id stops matching and the advisor reads its own
 * injected advice back as primary transcript. `tests/delivery.test.ts` pins the
 * literal value for exactly that reason — so a rename fails a test instead of
 * the already-written logs.
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
