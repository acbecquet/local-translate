import type { TextSegment, TranslatedSegment } from '../segments'

export interface FormatAdapter {
  readonly name: string
  readonly extensions: string[]
  extract(filePath: string): Promise<TextSegment[]>
  apply(filePath: string, outPath: string, segments: TranslatedSegment[]): Promise<void>
}

export function adapterFor(filePath: string, adapters: FormatAdapter[]): FormatAdapter | null {
  const lower = filePath.toLowerCase()
  return adapters.find((a) => a.extensions.some((ext) => lower.endsWith(ext))) ?? null
}
