// Region engine contract for image text translation (Phase 3, Task 2). Any
// engine (PP-OCR now, a VLM or hybrid later) implements RegionEngine and its
// raw output is normalized by validateRegions before anything downstream
// (the image adapter, Task 4) ever sees it. See plan Task 2:
// docs/superpowers/plans/2026-07-31-phase-3-image-text.md and the engine
// decision: docs/research/2026-07-31-phase-3-spike-image-regions.md

/** Pixel-space bounding box. Image pixels ARE points (1px == 1pt) per the
 * plan's Global Constraints - no DPI math anywhere in this module. */
export interface RegionBBox {
  x: number
  y: number
  w: number
  h: number
}

export interface TextRegion {
  /** 'r1', 'r2', ... - stable ordering within one image. Only meaningful
   * after validateRegions has run; raw engine output may use any id. */
  id: string
  /** Clamped to image bounds. The PAINT/FILL region: DILATION_PX added per
   * side (see its doc comment) so the background-fill sampling and the
   * repainted rect both cover the couple of stray/antialiased px just
   * outside the original glyphs. NOT the size authority - see inkBBox. */
  bbox: RegionBBox
  /**
   * The merged, PRE-dilation bbox - validateRegions's surviving geometry
   * exactly as detected/merged, before DILATION_PX ever touches it. This is
   * the SIZE authority: a painted replacement's rendered ink height must
   * match this box's height exactly (polish-round Task C - reusing the
   * dilated `bbox` for sizing inflated small text worst, since +2px/side is
   * a much bigger relative fudge on an 8px legend line than on a 40px
   * headline). Populated by validateRegions on every surviving region;
   * optional because engines/tests that build a TextRegion by hand (not via
   * validateRegions) have no equivalent pre-dilation geometry to report.
   * Downstream code MUST treat an absent inkBBox as inkBBox === bbox - i.e.
   * fall back to the region's own (possibly dilated) box rather than
   * assuming any particular ink extent.
   */
  inkBBox?: RegionBBox
  /** Source text as read by the engine. */
  text: string
  /** 0..1. */
  confidence: number
  /** true -> this region's own detection polygon looks skewed (an engine's
   * in-place rotation guess - e.g. ppocr.ts's isRotated on the NORMAL,
   * unrotated pass). By itself this means "caller must skip-with-log, never
   * paint": the decision doc's spike found PP-OCR GARBLES strongly rotated
   * text read in place, so an in-place skew guess is never trustworthy
   * enough to size/paint from. Absent when the engine cannot determine
   * rotation at all (no detection polygon exposed).
   *
   * Superseded by `rotation` below whenever that field is present: a region
   * that also carries a known 90/-90 rotation angle (from
   * withRotationPasses - rotation.ts) IS paintable regardless of what this
   * flag says, because that angle came from actually reading the text
   * upright in a rotated copy of the image, not from guessing at an in-place
   * skew. Only `rotated: true` WITHOUT a `rotation` angle means skip - see
   * rotation.ts's own module doc comment for the full policy.
   */
  rotated?: boolean
  /**
   * Known rotation of this region's text relative to horizontal, populated
   * only by withRotationPasses (rotation.ts): 90 means the text reads
   * top-to-bottom (each glyph turned 90 degrees clockwise from upright);
   * -90 means it reads bottom-to-top (each glyph turned 90 degrees
   * counterclockwise from upright - the common vertical chart-axis-title
   * style). Absent for ordinary horizontal text AND for text whose rotation
   * is merely suspected (see `rotated` above) - this field is only ever set
   * from a rotated-pass detection that actually read the text upright, never
   * guessed from in-place polygon skew.
   */
  rotation?: 0 | 90 | -90
}

export interface RegionEngine {
  detectRegions(image: Buffer): Promise<TextRegion[]>
}

/**
 * Below this, a region is reported (RunReport.skippedUnsupported via
 * collectSkips) but never painted - a wrong overlay is worse than no
 * overlay (plan Global Constraints: confidence gating). This module does
 * NOT apply this floor: validateRegions is a pure geometry/text-content
 * ladder and always returns every surviving region regardless of
 * confidence, because the caller (the image adapter, Task 4) needs to tell
 * "gated for low confidence" apart from "gated for being invalid" in its
 * own reporting. Confidence gating happens there, not here.
 */
