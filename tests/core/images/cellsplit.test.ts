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
  it('zeroes a full-height column touching both edge bands (marking it erased) and keeps a glyph stem that touches only one', () => {
    const h = 20
    const cols = [
      { ink: 0, top: false, bottom: false },
      { ink: 20, top: true, bottom: true }, // vertical table gridline
      { ink: 15, top: true, bottom: false }, // ascender stem - never reaches the bottom band
      { ink: 18, top: true, bottom: true } // gridline with antialiasing nicks
    ]
    expect(eraseGridlineColumns(cols, h)).toEqual({
      counts: [0, 0, 15, 0],
      erased: [false, true, false, true]
    })
  })

  it('keeps a near-full column that does not reach both edge bands (tall glyph, not a gridline)', () => {
    const cols = [{ ink: 19, top: false, bottom: true }]
    expect(eraseGridlineColumns(cols, 20).counts).toEqual([19])
  })

  it('erases only NARROW full-height runs - a wide solid band is content (filled header, bar), not a line', () => {
    const gridCol = { ink: 20, top: true, bottom: true }
    const blank = { ink: 0, top: false, bottom: false }
    // 3-wide full-height run: an antialiased gridline - erased.
    expect(eraseGridlineColumns([blank, gridCol, gridCol, gridCol, blank], 20).counts).toEqual([
      0, 0, 0, 0, 0
    ])
    // 6-wide full-height run: a solid filled band - kept as ink.
    expect(
      eraseGridlineColumns([blank, gridCol, gridCol, gridCol, gridCol, gridCol, gridCol, blank], 20)
        .counts
    ).toEqual([0, 20, 20, 20, 20, 20, 20, 0])
  })
})

