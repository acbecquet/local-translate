import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findAppRoot } from '../../src/core/app-root'

// findAppRoot used to be duplicated independently in fonts.ts and champion.ts
// (each with its own copy of the walk-up-to-package.json logic). It now
// lives here as the single implementation both import - see app-root.ts's
// own doc comment for why the walk-vs-fixed-hops approach matters and why a
// shared, dependency-free module was extracted rather than one module
// importing the other's copy.
describe('findAppRoot', () => {
  it('walks up from a nested start directory to the nearest ancestor containing package.json', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lt-approot-'))
    try {
      writeFileSync(path.join(root, 'package.json'), '{}')
      const nested = path.join(root, 'out', 'main')
      mkdirSync(nested, { recursive: true })

      expect(findAppRoot(nested)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns the start directory itself when it already contains package.json', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lt-approot-'))
    try {
      writeFileSync(path.join(root, 'package.json'), '{}')

      expect(findAppRoot(root)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the starting directory when no ancestor has a package.json (never loops forever)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lt-approot-'))
    try {
      const nested = path.join(root, 'a', 'b')
      mkdirSync(nested, { recursive: true })

      expect(findAppRoot(nested)).toBe(nested)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
