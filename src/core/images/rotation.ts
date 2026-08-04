// Rotated-text region support (Phase 3 polish round, Task E): the real
// deck's chart images have vertical (90-degree) axis titles. Today those get
// flagged `rotated: true` by ppocr.ts's in-place skew guess and skipped -
// Charlie's gate feedback asks for them to be translated instead, painted
// back at the SAME size and rotation, occupying only the original space.
//
// The spike doc (docs/research/2026-07-31-phase-3-spike-image-regions.md,
// "known limitation #4") already establishes WHY this can't be done by
// trusting an in-place read: PP-OCR GARBLES strongly rotated text read in
// place. The only reliable way to read it is to rotate the IMAGE itself so
// the text becomes horizontal, run the SAME engine again, and map whatever
// it finds back into the original image's coordinate frame. That is exactly
// what withRotationPasses below does - a RegionEngine decorator, not a new
// engine, so it composes with any engine (PP-OCR today, a VLM later) behind
// the same regions.ts contract.
//
// Lives in its own module rather than inside regions.ts: regions.ts is a
// pure geometry/text-content ladder with zero image-decoding dependencies
// (validateRegions takes already-detected regions and two numbers - no
// buffers, no skia-canvas) and its own test suite relies on that (regions.
// test.ts imports no image library at all). withRotationPasses needs
// skia-canvas to actually rotate image bytes and run the inner engine
// multiple times - a different concern (image manipulation + engine
// orchestration) from regions.ts's pure validation, matching how ppocr.ts,
// overlay.ts and sizing.ts already each get their own sibling module for
// their own distinct concern under src/core/images/.
import { loadImage } from 'skia-canvas'
import { createCanvas } from '../fit/fonts'
import { iou, type RegionBBox, type RegionEngine, type TextRegion } from './regions'

// Plan point 2: a rotated-pass region overlapping ANY normal-pass region
// above this IoU is dropped (the normal pass wins - ordinary horizontal text
// also decodes as garbage-but-confident "text" when the whole image is
// rotated 90 degrees, so this gate kills those false positives). The SAME
// threshold is reused for rotated-pass-vs-rotated-pass overlap (see
// dropLowerConfidenceOverlaps) - the plan calls out only the normal-pass
// comparison explicitly, but there is no separate threshold defined for the
// rotated-vs-rotated case, and reusing this one is simpler than inventing an
// unjustified second number.
const ROTATION_OVERLAP_IOU_THRESHOLD = 0.3

// Minimum elongation (long side / short side) for an ORPHAN rotated-pass
// survivor - one with zero overlap against every normal-pass region. Real
// vertical axis titles are long narrow runs; PP-OCR hallucinations on
// sideways/blank content are not reliably shaped that way (reviewer-
// prescribed guard, polish round E).
const ORPHAN_MIN_ASPECT = 2

// Gate-round-2 fix (real-deck evidence, 2026-08-04): when a chart full of
// ordinary horizontal text is rotated 90 degrees, PP-OCR reads each vertical
// STRIP of the original as one long "line" - concatenating the y-axis
// numbers, a slice of the title, an x-axis number and a legend fragment into
// a single narrow full-height candidate. Those strips destroyed whole chart
// images on the real deck: each one overlaps every individual normal-pass
// box only slightly (IoU with a small box is tiny when the union is the
// whole strip), so the IoU kill above never fires, and they are elongated,
// so the orphan aspect guard passes them too. Two additional geometric kills
// target exactly that shape:
//
// - SWALLOW: a candidate covering at least this fraction of some individual
//   normal-pass region's area has consumed an established horizontal
//   reading - real rotated text occupies space the normal pass saw nothing
//   in (a strip down the y-axis number column fully contains several of the
//   numbers; a genuine vertical axis title contains none).
const SWALLOW_FRACTION = 0.5
// - CROSSCUT: a candidate intersecting at least this many DISTINCT normal-
//   pass regions is a strip cutting across the page's horizontal content
//   (title + axis number + legend...), not a title sitting in clear margin
//   space. Two is still allowed: a vertical title hugging a crowded axis may
//   graze a neighboring tick label or two.
const CROSSCUT_MIN_REGIONS = 3
// - CONTAINED: a candidate mostly inside ONE normal-pass region (at least
//   this fraction of the CANDIDATE's own area) is a rotated re-read of
//   content the normal pass already owns. Real-deck evidence: the rotated
//   passes re-detected individual x-axis numbers ("20", "35", mirror junk
//   "OS") as 24x15 candidates sitting 96% inside the normal pass's merged
//   473x17 number-row region - far too small against the row for IoU,
//   swallow or crosscut to fire, and downstream they containment-merged
//   INTO the row and re-tagged it rotated. Same shape on photos: "NEW COIL"
//   re-read rotated inside the normal "NEW COIL2 OLD COIL1" label row.
const CONTAINED_IN_NORMAL_FRACTION = 0.6

