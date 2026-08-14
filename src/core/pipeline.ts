// Orchestrator: wires extract -> groupSegments -> translateBatch per group ->
// fit each translation -> apply into a single runnable flow, and reports
// what happened. This is the only file in src/core that touches every other
// module (adapters, batching, fit, translate/backend) - by design, nothing
// downstream of it needs to know about the others.

import path from 'node:path'
import type { FormatAdapter } from './adapters/adapter'
import { fit } from './fit/fit-engine'
import { registerBundledFonts } from './fit/fonts'
import { isSourceLanguageRegion } from './images/gating'
import type { TextSegment, TranslatedSegment } from './segments'
import type { TranslationBackend } from './translate/backend'
import { groupSegments, hasTranslatableContent } from './translate/batching'

/**
 * Per-segment detail for one extracted segment - a benchmark-consumption
 * counterpart to the aggregate counts elsewhere in RunReport (see
 * RunReport.segments below): the judge needs (source, translation) pairs,
 * the A/B report needs the same, and the fidelity metric needs per-segment
 * fitted sizes, so a stored RunReport must carry the texts, not just counts.
 */
export interface SegmentDetail {
  id: string
  sourceText: string
  /** null when the segment kept its original text (untranslatable, gated, failed). */
  translation: string | null
  /** Populated for every segment that went through fit (i.e. translation !== null). */
  fittedSizePt?: number
  /** Wrapped line count fit() produced for this segment; populated alongside fittedSizePt. */
  lineCount?: number
}

export interface RunReport {
  file: string
  outPath: string
  total: number
  translated: number
  keptOriginal: { id: string; reason: string }[]
  overflowed: { id: string; fontSizePt: number }[]
  /** One entry per extracted segment, in extract order - see SegmentDetail. */
  segments: SegmentDetail[]
  /** Unsupported-but-present content the adapter skipped entirely (never a segment, never touched on apply) - e.g. a chart, WordArt, or an unresolvable SmartArt part. Populated from the adapter's optional `collectSkips()` (adapter.ts); `[]` for an adapter that never implements it. */
  skippedUnsupported: { id: string; reason: string }[]
  durationMs: number
  /**
   * Rich per-run statistics for printing (cli.ts's printReport) and for
   * comparing models/runs against each other over time. Always populated
   * (never optional) - every number here is 0-safe: a backend that never
   * reports BatchResponse.usage (or a document with nothing to translate)
   * simply yields zeros rather than NaN/undefined anywhere below.
   */
  stats: {
    /** opts.model, verbatim - which model this run's numbers describe. */
    model: string
    /** Wall-clock time spent in each phase, in ms. `connect` is 0 unless the caller supplied `PipelineOpts.connectMs` - the pipeline itself never establishes a model-server connection, so it has nothing to time for that phase on its own. */
    phaseMs: { extract: number; connect: number; translate: number; fit: number; apply: number }
    /** Number of translateBatch() calls the pipeline made (one per group groupSegments produced). */
    groups: number
    /** Sum of BatchResponse.usage.calls across every group - the total count of model calls (group calls + retries + per-segment fallbacks + capability probes) that actually returned a response, across the whole run. */
    modelCalls: number
    /** Sum of BatchResponse.usage.retries across every group. */
    groupRetries: number
    /** Sum of BatchResponse.usage.perSegmentFallbacks across every group. */
    perSegmentFallbacks: number
    /** Sum of BatchResponse.usage.promptTokens across every group; 0 when the backend never reports usage. */
    promptTokens: number
    /** Sum of BatchResponse.usage.completionTokens across every group; 0 when the backend never reports usage. */
    completionTokens: number
    /** completionTokens / (summed BatchResponse.usage.evalDurationMs / 1000) - pure generation throughput, NOT divided by whole-call latency (which includes model load + prompt eval), matching ollama's own eval-rate convention. 0 when either side of that ratio is 0 (no usage reported, or a 0 ms eval duration). */
    tokensPerSec: number
    /** Sum of `.text.length` across every extracted segment, translated or not - the total amount of source text this run processed. */
    charsSource: number
    /** Sum of `.length` of each segment's ACTUAL resolved translation - only segments the backend translated. A keptOriginal segment (untranslatable passthrough, or a translation failure that fell back to source text) contributes to `charsSource` above but never to this field, since no translation was produced for it. */
    charsTranslated: number
    /** translated / (durationMs / 60000); 0 when durationMs is 0. */
    segmentsPerMin: number
  }
}

