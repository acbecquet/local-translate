/**
 * PPTX FormatAdapter: reduces a .pptx to TextSegments (extract) and writes
 * translations back into a lossless copy of the original file (apply).
 *
 * Both directions share one tree walk (`collectSites`) that assigns every
 * text-bearing node a stable, addressable id and resolves its box/font -
 * extract() maps the walk's output straight to TextSegment[]; apply() reruns
 * the SAME walk against the SAME source file (the pipeline always calls
 * apply() with the file extract() read) and, for every id it recognizes,
 * mutates that node's DOM in place. Because id derivation is a pure function
 * of the deck's own content, the two walks agree on every id without either
 * side needing to persist anything between calls.
 *
 * Id scheme (addresses, not opaque tokens - documented per the extract
 * contract):
 *   slide<N>/shape[name=<shape name>]/tb            - a shape's text body
 *   slide<N>/group[name=<g>]/.../shape[name=<s>]/tb - shape nested in group(s)
 *   slide<N>/table[gf-name=<name>]/r<R>c<C>          - a table cell (1-based)
 *   slide<N>/smartart[gf-name=<name>]/pt<modelId>    - a SmartArt data point
 *   slide<N>/notes                                   - the slide's notes body
 * A numeric `-2`, `-3`, ... suffix is appended whenever two nodes would
 * otherwise produce the identical id (e.g. two shapes sharing a name).
 */
import path from 'node:path'
import type { Document, Element, Node } from '@xmldom/xmldom'
import type { FormatAdapter } from '../adapter'
import type { Box, FontSpec, SegmentKind, TextSegment, TranslatedSegment } from '../../segments'
import {
  A_NS,
  P_NS,
  R_NS,
  RELS_NS,
  childElems,
  elems,
  openPptx,
  setRunText,
  textOfRun,
  type PptxArchive
} from './ooxml'
import { groupChildScale, resolveShapeGeom, tableCellBoxes } from './geometry'

/** DrawingML diagram (SmartArt) namespace - not part of ooxml.ts's exported constants (only a:/p:/r:/rels are). */
const DGM_NS = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'

const REL_TYPE_NOTES_SLIDE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'

const GRAPHIC_URI = {
  chart: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  ole: 'http://schemas.openxmlformats.org/presentationml/2006/ole',
  diagram: 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
}

/**
 * PowerPoint's line-wrapping metrics don't exactly match the skia-canvas
 * measurement fit() uses, so a translated line that just barely fits our
 * measured width can still clip in real PowerPoint. Shrinking only the box
 * WIDTH we hand to fit() by this factor gives PowerPoint's own wrap a safety
 * margin; height is left alone since vertical fit (line count) isn't subject
 * to the same cross-renderer measurement mismatch.
 */
const WRAP_SAFETY = 0.96

/**
 * Box handed to fit() for segments that must never shrink from their
 * starting size: notes (the notes pane scrolls - there's no "overflow" to
 * fix) and any segment whose real geometry is unresolvable
 * (`ShapeGeom.box === null`, which per geometry.ts's contract means "size
 * preserved"). It's larger than any real slide could ever be (EMU slide
 * dimensions top out at a few thousand pt), so fit() always finds the
 * segment's starting size already fits and returns it unchanged - which is
 * exactly what apply() checks (`fittedSizePt === font.sizePt`) to decide
 * whether to touch `sz` at all.
 */
const SENTINEL_BOX: Box = { wPt: 1_000_000, hPt: 1_000_000 }

/** Used only when neither an explicit run size nor (for shapes) a placeholder-type default resolves anything. */
const DEFAULT_FALLBACK_FONT_PT = 18
/** Used only when a segment's first non-empty run carries no a:latin/a:ea typeface at all. */
const DEFAULT_FALLBACK_FONT_FAMILY = 'Calibri'

/** CJK Unified Ideographs + Hiragana/Katakana + Hangul + compatibility/fullwidth forms - used only to pick a:ea vs a:latin typeface by script, a coarser heuristic than fit-engine's own wrap-break table (different job: family choice, not break opportunities). */
const CJK_RANGE = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

const ELEMENT_NODE = 1

interface Site {
  id: string
  kind: SegmentKind
  context: string
  groupKey: string
  text: string
  font: FontSpec
  box: Box
  /** The part to archive.markDirty() when this site's node is mutated. */
  partPath: string
  /** The `a:txBody` (shape/table cell/notes) or `dgm:t` (SmartArt point) element itself - has `a:bodyPr` + `a:p`* children directly, regardless of which wrapper it is. */
  bodyEl: Element
}

export class PptxAdapter implements FormatAdapter {
  readonly name = 'pptx'
  readonly extensions = ['.pptx']

