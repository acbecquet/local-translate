// Table-cell granularity for row-merged detections (Phase 3 gate round 5:
// "slide 6 is still getting butchered"). PP-OCR reads a whole table row -
// several visually separate cells - as ONE detection at page scale (spike
// doc known limitation), so one concatenated translation paints across the
// row and wipes the cell layout. Two fixes were tried against the real
// slide-6 image and empirically falsified (ledger, 2026-08-05): re-reading
// crops at 2x still row-merges and garbles, and a plain whitespace-valley
// split fails because table GRIDLINES cross the valleys while narrow-crop
// re-reads destroy text the page-scale read got right.
//
// withCellSplit is the surviving design: split the box GEOMETRICALLY but
// keep the trusted page-scale reading. Per eligible region:
//
//   1. Crop the region's pixels and build a per-column ink profile against
//      the crop's estimated background (analyzeColumns).
//   2. Erase vertical GRIDLINE columns - near-full-height ink runs touching
//      both the top and bottom edge bands of the crop; glyphs do not span
//      the whole detection box, table borders do (eraseGridlineColumns).
//   3. Split the ink extent at valleys of at least max(10px, 1x region
//      height) - a gap wider than the line is tall is a cell gutter, never
//      ordinary word spacing (inkSpans).
//   4. Distribute the EXISTING merged text's tokens across the sub-boxes so
//      each contiguous token group's measured width share best matches its
//      span's width share (distributeTokens) - NO re-OCR anywhere, so text
//      quality cannot regress by construction. When even the best
//      assignment leaves a span wildly mismatched, the whole split is
//      refused and the region passes through untouched - the fallback is
//      exactly today's behavior, never worse.
//
// A RegionEngine decorator like rotation.ts's withRotationPasses, wrapped
// OUTSIDE it (withCellSplit(withRotationPasses(engine))): it must see final
// original-frame regions, and rotated regions (known-angle or flagged) are
// never split - vertical text has no horizontal cell structure to find.
import { loadImage } from 'skia-canvas'
import { createCanvas, measureCtx, registerBundledFonts, resolveFamily } from '../fit/fonts'
import { containsCjk } from './gating'
import { iou, type RegionEngine, type TextRegion } from './regions'
import { inkMatchedFontSizePt } from './sizing'

// A pixel is ink when its luminance differs from the crop's estimated
// background by more than this (0-255 scale) - generous enough to keep
// antialiased glyph edges while ignoring JPEG ringing around them.
const INK_LUMINANCE_DELTA = 50

// A column is a GRIDLINE candidate when its ink covers at least this
// fraction of the crop height AND touches both edge bands below. Glyphs
// never reliably do both: the detection box includes ascender/descender
// slack, so even a tall stem stops short of one edge.
const GRIDLINE_MIN_COVERAGE = 0.85
const GRIDLINE_EDGE_BAND_FRACTION = 0.1

// Only RUNS of consecutive gridline-candidate columns up to this many px
// get erased: real table borders are 1px lines (2-3px antialiased), while a
// WIDER full-height ink band is content (a filled header cell, a chart
// bar) - erasing one would leave a phantom valley where solid ink stood.
const MAX_GRIDLINE_RUN_PX = 4

// Valley qualification - which empty runs count as CELL GUTTERS. The drawn
// table structure is the primary signal: a valley containing an ERASED
// GRIDLINE column is a ruled cell boundary and qualifies at a modest width
// (>= max(GRIDLINE_VALLEY_MIN_PX, 0.5x line height) - just enough to rule
// out a gridline grazing a glyph). A gridline-FREE valley must be
// table-scale: >= max(MIN_VALLEY_PX, 2x line height) - word gaps run
// ~0.25em and never qualify at any text size (live failure: at 6px tiny
// text a 1x-height rule let word gaps split "Date and Time" into cells),
// while unruled layouts that DO need splitting (chart tick rows, legends)
// have gaps of several line heights.
const MIN_VALLEY_PX = 14
const VALLEY_MIN_HEIGHT_RATIO = 2
const GRIDLINE_VALLEY_MIN_PX = 6
const GRIDLINE_VALLEY_MIN_HEIGHT_RATIO = 0.5

