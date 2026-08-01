import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { Canvas } from 'skia-canvas'
import {
  A_NS,
  P_NS,
  R_NS,
  RELS_NS,
  childElems,
  elems,
  listPictureMedia,
  openPptx,
  readMediaBytes,
  setRunText,
  textOfRun,
  writeMediaBytes
} from '../../../src/core/adapters/pptx/ooxml'
import { buildPptx } from '../../helpers/build-pptx'

/** A real, skia-canvas-decodable solid-color PNG - media byte tests need genuine encoded images, never raw/fake buffers. */
async function makePngBytes(width: number, height: number, color = '#3366cc'): Promise<Buffer> {
  const canvas = new Canvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  return canvas.toBuffer('png')
}

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

/** sha256 of the decompressed bytes of every part in a .pptx buffer, keyed by part path. */
async function digestParts(buffer: Buffer): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(buffer)
  const entries = Object.values(zip.files).filter((f) => !f.dir)
  const digests = new Map<string, string>()
  for (const entry of entries) {
    const data = await entry.async('nodebuffer')
    digests.set(entry.name, createHash('sha256').update(data).digest('hex'))
  }
  return digests
}

/** Builds a representative deck (textbox, placeholder, table, group, picture, notes). */
async function buildSampleDeck(): Promise<Buffer> {
  return buildPptx({
    slides: [
      {
        shapes: [
          {
            kind: 'textbox',
            text: ['Hello world'],
            box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
          },
          { kind: 'placeholder', phType: 'title', text: ['Title text'] },
          {
            kind: 'table',
            rows: [
              ['a', 'b'],
              ['c', 'd']
            ],
            colWidthsEmu: [500, 500],
            rowHeightsEmu: [300, 300],
            box: { xEmu: 0, yEmu: 600, wEmu: 1000, hEmu: 600 }
          },
          {
            kind: 'group',
            box: { xEmu: 0, yEmu: 1300, wEmu: 400, hEmu: 400 },
            chOff: { xEmu: 0, yEmu: 0 },
            chExt: { wEmu: 200, hEmu: 200 },
            children: [
              { kind: 'textbox', text: ['nested'], box: { xEmu: 0, yEmu: 0, wEmu: 100, hEmu: 100 } }
            ]
          },
          { kind: 'picture', box: { xEmu: 0, yEmu: 1800, wEmu: 200, hEmu: 200 } }
        ],
        notes: 'speaker notes for slide 1'
      },
      {
        shapes: [
          {
            kind: 'textbox',
            text: ['Second slide'],
            box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
          }
        ]
      }
    ],
    layoutPlaceholderBox: { phType: 'title', box: { xEmu: 0, yEmu: 0, wEmu: 2000, hEmu: 1000 } },
    masterPlaceholderBox: { phType: 'title', box: { xEmu: 0, yEmu: 0, wEmu: 2000, hEmu: 1000 } }
  })
}

