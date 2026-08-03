import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Canvas, loadImage } from 'skia-canvas'
import {
  _internals as imageAdapterInternals,
  createImageAdapter
} from '../../../src/core/adapters/images/image-adapter'
import {
  CONFIDENCE_FLOOR,
  type RegionEngine,
  type TextRegion
} from '../../../src/core/images/regions'
import { registerBundledFonts, resolveFamily } from '../../../src/core/fit/fonts'
import { _internals as fitInternals, fit } from '../../../src/core/fit/fit-engine'
import type { FontSpec, TranslatedSegment } from '../../../src/core/segments'
import { runPipeline } from '../../../src/core/pipeline'
import type { TranslationBackend } from '../../../src/core/translate/backend'

registerBundledFonts()

// Independent measurement helper (mirrors sizing.test.ts's own) - verifies
// extract()'s font.sizePt against a fresh measurement rather than checking
// image-adapter.ts's computation against itself.
const measureCanvas = new Canvas(8, 8)
const measureCtx = measureCanvas.getContext('2d')
function inkHeightAt(text: string, sizePt: number, font: FontSpec): number {
  const { family } = resolveFamily(font.family)
  measureCtx.font = `${sizePt}px "${family}"`
  const m = measureCtx.measureText(text)
  return m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
}

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs.length = 0
  vi.restoreAllMocks()
})

function newTmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lt-image-adapter-'))
  tmpDirs.push(dir)
  return dir
}

/** Writes a real, decodable solid-color PNG to a fresh tmp dir - extract()
 * decodes dimensions for real (skia-canvas loadImage), so every fixture
 * here must be a genuine encoded image, never a raw/fake buffer. */
async function writePng(
  fileName: string,
  width: number,
  height: number,
  color = '#ffffff'
): Promise<string> {
  const dir = newTmpDir()
  const file = path.join(dir, fileName)
  const canvas = new Canvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  await writeFile(file, await canvas.toBuffer('png'))
  return file
}

function fakeEngine(regions: TextRegion[]): RegionEngine {
  return { detectRegions: vi.fn().mockResolvedValue(regions) }
}

function rawRegion(
  overrides: Partial<TextRegion> & { bbox: TextRegion['bbox']; text: string }
): TextRegion {
  return { id: 'raw', confidence: 0.9, ...overrides }
}

function fakeBackend(overrides: Partial<TranslationBackend> = {}): TranslationBackend {
  return {
    listModels: vi.fn().mockResolvedValue([]),
    pullModel: vi.fn().mockResolvedValue(undefined),
    translateBatch: vi.fn().mockResolvedValue({ translations: [] }),
    ...overrides
  }
}

/** Decodes a PNG file back into a plain pixel-data view for assertions. */
async function decodeFile(
  file: string
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const img = await loadImage(await readFile(file))
  const canvas = new Canvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, img.width, img.height)
  return { width: img.width, height: img.height, data: imageData.data }
}

function regionRgb(
  decoded: { width: number; data: Uint8ClampedArray },
  x: number,
  y: number,
  w: number,
  h: number
): { r: number; g: number; b: number }[] {
  const pixels: { r: number; g: number; b: number }[] = []
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const idx = (py * decoded.width + px) * 4
      pixels.push({
        r: decoded.data[idx],
        g: decoded.data[idx + 1],
        b: decoded.data[idx + 2]
      })
    }
  }
  return pixels
}

function isWhite(p: { r: number; g: number; b: number }): boolean {
  return p.r === 255 && p.g === 255 && p.b === 255
}

function pixelAt(
  decoded: { width: number; data: Uint8ClampedArray },
  x: number,
  y: number
): { r: number; g: number; b: number } {
  const idx = (y * decoded.width + x) * 4
  return { r: decoded.data[idx], g: decoded.data[idx + 1], b: decoded.data[idx + 2] }
}

function channelDelta(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number }
): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b))
}

