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

/** The plugin identity carried by every advisor-injected message. */
export const ADVISOR_PLUGIN_ID = 'advisor' as const

/**
 * Source shape of an advisor-injected message: the classified first-party
 * `plugin` arm, owned by this plugin. `ContextFormed` contributes the
 * form-owned members (`form` + `summary` for the `notice` form the advisor
 * declares); no plugin-owned payload is ever added beside them.
 */
export type AdvisorSource = {
  readonly kind: 'plugin'
  readonly plugin: typeof ADVISOR_PLUGIN_ID
} & ContextFormed

/** True when a message was injected by the advisor itself. */
export function isAdvisorMessage(message: Message): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === ADVISOR_PLUGIN_ID
}
