import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  NOT_SOURCE_LANGUAGE_REASON,
  UNTRANSLATABLE_REASON,
  type RunReport
} from '../../../src/core/pipeline'
import type { CellConfig, StoredCell, StoredJudgement } from '../../../src/core/bench/store'
import type { Corpus, CorpusItem } from '../../../src/core/bench/corpus'
import {
  aggregate,
  cellMetrics,
  judgementQuality,
  pairKey,
  rankModels,
  recommendChampion,
  tierFor,
  type ModelAggregate
} from '../../../src/core/bench/metrics'

// --- fixtures ----------------------------------------------------------

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
    judgeModel: 'judge-model',
    promptVersion: 'v1',
    cellConfigHash: 'test-hash',
    scores: [{ segmentId: 's1', accuracy: 5, fluency: 5, format: 5 }],
    judgedAt: new Date().toISOString(),
    ...overrides
  }
}

function makeAggregate(overrides: Partial<ModelAggregate> & { model: string }): ModelAggregate {
  return {
    cells: 1,
    completedAll: true,
    judgedAll: true,
    completenessPct: 100,
    overflowed: 0,
    minFittedSizePt: null,
    ladderHits: 0,
    segmentsPerMin: 1,
    tokensPerSec: 1,
    meanOverall: 3,
    tiersByPair: {},
    ...overrides
  }
}

// --- cellMetrics: completeness (contract point 1) ----------------------

describe('cellMetrics - completeness (contract point 1)', () => {
  it('computes pct as translated/total*100 and groups keptOriginal by reason', () => {
    const report = makeReport({
      total: 4,
      translated: 2,
      keptOriginal: [
        { id: 's3', reason: UNTRANSLATABLE_REASON },
        { id: 's4', reason: NOT_SOURCE_LANGUAGE_REASON }
      ],
      skippedUnsupported: [{ id: 'x1', reason: 'unsupported-chart' }]
    })

    const { completeness } = cellMetrics(report)

    expect(completeness).toEqual({
      total: 4,
      translated: 2,
      pct: 50,
      keptByReason: {
        [UNTRANSLATABLE_REASON]: 1,
        [NOT_SOURCE_LANGUAGE_REASON]: 1
      },
      skippedUnsupported: 1
    })
  })

  it('groups multiple keptOriginal entries sharing the same reason under one count', () => {
    const report = makeReport({
      total: 3,
      translated: 0,
      keptOriginal: [
        { id: 's1', reason: UNTRANSLATABLE_REASON },
        { id: 's2', reason: UNTRANSLATABLE_REASON },
        { id: 's3', reason: NOT_SOURCE_LANGUAGE_REASON }
      ]
    })

    const { completeness } = cellMetrics(report)

    expect(completeness.keptByReason).toEqual({
      [UNTRANSLATABLE_REASON]: 2,
      [NOT_SOURCE_LANGUAGE_REASON]: 1
    })
  })

  it('a zero-segment report yields pct 100 and zeros everywhere else', () => {
    const report = makeReport({
      total: 0,
      translated: 0,
      keptOriginal: [],
      overflowed: [],
      segments: [],
      skippedUnsupported: []
    })

    const metrics = cellMetrics(report)

    expect(metrics.completeness).toEqual({
      total: 0,
      translated: 0,
      pct: 100,
      keptByReason: {},
      skippedUnsupported: 0
    })
    expect(metrics.fidelity.overflowed).toBe(0)
    expect(metrics.fidelity.unresolvedFailures).toBe(0)
    expect(metrics.fidelity.minFittedSizePt).toBeNull()
  })
})

// --- cellMetrics: fidelity (contract point 2) ---------------------------