export interface PipelineOpts {
  file: string
  out?: string
  sourceLang: string
  targetLang: string
  model: string
  adapter: FormatAdapter
  backend: TranslationBackend
  /**
   * How long the caller spent establishing its model-server connection
   * (e.g. cli.ts/TranslateService timing their own ensureOllama() call)
   * before invoking runPipeline - reported verbatim as
   * RunReport.stats.phaseMs.connect. The pipeline has no connection step of
   * its own to time, so this defaults to 0 when omitted (e.g. a caller that
   * reuses an already-established connection and pays no connect cost this
   * run).
   */
  connectMs?: number
  onProgress?: (
    done: number,
    total: number,
    phase: 'extract' | 'translate' | 'fit' | 'apply'
  ) => void
}

/** Fallback reason recorded when a segment is absent from a BatchResponse without a matching `failures` entry - should be unreachable given the backend contract, but the report must still account for every segment rather than silently losing one. */
const UNEXPLAINED_ABSENCE_REASON = 'no-translation'

/**
 * Reason recorded for segments groupSegments drops as untranslatable
 * (numeric/symbol/whitespace-only) - they're expected passthroughs, not
 * failures, but still counted in the report so every extracted segment is
 * accounted for. Exported so callers (cli.ts's exit-code logic) can
 * recognize this specific, expected reason without duplicating the string.
 */
export const UNTRANSLATABLE_REASON = 'skipped-untranslatable'

/**
 * Reason recorded for a TEXT segment the per-segment source-language gate
 * (isSourceLanguageRegion, images/gating.ts) rejects before it ever reaches
 * groupSegments/the backend - a segment whose text isn't in the run's
 * source language is legitimate leave-alone content (e.g. an already-
 * translated textbox left over in a mixed-language deck), not something to
 * send through translation. Image adapters already apply this same gate at
 * extract() time (no segment is ever created for a gated-out region, so
 * they never reach the pipeline at all); this reason exists for the second,
 * pipeline-level net that catches ordinary TEXT segments (pptx text boxes
 * and anything else extract() turns into a segment), which had no gate of
 * their own before Phase 3 polish Task A - the gap that let an EN->ZH run
 * paraphrase already-Chinese textboxes in a real deck. Exported for the
 * same reason as UNTRANSLATABLE_REASON: callers recognize this specific,
 * expected reason without duplicating the string.
 */
export const NOT_SOURCE_LANGUAGE_REASON = 'not-source-language'

export async function runPipeline(opts: PipelineOpts): Promise<RunReport> {
  const start = Date.now()
  // Idempotent (guarded internally): safe to call on every run rather than
  // pushing this responsibility onto every caller of runPipeline.
  registerBundledFonts()

  const extractStart = Date.now()
  const segments = await opts.adapter.extract(opts.file)
  assertUniqueIds(segments)
  const total = segments.length
  const extractMs = Date.now() - extractStart
  opts.onProgress?.(total, total, 'extract')
  // Read immediately after extract() - the adapter contract documents
  // collectSkips() as reporting the MOST RECENT extract() call's skips, and
  // apply() below reruns the adapter's own internal walk again (for a
  // different purpose: relocating nodes to write into), which must not be
  // mistaken for a second round of skips.
  const skippedUnsupported = opts.adapter.collectSkips?.() ?? []

  const translateStart = Date.now()
  const { translationById, keptOriginal, usage } = await translateSegments(opts, segments)
  const translateMs = Date.now() - translateStart

  const fitStart = Date.now()
  const { translatedSegments, overflowed } = fitSegments(opts, segments, translationById)
  const fitMs = Date.now() - fitStart
  const segmentDetails = collectSegmentDetails(segments, translationById, translatedSegments)

  const outPath = opts.out ?? defaultOutPath(opts.file, opts.adapter)
  const applyStart = Date.now()
  await opts.adapter.apply(opts.file, outPath, translatedSegments)
  const applyMs = Date.now() - applyStart
  opts.onProgress?.(1, 1, 'apply')

  // By construction every segment ends up in exactly one of "resolved a
  // translation" or `keptOriginal` (see translateSegments), so this always
  // satisfies total === translated + keptOriginal.length.
  const translated = total - keptOriginal.length
  const { charsSource, charsTranslated } = charCounts(segments, translationById)
  const durationMs = Date.now() - start

  return {
    file: opts.file,
    outPath,
    total,
    translated,
    keptOriginal,
    overflowed,
    segments: segmentDetails,
    skippedUnsupported,
    durationMs,
    stats: {
      model: opts.model,
      phaseMs: {
        extract: extractMs,
        connect: opts.connectMs ?? 0,
        translate: translateMs,
        fit: fitMs,
        apply: applyMs
      },
      groups: usage.groups,
      modelCalls: usage.modelCalls,
      groupRetries: usage.groupRetries,
      perSegmentFallbacks: usage.perSegmentFallbacks,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      tokensPerSec: safeRate(usage.completionTokens, usage.evalDurationMs / 1000),
      charsSource,
      charsTranslated,
      segmentsPerMin: safeRate(translated, durationMs / 60000)
    }
  }
}

