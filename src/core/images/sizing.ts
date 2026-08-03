// Ink-height-matched font-size ESTIMATE for painted image-region text
// (Phase 3 polish round, Task C - live gate feedback: a chart legend "still
// a little bigger than the original... It really needs to be exact").
//
// The paint font size for an image region used to be estimated as
// bbox.h / ONE_LINE_HEIGHT_FACTOR (1.2) from the DILATED validation bbox
// (regions.ts's DILATION_PX). Dilation exists so the background FILL rect
// covers a couple of stray/antialiased px outside the original glyphs (see
// DILATION_PX's own doc comment) - but reusing that same inflated box as the
// SIZE estimate hurts small text worst: +2px/side is a much bigger relative
// fudge on an 8px legend line than on a 40px headline, so the old estimate
// made every painted line render visibly bigger than the original. Charlie's
// constraint: replacement text occupies only the ORIGINAL space, exactly.
//
// inkMatchedFontSizePt finds, by binary search, the font size at which a
// given string's MEASURED ink extent (skia-canvas's actualBoundingBoxAscent
// + actualBoundingBoxDescent - the real rasterized glyph extent, not an
// em-box/line-height approximation) equals a target ink height in px.
// Callers pass a region's PRE-dilation inkBBox.h (regions.ts) as that
// target, so the returned size is a CEILING for fit-engine.ts's fit(): fit()
// only ever shrinks from its starting size (see its own fit contract), so
// starting from the ink-matched size means width overflow still shrinks the
// text, but nothing ever grows past the size that reproduces the original
// ink height - exactness beats filling the box.
//
// Lives here (src/core/images/sizing.ts), not fit/fit-engine.ts: this is an
// image-region-specific size ESTIMATE that feeds fit()'s starting point, not
// a change to the fit contract itself - fit() must stay a pure shrink-only
// box-fit, unaware of ink-height semantics or image-region concerns. Also
// not gating.ts: that module is text/script classification (source-language
// gating, CJK detection for font-family choice), an unrelated concern from
// font-size measurement - bundling them would blur gating.ts's single job.
import type { FontSpec } from '../segments'
import { measureCtx, registerBundledFonts, resolveFamily } from '../fit/fonts'

/** Returned when the target ink height is degenerate (<= 0) - matches
 * fit-engine.ts's own FLOOR_PT, so a size this function can never usefully
 * match doesn't invent a plausible-looking number. */
const MIN_SIZE_PT = 0.5

/** Generous ceiling - no real image-region font size approaches this; it
 * only bounds the exponential search against pathological input (e.g.
 * all-whitespace text, which never gains ink height no matter how large the
 * font grows) so the search is guaranteed to terminate. */
const MAX_SIZE_PT = 2000

/** Final answer is within this many PT of the true root - the plan's
 * "within 0.25pt" acceptance band. This bounds the FONT SIZE the binary
 * search converges to, not the resulting ink height: skia-canvas's
 * actualBoundingBox metrics are themselves whole-pixel-quantized (they
 * report a rasterized glyph's tight pixel bounding box), so two adjacent
 * candidate sizes can measure the identical ink height right up until the
 * next pixel boundary - converging on SIZE is the only precision that is
 * always achievable by construction. */
const SIZE_TOLERANCE_PT = 0.25

/** Cap on iterations for EACH phase (exponential and binary) below -
 * comfortably more than either phase needs: the binary phase alone only
 * needs log2(MAX_SIZE_PT / MIN_SIZE_PT / SIZE_TOLERANCE_PT) ~= 24 steps to
 * shrink the full [MIN_SIZE_PT, MAX_SIZE_PT] bracket under the tolerance,
 * and real calls start from a MUCH tighter bracket than that (see below).
 * Guarantees termination even for a non-monotonic pathological font metric,
 * rather than looping forever. */
const MAX_ITERATIONS = 40

/** Mirrors fit-engine.ts's/overlay.ts's own private setFont: same
 * font-string shape (1px == 1pt convention) and the same resolveFamily()
 * substitution, so a size measured here is measured with the identical font
 * fit() and renderOverlay() will actually lay out / draw with. */
function setFont(sizePt: number, font: FontSpec): void {
  const { family } = resolveFamily(font.family)
  const weight = font.bold ? 'bold ' : ''
  const style = font.italic ? 'italic ' : ''
  measureCtx().font = `${style}${weight}${sizePt}px "${family}"`
}

/** `text`'s actual rendered ink extent at `sizePt`/`font` - NOT the
 * em-box/line-height approximation the old h/1.2 estimate used. Zero for
 * empty/whitespace-only text (no glyphs to measure), by construction. */
function measuredInkHeightPx(text: string, sizePt: number, font: FontSpec): number {
  setFont(sizePt, font)
  const m = measureCtx().measureText(text)
  return m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
}

/**
 * The font size at which `text` set in `font` renders with a measured ink
 * height (actualBoundingBoxAscent + actualBoundingBoxDescent) matching
 * `inkHeightPx`, found in two phases:
 *
 * 1. Exponential ("galloping") search - same style as fit-engine.ts's own
 *    fitLength - starting from a bracket of [MIN_SIZE_PT, inkHeightPx * 1.2]
 *    (the old heuristic as the initial upper-bound guess: already within a
 *    small constant factor of the true answer for ordinary text, so this
 *    phase is usually 0-1 doublings), doubling the upper bound until its
 *    measured ink height reaches or exceeds the target.
 * 2. Binary search of the bracketed [lo, hi] range until its width is
 *    within SIZE_TOLERANCE_PT.
 *
 * Relies on ink height increasing monotonically with font size for any one
 * string/font pair - true of skia-canvas's glyph metrics, which scale
 * linearly with size (no integer-pixel hinting snap the way some browser
 * rasterizers apply at small sizes; verified empirically across latin and
 * CJK text at 4-100pt during development of this function).
 *
 * Degenerate input (all whitespace, or an inkHeightPx <= 0) never gains ink
 * height regardless of size; the iteration caps above guarantee termination
 * even then (the search bottoms out at MAX_SIZE_PT rather than spinning
 * forever). Callers only ever pass real OCR'd text with a positive measured
 * ink height in practice - regions.ts's content gate already requires at
 * least 2 letter/digit characters in any surviving region's text - so this
 * is a defensive backstop, not a real code path.
 */
export function inkMatchedFontSizePt(text: string, font: FontSpec, inkHeightPx: number): number {
  if (inkHeightPx <= 0) return MIN_SIZE_PT

  registerBundledFonts() // idempotent; guarantees the same glyphs overlay.ts will later paint with

  let lo = MIN_SIZE_PT
  let hi = Math.max(inkHeightPx * 1.2, MIN_SIZE_PT * 2)
  let hiInk = measuredInkHeightPx(text, hi, font)
  for (let i = 0; hiInk < inkHeightPx && hi < MAX_SIZE_PT && i < MAX_ITERATIONS; i++) {
    lo = hi
    hi = Math.min(hi * 2, MAX_SIZE_PT)
    hiInk = measuredInkHeightPx(text, hi, font)
  }

  for (let i = 0; i < MAX_ITERATIONS && hi - lo > SIZE_TOLERANCE_PT; i++) {
    const mid = (lo + hi) / 2
    if (measuredInkHeightPx(text, mid, font) < inkHeightPx) lo = mid
    else hi = mid
  }

  return (lo + hi) / 2
}
