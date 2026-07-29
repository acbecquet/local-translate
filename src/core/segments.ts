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
  | 'shape'
  | 'table-cell'
  | 'sheet-cell'
  | 'pdf-block'
  | 'image-region'
  | 'notes'
  | 'fake'

export interface TextSegment {
  id: string
  text: string
  box: Box
  font: FontSpec
  context: string
  kind: SegmentKind
}

export interface TranslatedSegment extends TextSegment {
  translation: string
  fittedSizePt: number
  fittedLines: string[]
}
