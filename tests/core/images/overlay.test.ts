import { describe, expect, it } from 'vitest'
import { Canvas, loadImage } from 'skia-canvas'
import { _internals, fit } from '../../../src/core/fit/fit-engine'
import { registerBundledFonts } from '../../../src/core/fit/fonts'
import {
  _internals as overlayInternals,
  renderOverlay,
  type OverlayRegion
} from '../../../src/core/images/overlay'
import { DILATION_PX } from '../../../src/core/images/regions'
import { inkMatchedFontSizePt } from '../../../src/core/images/sizing'

registerBundledFonts()

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]
const JPEG_MAGIC = [0xff, 0xd8]

interface Decoded {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** Builds a solid-color test image the same way real inputs arrive: an
 * encoded PNG/JPEG buffer, never a raw canvas - renderOverlay's contract
 * starts from bytes (loadImage + magic-byte format sniffing). */
async function solidImageBuffer(
  width: number,
  height: number,
  color: string,
  format: 'png' | 'jpeg' = 'png'
): Promise<Buffer> {
  const canvas = new Canvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  return canvas.toBuffer(format, format === 'jpeg' ? { quality: 0.9 } : undefined)
}

async function decode(buffer: Buffer): Promise<Decoded> {
  const img = await loadImage(buffer)
  const canvas = new Canvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, img.width, img.height)
  return { width: img.width, height: img.height, data: imageData.data }
}

function pixelAt(decoded: Decoded, x: number, y: number): { r: number; g: number; b: number } {
  const idx = (y * decoded.width + x) * 4
  return { r: decoded.data[idx], g: decoded.data[idx + 1], b: decoded.data[idx + 2] }
}

function luminance(c: { r: number; g: number; b: number }): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
}

function channelDelta(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number }
): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b))
}

function magicMatches(buffer: Buffer, magic: number[]): boolean {
  return magic.every((byte, i) => buffer[i] === byte)
}

/** Tight pixel bounding box of every pixel in `region` whose color differs
 * from `bg` by more than the fixed detection threshold shared with the
 * other tests in this file (channelDelta > 40) - i.e. the actual rendered
 * INK extent, read straight from pixels rather than from any font metric.
 * Returns null when the region is pure background (no ink found at all). */
