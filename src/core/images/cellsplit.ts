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
import { DILATION_PX, iou, type RegionEngine, type TextRegion } from './regions'
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

// When no band is ink-DOMINANT (stacked cell labels run near 50/50), the
// detector box itself says which line was read: it covers the read line
// (mostly) and only grazes the neighbor. The band whose IN-BOX INK beats
// the runner-up's decisively wins - ink, not row count, because a grazed
// neighbor contributes ascender-tip rows that carry almost nothing; a
// near-tie means a genuine multi-line detection and banding declines
// exactly as before. (Live failure: "Date and Time" over "Starting." split
// ink 60/40, dominance declined, and the slack detector box became an 18px
// "ink" height for a 12px line - every stacked label painted ~1.5x
// oversized.) When an ERASED BORDER ROW lies between the two leading bands
// the bar drops to BAND_REF_BORDER_RATIO: a drawn table border between
// them is structural proof they belong to different cells, and one
// detection reads one cell (live failures: "at60C" and "Horizontal test"
// boxes straddled their own line and the next row's almost evenly, ink
// ratios 1.5-2.5, and painted union-height smears across the border).
const BAND_REF_MIN_OVERLAP_PX = 3
const BAND_REF_DECISIVE_RATIO = 2
const BAND_REF_BORDER_RATIO = 1.2

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

// Foreign-ink exclusion: a row-merged detection often lassoes ink that
// ANOTHER detection already reads (live: "Fill Volume: 2 Resistance: 2.3
// 60% RH" swallowed the neighboring "Storage Humidity:" cell's ink - the
// foreign span made the token DP impossible and the whole row DROPPED, or
// worse, force-assigned a token onto the foreign cell; the same foreign
// rows also fused the row-merge's own band measurement into a multi-line
// union band, which then chain-killed innocent neighbors through the
// double-vote dedup). Ink accounted for by another region is not this
// region's to distribute or to measure, so its columns are excluded from
// BOTH the row-band profile (tightenVertical) and the span profile
// (trySplit) - but only when the other region is TRUSTWORTHY: its box no
// wider than this many times its own line height. A row-merged box (aspect
// 20-60 on the real slide) must never veto ink out of a fellow row-merge.
// As a second guard, exclusion is skipped when the other region's text
// occurs inside this region's own text - that shape is double coverage
// (both detections read the same cell), and erasing the span would cram
// this region's matching tokens into the wrong cells.
const TRUSTWORTHY_MAX_ASPECT = 12

// An interloper is a PARTIAL x-slice of a wider region. Another region
// whose zone would cover at least this fraction of the region's own width
// is not an interloper but a COMPETING READING of the same ink - that
// conflict belongs to the double-vote dedup, and mutual exclusion here
// would blind both regions' band measurements instead (observed: the
// phantom-vs-"1/2" dedup pair stopped converging on the shared band).
const FOREIGN_ZONE_MAX_WIDTH_FRACTION = 0.5

interface ForeignZone {
  x0: number
  x1: number
  y0: number
  y1: number
}

/**
 * The image-space RECTS owned by trustworthy other regions whose rows
 * intersect [rowFrom, rowTo) - see TRUSTWORTHY_MAX_ASPECT. Rects carry
 * DILATION_PX of margin per side: the owner's box hugs its glyphs, and
 * leaving the antialiased fringe behind forms a sliver span that poisons
 * the token DP exactly like the full foreign span did. The vertical extent
 * matters: masking a neighbor's whole COLUMNS also erased the REGION'S OWN
 * ink wherever the two merely shared x (live: "Step 1"'s cap rows fell
 * under the ink threshold because the trusted line BELOW it shared their
 * columns, and the band undersized the paint).
 */
function foreignZones(
  region: TextRegion,
  others: TextRegion[],
  rowFrom: number,
  rowTo: number
): ForeignZone[] {
  const zones: ForeignZone[] = []
  for (const other of others) {
    const oBand = other.inkBBox ?? other.bbox
    const oAspect = oBand.h > 0 ? other.bbox.w / oBand.h : Infinity
    if (oAspect > TRUSTWORTHY_MAX_ASPECT) continue
    if (Math.min(rowTo, oBand.y + oBand.h) - Math.max(rowFrom, oBand.y) <= 0) continue
    if (region.text.includes(other.text.trim())) continue
    const zx0 = Math.floor(other.bbox.x) - DILATION_PX
    const zx1 = Math.ceil(other.bbox.x + other.bbox.w) + DILATION_PX
    const inRegion = Math.min(zx1, region.bbox.x + region.bbox.w) - Math.max(zx0, region.bbox.x)
    if (inRegion >= region.bbox.w * FOREIGN_ZONE_MAX_WIDTH_FRACTION) continue
    zones.push({
      x0: zx0,
      x1: zx1,
      y0: Math.floor(oBand.y) - DILATION_PX,
      y1: Math.ceil(oBand.y + oBand.h) + DILATION_PX
    })
  }
  return zones
}

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

