import { describe, expect, it } from 'vitest'
import { createCanvas, registerBundledFonts, resolveFamily } from '../../../src/core/fit/fonts'
import {
  inkMatchedFontSizePt,
  refinePaintSizes,
  sizingAxesFor,
  type PaintSizeItem
} from '../../../src/core/images/sizing'
import type { FontSpec } from '../../../src/core/segments'

registerBundledFonts()

// Independent measurement helper - deliberately NOT importing sizing.ts's
// own private measuredInkHeightPx, so these tests verify inkMatchedFontSizePt
// against a fresh measurement rather than checking the implementation
// against itself.
const measureCanvas = createCanvas(8, 8)
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

describe('refinePaintSizes - apply-time paint sizing (gate round 3: pixel-perfect word replacement)', () => {
  const latinFont: FontSpec = { family: 'Noto Sans', sizePt: 0 }
  const cjkFont: FontSpec = { family: 'Noto Sans CJK SC', sizePt: 0 }

  function item(
    lines: string[],
    fittedSizePt: number,
    font: FontSpec,
    inkH: number
  ): PaintSizeItem {
    return {
      lines,
      fittedSizePt,
      font,
      region: {
        bbox: { x: 0, y: 0, w: 400, h: inkH + 4 },
        inkBBox: { x: 2, y: 2, w: 396, h: inkH }
      }
    }
  }

  it("re-matches a single-line CJK TRANSLATION's ink to the original ink target instead of painting at the latin-derived author size", () => {
    // The round-3 failure: a caps/digits row's author-size estimate paints
    // its CJK replacement ~20% taller than the ink it replaces. The refined
    // size must render the TRANSLATION at the target ink height.
    const target = 20
    const authorSizeEstimate = 28 // pt derived from a latin caps row - too big for CJK glyphs
    const [size] = refinePaintSizes([item(['高温高湿结果'], authorSizeEstimate, cjkFont, target)])

    expect(size).toBeLessThan(authorSizeEstimate)
    expect(Math.abs(inkHeightAt('高温高湿结果', size, cjkFont) - target)).toBeLessThanOrEqual(2)
  })

  it('never grows a paint size past the width-fitted ceiling', () => {
    const [size] = refinePaintSizes([item(['高温高湿结果'], 5, cjkFont, 40)])
    expect(size).toBe(5)
  })

  it('keeps the fitted size for a multi-line (wrapped) paint', () => {
    const [size] = refinePaintSizes([item(['line one', 'line two'], 11, latinFont, 40)])
    expect(size).toBe(11)
  })

  it('snaps noise-level size differences across one image to a shared value while keeping genuinely distinct sizes apart', () => {
    // Three rows of one table whose detection boxes carry +-1-2px of jitter
    // (targets 20/21/22px) plus a genuinely larger heading (48px). The three
    // rows must come out at ONE size; the heading must stay its own size.
    const rows = [
      item(['行一行一'], 100, cjkFont, 20),
      item(['行二行二'], 100, cjkFont, 21),
      item(['行三行三'], 100, cjkFont, 22),
      item(['大标题大标题'], 100, cjkFont, 48)
    ]
    const sizes = refinePaintSizes(rows)

    expect(sizes[0]).toBe(sizes[1])
    expect(sizes[1]).toBe(sizes[2])
    expect(sizes[3]).toBeGreaterThan(sizes[0] * 1.5)
    for (let i = 0; i < rows.length; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(rows[i].fittedSizePt)
    }
  })
})
