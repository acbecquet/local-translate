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
import type { RegionEngine, TextRegion } from './regions'

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

// A valley (run of empty columns) splits the region only at
// max(MIN_VALLEY_PX, 1x region height) - ordinary word spacing is ~0.25em,
// far under one line-height, so sentences never qualify; cell gutters do.
const MIN_VALLEY_PX = 10

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
function analyzeColumns(data: Uint8ClampedArray, w: number, h: number): ColumnStats[] {
  const lum = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  const border: number[] = []
  for (let x = 0; x < w; x++) {
    border.push(lum(4 * x), lum(4 * ((h - 1) * w + x)))
  }
  for (let y = 1; y < h - 1; y++) {
    border.push(lum(4 * (y * w)), lum(4 * (y * w + w - 1)))
  }
  border.sort((a, b) => a - b)
  const bg = border[Math.floor(border.length / 2)] ?? 255

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
 * Ink counts with vertical gridline columns zeroed - see
 * GRIDLINE_MIN_COVERAGE's doc comment for why full-height + both edge bands
 * identifies a table border and not a glyph, and MAX_GRIDLINE_RUN_PX's for
 * why only narrow runs of such columns qualify.
 */
function eraseGridlineColumns(cols: ColumnStats[], h: number): number[] {
  const isCandidate = cols.map((c) => c.top && c.bottom && c.ink >= GRIDLINE_MIN_COVERAGE * h)
  const counts = cols.map((c) => c.ink)
  let x = 0
  while (x < cols.length) {
    if (!isCandidate[x]) {
      x++
      continue
    }
    const runStart = x
    while (x < cols.length && isCandidate[x]) x++
    if (x - runStart <= MAX_GRIDLINE_RUN_PX) {
      for (let i = runStart; i < x; i++) counts[i] = 0
    }
  }
  return counts
}

/**
 * Maximal ink runs after splitting the profile's overall ink extent at
 * qualifying valleys (>= max(MIN_VALLEY_PX, h) consecutive empty columns).
 * Leading/trailing empty columns are trimmed rather than treated as
 * valleys; an all-empty profile yields no spans.
 */
function inkSpans(counts: number[], h: number): InkSpan[] {
  const emptyMax = Math.max(1, Math.round(h * EMPTY_COLUMN_MAX_FRACTION))
  const minValley = Math.max(MIN_VALLEY_PX, h)
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
    if (x - runStart >= minValley) {
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
function trySplit(region: TextRegion, ctx: Canvas2D, imgW: number, imgH: number): TextRegion[] {
  const x0 = Math.max(0, Math.floor(region.bbox.x))
  const y0 = Math.max(0, Math.floor(region.bbox.y))
  const x1 = Math.min(imgW, Math.ceil(region.bbox.x + region.bbox.w))
  const y1 = Math.min(imgH, Math.ceil(region.bbox.y + region.bbox.h))
  const w = x1 - x0
  const h = y1 - y0
  if (h <= 0 || w < MIN_SPLIT_ASPECT * h) return [region]

  const tokens = region.text.trim().split(/\s+/)
  const data = ctx.getImageData(x0, y0, w, h).data
  const cols = analyzeColumns(data, w, h)
  // See NARROW_STROKE_TOKEN_RE: with a stroke-only token in play, a
  // full-height narrow run may BE that glyph, so nothing gets erased.
  const counts = tokens.some((t) => NARROW_STROKE_TOKEN_RE.test(t))
    ? cols.map((c) => c.ink)
    : eraseGridlineColumns(cols, h)
  const spans = inkSpans(counts, h)
  if (spans.length < 2) return [region]

  const { tokenWidths, spaceWidth } = measuredTokenWidths(tokens, region.text)
  const groups = distributeTokens(
    tokenWidths,
    spaceWidth,
    spans.map((s) => s.end - s.start)
  )
  if (!groups) return [region]

  let tokenIndex = 0
  return spans.map((span, i) => {
    const cellTokens = tokens.slice(tokenIndex, tokenIndex + groups[i])
    tokenIndex += groups[i]
    return {
      ...region,
      id: `${region.id}c${i + 1}`,
      // Tight ink-span geometry (validateRegions dilates later); the
      // parent's vertical geometry is kept as-is so every cell of a row
      // shares one ink-height target and paints at one uniform size.
      bbox: { x: x0 + span.start, y: region.bbox.y, w: span.end - span.start, h: region.bbox.h },
      text: cellTokens.join(' '),
      inkBBox: undefined
    }
  })
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
      if (!regions.some(isSplitCandidate)) return regions

      const img = await loadImage(image)
      const canvas = createCanvas(img.width, img.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)

      const out: TextRegion[] = []
      for (const region of regions) {
        if (isSplitCandidate(region)) out.push(...trySplit(region, ctx, img.width, img.height))
        else out.push(region)
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