// Opposite-direction passes frequently BOTH detect the same genuinely
// rotated text - one reading it upright, the other reading it 180-degrees
// flipped as confident gibberish ("TPM (mg/puff)" vs "(Jjnd/6w) WdL" on the
// real deck; PP-OCR's internal orientation classifier is unreliable on
// short runs). When the two readings DISAGREE and their confidences are
// within this delta, there is no basis for picking one - and painting the
// mirror reading defaces the exact case this feature exists for - so BOTH
// are dropped and the original pixels stay (the firm gate constraint
// prefers leaving content alone over painting a coin-flip). A clear
// confidence winner is still kept, and candidates whose texts AGREE are an
// ordinary duplicate (keep the higher-confidence one) regardless of delta.
const AMBIGUOUS_CONFIDENCE_DELTA = 0.1

/** Area of the intersection of two bboxes (0 when disjoint). */
function intersectionArea(a: RegionBBox, b: RegionBBox): number {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return ix > 0 && iy > 0 ? ix * iy : 0
}

/**
 * Rotates `img` (dimensions W x H) 90 degrees CLOCKWISE into a new W x H -
 * swapped-to-H-x-W PNG buffer. Drawn via translate-to-new-center + rotate +
 * draw-centered, the standard skia-canvas/HTML canvas rotation recipe: cheap
 * (one extra canvas + drawImage call) compared to any per-pixel loop.
 * Encoded as PNG regardless of the source format - this buffer only ever
 * feeds the inner engine's detectRegions, never gets saved or shown, so
 * there is nothing to preserve losslessly FOR beyond what PNG already gives.
 */
async function rotateClockwise(
  img: Awaited<ReturnType<typeof loadImage>>,
  w: number,
  h: number
): Promise<Buffer> {
  const canvas = createCanvas(h, w)
  const ctx = canvas.getContext('2d')
  ctx.translate(h / 2, w / 2)
  ctx.rotate(Math.PI / 2)
  ctx.drawImage(img, -w / 2, -h / 2)
  return canvas.toBuffer('png')
}