// Columns with up to this fraction of the crop height in stray ink still
// count as empty - lone compression artifacts must not bridge a gutter.
const EMPTY_COLUMN_MAX_FRACTION = 0.06

// After the best token partition is found, any span whose group width share
// still differs from the span's own width share by more than this aborts
// the split: the OCR text demonstrably does not describe this ink layout
// (e.g. a dropped token), and painting tokens into the wrong cells is worse
// than the status quo.
const MAX_SPAN_FRACTION_ERROR = 0.45

// Second, RATIO-based agreement bound on the same shares - the absolute
// check above goes blind when both shares are small: on the real deck's
// image39 photo, 1-2px edge-artifact "spans" (share ~0.003) drew whole
// tokens (share ~0.29) at an absolute difference under 0.45 and scattered
// the label text across the image. Real skinny cells (slide 6's 18px
// "D8"/"3.2" values) agree with their tokens within ~1.2x; the artifact
// case disagrees by ~90x, so a generous 4x bound separates them cleanly.
const MAX_SPAN_SHARE_RATIO = 4

// Regions narrower than this many times their height cannot contain a
// qualifying valley plus content on both sides - skip the pixel work.
const MIN_SPLIT_ASPECT = 2

// Gridline-erase VETO (review finding): a token made entirely of narrow
// vertical-stroke glyphs renders as a full-height 1-3px ink run when the
// detection box is tight - per-column indistinguishable from a table
// border. Erasing such a glyph folds its token into a neighboring cell's
// group (which the share guards cannot see - the shift is one small
// token's share) and paints it into the WRONG cell, the one unacceptable
// failure mode. The text itself is the discriminating signal: OCR read a
// token for a glyph, never for a border - so when any token matches this,
// erasure is skipped wholesale. A real gridline then simply blocks the
// valley and the region passes through unchanged (always acceptable).
const NARROW_STROKE_TOKEN_RE = /^[1Iil|!()[\]]+$/

// Token widths only ever matter RELATIVE to each other, so any fixed
// measurement size works; a large one keeps rounding noise negligible.
const MEASURE_SIZE_PX = 100

// Vertical TIGHTEN (feedback-loop round 2): PP-OCR's detection boxes often
// carry vertical slack - a 25px box around a 12px text line - and since the
// validated inkBBox (the downstream SIZE authority) is snapshotted from the
// box, that slack painted translations up to ~2x oversized on the real
// slide-6 table. Every non-rotated region is therefore snapped to its
// measured ink ROW band before anything else: rows are analyzed with the
// SAME machinery as columns (on a transposed crop, so horizontal border
// lines get the identical narrow-run erase), and a single contiguous band
// replaces the box's vertical extent. A box whose ink shows more than one
// band (a genuine multi-line detection) is left vertically untouched.
const ROW_EMPTY_MAX_FRACTION = 0.01
const BAND_GAP_TOLERANCE_PX = 2
const MIN_BAND_H_PX = 4
const DOMINANT_BAND_MIN_INK_SHARE = 0.7
// The band search extends this far past the detector box on each side
// (relative to box height, absolute cap bounding neighbor-line bleed):
// PP-OCR boxes CLIP glyphs - the real slide's step rows were boxed at 9px
// around 13px glyphs, offset downward - so the true glyph extent must be
// measured beyond the box, and the fill box grown to cover it, or the
// clipped tops survive as ghost slices above every repaint while the
// clipped band undersizes every paint.
const BAND_SEARCH_EXPAND_RATIO = 0.75
const BAND_SEARCH_EXPAND_MAX_PX = 14

// When distribution REFUSES, the refusal normally keeps the region painting
// as one block (status quo). But a region whose profile shows at least this
// many SUBSTANTIAL ink spans is demonstrably multi-cell content - and
// painting one concatenated translation across several proven cells is the
// exact whole-row smear this module exists to end (the real deck's step-3
// detection: PP-OCR stretched one box across the entire table while reading
// only one cell's sentence). With that much evidence and no valid
// distribution, the region is DROPPED instead: nothing paints, every
// cell's original pixels stay - strictly closer to the only-original-space
// constraint than either smear or misassignment. Two spans stay refusal-
// only: that shape is common on photos (see the image39 tests) where
// painting the pair as one block is acceptable and expected.
const DROP_MIN_SUBSTANTIAL_SPANS = 3
// "Substantial" = wide enough to survive regions.ts's own NOISE_FLOOR_PX
// (8) - slivers and artifacts must not count as cell evidence.
const SUBSTANTIAL_SPAN_MIN_PX = 8

