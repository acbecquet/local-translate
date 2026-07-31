import { Canvas, FontLibrary, type CanvasRenderingContext2D } from 'skia-canvas'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Locates the app root - the nearest ancestor directory of `startDir` that
 * contains a package.json - by walking up rather than hardcoding a fixed
 * number of `..` hops. A fixed hop count breaks under bundling: this
 * module's *source* location (src/core/fit/fonts.ts) sits 3 directories
 * below the repo root, but electron-vite's production build inlines it
 * into a single out/main/index.js, only 2 directories below - a fixed
 * `../../../` walks one directory too far and never finds fonts/ (a real
 * bug caught by tests/e2e/runner.spec.ts driving the built app: it
 * resolved to `N:\fonts` instead of `N:\local_translate\fonts`). Walking up
 * to the package.json marker instead works identically whether this module
 * runs from its original source path (tsx, vitest) or bundled to any other
 * depth, since it never assumes a specific starting depth.
 */
function findAppRoot(startDir: string): string {
  let dir = startDir
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) {
      // Reached the filesystem root without finding package.json - fall
      // back to the starting directory rather than looping forever;
      // registerBundledFonts() will simply fail to find the font files, the
      // same observable failure the old fixed-hop-count code would have had.
      return startDir
    }
    dir = parent
  }
}

const FONTS_DIR = path.join(findAppRoot(path.dirname(fileURLToPath(import.meta.url))), 'fonts')
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
