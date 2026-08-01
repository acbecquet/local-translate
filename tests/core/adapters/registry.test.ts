import { describe, expect, it, vi } from 'vitest'
import { adapterFor } from '../../../src/core/adapters/adapter'
import { buildAdapters } from '../../../src/core/adapters/registry'
import type { RegionEngine } from '../../../src/core/images/regions'

function fakeEngine(): RegionEngine {
  return { detectRegions: vi.fn().mockResolvedValue([]) }
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