interface ColumnStats {
  ink: number
  top: boolean
  bottom: boolean
}

interface InkSpan {
  start: number
  end: number
}

/**
 * Per-column ink statistics for a wxh RGBA crop: ink pixel count plus
 * whether any ink falls in the top/bottom GRIDLINE_EDGE_BAND_FRACTION of
 * rows. Background is estimated as the median luminance of the crop's
 * border pixels - table rows sit on a locally uniform fill (white page,
 * shaded header band), and the border is the part of the crop glyphs
 * reach least, so its median is that fill even when the text is light on
 * dark.
 */
function lumAt(data: Uint8ClampedArray, i: number): number {
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
}

/**
 * Median luminance of the crop's border pixels - the background estimate.
 * MUST be taken from the LOOSE (pre-tighten) crop: a vertically tightened
 * crop hugs the ink, so its border rows are ink-heavy and the median would
 * flip polarity (ink read as background, margins as ink) on dense rows.
 */
function estimateBackground(data: Uint8ClampedArray, w: number, h: number): number {
  const border: number[] = []
  for (let x = 0; x < w; x++) {
    border.push(lumAt(data, 4 * x), lumAt(data, 4 * ((h - 1) * w + x)))
  }
  for (let y = 1; y < h - 1; y++) {
    border.push(lumAt(data, 4 * (y * w)), lumAt(data, 4 * (y * w + w - 1)))
  }
  border.sort((a, b) => a - b)
  return border[Math.floor(border.length / 2)] ?? 255
}

function analyzeColumns(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  bg = estimateBackground(data, w, h)
): ColumnStats[] {
  const lum = (i: number) => lumAt(data, i)
  const edgeBand = Math.max(1, Math.floor(h * GRIDLINE_EDGE_BAND_FRACTION))
  const cols: ColumnStats[] = []
  for (let x = 0; x < w; x++) {
    let ink = 0
    let top = false
    let bottom = false
    for (let y = 0; y < h; y++) {
      if (Math.abs(lum(4 * (y * w + x)) - bg) <= INK_LUMINANCE_DELTA) continue
      ink++
      if (y < edgeBand) top = true
      if (y >= h - edgeBand) bottom = true
    }
    cols.push({ ink, top, bottom })
  }
  return cols
}

/**
 * Ink counts with vertical gridline columns zeroed, plus WHICH columns got
 * erased (inkSpans treats an erased gridline inside a valley as the primary
 * cell-boundary signal) - see GRIDLINE_MIN_COVERAGE's doc comment for why
 * full-height + both edge bands identifies a table border and not a glyph,
 * and MAX_GRIDLINE_RUN_PX's for why only narrow runs qualify.
 */
function eraseGridlineColumns(
  cols: ColumnStats[],
  h: number
): { counts: number[]; erased: boolean[] } {
  const isCandidate = cols.map((c) => c.top && c.bottom && c.ink >= GRIDLINE_MIN_COVERAGE * h)
  const counts = cols.map((c) => c.ink)
  const erased = cols.map(() => false)
  let x = 0
  while (x < cols.length) {
    if (!isCandidate[x]) {
      x++
      continue
    }
    const runStart = x
    while (x < cols.length && isCandidate[x]) x++
    if (x - runStart <= MAX_GRIDLINE_RUN_PX) {
      for (let i = runStart; i < x; i++) {
        counts[i] = 0
        erased[i] = true
      }
    }
  }
  return { counts, erased }
}

/**
 * Maximal ink runs after splitting the profile's overall ink extent at
 * qualifying valleys - see the valley constants' doc comment: an erased
 * gridline inside a valley qualifies it at modest width; a gridline-free
 * valley must be table-scale (2x the line height). Leading/trailing empty
 * columns are trimmed rather than treated as valleys; an all-empty profile
 * yields no spans.
 */