/** Tight pixel bounding box of every pixel in `region` whose color differs
 * from `bg` by more than the detection threshold - the actual rendered INK
 * extent, read straight from pixels rather than from any font metric.
 * Mirrors tests/core/images/overlay.test.ts's identical helper. Returns null
 * when the region is pure background (no ink found at all). */
function scanInkBBox(
  decoded: { width: number; data: Uint8ClampedArray },
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

describe('extract() - paintable region field mapping (behavior contract point 1)', () => {
  it('maps a validated region to a TextSegment with id/kind/context/groupKey/box/font', async () => {
    const file = await writePng('photo.png', 400, 300)
    const engine = fakeEngine([rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Hello' })])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

    const segments = await adapter.extract(file)

    expect(segments).toHaveLength(1)
    const [seg] = segments
    expect(seg.id).toBe('r1')
    expect(seg.kind).toBe('image-region')
    expect(seg.context).toBe('image text region')
    expect(seg.groupKey).toBe('photo.png')
    expect(seg.text).toBe('Hello')
    // Raw bbox dilated by DILATION_PX (2px/side, regions.ts) - well inside
    // the 400x300 image so the final clamp is a no-op. Width is the dilated
    // bbox.w unchanged; height is a FIT BUDGET (Math.max(bbox.h,
    // sizePt * FIT_LINE_HEIGHT_FACTOR)), not the dilated bbox.h itself - see
    // image-adapter.ts's own doc comment on why (fit()'s height gate would
    // otherwise shrink the ink-matched size straight back to the old
    // bbox.h/1.2 heuristic).
    expect(seg.box.wPt).toBe(104)
    expect(seg.box.hPt).toBeCloseTo(
      Math.max(34, seg.font.sizePt * imageAdapterInternals.FIT_LINE_HEIGHT_FACTOR)
    )
    expect(seg.font.family).toBe('Noto Sans')
    // sizePt is now ink-matched to the RAW (pre-dilation) ink height - 30px
    // (bbox.h before the +2px/side dilation), not the dilated bbox.h (34).
    // Measuring "Hello" back at the returned size must land within 2px of
    // that 30px target.
    expect(Math.abs(inkHeightAt('Hello', seg.font.sizePt, seg.font) - 30)).toBeLessThanOrEqual(2)
    // And it must have MOVED from the old h/1.2 estimate (34/1.2 ~= 28.33) -
    // proving this is real ink measurement, not the old heuristic wearing a
    // new name.
    expect(Math.abs(seg.font.sizePt - 34 / 1.2)).toBeGreaterThan(1)
    // And the fit budget must be STRICTLY BIGGER than the dilated bbox.h -
    // this is the exact regression the reviewer caught: if box.hPt were left
    // as bbox.h, fit() would shrink the ink-matched size right back down.
    expect(seg.box.hPt).toBeGreaterThan(34)
  })

  it('picks the CJK font family when the region text contains CJK, independent of the exact CJK source-language spelling', async () => {
    // sourceLang must itself be CJK here (Japanese, not Chinese/Korean) - a
    // CJK-heavy region under a non-CJK source is gated out before font
    // selection ever runs (source-language gating, tested below), so this
    // still proves font selection depends only on the region's own text
    // (containsCjk), never on which CJK source-language string was passed.
    const file = await writePng('photo2.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: '你好世界' })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'Japanese' })

    const [seg] = await adapter.extract(file)

    expect(seg.font.family).toBe('Noto Sans CJK SC')
  })

  it('extracts multiple regions in reading order with dense ids', async () => {
    const file = await writePng('multi.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Hello' }),
      rawRegion({ bbox: { x: 20, y: 150, w: 100, h: 30 }, text: 'World' })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

    const segments = await adapter.extract(file)

    expect(segments.map((s) => s.id)).toEqual(['r1', 'r2'])
    expect(segments.map((s) => s.text)).toEqual(['Hello', 'World'])
  })
})

describe('extract() - source-language gating (behavior contract point 2)', () => {
  it('drops a non-CJK region under a CJK source language: no segment, no skip', async () => {
    const file = await writePng('deck.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Model X200' })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'Chinese (Simplified)' })

    const segments = await adapter.extract(file)

    expect(segments).toEqual([])
    expect(adapter.collectSkips?.()).toEqual([])
  })

  it('keeps a CJK region under a CJK source language', async () => {
    const file = await writePng('deck2.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: '你好世界' })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'Chinese (Simplified)' })

    const segments = await adapter.extract(file)

    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('你好世界')
  })

  it('drops a CJK-heavy region under a non-CJK source language (v2: symmetric gating - a script that cannot be the declared source language is left untouched, same reasoning as the CJK-source/latin-text case above)', async () => {
    const file = await writePng('deck3.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: '你好世界' })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

    const segments = await adapter.extract(file)

    expect(segments).toEqual([])
    expect(adapter.collectSkips?.()).toEqual([])
  })

  it('keeps a non-CJK region under a non-CJK source language: no script signal to gate on', async () => {
    const file = await writePng('deck4.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Model X200' })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

    const segments = await adapter.extract(file)

    expect(segments).toHaveLength(1)
  })
})

describe('extract() - confidence and rotation gating (behavior contract point 3)', () => {
  it('skips a low-confidence region with reason "low-confidence region", no segment', async () => {
    const file = await writePng('low-conf.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({
        bbox: { x: 20, y: 20, w: 100, h: 30 },
        text: 'Hello',
        confidence: CONFIDENCE_FLOOR - 0.1
      })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

    const segments = await adapter.extract(file)

    expect(segments).toEqual([])
    expect(adapter.collectSkips?.()).toEqual([{ id: 'r1', reason: 'low-confidence region' }])
  })

  it('skips a rotated region with reason "rotated region", no segment', async () => {
    const file = await writePng('rotated.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Hello', rotated: true })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

    const segments = await adapter.extract(file)

    expect(segments).toEqual([])
    expect(adapter.collectSkips?.()).toEqual([{ id: 'r1', reason: 'rotated region' }])
  })

  it('reports a low-confidence AND a rotated region separately within the same extract() call', async () => {
    const file = await writePng('mixed.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'AlphaBeta', confidence: 0.5 }),
      rawRegion({ bbox: { x: 20, y: 150, w: 100, h: 30 }, text: 'GammaDelta', rotated: true })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

    const segments = await adapter.extract(file)

    expect(segments).toEqual([])
    expect(
      adapter
        .collectSkips?.()
        ?.map((s) => s.reason)
        .sort()
    ).toEqual(['low-confidence region', 'rotated region'])
  })

  it('collectSkips() returns an empty array before any extract() call', () => {
    const adapter = createImageAdapter(fakeEngine([]), { sourceLang: 'English' })
    expect(adapter.collectSkips?.()).toEqual([])
  })
})

