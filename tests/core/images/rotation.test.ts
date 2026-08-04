import { describe, expect, it, vi } from 'vitest'
import { loadImage } from 'skia-canvas'
import { createCanvas, registerBundledFonts } from '../../../src/core/fit/fonts'
import {
  validateRegions,
  type RegionEngine,
  type TextRegion
} from '../../../src/core/images/regions'
import { _internals, withRotationPasses } from '../../../src/core/images/rotation'

registerBundledFonts()

const { mapCwBBoxToOriginal, mapCcwBBoxToOriginal } = _internals

async function solidPng(width: number, height: number, color = '#ffffff'): Promise<Buffer> {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  return canvas.toBuffer('png')
}

function rawRegion(
  overrides: Partial<TextRegion> & { bbox: TextRegion['bbox']; text: string }
): TextRegion {
  return { id: 'raw', confidence: 0.9, ...overrides }
}

function sequenceEngine(
  normal: TextRegion[],
  cw: TextRegion[],
  ccw: TextRegion[]
): { engine: RegionEngine; detectRegions: ReturnType<typeof vi.fn> } {
  const detectRegions = vi
    .fn()
    .mockResolvedValueOnce(normal)
    .mockResolvedValueOnce(cw)
    .mockResolvedValueOnce(ccw)
  return { engine: { detectRegions }, detectRegions }
}

describe('withRotationPasses - dimension routing (design point 1)', () => {
  it('runs the inner engine 3 times: the original buffer as-is, then a CW pass and a CCW pass each sized H x W', async () => {
    const buffer = await solidPng(100, 60)
    const detectRegions = vi.fn().mockResolvedValue([])
    const wrapped = withRotationPasses({ detectRegions })

    await wrapped.detectRegions(buffer)

    expect(detectRegions).toHaveBeenCalledTimes(3)
    // Normal pass: the SAME buffer, unchanged - "runs the inner engine on
    // the image as-is" (design point 1), not a decode/re-encode round trip.
    expect(detectRegions.mock.calls[0][0]).toBe(buffer)

    const cwImg = await loadImage(detectRegions.mock.calls[1][0] as Buffer)
    expect([cwImg.width, cwImg.height]).toEqual([60, 100])
    const ccwImg = await loadImage(detectRegions.mock.calls[2][0] as Buffer)
    expect([ccwImg.width, ccwImg.height]).toEqual([60, 100])
  })
})

describe('withRotationPasses - coordinate mapping round trip (design point 1, both signs)', () => {
  it('mapCwBBoxToOriginal recovers the exact original bbox from its forward-computed CW-frame bbox', () => {
    // Original image W=100, H=200; original bbox {x:10,y:20,w:5,h:30}.
    // Forward CW point map (x,y) -> (H-y, x) applied to all 4 corners and
    // reduced to min/max per axis gives the CW-frame bbox below - see
    // rotation.ts's own mapCwBBoxToOriginal doc comment for the full
    // derivation this fixture mirrors.
    const cwFrameBBox = { x: 150, y: 10, w: 30, h: 5 }
    expect(mapCwBBoxToOriginal(cwFrameBBox, 200)).toEqual({ x: 10, y: 20, w: 5, h: 30 })
  })

  it('mapCcwBBoxToOriginal recovers the exact original bbox from its forward-computed CCW-frame bbox', () => {
    // Same original bbox as above; forward CCW point map (x,y) -> (y, W-x),
    // W=100.
    const ccwFrameBBox = { x: 20, y: 85, w: 30, h: 5 }
    expect(mapCcwBBoxToOriginal(ccwFrameBBox, 100)).toEqual({ x: 10, y: 20, w: 5, h: 30 })
  })
})