  async extract(filePath: string): Promise<TextSegment[]> {
    const archive = await openPptx(filePath)
    return collectSites(archive).map((s) => ({
      id: s.id,
      text: s.text,
      box: s.box,
      font: s.font,
      context: s.context,
      groupKey: s.groupKey,
      kind: s.kind
    }))
  }

  /**
   * Reruns collectSites() against `filePath` (the same file extract() was
   * called on - runPipeline always passes the same `opts.file` to both) and,
   * for each segment whose translation actually differs from its extracted
   * source text, rewrites that node's paragraphs/runs and - only when the
   * fitted size differs from the size fitting started from - its run sizes.
   * A segment whose translation equals its source text (keptOriginal, or a
   * translation that legitimately came back unchanged) is never touched at
   * all: no setRunText call, no markDirty - the zero-diff guarantee the
   * apply contract requires. Because markDirty is only ever called for a
   * part that had at least one real mutation, a slide/notes/diagram part
   * with zero net changes is copied out byte-identical by archive.save().
   */
  async apply(filePath: string, outPath: string, segments: TranslatedSegment[]): Promise<void> {
    const archive = await openPptx(filePath)
    const siteById = new Map(collectSites(archive).map((s) => [s.id, s]))

    for (const seg of segments) {
      const site = siteById.get(seg.id)
      if (!site) {
        throw new Error(
          `pptx adapter: apply() could not locate segment "${seg.id}" while re-walking "${filePath}" - ` +
            'apply() must be called with the same file extract() read.'
        )
      }

      if (seg.translation === seg.text) continue

      writeTranslation(site.bodyEl, seg.translation)
      archive.markDirty(site.partPath)

      // Relies on fit-engine's fit() returning font.sizePt back bit-identically
      // (not merely a numerically-equal-but-recomputed value) whenever the
      // text already fits at the starting size - i.e. that this comparison
      // is a reliable proxy for "no shrink happened", not just a close one.
      if (site.kind !== 'notes' && seg.fittedSizePt !== seg.font.sizePt) {
        writeSize(site.bodyEl, seg.fittedSizePt)
      }
    }

    await archive.save(outPath)
  }
}

// ---- tree walk (shared by extract and apply) ----

interface WalkCtx {
  slideN: number
  slidePath: string
  slideDoc: Document
  layoutDoc: Document | null
  masterDoc: Document | null
  archive: PptxArchive
  usedIds: Set<string>
  sites: Site[]
}

function collectSites(archive: PptxArchive): Site[] {
  const sites: Site[] = []
  const usedIds = new Set<string>()

  for (const slidePath of archive.listSlidePaths()) {
    const slideN = slideNumberOf(slidePath)
    const slideDoc = archive.readXml(slidePath)
    const layoutPath = archive.layoutPathFor(slidePath)
    const layoutDoc = layoutPath ? archive.readXml(layoutPath) : null
    const masterPath = layoutPath ? archive.masterPathFor(layoutPath) : null
    const masterDoc = masterPath ? archive.readXml(masterPath) : null

    const ctx: WalkCtx = {
      slideN,
      slidePath,
      slideDoc,
      layoutDoc,
      masterDoc,
      archive,
      usedIds,
      sites
    }

    const spTree = elems(slideDoc, P_NS, 'spTree')[0]
    if (spTree) walkContainer(spTree, { sx: 1, sy: 1 }, '', ctx)
    handleNotes(ctx)
  }

  return sites
}

function slideNumberOf(slidePath: string): number {
  const m = /slide(\d+)\.xml$/.exec(slidePath)
  return m ? Number(m[1]) : 0
}

function walkContainer(
  container: Element,
  groupScale: { sx: number; sy: number },
  pathPrefix: string,
  ctx: WalkCtx
): void {
  for (const child of directChildElements(container)) {
    if (child.namespaceURI !== P_NS) continue
    switch (child.localName) {
      case 'sp':
        handleSp(child, groupScale, pathPrefix, ctx)
        break
      case 'pic':
        handlePic(child)
        break
      case 'graphicFrame':
        handleGraphicFrame(child, groupScale, pathPrefix, ctx)
        break
      case 'grpSp': {
        const name = shapeName(child)
        const scale = compoundScale(groupScale, groupChildScale(child))
        walkContainer(child, scale, `${pathPrefix}group[name=${escId(name)}]/`, ctx)
        break
      }
      default:
        break // cxnSp / contentPart: never carry translatable text.
    }
  }
}