describe('extract() - rotated-with-angle regions are paintable (polish round Task E)', () => {
  it('produces a segment (not a skip) for a region carrying a known rotation angle, with sizing axes swapped', async () => {
    const file = await writePng('rotated-angle.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 20, h: 100 }, text: 'VerticalAxis', rotation: -90 })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

    const segments = await adapter.extract(file)

    expect(segments).toHaveLength(1)
    expect(adapter.collectSkips?.()).toEqual([])
    const [seg] = segments
    // Dilated bbox (DILATION_PX=2/side, regions.ts): {x:18,y:18,w:24,h:104}.
    // Sizing axes swap for rotation +-90 (sizing.ts's sizingAxesFor): fit box
    // width = dilated bbox.h (the run length) = 104, NOT bbox.w (24).
    expect(seg.box.wPt).toBe(104)
    // Ink target = raw (pre-dilation) inkBBox.w = 20, NOT inkBBox.h (100) -
    // measuring the text back at the returned size must land within 2px of
    // that 20px target.
    expect(
      Math.abs(inkHeightAt('VerticalAxis', seg.font.sizePt, seg.font) - 20)
    ).toBeLessThanOrEqual(2)
  })

  it('treats a region with BOTH rotated:true and a rotation angle as paintable - rotation, not rotated, decides', async () => {
    const file = await writePng('rotated-both-flags.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({
        bbox: { x: 20, y: 20, w: 20, h: 100 },
        text: 'VerticalAxis',
        rotated: true,
        rotation: 90
      })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

    const segments = await adapter.extract(file)

    expect(segments).toHaveLength(1)
    expect(adapter.collectSkips?.()).toEqual([])
  })
})