/** Same as rotateClockwise but COUNTERCLOCKWISE - see its doc comment. */
async function rotateCounterclockwise(
  img: Awaited<ReturnType<typeof loadImage>>,
  w: number,
  h: number
): Promise<Buffer> {
  const canvas = createCanvas(h, w)
  const ctx = canvas.getContext('2d')
  ctx.translate(h / 2, w / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.drawImage(img, -w / 2, -h / 2)
  return canvas.toBuffer('png')
}

/**
 * Coordinate mapping, CW pass (verbatim derivation - see this feature's
 * commit/handoff notes for the full point-by-point algebra):
 *
 * The CW-rotated pass image has dimensions H x W (original W x H, swapped).
 * A pixel at original (x, y) lands at CW-frame (H - y, x) - i.e. the CW
 * frame's point (rx, ry) came from original (ry, H - rx). Applying that
 * inverse point map to a rotated-frame bbox's four corners and taking the
 * new min/max per axis gives, for a rotated-frame bbox {rx, ry, rw, rh}:
 *
 *   x = ry
 *   y = H - rx - rw
 *   w = rh
 *   h = rw
 *
 * Width/height swap because a 90-degree rotation swaps which original axis
 * is "width" - this is exactly why a vertical (tall, narrow) original bbox
 * shows up as a normal (wide, short) horizontal line once rotated into the
 * CW frame, and why mapping it back gives back the tall/narrow shape.
 *
 * Text found readable (horizontal, upright) ONLY after rotating the whole
 * ORIGINAL image clockwise was, in the original frame, rotated -90 degrees
 * from horizontal (rotating the image by +90 undoes a -90 glyph rotation) -
 * see overlay.ts's own paint-side derivation for the full sign proof via a
 * pixel test (bottom-to-top reading, each glyph turned 90 degrees
 * counterclockwise from upright).
 */
function mapCwBBoxToOriginal(bbox: RegionBBox, origH: number): RegionBBox {
  return {
    x: bbox.y,
    y: origH - bbox.x - bbox.w,
    w: bbox.h,
    h: bbox.w
  }
}

/**
 * Coordinate mapping, CCW pass - the mirror-image derivation of the CW case
 * above. The CCW-rotated pass image also has dimensions H x W. A pixel at
 * original (x, y) lands at CCW-frame (y, W - x) - i.e. the CCW frame's point
 * (rx, ry) came from original (W - ry, rx). Applied to a rotated-frame
 * bbox's four corners:
 *
 *   x = W - ry - rh
 *   y = rx
 *   w = rh
 *   h = rw
 *
 * Text found readable ONLY after rotating the whole original image
 * counterclockwise was, in the original frame, rotated +90 degrees from
 * horizontal (top-to-bottom reading, each glyph turned 90 degrees clockwise
 * from upright).
 */
function mapCcwBBoxToOriginal(bbox: RegionBBox, origW: number): RegionBBox {
  return {
    x: origW - bbox.y - bbox.h,
    y: bbox.x,
    w: bbox.h,
    h: bbox.w
  }
}

function mapRegions(
  regions: TextRegion[],
  mapBBox: (b: RegionBBox) => RegionBBox,
  rotation: 90 | -90
): TextRegion[] {
  return regions.map((r) => ({
    ...r,
    bbox: mapBBox(r.bbox),
    inkBBox: r.inkBBox ? mapBBox(r.inkBBox) : undefined,
    rotation,
    // The in-place skew flag described whatever the polygon looked like
    // INSIDE the rotated-pass image (which should be near-horizontal there -
    // that is the whole point of rotating first) - it says nothing useful
    // about the original frame and would only confuse the "rotated without
    // an angle" skip check downstream, so it is cleared in favor of the now-
    // authoritative `rotation` angle (see TextRegion.rotated's own doc
    // comment on this supersession).
    rotated: undefined
  }))
}

/** True when `a` and `b` overlap above the shared dedup threshold. */
function overlapsAbove(a: RegionBBox, b: RegionBBox): boolean {
  return iou(a, b) > ROTATION_OVERLAP_IOU_THRESHOLD
}

/**
 * Resolves rotated-vs-rotated overlaps (IoU above the shared threshold) to a
 * fixpoint, mirroring regions.ts's own mergeOverlapping loop shape (DROP
 * instead of merge, since two rotated-pass detections claiming the same spot
 * are competing readings, not two real pieces of content to join):
 *
 * - Same text (trimmed): an ordinary duplicate - keep the higher-confidence
 *   one.
 * - Different text, confidence gap >= AMBIGUOUS_CONFIDENCE_DELTA: keep the
 *   clear winner.
 * - Different text, confidences within the delta: drop BOTH - an
 *   irresolvable upright-vs-mirrored reading (see the constant's doc
 *   comment); leaving the original pixels beats painting a coin-flip.
 */
function dropLowerConfidenceOverlaps(regions: TextRegion[]): TextRegion[] {
  let current = regions.slice()
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < current.length && !changed; i++) {
      for (let j = i + 1; j < current.length; j++) {
        if (!overlapsAbove(current[i].bbox, current[j].bbox)) continue
        const a = current[i]
        const b = current[j]
        const sameText = a.text.trim() === b.text.trim()
        const ambiguous =
          !sameText && Math.abs(a.confidence - b.confidence) < AMBIGUOUS_CONFIDENCE_DELTA
        const dropIndexes = ambiguous ? [i, j] : [a.confidence >= b.confidence ? j : i]
        current = current.filter((_, idx) => !dropIndexes.includes(idx))
        changed = true
        break
      }
    }
  }
  return current
}

