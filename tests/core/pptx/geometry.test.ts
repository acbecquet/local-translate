import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import type { Document, Element } from '@xmldom/xmldom'
import { A_NS, P_NS, elems, openPptx } from '../../../src/core/adapters/pptx/ooxml'
import {
  groupChildScale,
  resolveShapeGeom,
  tableCellBoxes
} from '../../../src/core/adapters/pptx/geometry'
import { buildPptx } from '../../helpers/build-pptx'

const EMU_PER_PT = 12700

const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
  tmpDirs.length = 0
})

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** Writes a deck buffer to a temp file and opens it as a PptxArchive. */
async function openDeck(buffer: Buffer) {
  const dir = await tmpDir('lt-geom-')
  const srcPath = path.join(dir, 'src.pptx')
  await writeFile(srcPath, buffer)
  return openPptx(srcPath)
}

/** Docs for slide1's own doc + resolved layout/master, or null if unresolvable. */
function resolveDocs(
  archive: Awaited<ReturnType<typeof openPptx>>,
  slidePath: string
): { slideDoc: Document; layoutDoc: Document | null; masterDoc: Document | null } {
  const slideDoc = archive.readXml(slidePath)
  const layoutPath = archive.layoutPathFor(slidePath)
  const layoutDoc = layoutPath ? archive.readXml(layoutPath) : null
  const masterPath = layoutPath ? archive.masterPathFor(layoutPath) : null
  const masterDoc = masterPath ? archive.readXml(masterPath) : null
  return { slideDoc, layoutDoc, masterDoc }
}