describe('apply() - rotated-with-angle regions paint through the rotated overlay path (polish round Task E)', () => {
  it('paints a tall-narrow ink footprint matching the rotated bbox orientation, through the FULL pipeline (extract -> translate -> fit -> apply), proving rotation reaches renderOverlay with a realistically fit()-shrunk size', async () => {
    // Routed through runPipeline rather than a hand-built TranslatedSegment
    // (mirrors "runPipeline pixel-exactness through the full pipeline"
    // above): calling apply() directly with fittedSizePt forced equal to the
    // raw ink-matched font.sizePt would skip fit()'s own shrink-to-width
    // step, and the ink-matched size for this fixture's text genuinely does
    // not fit the run-length budget (fitBoxWPt = dilated bbox.h) without
    // fit() shrinking it - exactly the scenario fit() exists to handle.
    const file = await writePng('rotated-paint.png', 300, 300, '#ffffff')
    const bbox = { x: 100, y: 20, w: 40, h: 200 } // tall/narrow - a real vertical-axis-title shape
    const engine = fakeEngine([rawRegion({ bbox, text: 'VerticalAxis', rotation: -90 })])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })
    const backend = fakeBackend({
      translateBatch: vi
        .fn()
        .mockResolvedValue({ translations: [{ id: 'r1', translation: 'AxeVertical' }] })
    })

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    const decoded = await decodeFile(report.outPath)
    const dilated = { x: bbox.x - 2, y: bbox.y - 2, w: bbox.w + 4, h: bbox.h + 4 }
    const scanWindow = {
      x: dilated.x - 5,
      y: dilated.y - 5,
      w: dilated.w + 10,
      h: dilated.h + 10
    }
    const ink = scanInkBBox(decoded, scanWindow, { r: 255, g: 255, b: 255 })
    expect(ink).not.toBeNull()
    const inkW = ink!.maxX - ink!.minX + 1
    const inkH = ink!.maxY - ink!.minY + 1
    // Tall, not wide - proves the paint path actually rotated the text onto
    // the vertical run-length axis instead of drawing it horizontally.
    expect(inkH).toBeGreaterThan(inkW)
    // Contained within (a couple px slack around) the dilated bbox.
    expect(ink!.minX).toBeGreaterThanOrEqual(dilated.x - 2)
    expect(ink!.maxX).toBeLessThanOrEqual(dilated.x + dilated.w + 2)
    expect(ink!.minY).toBeGreaterThanOrEqual(dilated.y - 2)
    expect(ink!.maxY).toBeLessThanOrEqual(dilated.y + dilated.h + 2)
  })
})