describe('cellMetrics - fidelity (contract point 2)', () => {
  it('unresolvedFailures counts only keptOriginal reasons outside the expected passthrough set', () => {
    const report = makeReport({
      total: 6,
      translated: 2,
      keptOriginal: [
        { id: 's1', reason: UNTRANSLATABLE_REASON },
        { id: 's2', reason: NOT_SOURCE_LANGUAGE_REASON },
        { id: 's3', reason: 'no-translation' },
        { id: 's4', reason: 'some-other-failure' }
      ]
    })

    const { fidelity } = cellMetrics(report)

    expect(fidelity.unresolvedFailures).toBe(2)
  })

  it('minFittedSizePt is the min over segments with a fittedSizePt', () => {
    const report = makeReport({
      total: 4,
      translated: 3,
      keptOriginal: [{ id: 's4', reason: UNTRANSLATABLE_REASON }],
      segments: [
        { id: 's1', sourceText: 'a', translation: 'x', fittedSizePt: 14, lineCount: 1 },
        { id: 's2', sourceText: 'b', translation: 'y', fittedSizePt: 10, lineCount: 2 },
        { id: 's3', sourceText: 'c', translation: 'z', fittedSizePt: 18, lineCount: 1 },
        { id: 's4', sourceText: 'd', translation: null }
      ]
    })

    const { fidelity } = cellMetrics(report)

    expect(fidelity.minFittedSizePt).toBe(10)
  })

  it('minFittedSizePt is null when nothing was fitted (every segment kept its original text)', () => {
    const report = makeReport({
      total: 2,
      translated: 0,
      keptOriginal: [
        { id: 's1', reason: UNTRANSLATABLE_REASON },
        { id: 's2', reason: NOT_SOURCE_LANGUAGE_REASON }
      ],
      segments: [
        { id: 's1', sourceText: '123', translation: null },
        { id: 's2', sourceText: 'abc', translation: null }
      ]
    })

    const { fidelity } = cellMetrics(report)

    expect(fidelity.minFittedSizePt).toBeNull()
  })

  it('counts overflowed entries and sums groupRetries + perSegmentFallbacks into ladderHits', () => {
    const report = makeReport({
      overflowed: [
        { id: 's1', fontSizePt: 8 },
        { id: 's2', fontSizePt: 9 }
      ],
      stats: makeStats({ groupRetries: 2, perSegmentFallbacks: 3 })
    })

    const { fidelity } = cellMetrics(report)

    expect(fidelity.overflowed).toBe(2)
    expect(fidelity.ladderHits).toBe(5)
  })
})

// --- cellMetrics: speed (pass-through) -----------------------------------

describe('cellMetrics - speed', () => {
  it('mirrors report.stats segmentsPerMin/tokensPerSec/phaseMs and report.durationMs verbatim', () => {
    const report = makeReport({
      durationMs: 12345,
      stats: makeStats({
        segmentsPerMin: 42,
        tokensPerSec: 7.5,
        phaseMs: { extract: 1, connect: 2, translate: 3, fit: 4, apply: 5 }
      })
    })

    const { speed } = cellMetrics(report)

    expect(speed).toEqual({
      segmentsPerMin: 42,
      tokensPerSec: 7.5,
      durationMs: 12345,
      phaseMs: { extract: 1, connect: 2, translate: 3, fit: 4, apply: 5 }
    })
  })
})

// --- judgementQuality (contract point 3) --------------------------------

describe('judgementQuality (contract point 3)', () => {
  it('averages each dimension over scores and meanOverall is the mean of the three dimension means', () => {
    const judgement = makeJudgement({
      scores: [
        { segmentId: 's1', accuracy: 5, fluency: 4, format: 3 },
        { segmentId: 's2', accuracy: 3, fluency: 5, format: 4 }
      ]
    })

    const quality = judgementQuality(judgement, 3)

    expect(quality.judged).toBe(2)
    expect(quality.ofSegments).toBe(3)
    expect(quality.meanAccuracy).toBe(4)
    expect(quality.meanFluency).toBe(4.5)
    expect(quality.meanFormat).toBe(3.5)
    expect(quality.meanOverall).toBe(4)
  })

  it('a null judgement yields all-null dimension means with judged 0', () => {
    const quality = judgementQuality(null, 5)

    expect(quality).toEqual({
      judged: 0,
      ofSegments: 5,
      meanAccuracy: null,
      meanFluency: null,
      meanFormat: null,
      meanOverall: null
    })
  })

  it('a judgement with an empty scores array is treated the same as no judgement', () => {
    const judgement = makeJudgement({ scores: [] })

    const quality = judgementQuality(judgement, 5)

    expect(quality.judged).toBe(0)
    expect(quality.meanOverall).toBeNull()
  })
})

// --- tierFor (contract point 4) ------------------------------------------

describe('tierFor boundaries (contract point 4)', () => {
  it('4.5 is A', () => {
    expect(tierFor(4.5)).toBe('A')
  })

  it('3.5 is B', () => {
    expect(tierFor(3.5)).toBe('B')
  })

  it('2.5 is C', () => {
    expect(tierFor(2.5)).toBe('C')
  })

  it('2.49 is D', () => {
    expect(tierFor(2.49)).toBe('D')
  })
})

// --- pairKey ---------------------------------------------------------------

describe('pairKey', () => {
  it("formats 'source -> target'", () => {
    expect(pairKey('English', 'German')).toBe('English -> German')
  })
})

