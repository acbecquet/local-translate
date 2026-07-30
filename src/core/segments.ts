export interface FontSpec {
  family: string
  sizePt: number
  bold?: boolean
  italic?: boolean
  colorHex?: string
}

export interface Box {
  wPt: number
  hPt: number
}

export type SegmentKind =
  'shape' | 'table-cell' | 'sheet-cell' | 'pdf-block' | 'image-region' | 'notes' | 'fake'

export interface TextSegment {
  id: string
  text: string
  box: Box
  font: FontSpec
  /**
   * Human-readable role of this segment, used in translation prompts and
   * reports (e.g. "slide title", "table cell") - see FormatAdapter's
   * extract() docs. Also doubles as the batching grouping key for adapters
   * that don't set `groupKey` (see groupSegments in translate/batching.ts).
   */
  context: string
  /**
   * Optional exact-match key that groupSegments (translate/batching.ts)
   * groups by instead of `context`, when present. Adapters should set this
   * to the identity of the translation unit a segment came from (e.g. a
   * slide index, a sheet name, a page number) so that segments sharing a
   * unit are always batched together even when their human-readable
   * `context` strings differ (which stays free to vary per segment role
   * for prompts/reports). When absent, grouping falls back to `context`
   * exactly as before this field existed.
   */
  groupKey?: string
  kind: SegmentKind
}

export interface TranslatedSegment extends TextSegment {
  translation: string
  fittedSizePt: number
  fittedLines: string[]
}
