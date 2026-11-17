import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ADVISOR_NOTE_MAX_CHARS,
  DEFAULT_NEXT_PROMPT_MAX_CHARS,
  MAX_ADVISOR_NOTE_MAX_CHARS,
  MAX_NEXT_PROMPT_MAX_CHARS,
  MIN_ADVISOR_NOTE_MAX_CHARS,
  MIN_NEXT_PROMPT_MAX_CHARS,
  coerceTextBound,
  limitText,
} from '../src/text-limit'

// GitHub issue #155 — the shared bound helper behind both user-visible advisor
// surfaces (`nextPromptMaxChars` on the stored suggestion, `noteMaxChars` on
// the delivered note). The contract pinned here:
//   - the bounds are positive integers with schema floors (no 0 opt-out),
//   - a text within the bound is returned byte-identically,
//   - an over-long text is cut on a WORD boundary within the bound and marked
//     with `…`, which COUNTS toward the bound,
//   - the count is CODE POINTS (never UTF-16 units),
//   - a single over-long word falls back to a hard cut (a word-boundary cut
//     would collapse the text), and a long trailing word only loses the cut
//     when the boundary keeps ≥ 60 % of the budget.

describe('limitText — bounded code-point cut (GitHub issue #155)', () => {
  it('keeps the schema defaults and floors', () => {
    expect(DEFAULT_NEXT_PROMPT_MAX_CHARS).toBe(120)
    expect(DEFAULT_ADVISOR_NOTE_MAX_CHARS).toBe(768)
    expect(MIN_NEXT_PROMPT_MAX_CHARS).toBe(50)
    expect(MIN_ADVISOR_NOTE_MAX_CHARS).toBe(128)
    expect(MAX_NEXT_PROMPT_MAX_CHARS).toBe(2_000)
    expect(MAX_ADVISOR_NOTE_MAX_CHARS).toBe(4_096)
  })

  it('returns a text within the bound unchanged (no marker)', () => {
    expect(limitText('short advice', 768)).toBe('short advice')
    // Exactly at the bound.
    expect(limitText('abcde', 5)).toBe('abcde')
  })

  it('cuts on a word boundary and marks the cut, with the marker inside the bound', () => {
    const text = 'alpha beta gamma delta epsilon'
    const cut = limitText(text, 20)
    expect(Array.from(cut).length).toBeLessThanOrEqual(20)
    expect(cut).toBe('alpha beta gamma…')
    // The cut landed before a whole word, not inside one.
    expect(text.startsWith(cut.slice(0, -1))).toBe(true)
  })

  it('counts code points, never UTF-16 units (no lone surrogate)', () => {
    const cut = limitText('🚀'.repeat(200), 120)
    expect(Array.from(cut)).toHaveLength(120)
    expect(cut).toBe(`${'🚀'.repeat(119)}…`)
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('falls back to a hard cut for a single over-long word (nothing to preserve)', () => {
    expect(limitText('a'.repeat(130), 120)).toBe(`${'a'.repeat(119)}…`)
    // A huge trailing word must not collapse the text to its first phrase: the
    // boundary keeps only 60 % of the budget, so the hard cut applies.
    const withLongTail = `prefix ${'x'.repeat(1_000)}`
    const cut = limitText(withLongTail, 120)
    expect(Array.from(cut)).toHaveLength(120)
    expect(cut.endsWith('…')).toBe(true)
  })

  it('yields the bare marker for a bound of 1', () => {
    expect(limitText('anything', 1)).toBe('…')
  })

  it('is idempotent-safe: a marked text that still exceeds the bound is cut again', () => {
    const once = limitText('word '.repeat(400), 40)
    const twice = limitText(once, 40)
    expect(Array.from(twice).length).toBeLessThanOrEqual(40)
  })
})

describe('coerceTextBound — containment arms never report an invalid bound', () => {
  it('clamps a stored value into the schema range', () => {
    expect(coerceTextBound(0, 120, 50, 2_000)).toBe(50)
    expect(coerceTextBound(5_000, 768, 128, 4_096)).toBe(4_096)
    expect(coerceTextBound(200, 120, 50, 2_000)).toBe(200)
    expect(coerceTextBound(199.7, 120, 50, 2_000)).toBe(199)
  })

  it('falls back for a non-number or non-finite value', () => {
    expect(coerceTextBound(undefined, 120, 50, 2_000)).toBe(120)
    expect(coerceTextBound('120', 120, 50, 2_000)).toBe(120)
    expect(coerceTextBound(Number.NaN, 768, 128, 4_096)).toBe(768)
  })
})