describe('openPptx / PptxArchive', () => {
  it('contract 1: open -> save with zero edits is byte-identical part-for-part (unzip digest, not zip bytes)', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const srcBuffer = await buildSampleDeck()
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, srcBuffer)

    const archive = await openPptx(srcPath)
    const outPath = path.join(dir, 'out.pptx')
    await archive.save(outPath)

    const srcDigests = await digestParts(srcBuffer)
    const outDigests = await digestParts(await readFile(outPath))

    expect(new Set(outDigests.keys())).toEqual(new Set(srcDigests.keys()))
    for (const [part, digest] of srcDigests) {
      expect(outDigests.get(part)).toBe(digest)
    }
  })

  it('contract 2: setRunText + save only changes the dirtied slide part - everything else stays byte-identical', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const srcBuffer = await buildSampleDeck()
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, srcBuffer)
    const srcDigests = await digestParts(srcBuffer)

    const archive = await openPptx(srcPath)
    const slide1Path = archive.listSlidePaths()[0]
    const doc = archive.readXml(slide1Path)
    const run = elems(doc, A_NS, 'r')[0]
    expect(run).toBeDefined()
    setRunText(run, 'Edited text')
    archive.markDirty(slide1Path)

    const outPath = path.join(dir, 'out.pptx')
    await archive.save(outPath)

    const outBuffer = await readFile(outPath)
    const outDigests = await digestParts(outBuffer)

    expect(new Set(outDigests.keys())).toEqual(new Set(srcDigests.keys()))
    for (const [part, digest] of srcDigests) {
      if (part === slide1Path) {
        expect(outDigests.get(part)).not.toBe(digest)
      } else {
        expect(outDigests.get(part)).toBe(digest)
      }
    }
  })

  it('structural fidelity: dirtying+saving slide1 preserves table cell text, group child count/transform, and picture r:embed resolution', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const srcBuffer = await buildSampleDeck()
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, srcBuffer)

    const archive = await openPptx(srcPath)
    const slide1Path = archive.listSlidePaths()[0]
    const doc = archive.readXml(slide1Path)
    const run = elems(doc, A_NS, 'r')[0]
    setRunText(run, 'dirtied')
    archive.markDirty(slide1Path)

    const outPath = path.join(dir, 'out.pptx')
    await archive.save(outPath)

    const reopened = await openPptx(outPath)
    const reDoc = reopened.readXml(slide1Path)

    // Table cell text intact (one a:t per cell, row-major a/b/c/d).
    const cellTexts = elems(reDoc, A_NS, 'tc').map((tc) =>
      elems(tc, A_NS, 't')
        .map((t) => t.textContent)
        .join('')
    )
    expect(cellTexts).toEqual(['a', 'b', 'c', 'd'])

    // Group child count and chOff/chExt transform unchanged.
    const grpSp = elems(reDoc, P_NS, 'grpSp')[0]
    expect(grpSp).toBeDefined()
    const grpSpPr = childElems(grpSp, P_NS, 'grpSpPr')[0]
    const grpXfrm = childElems(grpSpPr, A_NS, 'xfrm')[0]
    const chOff = childElems(grpXfrm, A_NS, 'chOff')[0]
    const chExt = childElems(grpXfrm, A_NS, 'chExt')[0]
    expect(chOff.getAttribute('x')).toBe('0')
    expect(chOff.getAttribute('y')).toBe('0')
    expect(chExt.getAttribute('cx')).toBe('200')
    expect(chExt.getAttribute('cy')).toBe('200')
    const groupChildren = ['sp', 'pic', 'graphicFrame', 'grpSp'].flatMap((local) =>
      childElems(grpSp, P_NS, local)
    )
    expect(groupChildren).toHaveLength(1) // the one nested textbox from buildSampleDeck

    // Picture r:embed (a cross-namespace attribute) resolves through the
    // slide's own _rels to a Relationship entry whose target part actually
    // exists in the saved archive.
    const blip = elems(reDoc, A_NS, 'blip')[0]
    expect(blip).toBeDefined()
    const rId = blip.getAttributeNS(R_NS, 'embed')
    expect(rId).toBeTruthy()
    const relsDoc = reopened.readXml('ppt/slides/_rels/slide1.xml.rels')
    const imageRel = elems(relsDoc, RELS_NS, 'Relationship').find(
      (rel) => rel.getAttribute('Id') === rId
    )
    expect(imageRel).toBeDefined()
    const target = imageRel!.getAttribute('Target')!
    expect(target).toMatch(/^\.\.\/media\/image\d+\.png$/)
    const mediaPath = path.posix.normalize(
      path.posix.join(path.posix.dirname('ppt/slides/slide1.xml'), target)
    )
    const outZip = await JSZip.loadAsync(await readFile(outPath))
    expect(outZip.file(mediaPath)).not.toBeNull()
  })

  it('setRunText resolves the run\'s actual DrawingML prefix instead of hardcoding "a:" (nonstandard-prefix decks)', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            { kind: 'textbox', text: ['x'], box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 } }
          ]
        }
      ]
    })

    // Rebind DrawingML from the builder's default 'a:' prefix to a
    // nonstandard 'dml:' prefix, and strip the a:t child from the run -
    // simulates a LibreOffice/Keynote/third-party deck combined with the
    // "run has no text child yet" case that setRunText must create for.
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let slideXml = await zip.file(slidePath)!.async('string')
    slideXml = slideXml
      .replace(/xmlns:a=/g, 'xmlns:dml=')
      .replace(/<a:/g, '<dml:')
      .replace(/<\/a:/g, '</dml:')
    expect(slideXml).toContain('<dml:t>x</dml:t>')
    slideXml = slideXml.replace('<dml:t>x</dml:t>', '')
    zip.file(slidePath, slideXml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const srcPath = path.join(dir, 'nonstandard-prefix.pptx')
    await writeFile(srcPath, patchedBuffer)

    const archive = await openPptx(srcPath)
    const doc = archive.readXml(slidePath)
    const run = elems(doc, A_NS, 'r')[0]
    expect(childElems(run, A_NS, 't')).toHaveLength(0)

    setRunText(run, 'resolved prefix works')
    archive.markDirty(slidePath)

    const outPath = path.join(dir, 'out.pptx')
    await archive.save(outPath)

    // Reopen from disk: proves the serialized element used a bound prefix
    // (the document reparses cleanly and the text round-trips), not a
    // hardcoded 'a:' that would be unbound in this document.
    const reopened = await openPptx(outPath)
    const reopenedDoc = reopened.readXml(slidePath)
    const reopenedRun = elems(reopenedDoc, A_NS, 'r')[0]
    expect(textOfRun(reopenedRun)).toBe('resolved prefix works')

    const savedXml = await (
      await JSZip.loadAsync(await readFile(outPath))
    )
      .file(slidePath)!
      .async('string')
    expect(savedXml).toContain('<dml:t>resolved prefix works</dml:t>')
    expect(savedXml).not.toContain('<a:t>')
  })

  it('setRunText sets xml:space="preserve" for edge whitespace and removes it again when no longer needed', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            { kind: 'textbox', text: ['x'], box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 } }
          ]
        }
      ]
    })
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    const slide1Path = archive.listSlidePaths()[0]
    const doc = archive.readXml(slide1Path)
    const run = elems(doc, A_NS, 'r')[0]
    const t = childElems(run, A_NS, 't')[0]

    const padded = '  leading and trailing  '
    setRunText(run, padded)
    expect(t.getAttribute('xml:space')).toBe('preserve')
    archive.markDirty(slide1Path)

    const outPath = path.join(dir, 'out.pptx')
    await archive.save(outPath)

    // Round-trip through disk: XML whitespace normalization would otherwise
    // collapse/strip the leading and trailing spaces on reparse.
    const reopened = await openPptx(outPath)
    const reDoc = reopened.readXml(slide1Path)
    const reRun = elems(reDoc, A_NS, 'r')[0]
    const reT = childElems(reRun, A_NS, 't')[0]
    expect(textOfRun(reRun)).toBe(padded)
    expect(reT.getAttribute('xml:space')).toBe('preserve')

    // Setting text without edge whitespace removes the now-unneeded attribute.
    setRunText(reRun, 'no edges')
    expect(reT.hasAttribute('xml:space')).toBe(false)
  })

  it('contract 3: a:t runs are findable via elems(doc, A_NS, "t"); textOfRun/setRunText round-trip CJK and XML-special characters', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const original = 'Hello & <World> "quoted" \'apos\''
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: [original],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
            }
          ]
        }
      ]
    })
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    const slide1Path = archive.listSlidePaths()[0]
    const doc = archive.readXml(slide1Path)

    // a:t runs are findable via elems with the exported namespace constant.
    const runTexts = elems(doc, A_NS, 't')
    expect(runTexts).toHaveLength(1)

    const run = elems(doc, A_NS, 'r')[0]
    expect(textOfRun(run)).toBe(original)

    const cjkAndSpecials = '你好，世界！<tag> & "quotes" \'apostrophe\' こんにちは 안녕하세요'
    setRunText(run, cjkAndSpecials)
    expect(textOfRun(run)).toBe(cjkAndSpecials)
    archive.markDirty(slide1Path)

    const outPath = path.join(dir, 'out.pptx')
    await archive.save(outPath)

    // Round-trip through a fresh open to prove the serialized XML escaping
    // was correct (a naive/unescaped write would fail to reparse or would
    // reparse into different text).
    const reopened = await openPptx(outPath)
    const reopenedDoc = reopened.readXml(slide1Path)
    const reopenedRun = elems(reopenedDoc, A_NS, 'r')[0]
    expect(textOfRun(reopenedRun)).toBe(cjkAndSpecials)
  })

  it('contract 3b: setRunText creates a missing a:t child', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            { kind: 'textbox', text: ['x'], box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 } }
          ]
        }
      ]
    })
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    const doc = archive.readXml(archive.listSlidePaths()[0])
    const run = elems(doc, A_NS, 'r')[0]
    const existingT = childElems(run, A_NS, 't')[0]
    run.removeChild(existingT)
    expect(childElems(run, A_NS, 't')).toHaveLength(0)

    setRunText(run, 'created')
    expect(textOfRun(run)).toBe('created')
  })

  it('contract 4: listSlidePaths orders slide10 after slide9 (numeric, not lexicographic)', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const slides = Array.from({ length: 10 }, (_, i) => ({
      shapes: [
        {
          kind: 'textbox' as const,
          text: [`slide ${i + 1}`],
          box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
        }
      ]
    }))
    const buffer = await buildPptx({ slides })
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    const paths = archive.listSlidePaths()

    expect(paths).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
      'ppt/slides/slide4.xml',
      'ppt/slides/slide5.xml',
      'ppt/slides/slide6.xml',
      'ppt/slides/slide7.xml',
      'ppt/slides/slide8.xml',
      'ppt/slides/slide9.xml',
      'ppt/slides/slide10.xml'
    ])
    // Sanity: naive lexicographic sort would put slide10 before slide2.
    const lexicographic = [...paths].sort()
    expect(lexicographic).not.toEqual(paths)
  })

  it('lists notes parts numerically too - notesSlide10 after notesSlide9', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const slides = Array.from({ length: 10 }, (_, i) => ({
      shapes: [
        {
          kind: 'textbox' as const,
          text: [`slide ${i + 1}`],
          box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
        }
      ],
      notes: `notes ${i + 1}`
    }))
    const buffer = await buildPptx({ slides })
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    const notesPaths = archive.listNotesPaths()

    expect(notesPaths).toEqual([
      'ppt/notesSlides/notesSlide1.xml',
      'ppt/notesSlides/notesSlide2.xml',
      'ppt/notesSlides/notesSlide3.xml',
      'ppt/notesSlides/notesSlide4.xml',
      'ppt/notesSlides/notesSlide5.xml',
      'ppt/notesSlides/notesSlide6.xml',
      'ppt/notesSlides/notesSlide7.xml',
      'ppt/notesSlides/notesSlide8.xml',
      'ppt/notesSlides/notesSlide9.xml',
      'ppt/notesSlides/notesSlide10.xml'
    ])
    const lexicographic = [...notesPaths].sort()
    expect(lexicographic).not.toEqual(notesPaths)
  })

  it('contract 5: layoutPathFor/masterPathFor resolve through _rels correctly', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const buffer = await buildSampleDeck()
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    const slide1Path = archive.listSlidePaths()[0]

    const layoutPath = archive.layoutPathFor(slide1Path)
    expect(layoutPath).toBe('ppt/slideLayouts/slideLayout1.xml')

    const masterPath = archive.masterPathFor(layoutPath as string)
    expect(masterPath).toBe('ppt/slideMasters/slideMaster1.xml')

    // The resolved paths are real, readable parts.
    expect(() => archive.readXml(layoutPath as string)).not.toThrow()
    expect(() => archive.readXml(masterPath as string)).not.toThrow()
  })

  it('layoutPathFor/masterPathFor return null for a part with no such relationship', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const buffer = await buildSampleDeck()
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    // presentation.xml has no slideLayout relationship of its own.
    expect(archive.layoutPathFor('ppt/presentation.xml')).toBeNull()
  })

  it('layoutPathFor returns null when the part has no _rels file at all', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const buffer = await buildSampleDeck()
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    // A media part never has its own _rels/<name>.rels file - distinct from
    // the "rels file exists but no matching Relationship" case above.
    expect(archive.layoutPathFor('ppt/media/image1.png')).toBeNull()
  })

  it('resolves an absolute rel target ("/ppt/...") without treating it as relative to the referencing part', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const buffer = await buildSampleDeck()

    const zip = await JSZip.loadAsync(buffer)
    const relsPath = 'ppt/slides/_rels/slide1.xml.rels'
    let relsXml = await zip.file(relsPath)!.async('string')
    expect(relsXml).toContain('Target="../slideLayouts/slideLayout1.xml"')
    relsXml = relsXml.replace(
      'Target="../slideLayouts/slideLayout1.xml"',
      'Target="/ppt/slideLayouts/slideLayout1.xml"'
    )
    zip.file(relsPath, relsXml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const srcPath = path.join(dir, 'absolute-target.pptx')
    await writeFile(srcPath, patchedBuffer)

    const archive = await openPptx(srcPath)
    expect(archive.layoutPathFor('ppt/slides/slide1.xml')).toBe('ppt/slideLayouts/slideLayout1.xml')
  })

  it('contract 6: corrupt/non-zip input rejects with a clear error naming the file, never hangs or partially writes', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const corruptPath = path.join(dir, 'corrupt.pptx')
    await writeFile(corruptPath, Buffer.from('this is definitely not a zip file'))

    await expect(openPptx(corruptPath)).rejects.toThrow(/corrupt\.pptx/)
  })

  it('contract 6b: a missing input file rejects with a clear error naming the file', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const missingPath = path.join(dir, 'does-not-exist.pptx')

    await expect(openPptx(missingPath)).rejects.toThrow(/does-not-exist\.pptx/)
  })

  it('readXml throws a clear error for an unknown part', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const buffer = await buildSampleDeck()
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    expect(() => archive.readXml('ppt/slides/slide999.xml')).toThrow(/slide999\.xml/)
  })

  it('markDirty throws for an unknown part and never leaves a partial write on save() failure', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const buffer = await buildSampleDeck()
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    expect(() => archive.markDirty('ppt/slides/slide999.xml')).toThrow(/slide999\.xml/)

    // Marking a real part dirty without ever reading it means save() has
    // nothing to serialize for it - this must fail loudly, not silently
    // drop content, and must not leave a partial file at outPath.
    const slide1Path = archive.listSlidePaths()[0]
    archive.markDirty(slide1Path)
    const outPath = path.join(dir, 'out.pptx')

    await expect(archive.save(outPath)).rejects.toThrow(/never read/)
    expect(existsSync(outPath)).toBe(false)
  })
})

