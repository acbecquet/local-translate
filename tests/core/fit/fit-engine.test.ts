import { describe, expect, it } from 'vitest'
import { _internals, fit } from '../../../src/core/fit/fit-engine'
import { registerBundledFonts } from '../../../src/core/fit/fonts'

const { layoutAt, measuredFits, stepUp } = _internals

registerBundledFonts()
const font = { family: 'Noto Sans', sizePt: 24 }

describe('fit-engine', () => {
  it('keeps short text at its original size', () => {
    const r = fit('Hi', { wPt: 300, hPt: 100 }, font)
    expect(r.fontSizePt).toBe(24)
    expect(r.lines).toEqual(['Hi'])
    expect(r.overflowed).toBe(false)
  })

  it('wraps long text at box width', () => {
    const r = fit('The quick brown fox jumps over the lazy dog', { wPt: 150, hPt: 200 }, font)
    expect(r.lines.length).toBeGreaterThan(1)
    expect(r.overflowed).toBe(false)
  })

  it('shrinks font until everything fits', () => {
    const r = fit('word '.repeat(60).trim(), { wPt: 150, hPt: 60 }, font)
    expect(r.fontSizePt).toBeLessThan(24)
    expect(r.overflowed).toBe(false)
  })

  it('wraps CJK text without spaces', () => {
    const r = fit(
      '这是一个没有空格的很长的中文句子需要正确换行',
      { wPt: 100, hPt: 200 },
      {
        family: 'Noto Sans CJK SC',
        sizePt: 18
      }
    )
    expect(r.lines.length).toBeGreaterThan(1)
    expect(r.overflowed).toBe(false)
  })

  it('honors explicit line breaks', () => {
    const r = fit('line one\nline two', { wPt: 300, hPt: 100 }, font)
    expect(r.lines.length).toBeGreaterThanOrEqual(2)
  })

  it('flags overflow only at the 0.5pt floor', () => {
    const r = fit('x'.repeat(5000), { wPt: 4, hPt: 4 }, font)
    expect(r.fontSizePt).toBe(0.5)
    expect(r.overflowed).toBe(true)
  })

  // Fit invariant over a grid: whatever fits must actually measure inside the box,
  // and one descent step larger must NOT fit (else we shrank too far).
  it('fit invariant + minimality across a fixture grid', () => {
    const texts = [
      'Hello',
      'The quick brown fox jumps over the lazy dog. '.repeat(3).trim(),
      '技术规格和测试程序的内部业务文档',
      'Antidisestablishmentarianism supercalifragilistic'
    ]
    const boxes = [
      { wPt: 60, hPt: 30 },
      { wPt: 150, hPt: 60 },
      { wPt: 300, hPt: 20 }
    ]
    for (const text of texts)
      for (const box of boxes) {
        const r = fit(text, box, font)
        if (!r.overflowed) {
          expect(measuredFits(r.lines, r.fontSizePt, box, font)).toBe(true)
          const bigger = stepUp(r.fontSizePt)
          if (bigger <= font.sizePt) {
            const rBigger = layoutAt(text, bigger, box, font)
            expect(rBigger.fits).toBe(false)
          }
        }
      }
  })
})