interface InkBand {
  span: InkSpan
  ink: number
}

/**
 * The crop's ink ROW bands plus which rows were erased as horizontal border
 * lines (exactly like vertical gridlines are for the column profile - the
 * erased rows also mark drawn structure the fill box must never cover).
 * Gaps up to BAND_GAP_TOLERANCE_PX rows are bridged; wider gaps separate
 * distinct bands.
 */
function inkRowBands(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  bg: number
): { bands: InkBand[]; erased: boolean[]; counts: number[] } {
  const rowStats = analyzeColumns(transposeRgba(data, w, h), h, w, bg)
  const { counts, erased } = eraseGridlineColumns(rowStats, w)
  const emptyMax = Math.max(1, Math.round(w * ROW_EMPTY_MAX_FRACTION))
  const isInk = counts.map((c) => c > emptyMax)

  const bands: InkBand[] = []
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
  return { bands, erased, counts }
}

/**
 * The band to size from, or null when none is trustworthy. A single band
 * wins outright; the ink-DOMINANT one wins when it owns at least
 * DOMINANT_BAND_MIN_INK_SHARE of the total ink (the minority band is
 * neighbor-line bleed the detection box caught - the real slide's "Storage"
 * box carried a 2px sliver of the next line and painted ~2x oversized).
 * With balanced bands, `ref` (the detector box's own rows) picks the band
 * whose in-box ink beats the runner-up's decisively - a drawn border row
 * between the two leading bands lowers the bar (see the BAND_REF_*
 * constants above); a near-tie means a genuine multi-line detection and
 * banding declines.
 */
function chooseBand(
  bands: InkBand[],
  ref: InkSpan,
  counts: number[] = [],
  erased: boolean[] = []
): InkSpan | null {
  if (bands.length === 0) return null
  if (bands.length === 1) return bands[0].span
  const total = bands.reduce((a, b) => a + b.ink, 0)
  const dominant = bands.reduce((a, b) => (b.ink > a.ink ? b : a))
  if (dominant.ink >= total * DOMINANT_BAND_MIN_INK_SHARE) return dominant.span

  const overlapRows = bands.map((b) =>
    Math.max(0, Math.min(b.span.end, ref.end) - Math.max(b.span.start, ref.start))
  )
  const overlapInk = bands.map((b) => {
    let ink = 0
    const from = Math.max(b.span.start, ref.start)
    const to = Math.min(b.span.end, ref.end)
    for (let r = from; r < to; r++) ink += counts[r] ?? 0
    return ink
  })
  let bestIdx = 0
  let runnerIdx = -1
  for (let i = 1; i < bands.length; i++) {
    if (overlapInk[i] > overlapInk[bestIdx]) {
      runnerIdx = bestIdx
      bestIdx = i
    } else if (runnerIdx === -1 || overlapInk[i] > overlapInk[runnerIdx]) {
      runnerIdx = i
    }
  }
  const borderBetween = (() => {
    if (runnerIdx === -1 || overlapInk[runnerIdx] === 0) return false
    const gapStart = Math.min(bands[bestIdx].span.end, bands[runnerIdx].span.end)
    const gapEnd = Math.max(bands[bestIdx].span.start, bands[runnerIdx].span.start)
    for (let r = gapStart; r < gapEnd; r++) {
      if (erased[r]) return true
    }
    return false
  })()
  const ratio = borderBetween ? BAND_REF_BORDER_RATIO : BAND_REF_DECISIVE_RATIO
  const runnerInk = runnerIdx === -1 ? 0 : overlapInk[runnerIdx]
  return overlapRows[bestIdx] >= BAND_REF_MIN_OVERLAP_PX && overlapInk[bestIdx] >= runnerInk * ratio
    ? bands[bestIdx].span
    : null
}

/**
 * `region` with its inkBBox set to the measured ink row band (the SIZE
 * authority downstream - validateRegions preserves an engine-provided
 * inkBBox) - or unchanged (same object) when the band is absent,
 * ambiguous, degenerate, or the full crop height. The bbox (FILL
 * authority) grows to cover the full glyph band - painting only the band
 * left the original's antialiased fringe uncovered as a visible ghost
 * around every repainted line - but is then clipped away from FOREIGN ink:
 * a neighbor line's band or an erased border row must never be erased by
 * this region's fill (live failures: stacked-label boxes shaved the glyph
 * tops off the line below; the "hours" box erased a segment of the table
 * border under it). Clip limits stand DILATION_PX clear of the
 * obstruction, so validateRegions's later dilation lands exactly at its
 * edge; slack over genuinely EMPTY rows is kept as before.
 */
