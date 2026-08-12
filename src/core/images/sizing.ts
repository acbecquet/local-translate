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
import { containsCjk } from './gating'
import type { RegionBBox } from './regions'

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

/**
 * {ink height target, fit-box width, fit-box height floor} for one region,
 * accounting for rotation (polish round Task E: rotated +-90 text regions).
 * Centralizes the axis pick so image-adapter.ts's extract() and
 * pptx-adapter.ts's collectMediaSegments compute this identically instead of
 * each inlining their own copy of the swap - the two adapters must never
 * size a rotated region differently from one another, same reasoning as
 * gating.ts's isSourceLanguageRegion/containsCjk being a single shared
 * import rather than two implementations.
 *
 * Horizontal text (rotation absent, or 0): unchanged from pre-rotation-
 * support behavior - ink height target is inkBBox.h (or bbox.h when no
 * inkBBox was supplied, per TextRegion.inkBBox's own compatibility
 * contract), fit width is bbox.w, fit height floor is bbox.h.
 *
 * Rotated +-90 text: the axes swap, because rotation.ts's coordinate mapping
 * itself swaps width/height when it maps a rotated-pass detection back into
 * the original frame (a vertical axis title's ORIGINAL bbox is tall and
 * narrow: its HEIGHT is the text's run length, its WIDTH is the ink
 * thickness - the axis a horizontal line's ink normally occupies vertically
 * shows up horizontally here instead). So:
 *   - ink height target = inkBBox.w (the narrow axis is where the rotated-
 *     reading-frame "ink height" - stroke thickness - actually lives).
 *   - fit-box width = bbox.h (the tall axis is the text's run length, i.e.
 *     what fit()'s wrap/measure logic must treat as "width" to lay out the
 *     rotated line correctly).
 *   - fit-box height floor = bbox.w (mirrors the non-rotated case's
 *     Math.max(bbox.h, sizePt * lineHeightFactor) floor, just on the swapped
 *     axis) - the caller still takes Math.max(this floor, sizePt *
 *     FIT_LINE_HEIGHT_FACTOR) once sizePt is known from inkMatchedFontSizePt,
 *     exactly as the non-rotated case already does (see image-adapter.ts's
 *     own doc comment on why box.hPt must be a FIT BUDGET, not the bare
 *     bbox dimension, or fit() shrinks the ink-matched size straight back
 *     down).
 */
export interface SizingAxes {
  inkHeightPx: number
  fitBoxWPt: number
  fitBoxHPtFloor: number
}

export function sizingAxesFor(region: {
  bbox: RegionBBox
  inkBBox?: RegionBBox
  rotation?: 0 | 90 | -90
}): SizingAxes {
  const inkBBox = region.inkBBox ?? region.bbox
  if (region.rotation === 90 || region.rotation === -90) {
    return { inkHeightPx: inkBBox.w, fitBoxWPt: region.bbox.h, fitBoxHPtFloor: region.bbox.w }
  }
  return { inkHeightPx: inkBBox.h, fitBoxWPt: region.bbox.w, fitBoxHPtFloor: region.bbox.h }
}

// Mirrors fit-engine.ts's LINE_HEIGHT_FACTOR (module-private there) - the
// same duplicated-constant approach overlay.ts/image-adapter.ts already
// take, used here only to judge a wrapped block's height.
const WRAP_LINE_HEIGHT_FACTOR = 1.2

// A wrapped block may exceed the region's cross axis by this much before it
// is judged unpaintable - dilation slack, not a layout allowance.
const WRAP_OVERFLOW_SLACK_PX = 2

/**
 * True when a paint of `lineCount` lines at `sizePt` cannot fit inside the
 * region's own fill box on the line-stacking axis (bbox.h, or bbox.w for a
 * rotated region). fit() lays lines out against a fit BUDGET that is
 * deliberately taller than the region (image-adapter.ts's box.hPt doc
 * comment), so a translation can legally wrap into more lines than the
 * region has room to paint - live slide-6 failure: "RH" -> a two-line CJK
 * wrap in a one-line cell, the second line hanging over the neighbor's
 * pixels. Such a paint violates the only-original-space constraint no
 * matter the size, so the caller must skip it and keep the original pixels.
 */
