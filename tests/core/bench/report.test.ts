import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RunReport } from '../../../src/core/pipeline'
import {
  BenchStore,
  type CellConfig,
  type StoredCell,
  type StoredJudgement
} from '../../../src/core/bench/store'
import type { Corpus, CorpusItem } from '../../../src/core/bench/corpus'
import { JUDGE_PROMPT_VERSION } from '../../../src/core/bench/judge'
import { pairKey } from '../../../src/core/bench/metrics'
import { buildReport, renderHtml, renderResultsDoc } from '../../../src/core/bench/report'

// --- fixtures (mirrors metrics.test.ts / store.test.ts idioms) -------------

const tempDirs: string[] = []
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function makeStats(overrides: Partial<RunReport['stats']> = {}): RunReport['stats'] {
  return {
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
    segmentsPerMin: 1,
    ...overrides
  }
}

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
    durationMs: 1000,
    stats: makeStats(),
    ...overrides
  }
}

function makeCorpusItem(overrides: Partial<CorpusItem> & Pick<CorpusItem, 'id'>): CorpusItem {
  return {
    file: `fixtures/${overrides.id}.pptx`,
    sourceLang: 'English',
    targetLang: 'German',
    kind: 'pptx',
    ...overrides
  }
}

function makeConfig(overrides: Partial<CellConfig> = {}): CellConfig {
  return {
    model: 'model-a',
    itemId: 'item-a',
    sourceLang: 'English',
    targetLang: 'German',
    ...overrides
  }
}

function makeCell(overrides: Partial<StoredCell> = {}): StoredCell {
  const config = overrides.config ?? makeConfig()
  return {
    config,
    configHash: 'test-hash',
    report: makeReport(),
    artifactPath: path.join('artifacts', config.model, `${config.itemId}.pptx`),
    completedAt: new Date().toISOString(),
    ...overrides
  }
}

function makeJudgement(overrides: Partial<StoredJudgement> = {}): StoredJudgement {
  return {
    judgeModel: 'judge-x',
    promptVersion: JUDGE_PROMPT_VERSION,
    cellConfigHash: 'test-hash',
    scores: [{ segmentId: 's1', accuracy: 5, fluency: 5, format: 5 }],
    judgedAt: new Date().toISOString(),
    ...overrides
  }
}

// --- contract point 1 -------------------------------------------------------