// --- aggregate: weighting (contract point 5) ------------------------------

describe('aggregate - weighting (contract point 5)', () => {
  it('completenessPct is segment-weighted across cells, not a mean of per-cell percentages', () => {
    const corpus: Corpus = {
      items: [makeCorpusItem({ id: 'item-big' }), makeCorpusItem({ id: 'item-small' })]
    }
    // item-big: 90/100 = 90%. item-small: 10/10 = 100%.
    const cellBig = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-big' }),
      report: makeReport({ total: 100, translated: 90 })
    })
    const cellSmall = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-small' }),
      report: makeReport({ total: 10, translated: 10 })
    })

    const [result] = aggregate(
      [
        { cell: cellBig, judgement: null },
        { cell: cellSmall, judgement: null }
      ],
      corpus
    )

    // Naive mean of per-cell pcts: (90 + 100) / 2 = 95.
    // Segment-weighted: (90 + 10) / (100 + 10) * 100 = 90.909...
    expect(result.completenessPct).toBeCloseTo(90.909, 2)
    expect(result.completenessPct).not.toBeCloseTo(95, 1)
  })

  it('segmentsPerMin is duration-weighted across cells, not a mean of per-cell rates', () => {
    const corpus: Corpus = {
      items: [makeCorpusItem({ id: 'item-slow' }), makeCorpusItem({ id: 'item-fast' })]
    }
    // item-slow: 90 segments over 10 real minutes -> 9/min.
    const cellSlow = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-slow' }),
      report: makeReport({
        total: 90,
        translated: 90,
        durationMs: 600_000,
        stats: makeStats({ segmentsPerMin: 9 })
      })
    })
    // item-fast: 10 segments over 6 seconds -> 100/min.
    const cellFast = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-fast' }),
      report: makeReport({
        total: 10,
        translated: 10,
        durationMs: 6_000,
        stats: makeStats({ segmentsPerMin: 100 })
      })
    })

    const [result] = aggregate(
      [
        { cell: cellSlow, judgement: null },
        { cell: cellFast, judgement: null }
      ],
      corpus
    )

    // Naive mean of per-cell rates: (9 + 100) / 2 = 54.5.
    // Duration-weighted pooled rate: 100 segments / 10.1 min = 9.900990...
    expect(result.segmentsPerMin).toBeCloseTo(9.901, 2)
    expect(result.segmentsPerMin).not.toBeCloseTo(54.5, 1)
  })

  it('tokensPerSec is eval-weighted (by completionTokens) across cells, not a naive mean', () => {
    const corpus: Corpus = {
      items: [makeCorpusItem({ id: 'item-heavy' }), makeCorpusItem({ id: 'item-light' })]
    }
    const cellHeavy = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-heavy' }),
      report: makeReport({ stats: makeStats({ tokensPerSec: 10, completionTokens: 100 }) })
    })
    const cellLight = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-light' }),
      report: makeReport({ stats: makeStats({ tokensPerSec: 50, completionTokens: 1 }) })
    })

    const [result] = aggregate(
      [
        { cell: cellHeavy, judgement: null },
        { cell: cellLight, judgement: null }
      ],
      corpus
    )

    // Naive mean: (10 + 50) / 2 = 30.
    // completionTokens-weighted mean: (10*100 + 50*1) / 101 = 10.396...
    expect(result.tokensPerSec).toBeCloseTo(10.396, 2)
    expect(result.tokensPerSec).not.toBeCloseTo(30, 1)
  })

  it('meanOverall is judged-segment-weighted across cells, not a naive mean of per-cell means', () => {
    const corpus: Corpus = {
      items: [makeCorpusItem({ id: 'item-many' }), makeCorpusItem({ id: 'item-few' })]
    }
    const cellMany = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-many' }),
      report: makeReport({ total: 10, translated: 10 })
    })
    const cellFew = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-few' }),
      report: makeReport({ total: 1, translated: 1 })
    })
    // cellMany: 10 judged segments, all perfect scores -> meanOverall 5.
    const judgementMany = makeJudgement({
      scores: Array.from({ length: 10 }, (_, i) => ({
        segmentId: `s${i}`,
        accuracy: 5,
        fluency: 5,
        format: 5
      }))
    })
    // cellFew: 1 judged segment, worst score -> meanOverall 1.
    const judgementFew = makeJudgement({
      scores: [{ segmentId: 's0', accuracy: 1, fluency: 1, format: 1 }]
    })

    const [result] = aggregate(
      [
        { cell: cellMany, judgement: judgementMany },
        { cell: cellFew, judgement: judgementFew }
      ],
      corpus
    )

    // Naive mean of per-cell meanOveralls: (5 + 1) / 2 = 3.
    // Judged-segment-weighted: (5*10 + 1*1) / 11 = 4.636...
    expect(result.meanOverall).toBeCloseTo(4.636, 2)
    expect(result.meanOverall).not.toBeCloseTo(3, 1)
  })
})

