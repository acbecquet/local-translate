import { describe, expect, it } from 'vitest'
import { Canvas } from 'skia-canvas'
import { registerBundledFonts, resolveFamily } from '../../../src/core/fit/fonts'
import { inkMatchedFontSizePt, sizingAxesFor } from '../../../src/core/images/sizing'
import type { FontSpec } from '../../../src/core/segments'

registerBundledFonts()

// Independent measurement helper - deliberately NOT importing sizing.ts's
// own private measuredInkHeightPx, so these tests verify inkMatchedFontSizePt
// against a fresh measurement rather than checking the implementation
// against itself.
const measureCanvas = new Canvas(8, 8)
const measureCtx = measureCanvas.getContext('2d')

function inkHeightAt(text: string, sizePt: number, font: FontSpec): number {
  const { family } = resolveFamily(font.family)
  const weight = font.bold ? 'bold ' : ''
  const style = font.italic ? 'italic ' : ''
  measureCtx.font = `${style}${weight}${sizePt}px "${family}"`
  const m = measureCtx.measureText(text)
  return m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
}

describe('inkMatchedFontSizePt - round trip (latin, small target)', () => {
  it('returns a size whose measured ink height matches an 8px target within 2px', () => {
    const font: FontSpec = { family: 'Noto Sans', sizePt: 0 }
    const size = inkMatchedFontSizePt('Hello', font, 8)

    expect(inkHeightAt('Hello', size, font)).toBeGreaterThan(0)
    expect(Math.abs(inkHeightAt('Hello', size, font) - 8)).toBeLessThanOrEqual(2)
  })
})

describe('inkMatchedFontSizePt - round trip (latin, large target)', () => {
  it('returns a size whose measured ink height matches a 40px target within 2px', () => {
    const font: FontSpec = { family: 'Noto Sans', sizePt: 0 }
    const size = inkMatchedFontSizePt('Hello', font, 40)

    expect(Math.abs(inkHeightAt('Hello', size, font) - 40)).toBeLessThanOrEqual(2)
  })
})

describe('inkMatchedFontSizePt - round trip (CJK, small target)', () => {
  it('returns a size whose measured ink height matches an 8px target within 2px for CJK glyphs', () => {
    const font: FontSpec = { family: 'Noto Sans CJK SC', sizePt: 0 }
    const size = inkMatchedFontSizePt('你好世界', font, 8)

    expect(Math.abs(inkHeightAt('你好世界', size, font) - 8)).toBeLessThanOrEqual(2)
  })
})

describe('inkMatchedFontSizePt - round trip (CJK, large target)', () => {
  it('returns a size whose measured ink height matches a 40px target within 2px for CJK glyphs', () => {
    const font: FontSpec = { family: 'Noto Sans CJK SC', sizePt: 0 }
    const size = inkMatchedFontSizePt('你好世界', font, 40)

    expect(Math.abs(inkHeightAt('你好世界', size, font) - 40)).toBeLessThanOrEqual(2)
  })
})

describe('inkMatchedFontSizePt - not the old h/1.2 estimate', () => {
  it('diverges from the old bbox.h / 1.2 heuristic for ordinary text (proves this is a real measurement, not a renamed constant)', () => {
    const font: FontSpec = { family: 'Noto Sans', sizePt: 0 }
    const target = 30
    const oldEstimate = target / 1.2 // ~25

    const size = inkMatchedFontSizePt('Hello World', font, target)

    // "Hello World" has no descenders whose ink extent equals the full
    // em-box, so the ink-matched size sits noticeably above the naive
    // h/1.2 estimate - the whole point of this function existing.
    expect(Math.abs(size - oldEstimate)).toBeGreaterThan(1)
  })
})

describe('inkMatchedFontSizePt - monotonic behavior across sizes', () => {
  it('produces a strictly larger size for a strictly larger target ink height, same text/font', () => {
    const font: FontSpec = { family: 'Noto Sans', sizePt: 0 }
    const small = inkMatchedFontSizePt('Legend', font, 8)
    const large = inkMatchedFontSizePt('Legend', font, 40)

    expect(large).toBeGreaterThan(small)
  })
})