describe('buildReport - wires aggregate/rankModels/recommendChampion, carries every A/B row (contract point 1)', () => {
  it('ranks by aggregate output, recommends only the model that is completedAll and judgedAll, and never drops a null translation', async () => {
    const storeDir = await makeTempDir('bench-report-wiring-')
    const store = new BenchStore(storeDir)
    const corpus: Corpus = {
      items: [makeCorpusItem({ id: 'item-a' }), makeCorpusItem({ id: 'item-b' })]
    }

    // model-top: only completes+judges item-a, with a perfect score - ranks
    // FIRST on raw quality, but must NOT be recommended (misses item-b).
    const cellTopA = makeCell({
      config: makeConfig({ model: 'model-top', itemId: 'item-a' }),
      configHash: 'hash-top-a',
      report: makeReport({
        total: 2,
        translated: 1,
        segments: [
          {
            id: 's1',
            sourceText: 'hello',
            translation: 'hallo-top',
            fittedSizePt: 12,
            lineCount: 1
          },
          // s2 kept original by model-top - must show through as null, never dropped.
          { id: 's2', sourceText: 'kept', translation: null }
        ]
      })
    })
    store.saveCell(cellTopA)
    store.saveJudgement(
      'model-top',
      'item-a',
      makeJudgement({
        cellConfigHash: 'hash-top-a',
        scores: [{ segmentId: 's1', accuracy: 5, fluency: 5, format: 5 }]
      })
    )

    // model-solid: completes+judges BOTH items with a lower but complete score.
    const cellSolidA = makeCell({
      config: makeConfig({ model: 'model-solid', itemId: 'item-a' }),
      configHash: 'hash-solid-a',
      report: makeReport({
        total: 2,
        translated: 2,
        segments: [
          {
            id: 's1',
            sourceText: 'hello',
            translation: 'hallo-solid',
            fittedSizePt: 12,
            lineCount: 1
          },
          // Same segment id, but THIS model actually translated it.
          {
            id: 's2',
            sourceText: 'kept',
            translation: 'translated-solid',
            fittedSizePt: 12,
            lineCount: 1
          }
        ]
      })
    })
    const cellSolidB = makeCell({
      config: makeConfig({ model: 'model-solid', itemId: 'item-b' }),
      configHash: 'hash-solid-b'
    })
    store.saveCell(cellSolidA)
    store.saveCell(cellSolidB)
    store.saveJudgement(
      'model-solid',
      'item-a',
      makeJudgement({
        cellConfigHash: 'hash-solid-a',
        scores: [{ segmentId: 's1', accuracy: 3, fluency: 3, format: 3 }]
      })
    )
    store.saveJudgement(
      'model-solid',
      'item-b',
      makeJudgement({
        cellConfigHash: 'hash-solid-b',
        scores: [{ segmentId: 's1', accuracy: 3, fluency: 3, format: 3 }]
      })
    )

    const report = buildReport(store, corpus, 'judge-x')

    // aggregate/rankModels: model-top outranks model-solid on raw meanOverall (5 > 3).
    expect(report.ranking.map((r) => r.model)).toEqual(['model-top', 'model-solid'])
    // recommendChampion: model-top is skipped (not completedAll) even though it ranks first.
    expect(report.recommended).toBe('model-solid')

    expect(report.judgeModel).toBe('judge-x')
    expect(report.promptVersion).toBe(JUDGE_PROMPT_VERSION)

    expect(report.corpusItems).toEqual(
      expect.arrayContaining([
        { id: 'item-a', pair: pairKey('English', 'German'), kind: 'pptx', segments: 2 }
      ])
    )

    // A/B rows: every stored cell contributes, and a null translation shows
    // through verbatim - never dropped, never coerced to a string.
    const rowsA = report.abByItem['item-a']
    expect(rowsA).toHaveLength(2)
    const s2 = rowsA.find((r) => r.segmentId === 's2')
    expect(s2?.byModel['model-top'].translation).toBeNull()
    expect(s2?.byModel['model-solid'].translation).toBe('translated-solid')
  })
})

// --- contract point 2 -------------------------------------------------------

