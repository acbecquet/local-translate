/**
 * Test-only fixture builder: assembles a minimal but structurally valid
 * .pptx (OOXML zip) from plain template-literal XML strings.
 *
 * Deliberately independent of `src/core/adapters/pptx/ooxml.ts` - it uses
 * JSZip purely as a zip container (the same packaging primitive ooxml.ts
 * uses), but builds every XML part by hand, so tests exercising ooxml.ts
 * against decks from this builder are not self-referential.
 */
import JSZip from 'jszip'

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const DGM_NS = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
/** The cached-diagram-drawing namespace (Microsoft extension, not core ECMA-376) - real PowerPoint's `ppt/diagrams/drawingN.xml` cached shape-tree parts use this. */
const DSP_NS = 'http://schemas.microsoft.com/office/drawing/2008/diagram'

const REL_TYPE = {
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  officeDocument:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
  video: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video',
  diagramData: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData',
  diagramLayout:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramLayout',
  diagramQuickStyle:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramQuickStyle',
  diagramColors:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramColors',
  /** Microsoft extension relationship type: links a diagram's own data part (dataN.xml) to its cached drawing part (drawingN.xml), via a relationship in the DATA part's own `_rels/dataN.xml.rels` - not the slide's. */
  diagramDrawing: 'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing'
}

/** A 1x1 transparent PNG, embedded as the image part for 'picture' shapes. */
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

export interface EmuBox {
  xEmu: number
  yEmu: number
  wEmu: number
  hEmu: number
}

export interface TextboxShapeSpec {
  kind: 'textbox'
  /** Paragraphs; each entry becomes its own `a:p`. */
  text: string[]
  box: EmuBox
  fontPt?: number
  bold?: boolean
  /** `a:latin` typeface. */
  fontFamily?: string
  /** `a:ea` (East Asian) typeface - lets a fixture carry both a Latin and an East Asian typeface so tests can exercise the adapter's script-based a:ea-vs-a:latin preference. */
  eaFontFamily?: string
  name?: string
  /** Explicit `a:bodyPr` insets (EMU); any side omitted falls back to the OOXML default. */
  insetsEmu?: { l?: number; r?: number; t?: number; b?: number }
  /** Adds an `a:prstTxWarp` (non-"none") to `a:bodyPr` - exercises the adapter's WordArt-skip path. */
  wordArt?: boolean
  /** 0-based indices into `text` whose paragraph is emitted as an `a:fld` (auto-field, e.g. slide number/date placeholder) instead of a plain `a:r` - exercises the adapter's fld-as-text-carrier handling. */
  fldParagraphs?: number[]
}

export interface PlaceholderShapeSpec {
  kind: 'placeholder'
  phType: string
  phIdx?: number
  /** Paragraphs; box is intentionally omitted - inherited from layout/master. */
  text: string[]
  name?: string
}

export interface TableCellSpec {
  text: string
  /** Set only on a merge's master (top-left) cell. */
  gridSpan?: number
  rowSpan?: number
  /** Set only on a merge's continuation (placeholder) cells. */
  hMerge?: boolean
  vMerge?: boolean
  /** Explicit `a:tcPr` margins (EMU): marL/marR/marT/marB. Any side omitted falls back to the OOXML default. */
  marginsEmu?: { l?: number; r?: number; t?: number; b?: number }
}

export interface TableShapeSpec {
  kind: 'table'
  /** rows[r][c] = cell text, or a TableCellSpec for merged cells. */
  rows: (string | TableCellSpec)[][]
  colWidthsEmu: number[]
  rowHeightsEmu: number[]
  box: EmuBox
  name?: string
}

export interface GroupShapeSpec {
  kind: 'group'
  children: ShapeSpec[]
  box: EmuBox
  chOff: { xEmu: number; yEmu: number }
  chExt: { wEmu: number; hEmu: number }
  name?: string
}

export interface PictureShapeSpec {
  kind: 'picture'
  box: EmuBox
  name?: string
  /** Adds an `a:videoFile` marker under `p:nvPr` (linked, external target) - exercises the adapter's video-skip log path. */
  video?: boolean
}

