/**
 * PPTX geometry resolution: turns raw OOXML shape XML into pt-denominated
 * boxes and font defaults that the fit engine can consume directly.
 *
 * Unit rules (ECMA-376 DrawingML): 1 pt = 12700 EMU; `a:rPr/@sz` is
 * hundredths of a point (sz="1125" -> 11.25pt).
 *
 * Layering: this module only ever REPORTS geometry facts (box size, font
 * size, inset amounts) - it never decides how a caller uses them. In
 * particular `insetsPt` is reported even though `box` already has insets
 * subtracted out of it, because the two serve different callers: `box` is
 * the ready-to-use fit area (what the fit engine measures text against),
 * while `insetsPt` lets an adapter recover the pre-inset shape footprint
 * (`box.wPt + insetsPt.l + insetsPt.r` == the shape's usable-width source
 * size in the same coordinate space as `box`, insets and box both scaled
 * by the same `groupScale`) for positioning text within the original
 * shape's bounding rectangle. Nothing here subtracts insets a second time
 * or applies them to anything other than `box`.
 */
import type { Document, Element } from '@xmldom/xmldom'
import { A_NS, P_NS, childElems, elems } from './ooxml'

const EMU_PER_PT = 12700

/** bodyPr inset defaults (ECMA-376 CT_TextBodyProperties) when the attribute is absent. */
const DEFAULT_LR_INSET_EMU = 91440
const DEFAULT_TB_INSET_EMU = 45720

/**
 * Placeholder default font sizes used only when a placeholder's txBody has
 * no explicit run size anywhere - becquet's table. Not derived from the
 * deck's actual `p:txStyles` (out of scope for this module); any
 * placeholder type not listed here falls through to `fontPt: null`.
 */
const PLACEHOLDER_DEFAULT_FONT_PT: Record<string, number> = {
  title: 44,
  body: 18
}

/** ECMA-376 CT_Placeholder attribute defaults (19.7.9): type="obj", idx="0". */
const DEFAULT_PH_TYPE = 'obj'
const DEFAULT_PH_IDX = 0

export interface ResolvedBox {
  wPt: number
  hPt: number
}

export interface ShapeGeom {
  /** null = no constraint resolvable (fit engine skipped, size preserved). */
  box: ResolvedBox | null
  /** Explicit run size if present, else placeholder default, else null. */
  fontPt: number | null
  insetsPt: { l: number; r: number; t: number; b: number }
}

export interface ResolveShapeGeomOptions {
  /** p:sp / p:graphicFrame / nested child (p:sp, p:pic, or p:grpSp inside a group). */
  shape: Element
  slideDoc: Document
  layoutDoc: Document | null
  masterDoc: Document | null
  /** Accumulated group transform (product of every ancestor group's ext/chExt ratio). */
  groupScale?: { sx: number; sy: number }
}

export function resolveShapeGeom(opts: ResolveShapeGeomOptions): ShapeGeom {
  const { shape, layoutDoc, masterDoc } = opts
  const groupScale = opts.groupScale ?? { sx: 1, sy: 1 }

  const fontPt = resolveFontPt(shape)
  const insetsPt = readInsetsPt(shape, groupScale)

  const ownExt = getOwnExtEmu(shape)
  const extEmu = ownExt ?? resolveInheritedExtEmu(shape, layoutDoc, masterDoc)
  if (!extEmu) {
    return { box: null, fontPt, insetsPt }
  }

  const insetsEmu = readInsetsEmu(shape)
  const usableWEmu = extEmu.cx - insetsEmu.l - insetsEmu.r
  const usableHEmu = extEmu.cy - insetsEmu.t - insetsEmu.b

  const box: ResolvedBox = {
    wPt: (usableWEmu / EMU_PER_PT) * groupScale.sx,
    hPt: (usableHEmu / EMU_PER_PT) * groupScale.sy
  }

  return { box, fontPt, insetsPt }
}