describe('withRotationPasses - normal pass wins over an overlapping rotated candidate (design point 2)', () => {
  it('drops a rotated-pass region whose original-frame bbox overlaps a normal-pass region above IoU 0.3', async () => {
    // W=200,H=150 image. Desired original-frame overlap target:
    // {x:50,y:50,w:80,h:20} - both the normal region AND the (mapped)
    // rotated candidate land exactly here (IoU 1.0, well above 0.3).
    const buffer = await solidPng(200, 150)
    const normalRegion = rawRegion({
      bbox: { x: 50, y: 50, w: 80, h: 20 },
      text: 'Chart Title',
      confidence: 0.9
    })
    // Forward CW map of {x:50,y:50,w:80,h:20} at H=150: newX=H-y in
    // [80,100], newY=x in [50,130] -> CW-frame bbox {x:80,y:50,w:20,h:80}.
    const cwCandidate = rawRegion({
      bbox: { x: 80, y: 50, w: 20, h: 80 },
      text: 'garbage read',
      confidence: 0.85
    })
    const { engine } = sequenceEngine([normalRegion], [cwCandidate], [])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Chart Title')
    expect(result[0].rotation).toBeUndefined()
  })
})

describe('withRotationPasses - non-overlapping rotated regions survive with the correct rotation (both signs)', () => {
  it('keeps a CW-pass region as rotation -90 and a CCW-pass region as rotation 90, each mapped back correctly, when neither overlaps anything', async () => {
    // W=200,H=150. Label A: original bbox {x:10,y:10,w:8,h:60} (tall/
    // narrow - a real vertical axis title's shape), revealed by the CW pass
    // -> rotation -90. Label B: original bbox {x:150,y:80,w:8,h:60},
    // revealed by the CCW pass -> rotation 90. Forward-mapped per this
    // module's own formulas (see the two describe blocks above for the
    // general derivation).
    const buffer = await solidPng(200, 150)
    const cwCandidate = rawRegion({
      bbox: { x: 80, y: 10, w: 60, h: 8 },
      text: 'Y Axis',
      confidence: 0.9
    })
    const ccwCandidate = rawRegion({
      bbox: { x: 80, y: 42, w: 60, h: 8 },
      text: 'Right Label',
      confidence: 0.9
    })
    const { engine } = sequenceEngine([], [cwCandidate], [ccwCandidate])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result).toHaveLength(2)
    const yAxis = result.find((r) => r.text === 'Y Axis')
    expect(yAxis?.bbox).toEqual({ x: 10, y: 10, w: 8, h: 60 })
    expect(yAxis?.rotation).toBe(-90)
    expect(yAxis?.rotated).toBeUndefined()

    const rightLabel = result.find((r) => r.text === 'Right Label')
    expect(rightLabel?.bbox).toEqual({ x: 150, y: 80, w: 8, h: 60 })
    expect(rightLabel?.rotation).toBe(90)
  })
})

describe('withRotationPasses - orphan aspect guard (review finding: uncorroborated rotated paints)', () => {
  it('drops a square-ish rotated-pass orphan (zero normal-pass overlap, aspect < 2) - the hallucination shape', async () => {
    // W=200,H=150. Orphan original-frame footprint {x:20,y:20,w:30,h:40}:
    // aspect 40/30 = 1.33 < 2, and no normal-pass region exists at all, so
    // nothing ever corroborated it - exactly the shape a detector invents on
    // sideways/blank content. Forward CW map at H=150: {x:110,y:20,w:40,h:30}.
    const buffer = await solidPng(200, 150)
    const squarishOrphan = rawRegion({
      bbox: { x: 110, y: 20, w: 40, h: 30 },
      text: 'ghost text',
      confidence: 0.9
    })
    const { engine } = sequenceEngine([], [squarishOrphan], [])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result).toHaveLength(0)
  })

  it('keeps an elongated rotated-pass orphan (aspect >= 2) - the real vertical-title shape', async () => {
    // Same setup, but the orphan's original-frame footprint {x:10,y:10,w:8,h:60}
    // has aspect 60/8 = 7.5 - characteristically a vertical axis title.
    const buffer = await solidPng(200, 150)
    const elongatedOrphan = rawRegion({
      bbox: { x: 80, y: 10, w: 60, h: 8 },
      text: 'Y Axis',
      confidence: 0.9
    })
    const { engine } = sequenceEngine([], [elongatedOrphan], [])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result).toHaveLength(1)
    expect(result[0].rotation).toBe(-90)
  })

  it('keeps a non-elongated rotated candidate that PARTIALLY overlaps normal-pass content (IoU in (0, threshold]) - partial corroboration exempts it from the guard', async () => {
    // Normal region at {x:50,y:50,w:80,h:20}. Rotated candidate's
    // original-frame footprint {x:120,y:55,w:30,h:30}: intersection with the
    // normal region is x:[120,130] * y:[55,70] = 150, union = 1600+900-150 =
    // 2350, IoU ~ 0.064 - above zero (touches real content) but below the
    // 0.3 drop threshold, and aspect 1.0 < 2. The guard must not drop it.
    const buffer = await solidPng(200, 150)
    const normalRegion = rawRegion({
      bbox: { x: 50, y: 50, w: 80, h: 20 },
      text: 'Chart Title',
      confidence: 0.9
    })
    // Forward CW map of {x:120,y:55,w:30,h:30} at H=150: newX = H-y-h = 65,
    // newY = x = 120 -> CW-frame {x:65,y:120,w:30,h:30}.
    const touchingCandidate = rawRegion({
      bbox: { x: 65, y: 120, w: 30, h: 30 },
      text: 'unit mark',
      confidence: 0.9
    })
    const { engine } = sequenceEngine([normalRegion], [touchingCandidate], [])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result).toHaveLength(2)
    expect(result.find((r) => r.text === 'unit mark')?.rotation).toBe(-90)
  })
})