describe('resolveShapeGeom', () => {
  it('contract 1: textbox with explicit a:xfrm - box = ext EMU/12700 minus default bodyPr insets', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['hello'],
              box: { xEmu: 0, yEmu: 0, wEmu: 10 * EMU_PER_PT * 100, hEmu: 5 * EMU_PER_PT * 100 }
            }
          ]
        }
      ]
    })
    const archive = await openDeck(buffer)
    const slidePath = archive.listSlidePaths()[0]
    const { slideDoc, layoutDoc, masterDoc } = resolveDocs(archive, slidePath)
    const shape = elems(slideDoc, P_NS, 'sp')[0]

    const geom = resolveShapeGeom({ shape, slideDoc, layoutDoc, masterDoc })

    // Default insets: lIns/rIns 91440 EMU = 7.2pt each side; tIns/bIns 45720 EMU = 3.6pt each side.
    expect(geom.insetsPt).toEqual({ l: 7.2, r: 7.2, t: 3.6, b: 3.6 })
    expect(geom.box).not.toBeNull()
    expect(geom.box!.wPt).toBeCloseTo(1000 - 7.2 - 7.2, 10)
    expect(geom.box!.hPt).toBeCloseTo(500 - 3.6 - 3.6, 10)
  })

  it('contract 1b: explicit bodyPr insets override the defaults', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['hello'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000 * EMU_PER_PT, hEmu: 500 * EMU_PER_PT },
              insetsEmu: {
                l: 2 * EMU_PER_PT,
                r: 3 * EMU_PER_PT,
                t: 1 * EMU_PER_PT,
                b: 4 * EMU_PER_PT
              }
            }
          ]
        }
      ]
    })
    const archive = await openDeck(buffer)
    const slidePath = archive.listSlidePaths()[0]
    const { slideDoc, layoutDoc, masterDoc } = resolveDocs(archive, slidePath)
    const shape = elems(slideDoc, P_NS, 'sp')[0]

    const geom = resolveShapeGeom({ shape, slideDoc, layoutDoc, masterDoc })

    expect(geom.insetsPt).toEqual({ l: 2, r: 3, t: 1, b: 4 })
    expect(geom.box).toEqual({ wPt: 1000 - 2 - 3, hPt: 500 - 1 - 4 })
  })

  it('contract 5: explicit run sz="1125" resolves to fontPt 11.25 (fractional preserved)', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['hello'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000 * EMU_PER_PT, hEmu: 500 * EMU_PER_PT },
              fontPt: 11.25
            }
          ]
        }
      ]
    })
    const archive = await openDeck(buffer)
    const slidePath = archive.listSlidePaths()[0]
    const doc = archive.readXml(slidePath)
    const rPr = elems(doc, A_NS, 'rPr')[0]
    expect(rPr.getAttribute('sz')).toBe('1125')

    const { slideDoc, layoutDoc, masterDoc } = resolveDocs(archive, slidePath)
    const shape = elems(slideDoc, P_NS, 'sp')[0]
    const geom = resolveShapeGeom({ shape, slideDoc, layoutDoc, masterDoc })

    expect(geom.fontPt).toBe(11.25)
  })

  it("contract 2a: placeholder with no slide-level xfrm inherits box from the layout's matching p:ph, and gets the body default font size", async () => {
    const buffer = await buildPptx({
      slides: [{ shapes: [{ kind: 'placeholder', phType: 'body', text: ['body text'] }] }],
      layoutPlaceholderBox: {
        phType: 'body',
        box: { xEmu: 0, yEmu: 0, wEmu: 2000 * EMU_PER_PT, hEmu: 900 * EMU_PER_PT }
      },
      masterPlaceholderBox: {
        // Different box than the layout's, to prove layout wins over master when both match.
        phType: 'body',
        box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 5000 * EMU_PER_PT }
      }
    })
    const archive = await openDeck(buffer)
    const slidePath = archive.listSlidePaths()[0]
    const { slideDoc, layoutDoc, masterDoc } = resolveDocs(archive, slidePath)
    const shape = elems(slideDoc, P_NS, 'sp')[0]

    const geom = resolveShapeGeom({ shape, slideDoc, layoutDoc, masterDoc })

    expect(geom.box).not.toBeNull()
    expect(geom.box!.wPt).toBeCloseTo(2000 - 7.2 - 7.2, 10)
    expect(geom.box!.hPt).toBeCloseTo(900 - 3.6 - 3.6, 10)
    expect(geom.fontPt).toBe(18)
  })

  it('contract 2b: falls back to the master when the layout has no matching p:ph; title default font is 44', async () => {
    const buffer = await buildPptx({
      slides: [{ shapes: [{ kind: 'placeholder', phType: 'title', text: ['title text'] }] }],
      // Layout only has a "body" placeholder - no match for the slide's "title" placeholder.
      layoutPlaceholderBox: {
        phType: 'body',
        box: { xEmu: 0, yEmu: 0, wEmu: 1000 * EMU_PER_PT, hEmu: 1000 * EMU_PER_PT }
      },
      masterPlaceholderBox: {
        phType: 'title',
        box: { xEmu: 0, yEmu: 0, wEmu: 3000 * EMU_PER_PT, hEmu: 700 * EMU_PER_PT }
      }
    })
    const archive = await openDeck(buffer)
    const slidePath = archive.listSlidePaths()[0]
    const { slideDoc, layoutDoc, masterDoc } = resolveDocs(archive, slidePath)
    const shape = elems(slideDoc, P_NS, 'sp')[0]

    const geom = resolveShapeGeom({ shape, slideDoc, layoutDoc, masterDoc })

    expect(geom.box).not.toBeNull()
    expect(geom.box!.wPt).toBeCloseTo(3000 - 7.2 - 7.2, 10)
    expect(geom.box!.hPt).toBeCloseTo(700 - 3.6 - 3.6, 10)
    expect(geom.fontPt).toBe(44)
  })

  it('contract 3: nested group scaling compounds across two levels', async () => {
    // Outer group: ext 400x400 over chExt 200x200 -> sx=sy=2.
    // Inner group (in outer's child space): ext 100x100 over chExt 50x50 -> sx=sy=2.
    // Compounded scale on the leaf textbox: 4x.
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'group',
              box: { xEmu: 0, yEmu: 0, wEmu: 400 * EMU_PER_PT, hEmu: 400 * EMU_PER_PT },
              chOff: { xEmu: 0, yEmu: 0 },
              chExt: { wEmu: 200 * EMU_PER_PT, hEmu: 200 * EMU_PER_PT },
              children: [
                {
                  kind: 'group',
                  box: { xEmu: 0, yEmu: 0, wEmu: 100 * EMU_PER_PT, hEmu: 100 * EMU_PER_PT },
                  chOff: { xEmu: 0, yEmu: 0 },
                  chExt: { wEmu: 50 * EMU_PER_PT, hEmu: 50 * EMU_PER_PT },
                  children: [
                    {
                      kind: 'textbox',
                      text: ['nested'],
                      box: { xEmu: 0, yEmu: 0, wEmu: 10 * EMU_PER_PT, hEmu: 10 * EMU_PER_PT },
                      insetsEmu: { l: 0, r: 0, t: 0, b: 0 }
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })
    const archive = await openDeck(buffer)
    const slidePath = archive.listSlidePaths()[0]
    const { slideDoc, layoutDoc, masterDoc } = resolveDocs(archive, slidePath)

    const groups = elems(slideDoc, P_NS, 'grpSp')
    expect(groups).toHaveLength(2)
    const [outerGroup, innerGroup] = groups
    const outerScale = groupChildScale(outerGroup)
    const innerScale = groupChildScale(innerGroup)
    expect(outerScale).toEqual({ sx: 2, sy: 2 })
    expect(innerScale).toEqual({ sx: 2, sy: 2 })

    const compounded = { sx: outerScale.sx * innerScale.sx, sy: outerScale.sy * innerScale.sy }
    expect(compounded).toEqual({ sx: 4, sy: 4 })

    const leaf = elems(slideDoc, P_NS, 'sp')[0]
    const geom = resolveShapeGeom({
      shape: leaf,
      slideDoc,
      layoutDoc,
      masterDoc,
      groupScale: compounded
    })

    // Zero insets isolate the pure scaling behavior: 10pt * 4 = 40pt.
    expect(geom.box).toEqual({ wPt: 40, hPt: 40 })

    // Compare against not compounding (using only the outer scale) to prove
    // the inner level's contribution isn't silently dropped/overwritten.
    const outerOnly = resolveShapeGeom({
      shape: leaf,
      slideDoc,
      layoutDoc,
      masterDoc,
      groupScale: outerScale
    })
    expect(outerOnly.box).toEqual({ wPt: 20, hPt: 20 })
    expect(geom.box!.wPt).not.toBe(outerOnly.box!.wPt)
  })

  it('contract 3b: insets scale consistently with box, so box.wPt + insetsPt.l + insetsPt.r reconstructs the scaled source width', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'group',
              box: { xEmu: 0, yEmu: 0, wEmu: 200 * EMU_PER_PT, hEmu: 200 * EMU_PER_PT },
              chOff: { xEmu: 0, yEmu: 0 },
              chExt: { wEmu: 100 * EMU_PER_PT, hEmu: 100 * EMU_PER_PT },
              children: [
                {
                  kind: 'textbox',
                  text: ['x'],
                  box: { xEmu: 0, yEmu: 0, wEmu: 20 * EMU_PER_PT, hEmu: 20 * EMU_PER_PT }
                }
              ]
            }
          ]
        }
      ]
    })
    const archive = await openDeck(buffer)
    const slidePath = archive.listSlidePaths()[0]
    const { slideDoc, layoutDoc, masterDoc } = resolveDocs(archive, slidePath)
    const group = elems(slideDoc, P_NS, 'grpSp')[0]
    const scale = groupChildScale(group)
    expect(scale).toEqual({ sx: 2, sy: 2 })

    const leaf = elems(slideDoc, P_NS, 'sp')[0]
    const geom = resolveShapeGeom({
      shape: leaf,
      slideDoc,
      layoutDoc,
      masterDoc,
      groupScale: scale
    })

    expect(geom.box!.wPt + geom.insetsPt.l + geom.insetsPt.r).toBeCloseTo(20 * 2, 10)
    expect(geom.box!.hPt + geom.insetsPt.t + geom.insetsPt.b).toBeCloseTo(20 * 2, 10)
  })

  it('contract 6: a shape with no own xfrm and no p:ph is unresolvable - box: null, never a guessed box', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['x'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000 * EMU_PER_PT, hEmu: 500 * EMU_PER_PT }
            }
          ]
        }
      ]
    })

    // Strip the a:xfrm from the (non-placeholder) shape's spPr - simulates
    // a corrupt/unusual deck where a plain shape carries no transform at all.
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let slideXml = await zip.file(slidePath)!.async('string')
    expect(slideXml).toContain('<a:xfrm>')
    // Global: the root spTree's own group xfrm appears before the shape's,
    // so a non-global replace would strip the wrong (root's) occurrence.
    slideXml = slideXml.replace(/<a:xfrm>.*?<\/a:xfrm>/g, '')
    zip.file(slidePath, slideXml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const archive = await openDeck(patchedBuffer)
    const { slideDoc, layoutDoc, masterDoc } = resolveDocs(archive, slidePath)
    const shape = elems(slideDoc, P_NS, 'sp')[0]

    const geom = resolveShapeGeom({ shape, slideDoc, layoutDoc, masterDoc })

    expect(geom.box).toBeNull()
    // fontPt/insetsPt are still reported (shape-local facts, independent of box resolution).
    expect(geom.insetsPt).toEqual({ l: 7.2, r: 7.2, t: 3.6, b: 3.6 })
  })

  it('contract 6b: a placeholder matching neither layout nor master p:ph is unresolvable - box: null', async () => {
    const buffer = await buildPptx({
      slides: [{ shapes: [{ kind: 'placeholder', phType: 'title', text: ['orphan'] }] }],
      layoutPlaceholderBox: {
        phType: 'body',
        box: { xEmu: 0, yEmu: 0, wEmu: 1000 * EMU_PER_PT, hEmu: 1000 * EMU_PER_PT }
      }
      // No masterPlaceholderBox at all - neither doc has a "title" placeholder.
    })
    const archive = await openDeck(buffer)
    const slidePath = archive.listSlidePaths()[0]
    const { slideDoc, layoutDoc, masterDoc } = resolveDocs(archive, slidePath)
    const shape = elems(slideDoc, P_NS, 'sp')[0]

    const geom = resolveShapeGeom({ shape, slideDoc, layoutDoc, masterDoc })

    expect(geom.box).toBeNull()
    // Title has a placeholder default font size even when the box itself is unresolvable.
    expect(geom.fontPt).toBe(44)
  })
})

