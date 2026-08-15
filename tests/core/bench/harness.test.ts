import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FormatAdapter } from '../../../src/core/adapters/adapter'
import { FakeAdapter } from '../../../src/core/adapters/fake/fake-adapter'
import type { RunReport } from '../../../src/core/pipeline'
import type { TextSegment } from '../../../src/core/segments'
import type { BatchRequest, TranslationBackend } from '../../../src/core/translate/backend'
import type { OllamaConnection } from '../../../src/core/translate/ollama/lifecycle'
import {
  BenchStore,
  configHash,
  type CellConfig,
  type StoredCell
} from '../../../src/core/bench/store'
import type { Corpus, CorpusItem } from '../../../src/core/bench/corpus'
import {
  _internals,
  realHarnessDeps,
  runMatrix,
  type HarnessDeps,
  type HarnessEvent
} from '../../../src/core/bench/harness'

const tempDirs: string[] = []
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

// --- fixtures --------------------------------------------------------------

function seg(overrides: Partial<TextSegment> & { id: string; text: string }): TextSegment {
  return {
    box: { wPt: 400, hPt: 200 },
    font: { family: 'Noto Sans', sizePt: 18 },
    context: 'doc',
    kind: 'fake',
    ...overrides
  }
}

/** Writes a `.fake.json` fixture under `repoRoot/items/<id>.fake.json`, returns its repo-root-relative path (forward slashes, matching corpus.test.ts's own convention). */
async function writeFakeItem(
  repoRoot: string,
  id: string,
  segments: TextSegment[]
): Promise<string> {
  const rel = path.join('items', `${id}.fake.json`)
  const abs = path.join(repoRoot, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, JSON.stringify({ segments }))
  return rel.replace(/\\/g, '/')
}

function corpusItem(overrides: Partial<CorpusItem> & { id: string; file: string }): CorpusItem {
  return {
    sourceLang: 'English',
    targetLang: 'German',
    kind: 'pptx',
    ...overrides
  }
}

function fakeConnection(stop = vi.fn().mockResolvedValue(undefined)): OllamaConnection {
  return { baseUrl: 'http://127.0.0.1:1', spawned: false, stop }
}

/**
 * Narrows a HarnessEvent to its cell-failed shape. Not expressible via
 * `Extract<HarnessEvent, { type: 'cell-failed' }>`: the 'cell-failed' and
 * 'model-aborted' variants share ONE union member with `type: 'cell-failed'
 * | 'model-aborted'`, so Extract's structural check (is this whole member
 * assignable to `{ type: 'cell-failed' }`?) discards it entirely rather than
 * narrowing the literal - hence a hand-written predicate instead.
 */
function isCellFailedEvent(
  e: HarnessEvent
): e is { type: 'cell-failed'; model: string; itemId: string; error: string } {
  return e.type === 'cell-failed'
}

/** Deterministic fake backend: every translation is `[<targetLang>] <source text>` - never touches the network. */
function fakeTranslatingBackend(
  translateBatch = vi.fn().mockImplementation(async (req: BatchRequest) => ({
    translations: req.segments.map((s) => ({
      id: s.id,
      translation: `[${req.targetLang}] ${s.text}`
    }))
  }))
): TranslationBackend {
  return {
    listModels: vi.fn().mockResolvedValue([]),
    pullModel: vi.fn().mockResolvedValue(undefined),
    translateBatch
  }
}

function makeMinimalReport(): RunReport {
  return {
    file: 'items/placeholder.fake.json',
    outPath: 'items/placeholder_translated.fake.json',
    total: 1,
    translated: 1,
    keptOriginal: [],
    overflowed: [],
    segments: [
      {
        id: 's1',
        sourceText: 'placeholder',
        translation: 'placeholder',
        fittedSizePt: 12,
        lineCount: 1
      }
    ],
    skippedUnsupported: [],
    durationMs: 1,
    stats: {
      model: 'model-a',
      phaseMs: { extract: 0, connect: 0, translate: 0, fit: 0, apply: 0 },
      groups: 0,
      modelCalls: 0,
      groupRetries: 0,
      perSegmentFallbacks: 0,
      promptTokens: 0,
      completionTokens: 0,
      tokensPerSec: 0,
      charsSource: 0,
      charsTranslated: 0,
      segmentsPerMin: 0
    }
  }
}