describe('inkSpans', () => {
  it('splits at a gridline-free valley only when it is at least max(14px, 2x region height) - word gaps never qualify', () => {
    // Word gaps run ~0.25em and cell padding ~1em; a gridline-FREE gutter
    // must be table-scale (2 line heights) to count. Real failure: at 6px
    // tiny text the old 1x-height rule let word gaps split "Date and Time"
    // into cells.
    const h = 15
    const counts = new Array(120).fill(0)
    for (let x = 10; x < 40; x++) counts[x] = 5
    for (let x = 60; x < 90; x++) counts[x] = 5 // 20px gap < 2x15
    expect(inkSpans(counts, h)).toEqual([{ start: 10, end: 90 }])

    const wide = new Array(120).fill(0)
    for (let x = 10; x < 40; x++) wide[x] = 5
    for (let x = 72; x < 110; x++) wide[x] = 5 // 32px gap >= 30
    expect(inkSpans(wide, h)).toEqual([
      { start: 10, end: 40 },
      { start: 72, end: 110 }
    ])
  })

  it('splits at a much narrower valley when it contains an erased GRIDLINE - the drawn table structure is the primary cell signal', () => {
    const h = 15
    const counts = new Array(100).fill(0)
    for (let x = 10; x < 40; x++) counts[x] = 5
    for (let x = 52; x < 90; x++) counts[x] = 5 // 12px gap - far under 2h
    const erased = new Array(100).fill(false)
    erased[46] = true // the gridline that was erased mid-gutter
    expect(inkSpans(counts, h, erased)).toEqual([
      { start: 10, end: 40 },
      { start: 52, end: 90 }
    ])
  })

  it('treats single stray ink pixels inside a valley as empty (noise tolerance)', () => {
    const h = 15
    const counts = new Array(120).fill(0)
    for (let x = 10; x < 40; x++) counts[x] = 5
    for (let x = 75; x < 110; x++) counts[x] = 5
    counts[55] = 1 // lone artifact pixel mid-valley
    expect(inkSpans(counts, h)).toEqual([
      { start: 10, end: 40 },
      { start: 75, end: 110 }
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
    // Sub-boxes hug their own ink spans horizontally while KEEPING the
    // loose vertical extent for fill coverage; the measured band (blob ink
    // rows 3..17) goes to inkBBox, the size authority.
    expect(result[0].bbox.x).toBeGreaterThanOrEqual(9)
    expect(result[0].bbox.x + result[0].bbox.w).toBeLessThanOrEqual(61)
    expect(result[1].bbox.x).toBeGreaterThanOrEqual(139)
    expect(result[1].bbox.x + result[1].bbox.w).toBeLessThanOrEqual(191)
    for (const r of result) {
      expect(r.bbox.y).toBe(0)
      expect(r.bbox.h).toBe(20)
      expect(r.inkBBox?.y).toBe(3)
      expect(r.inkBBox?.h).toBe(14)
      expect(r.confidence).toBe(0.9)
    }
    expect(result[0].id).not.toBe(result[1].id)
  })

  it('tightens an inflated detection box to its single ink row-band (the real oversized-paint defect)', async () => {
    // A 124x25-style detection whose actual text line is only 12px tall
    // painted ~2x oversized on the real slide. The tightened bbox becomes
    // the ink authority downstream (validateRegions snapshots inkBBox from
    // it), so paint sizes track the REAL glyph height.
    const canvas = createCanvas(200, 40)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 40)
    ctx.fillStyle = '#000000'
    ctx.fillRect(10, 14, 180, 12) // single 12px text band inside a 40px box
    const buf = await canvas.toBuffer('png')
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 40 }, text: 'AAAA BBBB CCCC' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buf)

    expect(result).toHaveLength(1)
    expect(result[0].bbox).toEqual({ x: 0, y: 0, w: 200, h: 40 }) // fill keeps the loose box
    expect(result[0].inkBBox).toEqual({ x: 0, y: 14, w: 200, h: 12 }) // size takes the band
    expect(result[0].text).toBe('AAAA BBBB CCCC')
  })

  it('finds the TRUE glyph band beyond a clipping detector box and grows the fill box to cover it', async () => {
    // Real slide-6 failure: PP-OCR boxed the step rows at 9px around 13px
    // glyphs, offset downward - the fill left the glyph TOPS uncovered
    // (visible English ghost slices above every repaint) and the clipped
    // band undersized every paint. The band search must extend past the
    // box: inkBBox gets the full glyph extent, bbox grows to cover it.
    const canvas = createCanvas(300, 40)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 300, 40)
    ctx.fillStyle = '#000000'
    ctx.fillRect(10, 8, 280, 16) // glyph ink rows 8..24
    const buf = await canvas.toBuffer('png')
    const region = rawRegion({ bbox: { x: 5, y: 12, w: 290, h: 8 }, text: 'AAAA BBBB' }) // clips top AND bottom
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buf)

    expect(result).toHaveLength(1)
    expect(result[0].inkBBox?.y).toBe(8)
    expect(result[0].inkBBox?.h).toBe(16)
    expect(result[0].bbox.y).toBeLessThanOrEqual(8)
    expect(result[0].bbox.y + result[0].bbox.h).toBeGreaterThanOrEqual(24)
  })

  it('leaves a two-line (multi-band) detection box vertically untouched', async () => {
    const canvas = createCanvas(200, 44)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 44)
    ctx.fillStyle = '#000000'
    ctx.fillRect(10, 6, 180, 12) // line 1
    ctx.fillRect(10, 26, 180, 12) // line 2 - 8px line gap
    const buf = await canvas.toBuffer('png')
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 44 }, text: 'AAAA BBBB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buf)

    expect(result).toEqual([region])
  })

  it('erases a narrow full-width horizontal border line before finding the ink band', async () => {
    const canvas = createCanvas(200, 40)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 40)
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 200, 2) // table border along the box top
    ctx.fillRect(10, 20, 180, 12) // the actual text band
    const buf = await canvas.toBuffer('png')
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 40 }, text: 'AAAA BBBB CCCC' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buf)

    expect(result).toHaveLength(1)
    expect(result[0].inkBBox?.y).toBe(20)
    expect(result[0].inkBBox?.h).toBe(12)
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

  it('gives each split cell its OWN vertical ink band, so a descender cell and a caps cell each recover their true glyph extent', async () => {
    // Real slide-6 failure: sub-cells inheriting the parent ROW's band
    // recovered wildly different em sizes because each cell's glyph mix
    // (descenders vs none) was measured against the union band. Two blobs
    // at different vertical extents must come back with their own bands.
    const canvas = createCanvas(220, 24)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 220, 24)
    ctx.fillStyle = '#000000'
    ctx.fillRect(10, 4, 60, 12) // cell 1 ink rows 4..16
    ctx.fillRect(140, 8, 70, 12) // cell 2 ink rows 8..20
    const buf = await canvas.toBuffer('png')
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 220, h: 24 }, text: 'AAA BBB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buf)

    expect(result).toHaveLength(2)
    expect(result[0].inkBBox?.y).toBe(4)
    expect(result[0].inkBBox?.h).toBe(12)
    expect(result[1].inkBBox?.y).toBe(8)
    expect(result[1].inkBBox?.h).toBe(12)
  })

  it("computes each cell's band from the LOOSE vertical extent, so a parent-level row clip cannot eat a cell's glyph tips", async () => {
    // Real slide-6 failure: cells sit at different heights, so one cell's
    // top rows are sparse at ROW level (only its own narrow tips ink those
    // rows) and fall under the wide parent crop's row noise floor - the
    // parent tighten clipped them, and per-cell banding inside the clipped
    // crop could never get them back. Cell A: narrow tips rows 2-4 above a
    // wide body rows 5-14; its band must still start at row 2.
    const canvas = createCanvas(600, 30)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 600, 30)
    ctx.fillStyle = '#000000'
    ctx.fillRect(20, 2, 6, 3) // cell A cap tips (sparse at row level: 6px <= the 600px row's floor)
    ctx.fillRect(10, 5, 40, 10) // cell A body
    ctx.fillRect(300, 10, 200, 12) // cell B
    const buf = await canvas.toBuffer('png')
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 600, h: 30 }, text: 'AAA BBB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buf)

    expect(result).toHaveLength(2)
    expect(result[0].inkBBox?.y).toBe(2)
    expect(result[0].inkBBox?.h).toBe(13)
    expect(result[1].inkBBox?.y).toBe(10)
    expect(result[1].inkBBox?.h).toBe(12)
  })

  it('tightens to the DOMINANT band when a second band is minor neighbor-line bleed, but leaves balanced two-line boxes alone', async () => {
    // Real slide-6 failure: a "Storage" detection whose box caught a 2px
    // sliver of the next line's glyph tops - the sliver made banding bail
    // and the word painted at the full 20px box height (~2x too big).
    const canvas = createCanvas(120, 22)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 120, 22)
    ctx.fillStyle = '#000000'
    ctx.fillRect(10, 3, 100, 10) // the word itself
    ctx.fillRect(10, 19, 100, 2) // neighbor line's glyph tops caught by the box
    const buf = await canvas.toBuffer('png')
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 120, h: 22 }, text: 'Storage Xy' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buf)

    expect(result).toHaveLength(1)
    expect(result[0].inkBBox?.y).toBe(3)
    expect(result[0].inkBBox?.h).toBe(10)
    expect(result[0].bbox).toEqual({ x: 0, y: 0, w: 120, h: 22 })
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
      expect(r.inkBBox?.y).toBe(43)
      expect(r.inkBBox?.h).toBe(14)
    }
  })
})

