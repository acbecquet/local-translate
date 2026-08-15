import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RunReport } from '../../../src/core/pipeline'
import {
  BenchStore,
  configHash,
  modelSlug,
  type CellConfig,
  type StoredCell,
  type StoredJudgement
} from '../../../src/core/bench/store'

const tempDirs: string[] = []
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    file: 'fixtures/whatever.pptx',
    outPath: 'out/whatever.pptx',
    total: 1,
    translated: 1,
    keptOriginal: [],
    overflowed: [],
    segments: [
      { id: 's1', sourceText: 'hello', translation: 'hallo', fittedSizePt: 12, lineCount: 1 }
    ],
    skippedUnsupported: [],
    durationMs: 100,
    stats: {
      model: 'test-model',
      phaseMs: { extract: 10, connect: 0, translate: 50, fit: 20, apply: 20 },
      groups: 1,
      modelCalls: 1,
      groupRetries: 0,
      perSegmentFallbacks: 0,
      promptTokens: 10,
      completionTokens: 10,
      tokensPerSec: 5,
      charsSource: 5,
      charsTranslated: 5,
      segmentsPerMin: 1
    },
    ...overrides
  }
}

function makeConfig(overrides: Partial<CellConfig> = {}): CellConfig {
  return {
    model: 'qwen3.5:9b',
    itemId: 'item-1',
    sourceLang: 'English',
    targetLang: 'German',
    ...overrides
  }
}

function makeCell(overrides: Partial<StoredCell> = {}): StoredCell {
  const config = overrides.config ?? makeConfig()
  return {
    config,
    configHash: configHash(config),
    report: makeReport(),
    artifactPath: path.join('artifacts', modelSlug(config.model), `${config.itemId}.pptx`),
    completedAt: new Date().toISOString(),
    ...overrides
  }
}

describe('configHash (contract point 1)', () => {
  it('is stable regardless of key insertion order', () => {
    const a: CellConfig = {
      model: 'qwen3.5:9b',
      itemId: 'item-1',
      sourceLang: 'English',
      targetLang: 'German'
    }
    // Same values as `a`, deliberately built with different key insertion order.
    const b: CellConfig = {
      targetLang: 'German',
      sourceLang: 'English',
      itemId: 'item-1',
      model: 'qwen3.5:9b'
    }

    expect(configHash(a)).toBe(configHash(b))
  })

  it('changes when any single field changes', () => {
    const base = makeConfig()
    const baseHash = configHash(base)

    expect(configHash({ ...base, model: 'other-model' })).not.toBe(baseHash)
    expect(configHash({ ...base, itemId: 'other-item' })).not.toBe(baseHash)
    expect(configHash({ ...base, sourceLang: 'French' })).not.toBe(baseHash)
    expect(configHash({ ...base, targetLang: 'Spanish' })).not.toBe(baseHash)
  })
})

describe('saveCell / loadCell round-trip (contract point 2)', () => {
  it('round-trips a saved cell exactly', async () => {
    const storeDir = await makeTempDir('bench-store-roundtrip-')
    const store = new BenchStore(storeDir)
    const cell = makeCell()

    store.saveCell(cell)
    const loaded = store.loadCell(cell.config.model, cell.config.itemId)

    expect(loaded).toEqual(cell)
  })

  it('returns null for a cell that was never saved', async () => {
    const storeDir = await makeTempDir('bench-store-absent-')
    const store = new BenchStore(storeDir)

    expect(store.loadCell('never-run-model', 'never-run-item')).toBeNull()
  })
})

describe('saveCell atomicity (contract point 3)', () => {
  it('the destination stays absent while only a .tmp sibling exists, then becomes a complete parseable file once the rename lands', async () => {
    const storeDir = await makeTempDir('bench-store-atomic-')
    const store = new BenchStore(storeDir)
    const cell = makeCell({ config: makeConfig({ itemId: 'atomic-item' }) })
    const cellPath = path.join(storeDir, 'cells', modelSlug(cell.config.model), 'atomic-item.json')
    const tmpPath = `${cellPath}.tmp`

    // Simulate the moment mid-write: the .tmp sibling that saveCell's write
    // step would produce exists, but no rename has happened yet - this is
    // the write METHOD under test, not a spawned/killed process.
    await mkdir(path.dirname(tmpPath), { recursive: true })
    await writeFile(tmpPath, JSON.stringify(cell, null, 2))
    expect(existsSync(cellPath)).toBe(false)
    expect(store.loadCell(cell.config.model, 'atomic-item')).toBeNull()

    // The real saveCell call performs its own tmp-write-then-rename; once it
    // returns, the destination must be complete and parseable, and the
    // .tmp must be gone (a rename moves the file, it doesn't copy it).
    store.saveCell(cell)
    expect(existsSync(tmpPath)).toBe(false)
    const raw = await readFile(cellPath, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(store.loadCell(cell.config.model, 'atomic-item')).toEqual(cell)
  })
})

describe('corrupt files never throw (contract point 4)', () => {
  it('loadCell returns null for a truncated cell file instead of throwing', async () => {
    const storeDir = await makeTempDir('bench-store-corrupt-cell-')
    const store = new BenchStore(storeDir)
    const dir = path.join(storeDir, 'cells', modelSlug('broken-model'))
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'broken-item.json'), '{"config": {"model": "broken-model"')

    expect(() => store.loadCell('broken-model', 'broken-item')).not.toThrow()
    expect(store.loadCell('broken-model', 'broken-item')).toBeNull()
  })

  it('loadJudgement returns null for a truncated judgement file instead of throwing', async () => {
    const storeDir = await makeTempDir('bench-store-corrupt-judgement-')
    const store = new BenchStore(storeDir)
    const dir = path.join(
      storeDir,
      'judgements',
      modelSlug('judge-model'),
      modelSlug('scored-model')
    )
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'broken-item.json'), '{"judgeModel": "judge-model", "scores": [')

    expect(() => store.loadJudgement('judge-model', 'scored-model', 'broken-item')).not.toThrow()
    expect(store.loadJudgement('judge-model', 'scored-model', 'broken-item')).toBeNull()
  })
})