export const CONFIDENCE_FLOOR = 0.6

/**
 * Symmetric per-side box growth (px), applied to every surviving region
 * AFTER merge and BEFORE the final clamp to image bounds. PP-OCR's boxes
 * run slightly tight on small CJK glyphs (decision doc: img04 missed
 * strict IoU but hit relaxed) and antialiasing leaves a faint fringe just
 * outside the drawn glyphs in general; a small dilation absorbs both
 * before the region is used to sample a background fill or paint over
 * (overlay.ts, Task 3) so the fringe/undershoot doesn't show through.
 * Applied after merge (so merge decisions run on the tighter, un-dilated
 * geometry - dilating first would inflate IoU/containment and could merge
 * regions that shouldn't be) and before the final clamp (so growth that
 * pushes past an image edge gets clipped instead of producing an
 * out-of-bounds box).
 */
export const DILATION_PX = 2

// Regions under this in either dimension are noise (compression artifacts,
// stray detector activations) - plan point 2.
const NOISE_FLOOR_PX = 8

// Plan point 3: IoU strictly greater than this, OR containment at least the
// second threshold below, triggers a merge.
const MERGE_IOU_THRESHOLD = 0.5
const MERGE_CONTAINMENT_THRESHOLD = 0.8

// Decision doc hallucination guard: confidence gating alone lets through
// confident garbage on glossy/textless photos (observed live: "@" at 0.89,
// "02 DWWC" at 0.70). A minimum count of letter/digit characters is a
// second, independent gate - real text has letters or digits even when
// short; punctuation-only or single-character noise does not.
const MIN_NON_PUNCT_CHARS = 2
const NON_PUNCT_CHAR_RE = /[\p{L}\p{N}]/gu

function countNonPunctChars(text: string): number {
  return text.match(NON_PUNCT_CHAR_RE)?.length ?? 0
}

function bboxArea(b: RegionBBox): number {
  return Math.max(0, b.w) * Math.max(0, b.h)
}

function intersectionArea(a: RegionBBox, b: RegionBBox): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return ix * iy
}

/** Exported for rotation.ts's own overlap-based dedup (rotated-pass regions
 * vs normal-pass regions, and rotated-pass regions vs each other) - the same
 * IoU math, not a second implementation, so the two modules can never
 * disagree about what "overlapping" means. */
export function iou(a: RegionBBox, b: RegionBBox): number {
  const inter = intersectionArea(a, b)
  if (inter <= 0) return 0
  const union = bboxArea(a) + bboxArea(b) - inter
  return union <= 0 ? 0 : inter / union
}

function containmentFraction(a: RegionBBox, b: RegionBBox): number {
  const inter = intersectionArea(a, b)
  if (inter <= 0) return 0
  const smaller = Math.min(bboxArea(a), bboxArea(b))
  return smaller <= 0 ? 0 : inter / smaller
}

function shouldMerge(a: RegionBBox, b: RegionBBox): boolean {
  return iou(a, b) > MERGE_IOU_THRESHOLD || containmentFraction(a, b) >= MERGE_CONTAINMENT_THRESHOLD
}

function unionBBox(a: RegionBBox, b: RegionBBox): RegionBBox {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const x2 = Math.max(a.x + a.w, b.x + b.w)
  const y2 = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: x2 - x, h: y2 - y }
}

/** Two regions share a reading "band" when their vertical extents overlap
 * at all - used both for the final reading-order sort (plan point 4) and
 * for deciding which side of a merge's joined text comes first. */
function verticalOverlap(a: RegionBBox, b: RegionBBox): boolean {
  return a.y < b.y + b.h && b.y < a.y + a.h
}

/** True when `a` reads before `b`: same band -> left-to-right; otherwise
 * top-to-bottom. */
function readsBefore(a: TextRegion, b: TextRegion): boolean {
  if (verticalOverlap(a.bbox, b.bbox)) return a.bbox.x <= b.bbox.x
  return a.bbox.y <= b.bbox.y
}

