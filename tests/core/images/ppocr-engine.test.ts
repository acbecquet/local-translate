import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'

// Mocks the `@gutenye/ocr-node` npm package itself, not our own module: the
// real package pulls in onnxruntime-node + sharp and would load actual ONNX
// models - MACHINE RULES forbid real inference in an agent-run test. Every
// test here exercises createPPOcrEngine's own logic (temp-file spill,
// cleanup, line-to-TextRegion mapping) against a fake Ocr instance.
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  detect: vi.fn()
}))

vi.mock('@gutenye/ocr-node', () => ({
  default: { create: mocks.create }
}))

const { createPPOcrEngine } = await import('../../../src/core/images/engines/ppocr')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0])

function pngBuffer(): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from('fake-png-body')])
}

function jpegBuffer(): Buffer {
  return Buffer.concat([JPEG_SIGNATURE, Buffer.from('fake-jpeg-body')])
}

beforeEach(() => {
  mocks.create.mockReset()
  mocks.detect.mockReset()
  mocks.create.mockResolvedValue({ detect: mocks.detect })
})

describe('createPPOcrEngine - lazy init', () => {
  it('does not create the Ocr instance until the first detectRegions() call', () => {
    createPPOcrEngine()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('creates the Ocr instance exactly once and reuses it across multiple detectRegions() calls', async () => {
    mocks.detect.mockResolvedValue([])
    const engine = createPPOcrEngine()

    await engine.detectRegions(pngBuffer())
    await engine.detectRegions(pngBuffer())
    await engine.detectRegions(jpegBuffer())

    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.detect).toHaveBeenCalledTimes(3)
  })

  it('retries init on a later call after a failed first init instead of caching the rejection forever', async () => {
    // Init can fail transiently (AV scanning model files, FS pressure) and
    // the engine lives inside a long-running Electron session - a cached
    // rejected promise would replay the same stale error for the rest of
    // the process lifetime.
    mocks.detect.mockResolvedValue([])
    mocks.create
      .mockRejectedValueOnce(new Error('transient: model file locked'))
      .mockResolvedValueOnce({ detect: mocks.detect })
    const engine = createPPOcrEngine()

    await expect(engine.detectRegions(pngBuffer())).rejects.toThrow('transient: model file locked')
    await expect(engine.detectRegions(pngBuffer())).resolves.toEqual([])

    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(mocks.detect).toHaveBeenCalledTimes(1)
  })
})

describe('createPPOcrEngine - buffer-to-tempfile flow', () => {
  it('spills a PNG buffer to a temp file under os.tmpdir() with a .png extension, passing that path to detect()', async () => {
    mocks.detect.mockResolvedValue([])
    const engine = createPPOcrEngine()

    await engine.detectRegions(pngBuffer())

    expect(mocks.detect).toHaveBeenCalledTimes(1)
    const tmpPath = mocks.detect.mock.calls[0][0] as string
    expect(tmpPath.startsWith(os.tmpdir())).toBe(true)
    expect(tmpPath.endsWith('.png')).toBe(true)
  })

  it('spills a JPEG buffer to a temp file with a .jpg extension, detected by magic bytes not filename', async () => {
    mocks.detect.mockResolvedValue([])
    const engine = createPPOcrEngine()

    await engine.detectRegions(jpegBuffer())

    const tmpPath = mocks.detect.mock.calls[0][0] as string
    expect(tmpPath.endsWith('.jpg')).toBe(true)
  })

  it('throws a clear error for a buffer that is neither PNG nor JPEG, without ever calling detect()', async () => {
    const engine = createPPOcrEngine()

    await expect(engine.detectRegions(Buffer.from('not an image'))).rejects.toThrow(
      /neither PNG nor JPEG/
    )
    expect(mocks.detect).not.toHaveBeenCalled()
  })

  it('writes the actual buffer bytes to the temp file before calling detect(), and removes it after a successful call', async () => {
    let observedTmpPath = ''
    mocks.detect.mockImplementation(async (tmpPath: string) => {
      observedTmpPath = tmpPath
      const written = await readFile(tmpPath)
      expect(written.subarray(0, 4)).toEqual(PNG_SIGNATURE.subarray(0, 4))
      return []
    })
    const engine = createPPOcrEngine()

    await engine.detectRegions(pngBuffer())

    expect(observedTmpPath).not.toBe('')
    expect(existsSync(observedTmpPath)).toBe(false)
  })

  it('removes the temp file even when detect() throws, and rethrows the original error (cleanup-on-throw)', async () => {
    let observedTmpPath = ''
    mocks.detect.mockImplementation(async (tmpPath: string) => {
      observedTmpPath = tmpPath
      throw new Error('inference boom')
    })
    const engine = createPPOcrEngine()

    await expect(engine.detectRegions(pngBuffer())).rejects.toThrow('inference boom')

    expect(observedTmpPath).not.toBe('')
    expect(existsSync(observedTmpPath)).toBe(false)
  })
})

describe('createPPOcrEngine - line-to-TextRegion mapping', () => {
  it('maps bbox from the detection polygon extents (min/max of the 4 points), passing text and confidence straight through', async () => {
    mocks.detect.mockResolvedValue([
      {
        text: 'Hello',
        mean: 0.87,
        box: [
          [10, 20],
          [110, 20],
          [110, 50],
          [10, 50]
        ]
      }
    ])
    const engine = createPPOcrEngine()

    const regions = await engine.detectRegions(pngBuffer())

    expect(regions).toHaveLength(1)
    expect(regions[0].bbox).toEqual({ x: 10, y: 20, w: 100, h: 30 })
    expect(regions[0].text).toBe('Hello')
    expect(regions[0].confidence).toBe(0.87)
  })

  it('maps multiple lines in the order detect() returned them, each with its own confidence', async () => {
    mocks.detect.mockResolvedValue([
      {
        text: 'First',
        mean: 0.95,
        box: [
          [0, 0],
          [50, 0],
          [50, 20],
          [0, 20]
        ]
      },
      {
        text: 'Second',
        mean: 0.42,
        box: [
          [0, 100],
          [60, 100],
          [60, 120],
          [0, 120]
        ]
      }
    ])
    const engine = createPPOcrEngine()

    const regions = await engine.detectRegions(pngBuffer())

    expect(regions.map((r) => ({ text: r.text, confidence: r.confidence }))).toEqual([
      { text: 'First', confidence: 0.95 },
      { text: 'Second', confidence: 0.42 }
    ])
  })

  it('drops a detected line with no polygon rather than emitting a degenerate region', async () => {
    mocks.detect.mockResolvedValue([
      { text: 'NoBox', mean: 0.9 }, // box omitted entirely - no usable location
      {
        text: 'HasBox',
        mean: 0.8,
        box: [
          [0, 0],
          [20, 0],
          [20, 20],
          [0, 20]
        ]
      }
    ])
    const engine = createPPOcrEngine()

    const regions = await engine.detectRegions(pngBuffer())

    expect(regions.map((r) => r.text)).toEqual(['HasBox'])
  })
})

describe('createPPOcrEngine - rotated flag', () => {
  it('flags rotated:false for an axis-aligned detection polygon', async () => {
    mocks.detect.mockResolvedValue([
      {
        text: 'Straight',
        mean: 0.9,
        box: [
          [0, 0],
          [100, 0],
          [100, 30],
          [0, 30]
        ]
      }
    ])
    const engine = createPPOcrEngine()

    const regions = await engine.detectRegions(pngBuffer())

    expect(regions[0].rotated).toBe(false)
  })

  it('flags rotated:true for an axis-aligned but VERTICAL-shaped multi-char box (gate round 2: in-place garble of a vertical axis title)', async () => {
    // The real deck's "TPM (mg/puff)" came back as a perfectly axis-aligned
    // 24x108 box (TL->TR edge horizontal - the angle proxy reads 0) whose
    // text was read sideways into "(nd/6w) Wd1"; unflagged, it translated
    // and painted horizontally over the vertical title.
    mocks.detect.mockResolvedValue([
      {
        text: '(nd/6w) Wd1',
        mean: 0.89,
        box: [
          [36, 190],
          [60, 190],
          [60, 298],
          [36, 298]
        ]
      }
    ])
    const engine = createPPOcrEngine()

    const regions = await engine.detectRegions(pngBuffer())

    expect(regions[0].rotated).toBe(true)
  })

  it('does NOT flag a tall-but-short-text box (a thin axis digit) as rotated', async () => {
    mocks.detect.mockResolvedValue([
      {
        text: '5',
        mean: 0.97,
        box: [
          [61, 214],
          [72, 214],
          [72, 233],
          [61, 233]
        ]
      }
    ])
    const engine = createPPOcrEngine()

    const regions = await engine.detectRegions(pngBuffer())

    expect(regions[0].rotated).toBe(false)
  })

  it('flags rotated:true when the detection polygon is significantly skewed from axis-aligned', async () => {
    mocks.detect.mockResolvedValue([
      {
        text: 'Skewed',
        mean: 0.9,
        // Top edge (point 0 -> point 1) runs at 45 degrees from horizontal.
        box: [
          [0, 0],
          [50, 50],
          [20, 80],
          [-30, 30]
        ]
      }
    ])
    const engine = createPPOcrEngine()

    const regions = await engine.detectRegions(pngBuffer())

    expect(regions[0].rotated).toBe(true)
  })
})
