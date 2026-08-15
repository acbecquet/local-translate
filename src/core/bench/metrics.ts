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
 * Cross-cell aggregates are POOLED, not averaged - every one of them sums a
 * numerator across a model's cells and a denominator across the same cells
 * before dividing ONCE, rather than averaging each cell's own already-
 * divided rate. A rate never pools as a mean of rates (weighted or not) -
 * pooling "tokens per second" the way you'd pool "dollars per hour" means
 * total tokens over total seconds, full stop; a weighted arithmetic mean of
 * per-cell rates is a DIFFERENT, systematically-too-high number whenever
 * the rates differ (AM >= HM), because it lets a cell that ran briefly at a
 * high rate outvote a cell that ran a long time at a lower one.
 *
 * completenessPct sums translated/total segments (segment-weighted);
 * segmentsPerMin sums translated segments over summed duration (duration-
 * weighted); tokensPerSec sums completionTokens over summed eval-seconds
 * (eval-weighted). RunReport.stats never stores eval-seconds directly, but
 * it is recoverable by algebra from the two fields it DOES store: since
 * `tokensPerSec = completionTokens / evalSeconds` (pipeline.ts's
 * `safeRate`), a cell's own evalSeconds = completionTokens / tokensPerSec
 * (guarded to 0 when tokensPerSec is 0, since a 0 rate means that cell
 * contributed no eval time and no tokens either - never a division by 0).
 *
 * meanOverall is the one field that genuinely IS a judged-segment-weighted
 * MEAN, not a pooled rate: judgementQuality's per-cell meanOverall is
 * already a mean of a mean (dimension means, then their mean), and
 * combining several sample means into one overall mean by weighting each
 * by its own sample size (judged count) is the exact arithmetic identity
 * for reconstructing the true pooled mean over every underlying score - so
 * this one weighted-arithmetic-mean shape is correct as written, unlike a
 * weighted mean of rates.
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
  /** Judge coverage: how many segments actually carry a judge score, summed across cells. Surfaced in the report and the results doc, never only used as an internal weight - a model judged on 5 of 400 segments must not render identically to one judged on 400 of 400. */
  judged: number
  /** Judge coverage denominator: how many segments were eligible to be judged (i.e. were translated), summed across cells. */
  ofSegments: number
  /** keptOriginal segments whose reason is NOT an expected passthrough, summed across cells - content this model was asked to translate and did not deliver. The denominator half of deliveredPct. */
  unresolvedFailures: number
  /**
   * `translated / (translated + unresolvedFailures) * 100`, pooled across
   * cells - of the content this model was actually ASKED to translate, the
   * share it delivered. 100 when nothing was eligible.
   *
   * Deliberately distinct from `completenessPct`, which divides by EVERY
   * extracted segment and is therefore dominated by corpus-driven
   * legitimate passthrough (untranslatable codes, and segments already in
   * the target language). That makes completenessPct a fine comparative
   * tie-break but useless as an absolute bar - see
   * MIN_CHAMPION_DELIVERED_PCT, which gates on this number instead.
   */
  deliveredPct: number
  overflowed: number
  minFittedSizePt: number | null
  ladderHits: number
  /** Duration-weighted. */
  segmentsPerMin: number
  /** Eval-weighted: pooled as total completionTokens over total eval-seconds across cells (a true rate, not a mean of per-cell rates - see the module doc comment). */
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

/**
 * Recovers a cell's eval-seconds from the two fields RunReport actually
 * stores (completionTokens, tokensPerSec), by inverting
 * `tokensPerSec = completionTokens / evalSeconds` (pipeline.ts's
 * `safeRate`). 0 when tokensPerSec is <= 0 - a 0 rate means that cell
 * contributed no eval time and no tokens, never a division by 0.
 */
function evalSecondsFor(completionTokens: number, tokensPerSec: number): number {
  return tokensPerSec > 0 ? completionTokens / tokensPerSec : 0
}

