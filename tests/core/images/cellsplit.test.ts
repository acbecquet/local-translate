import { describe, expect, it, vi } from 'vitest'
import { createCanvas, registerBundledFonts } from '../../../src/core/fit/fonts'
import { validateRegions, type TextRegion } from '../../../src/core/images/regions'
import { _internals, withCellSplit } from '../../../src/core/images/cellsplit'

registerBundledFonts()

const { analyzeColumns, eraseGridlineColumns, inkSpans, distributeTokens } = _internals

/** RGBA buffer for a wxh image: `bg` everywhere, `fg` wherever paint(x,y). */
function rgba(
  w: number,
  h: number,
  bg: [number, number, number],
  fg: [number, number, number],
  paint: (x: number, y: number) => boolean
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y) ? fg : bg
      const i = 4 * (y * w + x)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return data
}

describe('analyzeColumns', () => {
  it('counts ink pixels per column and flags top/bottom edge-band presence against an estimated background', () => {
    // 8x6, white bg: full-height black column at x=3, half-height black
    // column at x=5 (rows 2-4 - touches neither edge band).
    const data = rgba(8, 6, [255, 255, 255], [0, 0, 0], (x, y) => {
      if (x === 3) return true
      return x === 5 && y >= 2 && y <= 4
    })
    const cols = analyzeColumns(data, 8, 6)
    expect(cols[3]).toEqual({ ink: 6, top: true, bottom: true })
    expect(cols[5]).toEqual({ ink: 3, top: false, bottom: false })
    expect(cols[0]).toEqual({ ink: 0, top: false, bottom: false })
  })

  it('estimates the background from the crop border, so light text on a dark background is ink too', () => {
    const data = rgba(8, 6, [20, 20, 20], [240, 240, 240], (x) => x === 3)
    const cols = analyzeColumns(data, 8, 6)
    expect(cols[3].ink).toBe(6)
    expect(cols[0].ink).toBe(0)
  })
})

describe('eraseGridlineColumns', () => {
  it('zeroes a full-height column touching both edge bands and keeps a glyph stem that touches only one', () => {
    const h = 20
    const cols = [
      { ink: 0, top: false, bottom: false },
      { ink: 20, top: true, bottom: true }, // vertical table gridline
      { ink: 15, top: true, bottom: false }, // ascender stem - never reaches the bottom band
      { ink: 18, top: true, bottom: true } // gridline with antialiasing nicks
    ]
    expect(eraseGridlineColumns(cols, h)).toEqual([0, 0, 15, 0])
  })

  it('keeps a near-full column that does not reach both edge bands (tall glyph, not a gridline)', () => {
    const cols = [{ ink: 19, top: false, bottom: true }]
    expect(eraseGridlineColumns(cols, 20)).toEqual([19])
  })

  it('erases only NARROW full-height runs - a wide solid band is content (filled header, bar), not a line', () => {
    const gridCol = { ink: 20, top: true, bottom: true }
    const blank = { ink: 0, top: false, bottom: false }
    // 3-wide full-height run: an antialiased gridline - erased.
    expect(eraseGridlineColumns([blank, gridCol, gridCol, gridCol, blank], 20)).toEqual([
      0, 0, 0, 0, 0
    ])
    // 6-wide full-height run: a solid filled band - kept as ink.
    expect(
      eraseGridlineColumns([blank, gridCol, gridCol, gridCol, gridCol, gridCol, gridCol, blank], 20)
    ).toEqual([0, 20, 20, 20, 20, 20, 20, 0])
  })
})