describe('withRotationPasses - chart-strip kills (gate round 2 regression: rotated passes flattened real chart images)', () => {
  // Scaled reconstruction of the real deck's image8.png (640x480 matplotlib
  // chart) whose entire plot got painted over by rotated-pass "strips": in
  // the rotated frame PP-OCR reads each vertical strip of the original as
  // one long line (y-axis numbers + a slice of the title + an x-axis number
  // + a legend fragment concatenated). Each strip's IoU against every
  // individual normal-pass box is far below the 0.3 kill threshold (the
  // union is the whole strip), it touches normal content (which used to
  // exempt it from the orphan aspect guard) and it is elongated - so before
  // this fix EVERY defense passed it through.
  const NORMALS = [
    rawRegion({ bbox: { x: 140, y: 35, w: 360, h: 25 }, text: 'Chart Title', confidence: 0.95 }),
    // y-axis tick numbers: a vertical column of small boxes at x ~ 28.
    ...Array.from({ length: 9 }, (_, i) =>
      rawRegion({
        bbox: { x: 28, y: 55 + i * 42, w: 12, h: 16 },
        text: `${9 - i}`,
        confidence: 0.9
      })
    ),
    rawRegion({ bbox: { x: 276, y: 428, w: 24, h: 16 }, text: '35', confidence: 0.9 }),
    rawRegion({
      bbox: { x: 250, y: 455, w: 140, h: 18 },
      text: 'Number of Puffs',
      confidence: 0.93
    }),
    rawRegion({ bbox: { x: 510, y: 65, w: 90, h: 80 }, text: 'BHHT-1 legend', confidence: 0.9 })
  ]

  it('SWALLOW kill: a full-height strip down the y-axis number column fully contains individual tick numbers and dies, despite sub-threshold IoU with each', async () => {
    const buffer = await solidPng(640, 480)
    // Original-frame strip {x:20,y:0,w:30,h:480} - forward CW map at H=480:
    // x' = H-y-h = 0, y' = x = 20, w' = h = 480, h' = w = 30.
    const columnStrip = rawRegion({
      bbox: { x: 0, y: 20, w: 480, h: 30 },
      text: '6 7 6 5 4 3 2 8',
      confidence: 0.88
    })
    const { engine } = sequenceEngine(NORMALS, [columnStrip], [])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result.some((r) => r.text === '6 7 6 5 4 3 2 8')).toBe(false)
    expect(result).toHaveLength(NORMALS.length)
  })

  it('CROSSCUT kill: a full-height strip crossing title + x-number + xlabel (swallowing none of them) dies for cutting across 3+ established readings', async () => {
    const buffer = await solidPng(640, 480)
    // Original-frame strip {x:290,y:0,w:30,h:480}: slices 8% of the title,
    // 21% of the xlabel and 42% of the '35' tick - never >= SWALLOW_FRACTION
    // of any single one, but crosses three distinct normal regions.
    // Forward CW map at H=480: {x:0,y:290,w:480,h:30}.
    const crossStrip = rawRegion({
      bbox: { x: 0, y: 290, w: 480, h: 30 },
      text: 'rt Ti 35 of Pu',
      confidence: 0.87
    })
    const { engine } = sequenceEngine(NORMALS, [crossStrip], [])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result.some((r) => r.text === 'rt Ti 35 of Pu')).toBe(false)
    expect(result).toHaveLength(NORMALS.length)
  })

  it('a genuine vertical axis title in the clear left margin still survives the same scene', async () => {
    const buffer = await solidPng(640, 480)
    // Original-frame title {x:6,y:140,w:20,h:180}: left of the tick-number
    // column, zero overlap with every normal region, aspect 9 - the real
    // "TPM (mg/puff)" shape. Forward CW map at H=480: x' = 480-140-180 =
    // 160, y' = 6 -> {x:160,y:6,w:180,h:20}.
    const axisTitle = rawRegion({
      bbox: { x: 160, y: 6, w: 180, h: 20 },
      text: 'TPM (mg/puff)',
      confidence: 0.9
    })
    const { engine } = sequenceEngine(NORMALS, [axisTitle], [])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    const title = result.find((r) => r.text === 'TPM (mg/puff)')
    expect(title?.bbox).toEqual({ x: 6, y: 140, w: 20, h: 180 })
    expect(title?.rotation).toBe(-90)
  })

  it('SWALLOW kill fires even for a compact (non-strip) candidate that consumes a whole normal region at sub-threshold IoU', async () => {
    const buffer = await solidPng(640, 480)
    const normal = rawRegion({
      bbox: { x: 100, y: 100, w: 40, h: 20 },
      text: 'Real',
      confidence: 0.9
    })
    // Original-frame candidate {x:80,y:90,w:120,h:60}: fully contains the
    // normal region (100% of its area) but IoU is only 800/7200 ~ 0.11 -
    // below the 0.3 same-spot kill. Forward CW map at H=480:
    // x' = 480-90-60 = 330, y' = 80 -> {x:330,y:80,w:60,h:120}.
    const swallower = rawRegion({
      bbox: { x: 330, y: 80, w: 60, h: 120 },
      text: 'engulfing read',
      confidence: 0.92
    })
    const { engine } = sequenceEngine([normal], [swallower], [])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result.map((r) => r.text)).toEqual(['Real'])
  })
})