/** Weighted mean of `number | null` values by `weight` (a null value is excluded from both sums), null when every included weight is 0 or nothing was non-null - the judged-segment-weighted shape meanOverall follows (see the module doc comment for why this shape, unlike a pooled rate, is correct for a mean). */
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

  const perCell: PerCellMetrics[] = modelCells.map((c) => ({
    itemId: c.cell.config.itemId,
    report: c.cell.report,
    fidelity: cellMetrics(c.cell.report).fidelity,
    quality: judgementQuality(c.judgement, c.cell.report.translated)
  }))

  const judged = perCell.reduce((sum, c) => sum + c.quality.judged, 0)
  const ofSegments = perCell.reduce((sum, c) => sum + c.quality.ofSegments, 0)

  // A stored judgement per cell is necessary but NOT sufficient: judgements
  // with zero scores in them are no quality evidence at all, so `judgedAll`
  // requires actual coverage too. Without the `judged > 0` clause this was a
  // pure presence check, and a model whose every judgement resolved empty
  // would read as fully judged - and be crownable - on nothing.
  const judgedAll = completedAll && modelCells.every((c) => c.judgement !== null) && judged > 0

  const unresolvedFailures = perCell.reduce((sum, c) => sum + c.fidelity.unresolvedFailures, 0)
  const translatedTotal = perCell.reduce((sum, c) => sum + c.report.translated, 0)
  const deliveredPct = pooledRatio(
    translatedTotal * 100,
    translatedTotal + unresolvedFailures,
    100 // nothing was eligible to translate: no content was lost either
  )

  const completenessPct = pooledRatio(
    translatedTotal * 100,
    perCell.reduce((sum, c) => sum + c.report.total, 0),
    100
  )
  const segmentsPerMin = pooledRatio(
    translatedTotal,
    perCell.reduce((sum, c) => sum + c.report.durationMs, 0) / 60000,
    0
  )
  const tokensPerSec = pooledRatio(
    perCell.reduce((sum, c) => sum + c.report.stats.completionTokens, 0),
    perCell.reduce(
      (sum, c) =>
        sum + evalSecondsFor(c.report.stats.completionTokens, c.report.stats.tokensPerSec),
      0
    ),
    0
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
    judged,
    ofSegments,
    unresolvedFailures,
    deliveredPct,
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

/**
 * The content-preservation floor for crowning: a model whose `deliveredPct`
 * is below this can never be recommended as champion, no matter how well it
 * scores on quality. The master plan's top-line constraint is that content
 * preservation is absolute, and the crowned model becomes the app's shipped
 * default - so a model that quietly leaves a large share of the content it
 * was asked to translate in its source language must not win on the strength
 * of its scores on the minority it did translate. Quality ranking alone
 * rewards exactly that: a model that translates 40% of the eligible content
 * beautifully outranks one that translates 99% of it well.
 *
 * Why 95, and why measured on `deliveredPct` rather than `completenessPct`:
 * the ladder (whole-group call, group retry, per-segment fallback) already
 * gives every eligible segment three chances, so a healthy model lands at or
 * within a hair of 100 and only genuinely pathological segments fall
 * through; 95 tolerates roughly one lost segment in twenty while catching
 * every systematic-loss case decisively. It is deliberately NOT applied to
 * `completenessPct` (translated over EVERY extracted segment): that number
 * is dominated by corpus-driven legitimate passthrough, which no model
 * controls. Measured on this repo's own phase-4 corpus, only 426 of 1164
 * pptx segments (36.6%) are even eligible for translation - the real deck is
 * mixed-language, so each direction language-gates most of it - which means
 * any absolute floor on completenessPct is either vacuous (below ~36) or
 * unreachable (above it) for every model alike.
 *
 * To override: change this constant (one place, and every consumer follows),
 * or crown deliberately with `bench crown <model>`, which is a human
 * accepting responsibility for a model the auto-recommendation refused and
 * says so out loud in its output.
 */
export const MIN_CHAMPION_DELIVERED_PCT = 95

/** A model that met every other champion bar but fell under MIN_CHAMPION_DELIVERED_PCT, carried out of recommendChampion so the report banner and the CLI can name it instead of silently skipping it. */
export interface ChampionExclusion {
  model: string
  deliveredPct: number
}

export interface ChampionRecommendation {
  /** The recommended champion, or null when nothing qualifies. */
  model: string | null
  /** Models ranked ABOVE `model` that met every other bar (completedAll && judgedAll) yet failed the completeness floor, in rank order - i.e. exactly the models this recommendation passed OVER, not every low-completeness model in the ranking (one that ranks below the recommendation lost on quality anyway and was never a candidate). Empty when the floor never bit. */
  excludedForCompleteness: ChampionExclusion[]
}

/**
 * The top-ranked model that is completedAll, judgedAll, AND at or above
 * MIN_CHAMPION_DELIVERED_PCT - the crown recommendation. A model that scores
 * higher but is missing cells or judgements is not a trustworthy champion,
 * so it is skipped rather than crowned on partial evidence; a model that
 * scores higher but preserved less content is skipped for a different and
 * louder reason, and is reported in `excludedForCompleteness` rather than
 * dropped silently - being passed over on the project's top-line constraint
 * is exactly the kind of thing the person crowning needs to see.
 */
export function recommendChampion(ranked: ModelAggregate[]): ChampionRecommendation {
  const excludedForCompleteness: ChampionExclusion[] = []
  for (const m of ranked) {
    if (!m.completedAll || !m.judgedAll) continue
    if (m.deliveredPct < MIN_CHAMPION_DELIVERED_PCT) {
      excludedForCompleteness.push({ model: m.model, deliveredPct: m.deliveredPct })
      continue
    }
    return { model: m.model, excludedForCompleteness }
  }
  return { model: null, excludedForCompleteness }
}
