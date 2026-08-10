/**
 * Advisor source kind + the `MessageSourceMap` merge extension (spec §6).
 *
 * Advisor-injected messages enter the session as user-role messages carrying
 * `source.kind === 'advisor'` (via the plugin's `MessageSourceMap` merge
 * declaration, `declare module '@deepseek-ai/dsh-llm'`). The delta renderer
 * (T3) and the delivery router (T6) both key off this kind:
 *
 * - **Self-review exclusion (spec §6):** every advisor-source message is
 *   excluded from subsequent advisor deltas, so the advisor never reads its
 *   own injected advice back.
 * - **Delivery tagging (T6):** `createUserMessage({ ..., source: { kind:
 *   ADVISOR_SOURCE_KIND } })` marks injected advice so it is visible in the
 *   session stream yet excluded from later deltas.
 *
 * @module dsh-advisor/kinds
 */

import type { Message } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * An advisor-injected message (user-role, self-describing
     * `[advisor:{severity}] {note}` content). Never derived into advisor
     * deltas (self-review guard, spec §6).
     */
    advisor: { readonly kind: 'advisor' }
  }
}

/** The `source.kind` value carried by every advisor-injected message. */
export const ADVISOR_SOURCE_KIND = 'advisor' as const

/** Type of a message source carrying the advisor kind. */
export type AdvisorSourceKind = typeof ADVISOR_SOURCE_KIND

/** True when a message was injected by the advisor itself. */
export function isAdvisorMessage(message: Message): boolean {
  return message.source.kind === ADVISOR_SOURCE_KIND
}