/** A minimal chart graphicFrame: `a:graphicData` with the DrawingML chart URI, referencing a stub `ppt/charts/chartN.xml` part - never readable as text, exercises the adapter's chart-skip path. */
export interface ChartShapeSpec {
  kind: 'chart'
  box: EmuBox
  name?: string
}

/**
 * A minimal OLE object graphicFrame: `a:graphicData` with the PresentationML
 * ole URI, wrapping a bare `p:oleObj`/`p:embed` (no real embedded binary or
 * relationship - the adapter never reads past the graphicData `uri`, so a
 * structurally-valid-but-empty placeholder is enough). Unlike 'chart' this
 * owns no separate part of its own: the whole graphicFrame lives inline in
 * the slide XML, exactly like real PowerPoint's linked/embedded OLE objects
 * whose only OTHER part is the embedded binary itself (out of scope here -
 * nothing in this codebase ever reads it).
 */
export interface OleShapeSpec {
  kind: 'ole'
  box: EmuBox
  name?: string
}

/** A minimal SmartArt (DrawingML diagram) graphicFrame: a `dgm:relIds`-referenced `ppt/diagrams/dataN.xml` data model with one `dgm:pt`/`dgm:t` per entry in `points`. */
export interface SmartArtShapeSpec {
  kind: 'smartart'
  box: EmuBox
  name?: string
  points: string[]
  /**
   * When true, also emits a cached `ppt/diagrams/drawingN.xml` (dsp
   * namespace) mirroring each of `points` as its own `dsp:sp/dsp:txBody`
   * text run, wired via the data part's `dgm:extLst/a:ext/dsp:dataModelExt`
   * relId - the same mechanism real PowerPoint uses to cache a diagram's
   * rendered shape tree alongside its data model.
   */
  cachedDrawing?: boolean
}

export type ShapeSpec =
  | TextboxShapeSpec
  | PlaceholderShapeSpec
  | TableShapeSpec
  | GroupShapeSpec
  | PictureShapeSpec
  | ChartShapeSpec
  | OleShapeSpec
  | SmartArtShapeSpec

export interface SlideSpec {
  shapes: ShapeSpec[]
  notes?: string
}

export interface PlaceholderBoxSpec {
  phType: string
  box: EmuBox
}