function inkSpans(counts: number[], h: number, erased: boolean[] = []): InkSpan[] {
  const emptyMax = Math.max(1, Math.round(h * EMPTY_COLUMN_MAX_FRACTION))
  const plainValley = Math.max(MIN_VALLEY_PX, h * VALLEY_MIN_HEIGHT_RATIO)
  const gridValley = Math.max(GRIDLINE_VALLEY_MIN_PX, h * GRIDLINE_VALLEY_MIN_HEIGHT_RATIO)
  const isInk = counts.map((c) => c > emptyMax)
  const first = isInk.indexOf(true)
  if (first === -1) return []
  const last = isInk.lastIndexOf(true)

  const spans: InkSpan[] = []
  let spanStart = first
  let x = first
  while (x <= last) {
    if (isInk[x]) {
      x++
      continue
    }
    const runStart = x
    while (x <= last && !isInk[x]) x++
    const runLen = x - runStart
    let hasGridline = false
    for (let i = runStart; i < x && !hasGridline; i++) hasGridline = erased[i] === true
    if (runLen >= (hasGridline ? gridValley : plainValley)) {
      spans.push({ start: spanStart, end: runStart })
      spanStart = x
    }
  }
  spans.push({ start: spanStart, end: last + 1 })
  return spans
}

/**
 * Partitions `tokenWidths` into spanWidths.length CONTIGUOUS non-empty
 * groups (token order is reading order - it must never be reshuffled)
 * minimizing the summed squared difference between each group's width share
 * (including intra-group space advances) and its span's width share.
 * Returns tokens-per-span counts, or null when no acceptable partition
 * exists: fewer tokens than spans, degenerate widths, or a best partition
 * that still leaves some span off by more than MAX_SPAN_FRACTION_ERROR.
 */
function distributeTokens(
  tokenWidths: number[],
  spaceWidth: number,
  spanWidths: number[]
): number[] | null {
  const m = tokenWidths.length
  const n = spanWidths.length
  if (n === 0 || m < n) return null

  const prefix = [0]
  for (const w of tokenWidths) prefix.push(prefix[prefix.length - 1] + w)
  const groupWidth = (i: number, j: number) =>
    prefix[j] - prefix[i] + spaceWidth * Math.max(0, j - i - 1)
  const totalTokenW = groupWidth(0, m)
  const totalSpanW = spanWidths.reduce((a, b) => a + b, 0)
  if (totalTokenW <= 0 || totalSpanW <= 0) return null

  const err = (spanIdx: number, i: number, j: number) => {
    const d = groupWidth(i, j) / totalTokenW - spanWidths[spanIdx] / totalSpanW
    return d * d
  }

  // dp[k][j]: best cost assigning the first j tokens to the first k+1
  // spans; parent[k][j] the split index that achieves it. Sizes here are
  // table-scale (a handful of cells, a couple dozen tokens), so the cubic
  // loop is microseconds.
  const dp = Array.from({ length: n }, () => new Array<number>(m + 1).fill(Infinity))
  const parent = Array.from({ length: n }, () => new Array<number>(m + 1).fill(-1))
  for (let j = 1; j <= m; j++) {
    dp[0][j] = err(0, 0, j)
    parent[0][j] = 0
  }
  for (let k = 1; k < n; k++) {
    for (let j = k + 1; j <= m; j++) {
      for (let i = k; i < j; i++) {
        const cost = dp[k - 1][i] + err(k, i, j)
        if (cost < dp[k][j]) {
          dp[k][j] = cost
          parent[k][j] = i
        }
      }
    }
  }
  if (!Number.isFinite(dp[n - 1][m])) return null

  const counts = new Array<number>(n).fill(0)
  let j = m
  for (let k = n - 1; k >= 0; k--) {
    const i = parent[k][j]
    counts[k] = j - i
    j = i
  }

  let idx = 0
  for (let k = 0; k < n; k++) {
    const groupShare = groupWidth(idx, idx + counts[k]) / totalTokenW
    const spanShare = spanWidths[k] / totalSpanW
    idx += counts[k]
    if (Math.abs(groupShare - spanShare) > MAX_SPAN_FRACTION_ERROR) return null
    const larger = Math.max(groupShare, spanShare)
    const smaller = Math.min(groupShare, spanShare)
    if (larger > smaller * MAX_SPAN_SHARE_RATIO) return null
  }
  return counts
}