describe('withRotationPasses - CONTAINED kill (gate round 2: rotated re-reads of single axis numbers inside the merged number row)', () => {
  it('drops a small rotated candidate sitting mostly inside one normal-pass region, despite tiny IoU', async () => {
    const buffer = await solidPng(640, 480)
    // The real image8 geometry: the normal pass merges the x-axis numbers
    // into one wide row {x:92,y:434,w:473,h:17}; a rotated pass re-detects
    // the single number "20" as {x:91,y:435,w:24,h:15} - 96% of the
    // candidate is inside the row while IoU is only ~0.04. Forward CW map of
    // the candidate at H=480: x' = 480-435-15 = 30, y' = 91 ->
    // {x:30,y:91,w:15,h:24}.
    const numberRow = rawRegion({
      bbox: { x: 92, y: 434, w: 473, h: 17 },
      text: '20 25 30 35 40 45 50 55 60',
      confidence: 1.0
    })
    const reRead = rawRegion({
      bbox: { x: 30, y: 91, w: 15, h: 24 },
      text: '20',
      confidence: 1.0
    })
    const { engine } = sequenceEngine([numberRow], [reRead], [])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('20 25 30 35 40 45 50 55 60')
    expect(result[0].rotation).toBeUndefined()
  })
})

describe('withRotationPasses - flagged in-place garbles are superseded, never merged over (gate round 2: vertical title translation)', () => {
  // The real image8 vertical title: the normal pass reads "TPM (mg/puff)"
  // in place as the garble "(nd/6w) Wd1" in a 24x108 box (now flagged
  // rotated by ppocr.ts's vertical-shape signal); the CW pass reads the
  // same pixels upright. Original-frame spot {x:36,y:190,w:24,h:108};
  // forward CW map at H=480: x' = 480-190-108 = 182, y' = 36 ->
  // {x:182,y:36,w:108,h:24}.
  const garble = rawRegion({
    bbox: { x: 36, y: 190, w: 24, h: 108 },
    text: '(nd/6w) Wd1',
    confidence: 0.89,
    rotated: true
  })
  const uprightReading = rawRegion({
    bbox: { x: 182, y: 36, w: 108, h: 24 },
    text: 'TPM (mg/puff)',
    confidence: 0.9
  })

  it('a surviving rotated-pass reading replaces the flagged garble at the same spot', async () => {
    const buffer = await solidPng(640, 480)
    const { engine } = sequenceEngine([garble], [uprightReading], [])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('TPM (mg/puff)')
    expect(result[0].bbox).toEqual({ x: 36, y: 190, w: 24, h: 108 })
    expect(result[0].rotation).toBe(-90)
  })

  it('a rotated-pass candidate reading the SAME text as the flagged garble does NOT supersede it - identical wrong read, pixels stay', async () => {
    const buffer = await solidPng(640, 480)
    // Same spot as the garble, same string - the CCW pass reproducing the
    // in-place mirror reading (observed verbatim on the real deck). Forward
    // CCW map of {x:36,y:190,w:24,h:108} at W=640: x' = y = 190,
    // y' = W-x-w = 580 -> {x:190,y:580,w:108,h:24}.
    const sameGarble = rawRegion({
      bbox: { x: 190, y: 580, w: 108, h: 24 },
      text: '(nd/6w) Wd1',
      confidence: 0.91
    })
    const { engine } = sequenceEngine([garble], [], [sameGarble])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('(nd/6w) Wd1')
    expect(result[0].rotated).toBe(true)
    expect(result[0].rotation).toBeUndefined()
  })

  it('a flagged garble no rotated-pass reading claims stays in the output (downstream skips it, pixels stay)', async () => {
    const buffer = await solidPng(640, 480)
    const { engine } = sequenceEngine([garble], [], [])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('(nd/6w) Wd1')
    expect(result[0].rotated).toBe(true)
  })
})