export interface BuildPptxOptions {
  slides: SlideSpec[]
  /** One spec, or several (e.g. both "title" and "body") - each becomes its own placeholder `p:sp` on the layout/master. */
  layoutPlaceholderBox?: PlaceholderBoxSpec | PlaceholderBoxSpec[]
  masterPlaceholderBox?: PlaceholderBoxSpec | PlaceholderBoxSpec[]
}

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escAttr(s: string): string {
  return escText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function xmlDecl(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
}

function xfrmXml(box: EmuBox): string {
  return `<a:xfrm><a:off x="${box.xEmu}" y="${box.yEmu}"/><a:ext cx="${box.wEmu}" cy="${box.hEmu}"/></a:xfrm>`
}

function bodyPrXml(
  insetsEmu?: { l?: number; r?: number; t?: number; b?: number },
  wordArt?: boolean
): string {
  const attrs = insetsEmu
    ? [
        insetsEmu.l !== undefined ? `lIns="${insetsEmu.l}"` : null,
        insetsEmu.r !== undefined ? `rIns="${insetsEmu.r}"` : null,
        insetsEmu.t !== undefined ? `tIns="${insetsEmu.t}"` : null,
        insetsEmu.b !== undefined ? `bIns="${insetsEmu.b}"` : null
      ].filter((a): a is string => a !== null)
    : []
  const attrsStr = attrs.length ? ` ${attrs.join(' ')}` : ''
  const warp = wordArt ? '<a:prstTxWarp prst="textArchUp"><a:avLst/></a:prstTxWarp>' : ''
  return warp ? `<a:bodyPr${attrsStr}>${warp}</a:bodyPr>` : `<a:bodyPr${attrsStr}/>`
}

function relationshipsXml(
  rels: { id: string; type: string; target: string; external?: boolean }[]
): string {
  const body = rels
    .map((r) => {
      const mode = r.external ? ' TargetMode="External"' : ''
      return `<Relationship Id="${r.id}" Type="${r.type}" Target="${escAttr(r.target)}"${mode}/>`
    })
    .join('')
  return `${xmlDecl()}<Relationships xmlns="${RELS_NS}">${body}</Relationships>`
}

function rootGroupXml(): string {
  return (
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  )
}

function paragraphsXml(
  lines: string[],
  opts?: {
    fontPt?: number
    bold?: boolean
    fontFamily?: string
    eaFontFamily?: string
    /** 0-based indices into `lines` whose paragraph is wrapped in `a:fld` instead of `a:r` - see TextboxShapeSpec.fldParagraphs. */
    fldIndices?: Set<number>
  }
): string {
  if (lines.length === 0) return '<a:p/>'
  return lines
    .map((line, i) => {
      const attrParts = ['lang="en-US"']
      if (opts?.fontPt !== undefined) attrParts.push(`sz="${Math.round(opts.fontPt * 100)}"`)
      if (opts?.bold) attrParts.push('b="1"')
      const latin = opts?.fontFamily ? `<a:latin typeface="${escAttr(opts.fontFamily)}"/>` : ''
      const ea = opts?.eaFontFamily ? `<a:ea typeface="${escAttr(opts.eaFontFamily)}"/>` : ''
      const rPr = `<a:rPr ${attrParts.join(' ')}>${latin}${ea}</a:rPr>`
      if (opts?.fldIndices?.has(i)) {
        // A real auto-field carries a GUID id + a recognized type
        // ("slidenum", "datetime1", ...) - neither is validated by this
        // codebase, so a fixed placeholder value is fine for every fld.
        return (
          `<a:p><a:fld id="{6E4B2C10-0000-0000-0000-00000000000${i}}" type="slidenum">` +
          `${rPr}<a:t>${escText(line)}</a:t></a:fld></a:p>`
        )
      }
      return `<a:p><a:r>${rPr}<a:t>${escText(line)}</a:t></a:r></a:p>`
    })
    .join('')
}

/** Builds a single placeholder `p:sp` with an explicit box (used on layout/master). */
function placeholderWithBoxXml(id: number, phType: string, box: EmuBox): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escAttr(phType)} Placeholder"/>` +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    `<p:nvPr><p:ph type="${escAttr(phType)}"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr>${xfrmXml(box)}</p:spPr>` +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>'
  )
}

interface BuildCtx {
  zip: JSZip
  mediaCounter: { n: number }
  chartCounter: { n: number }
  diagramCounter: { n: number }
  contentTypeOverrides: { partName: string; contentType: string }[]
}