/**
 * Merges any pair of regions meeting shouldMerge() into their union,
 * repeating to a fixpoint so a chain of overlaps (A merges B, the result
 * then also overlaps C) collapses into one region rather than stopping
 * after the first pair. Runs on raw (pre-dilation) geometry - see
 * DILATION_PX's doc comment for why dilation must come after this.
 */
function mergeOverlapping(regions: TextRegion[]): TextRegion[] {
  let current = regions.slice()
  let mergedAny = true
  while (mergedAny) {
    mergedAny = false
    for (let i = 0; i < current.length && !mergedAny; i++) {
      for (let j = i + 1; j < current.length; j++) {
        if (!shouldMerge(current[i].bbox, current[j].bbox)) continue
        const [first, second] = readsBefore(current[i], current[j])
          ? [current[i], current[j]]
          : [current[j], current[i]]
        // Orientation of the merged region: when the two sides AGREE on
        // rotation status, carry it through unchanged (a rotated region that
        // survives merged still counts as paintable-rotated rather than
        // silently losing its angle). When they DISAGREE, the dominant-area
        // contributor decides BOTH fields: at the round-2 gate a 24x15
        // rotated-pass re-read of one axis number got containment-merged
        // into the 473x17 normal-pass number row and its rotation -90 tag
        // poisoned the whole row - which then painted VERTICALLY over the
        // chart. A sliver must never re-orient the content that dominates
        // the merge; symmetrically, a tiny horizontal noise box must not
        // strip a genuine vertical title of its angle.
        const statusConflict =
          (current[i].rotation ?? null) !== (current[j].rotation ?? null) ||
          (current[i].rotated ?? false) !== (current[j].rotated ?? false)
        const dominant =
          bboxArea(current[i].bbox) >= bboxArea(current[j].bbox) ? current[i] : current[j]
        const merged: TextRegion = {
          id: first.id,
          bbox: unionBBox(current[i].bbox, current[j].bbox),
          text: `${first.text} ${second.text}`,
          confidence: Math.min(current[i].confidence, current[j].confidence),
          rotated: statusConflict
            ? dominant.rotated
            : current[i].rotated || current[j].rotated
              ? true
              : undefined,
          rotation: statusConflict ? dominant.rotation : (first.rotation ?? second.rotation)
        }
        current = [
          ...current.slice(0, i),
          merged,
          ...current.slice(i + 1, j),
          ...current.slice(j + 1)
        ]
        mergedAny = true
        break
      }
    }
  }
  return current
}

function dilate(b: RegionBBox, px: number): RegionBBox {
  return { x: b.x - px, y: b.y - px, w: b.w + 2 * px, h: b.h + 2 * px }
}

function clampToImage(b: RegionBBox, imgW: number, imgH: number): RegionBBox {
  const x = Math.max(0, b.x)
  const y = Math.max(0, b.y)
  const x2 = Math.min(imgW, b.x + b.w)
  const y2 = Math.min(imgH, b.y + b.h)
  return { x, y, w: x2 - x, h: y2 - y }
}

/**
 * Sorts into reading order (plan point 4): regions whose vertical extents
 * overlap form one band, read left-to-right; bands are read top-to-bottom.
 * A single sweep over y-sorted regions, growing each band by its running
 * max y2 so a transitive chain of overlaps (A overlaps B, B overlaps C,
 * A and C don't overlap directly) still collapses into one band - the
 * standard sorted-interval-merge algorithm applied to the y-axis.
 */
function sortReadingOrder(regions: TextRegion[]): TextRegion[] {
  const sorted = regions.slice().sort((a, b) => a.bbox.y - b.bbox.y)
  const bands: TextRegion[][] = []
  let currentBand: TextRegion[] = []
  let currentBandMaxY2 = -Infinity
  for (const region of sorted) {
    if (currentBand.length === 0 || region.bbox.y < currentBandMaxY2) {
      currentBand.push(region)
      currentBandMaxY2 = Math.max(currentBandMaxY2, region.bbox.y + region.bbox.h)
    } else {
      bands.push(currentBand)
      currentBand = [region]
      currentBandMaxY2 = region.bbox.y + region.bbox.h
    }
  }
  if (currentBand.length > 0) bands.push(currentBand)
  for (const band of bands) band.sort((a, b) => a.bbox.x - b.bbox.x)
  return bands.flat()
}

