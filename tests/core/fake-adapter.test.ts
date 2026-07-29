import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeAdapter } from '../../src/core/adapters/fake/fake-adapter'
import { adapterFor } from '../../src/core/adapters/adapter'
import type { TranslatedSegment } from '../../src/core/segments'

const seg = {
  id: 's1',
  text: 'Hello world',
  box: { wPt: 200, hPt: 50 },
  font: { family: 'Noto Sans', sizePt: 18 },
  context: 'fake doc',
  kind: 'fake' as const
}

describe('FakeAdapter', () => {
  it('round-trips segments through extract and apply', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lt-'))
    const file = path.join(dir, 'doc.fake.json')
    writeFileSync(file, JSON.stringify({ segments: [seg] }))

    const a = new FakeAdapter()
    const extracted = await a.extract(file)
    expect(extracted).toHaveLength(1)
    expect(extracted[0]).toMatchObject(seg)

    const translated: TranslatedSegment[] = [
      { ...extracted[0], translation: '你好世界', fittedSizePt: 18, fittedLines: ['你好世界'] }
    ]
    const out = path.join(dir, 'doc.out.fake.json')
    await a.apply(file, out, translated)
    const written = JSON.parse(readFileSync(out, 'utf8'))
    expect(written.segments[0].translation).toBe('你好世界')
  })

  it('is selected by adapterFor via extension', () => {
    const a = new FakeAdapter()
    expect(adapterFor('x/doc.fake.json', [a])).toBe(a)
    expect(adapterFor('x/doc.pptx', [a])).toBeNull()
  })
})
