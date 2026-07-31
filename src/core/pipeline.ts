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
  durationMs: number
}

export interface PipelineOpts {
  file: string
  out?: string
  sourceLang: string
  targetLang: string
  model: string
  adapter: FormatAdapter
  backend: TranslationBackend
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

  const segments = await opts.adapter.extract(opts.file)
  assertUniqueIds(segments)
  const total = segments.length
  opts.onProgress?.(total, total, 'extract')

  const { translationById, keptOriginal } = await translateSegments(opts, segments)

  const { translatedSegments, overflowed } = fitSegments(opts, segments, translationById)

  const outPath = opts.out ?? defaultOutPath(opts.file, opts.adapter)
  await opts.adapter.apply(opts.file, outPath, translatedSegments)
  opts.onProgress?.(1, 1, 'apply')

  return {
    file: opts.file,
    outPath,
    total,
    // By construction every segment ends up in exactly one of "resolved a
    // translation" or `keptOriginal` (see translateSegments), so this
    // always satisfies total === translated + keptOriginal.length.
    translated: total - keptOriginal.length,
    keptOriginal,
    overflowed,
    durationMs: Date.now() - start
  }
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

/**
 * Groups translatable segments and calls the backend once per group.
 * Untranslatable segments (dropped by groupSegments) are recorded in
 * `keptOriginal` up front and never reach the backend. Any segment that
 * comes back from a group's BatchResponse without a validated translation -
 * whether explicitly listed in `failures` or simply absent - is also
 * recorded in `keptOriginal`, with the backend's reported reason when one
 * was given.
 */
async function translateSegments(
  opts: PipelineOpts,
  segments: TextSegment[]
): Promise<{
  translationById: Map<string, string>
  keptOriginal: { id: string; reason: string }[]
}> {
  const translationById = new Map<string, string>()
  const keptOriginal: { id: string; reason: string }[] = []

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

  return { translationById, keptOriginal }
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