function handleSp(
  shape: Element,
  groupScale: { sx: number; sy: number },
  pathPrefix: string,
  ctx: WalkCtx
): void {
  const txBody = childElems(shape, P_NS, 'txBody')[0]
  if (!txBody) return

  if (isWordArt(txBody)) {
    logSkip('WordArt', shapeName(shape))
    return
  }

  const text = paragraphsText(txBody)
  if (!text.trim()) return

  const geom = resolveShapeGeom({
    shape,
    slideDoc: ctx.slideDoc,
    layoutDoc: ctx.layoutDoc,
    masterDoc: ctx.masterDoc,
    groupScale
  })
  const font = resolveBodyFont(txBody)
  const name = shapeName(shape)
  const id = uniqueId(`slide${ctx.slideN}/${pathPrefix}shape[name=${escId(name)}]/tb`, ctx.usedIds)

  ctx.sites.push({
    id,
    kind: 'shape',
    context: roleForShape(shape),
    groupKey: `slide${ctx.slideN}`,
    text,
    font: {
      family: font?.family ?? DEFAULT_FALLBACK_FONT_FAMILY,
      sizePt: geom.fontPt ?? DEFAULT_FALLBACK_FONT_PT,
      bold: font?.bold ?? false,
      italic: font?.italic ?? false
    },
    box: geom.box ? { wPt: geom.box.wPt * WRAP_SAFETY, hPt: geom.box.hPt } : SENTINEL_BOX,
    partPath: ctx.slidePath,
    bodyEl: txBody
  })
}

function handlePic(pic: Element): void {
  const nvPicPr = childElems(pic, P_NS, 'nvPicPr')[0]
  const nvPr = nvPicPr && childElems(nvPicPr, P_NS, 'nvPr')[0]
  if (!nvPr) return
  const isVideo =
    elems(nvPr, A_NS, 'videoFile').length > 0 || elems(nvPr, P_NS, 'videoFile').length > 0
  if (isVideo) logSkip('video', shapeName(pic))
  // Pictures never carry a txBody - nothing else to do either way.
}

function handleGraphicFrame(
  gf: Element,
  groupScale: { sx: number; sy: number },
  pathPrefix: string,
  ctx: WalkCtx
): void {
  if (elems(gf, A_NS, 'tbl')[0]) {
    handleTable(gf, groupScale, pathPrefix, ctx)
    return
  }

  const graphic = childElems(gf, A_NS, 'graphic')[0]
  const graphicData = graphic && childElems(graphic, A_NS, 'graphicData')[0]
  const uri = graphicData?.getAttribute('uri') ?? ''
  const name = shapeName(gf)

  if (uri === GRAPHIC_URI.chart) {
    logSkip('chart', name)
    return
  }
  if (uri === GRAPHIC_URI.ole) {
    logSkip('OLE object', name)
    return
  }
  if (uri === GRAPHIC_URI.diagram && graphicData) {
    handleSmartArt(gf, graphicData, groupScale, pathPrefix, ctx)
    return
  }
  if (uri) logSkip(`graphic frame (${uri})`, name)
}

function handleTable(
  gf: Element,
  groupScale: { sx: number; sy: number },
  pathPrefix: string,
  ctx: WalkCtx
): void {
  const tbl = elems(gf, A_NS, 'tbl')[0]
  if (!tbl) return

  const boxes = tableCellBoxes(gf)
  const trs = childElems(tbl, A_NS, 'tr')
  const name = shapeName(gf)

  for (let r = 0; r < trs.length; r++) {
    const tcs = childElems(trs[r], A_NS, 'tc')
    for (let c = 0; c < tcs.length; c++) {
      const tc = tcs[c]
      // Only the merge's anchor cell carries the real txBody text; every
      // other cell covered by a merge carries hMerge and/or vMerge with no
      // text of its own (see tableCellBoxes's doc comment) - skip those so
      // a merged region is emitted exactly once, not once per covered cell.
      // This is intentional per OOXML merge semantics (a continuation cell
      // is a layout placeholder for the anchor's span, not an independent
      // cell) - if one somehow DOES carry stray text anyway (a malformed or
      // hand-edited deck), that text is still dropped, but loudly logged
      // rather than silently, since silently dropping real content is
      // exactly the failure mode this adapter otherwise refuses to allow.
      if (tc.hasAttribute('hMerge') || tc.hasAttribute('vMerge')) {
        const strayTxBody = childElems(tc, A_NS, 'txBody')[0]
        const strayText = strayTxBody && paragraphsText(strayTxBody).trim()
        if (strayText) {
          logSkip(
            'merge-continuation cell with unexpected text (anchor-only extraction is intentional)',
            `${name} r${r + 1}c${c + 1}`
          )
        }
        continue
      }

      const txBody = childElems(tc, A_NS, 'txBody')[0]
      if (!txBody) continue
      const text = paragraphsText(txBody)
      if (!text.trim()) continue

      const font = resolveBodyFont(txBody)
      const cellBox = boxes[r]?.[c] ?? { wPt: 0, hPt: 0 }
      const id = uniqueId(
        `slide${ctx.slideN}/${pathPrefix}table[gf-name=${escId(name)}]/r${r + 1}c${c + 1}`,
        ctx.usedIds
      )

      ctx.sites.push({
        id,
        kind: 'table-cell',
        context: 'table cell',
        groupKey: `slide${ctx.slideN}`,
        text,
        font: {
          family: font?.family ?? DEFAULT_FALLBACK_FONT_FAMILY,
          sizePt: resolveExplicitSizePt(txBody, groupScale) ?? DEFAULT_FALLBACK_FONT_PT,
          bold: font?.bold ?? false,
          italic: font?.italic ?? false
        },
        box: {
          wPt: cellBox.wPt * groupScale.sx * WRAP_SAFETY,
          hPt: cellBox.hPt * groupScale.sy
        },
        partPath: ctx.slidePath,
        bodyEl: txBody
      })
    }
  }
}