describe('inkSpans', () => {
  it('splits the ink extent at valleys of at least max(10px, 1x region height)', () => {
    const h = 15
    const counts = new Array(100).fill(0)
    for (let x = 10; x < 40; x++) counts[x] = 5
    for (let x = 60; x < 90; x++) counts[x] = 5
    expect(inkSpans(counts, h)).toEqual([
      { start: 10, end: 40 },
      { start: 60, end: 90 }
    ])
  })

  it('does not split at a valley narrower than the region height', () => {
    const h = 15
    const counts = new Array(100).fill(0)
    for (let x = 10; x < 40; x++) counts[x] = 5
    for (let x = 52; x < 90; x++) counts[x] = 5 // 12px gap < 15
    expect(inkSpans(counts, h)).toEqual([{ start: 10, end: 90 }])
  })

  it('treats single stray ink pixels inside a valley as empty (noise tolerance)', () => {
    const h = 15
    const counts = new Array(100).fill(0)
    for (let x = 10; x < 40; x++) counts[x] = 5
    for (let x = 60; x < 90; x++) counts[x] = 5
    counts[50] = 1 // lone artifact pixel mid-valley
    expect(inkSpans(counts, h)).toEqual([
      { start: 10, end: 40 },
      { start: 60, end: 90 }
    ])
  })

  it('returns no spans for an all-empty profile', () => {
    expect(inkSpans(new Array(50).fill(0), 15)).toEqual([])
  })
})

describe('distributeTokens', () => {
  it('partitions tokens contiguously so group width shares track span width shares', () => {
    // "Media: D8 | Voltage: 3.2V" shape: widths 60,20 vs 80,40 against
    // spans 95,125 - the 2|2 partition is the clear width-share winner.
    expect(distributeTokens([60, 20, 80, 40], 10, [95, 125])).toEqual([2, 2])
  })

  it('returns null when there are fewer tokens than spans', () => {
    expect(distributeTokens([50], 10, [40, 40])).toBeNull()
  })

  it('returns null when the best partition still leaves a span wildly mismatched (OCR text does not describe this ink)', () => {
    // Two equal tokens over an 8px + 192px span pair: best case is a
    // 0.5-vs-0.04 share mismatch - distributing would paint into the wrong
    // cells, so no split.
    expect(distributeTokens([100, 100], 0, [8, 192])).toBeNull()
  })

  it('returns null when a span is a sliver whose share disagrees with its token by orders of magnitude (real image39 failure)', () => {
    // The real photo regression: "NEW COIL2 OLD COIL1" over spans
    // [151,1,2,141] - the 1px/2px spans are photo edge artifacts, not
    // cells. Absolute share differences all pass 0.45 (both shares are
    // small), so only a RATIO check catches a token claiming ~90x more
    // width than its span has ink.
    expect(distributeTokens([290, 330, 230, 290], 25, [151, 1, 2, 141])).toBeNull()
  })

  it('keeps a genuinely skinny single-glyph cell whose share agrees with its token (real image16 "D8"/"3.2" cells)', () => {
    // Real slide-6 Media row shape: label/value cells down to 18px wide -
    // token and span shares agree within ~1.2x, so the ratio guard must
    // not kill it.
    expect(distributeTokens([330, 140, 380, 150], 25, [44, 18, 52, 21])).toEqual([1, 1, 1, 1])
  })
})

// ---- E2E through the decorator: synthetic table-row PNGs + a fake inner
// engine (the real PP-OCR replay against the actual slide-6 image happens in
// scripts/tmp-replay-image8.ts before any GPU run - see the ledger).

async function rowPng(
  w: number,
  h: number,
  blobs: Array<[number, number]>,
  gridlines: number[] = []
): Promise<Buffer> {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#000000'
  for (const [x0, x1] of blobs) ctx.fillRect(x0, 3, x1 - x0, h - 6)
  for (const x of gridlines) ctx.fillRect(x, 0, 1, h)
  return canvas.toBuffer('png')
}

function rawRegion(
  overrides: Partial<TextRegion> & { bbox: TextRegion['bbox']; text: string }
): TextRegion {
  return { id: 'raw1', confidence: 0.9, ...overrides }
}

function fakeEngine(regions: TextRegion[]) {
  const detectRegions = vi.fn().mockResolvedValue(regions)
  return { engine: { detectRegions }, detectRegions }
}