function buildShapeXml(
  ctx: BuildCtx,
  shape: ShapeSpec,
  ordinal: number,
  nextId: () => number,
  addRel: (type: string, target: string, external?: boolean) => string
): string {
  const id = nextId()
  switch (shape.kind) {
    case 'textbox': {
      const name = shape.name ?? `TextBox ${ordinal}`
      return (
        `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escAttr(name)}"/>` +
        '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>' +
        `<p:spPr>${xfrmXml(shape.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
        `<p:txBody>${bodyPrXml(shape.insetsEmu, shape.wordArt)}<a:lstStyle/>` +
        paragraphsXml(shape.text, {
          fontPt: shape.fontPt,
          bold: shape.bold,
          fontFamily: shape.fontFamily,
          eaFontFamily: shape.eaFontFamily,
          fldIndices: shape.fldParagraphs ? new Set(shape.fldParagraphs) : undefined
        }) +
        '</p:txBody></p:sp>'
      )
    }
    case 'placeholder': {
      const name = shape.name ?? `Placeholder ${ordinal}`
      const idxAttr = shape.phIdx !== undefined ? ` idx="${shape.phIdx}"` : ''
      return (
        `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escAttr(name)}"/>` +
        '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
        `<p:nvPr><p:ph type="${escAttr(shape.phType)}"${idxAttr}/></p:nvPr></p:nvSpPr>` +
        '<p:spPr/>' +
        `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphsXml(shape.text)}</p:txBody></p:sp>`
      )
    }
    case 'table': {
      const name = shape.name ?? `Table ${ordinal}`
      const gridCols = shape.colWidthsEmu.map((w) => `<a:gridCol w="${w}"/>`).join('')
      const rowsXml = shape.rows
        .map((row, ri) => {
          const cells = row
            .map((cell) => {
              const spec: TableCellSpec = typeof cell === 'string' ? { text: cell } : cell
              const attrs = [
                spec.gridSpan !== undefined ? `gridSpan="${spec.gridSpan}"` : null,
                spec.rowSpan !== undefined ? `rowSpan="${spec.rowSpan}"` : null,
                spec.hMerge ? 'hMerge="1"' : null,
                spec.vMerge ? 'vMerge="1"' : null
              ]
                .filter((a): a is string => a !== null)
                .join(' ')
              const tcAttrs = attrs ? ` ${attrs}` : ''
              const marginAttrs = spec.marginsEmu
                ? [
                    spec.marginsEmu.l !== undefined ? `marL="${spec.marginsEmu.l}"` : null,
                    spec.marginsEmu.r !== undefined ? `marR="${spec.marginsEmu.r}"` : null,
                    spec.marginsEmu.t !== undefined ? `marT="${spec.marginsEmu.t}"` : null,
                    spec.marginsEmu.b !== undefined ? `marB="${spec.marginsEmu.b}"` : null
                  ]
                    .filter((a): a is string => a !== null)
                    .join(' ')
                : ''
              const tcPrXml = marginAttrs ? `<a:tcPr ${marginAttrs}/>` : '<a:tcPr/>'
              return (
                `<a:tc${tcAttrs}><a:txBody><a:bodyPr/><a:lstStyle/>` +
                `<a:p><a:r><a:t>${escText(spec.text)}</a:t></a:r></a:p>` +
                `</a:txBody>${tcPrXml}</a:tc>`
              )
            })
            .join('')
          return `<a:tr h="${shape.rowHeightsEmu[ri]}">${cells}</a:tr>`
        })
        .join('')
      return (
        `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${escAttr(name)}"/>` +
        '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
        `<p:xfrm><a:off x="${shape.box.xEmu}" y="${shape.box.yEmu}"/>` +
        `<a:ext cx="${shape.box.wEmu}" cy="${shape.box.hEmu}"/></p:xfrm>` +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
        `<a:tbl><a:tblPr/><a:tblGrid>${gridCols}</a:tblGrid>${rowsXml}</a:tbl>` +
        '</a:graphicData></a:graphic></p:graphicFrame>'
      )
    }
    case 'group': {
      const name = shape.name ?? `Group ${ordinal}`
      const childrenXml = shape.children
        .map((child, i) => buildShapeXml(ctx, child, i + 1, nextId, addRel))
        .join('')
      return (
        `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${escAttr(name)}"/>` +
        '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
        '<p:grpSpPr><a:xfrm>' +
        `<a:off x="${shape.box.xEmu}" y="${shape.box.yEmu}"/>` +
        `<a:ext cx="${shape.box.wEmu}" cy="${shape.box.hEmu}"/>` +
        `<a:chOff x="${shape.chOff.xEmu}" y="${shape.chOff.yEmu}"/>` +
        `<a:chExt cx="${shape.chExt.wEmu}" cy="${shape.chExt.hEmu}"/>` +
        `</a:xfrm></p:grpSpPr>${childrenXml}</p:grpSp>`
      )
    }
    case 'picture': {
      const name = shape.name ?? `Picture ${ordinal}`
      ctx.mediaCounter.n += 1
      const mediaName = `image${ctx.mediaCounter.n}.png`
      ctx.zip.file(`ppt/media/${mediaName}`, ONE_PX_PNG)
      const rId = addRel(REL_TYPE.image, `../media/${mediaName}`)
      const nvPr = shape.video
        ? (() => {
            const videoRId = addRel(REL_TYPE.video, 'https://example.invalid/video.mp4', true)
            return `<p:nvPr><a:videoFile r:link="${videoRId}"/></p:nvPr>`
          })()
        : '<p:nvPr/>'
      return (
        `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escAttr(name)}"/>` +
        `<p:cNvPicPr/>${nvPr}</p:nvPicPr>` +
        `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
        `<p:spPr>${xfrmXml(shape.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
        '</p:pic>'
      )
    }
    case 'chart': {
      const name = shape.name ?? `Chart ${ordinal}`
      ctx.chartCounter.n += 1
      const chartName = `chart${ctx.chartCounter.n}.xml`
      // Never read as text by the adapter (chart graphicFrames are always
      // skipped), so a minimal but well-formed stub is enough to keep the
      // deck structurally valid (every part parses, content-types complete).
      const chartXml = `${xmlDecl()}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="${A_NS}" xmlns:r="${R_NS}"><c:chart><c:plotArea/></c:chart></c:chartSpace>`
      ctx.zip.file(`ppt/charts/${chartName}`, chartXml)
      ctx.zip.file(`ppt/charts/_rels/${chartName}.rels`, relationshipsXml([]))
      ctx.contentTypeOverrides.push({
        partName: `/ppt/charts/${chartName}`,
        contentType: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
      })
      const rId = addRel(REL_TYPE.chart, `../charts/${chartName}`)
      return (
        `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${escAttr(name)}"/>` +
        '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
        `<p:xfrm><a:off x="${shape.box.xEmu}" y="${shape.box.yEmu}"/>` +
        `<a:ext cx="${shape.box.wEmu}" cy="${shape.box.hEmu}"/></p:xfrm>` +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
        `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${R_NS}" r:id="${rId}"/>` +
        '</a:graphicData></a:graphic></p:graphicFrame>'
      )
    }
    case 'ole': {
      const name = shape.name ?? `OLE Object ${ordinal}`
      return (
        `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${escAttr(name)}"/>` +
        '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
        `<p:xfrm><a:off x="${shape.box.xEmu}" y="${shape.box.yEmu}"/>` +
        `<a:ext cx="${shape.box.wEmu}" cy="${shape.box.hEmu}"/></p:xfrm>` +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">' +
        `<p:oleObj name="Embedded Object" showAsIcon="0" imgW="${shape.box.wEmu}" imgH="${shape.box.hEmu}">` +
        '<p:embed/></p:oleObj>' +
        '</a:graphicData></a:graphic></p:graphicFrame>'
      )
    }
    case 'smartart': {
      const name = shape.name ?? `SmartArt ${ordinal}`
      ctx.diagramCounter.n += 1
      const n = ctx.diagramCounter.n

      const ptsXml = shape.points
        .map(
          (text, i) =>
            `<dgm:pt modelId="${i + 1}"><dgm:prSet/><dgm:spPr/>` +
            `<dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escText(text)}</a:t></a:r></a:p></dgm:t>` +
            '</dgm:pt>'
        )
        .join('')

      // A cached drawing part (when requested) needs a relationship FROM the
      // data part TO the drawing part, referenced by the data part's own
      // dgm:extLst/a:ext/dsp:dataModelExt/@relId - resolved via the data
      // part's OWN _rels file, not the slide's (mirroring real PowerPoint).
      const drawingRelId = 'rIdDrawing'
      const extLstXml = shape.cachedDrawing
        ? `<dgm:extLst><a:ext uri="${DSP_NS}">` +
          `<dsp:dataModelExt xmlns:dsp="${DSP_NS}" relId="${drawingRelId}" ` +
          `minVer="${DGM_NS}"/></a:ext></dgm:extLst>`
        : ''
      const dataXml =
        `${xmlDecl()}<dgm:dataModel xmlns:dgm="${DGM_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
        `<dgm:ptLst><dgm:pt modelId="0" type="doc"><dgm:prSet/><dgm:spPr/></dgm:pt>${ptsXml}</dgm:ptLst>` +
        `<dgm:cxnLst/><dgm:bg/><dgm:whole/>${extLstXml}</dgm:dataModel>`
      const layoutXml = `${xmlDecl()}<dgm:layoutDef xmlns:dgm="${DGM_NS}" xmlns:a="${A_NS}" uniqueId="urn:test:layout"/>`
      const styleXml = `${xmlDecl()}<dgm:styleDef xmlns:dgm="${DGM_NS}" xmlns:a="${A_NS}" uniqueId="urn:test:style"/>`
      const colorsXml = `${xmlDecl()}<dgm:colorsDef xmlns:dgm="${DGM_NS}" xmlns:a="${A_NS}" uniqueId="urn:test:colors"/>`

      ctx.zip.file(`ppt/diagrams/data${n}.xml`, dataXml)
      ctx.zip.file(`ppt/diagrams/layout${n}.xml`, layoutXml)
      ctx.zip.file(`ppt/diagrams/quickStyle${n}.xml`, styleXml)
      ctx.zip.file(`ppt/diagrams/colors${n}.xml`, colorsXml)
      ctx.contentTypeOverrides.push(
        {
          partName: `/ppt/diagrams/data${n}.xml`,
          contentType: 'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml'
        },
        {
          partName: `/ppt/diagrams/layout${n}.xml`,
          contentType: 'application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml'
        },
        {
          partName: `/ppt/diagrams/quickStyle${n}.xml`,
          contentType: 'application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml'
        },
        {
          partName: `/ppt/diagrams/colors${n}.xml`,
          contentType: 'application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml'
        }
      )

      if (shape.cachedDrawing) {
        // Mirrors each data point's text as its own dsp:sp/dsp:txBody run -
        // the same a: (DrawingML) text-body shape real cached drawing parts
        // use, just wrapped in dsp:sp instead of p:sp.
        const shapesXml = shape.points
          .map(
            (text, i) =>
              `<dsp:sp modelId="${i + 1}"><dsp:nvSpPr><dsp:cNvPr id="${i + 2}" name=""/>` +
              '<dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr/>' +
              '<dsp:txBody><a:bodyPr/><a:lstStyle/>' +
              `<a:p><a:r><a:t>${escText(text)}</a:t></a:r></a:p></dsp:txBody></dsp:sp>`
          )
          .join('')
        const drawingXml =
          `${xmlDecl()}<dsp:drawing xmlns:dsp="${DSP_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
          `<dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr>` +
          `<dsp:grpSpPr/>${shapesXml}</dsp:spTree></dsp:drawing>`
        ctx.zip.file(`ppt/diagrams/drawing${n}.xml`, drawingXml)
        ctx.zip.file(
          `ppt/diagrams/_rels/data${n}.xml.rels`,
          relationshipsXml([
            { id: drawingRelId, type: REL_TYPE.diagramDrawing, target: `drawing${n}.xml` }
          ])
        )
        ctx.contentTypeOverrides.push({
          partName: `/ppt/diagrams/drawing${n}.xml`,
          contentType: 'application/vnd.ms-office.drawingml.diagramDrawing+xml'
        })
      }

      const dmRid = addRel(REL_TYPE.diagramData, `../diagrams/data${n}.xml`)
      const loRid = addRel(REL_TYPE.diagramLayout, `../diagrams/layout${n}.xml`)
      const qsRid = addRel(REL_TYPE.diagramQuickStyle, `../diagrams/quickStyle${n}.xml`)
      const csRid = addRel(REL_TYPE.diagramColors, `../diagrams/colors${n}.xml`)

      return (
        `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${escAttr(name)}"/>` +
        '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
        `<p:xfrm><a:off x="${shape.box.xEmu}" y="${shape.box.yEmu}"/>` +
        `<a:ext cx="${shape.box.wEmu}" cy="${shape.box.hEmu}"/></p:xfrm>` +
        `<a:graphic><a:graphicData uri="${DGM_NS}">` +
        `<dgm:relIds xmlns:dgm="${DGM_NS}" xmlns:r="${R_NS}" r:dm="${dmRid}" r:lo="${loRid}" r:qs="${qsRid}" r:cs="${csRid}"/>` +
        '</a:graphicData></a:graphic></p:graphicFrame>'
      )
    }
  }
}