function handleSmartArt(
  gf: Element,
  graphicData: Element,
  groupScale: { sx: number; sy: number },
  pathPrefix: string,
  ctx: WalkCtx
): void {
  const name = shapeName(gf)
  const relIds = elems(graphicData, DGM_NS, 'relIds')[0]
  const dmRid = relIds?.getAttributeNS(R_NS, 'dm')
  if (!dmRid) {
    logSkip('SmartArt (no data relationship)', name)
    return
  }

  const dataPath = resolveRelById(ctx.archive, ctx.slidePath, dmRid)
  if (!dataPath) {
    logSkip('SmartArt (data part unresolved)', name)
    return
  }

  let dataDoc: Document
  try {
    dataDoc = ctx.archive.readXml(dataPath)
  } catch {
    logSkip('SmartArt (data part unreadable)', name)
    return
  }

  const geom = resolveShapeGeom({
    shape: gf,
    slideDoc: ctx.slideDoc,
    layoutDoc: ctx.layoutDoc,
    masterDoc: ctx.masterDoc,
    groupScale
  })
  const box = geom.box ? { wPt: geom.box.wPt * WRAP_SAFETY, hPt: geom.box.hPt } : SENTINEL_BOX

  for (const pt of elems(dataDoc, DGM_NS, 'pt')) {
    const t = childElems(pt, DGM_NS, 't')[0]
    if (!t) continue
    const text = paragraphsText(t)
    if (!text.trim()) continue

    const font = resolveBodyFont(t)
    const modelId = pt.getAttribute('modelId') ?? 'unknown'
    const id = uniqueId(
      `slide${ctx.slideN}/${pathPrefix}smartart[gf-name=${escId(name)}]/pt${escId(modelId)}`,
      ctx.usedIds
    )

    ctx.sites.push({
      id,
      kind: 'shape',
      context: 'smartart',
      groupKey: `slide${ctx.slideN}`,
      text,
      font: {
        family: font?.family ?? DEFAULT_FALLBACK_FONT_FAMILY,
        sizePt: resolveExplicitSizePt(t, groupScale) ?? DEFAULT_FALLBACK_FONT_PT,
        bold: font?.bold ?? false,
        italic: font?.italic ?? false
      },
      box,
      partPath: dataPath,
      bodyEl: t
    })
  }
}

function handleNotes(ctx: WalkCtx): void {
  const notesPath = resolveRelTarget(ctx.archive, ctx.slidePath, REL_TYPE_NOTES_SLIDE)
  if (!notesPath) return

  let notesDoc: Document
  try {
    notesDoc = ctx.archive.readXml(notesPath)
  } catch {
    return
  }

  const spTree = elems(notesDoc, P_NS, 'spTree')[0]
  if (!spTree) return

  for (const sp of childElems(spTree, P_NS, 'sp')) {
    const nvSpPr = childElems(sp, P_NS, 'nvSpPr')[0]
    const nvPr = nvSpPr && childElems(nvSpPr, P_NS, 'nvPr')[0]
    const ph = nvPr && childElems(nvPr, P_NS, 'ph')[0]
    // A notes slide's body placeholder is the one text-bearing shape we
    // care about; other placeholders on a notes page (slide image, footer,
    // slide number) aren't translatable body content.
    if (!ph || (ph.getAttribute('type') || 'obj') !== 'body') continue

    const txBody = childElems(sp, P_NS, 'txBody')[0]
    if (!txBody) continue
    const text = paragraphsText(txBody)
    if (!text.trim()) continue

    const font = resolveBodyFont(txBody)
    const id = uniqueId(`slide${ctx.slideN}/notes`, ctx.usedIds)

    ctx.sites.push({
      id,
      kind: 'notes',
      context: 'notes',
      groupKey: `slide${ctx.slideN}-notes`,
      text,
      font: {
        family: font?.family ?? DEFAULT_FALLBACK_FONT_FAMILY,
        sizePt: resolveExplicitSizePt(txBody, { sx: 1, sy: 1 }) ?? DEFAULT_FALLBACK_FONT_PT,
        bold: font?.bold ?? false,
        italic: font?.italic ?? false
      },
      box: SENTINEL_BOX,
      partPath: notesPath,
      bodyEl: txBody
    })
  }
}

