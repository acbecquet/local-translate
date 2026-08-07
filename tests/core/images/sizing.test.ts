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

describe('refinePaintSizes - apply-time paint sizing (feedback loop: cap-normalized band targeting)', () => {
  const latinFont: FontSpec = { family: 'Noto Sans', sizePt: 0 }
  const cjkFont: FontSpec = { family: 'Noto Sans CJK SC', sizePt: 0 }

  function item(
    lines: string[],
    sourceText: string,
    fittedSizePt: number,
    font: FontSpec,
    inkH: number,
    boxW = 4000
  ): PaintSizeItem {
    return {
      lines,
      sourceText,
      fittedSizePt,
      font,
      region: {
        bbox: { x: 0, y: 0, w: boxW, h: inkH + 4 },
        inkBBox: { x: 2, y: 2, w: boxW - 4, h: inkH }
      }
    }
  }

  it('renders a CJK translation at ~1.3x the source CAP band - how a text-layer translation at the authored em looks', () => {
    // The source band of a caps/ascender Latin string IS its cap height;
    // office CJK glyph ink runs ~1.3x cap at the same em. Measuring the
    // source's ratio in Noto (skia metrics) recovers the wrong em because
    // the slide's real font has different cap/em - cap normalization from
    // the string's own glyph classes is font-agnostic.
    const band = 16
    const [size] = refinePaintSizes([item(['高温高湿'], 'HIGH TEMP', 999, cjkFont, band)])
    expect(Math.abs(inkHeightAt('高温高湿', size, cjkFont) - band * 1.3)).toBeLessThanOrEqual(2)
  })

  it('normalizes a descender-bearing source band to the same cap height, so descender rows and caps rows paint EQUAL sizes', () => {
    // 'ABC' band = cap (16px); 'Abg' band = cap + descender (~1.28x cap =
    // 20.5px). Both describe the same authored size and must come out equal.
    const [a, b] = refinePaintSizes([
      item(['甲乙丙'], 'ABC', 999, cjkFont, 16),
      item(['丁戊己'], 'Abg', 999, cjkFont, 20.5)
    ])
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1)
  })

  it('targets ink parity (1x band) for a non-CJK translation - same script, same ink', () => {
    const band = 16
    const [size] = refinePaintSizes([item(['Resultados'], 'RESULTS', 999, latinFont, band)])
    expect(Math.abs(inkHeightAt('Resultados', size, latinFont) - band)).toBeLessThanOrEqual(2.5)
  })

  it('caps the size so the translation never exceeds the region width', () => {
    // A long translation into a narrow box: the width cap binds, not the
    // band target.
    const [size] = refinePaintSizes([item(['很长的翻译文本超过格子'], 'HI', 999, cjkFont, 30, 60)])
    const { family } = resolveFamily(cjkFont.family)
    measureCtx.font = `${size}px "${family}"`
    expect(measureCtx.measureText('很长的翻译文本超过格子').width).toBeLessThanOrEqual(60)
  })

  it('keeps the fitted size for a multi-line (wrapped) paint', () => {
    const [size] = refinePaintSizes([
      item(['line one', 'line two'], 'line one line two', 11, latinFont, 40)
    ])
    expect(size).toBe(11)
  })

  it('unifies same-row cells whose bands differ only by measurement noise to ONE shared size at least the smallest target', () => {
    // Real slide-6 failure: Media/Voltage cells of one row recovered
    // targets 7% apart but landed in different clusters and painted 20%
    // apart. The widened, median-snapping cluster must give all three the
    // same size, no smaller than the smallest member's own target.
    const sizes = refinePaintSizes([
      item(['介质一'], 'ABC', 999, cjkFont, 16),
      item(['电压二'], 'Abg', 999, cjkFont, 21),
      item(['存储三'], 'ABX', 999, cjkFont, 16.6)
    ])
    expect(sizes[0]).toBe(sizes[1])
    expect(sizes[1]).toBe(sizes[2])
    expect(sizes[0]).toBeGreaterThanOrEqual(16 * 1.3 * 0.9)
  })

  it('anchors the cluster gap to the SMALLEST member so a smooth size chain cannot collapse to one size (real slide-6 failure)', () => {
    // Multi-line items pass through as their fitted size, so a fitted-size
    // chain exercises the clustering in isolation: adjacent sizes each
    // within 12% of the PREVIOUS one used to chain the whole table into a
    // single cluster snapped to the global minimum. Anchoring to the
    // cluster's first (smallest) member bounds any cluster's spread at 12%.
    const rows = [8, 8.8, 9.7, 10.7, 11.8, 13].map((s) =>
      item(['two', 'lines'], 'src', s, cjkFont, s)
    )
    expect(refinePaintSizes(rows)).toEqual([8, 8, 9.7, 9.7, 11.8, 11.8])
  })
})