describe('buildReport - stale judgements are treated as absent (contract point 2)', () => {
  it('ignores a judgement whose cellConfigHash no longer matches the cell current configHash', async () => {
    const storeDir = await makeTempDir('bench-report-stale-hash-')
    const store = new BenchStore(storeDir)
    const corpus: Corpus = { items: [makeCorpusItem({ id: 'item-a' })] }

    const cell = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-a' }),
      configHash: 'hash-current'
    })
    store.saveCell(cell)
    // Saved against an OLDER version of this cell - the cell was re-run
    // since (e.g. a corpus edit changed its config hash), so this judgement
    // is stale and must never score the newer run.
    store.saveJudgement(
      'model-a',
      'item-a',
      makeJudgement({ cellConfigHash: 'hash-old-before-rerun' })
    )

    const report = buildReport(store, corpus, 'judge-x')

    expect(report.ranking[0].meanOverall).toBeNull()
    expect(report.ranking[0].judgedAll).toBe(false)
    expect(report.judgeModel).toBeNull()
    expect(report.abByItem['item-a'][0].byModel['model-a'].overall).toBeNull()
  })

  it('ignores a judgement whose promptVersion no longer matches JUDGE_PROMPT_VERSION', async () => {
    const storeDir = await makeTempDir('bench-report-stale-prompt-')
    const store = new BenchStore(storeDir)
    const corpus: Corpus = { items: [makeCorpusItem({ id: 'item-a' })] }

    const cell = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-a' }),
      configHash: 'hash-current'
    })
    store.saveCell(cell)
    // Hash matches (same run), but the rubric changed since this was scored.
    store.saveJudgement(
      'model-a',
      'item-a',
      makeJudgement({ cellConfigHash: 'hash-current', promptVersion: 'v0-retired-rubric' })
    )

    const report = buildReport(store, corpus, 'judge-x')

    expect(report.ranking[0].meanOverall).toBeNull()
    expect(report.ranking[0].judgedAll).toBe(false)
    expect(report.judgeModel).toBeNull()
    expect(report.abByItem['item-a'][0].byModel['model-a'].overall).toBeNull()
  })

  it('a CURRENT judgement (matching hash and prompt version) is honored', async () => {
    const storeDir = await makeTempDir('bench-report-current-judgement-')
    const store = new BenchStore(storeDir)
    const corpus: Corpus = { items: [makeCorpusItem({ id: 'item-a' })] }

    const cell = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-a' }),
      configHash: 'hash-current'
    })
    store.saveCell(cell)
    store.saveJudgement('model-a', 'item-a', makeJudgement({ cellConfigHash: 'hash-current' }))

    const report = buildReport(store, corpus, 'judge-x')

    expect(report.ranking[0].meanOverall).toBe(5)
    expect(report.judgeModel).toBe('judge-x')
    expect(report.abByItem['item-a'][0].byModel['model-a'].overall).toBe(5)
  })
})

// --- contract point 3 -------------------------------------------------------

describe('renderHtml - self-containment and escaping (contract point 3)', () => {
  it('has no <script tag, no http(s):// URL anywhere, and HTML-escapes a malicious translation', async () => {
    const storeDir = await makeTempDir('bench-report-selfcontain-')
    const store = new BenchStore(storeDir)
    const corpus: Corpus = { items: [makeCorpusItem({ id: 'item-a' })] }

    const cell = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-a' }),
      report: makeReport({
        total: 1,
        translated: 1,
        segments: [
          {
            id: 's1',
            sourceText: 'hello',
            translation: '<script>alert(1)</script>',
            fittedSizePt: 12,
            lineCount: 1
          }
        ]
      })
    })
    store.saveCell(cell)

    const report = buildReport(store, corpus, 'judge-x')
    const html = renderHtml(report, store)

    expect(html).not.toContain('<script src')
    expect(html).not.toContain('<script>')
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes an untrusted model name the same way', async () => {
    const storeDir = await makeTempDir('bench-report-escape-ids-')
    const store = new BenchStore(storeDir)
    // '&' and "'" are both HTML-special AND legal Windows path components
    // (unlike '<'/'>'/'"', which BenchStore.saveCell would reject as an
    // illegal directory name before renderHtml even runs) - this exercises
    // escapeHtml without coupling the test to filesystem-legal-character
    // trivia unrelated to what is under test.
    const specialModel = "model-a & friends' co"
    const corpus: Corpus = { items: [makeCorpusItem({ id: 'item-a' })] }

    const cell = makeCell({ config: makeConfig({ model: specialModel, itemId: 'item-a' }) })
    store.saveCell(cell)

    const report = buildReport(store, corpus, 'judge-x')
    const html = renderHtml(report, store)

    expect(html).not.toContain(specialModel)
    expect(html).toContain('model-a &amp; friends&#39; co')
  })
})