// --- aggregate: completedAll / judgedAll (contract point 5) --------------

describe('aggregate - completedAll / judgedAll (contract point 5)', () => {
  it('sets completedAll false when any corpus item lacks a stored cell', () => {
    const corpus: Corpus = {
      items: [
        makeCorpusItem({ id: 'item-a' }),
        makeCorpusItem({ id: 'item-b' }),
        makeCorpusItem({ id: 'item-c' })
      ]
    }
    const cellA = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-a' }) })
    const cellB = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-b' }) })
    // item-c has no stored cell for model-a.

    const [result] = aggregate(
      [
        { cell: cellA, judgement: null },
        { cell: cellB, judgement: null }
      ],
      corpus
    )

    expect(result.cells).toBe(2)
    expect(result.completedAll).toBe(false)
  })

  it('judgedAll is true only when every corpus item has both a cell and a judgement', () => {
    const corpus: Corpus = {
      items: [makeCorpusItem({ id: 'item-a' }), makeCorpusItem({ id: 'item-b' })]
    }
    const cellA = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-a' }) })
    const cellB = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-b' }) })

    const [partial] = aggregate(
      [
        { cell: cellA, judgement: makeJudgement() },
        { cell: cellB, judgement: null }
      ],
      corpus
    )
    expect(partial.completedAll).toBe(true)
    expect(partial.judgedAll).toBe(false)

    const [full] = aggregate(
      [
        { cell: cellA, judgement: makeJudgement() },
        { cell: cellB, judgement: makeJudgement() }
      ],
      corpus
    )
    expect(full.completedAll).toBe(true)
    expect(full.judgedAll).toBe(true)
  })
})

// --- aggregate: tiersByPair (contract point 5) ----------------------------

describe('aggregate - tiersByPair (contract point 5)', () => {
  it('fills one tier per corpus pair: judged pair gets a letter, unjudged and cell-less pairs get null', () => {
    const corpus: Corpus = {
      items: [
        makeCorpusItem({ id: 'item-de', sourceLang: 'English', targetLang: 'German' }),
        makeCorpusItem({ id: 'item-fr', sourceLang: 'English', targetLang: 'French' }),
        makeCorpusItem({ id: 'item-es', sourceLang: 'English', targetLang: 'Spanish' })
      ]
    }
    const cellDe = makeCell({
      config: makeConfig({
        model: 'model-a',
        itemId: 'item-de',
        sourceLang: 'English',
        targetLang: 'German'
      })
    })
    const cellFr = makeCell({
      config: makeConfig({
        model: 'model-a',
        itemId: 'item-fr',
        sourceLang: 'English',
        targetLang: 'French'
      })
    })
    // item-es has no stored cell for model-a at all.
    const judgementDe = makeJudgement({
      scores: [{ segmentId: 's1', accuracy: 5, fluency: 5, format: 5 }]
    })

    const [result] = aggregate(
      [
        { cell: cellDe, judgement: judgementDe },
        { cell: cellFr, judgement: null }
      ],
      corpus
    )

    expect(result.tiersByPair[pairKey('English', 'German')]).toBe('A')
    expect(result.tiersByPair[pairKey('English', 'French')]).toBeNull()
    expect(result.tiersByPair[pairKey('English', 'Spanish')]).toBeNull()
    expect(result.completedAll).toBe(false)
  })
})

// --- rankModels (contract point 6) ----------------------------------------