function buildSlide(
  ctx: BuildCtx,
  slide: SlideSpec,
  slideIndex: number
): { slideXml: string; relsXml: string } {
  let shapeId = 1
  let relCounter = 0
  const rels: { id: string; type: string; target: string; external?: boolean }[] = []

  const nextId = (): number => {
    shapeId += 1
    return shapeId
  }
  const addRel = (type: string, target: string, external?: boolean): string => {
    relCounter += 1
    const id = `rId${relCounter}`
    rels.push({ id, type, target, external })
    return id
  }

  // rId1 is always the slide's layout relationship.
  addRel(REL_TYPE.slideLayout, '../slideLayouts/slideLayout1.xml')

  const shapesXml = slide.shapes
    .map((shape, i) => buildShapeXml(ctx, shape, i + 1, nextId, addRel))
    .join('')

  if (slide.notes !== undefined) {
    addRel(REL_TYPE.notesSlide, `../notesSlides/notesSlide${slideIndex}.xml`)
  }

  const slideXml =
    `${xmlDecl()}<p:sld xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">` +
    `<p:cSld><p:spTree>${rootGroupXml()}${shapesXml}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'

  return { slideXml, relsXml: relationshipsXml(rels) }
}

function buildNotesSlide(notes: string, slideIndex: number): { xml: string; relsXml: string } {
  const xml =
    `${xmlDecl()}<p:notes xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">` +
    `<p:cSld><p:spTree>${rootGroupXml()}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/>' +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr/>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphsXml(notes.split('\n'))}</p:txBody></p:sp>` +
    '</p:spTree></p:cSld></p:notes>'

  const relsXml = relationshipsXml([
    { id: 'rId1', type: REL_TYPE.notesMaster, target: '../notesMasters/notesMaster1.xml' },
    { id: 'rId2', type: REL_TYPE.slide, target: `../slides/slide${slideIndex}.xml` }
  ])

  return { xml, relsXml }
}