describe('renderHtml - keptOriginal translation is shown, never dropped, never the string null (binding requirement)', () => {
  it('renders "(kept original)" for a null translation without ever printing a literal null', async () => {
    const storeDir = await makeTempDir('bench-report-keptorig-')
    const store = new BenchStore(storeDir)
    const corpus: Corpus = { items: [makeCorpusItem({ id: 'item-a' })] }

    const cellA = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-a' }),
      report: makeReport({
        total: 2,
        translated: 1,
        segments: [
          { id: 's1', sourceText: 'hello', translation: 'hallo', fittedSizePt: 12, lineCount: 1 },
          { id: 's2', sourceText: '12345', translation: null }
        ]
      })
    })
    const cellB = makeCell({
      config: makeConfig({ model: 'model-b', itemId: 'item-a' }),
      report: makeReport({
        total: 2,
        translated: 2,
        segments: [
          { id: 's1', sourceText: 'hello', translation: 'salut', fittedSizePt: 12, lineCount: 1 },
          { id: 's2', sourceText: '12345', translation: '12345', fittedSizePt: 12, lineCount: 1 }
        ]
      })
    })
    store.saveCell(cellA)
    store.saveCell(cellB)

    const report = buildReport(store, corpus, 'judge-x')
    const s2 = report.abByItem['item-a'].find((r) => r.segmentId === 's2')
    expect(s2?.byModel['model-a'].translation).toBeNull()
    expect(s2?.byModel['model-b'].translation).toBe('12345')

    const html = renderHtml(report, store)
    expect(html).toContain('(kept original)')
    expect(html).not.toContain('>null<')
  })
})

// --- contract point 4 -------------------------------------------------------

describe('renderHtml - image artifact embedding (contract point 4)', () => {
  it('embeds a small artifact (and the original) as data:image/png;base64 URIs', async () => {
    const storeDir = await makeTempDir('bench-report-image-small-store-')
    const sourceDir = await makeTempDir('bench-report-image-small-source-')
    const store = new BenchStore(storeDir)
    const corpus: Corpus = {
      items: [makeCorpusItem({ id: 'item-img', kind: 'image', file: 'fixtures/whatever.png' })]
    }

    const originalPath = path.join(sourceDir, 'original.png')
    await writeFile(originalPath, Buffer.from('tiny-fake-original-bytes'))

    const artifactRelPath = store.artifactPathFor('model-a', 'item-img', 'whatever.png')
    const artifactAbsPath = path.join(store.dir, artifactRelPath)
    await mkdir(path.dirname(artifactAbsPath), { recursive: true })
    await writeFile(artifactAbsPath, Buffer.from('tiny-fake-translated-bytes'))

    const cell = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-img' }),
      report: makeReport({ file: originalPath }),
      artifactPath: artifactRelPath
    })
    store.saveCell(cell)

    const report = buildReport(store, corpus, 'judge-x')
    const html = renderHtml(report, store)

    const dataUriCount = (html.match(/data:image\/png;base64,/g) ?? []).length
    expect(dataUriCount).toBe(2) // the original + model-a's translated artifact
  })

  it('an oversized artifact (> 2 MB) renders its store-relative path as text instead of embedding', async () => {
    const storeDir = await makeTempDir('bench-report-image-large-store-')
    const sourceDir = await makeTempDir('bench-report-image-large-source-')
    const store = new BenchStore(storeDir)
    const corpus: Corpus = {
      items: [makeCorpusItem({ id: 'item-img', kind: 'image', file: 'fixtures/whatever.png' })]
    }

    // Original stays small - only the model artifact is oversized, so this
    // also proves the 2 MB gate is applied per-file, not page-wide.
    const originalPath = path.join(sourceDir, 'original.png')
    await writeFile(originalPath, Buffer.from('tiny-fake-original-bytes'))

    const artifactRelPath = store.artifactPathFor('model-a', 'item-img', 'whatever.png')
    const artifactAbsPath = path.join(store.dir, artifactRelPath)
    await mkdir(path.dirname(artifactAbsPath), { recursive: true })
    await writeFile(artifactAbsPath, Buffer.alloc(2 * 1024 * 1024 + 1024, 7))

    const cell = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-img' }),
      report: makeReport({ file: originalPath }),
      artifactPath: artifactRelPath
    })
    store.saveCell(cell)

    const report = buildReport(store, corpus, 'judge-x')
    const html = renderHtml(report, store)

    const dataUriCount = (html.match(/data:image\/png;base64,/g) ?? []).length
    expect(dataUriCount).toBe(1) // only the small original embeds
    expect(html).toContain(artifactRelPath)
  })
})