function tightenVertical(
  region: TextRegion,
  ctx: Canvas2D,
  imgW: number,
  imgH: number,
  others: TextRegion[] = []
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
  // Foreign RECTS are blanked to flat background before the row profile so
  // a row-merge bands to ITS OWN line instead of a union with the
  // neighbors it lassoed - see TRUSTWORTHY_MAX_ASPECT/foreignZones.
  const zones = foreignZones(region, others, ey0, ey1)
  for (const z of zones) {
    const fx0 = Math.max(x0, z.x0)
    const fx1 = Math.min(x1, z.x1)
    const fy0 = Math.max(ey0, z.y0)
    const fy1 = Math.min(ey1, z.y1)
    const flat = Math.round(bg)
    for (let yy = fy0; yy < fy1; yy++) {
      for (let xx = fx0; xx < fx1; xx++) {
        const i = 4 * ((yy - ey0) * w + (xx - x0))
        data[i] = flat
        data[i + 1] = flat
        data[i + 2] = flat
      }
    }
  }
  const { bands, erased, counts } = inkRowBands(data, w, eh, bg)
  const band = chooseBand(bands, { start: y0 - ey0, end: y1 - ey0 }, counts, erased)
  if (!band) return { region, bg }
  const bandY = ey0 + band.start
  const bandH = band.end - band.start
  if (bandH < MIN_BAND_H_PX || bandH >= eh) return { region, bg }

  let top = Math.min(region.bbox.y, bandY)
  let bottom = Math.max(region.bbox.y + region.bbox.h, bandY + bandH)
  let aboveLimit = -Infinity
  let belowLimit = Infinity
  for (const b of bands) {
    if (b.span === band) continue
    if (b.span.end <= band.start) {
      aboveLimit = Math.max(aboveLimit, ey0 + b.span.end + DILATION_PX)
    }
    if (b.span.start >= band.end) {
      belowLimit = Math.min(belowLimit, ey0 + b.span.start - DILATION_PX)
    }
  }
  for (let r = 0; r < eh; r++) {
    if (!erased[r]) continue
    if (r < band.start) aboveLimit = Math.max(aboveLimit, ey0 + r + 1 + DILATION_PX)
    if (r >= band.end) belowLimit = Math.min(belowLimit, ey0 + r - DILATION_PX)
  }
  // The masked foreign zones must obstruct the fill box DIRECTLY (review
  // finding): blanking hid their ink from `bands`, so the band-based clip
  // above cannot see them - but a raw detector box that overlapped a
  // neighbor would otherwise keep covering it and the fill would erase the
  // neighbor's real glyphs. Zone edges already carry DILATION_PX margin.
  for (const z of zones) {
    if (z.y1 <= bandY) aboveLimit = Math.max(aboveLimit, z.y1)
    if (z.y0 >= bandY + bandH) belowLimit = Math.min(belowLimit, z.y0)
  }
  // The clip never cuts into the chosen band itself: touching an adjacent
  // obstruction beats shaving the glyphs being replaced.
  top = Math.min(bandY, Math.max(top, aboveLimit))
  bottom = Math.max(bandY + bandH, Math.min(bottom, belowLimit))
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
  bg: number,
  others: TextRegion[] = [],
  loose?: { y0: number; y1: number }
): TextRegion[] {
  const x0 = Math.max(0, Math.floor(region.bbox.x))
  // The PRE-CLIP loose vertical extent: the fill box may have been clipped
  // clear of a foreign zone (tightenVertical), but gridline candidacy and
  // per-cell band search need the detector's original slack - in a
  // band-tight crop every letter stem reads as a full-height border (the
  // exact failure the loose-height rule below exists for; observed live
  // when the zone clip shrank "Fill Volume:..."'s box to its band and the
  // row split at its own stems).
  const y0 = Math.max(0, Math.floor(loose?.y0 ?? region.bbox.y))
  const x1 = Math.min(imgW, Math.ceil(region.bbox.x + region.bbox.w))
  const y1 = Math.min(imgH, Math.ceil(loose?.y1 ?? region.bbox.y + region.bbox.h))
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
  // Foreign-ink exclusion - see TRUSTWORTHY_MAX_ASPECT: columns covered by
  // another trustworthy region whose rows share this BAND are someone
  // else's text, erased like gridlines (so a valley through them qualifies
  // at gridline width). Column-scope is correct here - the profile below
  // only spans the band's own rows.
  for (const z of foreignZones(region, others, bandY0, bandY0 + bandH)) {
    for (let cx = Math.max(x0, z.x0); cx < Math.min(x1, z.x1); cx++) {
      counts[cx - x0] = 0
      erased[cx - x0] = true
    }
  }
  const spans = inkSpans(counts, bandH, erased)
  if (process.env.CELLSPLIT_DEBUG) {
    console.error(
      `[cellsplit] "${region.text.slice(0, 40)}" box=[${x0},${y0} ${w}x${h}] band=[${bandY0},${bandH}] ` +
        `spans=${JSON.stringify(spans.map((s) => [x0 + s.start, x0 + s.end]))}`
    )
  }
  if (spans.length < 2) return [region]

  const { tokenWidths, spaceWidth } = measuredTokenWidths(tokens, region.text)
  const groups = distributeTokens(
    tokenWidths,
    spaceWidth,
    spans.map((s) => s.end - s.start)
  )
  if (!groups) {
    const substantial = spans.filter((s) => s.end - s.start >= SUBSTANTIAL_SPAN_MIN_PX).length
    if (process.env.CELLSPLIT_DEBUG) {
      console.error(`[cellsplit]   -> DP null, substantial=${substantial}`)
    }
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
    const cellRef: InkSpan = band
      ? { start: bandY0 - y0, end: bandY0 - y0 + bandH }
      : { start: 0, end: h }
    const cellRows = inkRowBands(cellData, spanW, h, bg)
    const cellBand = chooseBand(cellRows.bands, cellRef, cellRows.counts, cellRows.erased)
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
      if (process.env.CELLSPLIT_DEBUG) {
        console.error(
          `[cellsplit] double-vote pair: "${a.text.slice(0, 30)}" (${a.confidence}) ` +
            `vs "${b.text.slice(0, 30)}" (${b.confidence}) ` +
            `iou=${iou(boxA, boxB).toFixed(2)} cont=${overlapOfSmaller(boxA, boxB).toFixed(2)} ` +
            `boxA=[${boxA.x},${boxA.y} ${boxA.w}x${boxA.h}] boxB=[${boxB.x},${boxB.y} ${boxB.w}x${boxB.h}]`
        )
      }
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
      const pending: {
        region: TextRegion
        bg: number | null
        loose: { y0: number; y1: number }
      }[] = []
      for (const region of regions) {
        if (region.rotation || region.rotated) {
          out.push(region)
          continue
        }
        // Band-measure FIRST (tightenVertical sets inkBBox, the size
        // authority the split's thresholds and downstream sizing key off).
        // Fellow RAW regions feed the foreign-column exclusion - their raw
        // boxes hug their ink well enough to mask a row-merge's lassoed
        // neighbors out of its band measurement.
        const rawOthers = regions.filter((r) => r !== region)
        const rawY0 = region.bbox.y
        const rawY1 = region.bbox.y + region.bbox.h
        const { region: tightened, bg } = tightenVertical(
          region,
          ctx,
          img.width,
          img.height,
          rawOthers
        )
        // The PRE-CLIP loose extent (raw box unioned with the band) - the
        // fill box above may be clipped clear of foreign zones, but the
        // split's gridline candidacy needs the original slack (see
        // trySplit's `loose` parameter).
        const ink = tightened.inkBBox
        const loose = {
          y0: Math.min(rawY0, ink?.y ?? rawY0),
          y1: Math.max(rawY1, ink ? ink.y + ink.h : rawY1)
        }
        // Hallucination kill - a "reading" that cannot fit its own box is
        // dropped before it can paint or poison a merge (see cannotFitBox).
        if (cannotFitBox(tightened)) {
          if (process.env.CELLSPLIT_DEBUG) {
            console.error(`[cellsplit] cannot-fit kill: "${tightened.text.slice(0, 40)}"`)
          }
          continue
        }
        pending.push({ region: tightened, bg, loose })
      }
      // Double-vote dedup runs on the whole band-measured set BEFORE
      // splitting - see dropDoubleVotes.
      const kept = new Set(dropDoubleVotes(pending.map((p) => p.region)))
      if (process.env.CELLSPLIT_DEBUG) {
        for (const p of pending) {
          if (!kept.has(p.region)) {
            console.error(`[cellsplit] double-vote drop: "${p.region.text.slice(0, 40)}"`)
          }
        }
      }
      for (const p of pending) {
        if (!kept.has(p.region)) continue
        if (p.bg !== null && isSplitCandidate(p.region)) {
          const others = [...kept].filter((r) => r !== p.region)
          out.push(...trySplit(p.region, ctx, img.width, img.height, p.bg, others, p.loose))
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
