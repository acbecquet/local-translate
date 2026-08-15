import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_MODEL } from '../../src/core/defaults'
import {
  _internals,
  readChampion,
  resolveDefaultModel,
  writeChampion,
  type ChampionState
} from '../../src/core/champion'

const { resolveConfigDir, readChampionFrom, setConfigDirForTesting } = _internals

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs.length = 0
  // Defensive reset even on tests that never set it - see _internals'
  // own doc comment on why the override exists (avoiding cross-test-file
  // races on the repo's real committed config/champion.json).
  setConfigDirForTesting(null)
  vi.restoreAllMocks()
})

function newTmpDir(prefix = 'lt-champion-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function makeState(overrides: Partial<ChampionState> = {}): ChampionState {
  return {
    model: 'qwen3.5:9b',
    crownedAt: '2026-08-15T00:00:00.000Z',
    note: 'test fixture',
    ...overrides
  }
}

describe('resolveConfigDir (packaged-resources-first resolution, mirrors fonts.ts resolveFontsDir)', () => {
  it('prefers <resourcesPath>/config when it exists on disk (packaged Electron)', () => {
    const resourcesRoot = newTmpDir()
    const packagedConfig = path.join(resourcesRoot, 'config')
    mkdirSync(packagedConfig, { recursive: true })
    const appRoot = path.join(resourcesRoot, 'app.asar')
    mkdirSync(path.join(appRoot, 'out', 'main'), { recursive: true })
    writeFileSync(path.join(appRoot, 'package.json'), '{}')
    const moduleDir = path.join(appRoot, 'out', 'main')

    expect(resolveConfigDir(moduleDir, resourcesRoot)).toBe(packagedConfig)
  })

  it("falls back to <findAppRoot>/config when resourcesPath has no config folder (dev-mode Electron: resourcesPath points at Electron's own bundled resources, not this app's)", () => {
    const root = newTmpDir()
    writeFileSync(path.join(root, 'package.json'), '{}')
    mkdirSync(path.join(root, 'config'), { recursive: true })
    const moduleDir = path.join(root, 'src', 'core')
    mkdirSync(moduleDir, { recursive: true })
    const electronOwnResources = newTmpDir()

    expect(resolveConfigDir(moduleDir, electronOwnResources)).toBe(path.join(root, 'config'))
  })

  it('falls back to <findAppRoot>/config when resourcesPath is undefined (the CLI and every test/vitest run - never runs under Electron)', () => {
    const root = newTmpDir()
    writeFileSync(path.join(root, 'package.json'), '{}')
    const moduleDir = path.join(root, 'src', 'core')
    mkdirSync(moduleDir, { recursive: true })

    expect(resolveConfigDir(moduleDir, undefined)).toBe(path.join(root, 'config'))
  })
})