function scanInkBBox(
  decoded: Decoded,
  region: { x: number; y: number; w: number; h: number },
  bg: { r: number; g: number; b: number }
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      const p = pixelAt(decoded, x, y)
      if (channelDelta(p, bg) > 40) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

describe('renderOverlay - zero regions (behavior contract point 1)', () => {
  it('returns a pixel-identical decode for a png input with no regions', async () => {
    const input = await solidImageBuffer(40, 30, '#3366cc', 'png')
    const before = await decode(input)

    const result = await renderOverlay(input, [])

    expect(result.format).toBe('png')
    const after = await decode(result.image)
    expect(after.width).toBe(before.width)
    expect(after.height).toBe(before.height)
    expect(Array.from(after.data)).toEqual(Array.from(before.data))
  })

  it('returns the same dimensions (not necessarily identical bytes) for a jpeg input with no regions', async () => {
    const input = await solidImageBuffer(40, 30, '#3366cc', 'jpeg')
    const before = await decode(input)

    const result = await renderOverlay(input, [])

    expect(result.format).toBe('jpeg')
    const after = await decode(result.image)
    expect(after.width).toBe(before.width)
    expect(after.height).toBe(before.height)
  })
})

describe('renderOverlay - background-sampled fill (behavior contract point 2)', () => {
  it('samples the surrounding red as the fill and leaves no stray white outside the drawn text rows', async () => {
    const width = 140
    const height = 80
    const red = { r: 200, g: 30, b: 30 }
    const canvas = new Canvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = `rgb(${red.r}, ${red.g}, ${red.b})`
    ctx.fillRect(0, 0, width, height)
    // Simulate original (untranslated) white source text sitting inside the
    // bbox - renderOverlay must erase this, not just paint over gaps in it.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(30, 30, 60, 20)
    const input = await canvas.toBuffer('png')

    const region: OverlayRegion = {
      bbox: { x: 20, y: 20, w: 100, h: 40 },
      lines: ['New'],
      fontSizePt: 16,
      font: { family: 'Noto Sans', sizePt: 16 }
    }

    const result = await renderOverlay(input, [region])
    const decoded = await decode(result.image)

    // Vertically centered text block for a single 16pt line (line height
    // 1.2) occupies roughly [30.4, 49.6] within the bbox's y:[20,60] span -
    // rows near the top and bottom edges of the bbox must be pure fill.
    for (const y of [21, 22, 58, 59]) {
      for (const x of [25, 60, 110]) {
        const p = pixelAt(decoded, x, y)
        expect(channelDelta(p, red)).toBeLessThan(8)
      }
    }
  })
})

describe('renderOverlay - large regions (regression: spread over per-pixel arrays)', () => {
  it('handles a region large enough to overflow a spread-args call without throwing', async () => {
    // 460x340 interior = ~156k pixels. Math.max(...distances) over an array
    // that size exceeds V8's call-argument limit and throws RangeError - the
    // accumulator-loop implementation must survive it. Real banner/title
    // regions on deck screenshots reach this size routinely.
    const width = 500
    const height = 400
    const canvas = new Canvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#204060'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(60, 60, 380, 280)
    const input = await canvas.toBuffer('png')

    const region: OverlayRegion = {
      bbox: { x: 20, y: 30, w: 460, h: 340 },
      lines: ['Large banner'],
      fontSizePt: 24,
      font: { family: 'Noto Sans', sizePt: 24 }
    }

    const result = await renderOverlay(input, [region])
    const decoded = await decode(result.image)
    expect(decoded.width).toBe(width)
    expect(decoded.height).toBe(height)
  })
})

describe('renderOverlay - 2-means cluster branch (not just the uniform fallback)', () => {
  it('draws glyphs near the interior text cluster color when the region genuinely contains old text pixels', async () => {
    // Yellow background with BLUE original text inside the bbox: maxDist to
    // the yellow fill is far above the uniform floor, so this exercises the
    // real Lloyd clustering, and the picked text color must land near blue -
    // NOT the black that the luminance fallback would choose for a bright
    // yellow fill. That difference is what distinguishes a working
    // cluster-selection from a silently broken one.
    const width = 160
    const height = 80
    const yellow = { r: 240, g: 220, b: 40 }
    const blue = { r: 20, g: 40, b: 200 }
    const canvas = new Canvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = `rgb(${yellow.r}, ${yellow.g}, ${yellow.b})`
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = `rgb(${blue.r}, ${blue.g}, ${blue.b})`
    ctx.fillRect(30, 30, 100, 20)
    const input = await canvas.toBuffer('png')

    const region: OverlayRegion = {
      bbox: { x: 15, y: 15, w: 130, h: 50 },
      lines: ['Text'],
      fontSizePt: 20,
      font: { family: 'Noto Sans', sizePt: 20 }
    }

    const result = await renderOverlay(input, [region])
    const decoded = await decode(result.image)

    // Scan the bbox interior for the darkest drawn pixel - with working
    // clustering it belongs to a glyph in (near-)blue; with the luminance
    // fallback it would be (near-)black. Blue distance << black distance.
    let darkest = { r: 255, g: 255, b: 255 }
    for (let y = 16; y < 64; y++) {
      for (let x = 16; x < 144; x++) {
        const p = pixelAt(decoded, x, y)
        if (luminance(p) < luminance(darkest)) darkest = p
      }
    }
    const distTo = (c: { r: number; g: number; b: number }): number =>
      Math.hypot(darkest.r - c.r, darkest.g - c.g, darkest.b - c.b)
    expect(distTo(blue)).toBeLessThan(distTo({ r: 0, g: 0, b: 0 }))
    expect(distTo(blue)).toBeLessThan(80)
  })
})

describe('renderOverlay - text color contrast (behavior contract point 3)', () => {
  it('picks light text on a dark fill', async () => {
    const input = await solidImageBuffer(120, 60, '#101010', 'png')
    const region: OverlayRegion = {
      bbox: { x: 10, y: 10, w: 100, h: 40 },
      lines: ['Hi'],
      fontSizePt: 24,
      font: { family: 'Noto Sans', sizePt: 24 }
    }

    const result = await renderOverlay(input, [region])
    const decoded = await decode(result.image)
    const fill = pixelAt(decoded, region.bbox.x + 2, region.bbox.y + 2)

    let sawGlyph = false
    for (let y = region.bbox.y; y < region.bbox.y + region.bbox.h && !sawGlyph; y++) {
      for (let x = region.bbox.x; x < region.bbox.x + region.bbox.w; x++) {
        const p = pixelAt(decoded, x, y)
        if (channelDelta(p, fill) > 60) {
          expect(luminance(p)).toBeGreaterThan(luminance(fill))
          sawGlyph = true
          break
        }
      }
    }
    expect(sawGlyph).toBe(true)
  })

  it('picks dark text on a light fill', async () => {
    const input = await solidImageBuffer(120, 60, '#f2f2f2', 'png')
    const region: OverlayRegion = {
      bbox: { x: 10, y: 10, w: 100, h: 40 },
      lines: ['Hi'],
      fontSizePt: 24,
      font: { family: 'Noto Sans', sizePt: 24 }
    }

    const result = await renderOverlay(input, [region])
    const decoded = await decode(result.image)
    const fill = pixelAt(decoded, region.bbox.x + 2, region.bbox.y + 2)

    let sawGlyph = false
    for (let y = region.bbox.y; y < region.bbox.y + region.bbox.h && !sawGlyph; y++) {
      for (let x = region.bbox.x; x < region.bbox.x + region.bbox.w; x++) {
        const p = pixelAt(decoded, x, y)
        if (channelDelta(p, fill) > 60) {
          expect(luminance(p)).toBeLessThan(luminance(fill))
          sawGlyph = true
          break
        }
      }
    }
    expect(sawGlyph).toBe(true)
  })
})

describe('renderOverlay - edge-flush border ring (behavior contract point 4)', () => {
  it('does not throw and clamps correctly when the bbox is flush against the top-left corner', async () => {
    const input = await solidImageBuffer(40, 40, '#224488', 'png')
    const region: OverlayRegion = {
      bbox: { x: 0, y: 0, w: 20, h: 20 },
      lines: ['Ok'],
      fontSizePt: 12,
      font: { family: 'Noto Sans', sizePt: 12 }
    }

    const result = await renderOverlay(input, [region])

    expect(magicMatches(result.image, PNG_MAGIC)).toBe(true)
    const decoded = await decode(result.image)
    expect(decoded.width).toBe(40)
    expect(decoded.height).toBe(40)
  })

  it('does not throw and clamps correctly when the bbox is flush against the bottom-right corner', async () => {
    const input = await solidImageBuffer(40, 40, '#224488', 'png')
    const region: OverlayRegion = {
      bbox: { x: 20, y: 20, w: 20, h: 20 },
      lines: ['Ok'],
      fontSizePt: 12,
      font: { family: 'Noto Sans', sizePt: 12 }
    }

    await expect(renderOverlay(input, [region])).resolves.toBeDefined()
  })
})

describe('renderOverlay - output format by magic bytes (behavior contract point 5)', () => {
  it('encodes a png input back to png', async () => {
    const input = await solidImageBuffer(50, 50, '#556677', 'png')
    const region: OverlayRegion = {
      bbox: { x: 5, y: 5, w: 30, h: 20 },
      lines: ['A'],
      fontSizePt: 10,
      font: { family: 'Noto Sans', sizePt: 10 }
    }

    const result = await renderOverlay(input, [region])

    expect(result.format).toBe('png')
    expect(magicMatches(result.image, PNG_MAGIC)).toBe(true)
  })

  it('encodes a jpeg input back to jpeg', async () => {
    const input = await solidImageBuffer(50, 50, '#556677', 'jpeg')
    const region: OverlayRegion = {
      bbox: { x: 5, y: 5, w: 30, h: 20 },
      lines: ['A'],
      fontSizePt: 10,
      font: { family: 'Noto Sans', sizePt: 10 }
    }

    const result = await renderOverlay(input, [region])

    expect(result.format).toBe('jpeg')
    expect(magicMatches(result.image, JPEG_MAGIC)).toBe(true)
  })
})

describe('renderOverlay - CJK glyph rendering (behavior contract point 6)', () => {
  it('renders non-empty CJK glyphs, proving CJK font registration reaches the actual draw call', async () => {
    const input = await solidImageBuffer(150, 60, '#eeeeee', 'png')
    const region: OverlayRegion = {
      bbox: { x: 10, y: 5, w: 130, h: 50 },
      lines: ['你好'], // "hello" in Simplified Chinese
      fontSizePt: 28,
      font: { family: 'Noto Sans CJK SC', sizePt: 28 }
    }

    const result = await renderOverlay(input, [region])
    const decoded = await decode(result.image)
    const fill = pixelAt(decoded, region.bbox.x + 1, region.bbox.y + 1)

    let nonFillPixelCount = 0
    for (let y = region.bbox.y; y < region.bbox.y + region.bbox.h; y++) {
      for (let x = region.bbox.x; x < region.bbox.x + region.bbox.w; x++) {
        const p = pixelAt(decoded, x, y)
        if (channelDelta(p, fill) > 40) nonFillPixelCount++
      }
    }
    expect(nonFillPixelCount).toBeGreaterThan(0)
  })
})

describe('renderOverlay + inkMatchedFontSizePt - pixel-exact ink height (polish round Task C)', () => {
  it("paints a translated line whose rendered ink-row extent is within 2px of the ORIGINAL text's, at a real (dilated) region geometry", async () => {
    // Build the "source" image exactly the way a real screenshot/deck would
    // arrive: an encoded PNG with real glyphs already drawn on it, at a size
    // this test picks (26pt) but the code under test never gets told -
    // it has to recover the original ink height purely from the image's own
    // pixels, the same way regions.ts's inkBBox does from a detector's raw
    // (pre-dilation) geometry.
    const width = 320
    const height = 150
    const white = { r: 255, g: 255, b: 255 }
    const origSizePt = 26
    const originalText = 'Hello'

    const srcCanvas = new Canvas(width, height)
    const srcCtx = srcCanvas.getContext('2d')
    srcCtx.fillStyle = '#ffffff'
    srcCtx.fillRect(0, 0, width, height)
    srcCtx.font = `${origSizePt}px "Noto Sans"`
    srcCtx.fillStyle = '#000000'
    srcCtx.textAlign = 'left'
    srcCtx.textBaseline = 'top'
    srcCtx.fillText(originalText, 40, 40)
    const input = await srcCanvas.toBuffer('png')

    // Recover the original's tight ink bbox by scanning pixels, not by
    // trusting the draw call's own font metrics - this is what makes the
    // eventual comparison below a true pixel test, not a metrics round trip.
    const inputDecoded = await decode(input)
    const origInk = scanInkBBox(inputDecoded, { x: 0, y: 0, w: width, h: height }, white)
    expect(origInk).not.toBeNull()
    const origInkHeightPx = origInk!.maxY - origInk!.minY + 1

    // Mirrors regions.ts's own ladder: inkBBox is the raw (tight, pre-
    // dilation) box; the PAINT/FILL bbox is inkBBox dilated by DILATION_PX
    // per side, the real constant regions.ts uses, not a hand-picked number.
    const rawBBox = {
      x: origInk!.minX,
      y: origInk!.minY,
      w: origInk!.maxX - origInk!.minX + 1,
      h: origInkHeightPx
    }
    const dilatedBBox = {
      x: rawBBox.x - DILATION_PX,
      y: rawBBox.y - DILATION_PX,
      w: rawBBox.w + 2 * DILATION_PX,
      h: rawBBox.h + 2 * DILATION_PX
    }

    // A genuinely different "translation" (not the same string) - proves
    // this isn't just measuring the same text against itself.
    const translation = 'Salut'
    const font = { family: 'Noto Sans', sizePt: origInkHeightPx }
    const fontSizePt = inkMatchedFontSizePt(translation, font, origInkHeightPx)

    const region: OverlayRegion = {
      bbox: dilatedBBox,
      lines: [translation],
      fontSizePt,
      font: { family: 'Noto Sans', sizePt: fontSizePt }
    }

    const result = await renderOverlay(input, [region])
    const outputDecoded = await decode(result.image)
    // Scan a window generous enough to catch the painted glyphs even if
    // their (differently-shaped) ink sits a little outside the original's
    // exact rows, but still well clear of image edges.
    const scanWindow = {
      x: Math.max(0, dilatedBBox.x - 5),
      y: Math.max(0, dilatedBBox.y - 10),
      w: Math.min(width, dilatedBBox.w + 10),
      h: Math.min(height, dilatedBBox.h + 20)
    }
    const paintedInk = scanInkBBox(outputDecoded, scanWindow, white)
    expect(paintedInk).not.toBeNull()
    const paintedInkHeightPx = paintedInk!.maxY - paintedInk!.minY + 1

    // Charlie's "it really needs to be exact" requirement, as a pixel test:
    // the painted replacement's rendered ink height must match the
    // original's, not the dilated fill box's inflated height.
    expect(Math.abs(paintedInkHeightPx - origInkHeightPx)).toBeLessThanOrEqual(2)
  })
})

describe('LINE_HEIGHT_FACTOR drift guard', () => {
  // overlay.ts cannot import fit-engine.ts's LINE_HEIGHT_FACTOR (private, not
  // exported) so it mirrors the value - this test proves the mirrored value
  // is exactly what fit-engine's own fitsBox() uses, by checking the
  // fit/no-fit boundary it produces rather than comparing the numbers
  // directly (which the two modules have no shared import to do). Width is
  // set huge so only the height term of fitsBox can decide the outcome.
  it('matches the fit engine at the fit/no-fit height boundary', () => {
    const font = { family: 'Noto Sans', sizePt: 20 }
    const sizePt = 20
    const lines = ['a', 'b', 'c']
    const wPt = 100000
    const mirrored = overlayInternals.LINE_HEIGHT_FACTOR

    const fitsAtBoundary = _internals.measuredFits(
      lines,
      sizePt,
      { wPt, hPt: lines.length * sizePt * mirrored },
      font
    )
    const failsJustBelow = _internals.measuredFits(
      lines,
      sizePt,
      { wPt, hPt: lines.length * sizePt * mirrored - 0.01 },
      font
    )

    expect(fitsAtBoundary).toBe(true)
    expect(failsJustBelow).toBe(false)
  })

  // Sanity: fit() itself agrees text laid out at this factor's exact box
  // height does not overflow, for an actual paragraph rather than a
  // pre-built lines array (belt-and-suspenders against the two systems'
  // layout functions disagreeing in some other way).
  it('fit() does not report overflow for a box sized exactly at the mirrored factor', () => {
    const mirrored = overlayInternals.LINE_HEIGHT_FACTOR
    const r = fit('Hi', { wPt: 300, hPt: 24 * mirrored }, { family: 'Noto Sans', sizePt: 24 })
    expect(r.overflowed).toBe(false)
  })
})
