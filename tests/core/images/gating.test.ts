import { describe, expect, it } from 'vitest'
import { containsCjk, isSourceLanguageRegion } from '../../../src/core/images/gating'

describe('isSourceLanguageRegion', () => {
  it('accepts a CJK-heavy region under a CJK source language', () => {
    expect(isSourceLanguageRegion('Chinese (Simplified)', '你好世界')).toBe(true)
  })

  it('rejects a pure-Latin region under a CJK source language', () => {
    expect(isSourceLanguageRegion('Chinese (Simplified)', 'Model X200')).toBe(false)
  })

  it('accepts right at the 30% CJK ratio threshold (>=, not >)', () => {
    // 10 non-space chars total, 3 CJK -> ratio exactly 0.3.
    expect(isSourceLanguageRegion('Japanese', 'ABCDEFG你好世')).toBe(true)
  })

  it('rejects just under the 30% CJK ratio threshold', () => {
    // 10 non-space chars total, 2 CJK -> ratio 0.2.
    expect(isSourceLanguageRegion('Korean', 'ABCDEFGH你好')).toBe(false)
  })

  it('ignores whitespace when computing the ratio', () => {
    // Same 3-of-10 non-space ratio as the boundary test above, with spaces
    // sprinkled in that must not count toward either the numerator or the
    // denominator.
    expect(isSourceLanguageRegion('Japanese', 'A B C D E F G 你好世')).toBe(true)
  })

  it('accepts every region under a non-CJK source language, including CJK text (v1: no filtering)', () => {
    expect(isSourceLanguageRegion('English', '你好世界')).toBe(true)
    expect(isSourceLanguageRegion('Spanish', 'Model X200')).toBe(true)
  })

  it('recognizes every CJK source-language spelling the app offers (zh-Hans/zh-Hant/ja/ko)', () => {
    expect(isSourceLanguageRegion('Chinese (Traditional)', 'Model X200')).toBe(false)
    expect(isSourceLanguageRegion('Japanese', 'Model X200')).toBe(false)
    expect(isSourceLanguageRegion('Korean', 'Model X200')).toBe(false)
  })

  it('treats empty text as failing the CJK ratio under a CJK source, but passthrough under others', () => {
    expect(isSourceLanguageRegion('Chinese (Simplified)', '')).toBe(false)
    expect(isSourceLanguageRegion('English', '')).toBe(true)
  })
})

describe('containsCjk', () => {
  it('is true for text containing any CJK character', () => {
    expect(containsCjk('你好世界')).toBe(true)
    expect(containsCjk('Model 你 X200')).toBe(true)
  })

  it('is false for pure-Latin text', () => {
    expect(containsCjk('Model X200')).toBe(false)
    expect(containsCjk('')).toBe(false)
  })
})