/** `data` (wxh RGBA) transposed to hxw - so per-ROW analysis can reuse the
 * per-column machinery above verbatim (same background estimate: the border
 * pixel set is identical under transposition). */
function transposeRgba(data: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = 4 * (y * w + x)
      const dst = 4 * (x * h + y)
      out[dst] = data[src]
      out[dst + 1] = data[src + 1]
      out[dst + 2] = data[src + 2]
      out[dst + 3] = data[src + 3]
    }
  }
  return out
}

/**
 * The crop's ink ROW band [start, end), or null when there is no usable
 * band. Gaps up to BAND_GAP_TOLERANCE_PX rows are bridged; wider gaps
 * separate distinct bands. With several bands, the ink-DOMINANT one wins
 * when it owns at least DOMINANT_BAND_MIN_INK_SHARE of the total ink (the
 * minority band is neighbor-line bleed the detection box caught - the real
 * slide's "Storage" box carried a 2px sliver of the next line and painted
 * ~2x oversized); BALANCED bands mean a genuine multi-line detection and
 * banding declines. Horizontal border lines are erased first, exactly like
 * vertical gridlines are for the column profile.
 */
function inkRowBand(data: Uint8ClampedArray, w: number, h: number, bg: number): InkSpan | null {
  const rowStats = analyzeColumns(transposeRgba(data, w, h), h, w, bg)
  const { counts } = eraseGridlineColumns(rowStats, w)
  const emptyMax = Math.max(1, Math.round(w * ROW_EMPTY_MAX_FRACTION))
  const isInk = counts.map((c) => c > emptyMax)

  const bands: { span: InkSpan; ink: number }[] = []
  let y = 0
  while (y < h) {
    if (!isInk[y]) {
      y++
      continue
    }
    const start = y
    let end = y
    while (y < h) {
      if (isInk[y]) {
        end = y + 1
        y++
        continue
      }
      let gap = 0
      while (y + gap < h && !isInk[y + gap]) gap++
      if (gap > BAND_GAP_TOLERANCE_PX) break
      y += gap
    }
    let ink = 0
    for (let r = start; r < end; r++) ink += counts[r]
    bands.push({ span: { start, end }, ink })
  }

  if (bands.length === 0) return null
  if (bands.length === 1) return bands[0].span
  const total = bands.reduce((a, b) => a + b.ink, 0)
  const dominant = bands.reduce((a, b) => (b.ink > a.ink ? b : a))
  return dominant.ink >= total * DOMINANT_BAND_MIN_INK_SHARE ? dominant.span : null
}

/**
 * `region` with its inkBBox set to the measured ink row band (the SIZE
 * authority downstream - validateRegions preserves an engine-provided
 * inkBBox) - or unchanged (same object) when the band is absent,
 * multi-line, degenerate, or the full crop height. The bbox itself is
 * NEVER shrunk: it stays the loose detector box, the FILL/coverage
 * authority - painting only the band left the original's antialiased
 * fringe uncovered as a visible ghost around every repainted line.
 */
