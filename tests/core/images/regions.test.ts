import { describe, expect, it } from 'vitest'
import {
  CONFIDENCE_FLOOR,
  DILATION_PX,
  validateRegions,
  type TextRegion
} from '../../../src/core/images/regions'

function region(
  overrides: Partial<TextRegion> & { bbox: TextRegion['bbox']; text: string }
): TextRegion {
  return {
    id: 'raw',
    confidence: 0.9,
    ...overrides
  }
}

describe('CONFIDENCE_FLOOR', () => {
  it('is 0.6', () => {
    expect(CONFIDENCE_FLOOR).toBe(0.6)
  })
})

describe('validateRegions - clamping and degenerate drops (plan point 1)', () => {
  it('clamps a partially out-of-bounds region to image bounds and drops a fully out-of-bounds region', () => {
    const imgW = 100
    const imgH = 100
    // Dilated by DILATION_PX (2) before clamp: {x:-5,y:10,w:20,h:20} -> {x:-7,y:8,w:24,h:24}.
    // Clamp: x=max(0,-7)=0, x2=min(100,-7+24=17)=17 -> w=17; y=8, y2=min(100,8+24=32)=32 -> h=24.
    const partiallyOutside = region({ bbox: { x: -5, y: 10, w: 20, h: 20 }, text: 'Hello' })
    // Dilated: {x:-52,y:-52,w:14,h:14} -> x2=-38,y2=-38, both still negative -> clamp yields
    // negative width/height -> dropped entirely.
    const fullyOutside = region({ bbox: { x: -50, y: -50, w: 10, h: 10 }, text: 'Gone' })

    const result = validateRegions([partiallyOutside, fullyOutside], imgW, imgH)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Hello')
    expect(result[0].bbox).toEqual({ x: 0, y: 8, w: 17, h: 24 })
  })

  it('drops a region with a raw zero-area bbox', () => {
    const zeroArea = region({ bbox: { x: 10, y: 10, w: 0, h: 20 }, text: 'NoWidth' })
    const negativeArea = region({ bbox: { x: 10, y: 50, w: 20, h: -5 }, text: 'NegHeight' })

    expect(validateRegions([zeroArea, negativeArea], 500, 500)).toEqual([])
  })
})

describe('validateRegions - noise floor (plan point 2)', () => {
  it('drops regions under 8px wide or 4px tall, keeps small-but-real text at the floors', () => {
    // The height floor sits BELOW the width floor since cellsplit's
    // vertical tighten emits honest 4-6px ink bands for genuinely tiny
    // text ("hours" measured 40x5 on the real slide-6 table) - an 8px
    // height floor executed real cells. Width keeps the original 8px:
    // nothing readable is under 8px wide, and the tighten never narrows
    // boxes horizontally below their ink spans.
    const tooNarrow = region({ bbox: { x: 10, y: 10, w: 5, h: 20 }, text: 'TooNarrow' })
    const tooShort = region({ bbox: { x: 10, y: 50, w: 20, h: 3 }, text: 'TooShort' })
    const tinyReal = region({ bbox: { x: 10, y: 120, w: 40, h: 5 }, text: 'hours' })
    const atFloor = region({ bbox: { x: 10, y: 80, w: 8, h: 8 }, text: 'AtFloor' })

    const result = validateRegions([tooNarrow, tooShort, tinyReal, atFloor], 200, 200)

    expect(result).toHaveLength(2)
    expect(result.map((r) => r.text)).toEqual(['AtFloor', 'hours'])
    // atFloor {x:10,y:80,w:8,h:8} dilated by 2 -> {x:8,y:78,w:12,h:12}; well within
    // the 200x200 bounds so clamp is a no-op.
    expect(result[0].bbox).toEqual({ x: 8, y: 78, w: 12, h: 12 })
  })
})