const CLR_MAP_ATTRS =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
  'hlink="hlink" folHlink="folHlink"'

function asArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined) return []
  return Array.isArray(x) ? x : [x]
}

function buildSlideMaster(
  masterPlaceholderBox?: PlaceholderBoxSpec | PlaceholderBoxSpec[]
): string {
  const placeholder = asArray(masterPlaceholderBox)
    .map((spec, i) => placeholderWithBoxXml(2 + i, spec.phType, spec.box))
    .join('')
  return (
    `${xmlDecl()}<p:sldMaster xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">` +
    `<p:cSld><p:spTree>${rootGroupXml()}${placeholder}</p:spTree></p:cSld>` +
    `<p:clrMap ${CLR_MAP_ATTRS}/>` +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>' +
    '</p:sldMaster>'
  )
}

function buildSlideLayout(
  layoutPlaceholderBox?: PlaceholderBoxSpec | PlaceholderBoxSpec[]
): string {
  const placeholder = asArray(layoutPlaceholderBox)
    .map((spec, i) => placeholderWithBoxXml(2 + i, spec.phType, spec.box))
    .join('')
  return (
    `${xmlDecl()}<p:sldLayout xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}" type="obj" preserve="1">` +
    `<p:cSld name="Layout1"><p:spTree>${rootGroupXml()}${placeholder}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
  )
}

function buildNotesMaster(): string {
  return (
    `${xmlDecl()}<p:notesMaster xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">` +
    `<p:cSld><p:spTree>${rootGroupXml()}</p:spTree></p:cSld>` +
    `<p:clrMap ${CLR_MAP_ATTRS}/>` +
    '</p:notesMaster>'
  )
}