function tightenVertical(
  region: TextRegion,
  ctx: Canvas2D,
  imgW: number,
  imgH: number
): { region: TextRegion; bg: number | null } {
  const x0 = Math.max(0, Math.floor(region.bbox.x))
  const y0 = Math.max(0, Math.floor(region.bbox.y))
  const x1 = Math.min(imgW, Math.ceil(region.bbox.x + region.bbox.w))
  const y1 = Math.min(imgH, Math.ceil(region.bbox.y + region.bbox.h))
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return { region, bg: null }

  // Search window extends past the (possibly glyph-clipping) detector box -
  // see BAND_SEARCH_EXPAND_RATIO.
  const expand = Math.min(BAND_SEARCH_EXPAND_MAX_PX, Math.ceil(h * BAND_SEARCH_EXPAND_RATIO) + 2)
  const ey0 = Math.max(0, y0 - expand)
  const ey1 = Math.min(imgH, y1 + expand)
  const eh = ey1 - ey0
  const data = ctx.getImageData(x0, ey0, w, eh).data
  const bg = estimateBackground(data, w, eh)
  const band = inkRowBand(data, w, eh, bg)
  if (!band) return { region, bg }
  const bandY = ey0 + band.start
  const bandH = band.end - band.start
  if (bandH < MIN_BAND_H_PX || bandH >= eh) return { region, bg }
  // bbox (the FILL authority) grows to cover the full glyph band; it never
  // shrinks. inkBBox (the SIZE authority) is the band itself.
  const top = Math.min(region.bbox.y, bandY)
  const bottom = Math.max(region.bbox.y + region.bbox.h, bandY + bandH)
  return {
    region: {
      ...region,
      bbox: { ...region.bbox, y: top, h: bottom - top },
      inkBBox: { x: region.bbox.x, y: bandY, w: region.bbox.w, h: bandH }
    },
    bg
  }
}

// A region whose text, rendered at its own band-matched size, is more than
// this many times WIDER than its box is a recognition hallucination - the
// real slide emitted 17px-wide boxes over fraction cells "reading" a
// 6-character word from another cell at 0.99 confidence, which then merged
// into and poisoned their neighbors. No genuine reading is under half as
// wide as its own text; snug numeric cells measure ~1.1-1.5x.
const CANNOT_FIT_WIDTH_RATIO = 2

/** True when `region`'s text cannot plausibly fit its own box - see
 * CANNOT_FIT_WIDTH_RATIO. Judged at the band-matched size so the check is
 * scale-invariant. */
function cannotFitBox(region: TextRegion): boolean {
  const text = region.text.trim()
  if (!text) return false
  registerBundledFonts()
  const { family } = resolveFamily(containsCjk(text) ? 'Noto Sans CJK SC' : 'Noto Sans')
  const bandH = (region.inkBBox ?? region.bbox).h
  const font = { family, sizePt: bandH }
  const sizePt = inkMatchedFontSizePt(text, font, bandH)
  const ctx = measureCtx()
  ctx.font = `${sizePt}px "${family}"`
  return ctx.measureText(text).width > region.bbox.w * CANNOT_FIT_WIDTH_RATIO
}

/** Splittable = horizontal (no rotation angle, no rotated flag) with at
 * least two whitespace-separated tokens to distribute. CJK runs have no
 * whitespace tokens, so they self-exclude - correct, since the only
 * repaint direction is en->zh (zh->en repaints zero media by design). */
function isSplitCandidate(region: TextRegion): boolean {
  if (region.rotation || region.rotated) return false
  return region.text.trim().split(/\s+/).length >= 2
}

function measuredTokenWidths(
  tokens: string[],
  text: string
): { tokenWidths: number[]; spaceWidth: number } {
  registerBundledFonts()
  const { family } = resolveFamily(containsCjk(text) ? 'Noto Sans CJK SC' : 'Noto Sans')
  const ctx = measureCtx()
  ctx.font = `${MEASURE_SIZE_PX}px "${family}"`
  return {
    tokenWidths: tokens.map((t) => ctx.measureText(t).width),
    spaceWidth: ctx.measureText(' ').width
  }
}

type Canvas2D = ReturnType<ReturnType<typeof createCanvas>['getContext']>

/**
 * The split attempt for one region: returns the sub-regions when every step
 * above agrees, or [region] untouched when any step refuses - the region
 * then behaves exactly as it does today.
 */
