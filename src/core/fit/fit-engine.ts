import { Canvas } from 'skia-canvas'
import type { Box, FontSpec } from '../segments'
import { resolveFamily } from './fonts'

export interface FitResult {
  fontSizePt: number
  lines: string[]
  overflowed: boolean
}

const FLOOR_PT = 0.5
const LINE_HEIGHT_FACTOR = 1.2
const canvas = new Canvas(8, 8) // throwaway measurement surface, never rendered
const ctx = canvas.getContext('2d')

function setFont(sizePt: number, font: FontSpec): void {
  const { family } = resolveFamily(font.family)
  const weight = font.bold ? 'bold ' : ''
  const style = font.italic ? 'italic ' : ''
  // 1px == 1pt convention (see plan Global Constraints)
  ctx.font = `${style}${weight}${sizePt}px "${family}"`
}

function width(s: string): number {
  return ctx.measureText(s).width
}

// CJK Symbols/Punctuation + Unified Ideographs (U+3000-U+9FFF), CJK Compatibility
// Ideographs (U+F900-U+FAFF), Hiragana + Katakana (U+3040-U+30FF), Fullwidth/Halfwidth
// forms (U+FF00-U+FFEF). Written with \u escapes (never literal characters): besides
// tripping eslint's no-irregular-whitespace rule (U+3000 is an ideographic space), a
// literal U+F900 pasted into a character class is prone to silent NFC normalization to
// its canonical decomposition U+8C48, which would widen this range to also swallow
// Hangul syllables, surrogate code points, and the Private Use Area - scripts it was
// never meant to match.
const CJK_BREAK_CHAR = /[\u3000-\u9fff\uf900-\ufaff\u3040-\u30ff\uff00-\uffef]/

/** Break opportunities: after spaces, and after every CJK char. */
function tokens(text: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    if (ch === ' ') {
      if (cur) out.push(cur)
      out.push(' ')
      cur = ''
    } else if (CJK_BREAK_CHAR.test(ch)) {
      if (cur) out.push(cur)
      out.push(ch)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

/** Break a single token into pieces that each individually fit within maxW. */
function breakToken(tok: string, maxW: number): string[] {
  const chars = [...tok]
  const pieces: string[] = []
  let piece = ''
  for (const ch of chars) {
    const cand = piece + ch
    if (piece !== '' && width(cand) > maxW) {
      pieces.push(piece)
      piece = ch
    } else {
      piece = cand
    }
  }
  if (piece) pieces.push(piece)
  return pieces
}

function wrapParagraph(par: string, maxW: number): { lines: string[]; fits: boolean } {
  const lines: string[] = []
  let line = ''
  let fits = true

  const pushLine = (l: string): void => {
    if (width(l) > maxW) fits = false
    lines.push(l)
  }

  for (const tok of tokens(par)) {
    if (tok === ' ') {
      // Trailing space never forces a break by itself; keep accumulating,
      // final trim happens when the line is flushed.
      line += line === '' ? '' : tok
      continue
    }

    const cand = (line + tok).trimEnd()
    if (line === '' || width(cand) <= maxW) {
      line = line + tok
      continue
    }

    // tok doesn't fit appended to the current line: flush current line, start fresh.
    if (line.trimEnd()) pushLine(line.trimEnd())

    // Does the token fit on its own line? If not, force character breaks.
    if (width(tok) > maxW) {
      const pieces = breakToken(tok, maxW)
      for (let i = 0; i < pieces.length - 1; i++) pushLine(pieces[i])
      line = pieces[pieces.length - 1] ?? ''
    } else {
      line = tok
    }
  }
  if (line.trimEnd()) pushLine(line.trimEnd())
  return { lines: lines.length ? lines : [''], fits }
}

function layout(
  text: string,
  sizePt: number,
  box: Box,
  font: FontSpec
): { lines: string[]; fits: boolean } {
  setFont(sizePt, font)
  let fits = true
  const lines = text.split('\n').flatMap((par) => {
    const w = wrapParagraph(par, box.wPt)
    fits = fits && w.fits
    return w.lines
  })
  const maxLineW = Math.max(...lines.map((l) => width(l)))
  const totalH = lines.length * sizePt * LINE_HEIGHT_FACTOR
  return { lines, fits: fits && maxLineW <= box.wPt && totalH <= box.hPt }
}

function stepDown(sizePt: number): number {
  return sizePt > 6 ? sizePt - 1 : sizePt - 0.5
}
function stepUp(sizePt: number): number {
  return sizePt >= 6 ? sizePt + 1 : sizePt + 0.5
}

export function fit(text: string, box: Box, font: FontSpec): FitResult {
  let size = font.sizePt
  while (size >= FLOOR_PT) {
    const r = layout(text, size, box, font)
    if (r.fits) return { fontSizePt: size, lines: r.lines, overflowed: false }
    size = stepDown(size)
  }
  const r = layout(text, FLOOR_PT, box, font)
  return { fontSizePt: FLOOR_PT, lines: r.lines, overflowed: !r.fits }
}

export const _internals = {
  layoutAt: (text: string, sizePt: number, box: Box, font: FontSpec) =>
    layout(text, sizePt, box, font),
  measuredFits: (lines: string[], sizePt: number, box: Box, font: FontSpec) => {
    setFont(sizePt, font)
    const maxW = Math.max(...lines.map((l) => width(l)))
    return maxW <= box.wPt && lines.length * sizePt * LINE_HEIGHT_FACTOR <= box.hPt
  },
  stepUp
}