export function wrappedPaintOverflows(
  lineCount: number,
  sizePt: number,
  region: { bbox: RegionBBox; rotation?: 0 | 90 | -90 }
): boolean {
  // Single-line paints are band-sized (refinePaintSizes) and clamped inside
  // the fill box at draw time (overlay.ts) - only WRAPPED blocks can hang
  // whole lines outside the region.
  if (lineCount <= 1) return false
  const axisPx = region.rotation === 90 || region.rotation === -90 ? region.bbox.w : region.bbox.h
  return lineCount * sizePt * WRAP_LINE_HEIGHT_FACTOR > axisPx + WRAP_OVERFLOW_SLACK_PX
}

// ---- apply-time paint-size refinement (gate round 3: "font sizes are all
// off and furthermore all over the place... pixel-perfect word replacement")
//
// The extract-time estimate above is measured against the ORIGINAL text -
// the only text that exists before translation - which leaves two visible
// error sources on a real repainted table:
//
// 1. Glyph-mix asymmetry: a caps/digits row's ink height is ~0.72em while
//    its CJK replacement's ink is ~0.88em, so painting the replacement at
//    the estimated author-pt renders it ~20% taller than the ink it
//    replaces - and the error DIFFERS row by row with each row's glyph mix
//    (descender rows land near 1.0, digit rows near 0.72). Fix: once the
//    translation is known (apply time), re-match the TRANSLATION's own
//    measured ink to the region's original ink target and paint at the
//    smaller of that and the width-fitted size (never grow past fit()'s
//    width ceiling; a genuinely-wrapped multi-line paint keeps its fitted
//    size - per-line ink retargeting doesn't compose with wrapping).
//
// 2. Detection-box noise: +-2-3px of OCR box jitter on 12-16px text is a
//    +-20% font-size swing between rows that were identical in the source,
//    and a band-merged header region's union box is taller than any of its
//    constituent lines. Fix: regions of ONE image whose refined sizes sit
//    within a small relative gap of each other are the same authored size
//    seen through noise - snap each cluster to its median (capped per
//    region by its own width-fitted ceiling, so snapping never reintroduces
//    an overflow).

/** Sizes within this ratio of a cluster's smallest member are treated as
 * the same authored size observed through band-measurement noise. 20%
 * (anchored at the cluster minimum, so a cluster's TOTAL spread is bounded
 * by it) covers the +-1px cap-normalization jitter on small text - live
 * evidence: same-row cells recovered targets 7% apart yet fell across a
 * tighter boundary and painted 20% apart - while keeping genuinely
 * distinct sizes (a 12pt body vs an 18pt heading, ratio 1.5) apart. */
const CLUSTER_GAP_RATIO = 1.2

// ---- cap-normalized band targeting (feedback-loop round, 2026-08-06).
//
// The measured ink BAND of a Latin source string is its cap height when the
// string has caps/ascenders/digits, cap + descender depth when it also has
// descenders, and bare x-height when it has neither. Recovering the
// authored em from that band THROUGH skia's Noto metrics is wrong in
// principle: the slide's real font (e.g. Calibri, cap ~0.64em) shares no
// metrics with Noto (skia's quantized actualBoundingBox ratios measured
// 0.85-1.05 on real strings), so the recovered em undershot by ~30% on the
// real slide-6 table. What IS font-agnostic: typographic proportions.
// Descender depth ~0.28x cap and x-height ~0.72x cap hold across office
// fonts within a few percent, and CJK glyph ink at the same em runs ~1.3x
// the Latin cap. So the paint target is: normalize the band to CAP height
// using the source string's own glyph classes, then render a CJK
// translation's ink at 1.3x cap (a non-CJK translation at plain band
// parity), capped so the line never exceeds the region width.
const DESCENDER_RE = /[gjpqy]/
const ASCENDER_RE = /[A-Z0-9bdfhklt]/
const DESCENDER_BAND_TO_CAP = 1.28
const X_HEIGHT_TO_CAP = 0.72
const CJK_INK_TO_CAP = 1.3

/** The source string's cap height implied by its measured ink band - see
 * the section comment above. A CJK-scripted source's band is already ~1.3x
 * cap-equivalent, mirroring CJK_INK_TO_CAP. */
