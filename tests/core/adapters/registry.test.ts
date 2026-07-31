import { describe, expect, it } from 'vitest'
import { adapterFor } from '../../../src/core/adapters/adapter'
import { ADAPTERS } from '../../../src/core/adapters/registry'

describe('ADAPTERS registry', () => {
  it('registers exactly the fake and pptx adapters', () => {
    expect(ADAPTERS.map((a) => a.name).sort()).toEqual(['fake', 'pptx'])
  })

  it('resolves a .fake.json file to the fake adapter', () => {
    const adapter = adapterFor('doc.fake.json', ADAPTERS)
    expect(adapter?.name).toBe('fake')
  })

  it('resolves a .pptx file to the pptx adapter', () => {
    const adapter = adapterFor('deck.pptx', ADAPTERS)
    expect(adapter?.name).toBe('pptx')
  })

  it('returns null for an unregistered extension', () => {
    expect(adapterFor('doc.docx', ADAPTERS)).toBeNull()
  })
})
