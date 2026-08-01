// PP-OCRv4 region engine via @gutenye/ocr-node, CPU only. Winner of the
// Phase 3 region-engine spike; see the decision doc:
// docs/research/2026-07-31-phase-3-spike-image-regions.md
// Ported from scripts/spike-image-regions.mjs's createPPOcrEngine, which is
// the exact invocation this file keeps (path-only detect() API, temp-file
// spill, cleanup in finally).
import { unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RegionBBox, RegionEngine, TextRegion } from '../regions'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8])

/** detect() takes a file path only (its ImageRaw loader wraps `sharp(path)`)
 * - there is no documented Buffer-input entry point, so every buffer is
 * spilled to a short-lived temp file instead. Extension is picked by magic
 * bytes, not by any filename the caller might have used, since the engine
 * interface is buffer-only and carries no filename. */
function sniffExtension(buffer: Buffer): string {
  if (buffer.subarray(0, 4).equals(PNG_MAGIC)) return '.png'
  if (buffer.subarray(0, 2).equals(JPEG_MAGIC)) return '.jpg'
  throw new Error('sniffExtension: buffer is neither PNG nor JPEG (unexpected magic bytes)')
}

// A detection polygon whose top edge deviates from horizontal by more than
// this is treated as rotated text. PP-OCR's minAreaRect boxes carry a few
// degrees of jitter even on straight horizontal text (font italics,
// antialiasing, kerning), so this stays well above zero to avoid flagging
// ordinary text as rotated; it's still small enough to catch genuine
// rotated/vertical labels (e.g. a chart's rotated y-axis title - the
// decision doc's known limitation #4, out of scope v1: skip-with-log).
const ROTATION_THRESHOLD_DEG = 5

/** box is a 4-point polygon [TL, TR, BR, BL], clockwise, from PP-OCR's
 * minAreaRect detection (see @gutenye/ocr-common's getMiniBoxes/
 * orderPointsClockwise). The angle of the TL->TR edge from horizontal is a
 * conservative, cheap proxy for how far the whole box is rotated. */
function isRotated(box: number[][]): boolean {
  const [topLeft, topRight] = box
  const dx = topRight[0] - topLeft[0]
  const dy = topRight[1] - topLeft[1]
  const angleDeg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI
  return angleDeg > ROTATION_THRESHOLD_DEG
}

function boxToBBox(box: number[][]): RegionBBox {
  const xs = box.map((p) => p[0])
  const ys = box.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** The one shape @gutenye/ocr-node's Ocr instance needs to expose for this
 * module's purposes - narrower than its full class so tests can mock it
 * without importing the real package (which pulls in onnxruntime-node and
 * sharp; MACHINE RULES forbid real ONNX inference from a test run). */
interface OcrLine {
  text: string
  mean: number
  box?: number[][]
}

interface OcrInstance {
  detect(imagePath: string): Promise<OcrLine[]>
}

/**
 * Creates a RegionEngine backed by @gutenye/ocr-node's ch_PP-OCRv4 model
 * (the package's bundled default - Chinese/multilingual det+rec, reads CJK
 * and Latin both, no separate model selection needed). The Ocr instance is
 * expensive to create (loads two ONNX sessions) and is lazily created once
 * on first detectRegions() call, then reused for every later call.
 */
export function createPPOcrEngine(): RegionEngine {
  let ocrPromise: Promise<OcrInstance> | null = null

  async function getOcr(): Promise<OcrInstance> {
    if (!ocrPromise) {
      ocrPromise = (async () => {
        const { default: Ocr } = await import('@gutenye/ocr-node')
        return (await Ocr.create()) as unknown as OcrInstance
      })()
    }
    return ocrPromise
  }

  return {
    async detectRegions(image: Buffer): Promise<TextRegion[]> {
      const ocr = await getOcr()
      const ext = sniffExtension(image)
      // pid+timestamp+random: unique across concurrent calls in the same
      // process and across processes, without needing a coordinating lock.
      const tmpPath = path.join(
        os.tmpdir(),
        `ppocr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      )
      await writeFile(tmpPath, image)
      try {
        const lines = await ocr.detect(tmpPath)
        // A line with no detection polygon has no usable location at all;
        // dropping it here (rather than emitting a degenerate 0x0 bbox and
        // relying on validateRegions' noise floor to catch it) keeps this
        // engine's contract honest: every TextRegion it emits has real
        // geometry.
        const withBox = lines.filter(
          (line): line is OcrLine & { box: number[][] } => !!line.box && line.box.length > 0
        )
        return withBox.map((line, i) => ({
          id: `r${i + 1}`,
          bbox: boxToBBox(line.box),
          text: line.text,
          confidence: line.mean,
          rotated: isRotated(line.box)
        }))
      } finally {
        await unlink(tmpPath).catch(() => {})
      }
    }
  }
}