// --- contract point 1: model-major order + unloadModel timing --------------

describe('runMatrix - model-major order and unloadModel timing (contract point 1)', () => {
  it('runs all of model A cells before model B starts, unloading each model exactly once in between', async () => {
    const repoRoot = await makeTempDir('bench-harness-order-')
    const store = new BenchStore(await makeTempDir('bench-harness-order-store-'))
    const appDataDir = await makeTempDir('bench-harness-order-appdata-')

    const file1 = await writeFakeItem(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hello' })])
    const file2 = await writeFakeItem(repoRoot, 'item-2', [seg({ id: 's1', text: 'World' })])
    const corpus: Corpus = {
      items: [corpusItem({ id: 'item-1', file: file1 }), corpusItem({ id: 'item-2', file: file2 })]
    }

    const timeline: string[] = []
    const onEvent = (e: HarnessEvent): void => {
      const suffix = 'itemId' in e ? `:${e.itemId}` : ''
      timeline.push(`${e.type}:${e.model}${suffix}`)
    }

    const stop = vi.fn().mockResolvedValue(undefined)
    const ensureOllama = vi.fn().mockResolvedValue(fakeConnection(stop))
    const createBackend = vi.fn().mockReturnValue(fakeTranslatingBackend())
    const unloadModel = vi.fn().mockImplementation(async (_baseUrl: string, model: string) => {
      timeline.push(`unload:${model}`)
    })
    const deps: HarnessDeps = {
      ensureOllama,
      createBackend,
      unloadModel,
      buildAdapters: vi.fn().mockReturnValue([new FakeAdapter()])
    }

    const summary = await runMatrix(
      { models: ['model-a', 'model-b'], corpus, store, repoRoot, appDataDir, onEvent },
      deps
    )

    expect(summary).toEqual({ completed: 4, skipped: 0, failed: 0 })
    expect(timeline).toEqual([
      'model-start:model-a',
      'cell-start:model-a:item-1',
      'cell-done:model-a:item-1',
      'cell-start:model-a:item-2',
      'cell-done:model-a:item-2',
      'unload:model-a',
      'model-done:model-a',
      'model-start:model-b',
      'cell-start:model-b:item-1',
      'cell-done:model-b:item-1',
      'cell-start:model-b:item-2',
      'cell-done:model-b:item-2',
      'unload:model-b',
      'model-done:model-b'
    ])
    expect(unloadModel).toHaveBeenCalledTimes(2)
    expect(unloadModel).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:1', 'model-a')
    expect(unloadModel).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:1', 'model-b')

    // One connection, one backend for the WHOLE matrix - not one per model/cell.
    expect(ensureOllama).toHaveBeenCalledTimes(1)
    expect(createBackend).toHaveBeenCalledTimes(1)
  })
})

// --- contract point 2: resume via configHash --------------------------------

describe('runMatrix - resume via configHash (contract point 2)', () => {
  it('skips a cell whose stored configHash matches (backend never called), re-runs and overwrites a mismatched one', async () => {
    const repoRoot = await makeTempDir('bench-harness-resume-')
    const store = new BenchStore(await makeTempDir('bench-harness-resume-store-'))
    const appDataDir = await makeTempDir('bench-harness-resume-appdata-')

    const freshFile = await writeFakeItem(repoRoot, 'fresh', [seg({ id: 's1', text: 'Hello' })])
    const staleFile = await writeFakeItem(repoRoot, 'stale', [seg({ id: 's1', text: 'World' })])
    const corpus: Corpus = {
      items: [
        corpusItem({ id: 'fresh', file: freshFile }),
        corpusItem({ id: 'stale', file: staleFile })
      ]
    }

    const freshConfig: CellConfig = {
      model: 'model-a',
      itemId: 'fresh',
      sourceLang: 'English',
      targetLang: 'German'
    }
    const seededFresh: StoredCell = {
      config: freshConfig,
      configHash: configHash(freshConfig),
      report: makeMinimalReport(),
      artifactPath: path.join('artifacts', 'model-a', 'fresh.fake.json'),
      completedAt: '2020-01-01T00:00:00.000Z'
    }
    store.saveCell(seededFresh)

    const staleConfig: CellConfig = {
      model: 'model-a',
      itemId: 'stale',
      sourceLang: 'English',
      targetLang: 'German'
    }
    // configHash deliberately wrong - simulates a corpus edit (e.g. a
    // language swap) since this cell was last stored.
    store.saveCell({
      config: staleConfig,
      configHash: 'deliberately-stale-hash',
      report: makeMinimalReport(),
      artifactPath: path.join('artifacts', 'model-a', 'stale.fake.json'),
      completedAt: '2020-01-01T00:00:00.000Z'
    })

    const events: HarnessEvent[] = []
    const translateBatch = vi.fn().mockImplementation(async (req: BatchRequest) => ({
      translations: req.segments.map((s) => ({
        id: s.id,
        translation: `[${req.targetLang}] ${s.text}`
      }))
    }))
    const deps: HarnessDeps = {
      ensureOllama: vi.fn().mockResolvedValue(fakeConnection()),
      createBackend: vi.fn().mockReturnValue(fakeTranslatingBackend(translateBatch)),
      unloadModel: vi.fn().mockResolvedValue(undefined),
      buildAdapters: vi.fn().mockReturnValue([new FakeAdapter()])
    }

    const summary = await runMatrix(
      { models: ['model-a'], corpus, store, repoRoot, appDataDir, onEvent: (e) => events.push(e) },
      deps
    )

    expect(summary).toEqual({ completed: 1, skipped: 1, failed: 0 })
    expect(events.some((e) => e.type === 'cell-skipped' && e.itemId === 'fresh')).toBe(true)
    expect(events.some((e) => e.type === 'cell-done' && e.itemId === 'stale')).toBe(true)

    // Backend never called for the skipped cell: exactly one call total, for 'stale'.
    expect(translateBatch).toHaveBeenCalledTimes(1)
    expect((translateBatch.mock.calls[0][0] as BatchRequest).segments[0].text).toBe('World')

    // The skipped cell is byte-for-byte untouched.
    expect(store.loadCell('model-a', 'fresh')).toEqual(seededFresh)

    // The mismatched cell was re-run and overwritten: new hash, new timestamp.
    const reloadedStale = store.loadCell('model-a', 'stale')
    expect(reloadedStale).not.toBeNull()
    expect(reloadedStale!.configHash).toBe(configHash(staleConfig))
    expect(reloadedStale!.completedAt).not.toBe('2020-01-01T00:00:00.000Z')
  })
})

// --- contract point 3: full report saved + artifact copied ------------------

describe('runMatrix - saves the full RunReport and copies the artifact into the store (contract point 3)', () => {
  it('a completed cell is self-contained: full report saved, translated output copied under artifactPathFor', async () => {
    const repoRoot = await makeTempDir('bench-harness-artifact-')
    const store = new BenchStore(await makeTempDir('bench-harness-artifact-store-'))
    const appDataDir = await makeTempDir('bench-harness-artifact-appdata-')

    const file = await writeFakeItem(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hello' })])
    const corpus: Corpus = { items: [corpusItem({ id: 'item-1', file, targetLang: 'German' })] }

    const deps: HarnessDeps = {
      ensureOllama: vi.fn().mockResolvedValue(fakeConnection()),
      createBackend: vi.fn().mockReturnValue(fakeTranslatingBackend()),
      unloadModel: vi.fn().mockResolvedValue(undefined),
      // This is the FIRST artifact ever written for 'model-a': artifactPathFor
      // only computes a path, it never creates the per-model directory
      // (unlike saveCell/saveJudgement, which mkdir lazily) - if the harness
      // forgot to mkdir before copying, this test fails with ENOENT.
      buildAdapters: vi.fn().mockReturnValue([new FakeAdapter()])
    }

    const summary = await runMatrix(
      { models: ['model-a'], corpus, store, repoRoot, appDataDir },
      deps
    )

    expect(summary).toEqual({ completed: 1, skipped: 0, failed: 0 })

    const cell = store.loadCell('model-a', 'item-1')
    expect(cell).not.toBeNull()
    expect(cell!.report.total).toBe(1)
    expect(cell!.report.translated).toBe(1)
    expect(cell!.report.segments[0].translation).toBe('[German] Hello')
    expect(cell!.configHash).toBe(
      configHash({
        model: 'model-a',
        itemId: 'item-1',
        sourceLang: 'English',
        targetLang: 'German'
      })
    )

    const artifactAbsPath = path.join(store.dir, cell!.artifactPath)
    expect(existsSync(artifactAbsPath)).toBe(true)
    const artifactContents = JSON.parse(await readFile(artifactAbsPath, 'utf8'))
    expect(artifactContents.segments[0].translation).toBe('[German] Hello')
  })
})

// --- contract point 4: ordinary failure continues; transport failure aborts+cascades --

describe('runMatrix - an ordinary cell failure is recorded and the model continues (contract point 4)', () => {
  it('records cell-failed, saves nothing for that cell, and still runs the next cell', async () => {
    const repoRoot = await makeTempDir('bench-harness-fail-')
    const store = new BenchStore(await makeTempDir('bench-harness-fail-store-'))
    const appDataDir = await makeTempDir('bench-harness-fail-appdata-')

    // item-1's file is never written, so FakeAdapter.extract's readFile
    // throws ENOENT - a realistic ordinary (non-transport) failure.
    const missingFile = 'items/missing.fake.json'
    const okFile = await writeFakeItem(repoRoot, 'item-2', [seg({ id: 's1', text: 'Hello' })])
    const corpus: Corpus = {
      items: [
        corpusItem({ id: 'item-1', file: missingFile }),
        corpusItem({ id: 'item-2', file: okFile })
      ]
    }

    const events: HarnessEvent[] = []
    const deps: HarnessDeps = {
      ensureOllama: vi.fn().mockResolvedValue(fakeConnection()),
      createBackend: vi.fn().mockReturnValue(fakeTranslatingBackend()),
      unloadModel: vi.fn().mockResolvedValue(undefined),
      buildAdapters: vi.fn().mockReturnValue([new FakeAdapter()])
    }

    const summary = await runMatrix(
      { models: ['model-a'], corpus, store, repoRoot, appDataDir, onEvent: (e) => events.push(e) },
      deps
    )

    expect(summary).toEqual({ completed: 1, skipped: 0, failed: 1 })

    const failedEvent = events.find(
      (e): e is { type: 'cell-failed'; model: string; itemId: string; error: string } =>
        isCellFailedEvent(e) && e.itemId === 'item-1'
    )
    expect(failedEvent).toBeDefined()
    expect(failedEvent!.error).toMatch(/ENOENT|no such file/i)

    expect(store.loadCell('model-a', 'item-1')).toBeNull()
    expect(events.some((e) => e.type === 'cell-done' && e.itemId === 'item-2')).toBe(true)
    expect(store.loadCell('model-a', 'item-2')).not.toBeNull()
  })
})

describe('runMatrix - a transport-class failure aborts the model and moves to the next one (contract point 4 exception, point 5)', () => {
  it('never retries: aborts the remaining cells of the failing model, unloads it, then runs the next model normally', async () => {
    const repoRoot = await makeTempDir('bench-harness-abort-')
    const store = new BenchStore(await makeTempDir('bench-harness-abort-store-'))
    const appDataDir = await makeTempDir('bench-harness-abort-appdata-')

    const ids = ['item-1', 'item-2', 'item-3', 'item-4']
    const files = await Promise.all(
      ids.map((id) => writeFakeItem(repoRoot, id, [seg({ id: 's1', text: 'Hello' })]))
    )
    const corpus: Corpus = { items: ids.map((id, i) => corpusItem({ id, file: files[i] })) }

    const transportError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' }
    })
    const translateBatch = vi
      .fn()
      .mockRejectedValueOnce(transportError)
      .mockImplementation(async (req: BatchRequest) => ({
        translations: req.segments.map((s) => ({
          id: s.id,
          translation: `[${req.targetLang}] ${s.text}`
        }))
      }))

    const stop = vi.fn().mockResolvedValue(undefined)
    const ensureOllama = vi.fn().mockResolvedValue(fakeConnection(stop))
    const unloadModel = vi.fn().mockResolvedValue(undefined)
    const deps: HarnessDeps = {
      ensureOllama,
      createBackend: vi.fn().mockReturnValue(fakeTranslatingBackend(translateBatch)),
      unloadModel,
      buildAdapters: vi.fn().mockReturnValue([new FakeAdapter()])
    }

    const events: HarnessEvent[] = []
    const summary = await runMatrix(
      {
        models: ['model-a', 'model-b'],
        corpus,
        store,
        repoRoot,
        appDataDir,
        onEvent: (e) => events.push(e)
      },
      deps
    )

    // model-a: item-1 triggers the transport error, item-2/3/4 cascade-abort.
    // model-b: all 4 items complete normally.
    expect(summary).toEqual({ completed: 4, skipped: 0, failed: 4 })

    const modelAEvents = events.filter((e) => e.model === 'model-a')
    expect(modelAEvents.filter((e) => e.type === 'model-aborted')).toHaveLength(4)
    expect(modelAEvents.some((e) => e.type === 'cell-failed')).toBe(false)

    // Never a retry loop: translateBatch is called once for the triggering
    // cell, then once per model-b cell - model-a's remaining cells never
    // reach the backend at all.
    expect(translateBatch).toHaveBeenCalledTimes(1 + ids.length)

    for (const id of ids) {
      expect(store.loadCell('model-a', id)).toBeNull()
    }
    expect(events.some((e) => e.model === 'model-b' && e.type === 'model-start')).toBe(true)
    for (const id of ids) {
      expect(store.loadCell('model-b', id)).not.toBeNull()
    }

    // unloadModel still runs for the aborted model, exactly once; ensureOllama
    // and connection.stop() each run exactly once for the WHOLE matrix.
    expect(unloadModel).toHaveBeenCalledTimes(2)
    expect(unloadModel).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:1', 'model-a')
    expect(unloadModel).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:1', 'model-b')
    expect(ensureOllama).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

// --- contract point 6: summary counts add up ---------------------------------

describe('runMatrix - summary counts add up to models x items (contract point 6)', () => {
  it('completed + skipped + failed equals the full matrix size on a mixed-outcome run', async () => {
    const repoRoot = await makeTempDir('bench-harness-summary-')
    const store = new BenchStore(await makeTempDir('bench-harness-summary-store-'))
    const appDataDir = await makeTempDir('bench-harness-summary-appdata-')

    const skipFile = await writeFakeItem(repoRoot, 'skip-me', [seg({ id: 's1', text: 'Hello' })])
    const okFile = await writeFakeItem(repoRoot, 'ok', [seg({ id: 's1', text: 'Hi' })])
    const missingFile = 'items/missing.fake.json'
    const corpus: Corpus = {
      items: [
        corpusItem({ id: 'skip-me', file: skipFile }),
        corpusItem({ id: 'ok', file: okFile }),
        corpusItem({ id: 'fail-me', file: missingFile })
      ]
    }

    const skipConfig: CellConfig = {
      model: 'model-a',
      itemId: 'skip-me',
      sourceLang: 'English',
      targetLang: 'German'
    }
    store.saveCell({
      config: skipConfig,
      configHash: configHash(skipConfig),
      report: makeMinimalReport(),
      artifactPath: path.join('artifacts', 'model-a', 'skip-me.fake.json'),
      completedAt: '2020-01-01T00:00:00.000Z'
    })

    const deps: HarnessDeps = {
      ensureOllama: vi.fn().mockResolvedValue(fakeConnection()),
      createBackend: vi.fn().mockReturnValue(fakeTranslatingBackend()),
      unloadModel: vi.fn().mockResolvedValue(undefined),
      buildAdapters: vi.fn().mockReturnValue([new FakeAdapter()])
    }

    const summary = await runMatrix(
      { models: ['model-a'], corpus, store, repoRoot, appDataDir },
      deps
    )

    expect(summary).toEqual({ completed: 1, skipped: 1, failed: 1 })
    expect(summary.completed + summary.skipped + summary.failed).toBe(1 * corpus.items.length)
  })
})

// --- contract point 7: adapter resolution mirrors cli.ts ---------------------

describe('runMatrix - adapter resolution mirrors cli.ts: buildAdapters -> adapterFor by extension (contract point 7)', () => {
  it('an image-kind item resolves the image-extension adapter, a pptx-kind item the pptx-extension adapter', async () => {
    const repoRoot = await makeTempDir('bench-harness-adapters-')
    const store = new BenchStore(await makeTempDir('bench-harness-adapters-store-'))
    const appDataDir = await makeTempDir('bench-harness-adapters-appdata-')

    function makeSpyAdapter(
      name: string,
      ext: string
    ): FormatAdapter & { extract: ReturnType<typeof vi.fn> } {
      const extract = vi.fn().mockResolvedValue([seg({ id: 's1', text: 'Hello' })])
      const apply = vi.fn().mockImplementation(async (_file: string, outPath: string) => {
        await writeFile(outPath, 'stub-output')
      })
      return { name, extensions: [ext], extract, apply }
    }

    const pptxLikeAdapter = makeSpyAdapter('pptx-like', '.fake-pptx.json')
    const imageLikeAdapter = makeSpyAdapter('image-like', '.fake-image.json')

    const corpus: Corpus = {
      items: [
        corpusItem({ id: 'a-pptx-item', file: 'docs/a.fake-pptx.json', kind: 'pptx' }),
        corpusItem({ id: 'an-image-item', file: 'docs/b.fake-image.json', kind: 'image' })
      ]
    }

    const deps: HarnessDeps = {
      ensureOllama: vi.fn().mockResolvedValue(fakeConnection()),
      createBackend: vi.fn().mockReturnValue(fakeTranslatingBackend()),
      unloadModel: vi.fn().mockResolvedValue(undefined),
      buildAdapters: vi.fn().mockReturnValue([pptxLikeAdapter, imageLikeAdapter])
    }

    const summary = await runMatrix(
      { models: ['model-a'], corpus, store, repoRoot, appDataDir },
      deps
    )

    expect(summary).toEqual({ completed: 2, skipped: 0, failed: 0 })
    expect(pptxLikeAdapter.extract).toHaveBeenCalledTimes(1)
    expect(pptxLikeAdapter.extract).toHaveBeenCalledWith(
      path.resolve(repoRoot, 'docs/a.fake-pptx.json')
    )
    expect(imageLikeAdapter.extract).toHaveBeenCalledTimes(1)
    expect(imageLikeAdapter.extract).toHaveBeenCalledWith(
      path.resolve(repoRoot, 'docs/b.fake-image.json')
    )
  })
})

// --- isTransportError predicate ----------------------------------------------

describe('_internals.isTransportError', () => {
  it('detects a fetch-failure TypeError by message', () => {
    expect(_internals.isTransportError(new TypeError('fetch failed'))).toBe(true)
  })

  it('detects ECONNREFUSED by error code', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
      code: 'ECONNREFUSED'
    })
    expect(_internals.isTransportError(err)).toBe(true)
  })

  it('detects ECONNRESET by error code', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    expect(_internals.isTransportError(err)).toBe(true)
  })

  it('detects ECONNREFUSED nested under .cause.code (undici-wrapped fetch failure)', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    expect(_internals.isTransportError(err)).toBe(true)
  })

  it('detects a model-load-failure message', () => {
    expect(_internals.isTransportError(new Error('failed to load model: out of memory'))).toBe(true)
  })

  it('does not classify an ordinary content/validation error as transport', () => {
    const err = new Error('Duplicate segment id "s1" returned by adapter.extract()')
    expect(_internals.isTransportError(err)).toBe(false)
  })

  it('does not classify a non-Error thrown value as transport', () => {
    expect(_internals.isTransportError('boom')).toBe(false)
  })
})

// --- realHarnessDeps: production wiring, no network/GPU touch at construction --

describe('realHarnessDeps (production wiring)', () => {
  it('returns all four dependency functions, and buildAdapters wires in the real fake/pptx/image adapters', () => {
    const deps = realHarnessDeps()
    expect(typeof deps.ensureOllama).toBe('function')
    expect(typeof deps.createBackend).toBe('function')
    expect(typeof deps.unloadModel).toBe('function')
    expect(typeof deps.buildAdapters).toBe('function')

    // regionEngine: null here is what a CALLER passes - realHarnessDeps's
    // buildAdapters closure must use its own closed-over PP-OCR engine
    // regardless (that's the "incl. PP-OCR region engine" production wiring
    // the interface comment promises), which is exactly what makes the image
    // adapter show up here despite the null.
    const adapters = deps.buildAdapters({ regionEngine: null, sourceLang: 'English' })
    expect(adapters.map((a) => a.name).sort()).toEqual(['fake', 'image', 'pptx'])
  })
})
