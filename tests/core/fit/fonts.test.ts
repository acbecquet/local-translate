import { describe, expect, it } from 'vitest'
import { registerBundledFonts, resolveFamily } from '../../../src/core/fit/fonts'

describe('fonts', () => {
  it('registers bundled fonts idempotently and resolves known families', () => {
    registerBundledFonts()
    registerBundledFonts() // second call must not throw or duplicate
    expect(resolveFamily('Noto Sans')).toEqual({ family: 'Noto Sans', substituted: false })
  })

  it('substitutes unknown families to a bundled fallback', () => {
    registerBundledFonts()
    const r = resolveFamily('Calibri-Not-Installed-XYZ')
    expect(r.substituted).toBe(true)
    expect(['Noto Sans', 'Noto Sans CJK SC']).toContain(r.family)
  })
})
