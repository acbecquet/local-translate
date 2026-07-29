import { Canvas, FontLibrary, type CanvasRenderingContext2D } from 'skia-canvas'
import path from 'node:path'

const FONTS_DIR = path.resolve(__dirname, '../../../fonts')
let registered = false
const knownFamilies = new Set<string>()

export function registerBundledFonts(): void {
  if (registered) return
  const entries = [
    { family: 'Noto Sans', files: ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'] },
    { family: 'Noto Sans CJK SC', files: ['NotoSansSC-Regular.otf'] }
  ]
  for (const e of entries) {
    FontLibrary.use(
      e.family,
      e.files.map((f) => path.join(FONTS_DIR, f))
    )
    knownFamilies.add(e.family)
  }
  for (const fam of FontLibrary.families) knownFamilies.add(fam)
  registered = true
}

export function resolveFamily(requested: string): { family: string; substituted: boolean } {
  if (knownFamilies.has(requested)) return { family: requested, substituted: false }
  return { family: 'Noto Sans', substituted: true }
}

// This module is the only place that knows which canvas library backs text
// measurement. Callers (fit-engine.ts and anything else that needs to measure
// text) get a 2D context, not a canvas library, so swapping the backend never
// touches consumers.
let measurementCtx: CanvasRenderingContext2D | null = null

export function measureCtx(): CanvasRenderingContext2D {
  if (!measurementCtx) {
    const canvas = new Canvas(8, 8) // throwaway measurement surface, never rendered
    measurementCtx = canvas.getContext('2d')
  }
  return measurementCtx
}
