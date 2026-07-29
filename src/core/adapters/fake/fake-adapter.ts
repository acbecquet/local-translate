import { readFile, writeFile } from 'node:fs/promises'
import type { FormatAdapter } from '../adapter'
import type { TextSegment, TranslatedSegment } from '../../segments'

/** Test adapter: a "document" is a JSON file { segments: TextSegment[] }. */
export class FakeAdapter implements FormatAdapter {
  readonly name = 'fake'
  readonly extensions = ['.fake.json']

  async extract(filePath: string): Promise<TextSegment[]> {
    const data = JSON.parse(await readFile(filePath, 'utf8'))
    return data.segments
  }

  async apply(_: string, outPath: string, segments: TranslatedSegment[]): Promise<void> {
    await writeFile(outPath, JSON.stringify({ segments }, null, 2))
  }
}
