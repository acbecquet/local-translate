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

const REL_TYPE = {
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  officeDocument:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
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
  fontFamily?: string
  name?: string
  /** Explicit `a:bodyPr` insets (EMU); any side omitted falls back to the OOXML default. */
  insetsEmu?: { l?: number; r?: number; t?: number; b?: number }
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
}

export type ShapeSpec =
  TextboxShapeSpec | PlaceholderShapeSpec | TableShapeSpec | GroupShapeSpec | PictureShapeSpec

export interface SlideSpec {
  shapes: ShapeSpec[]
  notes?: string
}

export interface BuildPptxOptions {
  slides: SlideSpec[]
  layoutPlaceholderBox?: { phType: string; box: EmuBox }
  masterPlaceholderBox?: { phType: string; box: EmuBox }
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

function bodyPrXml(insetsEmu?: { l?: number; r?: number; t?: number; b?: number }): string {
  if (!insetsEmu) return '<a:bodyPr/>'
  const attrs = [
    insetsEmu.l !== undefined ? `lIns="${insetsEmu.l}"` : null,
    insetsEmu.r !== undefined ? `rIns="${insetsEmu.r}"` : null,
    insetsEmu.t !== undefined ? `tIns="${insetsEmu.t}"` : null,
    insetsEmu.b !== undefined ? `bIns="${insetsEmu.b}"` : null
  ].filter((a): a is string => a !== null)
  return attrs.length ? `<a:bodyPr ${attrs.join(' ')}/>` : '<a:bodyPr/>'
}

function relationshipsXml(rels: { id: string; type: string; target: string }[]): string {
  const body = rels
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${escAttr(r.target)}"/>`)
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
  opts?: { fontPt?: number; bold?: boolean; fontFamily?: string }
): string {
  if (lines.length === 0) return '<a:p/>'
  return lines
    .map((line) => {
      const attrParts = ['lang="en-US"']
      if (opts?.fontPt !== undefined) attrParts.push(`sz="${Math.round(opts.fontPt * 100)}"`)
      if (opts?.bold) attrParts.push('b="1"')
      const typeface = opts?.fontFamily ? `<a:latin typeface="${escAttr(opts.fontFamily)}"/>` : ''
      const rPr = `<a:rPr ${attrParts.join(' ')}>${typeface}</a:rPr>`
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
  contentTypeOverrides: { partName: string; contentType: string }[]
}

function buildShapeXml(
  ctx: BuildCtx,
  shape: ShapeSpec,
  ordinal: number,
  nextId: () => number,
  addRel: (type: string, target: string) => string
): string {
  const id = nextId()
  switch (shape.kind) {
    case 'textbox': {
      const name = shape.name ?? `TextBox ${ordinal}`
      return (
        `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escAttr(name)}"/>` +
        '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>' +
        `<p:spPr>${xfrmXml(shape.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
        `<p:txBody>${bodyPrXml(shape.insetsEmu)}<a:lstStyle/>` +
        paragraphsXml(shape.text, {
          fontPt: shape.fontPt,
          bold: shape.bold,
          fontFamily: shape.fontFamily
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
              return (
                `<a:tc${tcAttrs}><a:txBody><a:bodyPr/><a:lstStyle/>` +
                `<a:p><a:r><a:t>${escText(spec.text)}</a:t></a:r></a:p>` +
                '</a:txBody><a:tcPr/></a:tc>'
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
      return (
        `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escAttr(name)}"/>` +
        '<p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
        `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
        `<p:spPr>${xfrmXml(shape.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
        '</p:pic>'
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
  const rels: { id: string; type: string; target: string }[] = []

  const nextId = (): number => {
    shapeId += 1
    return shapeId
  }
  const addRel = (type: string, target: string): string => {
    relCounter += 1
    const id = `rId${relCounter}`
    rels.push({ id, type, target })
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

function buildSlideMaster(masterPlaceholderBox?: { phType: string; box: EmuBox }): string {
  const placeholder = masterPlaceholderBox
    ? placeholderWithBoxXml(2, masterPlaceholderBox.phType, masterPlaceholderBox.box)
    : ''
  return (
    `${xmlDecl()}<p:sldMaster xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">` +
    `<p:cSld><p:spTree>${rootGroupXml()}${placeholder}</p:spTree></p:cSld>` +
    `<p:clrMap ${CLR_MAP_ATTRS}/>` +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>' +
    '</p:sldMaster>'
  )
}

function buildSlideLayout(layoutPlaceholderBox?: { phType: string; box: EmuBox }): string {
  const placeholder = layoutPlaceholderBox
    ? placeholderWithBoxXml(2, layoutPlaceholderBox.phType, layoutPlaceholderBox.box)
    : ''
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
  const ctx: BuildCtx = { zip, mediaCounter: { n: 0 }, contentTypeOverrides: [] }
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