/**
 * Wraps `engine` so detectRegions also looks for rotated (+-90 degree) text,
 * per the spike doc's finding that rotation must be handled by rotating the
 * IMAGE, never by trusting an in-place read:
 *
 * 1. Runs `engine` on the image as-is (the normal pass) - unchanged from
 *    today's behavior, byte-identical input.
 * 2. Runs `engine` again on a 90-degree-clockwise-rotated copy and again on a
 *    90-degree-counterclockwise-rotated copy (skia-canvas rotate+draw - CPU-
 *    cheap, no model cost of its own since it is the SAME engine/model
 *    running 3x, not a 3x-more-expensive one).
 * 3. Maps every rotated-pass region's bbox (and inkBBox, if the inner engine
 *    happened to set one) back into the original image's coordinate frame
 *    (see mapCwBBoxToOriginal/mapCcwBBoxToOriginal) and tags it with the
 *    corresponding `rotation` angle.
 * 4. Dedupes and guards, in order: a rotated-pass region overlapping
 *    (IoU > 0.3) any normal-pass region is dropped entirely (the normal
 *    pass wins - horizontal text also reads as confident garbage in a
 *    rotated frame); one that SWALLOWS an individual normal-pass region
 *    (>= SWALLOW_FRACTION of that region's area) or CROSSCUTS
 *    >= CROSSCUT_MIN_REGIONS distinct normal-pass regions is dropped as a
 *    rotated-frame "strip" reading of ordinary horizontal content (the
 *    failure mode that flattened real chart images at the round-2 gate);
 *    one mostly CONTAINED inside a single normal-pass region
 *    (CONTAINED_IN_NORMAL_FRACTION of its own area) is a rotated re-read of
 *    already-owned content and dies too; zero-overlap orphans must be
 *    elongated (ORPHAN_MIN_ASPECT); and among rotated-pass survivors
 *    overlapping EACH OTHER, same-text duplicates keep the
 *    higher-confidence copy while different-text conflicts keep a clear
 *    confidence winner or - within AMBIGUOUS_CONFIDENCE_DELTA - drop both
 *    (an upright-vs-mirrored reading nobody can adjudicate). Normal-pass
 *    regions FLAGGED rotated are exempt from every kill above and are
 *    instead superseded by any surviving rotated-pass reading that covers
 *    them (the candidate read the same pixels the right way up).
 *
 * Returns the normal-pass regions plus every surviving rotated-pass region,
 * as ONE raw TextRegion[] - exactly the shape any RegionEngine already
 * returns. Content gating (the 2-non-punctuation-char rule, noise floor,
 * etc.) is deliberately NOT duplicated here: the caller always runs
 * validateRegions (regions.ts) over this same raw output next, which already
 * gates every region - rotated or not - identically.
 */