// ---- apply-side writers ----

/**
 * Writes `translation` into `bodyEl`'s existing `a:p` paragraphs.
 *
 * Let k = min(translation's line count, `bodyEl`'s paragraph count). Lines
 * 1..k map 1:1 onto the first k paragraphs (see writeLineIntoParagraph).
 * Beyond that:
 *
 *  - MORE lines than paragraphs: every remaining line is appended to the
 *    k-th (last written) paragraph as its own `a:br`-preceded run - a real
 *    visual line break, but never a new `a:p` (a translation gaining an
 *    extra line is not license to invent a whole new paragraph's worth of
 *    formatting/list-level that the source never had).
 *  - FEWER lines than paragraphs: every paragraph beyond the k-th is
 *    DELETED outright.
 *
 * This is a deliberate redesign, not the obvious "keep every a:p, just
 * empty the surplus ones" approach: emptied-but-retained surplus paragraphs
 * are phantom blank lines - PowerPoint still renders each one as real
 * vertical space the fit engine never measured against, AND (since
 * paragraphText treats each a:p as its own `\n`-separated unit) a
 * subsequent extract() would see extra blank lines that were never in the
 * translation, breaking the round trip. Deleting the surplus paragraph does
 * lose that paragraph's own per-paragraph formatting (bullet level,
 * alignment, spacing) - accepted as the lesser cost versus a document that
 * silently renders content the translation never asked for.
 */
function writeTranslation(bodyEl: Element, translation: string): void {
  const lines = translation.split('\n')
  const paragraphs = childElems(bodyEl, A_NS, 'p')
  // Unreachable in practice: a segment only ever reaches apply() if extract()
  // found non-empty text in this same bodyEl, which requires at least one
  // a:p to have existed. Guarded anyway so a malformed/hand-edited deck
  // degrades to a no-op here instead of indexing paragraphs[-1] below.
  if (paragraphs.length === 0) return

  const k = Math.min(lines.length, paragraphs.length)
  for (let i = 0; i < k; i++) writeLineIntoParagraph(paragraphs[i], lines[i])

  if (lines.length > k) {
    const lastParagraph = paragraphs[k - 1]
    for (let i = k; i < lines.length; i++) appendBreakLine(lastParagraph, lines[i])
  }

  for (let i = paragraphs.length - 1; i >= k; i--) bodyEl.removeChild(paragraphs[i])
}

/**
 * Writes `text` into one paragraph: the paragraph's first run gets all of
 * it (keeping its a:rPr - the run is rewritten in place, never recreated);
 * every sibling run in that same paragraph is emptied, not deleted, so its
 * formatting markers survive even though it no longer carries text. A
 * paragraph with zero runs at all (a bare `<a:p/>` spacer line) has nowhere
 * to put non-empty text - a deliberate, documented limitation rather than
 * fabricating a brand-new `a:r` (which would need its own schema-correct
 * placement and namespace-prefix handling for a vanishingly rare case: a
 * translation inventing content for a paragraph that had none).
 */
function writeLineIntoParagraph(p: Element, text: string): void {
  const runs = childElems(p, A_NS, 'r')
  runs.forEach((run, i) => setRunText(run, i === 0 ? text : ''))
}

/**
 * Appends `text` to `paragraph` as a new visual line: an `a:br` followed by
 * a fresh `a:r` run carrying `text`. The new run's namespace prefix matches
 * whatever's already bound in scope (same resolution approach as
 * setRunText/ensureRPr), and it clones the paragraph's own first run's
 * `a:rPr` (if any) so the appended line's formatting matches rather than
 * silently falling back to bare paragraph/list defaults.
 */
function appendBreakLine(paragraph: Element, text: string): void {
  const doc = paragraph.ownerDocument
  if (!doc) return
  const prefix = paragraph.lookupPrefix(A_NS)
  const qualified = (local: string): string =>
    prefix === null ? `a:${local}` : prefix === '' ? local : `${prefix}:${local}`

  paragraph.appendChild(doc.createElementNS(A_NS, qualified('br')))

  const run = doc.createElementNS(A_NS, qualified('r'))
  const sourceRun = childElems(paragraph, A_NS, 'r')[0]
  const sourceRPr = sourceRun && childElems(sourceRun, A_NS, 'rPr')[0]
  if (sourceRPr) run.appendChild(sourceRPr.cloneNode(true))
  paragraph.appendChild(run)

  setRunText(run, text)
}