describe('listPictureMedia / readMediaBytes / writeMediaBytes (Phase 3, Task 5)', () => {
  it('returns one MediaRef per usage, resolving each a:blip r:embed to its media part and slide', async () => {
    const dir = await tmpDir('lt-ooxml-media-')
    const pngA = await makePngBytes(40, 20, '#ff0000')
    const pngB = await makePngBytes(60, 30, '#00ff00')
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            { kind: 'picture', box: { xEmu: 0, yEmu: 0, wEmu: 400, hEmu: 400 }, mediaBytes: pngA }
          ]
        },
        {
          shapes: [
            { kind: 'picture', box: { xEmu: 0, yEmu: 0, wEmu: 400, hEmu: 400 }, mediaBytes: pngB }
          ]
        }
      ]
    })
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    const refs = listPictureMedia(archive)

    expect(refs).toHaveLength(2)
    expect(refs[0].slidePath).toBe('ppt/slides/slide1.xml')
    expect(refs[1].slidePath).toBe('ppt/slides/slide2.xml')
    expect(refs[0].mediaPath).not.toBe(refs[1].mediaPath)
    expect(refs.every((r) => r.mediaPath.startsWith('ppt/media/'))).toBe(true)
  })

  it("returns one MediaRef per usage even when the SAME media part is used on multiple slides (non-deduped - dedup is the caller's job)", async () => {
    const dir = await tmpDir('lt-ooxml-media-')
    const png = await makePngBytes(40, 20)
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'picture',
              box: { xEmu: 0, yEmu: 0, wEmu: 400, hEmu: 400 },
              mediaBytes: png,
              sharedMediaKey: 'logo'
            }
          ]
        },
        {
          shapes: [
            {
              kind: 'picture',
              box: { xEmu: 0, yEmu: 0, wEmu: 400, hEmu: 400 },
              sharedMediaKey: 'logo'
            }
          ]
        },
        {
          shapes: [
            {
              kind: 'picture',
              box: { xEmu: 0, yEmu: 0, wEmu: 400, hEmu: 400 },
              sharedMediaKey: 'logo'
            }
          ]
        }
      ]
    })
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    const refs = listPictureMedia(archive)

    expect(refs).toHaveLength(3)
    const mediaPaths = new Set(refs.map((r) => r.mediaPath))
    expect(mediaPaths.size).toBe(1) // all three usages point at the one shared part
    expect(refs.map((r) => r.slidePath)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml'
    ])
  })

  it('readMediaBytes returns the exact original bytes of a media part', async () => {
    const dir = await tmpDir('lt-ooxml-media-')
    const png = await makePngBytes(50, 25, '#123456')
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            { kind: 'picture', box: { xEmu: 0, yEmu: 0, wEmu: 400, hEmu: 400 }, mediaBytes: png }
          ]
        }
      ]
    })
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    const [ref] = listPictureMedia(archive)
    const read = await readMediaBytes(archive, ref.mediaPath)

    expect(read.equals(png)).toBe(true)
  })

  it("writeMediaBytes replaces a part's bytes and marks it dirty; save() writes the new bytes and leaves every other part byte-identical", async () => {
    const dir = await tmpDir('lt-ooxml-media-')
    const original = await makePngBytes(50, 25, '#111111')
    const replacement = await makePngBytes(50, 25, '#eeeeee')
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Hello'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
            },
            {
              kind: 'picture',
              box: { xEmu: 0, yEmu: 600, wEmu: 400, hEmu: 400 },
              mediaBytes: original
            }
          ]
        }
      ]
    })
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)
    const srcDigests = await digestParts(buffer)

    const archive = await openPptx(srcPath)
    const [ref] = listPictureMedia(archive)
    writeMediaBytes(archive, ref.mediaPath, replacement)

    const outPath = path.join(dir, 'out.pptx')
    await archive.save(outPath)

    const outBuffer = await readFile(outPath)
    const outDigests = await digestParts(outBuffer)
    const rewritten = await readFile(outPath).then(async () => {
      const zip = await JSZip.loadAsync(outBuffer)
      return zip.file(ref.mediaPath)!.async('nodebuffer')
    })

    expect(rewritten.equals(replacement)).toBe(true)
    expect(outDigests.get(ref.mediaPath)).not.toBe(srcDigests.get(ref.mediaPath))
    for (const [part, digest] of srcDigests) {
      if (part === ref.mediaPath) continue
      expect(outDigests.get(part)).toBe(digest)
    }
  })

  it('readRawBytes/writeRawBytes throw a clear error for an unknown part', async () => {
    const dir = await tmpDir('lt-ooxml-media-')
    const buffer = await buildSampleDeck()
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, buffer)

    const archive = await openPptx(srcPath)
    expect(() => archive.readRawBytes('ppt/media/nope.png')).toThrow(/nope\.png/)
    expect(() => archive.writeRawBytes('ppt/media/nope.png', Buffer.from(''))).toThrow(/nope\.png/)
  })
})
