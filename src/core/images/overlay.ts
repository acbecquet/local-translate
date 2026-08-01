// Paints translated text back onto an image (Phase 3, Task 3). The algorithm
// is locked by the plan - see "Task 3: overlay.ts" in
// docs/superpowers/plans/2026-07-31-phase-3-image-text.md - and this module
// implements it verbatim rather than improvising alternatives.
import { Canvas, loadImage, type CanvasRenderingContext2D } from 'skia-canvas'
import type { FontSpec } from '../segments'
import type { RegionBBox } from './regions'
import { registerBundledFonts, resolveFamily } from '../fit/fonts'

export interface OverlayRegion {
  bbox: RegionBBox
  /** FitEngine's fittedLines. */
  lines: string[]
  /** FitEngine's fittedSizePt. */
  fontSizePt: number
  /** family/bold/italic used; colorHex is ignored - text color is always
   * sampled from the image, never taken from the source font spec. */
  font: FontSpec
}

export interface OverlayResult {
  image: Buffer
  format: 'png' | 'jpeg'
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8])

function detectFormat(buffer: Buffer): 'png' | 'jpeg' {
  if (buffer.subarray(0, 4).equals(PNG_MAGIC)) return 'png'
  if (buffer.subarray(0, 2).equals(JPEG_MAGIC)) return 'jpeg'
  throw new Error('renderOverlay: input buffer is neither PNG nor JPEG (unexpected magic bytes)')
}

// Mirrors fit-engine.ts's LINE_HEIGHT_FACTOR, which is not exported there
// (it is a module-private const with no public accessor). Kept identical by
// tests/core/images/overlay.test.ts's drift-guard test, which checks the
// fit/no-fit boundary this value produces against fit-engine's own fitsBox()
// rather than comparing numbers directly (there is no shared import to do
// that with) - it fails the moment the two modules' values diverge.
// Exposed below via _internals for that test only; not part of this
// module's real interface.
const LINE_HEIGHT_FACTOR = 1.2

// Plan point 2: a 3px border ring OUTSIDE the bbox, clamped at image edges.
const BORDER_RING_PX = 3

// Plan point 3: below this max RGB distance to fill, the interior is
// judged uniform (any original text was anti-aliased away to nothing
// distinguishable) and the black/white luminance fallback applies instead
// of 2-means clustering.
const TEXT_CLUSTER_DISTANCE_FLOOR = 40

// Plan point 3: fill luminance at/above this gets black fallback text,
// below it gets white fallback text.
const FILL_LUMINANCE_THRESHOLD = 140

// skia-canvas's ExportOptions.quality is a 0.0-1.0 fraction, not the
// conventional 0-100 JPEG quality scale the plan's "quality 90" refers to.
const JPEG_QUALITY = 0.9

interface RGB {
  r: number
  g: number
  b: number
}

/** Integer, in-bounds pixel rect for getImageData - floors the origin and
 * ceils the far edge so the rounded rect always fully covers the requested
 * float-space region, then clamps to the image so edge-flush bboxes (plan
 * behavior contract point 4) never produce an out-of-range read. */
function toClampedIntRect(
  x: number,
  y: number,
  w: number,
  h: number,
  imgW: number,
  imgH: number
): RegionBBox {
  const x0 = Math.max(0, Math.floor(x))
  const y0 = Math.max(0, Math.floor(y))
  const x1 = Math.min(imgW, Math.ceil(x + w))
  const y1 = Math.min(imgH, Math.ceil(y + h))
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function distance(a: RGB, b: RGB): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)
}

function luminance(c: RGB): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
}

function meanColor(pixels: RGB[]): RGB | null {
  if (pixels.length === 0) return null
  const sum = pixels.reduce((acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }), {
    r: 0,
    g: 0,
    b: 0
  })
  return { r: sum.r / pixels.length, g: sum.g / pixels.length, b: sum.b / pixels.length }
}

function colorsEqual(a: RGB, b: RGB): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b
}