describe('inkMatchedFontSizePt - convergence tolerance', () => {
  it('two calls for the same text/font/target return the same size deterministically', () => {
    const font: FontSpec = { family: 'Noto Sans', sizePt: 0 }
    const a = inkMatchedFontSizePt('Repeatable', font, 16)
    const b = inkMatchedFontSizePt('Repeatable', font, 16)

    expect(a).toBe(b)
  })
})

describe('inkMatchedFontSizePt - degenerate input never throws or hangs', () => {
  it('returns a floor size for a non-positive target ink height', () => {
    const font: FontSpec = { family: 'Noto Sans', sizePt: 0 }
    expect(inkMatchedFontSizePt('Hello', font, 0)).toBeGreaterThan(0)
    expect(inkMatchedFontSizePt('Hello', font, -5)).toBeGreaterThan(0)
  })

  it('terminates (does not hang) for whitespace-only text, which never gains ink height', () => {
    const font: FontSpec = { family: 'Noto Sans', sizePt: 0 }
    expect(() => inkMatchedFontSizePt('   ', font, 20)).not.toThrow()
  })
})

describe('sizingAxesFor - horizontal text (rotation absent/0), unchanged from pre-rotation-support behavior', () => {
  it('picks inkBBox.h as the ink target, bbox.w as the fit width, bbox.h as the fit height floor', () => {
    const region = {
      bbox: { x: 0, y: 0, w: 120, h: 34 },
      inkBBox: { x: 2, y: 2, w: 116, h: 30 }
    }

    expect(sizingAxesFor(region)).toEqual({ inkHeightPx: 30, fitBoxWPt: 120, fitBoxHPtFloor: 34 })
  })

  it('falls back to bbox when inkBBox is absent (TextRegion.inkBBox compatibility contract)', () => {
    const region = { bbox: { x: 0, y: 0, w: 120, h: 34 } }

    expect(sizingAxesFor(region)).toEqual({ inkHeightPx: 34, fitBoxWPt: 120, fitBoxHPtFloor: 34 })
  })

  it('treats rotation: 0 identically to rotation absent', () => {
    const region = {
      bbox: { x: 0, y: 0, w: 120, h: 34 },
      inkBBox: { x: 2, y: 2, w: 116, h: 30 },
      rotation: 0 as const
    }

    expect(sizingAxesFor(region)).toEqual({ inkHeightPx: 30, fitBoxWPt: 120, fitBoxHPtFloor: 34 })
  })
})

describe('sizingAxesFor - rotated +-90 text: axes swap (polish round Task E)', () => {
  it('rotation -90: ink target = inkBBox.w, fit width = bbox.h, fit height floor = bbox.w', () => {
    // A tall/narrow vertical-axis-title shape: bbox.h (220) is the run
    // length, bbox.w (40) is the ink-thickness axis - the opposite of a
    // horizontal region's usual (wide, short) shape.
    const region = {
      bbox: { x: 10, y: 10, w: 40, h: 220 },
      inkBBox: { x: 14, y: 14, w: 32, h: 212 },
      rotation: -90 as const
    }

    expect(sizingAxesFor(region)).toEqual({ inkHeightPx: 32, fitBoxWPt: 220, fitBoxHPtFloor: 40 })
  })

  it('rotation 90: same axis swap as -90 (the swap depends only on |rotation| = 90, not its sign)', () => {
    const region = {
      bbox: { x: 10, y: 10, w: 40, h: 220 },
      inkBBox: { x: 14, y: 14, w: 32, h: 212 },
      rotation: 90 as const
    }

    expect(sizingAxesFor(region)).toEqual({ inkHeightPx: 32, fitBoxWPt: 220, fitBoxHPtFloor: 40 })
  })

  it('falls back to bbox when inkBBox is absent, still swapped for rotation -90', () => {
    const region = { bbox: { x: 10, y: 10, w: 40, h: 220 }, rotation: -90 as const }

    expect(sizingAxesFor(region)).toEqual({ inkHeightPx: 40, fitBoxWPt: 220, fitBoxHPtFloor: 40 })
  })
})