describe('withRotationPasses - opposite-pass reading ambiguity (gate round 2: mirror readings painted over real titles)', () => {
  const { dropLowerConfidenceOverlaps, AMBIGUOUS_CONFIDENCE_DELTA } = _internals
  const spot = { x: 10, y: 60, w: 20, h: 100 }

  it('drops BOTH candidates when opposite passes disagree about the text within the confidence delta - original pixels beat a coin-flip', () => {
    const upright = rawRegion({
      bbox: spot,
      text: 'TPM (mg/puff)',
      confidence: 0.86,
      rotation: -90
    })
    const mirrored = rawRegion({
      bbox: spot,
      text: '(Jjnd/6w) WdL',
      confidence: 0.82,
      rotation: 90
    })
    expect(Math.abs(upright.confidence - mirrored.confidence)).toBeLessThan(
      AMBIGUOUS_CONFIDENCE_DELTA
    )

    expect(dropLowerConfidenceOverlaps([upright, mirrored])).toEqual([])
  })

  it('keeps the clear confidence winner when the gap is at least the delta', () => {
    const upright = rawRegion({
      bbox: spot,
      text: 'TPM (mg/puff)',
      confidence: 0.95,
      rotation: -90
    })
    const mirrored = rawRegion({ bbox: spot, text: '(Jjnd/6w) WdL', confidence: 0.5, rotation: 90 })

    const result = dropLowerConfidenceOverlaps([upright, mirrored])
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('TPM (mg/puff)')
  })

  it('treats same-text candidates as an ordinary duplicate regardless of the delta - keeps the higher-confidence copy', () => {
    const a = rawRegion({ bbox: spot, text: 'TPM (mg/puff)', confidence: 0.86, rotation: -90 })
    const b = rawRegion({ bbox: spot, text: 'TPM (mg/puff) ', confidence: 0.82, rotation: 90 })

    const result = dropLowerConfidenceOverlaps([a, b])
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe(0.86)
  })
})

