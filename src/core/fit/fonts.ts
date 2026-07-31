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
  process.resourcesPath
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