describe('rankModels (contract point 6)', () => {
  it('orders by meanOverall descending, with null sorted last', () => {
    const a = makeAggregate({ model: 'a', meanOverall: 3 })
    const b = makeAggregate({ model: 'b', meanOverall: 4.5 })
    const c = makeAggregate({ model: 'c', meanOverall: null })

    const ranked = rankModels([a, c, b])

    expect(ranked.map((m) => m.model)).toEqual(['b', 'a', 'c'])
  })

  it('ties on meanOverall break by completenessPct descending', () => {
    const a = makeAggregate({ model: 'a', meanOverall: 4, completenessPct: 80 })
    const b = makeAggregate({ model: 'b', meanOverall: 4, completenessPct: 95 })

    expect(rankModels([a, b]).map((m) => m.model)).toEqual(['b', 'a'])
  })

  it('ties on meanOverall and completenessPct break by segmentsPerMin descending', () => {
    const a = makeAggregate({ model: 'a', meanOverall: 4, completenessPct: 90, segmentsPerMin: 5 })
    const b = makeAggregate({
      model: 'b',
      meanOverall: 4,
      completenessPct: 90,
      segmentsPerMin: 20
    })

    expect(rankModels([a, b]).map((m) => m.model)).toEqual(['b', 'a'])
  })

  it('does not mutate the input array', () => {
    const a = makeAggregate({ model: 'a', meanOverall: 1 })
    const b = makeAggregate({ model: 'b', meanOverall: 9 })
    const input = [a, b]

    rankModels(input)

    expect(input).toEqual([a, b])
  })
})

// --- recommendChampion (contract point 6) ----------------------------------

describe('recommendChampion (contract point 6)', () => {
  it('skips a higher-scored model that is missing cells or judgements', () => {
    const topButIncomplete = makeAggregate({
      model: 'top',
      meanOverall: 4.9,
      completedAll: false
    })
    const runnerUp = makeAggregate({
      model: 'runner-up',
      meanOverall: 4.0,
      completedAll: true,
      judgedAll: true
    })

    const ranked = rankModels([topButIncomplete, runnerUp])

    expect(recommendChampion(ranked)).toBe('runner-up')
  })

  it('skips a higher-scored model missing judgedAll even when completedAll is true', () => {
    const topButUnjudged = makeAggregate({
      model: 'top',
      meanOverall: 4.9,
      completedAll: true,
      judgedAll: false
    })
    const runnerUp = makeAggregate({
      model: 'runner-up',
      meanOverall: 4.0,
      completedAll: true,
      judgedAll: true
    })

    const ranked = rankModels([topButUnjudged, runnerUp])

    expect(recommendChampion(ranked)).toBe('runner-up')
  })

  it('returns null when nothing qualifies', () => {
    const onlyIncomplete = makeAggregate({ model: 'only', judgedAll: false })

    expect(recommendChampion(rankModels([onlyIncomplete]))).toBeNull()
  })

  it('returns the top-ranked model when it fully qualifies', () => {
    const winner = makeAggregate({ model: 'winner', meanOverall: 5 })
    const loser = makeAggregate({ model: 'loser', meanOverall: 2 })

    expect(recommendChampion(rankModels([winner, loser]))).toBe('winner')
  })
})

// --- 0-safety: no NaN anywhere (self-review) --------------------------------

describe('0-safety - no NaN anywhere', () => {
  it('a zero-segment, zero-duration, unjudged cell produces only finite numbers or explicit nulls', () => {
    const report = makeReport({
      total: 0,
      translated: 0,
      keptOriginal: [],
      overflowed: [],
      segments: [],
      skippedUnsupported: [],
      durationMs: 0,
      stats: makeStats({
        groupRetries: 0,
        perSegmentFallbacks: 0,
        tokensPerSec: 0,
        completionTokens: 0,
        segmentsPerMin: 0
      })
    })

    const metrics = cellMetrics(report)
    const quality = judgementQuality(null, 0)

    for (const value of [
      metrics.completeness.pct,
      metrics.fidelity.ladderHits,
      metrics.fidelity.unresolvedFailures,
      metrics.speed.segmentsPerMin,
      metrics.speed.tokensPerSec
    ]) {
      expect(Number.isNaN(value)).toBe(false)
    }
    expect(metrics.fidelity.minFittedSizePt).toBeNull()
    expect(quality.meanOverall).toBeNull()
  })

  it('aggregate over zero-segment, zero-duration, unjudged cells produces only finite numbers or explicit nulls', () => {
    const corpus: Corpus = { items: [makeCorpusItem({ id: 'item-empty' })] }
    const cell = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-empty' }),
      report: makeReport({
        total: 0,
        translated: 0,
        durationMs: 0,
        segments: [],
        stats: makeStats({ tokensPerSec: 0, completionTokens: 0, segmentsPerMin: 0 })
      })
    })

    const [result] = aggregate([{ cell, judgement: null }], corpus)

    for (const value of [
      result.completenessPct,
      result.segmentsPerMin,
      result.tokensPerSec,
      result.overflowed,
      result.ladderHits
    ]) {
      expect(Number.isNaN(value)).toBe(false)
    }
    expect(result.meanOverall).toBeNull()
    expect(result.minFittedSizePt).toBeNull()
  })
})