/**
 * Reads the 3px border ring OUTSIDE `inner` (already clamped to image
 * bounds), excluding every pixel inside `inner` itself, and returns the
 * per-channel median (median, not mean: robust to stray original-text
 * pixels that happen to fall in the ring - plan point 2).
 */
function sampleFillColor(
  ctx: CanvasRenderingContext2D,
  inner: RegionBBox,
  imgW: number,
  imgH: number
): RGB {
  const outer = toClampedIntRect(
    inner.x - BORDER_RING_PX,
    inner.y - BORDER_RING_PX,
    inner.w + 2 * BORDER_RING_PX,
    inner.h + 2 * BORDER_RING_PX,
    imgW,
    imgH
  )
  if (outer.w <= 0 || outer.h <= 0) return { r: 128, g: 128, b: 128 }

  const data = ctx.getImageData(outer.x, outer.y, outer.w, outer.h).data
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  for (let py = 0; py < outer.h; py++) {
    const absY = outer.y + py
    for (let px = 0; px < outer.w; px++) {
      const absX = outer.x + px
      const insideInner =
        absX >= inner.x && absX < inner.x + inner.w && absY >= inner.y && absY < inner.y + inner.h
      if (insideInner) continue // ring pixels only - never sample what's about to be overwritten
      const idx = (py * outer.w + px) * 4
      rs.push(data[idx])
      gs.push(data[idx + 1])
      bs.push(data[idx + 2])
    }
  }

  // A bbox that (after clamping) leaves no ring pixels at all - e.g. it
  // covers the whole image - has nothing to sample; mid-gray is a neutral,
  // deterministic fallback rather than throwing on a case the caller has no
  // way to avoid.
  if (rs.length === 0) return { r: 128, g: 128, b: 128 }
  return { r: median(rs), g: median(gs), b: median(bs) }
}

/** Reads every pixel inside `inner` from the CURRENT canvas contents - this
 * must run before the fill rect is painted, since afterward every interior
 * pixel would just equal the fill color and the 2-means step below would
 * always fall through to the uniform-region fallback. */
function sampleInteriorPixels(ctx: CanvasRenderingContext2D, inner: RegionBBox): RGB[] {
  if (inner.w <= 0 || inner.h <= 0) return []
  const data = ctx.getImageData(inner.x, inner.y, inner.w, inner.h).data
  const pixels: RGB[] = []
  for (let i = 0; i < data.length; i += 4) {
    pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2] })
  }
  return pixels
}

/**
 * Plan point 3: simple 2-means on RGB distance over interior pixels, text
 * color = the cluster farthest from fill; black/white luminance fallback
 * when the interior is too uniform to cluster meaningfully.
 *
 * Seeded from the fill color (near cluster) and the single interior pixel
 * farthest from fill (far cluster) rather than a random init, so the
 * "farthest from fill" cluster is well-defined from the first iteration -
 * this needs to be fully deterministic for small synthetic test canvases,
 * not just probabilistically good on average.
 */
function textColorFor(pixels: RGB[], fill: RGB): RGB {
  // Accumulator loop, never Math.max(...spread): `pixels` is per-pixel data
  // for the whole bbox interior, and spreading tens of thousands of
  // arguments overflows V8's call-argument limit (RangeError) on regions as
  // small as a few hundred px on a side.
  const distances = pixels.map((p) => distance(p, fill))
  let maxDist = 0
  let farIdx = -1
  for (let i = 0; i < distances.length; i++) {
    if (distances[i] > maxDist || farIdx === -1) {
      maxDist = distances[i]
      farIdx = i
    }
  }
  if (farIdx === -1 || maxDist < TEXT_CLUSTER_DISTANCE_FLOOR) {
    return luminance(fill) >= FILL_LUMINANCE_THRESHOLD
      ? { r: 0, g: 0, b: 0 }
      : { r: 255, g: 255, b: 255 }
  }

  let centroidNear: RGB = { ...fill }
  let centroidFar: RGB = { ...pixels[farIdx] }

  for (let iter = 0; iter < 10; iter++) {
    const nearGroup: RGB[] = []
    const farGroup: RGB[] = []
    for (const p of pixels) {
      if (distance(p, centroidNear) <= distance(p, centroidFar)) nearGroup.push(p)
      else farGroup.push(p)
    }
    const nextNear = meanColor(nearGroup) ?? centroidNear
    const nextFar = meanColor(farGroup) ?? centroidFar
    const converged = colorsEqual(nextNear, centroidNear) && colorsEqual(nextFar, centroidFar)
    centroidNear = nextNear
    centroidFar = nextFar
    if (converged) break
  }

  return distance(centroidFar, fill) >= distance(centroidNear, fill) ? centroidFar : centroidNear
}