describe('withCellSplit - splits a row-merged detection at true cell gutters', () => {
  it('splits two ink blobs separated by a full-height valley into two regions with the text distributed in order', async () => {
    const buffer = await rowPng(200, 20, [
      [10, 60],
      [140, 190]
    ])
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 20 }, text: 'AAA BBB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toHaveLength(2)
    expect(result.map((r) => r.text)).toEqual(['AAA', 'BBB'])
    // Sub-boxes hug their own ink spans (validateRegions dilates later) and
    // keep the parent's vertical geometry.
    expect(result[0].bbox.x).toBeGreaterThanOrEqual(9)
    expect(result[0].bbox.x + result[0].bbox.w).toBeLessThanOrEqual(61)
    expect(result[1].bbox.x).toBeGreaterThanOrEqual(139)
    expect(result[1].bbox.x + result[1].bbox.w).toBeLessThanOrEqual(191)
    for (const r of result) {
      expect(r.bbox.y).toBe(0)
      expect(r.bbox.h).toBe(20)
      expect(r.confidence).toBe(0.9)
    }
    expect(result[0].id).not.toBe(result[1].id)
  })

  it('erases a vertical gridline so the two half-valleys it bisects still merge into one qualifying gutter (the falsified-attempt killer)', async () => {
    // Left gap [88,100) and right gap [101,112) are each under the 20px
    // valley floor; only with the gridline column at x=100 erased does the
    // full [88,112) gutter qualify. This is the exact real-deck failure
    // ("Media: D8 Voltage:..." never split) the gridline erase exists for.
    const buffer = await rowPng(
      200,
      20,
      [
        [10, 88],
        [112, 190]
      ],
      [100]
    )
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 20 }, text: 'AAA BBB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toHaveLength(2)
    expect(result.map((r) => r.text)).toEqual(['AAA', 'BBB'])
    // The gridline lives in the gutter - neither painted box may cover it.
    expect(result[0].bbox.x + result[0].bbox.w).toBeLessThanOrEqual(100)
    expect(result[1].bbox.x).toBeGreaterThan(100)
  })

  it('splits a four-cell row and distributes all four tokens in order (the motivating slide-6 shape)', async () => {
    // Blob widths proportional to the measured token widths of
    // "Media: D8 Voltage: 3.2V" so the 1|1|1|1 partition is the clear
    // winner - the full pixel path (profile, valleys, mapping, token-index
    // accumulation across three boundaries) in one E2E.
    const buffer = await rowPng(320, 20, [
      [10, 70],
      [100, 126],
      [156, 234],
      [264, 304]
    ])
    const region = rawRegion({
      bbox: { x: 0, y: 0, w: 320, h: 20 },
      text: 'Media: D8 Voltage: 3.2V'
    })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result.map((r) => r.text)).toEqual(['Media:', 'D8', 'Voltage:', '3.2V'])
    expect(result.map((r) => r.id)).toEqual(['raw1c1', 'raw1c2', 'raw1c3', 'raw1c4'])
    for (let i = 1; i < result.length; i++) {
      expect(result[i].bbox.x).toBeGreaterThan(result[i - 1].bbox.x + result[i - 1].bbox.w)
    }
  })

  it('lets validateRegions drop a sub-8px split cell (noise floor) while its siblings survive - pixels stay, text never lands elsewhere', async () => {
    // A 6px-wide "J" cell between two wide cells: its sub-region dies at
    // regions.ts's NOISE_FLOOR_PX (and would die the content gate too),
    // exactly as PP-OCR's own separate single-glyph detections already do -
    // the original pixels stay put, and crucially the J's text is NOT
    // folded into a neighboring cell.
    const buffer = await rowPng(200, 20, [
      [10, 60],
      [100, 106],
      [140, 190]
    ])
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 20 }, text: 'AAA J BBB' })
    const { engine } = fakeEngine([region])

    const raw = await withCellSplit(engine).detectRegions(buffer)
    const validated = validateRegions(raw, 200, 20)

    expect(raw.map((r) => r.text)).toEqual(['AAA', 'J', 'BBB'])
    expect(validated.map((r) => r.text)).toEqual(['AAA', 'BBB'])
  })

  it('maps spans back into image coordinates for a region not at the origin', async () => {
    const canvas = createCanvas(300, 100)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 300, 100)
    ctx.fillStyle = '#000000'
    ctx.fillRect(60, 43, 50, 14) // blob 1 inside bbox {50,40,200,20}
    ctx.fillRect(190, 43, 50, 14) // blob 2
    const buffer = await canvas.toBuffer('png')
    const region = rawRegion({ bbox: { x: 50, y: 40, w: 200, h: 20 }, text: 'AAA BBB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toHaveLength(2)
    expect(result[0].bbox.x).toBeGreaterThanOrEqual(59)
    expect(result[0].bbox.x + result[0].bbox.w).toBeLessThanOrEqual(111)
    expect(result[1].bbox.x).toBeGreaterThanOrEqual(189)
    expect(result[1].bbox.x + result[1].bbox.w).toBeLessThanOrEqual(241)
    for (const r of result) {
      expect(r.bbox.y).toBe(40)
      expect(r.bbox.h).toBe(20)
    }
  })
})

