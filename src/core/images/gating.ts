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
 * `sourceLang` - the single shared gate every region-detecting adapter (and,
 * since Phase 3 polish Task A, the per-segment TEXT pipeline gate in
 * pipeline.ts) applies identically, so content gated out by one call site is
 * gated out by every other given the same inputs (no copy-paste divergence).
 *
 * v2 rule, symmetric on script alone: CJK-vs-Latin is the only script
 * distinction this function can reliably detect (telling "is this actually
 * English" from "is this actually Spanish" isn't possible from characters
 * alone), so it compares whether sourceLang is CJK-scripted (zh/ja/ko)
 * against whether text itself is CJK-scripted (>= CJK_TEXT_RATIO_THRESHOLD
 * of non-space chars) and accepts only when the two agree:
 *   - CJK source, CJK-heavy text -> accept (ordinary case).
 *   - CJK source, Latin-heavy text -> reject (a logo, a part number -
 *     legitimate leave-alone content under a CJK source).
 *   - non-CJK source, CJK-heavy text -> reject (v1 left this case
 *     unfiltered - see history below - which is exactly the failure mode a
 *     live EN->ZH gate run hit: a mixed-language deck's already-Chinese
 *     content got "translated" (paraphrased) under an English source
 *     because nothing gated it. CJK script under a non-CJK source is just as
 *     clear a signal as Latin script under a CJK source, so it's now
 *     rejected the same way.)
 *   - non-CJK source, non-CJK text (e.g. English source, Spanish text) ->
 *     accept - no script-level signal either way, so this remains
 *     translatable exactly as v1 left it; v2 only closes the CJK-detectable
 *     half of the gap, not the general "which Latin language is this"
 *     problem (still not solvable from script alone).
 *
 * (History: v1 shipped only the CJK-source half of this symmetry; fixed in
 * Phase 3 polish Task A after that exact gap corrupted already-translated
 * content in a real deck.)
 */
export function isSourceLanguageRegion(sourceLang: string, text: string): boolean {
  const sourceIsCjk = CJK_SOURCE_LANG_RE.test(sourceLang)
  const textIsCjk = cjkRatio(text) >= CJK_TEXT_RATIO_THRESHOLD
  return sourceIsCjk === textIsCjk
}