/**
 * Pure validation ladder applied over ANY raw engine output. Order:
 *
 * 1. Drop raw-degenerate bboxes (zero/negative area) - garbage input, not
 *    something later dilation/clamping should paper over (plan point 1,
 *    first half).
 * 2. Drop regions under the noise floor in either raw dimension (plan
 *    point 2) - checked before dilation so dilation can never rescue noise.
 * 3. Trim text; drop empty-after-trim regions (plan point 6).
 * 4. Content gate: drop regions with fewer than 2 non-punctuation
 *    characters (decision doc hallucination guard) - before merge, so a
 *    lone piece of garbage never contaminates a real neighbor's text.
 * 5. Merge overlapping/containing regions (plan point 3), on raw geometry.
 * 6. Sort into reading order (plan point 4) - BEFORE dilation, for the same
 *    reason merge runs on raw geometry: dilation closes up to
 *    2*DILATION_PX of real vertical gap, which would let the band sweep
 *    chain visually separate rows into one band and destroy row order
 *    (three tightly-spaced rows would come back column-major or reversed).
 * 7. Snapshot each surviving region's current (merged, pre-dilation) bbox
 *    as inkBBox, THEN dilate bbox itself (decision doc; see DILATION_PX) -
 *    a pure order-preserving map, so running it after the sort changes
 *    nothing about ordering. inkBBox has to be captured in this same step,
 *    before bbox is overwritten with the dilated value - it is the size
 *    authority downstream sizing (sizing.ts's inkMatchedFontSizePt) uses
 *    instead of the inflated dilated box (polish-round Task C).
 * 8. Clamp to image bounds; drop anything that clamps to a zero/negative
 *    area box (plan point 1, second half - e.g. a region already entirely
 *    outside the image, or dilated past an edge with nothing left inside).
 * 9. Assign dense, stable ids 'r1'..'rN' (plan point 5) - last, so ids
 *    never depend on anything but the final surviving set and its order.
 *
 * Residual caveat on the band sweep: its running-max is transitive, so
 * three regions whose RAW vertical extents genuinely chain-overlap still
 * share a band even when the outer two never overlap directly. That is
 * inherent to y-band reading order and acceptable for real page content;
 * the ordering above only removes the case where dilation manufactured
 * the chaining out of thin air.
 *
 * Source-language gating (only regions whose text is in the source
 * language get translated) is deliberately NOT part of this ladder: it
 * needs the run's source language, which validateRegions has no access to
 * by design (it stays a pure function of one image's regions + dimensions).
 * That gate belongs to the future adapter layer (Task 4,
 * image-adapter.ts's extract()), which calls validateRegions first and
 * then applies source-language gating on the result.
 */
export function validateRegions(raw: TextRegion[], imgW: number, imgH: number): TextRegion[] {
  let regions = raw.filter((r) => r.bbox.w > 0 && r.bbox.h > 0)

  regions = regions.filter((r) => r.bbox.w >= NOISE_FLOOR_PX && r.bbox.h >= NOISE_FLOOR_PX)

  regions = regions.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text.length > 0)

  regions = regions.filter((r) => countNonPunctChars(r.text) >= MIN_NON_PUNCT_CHARS)

  regions = mergeOverlapping(regions)

  regions = sortReadingOrder(regions)

  // inkBBox: r.bbox reads the PRE-dilation box (r is never mutated by this
  // map; the bbox: dilate(...) key below overwrites it in the OUTPUT object
  // only), so both keys land correctly in one pass without a second map.
  regions = regions.map((r) => ({ ...r, inkBBox: r.bbox, bbox: dilate(r.bbox, DILATION_PX) }))

  regions = regions
    .map((r) => ({ ...r, bbox: clampToImage(r.bbox, imgW, imgH) }))
    .filter((r) => r.bbox.w > 0 && r.bbox.h > 0)

  return regions.map((r, i) => ({ ...r, id: `r${i + 1}` }))
}