// --- contract point 5 -------------------------------------------------------

describe('renderResultsDoc - ranking order, recommended champion, tier table, one sentence per line (contract point 5)', () => {
  it('renders markdown containing the ranking order, the recommended champion, and a tier table', async () => {
    const storeDir = await makeTempDir('bench-report-doc-')
    const store = new BenchStore(storeDir)
    const corpus: Corpus = { items: [makeCorpusItem({ id: 'item-a' })] }

    const cellHigh = makeCell({
      config: makeConfig({ model: 'model-high', itemId: 'item-a' }),
      configHash: 'hash-high'
    })
    const cellLow = makeCell({
      config: makeConfig({ model: 'model-low', itemId: 'item-a' }),
      configHash: 'hash-low'
    })
    store.saveCell(cellHigh)
    store.saveCell(cellLow)
    store.saveJudgement(
      'model-high',
      'item-a',
      makeJudgement({
        cellConfigHash: 'hash-high',
        scores: [{ segmentId: 's1', accuracy: 5, fluency: 5, format: 5 }]
      })
    )
    store.saveJudgement(
      'model-low',
      'item-a',
      makeJudgement({
        cellConfigHash: 'hash-low',
        scores: [{ segmentId: 's1', accuracy: 2, fluency: 2, format: 2 }]
      })
    )

    const report = buildReport(store, corpus, 'judge-x')
    // Sanity on the fixture: both models complete/judge the single item, so
    // the higher meanOverall must win the recommendation outright.
    expect(report.recommended).toBe('model-high')

    const doc = renderResultsDoc(report)

    // Ranking order: model-high's row precedes model-low's row.
    const highIndex = doc.indexOf('model-high')
    const lowIndex = doc.indexOf('model-low')
    expect(highIndex).toBeGreaterThan(-1)
    expect(lowIndex).toBeGreaterThan(-1)
    expect(highIndex).toBeLessThan(lowIndex)

    // Recommended champion is named in prose.
    expect(doc.toLowerCase()).toContain('champion')
    expect(doc).toContain('model-high')

    // Tier table: tierFor(5) = A for model-high, tierFor(2) = D for model-low.
    expect(doc).toContain('| A |')
    expect(doc).toContain('| D |')

    // One full sentence per physical line (repo markdown convention): no
    // non-table, non-heading, non-blank line has a mid-line sentence
    // terminator followed by the start of another sentence.
    for (const line of doc.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('|') || trimmed.startsWith('#')) continue
      const withoutTrailingTerminator = trimmed.replace(/[.!?]$/, '')
      expect(withoutTrailingTerminator).not.toMatch(/[.!?]\s+[A-Z(]/)
    }
  })

  it('never uses an em dash', async () => {
    const storeDir = await makeTempDir('bench-report-doc-emdash-')
    const store = new BenchStore(storeDir)
    const corpus: Corpus = { items: [makeCorpusItem({ id: 'item-a' })] }
    store.saveCell(makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-a' }) }))

    const report = buildReport(store, corpus, 'judge-x')
    const doc = renderResultsDoc(report)

    expect(doc).not.toContain('—')
  })
})

// --- BenchReport.judgeModel field (Minor, documented interface behavior) ---

describe('buildReport - judgeModel field reflects whether anything is currently judged (Minor)', () => {
  it('is null when the store has no judgements at all', async () => {
    const storeDir = await makeTempDir('bench-report-nojudge-')
    const store = new BenchStore(storeDir)
    const corpus: Corpus = { items: [makeCorpusItem({ id: 'item-a' })] }
    store.saveCell(makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-a' }) }))

    const report = buildReport(store, corpus, 'judge-x')

    expect(report.judgeModel).toBeNull()
  })
})
