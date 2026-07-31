// Orchestrator: wires extract -> groupSegments -> translateBatch per group ->
// fit each translation -> apply into a single runnable flow, and reports
// what happened. This is the only file in src/core that touches every other
// module (adapters, batching, fit, translate/backend) - by design, nothing
// downstream of it needs to know about the others.

import path from 'node:path'
import type { FormatAdapter } from './adapters/adapter'
import { fit } from './fit/fit-engine'
import { registerBundledFonts } from './fit/fonts'
import type { TextSegment, TranslatedSegment } from './segments'
import type { TranslationBackend } from './translate/backend'
import { groupSegments, hasTranslatableContent } from './translate/batching'

export interface RunReport {
  file: string
  outPath: string
  total: number
  translated: number
  keptOriginal: { id: string; reason: string }[]
  overflowed: { id: string; fontSizePt: number }[]
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
    /** completionTokens / (summed BatchResponse.usage.modelDurationMs / 1000); 0 when either side of that ratio is 0 (no usage reported, or a 0 ms duration). */
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
      tokensPerSec: safeRate(usage.completionTokens, usage.modelDurationMs / 1000),
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

/** Aggregate of BatchResponse.usage summed across every group this pipeline run sent to the backend - see RunReport.stats's doc comment (pipeline.ts) for how each field maps into the final report. Kept separate from RunReport.stats itself since this also carries `modelDurationMs`, an intermediate the report never exposes directly (only tokensPerSec, derived from it). */
interface UsageTotals {
  groups: number
  modelCalls: number
  groupRetries: number
  perSegmentFallbacks: number
  promptTokens: number
  completionTokens: number
  modelDurationMs: number
}

/**
 * Groups translatable segments and calls the backend once per group.
 * Untranslatable segments (dropped by groupSegments) are recorded in
 * `keptOriginal` up front and never reach the backend. Any segment that
 * comes back from a group's BatchResponse without a validated translation -
 * whether explicitly listed in `failures` or simply absent - is also
 * recorded in `keptOriginal`, with the backend's reported reason when one
 * was given. Also aggregates BatchResponse.usage (when the backend reports
 * it) across every group into the returned `usage` totals.
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
    modelDurationMs: 0
  }

  for (const seg of segments) {
    if (!hasTranslatableContent(seg.text)) {
      keptOriginal.push({ id: seg.id, reason: UNTRANSLATABLE_REASON })
    }
  }

  const groups = groupSegments(segments)
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