describe('withRotationPasses - rotated-pass-vs-rotated-pass dedup keeps the higher confidence (design point 2)', () => {
  it('drops the lower-confidence rotated candidate when a CW-pass and a CCW-pass region map to overlapping original bboxes', async () => {
    // Both candidates map back to the SAME original bbox {x:10,y:10,w:8,
    // h:60} (IoU 1.0, well above 0.3) - simulating an ambiguous case where
    // both rotation directions "find" the same physical text.
    const buffer = await solidPng(200, 150)
    const cwCandidate = rawRegion({
      bbox: { x: 80, y: 10, w: 60, h: 8 },
      text: 'LowConf',
      confidence: 0.5
    })
    const ccwCandidate = rawRegion({
      bbox: { x: 10, y: 182, w: 60, h: 8 },
      text: 'HighConf',
      confidence: 0.95
    })
    const { engine } = sequenceEngine([], [cwCandidate], [ccwCandidate])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('HighConf')
    expect(result[0].rotation).toBe(90)
  })
})

describe('withRotationPasses - dedup ordering: normal-overlap resolves BEFORE rotated-vs-rotated (regression guard)', () => {
  it("does not let a normal-overlapping rotated candidate's higher confidence drag down an otherwise-clean rival", async () => {
    // N (normal) = {x:0,y:0,w:100,h:40}. A (from the CW pass) =
    // {x:50,y:0,w:100,h:40}: overlaps N (IoU 0.333 > 0.3) AND overlaps B
    // (IoU 0.333 > 0.3), confidence 0.9 - the HIGHER of the two rotated
    // candidates. B (from the CCW pass) = {x:100,y:0,w:100,h:40}: overlaps
    // A but NOT N at all (IoU 0), confidence 0.6 - the lower one.
    //
    // A naive "resolve rotated-vs-rotated first" implementation would keep
    // A over B (A has higher confidence), THEN drop A for overlapping N -
    // losing B for no reason, even though B never conflicted with any real
    // content. The correct order drops A first (it overlaps established
    // normal-pass content), leaving B as the sole survivor with nothing left
    // to conflict with.
    const width = 400
    const height = 300
    const buffer = await solidPng(width, height)
    const normalRegion = rawRegion({
      bbox: { x: 0, y: 0, w: 100, h: 40 },
      text: 'Normal',
      confidence: 0.9
    })
    // Forward CW map of A={x:50,y:0,w:100,h:40} at H=300: newX=H-y in
    // [260,300], newY=x in [50,150].
    const candidateA = rawRegion({
      bbox: { x: 260, y: 50, w: 40, h: 100 },
      text: 'CandA',
      confidence: 0.9
    })
    // Forward CCW map of B={x:100,y:0,w:100,h:40} at W=400: newX=y in
    // [0,40], newY=W-x in [200,300].
    const candidateB = rawRegion({
      bbox: { x: 0, y: 200, w: 40, h: 100 },
      text: 'CandB',
      confidence: 0.6
    })
    const { engine } = sequenceEngine([normalRegion], [candidateA], [candidateB])

    const result = await withRotationPasses(engine).detectRegions(buffer)

    const texts = result.map((r) => r.text).sort()
    expect(texts).toEqual(['CandB', 'Normal'])
    const candB = result.find((r) => r.text === 'CandB')
    expect(candB?.bbox).toEqual({ x: 100, y: 0, w: 100, h: 40 })
    expect(candB?.rotation).toBe(90)
  })
})