/** `numerator / denominator`, but 0 (never NaN/Infinity) when `denominator` is 0 - the shared "0-safe rate" rule every stats.ts ratio in RunReport.stats follows (tokensPerSec, segmentsPerMin). */
function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

/**
 * `charsSource` counts every extracted segment's original text length,
 * whether or not it ended up translated - the total volume of source text
 * this run processed. `charsTranslated` counts only the segments that
 * actually have an entry in `translationById` (i.e., the backend produced
 * a validated translation for them) - a keptOriginal segment (untranslatable
 * passthrough, or a failed translation that fell back to its original text
 * in fitSegments) is deliberately excluded from `charsTranslated`, since no
 * translation was ever produced for it.
 */
function charCounts(
  segments: TextSegment[],
  translationById: Map<string, string>
): { charsSource: number; charsTranslated: number } {
  let charsSource = 0
  let charsTranslated = 0
  for (const seg of segments) {
    charsSource += seg.text.length
    const translation = translationById.get(seg.id)
    if (translation !== undefined) charsTranslated += translation.length
  }
  return { charsSource, charsTranslated }
}

/**
 * Guards the id-uniqueness contract FormatAdapter.extract() documents
 * (adapter.ts): every id downstream (translation lookups, fit results, the
 * applied output) is keyed by segment id, so a duplicate would make it
 * impossible to tell which occurrence a later result belongs to. Checked
 * immediately after extract(), before any translation work starts, so a
 * misbehaving adapter fails fast with a clear error and the input file is
 * never touched.
 */
function assertUniqueIds(segments: TextSegment[]): void {
  const seen = new Set<string>()
  for (const seg of segments) {
    if (seen.has(seg.id)) {
      throw new Error(
        `Duplicate segment id "${seg.id}" returned by adapter.extract() - every extracted segment id must be unique.`
      )
    }
    seen.add(seg.id)
  }
}

/**
 * The prompt-facing "what is this batch" string for a group. When every
 * segment in the group shares a `groupKey` (an adapter set one - see
 * TextSegment.groupKey), the groupKey alone doesn't tell the model what
 * KINDS of text it's translating (a slide can batch a title, a body, and a
 * table cell together), so this folds in the sorted set of distinct roles
 * too: "slide3: body, slide title, table cell". Without a groupKey,
 * groupSegments (batching.ts) already grouped purely by `context`, so every
 * segment in the group shares the identical context string - falling back
 * to that single value, unchanged from the pre-groupKey behavior.
 */
function deriveGroupContext(group: TextSegment[]): string {
  const groupKey = group[0].groupKey
  if (!groupKey) return group[0].context
  const roles = [...new Set(group.map((s) => s.context))].sort()
  return `${groupKey}: ${roles.join(', ')}`
}

/** Aggregate of BatchResponse.usage summed across every group this pipeline run sent to the backend - see RunReport.stats's doc comment (pipeline.ts) for how each field maps into the final report. Kept separate from RunReport.stats itself since this also carries `modelDurationMs`/`evalDurationMs`, intermediates the report never exposes directly (only tokensPerSec, derived from `evalDurationMs` - see its own doc comment on backend.ts's BatchResponse.usage for why that field, not `modelDurationMs`, is the tokensPerSec basis). */
interface UsageTotals {
  groups: number
  modelCalls: number
  groupRetries: number
  perSegmentFallbacks: number
  promptTokens: number
  completionTokens: number
  modelDurationMs: number
  evalDurationMs: number
}