describe('judgement round-trip keyed under judge model (contract point 5)', () => {
  it('round-trips a saved judgement', async () => {
    const storeDir = await makeTempDir('bench-store-judgement-roundtrip-')
    const store = new BenchStore(storeDir)
    const cell = makeCell()
    const judgement: StoredJudgement = {
      judgeModel: 'qwen3.6:35b',
      promptVersion: 'v1',
      cellConfigHash: cell.configHash,
      scores: [{ segmentId: 's1', accuracy: 5, fluency: 4, format: 5 }],
      judgedAt: new Date().toISOString()
    }

    store.saveJudgement(cell.config.model, cell.config.itemId, judgement)
    const loaded = store.loadJudgement(judgement.judgeModel, cell.config.model, cell.config.itemId)

    expect(loaded).toEqual(judgement)
  })

  it('a different judge model never collides with an existing judgement for the same cell', async () => {
    const storeDir = await makeTempDir('bench-store-judgement-collision-')
    const store = new BenchStore(storeDir)
    const cell = makeCell()
    const judgement: StoredJudgement = {
      judgeModel: 'judge-a',
      promptVersion: 'v1',
      cellConfigHash: cell.configHash,
      scores: [{ segmentId: 's1', accuracy: 3, fluency: 3, format: 3 }],
      judgedAt: new Date().toISOString()
    }

    store.saveJudgement(cell.config.model, cell.config.itemId, judgement)

    expect(store.loadJudgement('judge-b', cell.config.model, cell.config.itemId)).toBeNull()
    expect(store.loadJudgement('judge-a', cell.config.model, cell.config.itemId)).toEqual(judgement)
  })
})

describe('listCells (contract point 6)', () => {
  it('returns every stored cell across every model, skipping corrupt files', async () => {
    const storeDir = await makeTempDir('bench-store-listcells-')
    const store = new BenchStore(storeDir)

    const cellA = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-1' }) })
    const cellB = makeCell({ config: makeConfig({ model: 'model-b', itemId: 'item-2' }) })
    store.saveCell(cellA)
    store.saveCell(cellB)

    // A corrupt file dropped directly into a model's cell directory must be
    // skipped, not thrown, by listCells.
    const brokenDir = path.join(storeDir, 'cells', modelSlug('model-a'))
    await writeFile(path.join(brokenDir, 'broken-item.json'), '{"config": {')

    const cells = store.listCells()

    expect(cells).toHaveLength(2)
    const itemIds = cells.map((c) => c.config.itemId).sort()
    expect(itemIds).toEqual(['item-1', 'item-2'])
  })
})

describe('modelSlug (contract point 7)', () => {
  it('replaces : and / with -', () => {
    expect(modelSlug('qwen3.5:9b')).toBe('qwen3.5-9b')
  })

  it('never contains a path separator, even for a namespaced model tag', () => {
    const slug = modelSlug('org/model-name:latest')

    expect(slug).not.toContain('/')
    expect(slug).not.toContain(':')
    expect(slug).not.toContain('\\')
  })
})

describe('BenchStore construction', () => {
  it('creates cells/, judgements/, and artifacts/ under dir', async () => {
    const root = await makeTempDir('bench-store-ctor-')
    const storeDir = path.join(root, 'nested-store-dir')

    new BenchStore(storeDir)

    expect(existsSync(path.join(storeDir, 'cells'))).toBe(true)
    expect(existsSync(path.join(storeDir, 'judgements'))).toBe(true)
    expect(existsSync(path.join(storeDir, 'artifacts'))).toBe(true)
  })

  it('exposes the constructor argument as .dir, so callers can resolve store-relative paths (e.g. artifactPathFor) to absolute ones', async () => {
    const root = await makeTempDir('bench-store-dir-field-')
    const storeDir = path.join(root, 'nested-store-dir')

    const store = new BenchStore(storeDir)

    expect(store.dir).toBe(storeDir)
  })
})

describe('artifactPathFor', () => {
  it('returns a store-relative path under artifacts/<modelSlug>/, preserving the source extension', async () => {
    const storeDir = await makeTempDir('bench-store-artifactpath-')
    const store = new BenchStore(storeDir)

    const result = store.artifactPathFor('qwen3.5:9b', 'item-1', 'some/nested/source.PPTX')

    expect(result).toBe(path.join('artifacts', 'qwen3.5-9b', 'item-1.PPTX'))
  })
})