describe('apply() - keptOriginal/missing not painted, cache keyed by path (behavior contract point 4)', () => {
  it('throws a clear error when called without a prior extract() on the same path', async () => {
    const file = await writePng('never-extracted.png', 200, 200)
    const adapter = createImageAdapter(fakeEngine([]), { sourceLang: 'English' })

    await expect(adapter.apply(file, `${file}.out.png`, [])).rejects.toThrow(/prior extract/)
  })

  it('paints a translated region but leaves a missing (keptOriginal) region untouched', async () => {
    const file = await writePng('two-regions.png', 400, 300, '#ffffff')
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Hello' }),
      rawRegion({ bbox: { x: 20, y: 150, w: 100, h: 30 }, text: 'World' })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

    const segments = await adapter.extract(file)
    expect(segments.map((s) => s.id)).toEqual(['r1', 'r2'])

    const translated: TranslatedSegment[] = [
      {
        ...segments[0],
        translation: 'Bonjour',
        fittedSizePt: segments[0].font.sizePt,
        fittedLines: ['Bonjour']
      }
      // segments[1] ('World' / r2) deliberately omitted - simulates
      // keptOriginal/missing: must be left unpainted.
    ]

    const outPath = file.replace('.png', '_out.png')
    await adapter.apply(file, outPath, translated)

    const decoded = await decodeFile(outPath)
    const r1Pixels = regionRgb(decoded, 18, 18, 104, 34) // painted region's dilated bbox
    expect(r1Pixels.some((p) => !isWhite(p))).toBe(true)

    const r2Pixels = regionRgb(decoded, 18, 148, 104, 34) // untouched region
    expect(r2Pixels.every(isWhite)).toBe(true)
  })

  it('does not paint a segment whose translation equals its source text (zero-diff guarantee)', async () => {
    const file = await writePng('unchanged.png', 400, 300, '#ffffff')
    const engine = fakeEngine([rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Hello' })])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

    const [seg] = await adapter.extract(file)
    const translated: TranslatedSegment[] = [
      { ...seg, translation: seg.text, fittedSizePt: seg.font.sizePt, fittedLines: [seg.text] }
    ]

    const outPath = file.replace('.png', '_out.png')
    await adapter.apply(file, outPath, translated)

    const decoded = await decodeFile(outPath)
    expect(regionRgb(decoded, 18, 18, 104, 34).every(isWhite)).toBe(true)
  })

  it("caches regions per path: applying one path never uses a different path's cached regions", async () => {
    const fileA = await writePng('a.png', 300, 200, '#ffffff')
    const fileB = await writePng('b.png', 300, 200, '#ffffff')
    const regionA = rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Hello' })
    const regionB = rawRegion({ bbox: { x: 20, y: 130, w: 100, h: 30 }, text: 'World' })

    const fileABuffer = await readFile(fileA)
    const detectRegions = vi.fn().mockImplementation(async (buf: Buffer) => {
      return buf.equals(fileABuffer) ? [regionA] : [regionB]
    })
    const adapter = createImageAdapter({ detectRegions }, { sourceLang: 'English' })

    const segA = await adapter.extract(fileA)
    await adapter.extract(fileB) // extracting a SECOND path must not clobber fileA's cache entry

    const translatedA: TranslatedSegment[] = [
      {
        ...segA[0],
        translation: 'Bonjour',
        fittedSizePt: segA[0].font.sizePt,
        fittedLines: ['Bonjour']
      }
    ]
    const outA = fileA.replace('.png', '_out.png')
    await adapter.apply(fileA, outA, translatedA)

    const decoded = await decodeFile(outA)
    // fileA's own region (y:18-52) is painted...
    expect(regionRgb(decoded, 18, 18, 104, 34).some((p) => !isWhite(p))).toBe(true)
    // ...while fileB's bbox coordinates (y:128-162), which have nothing to
    // do with fileA, stay untouched in fileA's own output - a cache that
    // mixed the two paths up would paint here instead (or not at all at the
    // real fileA location).
    expect(regionRgb(decoded, 18, 128, 104, 34).every(isWhite)).toBe(true)
  })
})

describe('runPipeline end-to-end through the image adapter (behavior contract point 6)', () => {
  it('completes with a zero-segment report for a no-text image; output matches input dimensions', async () => {
    const file = await writePng('blank.png', 120, 80, '#3366cc')
    const engine = fakeEngine([]) // img10-style: no regions detected at all
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })
    const backend = fakeBackend()

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.total).toBe(0)
    expect(report.translated).toBe(0)
    expect(report.keptOriginal).toEqual([])
    expect(report.skippedUnsupported).toEqual([])
    expect(backend.translateBatch).not.toHaveBeenCalled()

    const outImg = await loadImage(await readFile(report.outPath))
    const inImg = await loadImage(await readFile(file))
    expect(outImg.width).toBe(inImg.width)
    expect(outImg.height).toBe(inImg.height)
  })

  it('translates a single detected region end to end and paints it into the output file', async () => {
    const file = await writePng('single.png', 300, 200, '#ffffff')
    const engine = fakeEngine([rawRegion({ bbox: { x: 20, y: 20, w: 150, h: 30 }, text: 'Hello' })])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })
    const backend = fakeBackend({
      translateBatch: vi
        .fn()
        .mockResolvedValue({ translations: [{ id: 'r1', translation: 'Bonjour' }] })
    })

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.total).toBe(1)
    expect(report.translated).toBe(1)

    const decoded = await decodeFile(report.outPath)
    // Dilated bbox {x:18,y:18,w:154,h:34} (2px/side growth, regions.ts).
    expect(regionRgb(decoded, 18, 18, 154, 34).some((p) => !isWhite(p))).toBe(true)
  })
})

