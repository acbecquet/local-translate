import type { Box, FontSpec } from '../segments'
import { measureCtx, resolveFamily } from './fonts'

export interface FitResult {
  fontSizePt: number
  lines: string[]
  overflowed: boolean
}

const FLOOR_PT = 0.5
const LINE_HEIGHT_FACTOR = 1.2
const ctx = measureCtx()

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

// CJK Symbols/Punctuation + Unified Ideographs (U+3000-U+9FFF, which already covers
// Hiragana/Katakana at U+3040-U+30FF), CJK Compatibility Ideographs (U+F900-U+FAFF),
// and Fullwidth/Halfwidth forms (U+FF00-U+FFEF). Written with \u escapes (never
// literal characters): besides tripping eslint's no-irregular-whitespace rule
// (U+3000 is an ideographic space), a literal U+F900 pasted into a character class
// is prone to silent NFC normalization to its canonical decomposition U+8C48, which
// would widen this range to also swallow Hangul syllables, surrogate code points,
// and the Private Use Area - scripts it was never meant to match.
const CJK_BREAK_CHAR = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/

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

function wrapParagraph(par: string, maxW: number): string[] {
  const lines: string[] = []
  let line = ''

  // Start a fresh line with `tok`. Used both for the first token of a
  // paragraph and for a token that didn't fit appended to the previous
  // line - the same force-break check applies either way, so a token can
  // never dodge it just by being first.
  const startLine = (tok: string): void => {
    if (width(tok) > maxW) {
      const pieces = breakToken(tok, maxW)
      for (let i = 0; i < pieces.length - 1; i++) lines.push(pieces[i])
      line = pieces[pieces.length - 1] ?? ''
    } else {
      line = tok
    }
  }

  for (const tok of tokens(par)) {
    if (tok === ' ') {
      // Leading/trailing spaces never force a break by themselves.
      if (line !== '') line += tok
      continue
    }

    if (line === '') {
      startLine(tok)
      continue
    }

    const cand = (line + tok).trimEnd()
    if (width(cand) <= maxW) {
      line = line + tok
      continue
    }

    // tok doesn't fit appended to the current line: flush it, then let
    // startLine decide how tok begins the next one (forced breaks included).
    lines.push(line.trimEnd())
    line = ''
    startLine(tok)
  }
  if (line.trimEnd()) lines.push(line.trimEnd())
  return lines.length ? lines : ['']
}

/** Single source of truth for "does this laid-out text fit the box". */
function fitsBox(lines: string[], sizePt: number, box: Box): boolean {
  const maxLineW = Math.max(...lines.map((l) => width(l)))
  const totalH = lines.length * sizePt * LINE_HEIGHT_FACTOR
  return maxLineW <= box.wPt && totalH <= box.hPt
}

function layout(
  text: string,
  sizePt: number,
  box: Box,
  font: FontSpec
): { lines: string[]; fits: boolean } {
  setFont(sizePt, font)
  const lines = text.split('\n').flatMap((par) => wrapParagraph(par, box.wPt))
  return { lines, fits: fitsBox(lines, sizePt, box) }
}

function stepDown(sizePt: number): number {
  return sizePt > 6 ? sizePt - 1 : sizePt - 0.5
}
function stepUp(sizePt: number): number {
  return sizePt >= 6 ? sizePt + 1 : sizePt + 0.5
}

export function fit(text: string, box: Box, font: FontSpec): FitResult {
  let size = Math.max(font.sizePt, FLOOR_PT)
  let result = layout(text, size, box, font)
  while (!result.fits && size > FLOOR_PT) {
    size = stepDown(size)
    result = layout(text, size, box, font)
  }
  return { fontSizePt: size, lines: result.lines, overflowed: !result.fits }
}

export const _internals = {
  layoutAt: (text: string, sizePt: number, box: Box, font: FontSpec) =>
    layout(text, sizePt, box, font),
  measuredFits: (lines: string[], sizePt: number, box: Box, font: FontSpec) => {
    setFont(sizePt, font)
    return fitsBox(lines, sizePt, box)
  },
  stepUp
}