/**
 * Groups translatable segments and calls the backend once per group.
 * Two kinds of segment are excluded from grouping and recorded in
 * `keptOriginal` up front, before groupSegments/the backend ever see them:
 *
 * 1. Segments whose text isn't in the run's source language
 *    (!isSourceLanguageRegion(opts.sourceLang, seg.text) - reason
 *    NOT_SOURCE_LANGUAGE_REASON). Checked FIRST, ahead of the untranslatable
 *    check below: a segment can satisfy both (e.g. a pure-digit segment
 *    under a CJK source has a 0% CJK ratio, which fails the language gate,
 *    AND has no \p{L} letters, which would separately fail
 *    hasTranslatableContent) and must land in `keptOriginal` exactly once,
 *    not twice - language mismatch is the more specific, more actionable
 *    reason (it says WHY the content shouldn't be touched; "untranslatable"
 *    is just "nothing for a model to act on"), so it takes precedence and
 *    the untranslatable check below only ever sees segments that already
 *    passed the language gate.
 * 2. Untranslatable segments (numeric/symbol/whitespace-only -
 *    hasTranslatableContent false - reason UNTRANSLATABLE_REASON), dropped
 *    by groupSegments internally too; recorded here for reporting.
 *
 * Any segment that comes back from a group's BatchResponse without a
 * validated translation - whether explicitly listed in `failures` or simply
 * absent - is also recorded in `keptOriginal`, with the backend's reported
 * reason when one was given. Also aggregates BatchResponse.usage (when the
 * backend reports it) across every group into the returned `usage` totals.
 */
async function translateSegments(
  opts: PipelineOpts,
  segments: TextSegment[]
): Promise<{
  translationById: Map<string, string>
  keptOriginal: { id: string; reason: string }[]
  usage: UsageTotals
}> {
  const translationById = new Map<string, string>()
  const keptOriginal: { id: string; reason: string }[] = []
  const usage: UsageTotals = {
    groups: 0,
    modelCalls: 0,
    groupRetries: 0,
    perSegmentFallbacks: 0,
    promptTokens: 0,
    completionTokens: 0,
    modelDurationMs: 0,
    evalDurationMs: 0
  }

  const languageGated = new Set<string>()
  for (const seg of segments) {
    if (!isSourceLanguageRegion(opts.sourceLang, seg.text)) {
      languageGated.add(seg.id)
      keptOriginal.push({ id: seg.id, reason: NOT_SOURCE_LANGUAGE_REASON })
    }
  }

  const inSourceLanguage = segments.filter((seg) => !languageGated.has(seg.id))

  for (const seg of inSourceLanguage) {
    if (!hasTranslatableContent(seg.text)) {
      keptOriginal.push({ id: seg.id, reason: UNTRANSLATABLE_REASON })
    }
  }

  const groups = groupSegments(inSourceLanguage)
  const totalToTranslate = groups.reduce((n, g) => n + g.length, 0)
  if (groups.length === 0) {
    opts.onProgress?.(0, 0, 'translate')
  }

  let done = 0
  for (const group of groups) {
    const response = await opts.backend.translateBatch({
      model: opts.model,
      sourceLang: opts.sourceLang,
      targetLang: opts.targetLang,
      groupContext: deriveGroupContext(group),
      segments: group.map((s) => ({ id: s.id, text: s.text }))
    })

    usage.groups += 1
    // response.usage is optional (backend.ts) - a test double or a future
    // backend that never tracks telemetry simply contributes 0 across the
    // board rather than this loop needing a special case for it.
    if (response.usage) {
      usage.modelCalls += response.usage.calls
      usage.groupRetries += response.usage.retries
      usage.perSegmentFallbacks += response.usage.perSegmentFallbacks
      usage.promptTokens += response.usage.promptTokens
      usage.completionTokens += response.usage.completionTokens
      usage.modelDurationMs += response.usage.modelDurationMs
      usage.evalDurationMs += response.usage.evalDurationMs
    }

    for (const t of response.translations) {
      translationById.set(t.id, t.translation)
    }

    const failureReasonById = new Map((response.failures ?? []).map((f) => [f.id, f.reason]))
    for (const seg of group) {
      if (!translationById.has(seg.id)) {
        keptOriginal.push({
          id: seg.id,
          reason: failureReasonById.get(seg.id) ?? UNEXPLAINED_ABSENCE_REASON
        })
      }
    }

    done += group.length
    opts.onProgress?.(done, totalToTranslate, 'translate')
  }

  return { translationById, keptOriginal, usage }
}