function toHex(c: RGB): string {
  const channel = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(c.r)}${channel(c.g)}${channel(c.b)}`
}

/** Mirrors fit-engine.ts's setFont(): same font-string shape (1px == 1pt
 * convention) and the same resolveFamily() substitution, so a family the
 * fit engine could measure is guaranteed to also be drawable here. */
function setFont(ctx: CanvasRenderingContext2D, sizePt: number, font: FontSpec): void {
  const { family } = resolveFamily(font.family)
  const weight = font.bold ? 'bold ' : ''
  const style = font.italic ? 'italic ' : ''
  ctx.font = `${style}${weight}${sizePt}px "${family}"`
}

function paintRegion(
  ctx: CanvasRenderingContext2D,
  region: OverlayRegion,
  imgW: number,
  imgH: number
): void {
  const inner = toClampedIntRect(
    region.bbox.x,
    region.bbox.y,
    region.bbox.w,
    region.bbox.h,
    imgW,
    imgH
  )
  if (inner.w <= 0 || inner.h <= 0) return // nothing left to paint after clamping

  const fill = sampleFillColor(ctx, inner, imgW, imgH)
  // Interior pixels MUST be read before the fill rect below overwrites them.
  const textColor = textColorFor(sampleInteriorPixels(ctx, inner), fill)

  ctx.fillStyle = toHex(fill)
  ctx.fillRect(inner.x, inner.y, inner.w, inner.h)

  setFont(ctx, region.fontSizePt, region.font)
  ctx.fillStyle = toHex(textColor)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'

  const lineHeightPx = region.fontSizePt * LINE_HEIGHT_FACTOR
  const totalTextH = region.lines.length * lineHeightPx
  const startY = inner.y + (inner.h - totalTextH) / 2
  region.lines.forEach((line, i) => {
    ctx.fillText(line, inner.x, startY + i * lineHeightPx)
  })
}

/**
 * Algorithm (locked - see plan Task 3):
 * 1. Decode via skia-canvas loadImage, draw onto a canvas of identical
 *    dimensions.
 * 2-4. Per region: background-fill from the sampled border ring, text color
 *    from 2-means/luminance fallback, draw fitted lines centered/left-
 *    aligned at fontSizePt (see paintRegion).
 * 5. Encode back to the INPUT format by magic bytes, never by filename:
 *    png in -> png out, jpg in -> jpeg quality 90.
 */
export async function renderOverlay(
  image: Buffer,
  regions: OverlayRegion[]
): Promise<OverlayResult> {
  const format = detectFormat(image)
  registerBundledFonts()

  const img = await loadImage(image)
  const canvas = new Canvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)

  for (const region of regions) {
    paintRegion(ctx, region, img.width, img.height)
  }

  const buffer =
    format === 'png'
      ? await canvas.toBuffer('png')
      : await canvas.toBuffer('jpeg', { quality: JPEG_QUALITY })

  return { image: buffer, format }
}

// Test-only visibility into the mirrored constant above (drift-guard test in
// tests/core/images/overlay.test.ts) - not part of this module's real
// interface, matching fit-engine.ts's own _internals convention.
export const _internals = { LINE_HEIGHT_FACTOR }