function buildPresentation(slideCount: number): string {
  const sldIds = Array.from(
    { length: slideCount },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`
  ).join('')
  return (
    `${xmlDecl()}<p:presentation xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
    '<p:sldSz cx="12192000" cy="6858000"/>' +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>'
  )
}

function buildPresentationRels(slideCount: number, hasNotes: boolean): string {
  const rels = [{ id: 'rId1', type: REL_TYPE.slideMaster, target: 'slideMasters/slideMaster1.xml' }]
  for (let i = 0; i < slideCount; i++) {
    rels.push({ id: `rId${i + 2}`, type: REL_TYPE.slide, target: `slides/slide${i + 1}.xml` })
  }
  if (hasNotes) {
    rels.push({
      id: `rId${slideCount + 2}`,
      type: REL_TYPE.notesMaster,
      target: 'notesMasters/notesMaster1.xml'
    })
  }
  return relationshipsXml(rels)
}

function buildContentTypes(overrides: { partName: string; contentType: string }[]): string {
  const defaults =
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>'
  const overrideXml = overrides
    .map((o) => `<Override PartName="${o.partName}" ContentType="${o.contentType}"/>`)
    .join('')
  return `${xmlDecl()}<Types xmlns="${CT_NS}">${defaults}${overrideXml}</Types>`
}