describe('tableCellBoxes', () => {
  it('contract 4: cell widths from a:gridCol, heights from a:tr, gridSpan unions widths, rowSpan/vMerge unions heights', async () => {
    const colWidthsEmu = [1000 * EMU_PER_PT, 2000 * EMU_PER_PT, 3000 * EMU_PER_PT]
    const rowHeightsEmu = [500 * EMU_PER_PT, 600 * EMU_PER_PT, 700 * EMU_PER_PT]

    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'table',
              box: { xEmu: 0, yEmu: 0, wEmu: 6000 * EMU_PER_PT, hEmu: 1800 * EMU_PER_PT },
              colWidthsEmu,
              rowHeightsEmu,
              rows: [
                [{ text: 'A' }, { text: 'B', gridSpan: 2 }, { text: '', hMerge: true }],
                [{ text: 'C', rowSpan: 2 }, { text: 'D' }, { text: 'E' }],
                [{ text: '', vMerge: true }, { text: 'F' }, { text: 'G' }]
              ]
            }
          ]
        }
      ]
    })
    const archive = await openDeck(buffer)
    const slidePath = archive.listSlidePaths()[0]
    const doc = archive.readXml(slidePath)
    const graphicFrame = elems(doc, P_NS, 'graphicFrame')[0]

    const boxes = tableCellBoxes(graphicFrame)

    const pt = (emu: number): number => emu / EMU_PER_PT

    // Row 0: col0 plain; col1+col2 unioned by gridSpan (both report the same union).
    expect(boxes[0][0]).toEqual({ wPt: pt(colWidthsEmu[0]), hPt: pt(rowHeightsEmu[0]) })
    const row0UnionW = pt(colWidthsEmu[1] + colWidthsEmu[2])
    expect(boxes[0][1]).toEqual({ wPt: row0UnionW, hPt: pt(rowHeightsEmu[0]) })
    expect(boxes[0][2]).toEqual({ wPt: row0UnionW, hPt: pt(rowHeightsEmu[0]) })

    // Column 0, rows 1-2: unioned by rowSpan/vMerge (both report the same union).
    const col0UnionH = pt(rowHeightsEmu[1] + rowHeightsEmu[2])
    expect(boxes[1][0]).toEqual({ wPt: pt(colWidthsEmu[0]), hPt: col0UnionH })
    expect(boxes[2][0]).toEqual({ wPt: pt(colWidthsEmu[0]), hPt: col0UnionH })

    // Untouched cells: plain per-cell box from their own column width / row height.
    expect(boxes[1][1]).toEqual({ wPt: pt(colWidthsEmu[1]), hPt: pt(rowHeightsEmu[1]) })
    expect(boxes[1][2]).toEqual({ wPt: pt(colWidthsEmu[2]), hPt: pt(rowHeightsEmu[1]) })
    expect(boxes[2][1]).toEqual({ wPt: pt(colWidthsEmu[1]), hPt: pt(rowHeightsEmu[2]) })
    expect(boxes[2][2]).toEqual({ wPt: pt(colWidthsEmu[2]), hPt: pt(rowHeightsEmu[2]) })
  })

  it('returns [] for a graphicFrame with no a:tbl', async () => {
    // A picture shape's element has no a:tbl anywhere in its subtree.
    const buffer = await buildPptx({
      slides: [{ shapes: [{ kind: 'picture', box: { xEmu: 0, yEmu: 0, wEmu: 100, hEmu: 100 } }] }]
    })
    const archive = await openDeck(buffer)
    const doc = archive.readXml(archive.listSlidePaths()[0])
    const pic = elems(doc, P_NS, 'pic')[0]

    expect(tableCellBoxes(pic as unknown as Element)).toEqual([])
  })
})