/**
 * Sets `sz` (hundredths of a point, rounded to the nearest quarter point)
 * on every run in `bodyEl` whose current text is non-empty, and marks
 * `bodyEl`'s `a:bodyPr` with a bare `<a:normAutofit/>` (see
 * ensureNormAutofit's own doc comment for why) as a belt-and-suspenders
 * safety net on top of our explicit size. Must run AFTER writeTranslation
 * so "non-empty run" reflects the post-translation state (runs
 * writeTranslation just emptied are correctly left untouched here).
 */
function writeSize(bodyEl: Element, sizePt: number): void {
  const QUARTER_POINT = 25
  const hundredths = Math.round((sizePt * 100) / QUARTER_POINT) * QUARTER_POINT

  for (const run of elems(bodyEl, A_NS, 'r')) {
    if (textOfRun(run).trim() === '') continue
    ensureRPr(run).setAttribute('sz', String(hundredths))
  }

  ensureNormAutofit(bodyEl)
}

/**
 * Research-adopted belt-and-suspenders (credit: LinguaHaru's approach to
 * the same problem, per the Phase 2 research/knowledge-base adoption).
 * writeSize() above already writes an explicit fitted `sz` computed from
 * our own skia-canvas-based wrap measurement (with the WRAP_SAFETY margin
 * on top - see its doc comment), but that measurement can still diverge
 * slightly from PowerPoint's real text layout engine on some fonts/scripts
 * - and unlike our earlier "explicit size means autofit must not ALSO
 * apply on top of it" stance, a residual mismatch there would silently
 * clip text with no recourse. So instead: ensure `bodyEl`'s `a:bodyPr`
 * carries a bare `<a:normAutofit/>` (no `fontScale`/`lnSpcReduction`
 * attributes - those would be PowerPoint's own record of a PREVIOUS
 * autofit computed for different text/size, so carrying stale values
 * forward here would be actively wrong for what we just wrote). This asks
 * PowerPoint to keep autofitting on top of our size if it still doesn't
 * fit once opened/edited, rather than leaving an uncorrectable overflow.
 *
 * Replaces whichever EG_TextAutofit choice element (`a:noAutofit`,
 * `a:spAutoFit`, or a stale `a:normAutofit`) was already there, and
 * creates `a:bodyPr` itself in the (schema-invalid on any real deck, so
 * normally unreachable) case a body somehow lacks one - `a:bodyPr` is
 * `CT_TextBody`'s first required child, so every body this codebase can
 * actually extract a segment from will already have one.
 */
function ensureNormAutofit(bodyEl: Element): void {
  const doc = bodyEl.ownerDocument
  if (!doc) return

  const qualified = (el: Element, local: string): string => {
    const prefix = el.lookupPrefix(A_NS)
    return prefix === null ? `a:${local}` : prefix === '' ? local : `${prefix}:${local}`
  }

  let bodyPr = childElems(bodyEl, A_NS, 'bodyPr')[0]
  if (!bodyPr) {
    bodyPr = doc.createElementNS(A_NS, qualified(bodyEl, 'bodyPr'))
    bodyEl.insertBefore(bodyPr, bodyEl.firstChild)
  }

  for (const stale of [
    ...childElems(bodyPr, A_NS, 'noAutofit'),
    ...childElems(bodyPr, A_NS, 'normAutofit'),
    ...childElems(bodyPr, A_NS, 'spAutoFit')
  ]) {
    bodyPr.removeChild(stale)
  }

  const normAutofit = doc.createElementNS(A_NS, qualified(bodyPr, 'normAutofit'))
  const insertBefore = firstAutofitSuccessorSibling(bodyPr)
  if (insertBefore) bodyPr.insertBefore(normAutofit, insertBefore)
  else bodyPr.appendChild(normAutofit)
}

/**
 * The first of `a:scene3d`/`a:sp3d`/`a:flatTx`/`a:extLst` among `bodyPr`'s
 * direct children, in document order. CT_TextBodyProperties's schema
 * places the EG_TextAutofit choice (`noAutofit`|`normAutofit`|`spAutoFit`)
 * immediately before these, after an optional `a:prstTxWarp` - which this
 * function deliberately does NOT match against, so it never returns a
 * position before that warp shape (WordArt bodies never actually reach
 * ensureNormAutofit() in practice - isWordArt() skips them entirely in
 * handleSp() - but stay schema-correct regardless of that). Returns null
 * when none of those trailing elements exist, meaning the new
 * `a:normAutofit` can simply be appended as bodyPr's last child - the
 * common case for every body this adapter actually writes to.
 */
