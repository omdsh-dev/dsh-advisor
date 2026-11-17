/**
 * dsh-advisor reviewer system prompt (spec §6, §8.2 KD-2) + the next-prompt
 * prediction system prompt (plan dsh-advisor-next-prompt-n12, T1).
 *
 * The advisor is an independent reviewer attached to a coding session: it
 * receives an incremental markdown delta prefixed with `### Session update`
 * (the T3 `DeltaRenderer` output) after each stepped primary turn and replies
 * with exactly one JSON object `{"note", "severity"}`.
 *
 * The prompt pins the delivery contract KD-2 relies on:
 * - the reviewer framing (independent, advisory-only — never approves actions);
 * - the severity definitions from spec §6 (nit / concern / blocker);
 * - the JSON-frame output contract: exactly one object, `severity` optional
 *   (omitted = nit), `note` non-empty, one note per update;
 * - a valid "nothing to add" frame, which the T5 emission guard's content-free
 *   suppression filters out at delivery time.
 *
 * The extraction code tolerates prose/fences defensively, but the prompt asks
 * for a bare frame so the happy path is a clean parse.
 *
 * @module dsh-advisor/prompts
 */

export const DEFAULT_ADVISOR_SYSTEM_PROMPT = `You are an independent reviewer attached to a coding-agent session. You observe the primary agent's work and surface concise, severity-ranked advice. You are advisory only: you never approve or reject the agent's actions, and you never issue commands as if you were the primary agent.

After each completed primary turn you receive an incremental transcript update prefixed with "### Session update" (a user message). Review only what changed in this update.

Severity levels:
- nit: a minor style, clarity, or quality suggestion; no course change is needed.
- concern: a material risk or a clearly better direction that the primary should weigh before continuing.
- blocker: continuing clearly wastes work — the primary contradicts an explicit user instruction, is going in circles, or the approach is fundamentally unsound.

Reply with EXACTLY ONE JSON object and nothing else:
{"note": "<your note>", "severity": "nit"|"concern"|"blocker"}

- "severity" is optional; when omitted it means "nit".
- "note" must be a non-empty string: one concise, specific, actionable observation about this update. One note per update.
- If there is genuinely nothing worth advising, respond with {"note": "Nothing to add"}.
- Do not include prose, markdown fences, or anything outside the JSON object.`

/**
 * The next-prompt prediction system prompt (plan dsh-advisor-next-prompt-n12,
 * T1): after each completed primary turn the predictor receives the same
 * incremental transcript delta and replies with ONE plausible next user
 * prompt for this session — a bare single line, or the literal `NONE` when
 * nothing is predictable (the caller drops the empty/`NONE` reply silently —
 * best-effort, no retry-worthy signal).
 */
export const DEFAULT_NEXT_PROMPT_SYSTEM_PROMPT = `You predict a coding-agent session's likely next user prompt. You receive a transcript update of the work just completed. Reply with ONE concise, plausible, single-line next user prompt for this session — no quotes, no markdown, no explanation. If nothing is predictable, reply with exactly NONE.`

/**
 * The prediction system prompt with the serving text bound spelled out
 * (GitHub issue #155): the stored suggestion is bounded by
 * `nextPromptMaxChars`, and stating the budget in the prompt asks the model to
 * produce a text that fits instead of being trimmed afterwards. Advisory only —
 * the shaping step remains the enforcement, so a model that ignores the budget
 * still cannot overrun it. `maxChars <= 0` means no bound: the plain prompt.
 */
export function nextPromptSystemPrompt(maxChars: number): string {
  if (maxChars <= 0) return DEFAULT_NEXT_PROMPT_SYSTEM_PROMPT
  return `${DEFAULT_NEXT_PROMPT_SYSTEM_PROMPT} Keep the reply within ${maxChars} characters.`
}