const CONTENT_TYPE = {
  presentation:
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  slideLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  notesSlide: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  notesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml'
}

/**
 * Builds a minimal, structurally valid .pptx buffer for testing the OOXML
 * layer: [Content_Types].xml, package rels, presentation.xml, one
 * slideMaster + one slideLayout, and one part per slide (plus notes parts
 * when any slide sets `notes`).
 */
export async function buildPptx(opts: BuildPptxOptions): Promise<Buffer> {
  const zip = new JSZip()
  const ctx: BuildCtx = {
    zip,
    mediaCounter: { n: 0 },
    chartCounter: { n: 0 },
    diagramCounter: { n: 0 },
    contentTypeOverrides: []
  }
  const hasNotes = opts.slides.some((s) => s.notes !== undefined)

  ctx.contentTypeOverrides.push({
    partName: '/ppt/presentation.xml',
    contentType: CONTENT_TYPE.presentation
  })
  ctx.contentTypeOverrides.push({
    partName: '/ppt/slideMasters/slideMaster1.xml',
    contentType: CONTENT_TYPE.slideMaster
  })
  ctx.contentTypeOverrides.push({
    partName: '/ppt/slideLayouts/slideLayout1.xml',
    contentType: CONTENT_TYPE.slideLayout
  })

  zip.file(
    '_rels/.rels',
    relationshipsXml([
      { id: 'rId1', type: REL_TYPE.officeDocument, target: 'ppt/presentation.xml' }
    ])
  )
  zip.file('ppt/presentation.xml', buildPresentation(opts.slides.length))
  zip.file('ppt/_rels/presentation.xml.rels', buildPresentationRels(opts.slides.length, hasNotes))
  zip.file('ppt/slideMasters/slideMaster1.xml', buildSlideMaster(opts.masterPlaceholderBox))
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    relationshipsXml([
      { id: 'rId1', type: REL_TYPE.slideLayout, target: '../slideLayouts/slideLayout1.xml' }
    ])
  )
  zip.file('ppt/slideLayouts/slideLayout1.xml', buildSlideLayout(opts.layoutPlaceholderBox))
  zip.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    relationshipsXml([
      { id: 'rId1', type: REL_TYPE.slideMaster, target: '../slideMasters/slideMaster1.xml' }
    ])
  )

  if (hasNotes) {
    zip.file('ppt/notesMasters/notesMaster1.xml', buildNotesMaster())
    zip.file('ppt/notesMasters/_rels/notesMaster1.xml.rels', relationshipsXml([]))
    ctx.contentTypeOverrides.push({
      partName: '/ppt/notesMasters/notesMaster1.xml',
      contentType: CONTENT_TYPE.notesMaster
    })
  }

  opts.slides.forEach((slide, i) => {
    const slideIndex = i + 1
    const { slideXml, relsXml } = buildSlide(ctx, slide, slideIndex)
    zip.file(`ppt/slides/slide${slideIndex}.xml`, slideXml)
    zip.file(`ppt/slides/_rels/slide${slideIndex}.xml.rels`, relsXml)
    ctx.contentTypeOverrides.push({
      partName: `/ppt/slides/slide${slideIndex}.xml`,
      contentType: CONTENT_TYPE.slide
    })

    if (slide.notes !== undefined) {
      const notes = buildNotesSlide(slide.notes, slideIndex)
      zip.file(`ppt/notesSlides/notesSlide${slideIndex}.xml`, notes.xml)
      zip.file(`ppt/notesSlides/_rels/notesSlide${slideIndex}.xml.rels`, notes.relsXml)
      ctx.contentTypeOverrides.push({
        partName: `/ppt/notesSlides/notesSlide${slideIndex}.xml`,
        contentType: CONTENT_TYPE.notesSlide
      })
    }
  })

  zip.file('[Content_Types].xml', buildContentTypes(ctx.contentTypeOverrides))

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