describe('validateRegions - merge (plan point 3)', () => {
  it('merges two regions whose IoU exceeds 0.5 into their union, joining text in reading order and keeping the min confidence', () => {
    const left = region({ bbox: { x: 100, y: 100, w: 100, h: 20 }, text: 'Left', confidence: 0.9 })
    const right = region({
      bbox: { x: 120, y: 100, w: 100, h: 20 },
      text: 'Right',
      confidence: 0.7
    })
    // IoU check: intersection x=[120,200] -> width 80, height 20 -> inter=1600.
    // union = 2000+2000-1600=2400, iou=1600/2400=0.667 > 0.5.

    const result = validateRegions([left, right], 1000, 1000)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Left Right')
    expect(result[0].confidence).toBe(0.7)
    // union bbox {x:100,y:100,w:120,h:20} dilated by 2 -> {x:98,y:98,w:124,h:24};
    // 1000x1000 bounds mean clamp is a no-op.
    expect(result[0].bbox).toEqual({ x: 98, y: 98, w: 124, h: 24 })
  })

  it('merges two regions when one contains at least 80% of the other, even at low IoU', () => {
    const big = region({ bbox: { x: 100, y: 100, w: 200, h: 200 }, text: 'Big', confidence: 0.8 })
    const small = region({
      bbox: { x: 150, y: 150, w: 50, h: 50 },
      text: 'Small',
      confidence: 0.95
    })
    // small is fully inside big: containment fraction = 1.0 >= 0.8, though IoU
    // (2500 / 40000 = 0.0625) alone would never trigger a merge.

    const result = validateRegions([big, small], 1000, 1000)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Big Small')
    expect(result[0].confidence).toBe(0.8)
    // union of big+small is just big's bbox (small is fully inside it), dilated by 2.
    expect(result[0].bbox).toEqual({ x: 98, y: 98, w: 204, h: 204 })
  })

  it('does not merge two regions with low IoU and no containment', () => {
    // Text is 2 letters each (not the single-char 'A'/'B' it's tempting to
    // reach for here): the content gate below drops anything under 2
    // non-punctuation characters regardless of merge behavior, so a
    // single-letter fixture would fail this test for the wrong reason.
    const a = region({ bbox: { x: 0, y: 0, w: 50, h: 50 }, text: 'AA' })
    const b = region({ bbox: { x: 500, y: 500, w: 50, h: 50 }, text: 'BB' })

    const result = validateRegions([a, b], 1000, 1000)

    expect(result).toHaveLength(2)
    expect(result.map((r) => r.text).sort()).toEqual(['AA', 'BB'])
  })

  it('merges a chain of three mutually-triggering regions into one, not two separate pairs', () => {
    // A-B overlap enough to merge (IoU 0.667, same ratio as the two-region
    // case above), and the resulting union then also overlaps C enough to
    // merge again (IoU 0.571) - a single pairwise merge pass would stop
    // after A+B and leave C unmerged; validateRegions must run merge to a
    // fixpoint.
    const regionA = region({ bbox: { x: 0, y: 0, w: 100, h: 20 }, text: 'Alpha' })
    const regionB = region({ bbox: { x: 20, y: 0, w: 100, h: 20 }, text: 'Beta' })
    const regionC = region({ bbox: { x: 40, y: 0, w: 100, h: 20 }, text: 'Gamma' })

    const result = validateRegions([regionA, regionB, regionC], 1000, 1000)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Alpha Beta Gamma')
  })
})

describe('validateRegions - reading order sort (plan point 4)', () => {
  it('sorts by y-band (overlapping vertical extents) first, then by x within a band', () => {
    // A and C share a vertical band (both y:[10,30]); B is a separate lower band.
    const thirdOnSameBand = region({
      bbox: { x: 300, y: 10, w: 50, h: 20 },
      text: 'ThirdOnSameBand'
    })
    const firstBandLeft = region({ bbox: { x: 10, y: 10, w: 50, h: 20 }, text: 'FirstBandLeft' })
    const secondBandRow = region({ bbox: { x: 10, y: 200, w: 50, h: 20 }, text: 'SecondBandRow' })

    const result = validateRegions([thirdOnSameBand, firstBandLeft, secondBandRow], 1000, 1000)

    expect(result.map((r) => r.text)).toEqual(['FirstBandLeft', 'ThirdOnSameBand', 'SecondBandRow'])
  })

  it('keeps tightly-spaced rows in top-to-bottom order: dilation must not chain separate rows into one band', () => {
    // Three visually distinct rows whose raw vertical gaps (3px) are smaller
    // than what dilation closes (2 * DILATION_PX = 4px). Sorting on dilated
    // geometry would chain all three into a single band via the sweep's
    // running max and return them x-sorted: ['Aa', 'Mm', 'Zz'] - the exact
    // reverse of reading order. The ladder sorts BEFORE dilation, so row
    // order must survive.
    const topRight = region({ bbox: { x: 200, y: 0, w: 40, h: 20 }, text: 'Zz' })
    const middle = region({ bbox: { x: 100, y: 23, w: 40, h: 20 }, text: 'Mm' })
    const bottomLeft = region({ bbox: { x: 0, y: 46, w: 40, h: 20 }, text: 'Aa' })

    const result = validateRegions([topRight, middle, bottomLeft], 1000, 1000)

    expect(result.map((r) => r.text)).toEqual(['Zz', 'Mm', 'Aa'])
  })
})

