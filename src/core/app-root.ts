// Shared by fonts.ts and champion.ts (and any future module with the same
// need): locates the app root by walking up from a starting directory until
// a package.json is found. Depends on nothing but node:fs/node:path, which
// is the whole point of this module existing on its own - fonts.ts pulls in
// skia-canvas at module scope, and champion.ts resolves the app's default
// model on essentially every CLI/app startup path, so it must not force-load
// a rendering library's native addon just to find the repo root. Lifted out
// of fonts.ts (which used to own this function, duplicated verbatim into
// champion.ts to avoid that exact coupling) into this dependency-free module
// so both import the same implementation instead of maintaining two copies.

import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Locates the app root - the nearest ancestor directory of `startDir` that
 * contains a package.json - by walking up rather than hardcoding a fixed
 * number of `..` hops. A fixed hop count breaks under bundling: a module's
 * *source* location can sit several directories below the repo root, but a
 * bundler can inline it to a different depth - a fixed `../../../` walks
 * one directory too far (or too few) and never finds the intended sibling
 * (a real bug once caught by tests/e2e/runner.spec.ts driving the built
 * app: fonts.ts's old fixed-hop version resolved to `N:\fonts` instead of
 * `N:\local_translate\fonts`). Walking up to the package.json marker instead
 * works identically whether a module runs from its original source path
 * (tsx, vitest) or bundled to any other depth, since it never assumes a
 * specific starting depth.
 */
export function findAppRoot(startDir: string): string {
  let dir = startDir
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) {
      // Reached the filesystem root without finding package.json - fall
      // back to the starting directory rather than looping forever; the
      // caller simply fails to find whatever it was looking for relative to
      // the app root, the same observable failure a fixed hop-count
      // approach would have had.
      return startDir
    }
    dir = parent
  }
}