function firstAutofitSuccessorSibling(bodyPr: Element): Element | null {
  const TRAILING_LOCAL_NAMES = new Set(['scene3d', 'sp3d', 'flatTx', 'extLst'])
  const children = bodyPr.childNodes
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i)
    if (!child || child.nodeType !== ELEMENT_NODE) continue
    const el = child as Element
    if (el.namespaceURI !== A_NS) continue
    if (el.localName && TRAILING_LOCAL_NAMES.has(el.localName)) return el
  }
  return null
}

/** Finds (or creates, matching the run's own bound DrawingML prefix - mirrors setRunText's approach) a run's `a:rPr`, inserted as its first child per CT_TextRun's schema order. */
function ensureRPr(run: Element): Element {
  const existing = childElems(run, A_NS, 'rPr')[0]
  if (existing) return existing

  const doc = run.ownerDocument
  if (!doc) throw new Error('Cannot create rPr: <a:r> element has no owner document')
  const prefix = run.lookupPrefix(A_NS)
  const qualifiedName = prefix === null ? 'a:rPr' : prefix === '' ? 'rPr' : `${prefix}:rPr`
  const rPr = doc.createElementNS(A_NS, qualifiedName)
  if (run.firstChild) run.insertBefore(rPr, run.firstChild)
  else run.appendChild(rPr)
  return rPr
}

// ---- shape/text helpers ----

function paragraphsText(bodyEl: Element): string {
  return childElems(bodyEl, A_NS, 'p').map(paragraphText).join('\n')
}

/**
 * One paragraph's text, walking its direct children in document order so an
 * `a:br` (an explicit line break WITHIN a paragraph - e.g. one appended by
 * writeTranslation's own overflow path, or authored by hand in a source
 * deck) becomes a `\n`, matching how the paragraph-vs-line accounting in
 * writeTranslation treats it on the way back in. `a:r` and `a:fld` runs
 * contribute their own `a:t` text; nothing else (end-paragraph run
 * properties, etc.) carries text.
 */
function paragraphText(p: Element): string {
  const parts: string[] = []
  const children = p.childNodes
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i)
    if (!child || child.nodeType !== ELEMENT_NODE) continue
    const el = child as Element
    if (el.namespaceURI !== A_NS) continue
    if (el.localName === 'br') {
      parts.push('\n')
    } else if (el.localName === 'r' || el.localName === 'fld') {
      parts.push(childElems(el, A_NS, 't')[0]?.textContent ?? '')
    }
  }
  return parts.join('')
}

function isWordArt(bodyEl: Element): boolean {
  const bodyPr = childElems(bodyEl, A_NS, 'bodyPr')[0]
  const warp = bodyPr && childElems(bodyPr, A_NS, 'prstTxWarp')[0]
  return !!warp && warp.getAttribute('prst') !== 'none'
}

/**
 * First explicit `a:rPr/@sz` found in document order (mirrors
 * geometry.ts's resolveRawFontPt run-scan for the "sp" case, reimplemented
 * here because that function only resolves shapes whose element is itself
 * `p:sp` - table cells, notes, and SmartArt data points are never that, so
 * resolveShapeGeom can't be asked about them directly), scaled by
 * `min(groupScale.sx, groupScale.sy)` exactly as resolveFontPt documents.
 * No placeholder-type default fallback here: `p:ph` only exists on shapes.
 */
function resolveExplicitSizePt(
  bodyEl: Element,
  groupScale: { sx: number; sy: number }
): number | null {
  for (const r of elems(bodyEl, A_NS, 'r')) {
    const rPr = childElems(r, A_NS, 'rPr')[0]
    if (rPr?.hasAttribute('sz')) {
      return (Number(rPr.getAttribute('sz')) / 100) * Math.min(groupScale.sx, groupScale.sy)
    }
  }
  return null
}

/**
 * Family/bold/italic from the FIRST run with non-empty text (per the
 * extract contract's point 4 - deliberately a different run-selection rule
 * than resolveExplicitSizePt's "first rPr with @sz regardless of text",
 * since geometry.ts's own resolveRawFontPt already established that size
 * comes from the first explicit size in document order, empty run or not).
 * Family prefers `a:ea` over `a:latin` when the run's own text looks CJK,
 * and vice versa - falling back to whichever of the two IS present.
 */
function resolveBodyFont(
  bodyEl: Element
): { family: string; bold: boolean; italic: boolean } | null {
  for (const r of elems(bodyEl, A_NS, 'r')) {
    const text = textOfRun(r)
    if (text.trim() === '') continue

    const rPr = childElems(r, A_NS, 'rPr')[0]
    const latin = rPr && childElems(rPr, A_NS, 'latin')[0]?.getAttribute('typeface')
    const ea = rPr && childElems(rPr, A_NS, 'ea')[0]?.getAttribute('typeface')
    const isCjk = CJK_RANGE.test(text)
    const family = (isCjk ? ea || latin : latin || ea) || DEFAULT_FALLBACK_FONT_FAMILY

    return {
      family,
      bold: rPr?.getAttribute('b') === '1',
      italic: rPr?.getAttribute('i') === '1'
    }
  }
  return null
}