describe("extract() + fit() wiring - ink-matched size survives fit() (regression: box.hPt used to equal the dilated bbox.h, so fit()'s height gate always shrank it straight back to the old h/1.2 heuristic)", () => {
  it('no width pressure: fittedSizePt equals the ink-matched font.sizePt exactly - fit() does not shrink it', async () => {
    const file = await writePng('wiring-no-shrink.png', 400, 200, '#ffffff')
    // Wide raw box (w:300) removes width as a constraint entirely - isolates
    // the height-budget fix this test exists to guard. h:30 is the same
    // ink-height fixture used by the sizing test above.
    const engine = fakeEngine([rawRegion({ bbox: { x: 20, y: 20, w: 300, h: 30 }, text: 'Hello' })])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })
    const applySpy = vi.spyOn(adapter, 'apply')
    const backend = fakeBackend({
      translateBatch: vi
        .fn()
        .mockResolvedValue({ translations: [{ id: 'r1', translation: 'Bonjour' }] })
    })

    await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(applySpy).toHaveBeenCalledTimes(1)
    const translatedSegments = applySpy.mock.calls[0][2] as TranslatedSegment[]
    const seg = translatedSegments.find((s) => s.id === 'r1')!
    // fittedSizePt EQUALS the ink-matched candidate bit-for-bit - proof
    // fit() accepted the starting size as-is instead of shrinking it.
    expect(seg.fittedSizePt).toBe(seg.font.sizePt)
    // And that candidate is still the (bigger) ink-matched size, not the old
    // h/1.2 heuristic - otherwise the equality above would hold for the
    // wrong reason.
    expect(seg.font.sizePt).toBeGreaterThan(34 / 1.2 + 1)
  })

  it('genuine width overflow still shrinks: a too-narrow region forces fit() below the ink-matched candidate', async () => {
    const file = await writePng('wiring-shrink.png', 300, 200, '#ffffff')
    // Narrow raw box (w:20) - the ink-matched candidate (tens of pt) cannot
    // lay out a multi-word translation within that width; the legitimate
    // width-driven shrink path must still work.
    const engine = fakeEngine([rawRegion({ bbox: { x: 20, y: 20, w: 20, h: 30 }, text: 'Hello' })])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })
    const applySpy = vi.spyOn(adapter, 'apply')
    const backend = fakeBackend({
      translateBatch: vi
        .fn()
        .mockResolvedValue({ translations: [{ id: 'r1', translation: 'Bonjour tout le monde' }] })
    })

    await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    const translatedSegments = applySpy.mock.calls[0][2] as TranslatedSegment[]
    const seg = translatedSegments.find((s) => s.id === 'r1')!
    expect(seg.fittedSizePt).toBeLessThan(seg.font.sizePt)
  })
})