describe('withCellSplit - refuses to split when the evidence does not support it', () => {
  it('leaves a region alone when the valley is narrower than the region height', async () => {
    const buffer = await rowPng(200, 20, [
      [10, 60],
      [75, 190] // 15px gap < 20px height
    ])
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 20 }, text: 'AAA BBB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([region])
  })

  it('leaves a region alone when its text has fewer tokens than there are ink spans', async () => {
    const buffer = await rowPng(200, 20, [
      [10, 60],
      [140, 190]
    ])
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 20 }, text: 'AAA' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([region])
  })

  it('leaves a region alone when token order cannot match the ink layout (wide token over a narrow span)', async () => {
    // OCR order says the SHORT token comes first, but the FIRST ink span is
    // the wide one - the width-share guard must refuse rather than paint
    // tokens into the wrong cells.
    const buffer = await rowPng(220, 20, [
      [10, 150],
      [170, 195]
    ])
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 220, h: 20 }, text: 'Hi VeryLongTokenHere' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([region])
  })

  it('leaves a region alone when the profile finds sliver spans no token can plausibly own (photo edge artifacts)', async () => {
    // Photo-shaped failure from the real deck's image39: real text blobs at
    // the ends plus two partial-height 1-2px edge artifacts in the middle
    // (partial height so the gridline erase correctly leaves them alone).
    const canvas = createCanvas(700, 45)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 700, 45)
    ctx.fillStyle = '#000000'
    ctx.fillRect(10, 3, 150, 39)
    ctx.fillRect(300, 8, 1, 30)
    ctx.fillRect(400, 8, 2, 30)
    ctx.fillRect(500, 3, 140, 39)
    const buffer = await canvas.toBuffer('png')
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 700, h: 45 }, text: 'NEW COIL2 OLD COIL1' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([region])
  })

  it('never erases when a token is all narrow strokes - a "1" glyph is per-column indistinguishable from a gridline (review finding)', async () => {
    // "AAA 1 BBB": the lone "1" is a full-height 2px stem with sub-valley
    // gaps on both sides. Erasing it as a "gridline" would merge the gaps
    // into one qualifying valley, fold the 1 into a neighboring cell's
    // group (which passes both share guards), and paint it into the wrong
    // cell. The narrow-stroke-token veto must refuse erasure entirely, and
    // with the stem standing no valley qualifies - region unchanged.
    const canvas = createCanvas(200, 20)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 20)
    ctx.fillStyle = '#000000'
    ctx.fillRect(10, 3, 78, 14)
    ctx.fillRect(100, 0, 2, 20) // the "1" stem - full height, tight box
    ctx.fillRect(113, 3, 77, 14)
    const buffer = await canvas.toBuffer('png')
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 20 }, text: 'AAA 1 BBB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([region])
  })

  it('never touches rotated regions (known-angle or flagged)', async () => {
    const buffer = await rowPng(200, 20, [
      [10, 60],
      [140, 190]
    ])
    const angled = rawRegion({
      bbox: { x: 0, y: 0, w: 200, h: 20 },
      text: 'AAA BBB',
      rotation: -90
    })
    const flagged = rawRegion({
      id: 'raw2',
      bbox: { x: 0, y: 0, w: 200, h: 20 },
      text: 'CCC DDD',
      rotated: true
    })
    const { engine } = fakeEngine([angled, flagged])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([angled, flagged])
  })

  it('skips near-square regions without any pixel analysis (aspect guard)', async () => {
    const buffer = await rowPng(200, 20, [[10, 60]])
    const region = rawRegion({ bbox: { x: 10, y: 0, w: 30, h: 20 }, text: 'AA BB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([region])
  })
})