/** [row][col] cell boxes; horizontal (gridSpan) and vertical (rowSpan/vMerge) merges unioned. */
export function tableCellBoxes(graphicFrame: Element): ResolvedBox[][] {
  const tbl = elems(graphicFrame, A_NS, 'tbl')[0]
  if (!tbl) return []

  const tblGrid = childElems(tbl, A_NS, 'tblGrid')[0]
  const colWidthsEmu = tblGrid
    ? childElems(tblGrid, A_NS, 'gridCol').map((c) => Number(c.getAttribute('w')) || 0)
    : []
  const trs = childElems(tbl, A_NS, 'tr')
  const rowHeightsEmu = trs.map((tr) => Number(tr.getAttribute('h')) || 0)

  const numRows = trs.length
  const numCols = colWidthsEmu.length
  const rowsTcs = trs.map((tr) => childElems(tr, A_NS, 'tc'))

  const tcAt = (r: number, c: number): Element | undefined => rowsTcs[r]?.[c]

  // Pass 1: horizontal spans. Every grid column slot has its own <a:tc> in
  // OOXML (continuation cells are placeholders, not omitted), so a
  // master's gridSpan tells us exactly how many upcoming column indices in
  // THIS row to union and how far to jump the scan - continuation cells
  // are only ever reached by being jumped over, never as a loop head.
  const widthPt: number[][] = Array.from({ length: numRows }, () => new Array(numCols).fill(0))
  for (let r = 0; r < numRows; r++) {
    let c = 0
    while (c < numCols) {
      const tc = tcAt(r, c)
      const span = clampSpan(tc?.getAttribute('gridSpan'))
      const unionEmu = sumRange(colWidthsEmu, c, span)
      for (let k = 0; k < span && c + k < numCols; k++) {
        widthPt[r][c + k] = unionEmu / EMU_PER_PT
      }
      c += span
    }
  }

  // Pass 2: vertical spans, symmetric to pass 1 but scanning each column
  // top-to-bottom using rowSpan on the master row's cell for that column.
  const heightPt: number[][] = Array.from({ length: numRows }, () => new Array(numCols).fill(0))
  for (let c = 0; c < numCols; c++) {
    let r = 0
    while (r < numRows) {
      const tc = tcAt(r, c)
      const span = clampSpan(tc?.getAttribute('rowSpan'))
      const unionEmu = sumRange(rowHeightsEmu, r, span)
      for (let k = 0; k < span && r + k < numRows; k++) {
        heightPt[r + k][c] = unionEmu / EMU_PER_PT
      }
      r += span
    }
  }

  return Array.from({ length: numRows }, (_, r) =>
    Array.from({ length: numCols }, (_, c) => ({ wPt: widthPt[r][c], hPt: heightPt[r][c] }))
  )
}

/** { sx, sy } = ext / chExt (the group's own transform, not compounded with any ancestor). */
export function groupChildScale(grpSp: Element): { sx: number; sy: number } {
  const identity = { sx: 1, sy: 1 }
  const grpSpPr = childElems(grpSp, P_NS, 'grpSpPr')[0]
  const xfrm = grpSpPr && childElems(grpSpPr, A_NS, 'xfrm')[0]
  if (!xfrm) return identity

  const ext = childElems(xfrm, A_NS, 'ext')[0]
  const chExt = childElems(xfrm, A_NS, 'chExt')[0]
  if (!ext || !chExt) return identity

  const cx = Number(ext.getAttribute('cx'))
  const cy = Number(ext.getAttribute('cy'))
  const chCx = Number(chExt.getAttribute('cx'))
  const chCy = Number(chExt.getAttribute('cy'))
  if (!chCx || !chCy) return identity

  return { sx: cx / chCx, sy: cy / chCy }
}

// ---- internals ----

function clampSpan(attr: string | null | undefined): number {
  const n = attr ? Number(attr) : 1
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}

function sumRange(values: number[], start: number, span: number): number {
  let total = 0
  for (let i = start; i < start + span && i < values.length; i++) total += values[i]
  return total
}

/** The shape's own `<a:ext>` in EMU, from `p:spPr/a:xfrm` (sp/pic/grpSp) or `p:xfrm` (graphicFrame). */
function getOwnExtEmu(shape: Element): { cx: number; cy: number } | null {
  const xfrm = getOwnXfrm(shape)
  if (!xfrm) return null
  const ext = childElems(xfrm, A_NS, 'ext')[0]
  if (!ext) return null
  const cx = Number(ext.getAttribute('cx'))
  const cy = Number(ext.getAttribute('cy'))
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  return { cx, cy }
}

