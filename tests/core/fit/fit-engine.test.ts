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

  // Regression: stepDown's -0.5 descent (used below 6pt) can jump straight
  // past FLOOR_PT for a fractional starting size instead of landing on it
  // exactly (e.g. 12.3pt's descent reaches 0.8 -> 0.3, which is below the
  // 0.5pt floor). fontSizePt must never go below FLOOR_PT regardless of the
  // starting size's fractional part, and the tiny box here (guaranteeing
  // the text never fits at any size) forces the shrink loop all the way
  // down to the floor for each one.
  it.each([12.3, 11.25, 0.55])(
    'never shrinks fontSizePt below the 0.5pt floor for a fractional start size of %spt',
    (startSizePt) => {
      const r = fit(
        'x'.repeat(500),
        { wPt: 4, hPt: 4 },
        { family: 'Noto Sans', sizePt: startSizePt }
      )
      expect(r.fontSizePt).toBeGreaterThanOrEqual(0.5)
      expect(r.fontSizePt).toBe(0.5)
      expect(r.overflowed).toBe(true)
    }
  )

  // Regression: a word-wrap bug let a token that STARTS a line skip the
  // force-break check entirely (the `line === ''` branch short-circuited
  // before ever measuring the token), so an oversized leading token was
  // accepted as a single unbroken line. The engine then had to shrink the
  // font drastically just to make that one giant line's width fit, instead
  // of wrapping it into several lines at a reasonable size. Self-consistency
  // checks alone (like the invariant test below) don't catch this: an
  // unbroken line that "fits" only because the font shrank to a near-floor
  // size still measures as fitting. These tests assert wrapping actually
  // happened, not just that whatever size was picked is self-consistent.
  it('force-breaks an oversized token even when it starts the line', () => {
    const r = fit('A'.repeat(400), { wPt: 60, hPt: 2000 }, font)
    expect(r.lines.length).toBeGreaterThan(1)
    expect(r.overflowed).toBe(false)
  })

  it('shrinks a leading oversized word about as much as the same word mid-text', () => {
    const box = { wPt: 60, hPt: 30 }
    const longWord = 'Antidisestablishmentarianism'
    const leading = fit(longWord, box, font)
    const nonLeading = fit(`X ${longWord}`, box, font)

    // Wrapping must actually happen in both cases.
    expect(leading.lines.length).toBeGreaterThan(1)
    expect(nonLeading.lines.length).toBeGreaterThan(1)

    // A token that starts a line must not be forced to shrink dramatically
    // more than the identical token appearing mid-paragraph, where
    // force-breaking already worked before this fix.
    expect(Math.abs(leading.fontSizePt - nonLeading.fontSizePt)).toBeLessThanOrEqual(1)
  })

  // Fit invariant over a grid: whatever fits must actually measure inside the box,
  // and one descent step larger must NOT fit (else we shrank too far).
  it('fit invariant + minimality across a fixture grid', () => {
    // Exactly 200 characters, computed rather than hand-counted, since a
    // long CJK paragraph (no spaces to wrap on - every character is its own
    // break opportunity per fit-engine's CJK_BREAK_CHAR table) is a
    // meaningfully different wrapping/shrinking shape than the short CJK
    // sentence above.
    const cjk200 = '技术规格和测试程序的内部业务文档。'.repeat(12).slice(0, 200)
    expect(cjk200).toHaveLength(200)

    const texts = [
      'Hello',
      'The quick brown fox jumps over the lazy dog. '.repeat(3).trim(),
      '技术规格和测试程序的内部业务文档',
      cjk200,
      'Antidisestablishmentarianism supercalifragilistic'
    ]
    const boxes = [
      { wPt: 60, hPt: 30 },
      { wPt: 150, hPt: 60 },
      { wPt: 300, hPt: 20 }
    ]
    const fractionalStartFonts = [
      { family: 'Noto Sans', sizePt: 24 },
      { family: 'Noto Sans', sizePt: 12.3 },
      { family: 'Noto Sans', sizePt: 11.25 }
    ]
    for (const text of texts)
      for (const box of boxes)
        for (const startFont of fractionalStartFonts) {
          const r = fit(text, box, startFont)
          if (!r.overflowed) {
            expect(measuredFits(r.lines, r.fontSizePt, box, startFont)).toBe(true)
            const bigger = stepUp(r.fontSizePt)
            // Minimality via stepUp(result) reconstructs "the size fit()
            // tried right before landing on result" - valid IFF stepUp is
            // truly the inverse of the stepDown that produced it. stepDown
            // changes its own step size exactly at the 6pt threshold
            // (-1 above 6, -0.5 at/below), so for a result landing strictly
            // inside (5, 6) that reconstruction is ambiguous: e.g. 5.3
            // could have come from stepDown(6.3) (the >6 branch, one step
            // up = 6.3) or from stepDown(5.8) (the <=6 branch, one step up
            // = 5.8) - both are legal predecessors and stepUp(5.3) can only
            // reconstruct one of them. Outside that open interval the
            // branch is unambiguous from the result alone (proof: result
            // >= 6 forces the predecessor to be result+1 via the >6 branch;
            // result <= 5 forces it to be result+0.5 via the <=6 branch),
            // so the assertion stays meaningful everywhere except this one
            // pre-existing, out-of-scope corner of fit-engine's own
            // stepUp/stepDown (not part of this task - see fit-engine.ts).
            const reconstructionAmbiguous = r.fontSizePt > 5 && r.fontSizePt < 6
            if (!reconstructionAmbiguous && bigger <= startFont.sizePt) {
              const rBigger = layoutAt(text, bigger, box, startFont)
              expect(rBigger.fits).toBe(false)
            }
          }
        }
  })
})
