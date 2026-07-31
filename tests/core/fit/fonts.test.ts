import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  findAppRoot,
  registerBundledFonts,
  resolveFamily,
  resolveFontsDir
} from '../../../src/core/fit/fonts'

describe('fonts', () => {
  it('registers bundled fonts idempotently and resolves known families', () => {
    registerBundledFonts()
    registerBundledFonts() // second call must not throw or duplicate
    expect(resolveFamily('Noto Sans')).toEqual({ family: 'Noto Sans', substituted: false })
  })

  it('substitutes unknown families to a bundled fallback', () => {
    registerBundledFonts()
    const r = resolveFamily('Calibri-Not-Installed-XYZ')
    expect(r.substituted).toBe(true)
    expect(['Noto Sans', 'Noto Sans CJK SC']).toContain(r.family)
  })
})

describe('findAppRoot', () => {
  it('walks up from a nested start directory to the nearest ancestor containing package.json', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lt-fonts-approot-'))
    try {
      writeFileSync(path.join(root, 'package.json'), '{}')
      const nested = path.join(root, 'out', 'main')
      mkdirSync(nested, { recursive: true })

      expect(findAppRoot(nested)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the starting directory when no ancestor has a package.json (never loops forever)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lt-fonts-approot-'))
    try {
      const nested = path.join(root, 'a', 'b')
      mkdirSync(nested, { recursive: true })

      expect(findAppRoot(nested)).toBe(nested)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('resolveFontsDir', () => {
  /**
   * Simulates electron-builder.yml's extraResources layout: fonts/** shipped
   * to resources/fonts, a SIBLING of the packaged app root (app.asar or its
   * unpacked equivalent), not a child of it - so the resources/fonts probe
   * has to be tried explicitly rather than falling out of findAppRoot's own
   * package.json walk (which would stop one level too deep, inside the app
   * root, and never see a sibling directory).
   */
  it('prefers <resourcesPath>/fonts when it exists on disk (packaged Electron)', () => {
    const resourcesRoot = mkdtempSync(path.join(tmpdir(), 'lt-fonts-resources-'))
    try {
      const packagedFonts = path.join(resourcesRoot, 'fonts')
      mkdirSync(packagedFonts, { recursive: true })
      const appRoot = path.join(resourcesRoot, 'app.asar')
      mkdirSync(path.join(appRoot, 'out', 'main'), { recursive: true })
      writeFileSync(path.join(appRoot, 'package.json'), '{}')
      const moduleDir = path.join(appRoot, 'out', 'main')

      expect(resolveFontsDir(moduleDir, resourcesRoot)).toBe(packagedFonts)
    } finally {
      rmSync(resourcesRoot, { recursive: true, force: true })
    }
  })

  it("falls back to <findAppRoot>/fonts when resourcesPath has no fonts folder (dev-mode Electron: resourcesPath points at Electron's own bundled resources, not this app's)", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lt-fonts-devroot-'))
    try {
      writeFileSync(path.join(root, 'package.json'), '{}')
      mkdirSync(path.join(root, 'fonts'), { recursive: true })
      const moduleDir = path.join(root, 'src', 'core', 'fit')
      mkdirSync(moduleDir, { recursive: true })

      // resourcesPath is set (as it always is under real Electron) but has
      // no fonts/ subfolder of its own - e.g. electron-vite dev, where it
      // points into node_modules/electron's bundled resources.
      const electronOwnResources = mkdtempSync(path.join(tmpdir(), 'lt-fonts-electron-'))
      try {
        expect(resolveFontsDir(moduleDir, electronOwnResources)).toBe(path.join(root, 'fonts'))
      } finally {
        rmSync(electronOwnResources, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to <findAppRoot>/fonts when resourcesPath is undefined (the CLI and every test/vitest run - never runs under Electron)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lt-fonts-clidev-'))
    try {
      writeFileSync(path.join(root, 'package.json'), '{}')
      const moduleDir = path.join(root, 'src', 'core', 'fit')
      mkdirSync(moduleDir, { recursive: true })

      expect(resolveFontsDir(moduleDir, undefined)).toBe(path.join(root, 'fonts'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
