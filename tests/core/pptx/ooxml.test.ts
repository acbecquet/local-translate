import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import {
  A_NS,
  childElems,
  elems,
  openPptx,
  setRunText,
  textOfRun
} from '../../../src/core/adapters/pptx/ooxml'
import { buildPptx } from '../../helpers/build-pptx'

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

  it('lists notes parts numerically too', async () => {
    const dir = await tmpDir('lt-ooxml-')
    const slides = Array.from({ length: 3 }, (_, i) => ({
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
    expect(archive.listNotesPaths()).toEqual([
      'ppt/notesSlides/notesSlide1.xml',
      'ppt/notesSlides/notesSlide2.xml',
      'ppt/notesSlides/notesSlide3.xml'
    ])
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
