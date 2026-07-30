import type { TextSegment, TranslatedSegment } from '../segments'

export interface FormatAdapter {
  readonly name: string
  readonly extensions: string[]
  /**
   * Extracts every translatable text segment from `filePath`, in the order
   * they should be reported/applied. Every returned segment's `id` MUST be
   * unique within the returned array - runPipeline checks this immediately
   * after extract() (before any translation work starts) and rejects the
   * whole run with a clear "duplicate id" error otherwise, since a
   * duplicate id would make it impossible to tell which occurrence a later
   * translation or fit result belongs to.
   *
   * Adapters should also set `groupKey` on each segment to the identity of
   * its translation unit (e.g. a slide index, a sheet name, a page
   * number), distinct from `context` (the human-readable role used in
   * prompts/reports, e.g. "slide title", "table cell") - see
   * TextSegment.groupKey and TextSegment.context in ../segments.ts, and
   * groupSegments in ../translate/batching.ts, which groups by `groupKey`
   * when present and falls back to `context` otherwise.
   */
  extract(filePath: string): Promise<TextSegment[]>
  apply(filePath: string, outPath: string, segments: TranslatedSegment[]): Promise<void>
}

/**
 * Picks the adapter registered for `filePath`, by longest matching
 * extension across every adapter (not just the first adapter whose
 * extension matches, and not just the first matching extension on that
 * adapter) - e.g. an adapter for `.json` and another for `.fake.json` must
 * both be considered for `doc.fake.json`, and the more specific
 * `.fake.json` must win, mirroring pipeline.ts's defaultOutPath, which
 * resolves the same way for the same reason (a shorter suffix match is
 * always a strict subset of a longer one).
 */
export function adapterFor(filePath: string, adapters: FormatAdapter[]): FormatAdapter | null {
  const lower = filePath.toLowerCase()
  let best: { adapter: FormatAdapter; ext: string } | null = null
  for (const adapter of adapters) {
    for (const ext of adapter.extensions) {
      if (lower.endsWith(ext.toLowerCase()) && (!best || ext.length > best.ext.length)) {
        best = { adapter, ext }
      }
    }
  }
  return best?.adapter ?? null
}
