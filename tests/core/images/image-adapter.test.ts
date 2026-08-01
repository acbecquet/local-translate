import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Canvas, loadImage } from 'skia-canvas'
import { createImageAdapter } from '../../../src/core/adapters/images/image-adapter'
import {
  CONFIDENCE_FLOOR,
  type RegionEngine,
  type TextRegion
} from '../../../src/core/images/regions'
import type { TranslatedSegment } from '../../../src/core/segments'
import { runPipeline } from '../../../src/core/pipeline'
import type { TranslationBackend } from '../../../src/core/translate/backend'

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
    // the 400x300 image so the final clamp is a no-op.
    expect(seg.box).toEqual({ wPt: 104, hPt: 34 })
    expect(seg.font.sizePt).toBeCloseTo(34 / 1.2)
    expect(seg.font.family).toBe('Noto Sans')
  })

  it('picks the CJK font family when the region text contains CJK, independent of source language', async () => {
    const file = await writePng('photo2.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: '你好世界' })
    ])
    const adapter = createImageAdapter(engine, { sourceLang: 'English' })

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

  it('keeps every region under a non-CJK source language, including CJK text (v1: no filtering)', async () => {
    const file = await writePng('deck3.png', 400, 300)
    const engine = fakeEngine([
      rawRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: '你好世界' })
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
