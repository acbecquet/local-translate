import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Canvas } from 'skia-canvas'
import { adapterFor } from '../../../src/core/adapters/adapter'
import { buildAdapters } from '../../../src/core/adapters/registry'
import type { RegionEngine, TextRegion } from '../../../src/core/images/regions'
import { buildPptx } from '../../helpers/build-pptx'

function fakeEngine(regions: TextRegion[] = []): RegionEngine {
  return { detectRegions: vi.fn().mockResolvedValue(regions) }
}

describe('buildAdapters', () => {
  it('always registers fake and pptx, regardless of regionEngine', () => {
    const withEngine = buildAdapters({ regionEngine: fakeEngine(), sourceLang: 'English' })
    const withoutEngine = buildAdapters({ regionEngine: null, sourceLang: 'English' })

    expect(withEngine.map((a) => a.name).sort()).toEqual(['fake', 'image', 'pptx'])
    expect(withoutEngine.map((a) => a.name).sort()).toEqual(['fake', 'pptx'])
  })

  it('excludes the image adapter when regionEngine is null', () => {
    const adapters = buildAdapters({ regionEngine: null, sourceLang: 'English' })
    expect(adapterFor('photo.png', adapters)).toBeNull()
  })

  it('resolves .png/.jpg/.jpeg to the image adapter when an engine is supplied', () => {
    const adapters = buildAdapters({ regionEngine: fakeEngine(), sourceLang: 'English' })
    expect(adapterFor('photo.png', adapters)?.name).toBe('image')
    expect(adapterFor('photo.jpg', adapters)?.name).toBe('image')
    expect(adapterFor('photo.jpeg', adapters)?.name).toBe('image')
  })

  it('resolves a .fake.json file to the fake adapter', () => {
    const adapters = buildAdapters({ regionEngine: null, sourceLang: 'English' })
    expect(adapterFor('doc.fake.json', adapters)?.name).toBe('fake')
  })

  it('resolves a .pptx file to the pptx adapter', () => {
    const adapters = buildAdapters({ regionEngine: null, sourceLang: 'English' })
    expect(adapterFor('deck.pptx', adapters)?.name).toBe('pptx')
  })

  it('returns null for an unregistered extension', () => {
    const adapters = buildAdapters({ regionEngine: null, sourceLang: 'English' })
    expect(adapterFor('doc.docx', adapters)).toBeNull()
  })
})

describe('buildAdapters - pptx adapter receives regionEngine/sourceLang (Phase 3 Task 5)', () => {
  async function writeDeckWithPicture(mediaBytes: Buffer): Promise<string> {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [{ kind: 'picture', box: { xEmu: 0, yEmu: 0, wEmu: 400, hEmu: 400 }, mediaBytes }]
        }
      ]
    })
    const dir = await mkdtemp(path.join(tmpdir(), 'lt-registry-pptx-'))
    const file = path.join(dir, 'deck.pptx')
    await writeFile(file, buffer)
    return file
  }

  async function makePngBytes(width: number, height: number): Promise<Buffer> {
    const canvas = new Canvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    return canvas.toBuffer('png')
  }

  it('with a regionEngine supplied, the registry-built pptx adapter detects embedded image text', async () => {
    const png = await makePngBytes(200, 100)
    const engine = fakeEngine([
      { id: 'raw', bbox: { x: 10, y: 10, w: 100, h: 30 }, text: 'Hello', confidence: 0.9 }
    ])
    const file = await writeDeckWithPicture(png)

    const adapters = buildAdapters({ regionEngine: engine, sourceLang: 'English' })
    const pptxAdapter = adapterFor(file, adapters)!
    const segments = await pptxAdapter.extract(file)

    expect(segments.some((s) => s.kind === 'image-region')).toBe(true)
    await rm(path.dirname(file), { recursive: true, force: true })
  })

  it('with regionEngine null, the registry-built pptx adapter detects zero embedded image text (exact Phase 2 behavior)', async () => {
    const png = await makePngBytes(200, 100)
    const file = await writeDeckWithPicture(png)

    const adapters = buildAdapters({ regionEngine: null, sourceLang: 'English' })
    const pptxAdapter = adapterFor(file, adapters)!
    const segments = await pptxAdapter.extract(file)

    expect(segments.filter((s) => s.kind === 'image-region')).toEqual([])
    expect(pptxAdapter.collectSkips?.()).toEqual([])
    await rm(path.dirname(file), { recursive: true, force: true })
  })
})
