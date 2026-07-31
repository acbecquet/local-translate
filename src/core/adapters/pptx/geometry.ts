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
 * shape's bounding rectangle. `box` already excludes insets, permanently -
 * a caller must never subtract `insetsPt` from `box` again (that would
 * double-shrink the fit area). See the field doc comments on `ShapeGeom`
 * for the normative statement of this rule.
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

/**
 * Placeholder type aliases applied when matching a slide's placeholder
 * against candidate `p:ph` elements on the layout/master, and when looking
 * up the default font size below. Real decks routinely give a title
 * slide's centered title/subtitle the specialized types "ctrTitle"/
 * "subTitle" on the slide (and often the layout), while the master
 * frequently only defines the generic "title"/"body" placeholders these
 * conceptually inherit from - without this alias, a slide-level ctrTitle
 * placeholder could never fall back to a master-level title placeholder.
 * Both sides of any comparison are normalized through this table, so a
 * literal "title" vs "title" match (no alias involved) is unaffected.
 */
const PH_TYPE_ALIASES: Record<string, string> = {
  ctrTitle: 'title',
  subTitle: 'body'
}

function normalizePhType(type: string): string {
  return PH_TYPE_ALIASES[type] ?? type
}

export interface ResolvedBox {
  wPt: number
  hPt: number
}

export interface ShapeGeom {
  /**
   * null = no constraint resolvable (fit engine skipped, size preserved).
   * When non-null, `box` ALREADY EXCLUDES bodyPr insets on every side - it
   * is the ready-to-measure usable text area, not the shape's raw bounding
   * box. Do NOT subtract `insetsPt` from `box`: insets have already been
   * removed exactly once to produce this value, and subtracting them again
   * double-shrinks the fit area. `insetsPt` exists for positioning and
   * diagnostics only (see below) - it is not a further input to `box`.
   */
  box: ResolvedBox | null
  /**
   * Explicit run size if present, else placeholder default, else null.
   * Deliberately NOT scaled by `groupScale`: PowerPoint applies group
   * transforms to child shape GEOMETRY but renders text at its nominal
   * point size (verified empirically 2026-07-31 on a deck with real 2x
   * and 0.5x XML transforms - glyphs rendered identical to an ungrouped
   * 18pt reference while boxes scaled). The fit engine therefore measures
   * nominal-size text against the SCALED box, which is exactly what
   * PowerPoint will render.
   */
  fontPt: number | null
  /**
   * bodyPr inset amounts in pt (explicit or the OOXML default), scaled by
   * the same `groupScale` as `box`. Reported for the adapter's own
   * positioning/diagnostic use - e.g. recovering the shape's pre-inset
   * source size via `box.wPt + insetsPt.l + insetsPt.r` - NEVER meant to
   * be subtracted from `box`, which already reflects insets having been
   * removed (see `box`'s doc comment above).
   */
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

/**
 * [row][col] cell boxes; horizontal (gridSpan) and vertical (rowSpan/vMerge)
 * merges unioned, then the anchor cell's own `a:tcPr` margins (explicit or
 * the OOXML default) are subtracted from that union EXACTLY ONCE - mirroring
 * how `resolveShapeGeom` subtracts `bodyPr` insets from a shape's box.
 * Every cell covered by a merge shares the identical anchor, so they all
 * report the identical post-margin union; a covered (hMerge/vMerge-only)
 * cell's own `a:tcPr` is never consulted, matching how only the anchor
 * carries real span/formatting information per OOXML merge semantics (see
 * the anchorOf() doc comment below).
 */
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

  // Resolves any grid cell to the top-left "anchor" of whatever merge
  // region it belongs to (itself, if unmerged). Per OOXML, only the true
  // anchor carries gridSpan/rowSpan; every other cell covered by a merge
  // carries just hMerge and/or vMerge with no repeated span info - so a
  // combined horizontal+vertical merge cannot be resolved by scanning rows
  // and columns independently (a continuation cell in row anchor+1 has no
  // gridSpan of its own to read, even though it's still part of the
  // horizontal span too). Walking up through vMerge first, then left
  // through hMerge at whatever row that lands on, threads both axes
  // correctly for pure-horizontal, pure-vertical, and combined merges
  // alike.
  const anchorOf = (r: number, c: number): [number, number] => {
    let ar = r
    while (ar > 0 && tcAt(ar, c)?.hasAttribute('vMerge')) ar -= 1
    let ac = c
    while (ac > 0 && tcAt(ar, ac)?.hasAttribute('hMerge')) ac -= 1
    return [ar, ac]
  }

  const boxes: ResolvedBox[][] = Array.from({ length: numRows }, () => new Array(numCols))
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const [ar, ac] = anchorOf(r, c)
      const anchor = tcAt(ar, ac)
      const colSpan = clampSpan(anchor?.getAttribute('gridSpan'))
      const rowSpan = clampSpan(anchor?.getAttribute('rowSpan'))
      const marginsEmu = readCellMarginsEmu(anchor)
      const rawWEmu = sumRange(colWidthsEmu, ac, colSpan)
      const rawHEmu = sumRange(rowHeightsEmu, ar, rowSpan)
      boxes[r][c] = {
        wPt: Math.max(0, rawWEmu - marginsEmu.l - marginsEmu.r) / EMU_PER_PT,
        hPt: Math.max(0, rawHEmu - marginsEmu.t - marginsEmu.b) / EMU_PER_PT
      }
    }
  }
  return boxes
}

/** `a:tcPr` margin amounts in EMU (explicit or the OOXML default) for one table cell - mirrors readInsetsEmu's shape for bodyPr insets. `tc` is undefined only for a malformed deck missing the anchor cell entirely, in which case the OOXML defaults apply. */
function readCellMarginsEmu(tc: Element | undefined): {
  l: number
  r: number
  t: number
  b: number
} {
  const tcPr = tc && childElems(tc, A_NS, 'tcPr')[0]
  const readOr = (attr: string, fallback: number): number =>
    tcPr?.hasAttribute(attr) ? Number(tcPr.getAttribute(attr)) : fallback

  return {
    l: readOr('marL', DEFAULT_LR_INSET_EMU),
    r: readOr('marR', DEFAULT_LR_INSET_EMU),
    t: readOr('marT', DEFAULT_TB_INSET_EMU),
    b: readOr('marB', DEFAULT_TB_INSET_EMU)
  }
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
  const wantType = normalizePhType(phType(wantPh))
  const wantIdx = phIdx(wantPh)
  for (const sp of elems(doc, P_NS, 'sp')) {
    const candidatePh = getPh(sp)
    if (!candidatePh) continue
    if (normalizePhType(phType(candidatePh)) === wantType && phIdx(candidatePh) === wantIdx) {
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

/**
 * First explicit run size in document order; else the placeholder-type
 * default; else null. NO group scaling is applied: PowerPoint renders
 * grouped text at nominal point size even when the group's XML transform
 * scales the child geometry (empirically verified 2026-07-31; supersedes
 * the earlier min(sx,sy) controller ruling, which predated the evidence).
 * See ShapeGeom.fontPt's doc comment for the full rendering-model note.
 */
function resolveFontPt(shape: Element): number | null {
  return resolveRawFontPt(shape)
}

function resolveRawFontPt(shape: Element): number | null {
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
    const fallback = PLACEHOLDER_DEFAULT_FONT_PT[normalizePhType(phType(ph))]
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