function capHeightFromBand(sourceText: string, bandPx: number): number {
  if (containsCjk(sourceText)) return bandPx / CJK_INK_TO_CAP
  if (DESCENDER_RE.test(sourceText)) return bandPx / DESCENDER_BAND_TO_CAP
  if (ASCENDER_RE.test(sourceText)) return bandPx
  return bandPx / X_HEIGHT_TO_CAP
}

/** The size at which `line` set in `font` exactly fills `widthPx` - the
 * hard ceiling keeping a painted line inside its region horizontally.
 * Width scales linearly with size, so one 100px measurement suffices. */
function widthCappedSizePt(line: string, font: FontSpec, widthPx: number): number {
  registerBundledFonts()
  setFont(100, font)
  const w = measureCtx().measureText(line).width
  return w > 0 ? (100 * widthPx) / w : Number.MAX_SAFE_INTEGER
}

export interface PaintSizeItem {
  /** fit()'s output lines - a single-line paint is retargeted from the ink band; multi-line keeps fittedSizePt. */
  lines: string[]
  /** The ORIGINAL (source) text - its glyph classes normalize the band to cap height. */
  sourceText: string
  /** fit()'s output size - kept as-is for multi-line (wrapped) paints. */
  fittedSizePt: number
  font: FontSpec
  region: { bbox: RegionBBox; inkBBox?: RegionBBox; rotation?: 0 | 90 | -90 }
}

/**
 * Final paint sizes for every region of ONE image, returned aligned with
 * `items`. Single-line paints are sized by cap-normalized band targeting
 * (see the section comment above): the translation's ink is rendered at
 * CJK_INK_TO_CAP x the source's cap height (plain band parity for non-CJK
 * translations), hard-capped by the region width; multi-line (wrapped)
 * paints keep fit()'s size. Then the per-image cluster snap: sizes within
 * CLUSTER_GAP_RATIO of a cluster's smallest member are the same authored
 * size seen through residual noise and snap to that smallest member, so
 * rows come out uniform without any region ever growing.
 */
export function refinePaintSizes(items: PaintSizeItem[]): number[] {
  const sized = items.map((item) => {
    if (item.lines.length !== 1) {
      // Multi-line (wrapped) paints keep fit()'s size; it is also their
      // ceiling - growing would re-wrap what fit() already laid out.
      return { sizePt: item.fittedSizePt, ceilPt: item.fittedSizePt }
    }
    const axes = sizingAxesFor(item.region)
    const cap = capHeightFromBand(item.sourceText, axes.inkHeightPx)
    const targetInk = containsCjk(item.lines[0]) ? cap * CJK_INK_TO_CAP : axes.inkHeightPx
    const ceilPt = widthCappedSizePt(item.lines[0], item.font, axes.fitBoxWPt)
    return {
      sizePt: Math.min(inkMatchedFontSizePt(item.lines[0], item.font, targetInk), ceilPt),
      ceilPt
    }
  })

  const order = sized
    .map((s, index) => ({ ...s, index }))
    .sort((a, b) => a.sizePt - b.sizePt || a.index - b.index)

  const result = sized.map((s) => s.sizePt)
  let clusterStart = 0
  for (let i = 1; i <= order.length; i++) {
    // The gap test anchors to the cluster's FIRST (smallest) member, not
    // the previous one: chaining member-to-member let a smooth size
    // distribution link into one mega-cluster and snap an entire image to
    // its global minimum (observed live on the slide-6 table). Anchoring
    // bounds any cluster's total spread at CLUSTER_GAP_RATIO.
    const gapBreaks =
      i === order.length || order[i].sizePt > order[clusterStart].sizePt * CLUSTER_GAP_RATIO
    if (!gapBreaks) continue
    const cluster = order.slice(clusterStart, i)
    if (cluster.length > 1) {
      // Snap to the MEDIAN, bounded by every member's own ceiling - the
      // median tracks the authored size best, and the bound keeps the snap
      // from pushing any member past what physically fits it.
      const median = cluster[Math.floor(cluster.length / 2)].sizePt
      const snap = Math.min(median, ...cluster.map((m) => m.ceilPt))
      for (const member of cluster) {
        result[member.index] = snap
      }
    }
    clusterStart = i
  }
  return result
}
