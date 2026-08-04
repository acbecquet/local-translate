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
export function findAppRoot(startDir: string): string {
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

/**
 * Resolves the directory holding the bundled font files, preferring the
 * packaged app's extraResources fonts folder over the dev-mode findAppRoot()
 * walk:
 *
 * 1. `<resourcesPath>/fonts` - electron-builder.yml ships repo-root fonts/**
 *    to `resources/fonts` via extraResources, which lands as a SIBLING of
 *    the packaged app root (app.asar or its unpacked equivalent), not a
 *    child of it - findAppRoot's own package.json walk stops one level too
 *    deep to ever see it, so it has to be tried explicitly. Only trusted
 *    when it actually exists on disk: in `electron-vite dev`, Electron sets
 *    `resourcesPath` to its OWN bundled resources folder (inside
 *    node_modules/electron), which has no `fonts/` of ours, so this probe
 *    correctly fails there and falls through to (2) - same for every
 *    non-Electron run (`resourcesPath` is undefined outside Electron).
 * 2. `findAppRoot(moduleDir)/fonts` - the repo-root fonts/ directory,
 *    correct for dev (electron-vite dev), the CLI (always run from source
 *    via tsx, never packaged), and tests. Unchanged from before this
 *    function existed - this is the sole behavior for every environment
 *    that isn't a packaged Electron build.
 *
 * `resourcesPath` is Electron's `process.resourcesPath` - read by the one
 * call site below via the bare `process` global (no `electron` import), so
 * this stays true to src/core's Electron-free rule while still resolving
 * correctly once packaged. `exists` is injected (default `fs.existsSync`) so
 * this is testable against a faked resources layout without touching
 * Electron or leaving the temp fixture behind.
 */
export function resolveFontsDir(
  moduleDir: string,
  resourcesPath: string | undefined,
  exists: (p: string) => boolean = existsSync
): string {
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'fonts')
    if (exists(packaged)) return packaged
  }
  return path.join(findAppRoot(moduleDir), 'fonts')
}

const FONTS_DIR = resolveFontsDir(
  path.dirname(fileURLToPath(import.meta.url)),
  // Cast, not the ambient electron.d.ts type: that augmentation only reaches
  // this file while something in the same TS program imports 'electron', and
  // it also declares resourcesPath always-present when it is genuinely
  // undefined outside Electron (CLI via tsx, vitest). The local optional type
  // keeps src/core's typecheck self-sufficient and honest about undefined.
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
)
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

/**
 * The one sanctioned way to construct a skia-canvas Canvas anywhere in this
 * codebase - it forces CPU rendering (`gpu = false`) before first use.
 *
 * skia-canvas defaults to GPU rendering (Vulkan on Windows/Linux), which
 * pulls the live GPU driver INTO this process: measured on the dev machine,
 * a default Canvas loads amdvlk64.dll (twice, from two different driver
 * stores), vulkan-1.dll, the d3d stack, and even third-party Vulkan overlay
 * layers (RivaTuner's RTSSVkLayer64.dll) - none of which load with
 * gpu=false. That is not a theoretical concern: the phase-3 gate runs died
 * with a raw 0xC0000005 in the CLI's node process at the exact moment
 * ollama's ROCm model load stormed the same discrete GPU our Vulkan context
 * lived on (diagnosed 2026-08-04; the identical pipeline against a fake
 * ollama server, no GPU load, runs clean end to end). A batch document
 * pipeline gains nothing from GPU rasterization, and CPU rendering also
 * matches CI's GPU-less runners exactly, so pixel tests assert the same
 * rasterizer everywhere. A static policy test keeps `new Canvas(` calls
 * from creeping in outside this function.
 */
export function createCanvas(width: number, height: number): Canvas {
  const canvas = new Canvas(width, height)
  canvas.gpu = false
  return canvas
}

// This module is the only place that knows which canvas library backs text
// measurement. Callers (fit-engine.ts and anything else that needs to measure
// text) get a 2D context, not a canvas library, so swapping the backend never
// touches consumers.
let measurementCtx: CanvasRenderingContext2D | null = null

export function measureCtx(): CanvasRenderingContext2D {
  if (!measurementCtx) {
    const canvas = createCanvas(8, 8) // throwaway measurement surface, never rendered
    measurementCtx = canvas.getContext('2d')
  }
  return measurementCtx
}
