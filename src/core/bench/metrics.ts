/**
 * Pure metric computation for the benchmark harness: turns a single cell's
 * RunReport (plus its optional judge scores) into the completeness/
 * fidelity/speed/quality numbers the report and champion-ranking logic
 * consume, then combines many cells into one ModelAggregate per model and
 * ranks models against each other.
 *
 * Every number here is 0-safe: a model with nothing translated yet, or a
 * cell nobody has judged, must produce a sane placeholder (0, or an
 * explicit null where the interface says so), never NaN - a partially-run
 * benchmark still has to render a report mid-run.
 *
 * Cross-cell aggregates are POOLED, not averaged. completenessPct sums
 * translated and total segments across a model's cells before dividing
 * (segment-weighted); segmentsPerMin sums translated segments over summed
 * duration (duration-weighted) - both are the same "sum of the numerator
 * over sum of the denominator" shape as the per-cell rate they generalize.
 * tokensPerSec and meanOverall instead take a weighted mean of each cell's
 * own already-computed rate, weighted by completionTokens and judged-
 * segment count respectively: the true pooled numerator/denominator for
 * those two isn't available at this layer (RunReport never stores eval
 * duration, and judgementQuality already collapsed raw scores into means),
 * so weighting the per-cell rate by its natural "how much work" measure is
 * the closest equivalent. In every case a naive unweighted mean of per-cell
 * numbers would let a tiny cell's perfect score cancel out a huge cell's
 * failure; pooling/weighting by volume is what a benchmark needs instead.
 */
import { NOT_SOURCE_LANGUAGE_REASON, UNTRANSLATABLE_REASON, type RunReport } from '../pipeline'
import type { StoredCell, StoredJudgement } from './store'
import type { Corpus, CorpusItem } from './corpus'

export interface MetricFamilies {
  completeness: {
    total: number
    translated: number
    /** 0..100, 100 for a zero-segment document. */
    pct: number
    keptByReason: Record<string, number>
    skippedUnsupported: number
  }
  fidelity: {
    overflowed: number
    /** null when nothing was fitted. */
    minFittedSizePt: number | null
    /** groupRetries + perSegmentFallbacks. */
    ladderHits: number
    /** keptOriginal entries whose reason is NOT an expected passthrough (untranslatable / not-source-language). */
    unresolvedFailures: number
  }
  speed: {
    segmentsPerMin: number
    tokensPerSec: number
    durationMs: number
    phaseMs: RunReport['stats']['phaseMs']
  }
}

/** One cell's RunReport, reshaped into the three metric families the report/ranking layer reads. Pure read of the report - no cross-cell context needed. */
export function cellMetrics(report: RunReport): MetricFamilies {
  const keptByReason: Record<string, number> = {}
  let unresolvedFailures = 0
  for (const entry of report.keptOriginal) {
    keptByReason[entry.reason] = (keptByReason[entry.reason] ?? 0) + 1
    if (entry.reason !== UNTRANSLATABLE_REASON && entry.reason !== NOT_SOURCE_LANGUAGE_REASON) {
      unresolvedFailures++
    }
  }

  let minFittedSizePt: number | null = null
  for (const segment of report.segments) {
    if (segment.fittedSizePt === undefined) continue
    if (minFittedSizePt === null || segment.fittedSizePt < minFittedSizePt) {
      minFittedSizePt = segment.fittedSizePt
    }
  }

  return {
    completeness: {
      total: report.total,
      translated: report.translated,
      pct: report.total > 0 ? (report.translated / report.total) * 100 : 100,
      keptByReason,
      skippedUnsupported: report.skippedUnsupported.length
    },
    fidelity: {
      overflowed: report.overflowed.length,
      minFittedSizePt,
      ladderHits: report.stats.groupRetries + report.stats.perSegmentFallbacks,
      unresolvedFailures
    },
    speed: {
      segmentsPerMin: report.stats.segmentsPerMin,
      tokensPerSec: report.stats.tokensPerSec,
      durationMs: report.durationMs,
      phaseMs: report.stats.phaseMs
    }
  }
}

