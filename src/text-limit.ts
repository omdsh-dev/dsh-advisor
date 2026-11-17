/**
 * Shared text-bound helper for the two user-visible advisor surfaces
 * (GitHub issue #155): the stored next-prompt suggestion
 * ({@link DEFAULT_NEXT_PROMPT_MAX_CHARS}) and the delivered advice note
 * ({@link DEFAULT_ADVISOR_NOTE_MAX_CHARS}).
 *
 * Before this module both bounds were hardcoded at their call sites and cut
 * the text with a raw `slice` — the suggestion silently, mid-word, with no
 * marker at all. The bounds are now configurable
 * (`nextPromptMaxChars` / `noteMaxChars`, `src/config.ts`), always POSITIVE
 * (each key has a schema floor), and every bounded cut ends on a WORD boundary
 * with a `…` marker so a shortened text can never read as a complete one.
 *
 * There is deliberately no "0 = unbounded" opt-out: the note bound is the only
 * output bound left after the 2026-10-18 `maxTokens` removal (it limits how
 * much secondary-model text enters the primary session as a user-role
 * message), so the setting may shrink or modestly grow the bound but never
 * remove it.
 *
 * The bound is counted in CODE POINTS, never UTF-16 code units: a unit-level
 * cut could split a surrogate pair and store a lone surrogate that renders as
 * U+FFFD.
 *
 * @module dsh-advisor/text-limit
 */

/** Schema default for {@link limitText} on the next-prompt suggestion. */
export const DEFAULT_NEXT_PROMPT_MAX_CHARS = 120

/** Schema default for {@link limitText} on the delivered advice note. */
export const DEFAULT_ADVISOR_NOTE_MAX_CHARS = 768

/** Schema floor for `nextPromptMaxChars` — a shorter dock tip is not a prompt. */
export const MIN_NEXT_PROMPT_MAX_CHARS = 50

/** Schema floor for `noteMaxChars` — a T5-steerable note needs this much text. */
export const MIN_ADVISOR_NOTE_MAX_CHARS = 128

/** Upper bound the schema accepts for `nextPromptMaxChars`. */
export const MAX_NEXT_PROMPT_MAX_CHARS = 2_000

/** Upper bound the schema accepts for `noteMaxChars` (≈ 5× the default). */
export const MAX_ADVISOR_NOTE_MAX_CHARS = 4_096

/** The single-character marker every bounded cut appends. */
const ELLIPSIS = '…'

/**
 * Bound `text` to `maxChars` CODE POINTS, cutting on a word boundary and
 * appending `…` (the marker counts toward the bound, so the result is always
 * `<= maxChars`).
 *
 * - A text within the bound is returned unchanged — no marker, byte-identical.
 * - A single word longer than the bound falls back to a hard cut: there is no
 *   word boundary to land on, and dropping the word would return nothing.
 *
 * `maxChars` is a positive integer at every call site (the schema floors are
 * {@link MIN_NEXT_PROMPT_MAX_CHARS} / {@link MIN_ADVISOR_NOTE_MAX_CHARS}); a
 * smaller value still cannot return more than the bound. Never throws.
 */
export function limitText(text: string, maxChars: number): string {
  const points = Array.from(text)
  if (points.length <= maxChars) return text
  // Reserve one code point for the marker so `body + …` never exceeds the
  // bound.
  const budget = Math.max(0, maxChars - 1)
  const body = points.slice(0, budget).join('')
  // The last whitespace run that still has text after it marks the trailing
  // (possibly partial) word; cut before it. Only accept that boundary when it
  // keeps most of the budget — a single huge "word" (a URL, a hash, a run of
  // filler) would otherwise collapse a near-full note to a few characters,
  // which is a worse outcome than a mid-word cut. `search` on a non-empty body
  // only matches at or after index 0; index 0 means the body is one leading
  // run — nothing worth preserving.
  const lastSpace = body.search(/\s\S*$/)
  const cut = lastSpace >= Math.ceil(budget * 0.6) ? body.slice(0, lastSpace) : body
  return `${cut.trimEnd()}${ELLIPSIS}`
}