describe('withRotationPasses - real end-to-end rotation fixture (design point (b))', () => {
  it('recovers a genuinely-rotated vertical label drawn via canvas transform, from a dimension-keyed mock engine', async () => {
    // A REAL image (not a hand-built bbox fixture): a horizontal title drawn
    // normally, plus a vertical label drawn via the SAME
    // translate-to-center/rotate(-90deg)/draw-centered recipe overlay.ts's
    // own paint path uses - i.e. genuinely rotated pixels, not merely
    // claimed rotation. A REAL model load is forbidden here (machine
    // rules), so the inner engine is mocked - but keyed only by IMAGE
    // DIMENSIONS, exactly the cheap signal withRotationPasses itself uses to
    // pick which pass produced a given raw buffer (original W x H vs either
    // rotated pass's H x W). This proves the coordinate math and pass
    // plumbing against a real rotated image; it does NOT prove real PP-OCR
    // actually reads the rotated copy correctly - that proof only happens at
    // the Charlie-run gate (a real model load is off limits in this
    // environment).
    const width = 300
    const height = 200
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#000000'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.font = '18px "Noto Sans"'
    ctx.fillText('Chart Title', 20, 15)

    const labelBBox = { x: 15, y: 60, w: 20, h: 100 }
    ctx.save()
    ctx.translate(labelBBox.x + labelBBox.w / 2, labelBBox.y + labelBBox.h / 2)
    ctx.rotate(-Math.PI / 2) // matches overlay.ts's own rotation:-90 sign convention
    ctx.font = '14px "Noto Sans"'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Y Axis Title', 0, 0)
    ctx.restore()
    const fixtureBuffer = await canvas.toBuffer('png')

    const titleRegion = rawRegion({
      bbox: { x: 20, y: 15, w: 120, h: 25 },
      text: 'Chart Title',
      confidence: 0.95
    })
    // Forward CW map of labelBBox at H=200: newX=H-y in [40,140],
    // newY=x in [15,35] -> {x:40,y:15,w:100,h:20}. Both rotated passes share
    // dimensions (200,300) and a dimension-only mock cannot distinguish
    // which pass produced a given buffer, so it reports this SAME candidate
    // for either - withRotationPasses maps it via BOTH formulas regardless
    // (see below: the CW-formula result is the real label; the CCW-formula
    // result is a harmless, non-overlapping byproduct of feeding the same
    // raw numbers through the other pass's math).
    const labelCandidate = rawRegion({
      bbox: { x: 40, y: 15, w: 100, h: 20 },
      text: 'Y Axis Title',
      confidence: 0.92
    })
    const detectRegions = vi.fn(async (buf: Buffer) => {
      const img = await loadImage(buf)
      if (img.width === width && img.height === height) return [titleRegion]
      if (img.width === height && img.height === width) return [labelCandidate]
      return []
    })

    const result = await withRotationPasses({ detectRegions }).detectRegions(fixtureBuffer)

    const label = result.find((r) => r.text === 'Y Axis Title' && r.rotation === -90)
    expect(label).toBeDefined()
    expect(label!.bbox).toEqual(labelBBox)

    expect(result.some((r) => r.text === 'Chart Title' && r.rotation === undefined)).toBe(true)
  })
})

describe('withRotationPasses + validateRegions - content gates still apply to the merged set (design point 2)', () => {
  it('drops a rotated-pass region that fails the existing 2-non-punctuation-character content gate, exactly like any other region', async () => {
    const width = 200
    const height = 150
    const buffer = await solidPng(width, height)
    // Forward CW map of {x:10,y:10,w:8,h:60} at H=150: {x:80,y:10,w:60,h:8}
    // (same shape used by the "non-overlapping" test above).
    const garbageCandidate = rawRegion({
      bbox: { x: 80, y: 10, w: 60, h: 8 },
      text: '@', // fails MIN_NON_PUNCT_CHARS - regions.ts's own hallucination guard
      confidence: 0.92
    })
    const { engine } = sequenceEngine([], [garbageCandidate], [])

    const raw = await withRotationPasses(engine).detectRegions(buffer)
    expect(raw.some((r) => r.text === '@')).toBe(true) // survives withRotationPasses itself...

    const validated = validateRegions(raw, width, height)
    expect(validated).toEqual([]) // ...but is gated out by validateRegions, same as any garbage region
  })
})