export interface QualityMetric {
  judged: number
  ofSegments: number
  meanAccuracy: number | null
  meanFluency: number | null
  meanFormat: number | null
  /** Mean of the three dimension means; null when judged === 0. */
  meanOverall: number | null
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** A cell's judge scores (if any) reshaped into per-dimension and overall means. `translatedCount` is carried through verbatim as `ofSegments` - how many segments were even eligible to be judged, regardless of how many the judge actually resolved. */
export function judgementQuality(
  judgement: StoredJudgement | null,
  translatedCount: number
): QualityMetric {
  const scores = judgement?.scores ?? []
  if (scores.length === 0) {
    return {
      judged: 0,
      ofSegments: translatedCount,
      meanAccuracy: null,
      meanFluency: null,
      meanFormat: null,
      meanOverall: null
    }
  }

  const meanAccuracy = mean(scores.map((s) => s.accuracy))
  const meanFluency = mean(scores.map((s) => s.fluency))
  const meanFormat = mean(scores.map((s) => s.format))

  return {
    judged: scores.length,
    ofSegments: translatedCount,
    meanAccuracy,
    meanFluency,
    meanFormat,
    meanOverall: (meanAccuracy + meanFluency + meanFormat) / 3
  }
}

export type Tier = 'A' | 'B' | 'C' | 'D'

/** Per-pair quality tier (knowledge-base item 9): >= 4.5 A, >= 3.5 B, >= 2.5 C, else D. */
export function tierFor(meanOverall: number): Tier {
  if (meanOverall >= 4.5) return 'A'
  if (meanOverall >= 3.5) return 'B'
  if (meanOverall >= 2.5) return 'C'
  return 'D'
}

/** Stable key for a language pair, used both as a tiersByPair map key and as the per-pair report table's column label. */
export function pairKey(sourceLang: string, targetLang: string): string {
  return `${sourceLang} -> ${targetLang}`
}

export interface ModelAggregate {
  model: string
  cells: number
  /** Every corpus item has a stored cell. */
  completedAll: boolean
  judgedAll: boolean
  /** Segment-weighted across cells. */
  completenessPct: number
  overflowed: number
  minFittedSizePt: number | null
  ladderHits: number
  /** Duration-weighted. */
  segmentsPerMin: number
  /** Eval-weighted mean across cells. */
  tokensPerSec: number
  /** Judged-segment-weighted. */
  meanOverall: number | null
  /** pairKey -> tier, null when unjudged. */
  tiersByPair: Record<string, Tier | null>
}

/** 0-safe `numeratorSum / denominatorSum`, falling back to `zeroFallback` (never NaN/Infinity) when the pooled denominator is 0 - the segment-weighted/duration-weighted "pool first, divide once" shape completenessPct and segmentsPerMin both follow. */
function pooledRatio(numeratorSum: number, denominatorSum: number, zeroFallback: number): number {
  return denominatorSum > 0 ? numeratorSum / denominatorSum : zeroFallback
}

/** Weighted mean of `value`s by `weight`, 0 when every weight is <= 0 (never NaN) - the eval-weighted shape tokensPerSec follows, since RunReport never stores the raw eval-duration denominator needed to pool a true rate. */
function weightedMean(items: { value: number; weight: number }[]): number {
  const weightSum = items.reduce((sum, item) => sum + item.weight, 0)
  if (weightSum <= 0) return 0
  const valueSum = items.reduce((sum, item) => sum + item.value * item.weight, 0)
  return valueSum / weightSum
}

/** Same shape as weightedMean, but for `number | null` values (a null value is excluded from both sums) and a null fallback instead of 0 - the judged-segment-weighted shape meanOverall follows. */
function weightedMeanOrNull(items: { value: number | null; weight: number }[]): number | null {
  let weightSum = 0
  let valueSum = 0
  for (const { value, weight } of items) {
    if (value === null || weight <= 0) continue
    weightSum += weight
    valueSum += value * weight
  }
  return weightSum > 0 ? valueSum / weightSum : null
}

/** Per-cell numbers aggregate() needs more than once (for the model-wide rollup and again per pair), computed once per cell up front. */
interface PerCellMetrics {
  itemId: string
  report: RunReport
  fidelity: MetricFamilies['fidelity']
  quality: QualityMetric
}

function aggregateOneModel(
  model: string,
  cells: { cell: StoredCell; judgement: StoredJudgement | null }[],
  corpus: Corpus,
  itemsById: Map<string, CorpusItem>,
  pairs: string[]
): ModelAggregate {
  const modelCells = cells.filter((c) => c.cell.config.model === model)
  const itemIds = new Set(modelCells.map((c) => c.cell.config.itemId))
  const completedAll = corpus.items.every((item) => itemIds.has(item.id))
  const judgedAll = completedAll && modelCells.every((c) => c.judgement !== null)

  const perCell: PerCellMetrics[] = modelCells.map((c) => ({
    itemId: c.cell.config.itemId,
    report: c.cell.report,
    fidelity: cellMetrics(c.cell.report).fidelity,
    quality: judgementQuality(c.judgement, c.cell.report.translated)
  }))

  const completenessPct = pooledRatio(
    perCell.reduce((sum, c) => sum + c.report.translated, 0) * 100,
    perCell.reduce((sum, c) => sum + c.report.total, 0),
    100
  )
  const segmentsPerMin = pooledRatio(
    perCell.reduce((sum, c) => sum + c.report.translated, 0),
    perCell.reduce((sum, c) => sum + c.report.durationMs, 0) / 60000,
    0
  )
  const tokensPerSec = weightedMean(
    perCell.map((c) => ({
      value: c.report.stats.tokensPerSec,
      weight: c.report.stats.completionTokens
    }))
  )
  const meanOverall = weightedMeanOrNull(
    perCell.map((c) => ({ value: c.quality.meanOverall, weight: c.quality.judged }))
  )

  const overflowed = perCell.reduce((sum, c) => sum + c.fidelity.overflowed, 0)
  const ladderHits = perCell.reduce((sum, c) => sum + c.fidelity.ladderHits, 0)
  const minFittedSizePt = perCell.reduce<number | null>((min, c) => {
    if (c.fidelity.minFittedSizePt === null) return min
    return min === null ? c.fidelity.minFittedSizePt : Math.min(min, c.fidelity.minFittedSizePt)
  }, null)

  const tiersByPair: Record<string, Tier | null> = {}
  for (const pair of pairs) {
    const inPair = perCell.filter((c) => {
      const item = itemsById.get(c.itemId)
      return item !== undefined && pairKey(item.sourceLang, item.targetLang) === pair
    })
    const pairMeanOverall = weightedMeanOrNull(
      inPair.map((c) => ({ value: c.quality.meanOverall, weight: c.quality.judged }))
    )
    tiersByPair[pair] = pairMeanOverall === null ? null : tierFor(pairMeanOverall)
  }

  return {
    model,
    cells: modelCells.length,
    completedAll,
    judgedAll,
    completenessPct,
    overflowed,
    minFittedSizePt,
    ladderHits,
    segmentsPerMin,
    tokensPerSec,
    meanOverall,
    tiersByPair
  }
}

/** One ModelAggregate per distinct model present in `cells`, rolling up every cell/judgement pair for that model against the full `corpus` (which supplies both the "every item present" check for completedAll/judgedAll and the full pair list for tiersByPair). */
export function aggregate(
  cells: { cell: StoredCell; judgement: StoredJudgement | null }[],
  corpus: Corpus
): ModelAggregate[] {
  const itemsById = new Map(corpus.items.map((item) => [item.id, item]))
  const pairs = [...new Set(corpus.items.map((item) => pairKey(item.sourceLang, item.targetLang)))]
  const models = [...new Set(cells.map((c) => c.cell.config.model))]

  return models.map((model) => aggregateOneModel(model, cells, corpus, itemsById, pairs))
}

/** Descending numeric compare with null sorted after every number - meanOverall's tie-break rule in rankModels. */
function compareDescNullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

/**
 * Ranking: meanOverall desc (null sorts last), then completenessPct desc,
 * then segmentsPerMin desc. Returns a new array - `aggregates` is never
 * mutated, so callers can rank the same aggregation more than once (e.g.
 * once for the report table, once to feed recommendChampion) without
 * caring about call order.
 */
export function rankModels(aggregates: ModelAggregate[]): ModelAggregate[] {
  return [...aggregates].sort((a, b) => {
    const byQuality = compareDescNullsLast(a.meanOverall, b.meanOverall)
    if (byQuality !== 0) return byQuality

    const byCompleteness = b.completenessPct - a.completenessPct
    if (byCompleteness !== 0) return byCompleteness

    return b.segmentsPerMin - a.segmentsPerMin
  })
}

/** The top-ranked model with completedAll && judgedAll, else null - the crown recommendation. A model that scores higher but is missing cells or judgements is not a trustworthy champion, so it is skipped rather than crowned on partial evidence. */
export function recommendChampion(ranked: ModelAggregate[]): string | null {
  const champion = ranked.find((m) => m.completedAll && m.judgedAll)
  return champion?.model ?? null
}