function trySplit(
  region: TextRegion,
  ctx: Canvas2D,
  imgW: number,
  imgH: number,
  bg: number
): TextRegion[] {
  const x0 = Math.max(0, Math.floor(region.bbox.x))
  const y0 = Math.max(0, Math.floor(region.bbox.y))
  const x1 = Math.min(imgW, Math.ceil(region.bbox.x + region.bbox.w))
  const y1 = Math.min(imgH, Math.ceil(region.bbox.y + region.bbox.h))
  const w = x1 - x0
  const h = y1 - y0
  // The measured ink band (tightenVertical) is the LINE-HEIGHT authority
  // for the aspect gate and the valley thresholds; the loose box is the
  // fallback when no band was found.
  const band = region.inkBBox
  const bandY0 = band ? Math.max(y0, Math.floor(band.y)) : y0
  const bandH = band ? Math.min(y1, Math.ceil(band.y + band.h)) - bandY0 : h
  if (h <= 0 || bandH <= 0 || w < MIN_SPLIT_ASPECT * bandH) return [region]

  const tokens = region.text.trim().split(/\s+/)
  // Column INK profile over the band rows only (neighbor-line bleed above/
  // below the band must not pollute valley emptiness); GRIDLINE candidacy
  // over the full LOOSE box height - a true table border crosses the whole
  // detector box, while inside the band every letter stem would look
  // "full height touching both bands" and erase as a gridline (observed
  // live: word gaps became ruled boundaries and a sentence split at its
  // words). The narrow-stroke-token veto stays on top for tight-box stroke
  // glyphs (see NARROW_STROKE_TOKEN_RE).
  const cols = analyzeColumns(ctx.getImageData(x0, bandY0, w, bandH).data, w, bandH, bg)
  const colsLoose = analyzeColumns(ctx.getImageData(x0, y0, w, h).data, w, h, bg)
  const { erased } = tokens.some((t) => NARROW_STROKE_TOKEN_RE.test(t))
    ? { erased: colsLoose.map(() => false) }
    : eraseGridlineColumns(colsLoose, h)
  const counts = cols.map((c, i) => (erased[i] ? 0 : c.ink))
  const spans = inkSpans(counts, bandH, erased)
  if (spans.length < 2) return [region]

  const { tokenWidths, spaceWidth } = measuredTokenWidths(tokens, region.text)
  const groups = distributeTokens(
    tokenWidths,
    spaceWidth,
    spans.map((s) => s.end - s.start)
  )
  if (!groups) {
    const substantial = spans.filter((s) => s.end - s.start >= SUBSTANTIAL_SPAN_MIN_PX).length
    return substantial >= DROP_MIN_SUBSTANTIAL_SPANS ? [] : [region]
  }

  let tokenIndex = 0
  return spans.map((span, i) => {
    const cellTokens = tokens.slice(tokenIndex, tokenIndex + groups[i])
    tokenIndex += groups[i]
    // Each cell gets its OWN vertical ink band (from its own span columns
    // over the FULL loose extent - cells sit at different heights, and a
    // cell's tips can be sparse at whole-row level; its own narrow crop
    // has a proportionate floor and keeps them). The cell's bbox keeps the
    // loose vertical extent for FILL coverage; the band goes to inkBBox,
    // the size authority. Residual per-cell jitter is what
    // refinePaintSizes's cluster snap exists to absorb.
    const spanW = span.end - span.start
    const cellData = ctx.getImageData(x0 + span.start, y0, spanW, h).data
    const cellBand = inkRowBand(cellData, spanW, h, bg)
    return {
      ...region,
      id: `${region.id}c${i + 1}`,
      bbox: { x: x0 + span.start, y: region.bbox.y, w: spanW, h: region.bbox.h },
      text: cellTokens.join(' '),
      inkBBox: cellBand
        ? { x: x0 + span.start, y: y0 + cellBand.start, w: spanW, h: cellBand.end - cellBand.start }
        : band
          ? { x: x0 + span.start, y: band.y, w: spanW, h: band.h }
          : undefined
    }
  })
}

// Post-tighten double-vote dedup threshold: two non-rotated detections
// whose TIGHTENED boxes overlap this much are claiming the same ink (a
// phantom box over a fraction cell tightens onto the cell's real glyphs
// and converges with the true reading - observed live as "for" merging
// into "1/2"). The higher-confidence reading wins, mirroring rotation.ts's
// dropLowerConfidenceOverlaps policy.
const DOUBLE_VOTE_IOU = 0.5
// ...or when the SMALLER tightened box sits mostly inside the other - the
// live signature: the true "1/2" band was 100% contained in the phantom
// "Upside" box while their IoU hovered at the 0.5 boundary.
const DOUBLE_VOTE_CONTAINMENT = 0.8