/**
 * Fits every extracted segment's final text (its resolved translation, or
 * its original text when none was resolved) to its box, in original extract
 * order, so the applied output always contains exactly the segments that
 * were extracted - once each. Segments that don't fit even at the fit
 * engine's size floor are still included (content preservation - never
 * drop) and reported in `overflowed`.
 */
function fitSegments(
  opts: PipelineOpts,
  segments: TextSegment[],
  translationById: Map<string, string>
): { translatedSegments: TranslatedSegment[]; overflowed: { id: string; fontSizePt: number }[] } {
  const translatedSegments: TranslatedSegment[] = []
  const overflowed: { id: string; fontSizePt: number }[] = []

  let done = 0
  const total = segments.length
  if (total === 0) {
    opts.onProgress?.(0, 0, 'fit')
  }
  for (const seg of segments) {
    const translation = translationById.get(seg.id) ?? seg.text
    const result = fit(translation, seg.box, seg.font)
    if (result.overflowed) {
      overflowed.push({ id: seg.id, fontSizePt: result.fontSizePt })
    }
    translatedSegments.push({
      ...seg,
      translation,
      fittedSizePt: result.fontSizePt,
      fittedLines: result.lines
    })
    done += 1
    opts.onProgress?.(done, total, 'fit')
  }

  return { translatedSegments, overflowed }
}

/**
 * Builds RunReport.segments straight from the two structures translation and
 * fit already produced - no extra pass over the adapter or the backend.
 * `translatedSegments` has exactly one entry per `segments` entry, pushed in
 * the same extract-order loop inside fitSegments, so zipping the two arrays
 * by index (rather than building yet another id-keyed map) is safe and
 * preserves extract order for free. A segment kept as original text
 * (untranslatable, gated, or a backend failure - i.e. absent from
 * `translationById`) reports `translation: null` and omits the fit fields
 * entirely: fitSegments still runs fit() on its original text (so apply()
 * has a size for it too), but that size was never a translation decision,
 * so the benchmark-facing detail record doesn't claim one.
 */
function collectSegmentDetails(
  segments: TextSegment[],
  translationById: Map<string, string>,
  translatedSegments: TranslatedSegment[]
): SegmentDetail[] {
  return segments.map((seg, i) => {
    const translation = translationById.get(seg.id)
    if (translation === undefined) {
      return { id: seg.id, sourceText: seg.text, translation: null }
    }
    const fitted = translatedSegments[i]
    return {
      id: seg.id,
      sourceText: seg.text,
      translation,
      fittedSizePt: fitted.fittedSizePt,
      lineCount: fitted.fittedLines.length
    }
  })
}

/**
 * `<name>_translated<ext>` beside the input, where `<ext>` is the adapter's
 * own registered extension (which may be compound, e.g. `.fake.json`) -
 * matched against the file path the same way adapterFor() does, rather than
 * via path.extname(), which would only strip `.json` and mangle the name
 * for compound extensions. When more than one registered extension matches
 * the file (e.g. a hypothetical adapter registering both `.json` and
 * `.fake.json`), the longest match wins, since a shorter suffix match is
 * always a strict subset of a longer one and picking it would truncate the
 * name mid-extension. Falls back to path.extname() on the (normally
 * unreachable) case where the file doesn't actually match any of the
 * adapter's extensions.
 */
function defaultOutPath(file: string, adapter: FormatAdapter): string {
  const lower = file.toLowerCase()
  const matches = adapter.extensions.filter((e) => lower.endsWith(e.toLowerCase()))
  const ext =
    matches.length > 0
      ? matches.reduce((longest, e) => (e.length > longest.length ? e : longest))
      : path.extname(file)
  const base = file.slice(0, file.length - ext.length)
  return `${base}_translated${ext}`
}