describe('validateRegions - id assignment (plan point 5)', () => {
  it('assigns dense, stable ids r1..rN after validation regardless of raw ids', () => {
    const first = region({ id: 'zzz', bbox: { x: 10, y: 10, w: 50, h: 20 }, text: 'First' })
    const dropped = region({ id: 'zzz', bbox: { x: 10, y: 200, w: 50, h: 20 }, text: '   ' })
    const second = region({ id: 'q', bbox: { x: 10, y: 400, w: 50, h: 20 }, text: 'Second' })

    const result = validateRegions([first, dropped, second], 1000, 1000)

    expect(result.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(result.map((r) => r.text)).toEqual(['First', 'Second'])
  })
})

describe('validateRegions - trim and empty drop (plan point 6)', () => {
  it('trims region text and drops regions that are empty after trimming', () => {
    const padded = region({ bbox: { x: 10, y: 10, w: 50, h: 20 }, text: '  Hello  ' })
    const blank = region({ bbox: { x: 10, y: 200, w: 50, h: 20 }, text: '   ' })
    const empty = region({ bbox: { x: 10, y: 400, w: 50, h: 20 }, text: '' })

    const result = validateRegions([padded, blank, empty], 1000, 1000)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Hello')
  })
})

describe('validateRegions - content gate (decision doc: hallucination guard)', () => {
  it('drops regions with fewer than 2 non-punctuation characters', () => {
    const atSign = region({ bbox: { x: 0, y: 0, w: 50, h: 20 }, text: '@', confidence: 0.89 })
    const dots = region({ bbox: { x: 100, y: 0, w: 50, h: 20 }, text: '..' })
    const singleLetter = region({ bbox: { x: 200, y: 0, w: 50, h: 20 }, text: 'A' })
    const letterPlusPunct = region({ bbox: { x: 300, y: 0, w: 50, h: 20 }, text: 'A!' })
    const twoLetters = region({ bbox: { x: 400, y: 0, w: 50, h: 20 }, text: 'AB' })
    const twoDigits = region({ bbox: { x: 500, y: 0, w: 50, h: 20 }, text: '42' })

    const result = validateRegions(
      [atSign, dots, singleLetter, letterPlusPunct, twoLetters, twoDigits],
      1000,
      1000
    )

    expect(result.map((r) => r.text).sort()).toEqual(['42', 'AB'])
  })
})

describe('validateRegions - dilation after merge, before clamp (decision doc: known PP-OCR limitation #2)', () => {
  it('dilates every surviving bbox by DILATION_PX before the final clamp, so an edge-flush box grows only where bounds allow', () => {
    expect(DILATION_PX).toBeGreaterThanOrEqual(1)
    expect(DILATION_PX).toBeLessThanOrEqual(2)

    const flushLeft = region({ bbox: { x: 0, y: 20, w: 30, h: 30 }, text: 'FlushLeft' })

    const result = validateRegions([flushLeft], 200, 200)

    expect(result).toHaveLength(1)
    // Dilate: {x:-2,y:18,w:34,h:34}. Clamp: x=max(0,-2)=0, x2=min(200,32)=32 -> w=32
    // (clipped, proving dilate ran BEFORE clamp - clamping first would have left x=0
    // and a later dilate would have produced an invalid negative x=-2).
    // y=18,y2=min(200,52)=52 -> h=34 (untouched by clamp, proving the full 2px-per-side
    // growth actually happened).
    expect(result[0].bbox).toEqual({ x: 0, y: 18, w: 32, h: 34 })
  })
})

describe('validateRegions - inkBBox (pre-dilation size authority, polish round Task C)', () => {
  it('populates inkBBox with the raw (pre-dilation) bbox on a solo surviving region, distinct from the dilated bbox', () => {
    const solo = region({ bbox: { x: 10, y: 20, w: 60, h: 8 }, text: 'Legend' })

    const result = validateRegions([solo], 500, 500)

    expect(result).toHaveLength(1)
    // Raw bbox, untouched by DILATION_PX.
    expect(result[0].inkBBox).toEqual({ x: 10, y: 20, w: 60, h: 8 })
    // The paint/fill bbox IS dilated - the two must differ, or this whole
    // feature is a no-op.
    expect(result[0].bbox).toEqual({ x: 8, y: 18, w: 64, h: 12 })
    expect(result[0].inkBBox).not.toEqual(result[0].bbox)
  })

  it('merge case: inkBBox is the union of RAW geometry, not the dilated union', () => {
    const left = region({ bbox: { x: 100, y: 100, w: 100, h: 20 }, text: 'Left' })
    const right = region({ bbox: { x: 120, y: 100, w: 100, h: 20 }, text: 'Right' })
    // Same IoU-triggering pair as the "merges two regions" test above
    // (iou 0.667 > 0.5): union of raw geometry is {x:100,y:100,w:120,h:20}.

    const result = validateRegions([left, right], 1000, 1000)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Left Right')
    // Pre-dilation union - NOT {x:98,y:98,w:124,h:24} (that's the dilated
    // bbox, asserted separately below; reusing it here would defeat the
    // point of a separate ink authority).
    expect(result[0].inkBBox).toEqual({ x: 100, y: 100, w: 120, h: 20 })
    expect(result[0].bbox).toEqual({ x: 98, y: 98, w: 124, h: 24 })
  })

  it('compatibility: raw regions built without an inkBBox field (the normal engine-output shape - see the `region()` helper above, which never sets one) still produce a correctly-populated inkBBox on output; validateRegions never requires callers to supply one', () => {
    // Every fixture in this entire file is built via `region()`, which never
    // sets inkBBox - this test just makes that implicit assumption explicit
    // for the one field this whole describe block is about.
    const raw = region({ bbox: { x: 0, y: 0, w: 50, h: 20 }, text: 'NoInkBBoxInput' })
    expect((raw as { inkBBox?: unknown }).inkBBox).toBeUndefined()

    const result = validateRegions([raw], 1000, 1000)

    expect(result).toHaveLength(1)
    expect(result[0].inkBBox).toEqual({ x: 0, y: 0, w: 50, h: 20 })
  })
})

describe('validateRegions - rotated flag passthrough', () => {
  it('preserves rotated:true on a surviving region that never merges with anything', () => {
    const solo = region({
      bbox: { x: 10, y: 10, w: 50, h: 20 },
      text: 'Skewed',
      rotated: true
    })

    const result = validateRegions([solo], 1000, 1000)

    expect(result).toHaveLength(1)
    expect(result[0].rotated).toBe(true)
  })

  it('keeps a merged region rotated when the rotated constituent dominates the merge', () => {
    // A genuinely rotated region must not lose its status by absorbing a
    // small straight fragment. (Status conflicts resolve to the dominant-
    // area contributor since the gate-round-2 fix - the symmetric case, a
    // small rotated fragment poisoning a dominant straight region, is
    // covered by the regression suite below.)
    const skewed = region({
      bbox: { x: 120, y: 95, w: 140, h: 30 },
      text: 'Right',
      rotated: true
    })
    const straightSliver = region({ bbox: { x: 130, y: 100, w: 30, h: 20 }, text: 'Left' })

    const result = validateRegions([skewed, straightSliver], 1000, 1000)

    expect(result).toHaveLength(1)
    expect(result[0].rotated).toBe(true)
  })
})

describe('validateRegions - rotation angle passthrough (polish round Task E)', () => {
  it('preserves a known rotation angle on a surviving region that never merges with anything', () => {
    const solo = region({
      bbox: { x: 10, y: 10, w: 50, h: 20 },
      text: 'Vertical',
      rotation: -90
    })

    const result = validateRegions([solo], 1000, 1000)

    expect(result).toHaveLength(1)
    expect(result[0].rotation).toBe(-90)
  })

  it('carries a rotation angle through a merge when the angled constituent dominates it', () => {
    // The angle must not be silently dropped when a genuine rotated region
    // absorbs a small unrotated fragment - the dominant-area contributor
    // decides orientation on conflict (gate-round-2 rule; the reverse
    // direction is covered by the regression suite below).
    const rotated = region({
      bbox: { x: 120, y: 95, w: 140, h: 30 },
      text: 'Right',
      rotation: 90
    })
    const straightSliver = region({ bbox: { x: 130, y: 100, w: 30, h: 20 }, text: 'Left' })

    const result = validateRegions([rotated, straightSliver], 1000, 1000)

    expect(result).toHaveLength(1)
    expect(result[0].rotation).toBe(90)
  })
})

describe('validateRegions - merge orientation conflicts resolve to the dominant-area contributor (gate round 2 regression)', () => {
  it('a small rotation-tagged fragment containment-merged into a large normal region must NOT re-orient it', () => {
    // Real image8: a 24x15 rotated-pass re-read of one axis number merged
    // into the 473x17 normal number row and its rotation tag made the whole
    // row paint VERTICALLY over the chart.
    const row = region({
      bbox: { x: 92, y: 434, w: 473, h: 17 },
      text: '20 25 30 35 40',
      confidence: 1.0
    })
    const fragment = region({
      bbox: { x: 91, y: 435, w: 24, h: 15 },
      text: '20',
      confidence: 1.0,
      rotation: -90
    })

    const result = validateRegions([row, fragment], 640, 480)

    expect(result).toHaveLength(1)
    expect(result[0].rotation).toBeUndefined()
    expect(result[0].rotated).toBeUndefined()
  })

  it('a tiny untagged noise box merged into a large rotated region must NOT strip its angle', () => {
    const title = region({
      bbox: { x: 10, y: 60, w: 30, h: 150 },
      text: 'TPM (mg/puff)',
      confidence: 0.9,
      rotation: -90
    })
    const noise = region({
      bbox: { x: 12, y: 65, w: 20, h: 12 },
      text: 'no',
      confidence: 0.9
    })

    const result = validateRegions([title, noise], 640, 480)

    expect(result).toHaveLength(1)
    expect(result[0].rotation).toBe(-90)
  })
})