function overlapOfSmaller(a: TextRegion['bbox'], b: TextRegion['bbox']): number {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  const inter = ix > 0 && iy > 0 ? ix * iy : 0
  const smaller = Math.min(a.w * a.h, b.w * b.h)
  return smaller > 0 ? inter / smaller : 0
}

/** Resolves same-spot conflicting readings to the higher confidence - see
 * DOUBLE_VOTE_IOU/DOUBLE_VOTE_CONTAINMENT. Runs on tightened, pre-split
 * regions. */
function dropDoubleVotes(regions: TextRegion[]): TextRegion[] {
  const dropped = new Set<number>()
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (dropped.has(i) || dropped.has(j)) continue
      const a = regions[i]
      const b = regions[j]
      // Compared on the measured BANDS (bbox falls back): phantom and true
      // readings converge on the same ink band while their loose boxes can
      // stay comfortably apart.
      const boxA = a.inkBBox ?? a.bbox
      const boxB = b.inkBBox ?? b.bbox
      const sameSpot =
        iou(boxA, boxB) > DOUBLE_VOTE_IOU || overlapOfSmaller(boxA, boxB) >= DOUBLE_VOTE_CONTAINMENT
      if (!sameSpot) continue
      dropped.add(a.confidence >= b.confidence ? j : i)
    }
  }
  return regions.filter((_, idx) => !dropped.has(idx))
}

/**
 * Wraps `engine` so row-merged table detections get split at true cell
 * gutters while keeping the trusted page-scale text - see the module doc
 * comment for the full design and the falsified alternatives it replaces.
 * Decodes the image once (CPU canvas - the sanctioned constructor) and only
 * when at least one candidate region exists; every non-candidate or
 * refused region passes through byte-identical.
 */
export function withCellSplit(engine: RegionEngine): RegionEngine {
  return {
    async detectRegions(image: Buffer): Promise<TextRegion[]> {
      const regions = await engine.detectRegions(image)
      if (!regions.some((r) => !r.rotation && !r.rotated)) return regions

      const img = await loadImage(image)
      const canvas = createCanvas(img.width, img.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)

      const out: TextRegion[] = []
      const pending: { region: TextRegion; bg: number | null }[] = []
      for (const region of regions) {
        if (region.rotation || region.rotated) {
          out.push(region)
          continue
        }
        // Band-measure FIRST (tightenVertical sets inkBBox, the size
        // authority the split's thresholds and downstream sizing key off).
        const { region: tightened, bg } = tightenVertical(region, ctx, img.width, img.height)
        // Hallucination kill - a "reading" that cannot fit its own box is
        // dropped before it can paint or poison a merge (see cannotFitBox).
        if (cannotFitBox(tightened)) continue
        pending.push({ region: tightened, bg })
      }
      // Double-vote dedup runs on the whole band-measured set BEFORE
      // splitting - see dropDoubleVotes.
      const kept = new Set(dropDoubleVotes(pending.map((p) => p.region)))
      for (const p of pending) {
        if (!kept.has(p.region)) continue
        if (p.bg !== null && isSplitCandidate(p.region)) {
          out.push(...trySplit(p.region, ctx, img.width, img.height, p.bg))
        } else {
          out.push(p.region)
        }
      }
      return out
    }
  }
}

// Test-only visibility (tests/core/images/cellsplit.test.ts) - matching
// rotation.ts's/overlay.ts's _internals convention.
export const _internals = {
  INK_LUMINANCE_DELTA,
  GRIDLINE_MIN_COVERAGE,
  GRIDLINE_EDGE_BAND_FRACTION,
  MIN_VALLEY_PX,
  EMPTY_COLUMN_MAX_FRACTION,
  MAX_SPAN_FRACTION_ERROR,
  MIN_SPLIT_ASPECT,
  analyzeColumns,
  eraseGridlineColumns,
  inkSpans,
  distributeTokens
}