describe('runPipeline pixel-exactness through the full pipeline (closes the gap: earlier pixel tests bypassed fit())', () => {
  it("paints a translated line through extract -> translate -> fit -> apply whose rendered ink-row extent is within 2px of the ORIGINAL text's", async () => {
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
    const inputBuffer = await srcCanvas.toBuffer('png')

    const dir = newTmpDir()
    const file = path.join(dir, 'pipeline-pixel.png')
    await writeFile(file, inputBuffer)

    // Recover the original's tight ink bbox by scanning pixels (not by
    // trusting the draw call's own font metrics) - mirrors
    // tests/core/images/overlay.test.ts's identical scan, run here through
    // the REAL pipeline (extract -> translate -> fit -> apply) instead of
    // calling renderOverlay directly, so this closes exactly the gap the
    // reviewer identified: every prior pixel test bypassed fit().
    const inputDecoded = await decodeFile(file)
    const origInk = scanInkBBox(inputDecoded, { x: 0, y: 0, w: width, h: height }, white)
    expect(origInk).not.toBeNull()
    const origInkHeightPx = origInk!.maxY - origInk!.minY + 1
    const rawBBox = {
      x: origInk!.minX,
      y: origInk!.minY,
      w: origInk!.maxX - origInk!.minX + 1,
      h: origInkHeightPx
    }

    // A genuinely different "translation" - proves this isn't just measuring
    // the same text against itself.
    const translation = 'Salut'
    const engine = fakeEngine([rawRegion({ bbox: rawBBox, text: originalText })])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })
    const backend = fakeBackend({
      translateBatch: vi.fn().mockResolvedValue({ translations: [{ id: 'r1', translation }] })
    })

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    const outputDecoded = await decodeFile(report.outPath)
    const dilatedBBox = {
      x: rawBBox.x - 2,
      y: rawBBox.y - 2,
      w: rawBBox.w + 4,
      h: rawBBox.h + 4
    }
    const scanWindow = {
      x: Math.max(0, dilatedBBox.x - 5),
      y: Math.max(0, dilatedBBox.y - 10),
      w: Math.min(width, dilatedBBox.w + 10),
      h: Math.min(height, dilatedBBox.h + 20)
    }
    const paintedInk = scanInkBBox(outputDecoded, scanWindow, white)
    expect(paintedInk).not.toBeNull()
    const paintedInkHeightPx = paintedInk!.maxY - paintedInk!.minY + 1

    // Charlie's "it really needs to be exact" requirement, driven through
    // the FULL pipeline (including fit()) rather than calling renderOverlay
    // directly - the painted replacement's rendered ink height must match
    // the original's, not the dilated fill box's inflated height, and not
    // whatever a defeated fit() would have shrunk it back down to.
    expect(Math.abs(paintedInkHeightPx - origInkHeightPx)).toBeLessThanOrEqual(2)
  })
})

describe('FIT_LINE_HEIGHT_FACTOR drift guard', () => {
  // image-adapter.ts cannot import fit-engine.ts's LINE_HEIGHT_FACTOR
  // (private, not exported) so it mirrors the value as
  // FIT_LINE_HEIGHT_FACTOR - this test proves the mirrored value is exactly
  // what fit-engine's own fitsBox() uses, by checking the fit/no-fit
  // boundary it produces rather than comparing the numbers directly (the two
  // modules have no shared import to do that). Mirrors
  // tests/core/images/overlay.test.ts's and
  // tests/core/pptx/pptx-adapter.test.ts's identical drift-guard blocks for
  // their own copies of the same constant. Width is set huge so only the
  // height term of fitsBox can decide the outcome.
  it('matches the fit engine at the fit/no-fit height boundary', () => {
    const font = { family: 'Noto Sans', sizePt: 20 }
    const sizePt = 20
    const lines = ['a', 'b', 'c']
    const wPt = 100000
    const mirrored = imageAdapterInternals.FIT_LINE_HEIGHT_FACTOR

    const fitsAtBoundary = fitInternals.measuredFits(
      lines,
      sizePt,
      { wPt, hPt: lines.length * sizePt * mirrored },
      font
    )
    const failsJustBelow = fitInternals.measuredFits(
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
    const mirrored = imageAdapterInternals.FIT_LINE_HEIGHT_FACTOR
    const r = fit('Hi', { wPt: 300, hPt: 24 * mirrored }, { family: 'Noto Sans', sizePt: 24 })
    expect(r.overflowed).toBe(false)
  })
})
