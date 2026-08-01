// Shared source-language gate for detected image-text regions (Phase 3,
// Task 4/5). image-adapter.ts (standalone PNG/JPG, Task 4) and the pptx
// adapter's embedded-media hookup (Task 5) both import this SAME function
// so the gate can never drift between the two call sites - see the plan's
// Global Constraints ("Source-language gating") and Task 4 behavior
// contract point 2:
// docs/superpowers/plans/2026-07-31-phase-3-image-text.md

/** CJK Unified Ideographs + Hiragana/Katakana + Hangul + compatibility/
 * fullwidth forms - mirrors pptx-adapter.ts's own private CJK_RANGE (font-
 * family selection there is a different job than language gating here, but
 * the same script ranges answer both questions). */
const CJK_RANGE = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

/** Source languages this gate treats as CJK-scripted - substring match
 * against src/shared/languages.ts's LANGUAGES entries ('Chinese
 * (Simplified)', 'Chinese (Traditional)', 'Japanese', 'Korean'). */
const CJK_SOURCE_LANG_RE = /chinese|japanese|korean|mandarin|cantonese/i

/** Fraction of a region's non-space characters that must fall in a CJK
 * unicode range for its text to count as CJK - plan Task 4 behavior
 * contract point 2. */
const CJK_TEXT_RATIO_THRESHOLD = 0.3

function cjkRatio(text: string): number {
  const nonSpace = Array.from(text).filter((ch) => !/\s/.test(ch))
  if (nonSpace.length === 0) return 0
  const cjkCount = nonSpace.filter((ch) => CJK_RANGE.test(ch)).length
  return cjkCount / nonSpace.length
}

/**
 * True when `text` contains at least one CJK-scripted character - a coarser
 * "any CJK glyph at all" question than isSourceLanguageRegion's ratio-based
 * gate, used for font-FAMILY selection (Noto Sans vs Noto Sans CJK SC) by
 * image-adapter.ts. Exported from here rather than duplicated so the two
 * modules never define slightly different CJK unicode ranges by accident.
 */
export function containsCjk(text: string): boolean {
  return CJK_RANGE.test(text)
}

/**
 * True when `text` should be translated for a run whose source language is
 * `sourceLang` - the single shared gate every region-detecting adapter
 * applies identically, so a region gated out by one adapter is gated out by
 * every other given the same inputs (no copy-paste divergence).
 *
 * v1 rule (plan Global Constraints - "Source-language gating"): only a CJK
 * source language (zh/ja/ko) actually filters anything, requiring at least
 * CJK_TEXT_RATIO_THRESHOLD of the region's non-space characters to be
 * CJK-scripted; a pure-Latin region (a logo, a part number) under a CJK
 * source is left untouched - no segment, no skip, legitimate leave-alone
 * content. Any OTHER source language (English, Spanish, ...) accepts every
 * region without filtering: detecting "is this text actually written in
 * English" from script alone isn't possible the way CJK-vs-Latin is, so v1
 * doesn't attempt it. The resulting risk (an en-source deck's foreign-
 * script logo getting translated) is an explicit Charlie-eyeball item at
 * the phase gate, not something this function tries to solve.
 */
export function isSourceLanguageRegion(sourceLang: string, text: string): boolean {
  if (!CJK_SOURCE_LANG_RE.test(sourceLang)) return true
  return cjkRatio(text) >= CJK_TEXT_RATIO_THRESHOLD
}