describe('groupChildScale', () => {
  it('returns identity scale when the group has no xfrm at all', async () => {
    // The builder always emits an xfrm for groups; patch it away to exercise the guard.
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'group',
              box: { xEmu: 0, yEmu: 0, wEmu: 400, hEmu: 400 },
              chOff: { xEmu: 0, yEmu: 0 },
              chExt: { wEmu: 200, hEmu: 200 },
              children: [
                { kind: 'textbox', text: ['x'], box: { xEmu: 0, yEmu: 0, wEmu: 10, hEmu: 10 } }
              ]
            }
          ]
        }
      ]
    })
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let slideXml = await zip.file(slidePath)!.async('string')
    // Global: the root spTree's own grpSpPr/xfrm textually matches too and
    // sorts first in the document, so a non-global replace would hit that
    // one instead of our actual grpSp's.
    slideXml = slideXml.replace(/<p:grpSpPr><a:xfrm>.*?<\/a:xfrm><\/p:grpSpPr>/g, '<p:grpSpPr/>')
    zip.file(slidePath, slideXml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const archive = await openDeck(patchedBuffer)
    const doc = archive.readXml(slidePath)
    const grpSp = elems(doc, P_NS, 'grpSp')[0]

    expect(groupChildScale(grpSp)).toEqual({ sx: 1, sy: 1 })
  })

  it('returns identity scale when chExt is zero (would otherwise divide by zero)', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'group',
              box: { xEmu: 0, yEmu: 0, wEmu: 400, hEmu: 400 },
              chOff: { xEmu: 0, yEmu: 0 },
              chExt: { wEmu: 0, hEmu: 0 },
              children: [
                { kind: 'textbox', text: ['x'], box: { xEmu: 0, yEmu: 0, wEmu: 10, hEmu: 10 } }
              ]
            }
          ]
        }
      ]
    })
    const archive = await openDeck(buffer)
    const doc = archive.readXml(archive.listSlidePaths()[0])
    const grpSp = elems(doc, P_NS, 'grpSp')[0]

    expect(groupChildScale(grpSp)).toEqual({ sx: 1, sy: 1 })
  })
})