function getOwnXfrm(shape: Element): Element | undefined {
  switch (shape.localName) {
    case 'sp':
    case 'pic': {
      const spPr = childElems(shape, P_NS, 'spPr')[0]
      return spPr && childElems(spPr, A_NS, 'xfrm')[0]
    }
    case 'grpSp': {
      const grpSpPr = childElems(shape, P_NS, 'grpSpPr')[0]
      return grpSpPr && childElems(grpSpPr, A_NS, 'xfrm')[0]
    }
    case 'graphicFrame':
      // p:graphicFrame's transform is a direct <p:xfrm> child (P_NS), not
      // nested under a spPr/grpSpPr - distinct from every other shape kind.
      return childElems(shape, P_NS, 'xfrm')[0]
    default:
      return undefined
  }
}

/** Resolves a placeholder's box via the layout's matching p:ph, falling back to the master. */
function resolveInheritedExtEmu(
  shape: Element,
  layoutDoc: Document | null,
  masterDoc: Document | null
): { cx: number; cy: number } | null {
  const ph = getPh(shape)
  if (!ph) return null
  return findPlaceholderExtEmu(layoutDoc, ph) ?? findPlaceholderExtEmu(masterDoc, ph)
}

function findPlaceholderExtEmu(
  doc: Document | null,
  wantPh: Element
): { cx: number; cy: number } | null {
  if (!doc) return null
  const wantType = phType(wantPh)
  const wantIdx = phIdx(wantPh)
  for (const sp of elems(doc, P_NS, 'sp')) {
    const candidatePh = getPh(sp)
    if (!candidatePh) continue
    if (phType(candidatePh) === wantType && phIdx(candidatePh) === wantIdx) {
      const ext = getOwnExtEmu(sp)
      if (ext) return ext
    }
  }
  return null
}

/** The shape's own `<p:ph>` (only `p:sp` elements can be placeholders), or null. */
function getPh(shape: Element): Element | null {
  if (shape.localName !== 'sp') return null
  const nvSpPr = childElems(shape, P_NS, 'nvSpPr')[0]
  const nvPr = nvSpPr && childElems(nvSpPr, P_NS, 'nvPr')[0]
  const ph = nvPr && childElems(nvPr, P_NS, 'ph')[0]
  return ph ?? null
}

function phType(ph: Element): string {
  return ph.getAttribute('type') || DEFAULT_PH_TYPE
}

function phIdx(ph: Element): number {
  return ph.hasAttribute('idx') ? Number(ph.getAttribute('idx')) : DEFAULT_PH_IDX
}

function findTxBody(shape: Element): Element | undefined {
  if (shape.localName !== 'sp') return undefined
  return childElems(shape, P_NS, 'txBody')[0]
}

/** First explicit run size in document order; else the placeholder-type default; else null. */
function resolveFontPt(shape: Element): number | null {
  const txBody = findTxBody(shape)
  if (txBody) {
    for (const r of elems(txBody, A_NS, 'r')) {
      const rPr = childElems(r, A_NS, 'rPr')[0]
      if (rPr?.hasAttribute('sz')) {
        return Number(rPr.getAttribute('sz')) / 100
      }
    }
  }

  const ph = getPh(shape)
  if (ph) {
    const fallback = PLACEHOLDER_DEFAULT_FONT_PT[phType(ph)]
    if (fallback !== undefined) return fallback
  }

  return null
}

function readInsetsEmu(shape: Element): { l: number; r: number; t: number; b: number } {
  const txBody = findTxBody(shape)
  const bodyPr = txBody && childElems(txBody, A_NS, 'bodyPr')[0]
  const readOr = (attr: string, fallback: number): number =>
    bodyPr?.hasAttribute(attr) ? Number(bodyPr.getAttribute(attr)) : fallback

  return {
    l: readOr('lIns', DEFAULT_LR_INSET_EMU),
    r: readOr('rIns', DEFAULT_LR_INSET_EMU),
    t: readOr('tIns', DEFAULT_TB_INSET_EMU),
    b: readOr('bIns', DEFAULT_TB_INSET_EMU)
  }
}

function readInsetsPt(
  shape: Element,
  groupScale: { sx: number; sy: number }
): { l: number; r: number; t: number; b: number } {
  const e = readInsetsEmu(shape)
  return {
    l: (e.l / EMU_PER_PT) * groupScale.sx,
    r: (e.r / EMU_PER_PT) * groupScale.sx,
    t: (e.t / EMU_PER_PT) * groupScale.sy,
    b: (e.b / EMU_PER_PT) * groupScale.sy
  }
}