describe('readChampionFrom: valid, missing, and malformed (contract point 1)', () => {
  it('returns the parsed state for a valid champion.json', () => {
    const dir = newTmpDir()
    const state = makeState()
    writeFileSync(path.join(dir, 'champion.json'), JSON.stringify(state))

    expect(readChampionFrom(dir)).toEqual(state)
  })

  it('returns null silently (no console.warn) when champion.json is missing', () => {
    const dir = newTmpDir()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readChampionFrom(dir)).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('returns null and warns exactly once for unparseable JSON', () => {
    const dir = newTmpDir()
    writeFileSync(path.join(dir, 'champion.json'), '{ this is not valid json')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readChampionFrom(dir)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

describe('readChampionFrom: an empty/non-string model counts as malformed (contract point 2)', () => {
  it('warns exactly once and returns null when model is missing entirely', () => {
    const dir = newTmpDir()
    writeFileSync(
      path.join(dir, 'champion.json'),
      JSON.stringify({ crownedAt: '2026-08-15T00:00:00.000Z' })
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readChampionFrom(dir)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('warns exactly once and returns null when model is an empty string', () => {
    const dir = newTmpDir()
    writeFileSync(path.join(dir, 'champion.json'), JSON.stringify(makeState({ model: '' })))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readChampionFrom(dir)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('warns exactly once and returns null when model is whitespace-only', () => {
    const dir = newTmpDir()
    writeFileSync(path.join(dir, 'champion.json'), JSON.stringify(makeState({ model: '   ' })))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readChampionFrom(dir)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('warns exactly once and returns null when model is not a string', () => {
    const dir = newTmpDir()
    const raw = JSON.stringify({ ...makeState(), model: 42 })
    writeFileSync(path.join(dir, 'champion.json'), raw)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readChampionFrom(dir)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

describe('writeChampion (contract point 3)', () => {
  it('round-trips through readChampionFrom', () => {
    const repoRoot = newTmpDir()
    const state = makeState({ model: 'qwen3:30b' })

    writeChampion(state, repoRoot)

    expect(readChampionFrom(path.join(repoRoot, 'config'))).toEqual(state)
  })

  it('creates config/ on demand when repoRoot has no config directory yet', () => {
    const repoRoot = newTmpDir()
    expect(existsSync(path.join(repoRoot, 'config'))).toBe(false)

    writeChampion(makeState(), repoRoot)

    expect(existsSync(path.join(repoRoot, 'config', 'champion.json'))).toBe(true)
  })

  it('writes atomically: the destination stays absent while only a .tmp sibling exists, then becomes complete once the rename lands', () => {
    const repoRoot = newTmpDir()
    const dest = path.join(repoRoot, 'config', 'champion.json')
    const tmpPath = `${dest}.tmp`
    const state = makeState({ model: 'gemma4:12b' })

    // Simulate the moment mid-write: the .tmp sibling that writeChampion's
    // write step would produce exists, but no rename has happened yet -
    // this is the write METHOD under test, not a spawned/killed process.
    mkdirSync(path.dirname(tmpPath), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(state, null, 2))
    expect(existsSync(dest)).toBe(false)

    // The real writeChampion call performs its own tmp-write-then-rename;
    // once it returns, the destination must be complete and parseable, and
    // the .tmp must be gone (a rename moves the file, it doesn't copy it).
    writeChampion(state, repoRoot)

    expect(existsSync(tmpPath)).toBe(false)
    const raw = readFileSync(dest, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(readChampionFrom(path.join(repoRoot, 'config'))).toEqual(state)
  })
})

describe('readChampion / resolveDefaultModel: public API', () => {
  it('the real committed config/champion.json resolves and matches DEFAULT_MODEL in its pre-crowning placeholder state (read-only - proves the real findAppRoot-based resolution path)', () => {
    expect(readChampion()).toEqual({
      model: DEFAULT_MODEL,
      crownedAt: '2026-08-14T00:00:00.000Z',
      note: 'pre-benchmark placeholder, equals DEFAULT_MODEL until the phase-4 cohort crowns'
    })
    expect(resolveDefaultModel()).toBe(DEFAULT_MODEL)
  })

  it('a valid champion file with a model different from DEFAULT_MODEL wins over it (contract point 1)', () => {
    const dir = newTmpDir()
    const configDir = path.join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      path.join(configDir, 'champion.json'),
      JSON.stringify(makeState({ model: 'qwen3.5:9b' }))
    )
    setConfigDirForTesting(configDir)

    expect(resolveDefaultModel()).toBe('qwen3.5:9b')
    expect(resolveDefaultModel()).not.toBe(DEFAULT_MODEL)
  })

  it('falls back to DEFAULT_MODEL silently when champion.json is missing', () => {
    const dir = newTmpDir()
    const configDir = path.join(dir, 'config') // never created - no champion.json in it
    setConfigDirForTesting(configDir)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(resolveDefaultModel()).toBe(DEFAULT_MODEL)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('falls back to DEFAULT_MODEL with exactly one warn when champion.json is malformed', () => {
    const dir = newTmpDir()
    const configDir = path.join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, 'champion.json'), 'not json at all')
    setConfigDirForTesting(configDir)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(resolveDefaultModel()).toBe(DEFAULT_MODEL)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