const PH_ALIAS: Record<string, string> = { ctrTitle: 'title', subTitle: 'body' }

/** Human-readable role: placeholder type maps to a fixed vocabulary ('slide title', 'body'), any other placeholder type is named literally, and a non-placeholder shape is a generic 'text box'. */
function roleForShape(shape: Element): string {
  const type = placeholderType(shape)
  if (type === null) return 'text box'
  const normalized = PH_ALIAS[type] ?? type
  if (normalized === 'title') return 'slide title'
  if (normalized === 'body') return 'body'
  return `placeholder (${type})`
}

function placeholderType(shape: Element): string | null {
  if (shape.localName !== 'sp') return null
  const nvSpPr = childElems(shape, P_NS, 'nvSpPr')[0]
  const nvPr = nvSpPr && childElems(nvSpPr, P_NS, 'nvPr')[0]
  const ph = nvPr && childElems(nvPr, P_NS, 'ph')[0]
  if (!ph) return null
  return ph.getAttribute('type') || 'obj' // CT_Placeholder default (ECMA-376 19.7.9)
}

const NV_CONTAINER_BY_KIND: Record<string, string> = {
  sp: 'nvSpPr',
  pic: 'nvPicPr',
  grpSp: 'nvGrpSpPr',
  graphicFrame: 'nvGraphicFramePr'
}

function shapeName(shape: Element): string {
  const containerLocal = NV_CONTAINER_BY_KIND[shape.localName ?? '']
  const container = containerLocal ? childElems(shape, P_NS, containerLocal)[0] : undefined
  const cNvPr = container && childElems(container, P_NS, 'cNvPr')[0]
  const name = cNvPr?.getAttribute('name')?.trim()
  if (name) return name
  const id = cNvPr?.getAttribute('id')
  return id ? `Shape ${id}` : 'Shape'
}

function logSkip(kind: string, name: string): void {
  console.warn(`pptx adapter: skipping unsupported ${kind} "${name}" - left untouched on apply`)
}

// ---- small generic/id/relationship utilities ----

function directChildElements(parent: Element): Element[] {
  const out: Element[] = []
  const children = parent.childNodes
  for (let i = 0; i < children.length; i++) {
    const child: Node | null = children.item(i)
    if (child && child.nodeType === ELEMENT_NODE) out.push(child as Element)
  }
  return out
}

function compoundScale(
  a: { sx: number; sy: number },
  b: { sx: number; sy: number }
): { sx: number; sy: number } {
  return { sx: a.sx * b.sx, sy: a.sy * b.sy }
}

/** Keeps the id scheme's `/` and `[]` delimiters unambiguous when a real shape name happens to contain them. */
function escId(name: string): string {
  return name.replace(/[[\]/]/g, '_')
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base}-${n}`)) n++
  const id = `${base}-${n}`
  used.add(id)
  return id
}

/**
 * Reimplements ooxml.ts's private relsPathFor/resolvePartPath (not
 * exported - only layoutPathFor/masterPathFor, which are hardcoded to their
 * own specific relationship types, are) so this adapter can resolve the two
 * relationship kinds those don't cover: a slide's notesSlide, and a
 * SmartArt graphicFrame's diagram-data relationship by explicit r:id rather
 * than by type.
 */
function relsPathFor(partPath: string): string {
  const dir = path.posix.dirname(partPath)
  const base = path.posix.basename(partPath)
  return path.posix.join(dir, '_rels', `${base}.rels`)
}

function resolveRelPartPath(basePartPath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const dir = path.posix.dirname(basePartPath)
  return path.posix.normalize(path.posix.join(dir, target))
}

function resolveRelTarget(archive: PptxArchive, partPath: string, relType: string): string | null {
  let relsDoc: Document
  try {
    relsDoc = archive.readXml(relsPathFor(partPath))
  } catch {
    return null
  }
  for (const rel of elems(relsDoc, RELS_NS, 'Relationship')) {
    if (rel.getAttribute('Type') === relType) {
      const target = rel.getAttribute('Target')
      if (target) return resolveRelPartPath(partPath, target)
    }
  }
  return null
}

function resolveRelById(archive: PptxArchive, partPath: string, rId: string): string | null {
  let relsDoc: Document
  try {
    relsDoc = archive.readXml(relsPathFor(partPath))
  } catch {
    return null
  }
  for (const rel of elems(relsDoc, RELS_NS, 'Relationship')) {
    if (rel.getAttribute('Id') === rId) {
      const target = rel.getAttribute('Target')
      if (target) return resolveRelPartPath(partPath, target)
    }
  }
  return null
}