describe('withCellSplit - refuses to split when the evidence does not support it', () => {
  it('does not split when the valley is narrower than the region height (only the vertical tighten applies)', async () => {
    const buffer = await rowPng(200, 20, [
      [10, 60],
      [72, 190] // 12px gap < the TIGHTENED 14px line height
    ])
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 20 }, text: 'AAA BBB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([{ ...region, inkBBox: { x: 0, y: 3, w: 200, h: 14 } }])
  })

  it('does not split when its text has fewer tokens than there are ink spans (only the vertical tighten applies)', async () => {
    const buffer = await rowPng(200, 20, [
      [10, 60],
      [140, 190]
    ])
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 20 }, text: 'AAA' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([{ ...region, inkBBox: { x: 0, y: 3, w: 200, h: 14 } }])
  })

  it('DROPS a region whose ink proves 3+ cells but whose text cannot cover them (the real slide-6 whole-row smear)', async () => {
    // The real deck's step-3 monster: PP-OCR stretched one detection across
    // the whole table (ink in many cells) while reading only one cell's
    // sentence. Painting the concatenated translation across every cell is
    // the worst possible outcome under the only-original-space constraint -
    // with multi-cell evidence AND an impossible distribution, nothing
    // paints and every cell's original pixels stay.
    const buffer = await rowPng(320, 20, [
      [10, 80],
      [120, 190],
      [230, 300]
    ])
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 320, h: 20 }, text: 'AAA BBB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([])
  })

  it('still REFUSES (keeps painting) on a 2-span mismatch - only 3+ substantial spans justify dropping', async () => {
    // OCR order says the SHORT token comes first, but the FIRST ink span is
    // the wide one - the width-share guard must refuse rather than paint
    // tokens into the wrong cells. And with only 2 spans of cell evidence
    // the region keeps painting as one block (see the photo-label tests) -
    // just vertically tightened.
    const buffer = await rowPng(220, 20, [
      [10, 150],
      [170, 195]
    ])
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 220, h: 20 }, text: 'Hi VeryLongTokenHere' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([{ ...region, inkBBox: { x: 0, y: 3, w: 220, h: 14 } }])
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

    // Only 2 substantial spans (the slivers don't count), so no drop and no
    // split - the region survives with just the vertical tighten applied.
    expect(result).toEqual([{ ...region, inkBBox: { x: 0, y: 3, w: 700, h: 39 } }])
  })

  it('never mistakes a glyph STEM for a gridline after tightening - candidacy is judged against the LOOSE box height', async () => {
    // Real slide-6 failure: once the crop is tightened to the ink band,
    // every letter stem spans "full height touching both bands" and got
    // erased as a gridline, marking word gaps as ruled cell boundaries -
    // "Step 2: Move Samples to room temperature for 2" split at its word
    // gaps. A stem only spans the BAND; a true gridline spans the LOOSE
    // detector box. This stem sits mid-gap between two words (11px gap,
    // far under the gridline-free 2x-height threshold).
    const canvas = createCanvas(200, 20)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 20)
    ctx.fillStyle = '#000000'
    ctx.fillRect(10, 6, 78, 10) // word 1, band rows 6..16
    ctx.fillRect(99, 6, 2, 10) // a stem-like full-BAND stroke in the gap
    ctx.fillRect(112, 6, 78, 10) // word 2
    const buf = await canvas.toBuffer('png')
    const region = rawRegion({ bbox: { x: 0, y: 0, w: 200, h: 20 }, text: 'AAA BBB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buf)

    expect(result).toEqual([{ ...region, inkBBox: { x: 0, y: 6, w: 200, h: 10 } }])
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

    // No split (the vetoed stem blocks the valley) - only the vertical
    // tighten applies (the stem-only rows are under the row noise floor).
    expect(result).toEqual([{ ...region, inkBBox: { x: 0, y: 3, w: 200, h: 14 } }])
  })

  it('DROPS a region whose text physically cannot fit its box at the band height (recognition hallucination)', async () => {
    // Real slide-6 failure: PP-OCR emitted 17px-wide boxes over fraction
    // cells whose "text" was a 6-character word from a different cell
    // ("Upside" at 0.99 confidence). Painting or merging them scatters
    // words across the table; a box less than half as wide as its own text
    // is not a real reading.
    const buffer = await rowPng(200, 20, [[100, 114]])
    const region = rawRegion({ bbox: { x: 98, y: 0, w: 18, h: 20 }, text: 'Upside' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([])
  })

  it('keeps a snug short reading whose text does fit its box ("0/2"-style cells)', async () => {
    const buffer = await rowPng(200, 20, [[100, 114]])
    const region = rawRegion({ bbox: { x: 98, y: 0, w: 18, h: 20 }, text: '0/2' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('0/2')
  })

  it('resolves two detections that tighten onto the SAME ink to the higher-confidence reading (detector double-vote)', async () => {
    // Real slide-6 failure: a phantom box over a fraction cell ("for",
    // conf 0.99) tightened onto the cell's actual ink - converging on the
    // same band as the true reading ("1/2", conf 1.0) - and the two then
    // merged into "for 1/2". Same spot, conflicting text: the higher
    // confidence wins, mirroring rotation.ts's established dedup policy.
    const canvas = createCanvas(200, 30)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 30)
    ctx.fillStyle = '#000000'
    ctx.fillRect(100, 8, 30, 12) // the cell's actual ink, rows 8..20
    const buffer = await canvas.toBuffer('png')
    const phantom = rawRegion({
      bbox: { x: 98, y: 0, w: 34, h: 18 },
      text: 'for',
      confidence: 0.97
    })
    const real = rawRegion({
      id: 'raw2',
      bbox: { x: 98, y: 8, w: 34, h: 22 },
      text: '1/2',
      confidence: 0.99
    })
    const { engine } = fakeEngine([phantom, real])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('1/2')
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

  it('never SPLITS a near-square region (aspect guard) though the vertical tighten still applies', async () => {
    const buffer = await rowPng(200, 20, [[10, 60]])
    const region = rawRegion({ bbox: { x: 10, y: 0, w: 30, h: 20 }, text: 'AA BB' })
    const { engine } = fakeEngine([region])

    const result = await withCellSplit(engine).detectRegions(buffer)

    expect(result).toEqual([{ ...region, inkBBox: { x: 10, y: 3, w: 30, h: 14 } }])
  })
})