export function withRotationPasses(engine: RegionEngine): RegionEngine {
  return {
    async detectRegions(image: Buffer): Promise<TextRegion[]> {
      const img = await loadImage(image)
      const w = img.width
      const h = img.height

      const normalRegions = await engine.detectRegions(image)

      const [cwBuffer, ccwBuffer] = await Promise.all([
        rotateClockwise(img, w, h),
        rotateCounterclockwise(img, w, h)
      ])
      const [cwRaw, ccwRaw] = await Promise.all([
        engine.detectRegions(cwBuffer),
        engine.detectRegions(ccwBuffer)
      ])

      const cwMapped = mapRegions(cwRaw, (b) => mapCwBBoxToOriginal(b, h), -90)
      const ccwMapped = mapRegions(ccwRaw, (b) => mapCcwBBoxToOriginal(b, w), 90)

      // Normal-vs-rotated dedup runs FIRST, on the full rotated-candidate
      // pool: a region that only reads as "text" because the whole frame
      // got rotated loses unconditionally to real, already-established
      // normal-pass content, independent of how it fares against other
      // rotated candidates. Running rotated-vs-rotated dedup first would let
      // a normal-overlapping candidate "win" that tiebreak by confidence and
      // drag its (otherwise clean) rival down with it when the winner is
      // then dropped in a second pass - see this module's test suite for the
      // exact scenario this ordering avoids.
      // Normal-pass regions FLAGGED rotated (skewed polygon, or the
      // vertical-shape signal ppocr.ts now emits) are in-place garble reads
      // of genuinely rotated text - the one kind of normal-pass content a
      // rotated-pass candidate is MORE trustworthy than, since the candidate
      // read the same pixels the right way up. They are excluded from every
      // kill below and superseded after dedup (see the return).
      const flaggedNormals = normalRegions.filter((normal) => normal.rotated)
      const cleanNormals = normalRegions.filter((normal) => !normal.rotated)

      const guarded = [...cwMapped, ...ccwMapped].filter((candidate) => {
        // (a) Same-spot conflict: the normal pass already established a
        // horizontal reading here - it wins unconditionally.
        if (cleanNormals.some((normal) => overlapsAbove(candidate.bbox, normal.bbox))) return false
        // (b) SWALLOW, (c) CROSSCUT and (e) CONTAINED kills - the shapes
        // that flattened real chart images at the round-2 gate; see the
        // constants' doc comments for the evidence behind each.
        const candidateArea = Math.max(1, candidate.bbox.w * candidate.bbox.h)
        let crossed = 0
        for (const normal of cleanNormals) {
          const inter = intersectionArea(candidate.bbox, normal.bbox)
          if (inter <= 0) continue
          crossed += 1
          const normalArea = Math.max(1, normal.bbox.w * normal.bbox.h)
          if (inter / normalArea >= SWALLOW_FRACTION) return false
          if (inter / candidateArea >= CONTAINED_IN_NORMAL_FRACTION) return false
          if (crossed >= CROSSCUT_MIN_REGIONS) return false
        }
        if (crossed > 0) return true
        // Overlapping an in-place garble of rotated text is corroboration,
        // not orphanhood - two passes saw text at this spot.
        if (flaggedNormals.some((n) => intersectionArea(candidate.bbox, n.bbox) > 0)) return true
        // (d) Orphan guard: a candidate with ZERO overlap against any
        // normal-pass region is content nothing else ever corroborated - the
        // highest-risk shape for a hallucinated rotated paint. Real rotated
        // text (vertical axis titles) is characteristically an elongated
        // run, so orphans must additionally be elongated.
        const { w: bw, h: bh } = candidate.bbox
        const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh))
        return aspect >= ORPHAN_MIN_ASPECT
      })
      // Same-text veto: a rotated-pass candidate reading the SAME string as
      // the flagged in-place garble it covers is not a better reading - it
      // is the identical wrong-direction read reproduced from a rotated
      // frame (the real deck's vertical title came back as "(nd/6w) Wd1"
      // from BOTH the in-place read and the CCW pass). Promoting it would
      // paint that garble's "translation" over the title; dropping it keeps
      // the flagged region, which downstream skips - pixels stay intact.
      const survivors = dropLowerConfidenceOverlaps(guarded).filter(
        (s) =>
          !flaggedNormals.some(
            (normal) => overlapsAbove(s.bbox, normal.bbox) && normal.text.trim() === s.text.trim()
          )
      )

      // Supersede: an in-place garble covered by a surviving (genuinely
      // different) rotated-pass reading drops out entirely - keeping both
      // would hand validateRegions an overlapping pair to containment-merge
      // into nonsense. A flagged garble NO survivor claimed stays in the
      // output: downstream adapters already skip rotated-without-angle
      // regions, so it neither translates nor paints - the original pixels
      // stay, which is the safe default.
      const remainingFlagged = flaggedNormals.filter(
        (normal) => !survivors.some((s) => overlapsAbove(s.bbox, normal.bbox))
      )

      return [...cleanNormals, ...remainingFlagged, ...survivors]
    }
  }
}

// Test-only visibility (tests/core/images/rotation.test.ts) - not part of
// this module's real interface, matching overlay.ts's/image-adapter.ts's own
// _internals convention.
export const _internals = {
  ROTATION_OVERLAP_IOU_THRESHOLD,
  ORPHAN_MIN_ASPECT,
  SWALLOW_FRACTION,
  CROSSCUT_MIN_REGIONS,
  CONTAINED_IN_NORMAL_FRACTION,
  AMBIGUOUS_CONFIDENCE_DELTA,
  mapCwBBoxToOriginal,
  mapCcwBBoxToOriginal,
  dropLowerConfidenceOverlaps,
  intersectionArea
}
