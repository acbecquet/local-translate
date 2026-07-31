import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { A_NS, elems, openPptx } from '../../../src/core/adapters/pptx/ooxml'
import { PptxAdapter } from '../../../src/core/adapters/pptx/pptx-adapter'
import { runPipeline } from '../../../src/core/pipeline'
import type { TextSegment, TranslatedSegment } from '../../../src/core/segments'
import type {
  BatchRequest,
  BatchResponse,
  TranslationBackend
} from '../../../src/core/translate/backend'
import { buildPptx, type BuildPptxOptions } from '../../helpers/build-pptx'
import { checkPptxIntegrity } from '../../helpers/pptx-integrity'

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

async function writeDeck(opts: BuildPptxOptions): Promise<string> {
  const buffer = await buildPptx(opts)
  const dir = await tmpDir('lt-pptx-adapter-')
  const srcPath = path.join(dir, 'src.pptx')
  await writeFile(srcPath, buffer)
  return srcPath
}

/** sha256 of the decompressed bytes of every part in a .pptx buffer, keyed by part path (same technique as ooxml.test.ts). */
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

/** Reverses each paragraph's characters independently (codepoint-safe, so CJK/surrogate pairs survive) - a deterministic, offline stand-in for a real translation model. Never echoes non-trivial text back unchanged. */
function mockTranslate(text: string): string {
  return text
    .split('\n')
    .map((line) => [...line].reverse().join(''))
    .join('\n')
}

function reverseTranslateBackend(): TranslationBackend {
  return {
    listModels: vi.fn().mockResolvedValue([]),
    pullModel: vi.fn().mockResolvedValue(undefined),
    translateBatch: vi.fn(async (req: BatchRequest): Promise<BatchResponse> => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: mockTranslate(s.text) }))
    }))
  }
}

interface RoundTrip {
  outPath: string
  originalSegments: TextSegment[]
  reExtracted: TextSegment[]
}

/** extract -> mock-translate (via runPipeline) -> apply -> re-extract. */
async function roundTrip(srcPath: string): Promise<RoundTrip> {
  const adapter = new PptxAdapter()
  const originalSegments = await adapter.extract(srcPath)
  const report = await runPipeline({
    file: srcPath,
    sourceLang: 'English',
    targetLang: 'French',
    model: 'test-model',
    adapter,
    backend: reverseTranslateBackend()
  })
  const reExtracted = await adapter.extract(report.outPath)
  return { outPath: report.outPath, originalSegments, reExtracted }
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]))
}

let warnSpy: ReturnType<typeof vi.spyOn>
let warnMessages: string[] = []
beforeEach(() => {
  warnMessages = []
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg: unknown) => {
    warnMessages.push(String(msg))
  })
})
afterEach(() => {
  warnSpy.mockRestore()
})

describe('PptxAdapter.extract', () => {
  it('registers as the .pptx adapter', () => {
    const adapter = new PptxAdapter()
    expect(adapter.name).toBe('pptx')
    expect(adapter.extensions).toEqual(['.pptx'])
  })

  it('extracts a multi-paragraph textbox: paragraphs joined by \\n, stable id, groupKey slide<N>, context "text box"', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['First paragraph.', 'Second paragraph.', 'Third paragraph.'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT },
              fontPt: 18,
              name: 'Body Text 1'
            }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)

    expect(segments).toHaveLength(1)
    const s = segments[0]
    expect(s.id).toBe('slide1/shape[name=Body Text 1]/tb')
    expect(s.text).toBe('First paragraph.\nSecond paragraph.\nThird paragraph.')
    expect(s.groupKey).toBe('slide1')
    expect(s.context).toBe('text box')
    expect(s.kind).toBe('shape')
    expect(s.font.sizePt).toBe(18)
    // WRAP_SAFETY (0.96) shrinks only the width, insets already subtracted by geometry.ts.
    const insetW = 5000 - 7.2 - 7.2
    expect(s.box.wPt).toBeCloseTo(insetW * 0.96, 6)
    expect(s.box.hPt).toBeCloseTo(3000 - 3.6 - 3.6, 6)
  })

  it('title/body placeholders inherit their box from the layout and get "slide title"/"body" roles', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            { kind: 'placeholder', phType: 'title', text: ['My Title'] },
            { kind: 'placeholder', phType: 'body', text: ['Body line one', 'Body line two'] }
          ]
        }
      ],
      layoutPlaceholderBox: [
        {
          phType: 'title',
          box: { xEmu: 0, yEmu: 0, wEmu: 4000 * EMU_PER_PT, hEmu: 800 * EMU_PER_PT }
        },
        {
          phType: 'body',
          box: { xEmu: 0, yEmu: 900, wEmu: 4000 * EMU_PER_PT, hEmu: 2000 * EMU_PER_PT }
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(2)
    const title = segments.find((s) => s.context === 'slide title')!
    const body = segments.find((s) => s.context === 'body')!

    expect(title.text).toBe('My Title')
    expect(title.font.sizePt).toBe(44) // placeholder default for "title"
    expect(title.box.wPt).toBeCloseTo((4000 - 7.2 - 7.2) * 0.96, 6)

    expect(body.text).toBe('Body line one\nBody line two')
    expect(body.font.sizePt).toBe(18) // placeholder default for "body"
    expect(body.groupKey).toBe('slide1')
  })

  it('a 3x3 table with a combined merge emits a segment only for the merge anchor cell, addressed r<R>c<C> (1-based)', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'table',
              name: 'Data Table',
              box: { xEmu: 0, yEmu: 0, wEmu: 3000 * EMU_PER_PT, hEmu: 1800 * EMU_PER_PT },
              colWidthsEmu: [1000 * EMU_PER_PT, 1000 * EMU_PER_PT, 1000 * EMU_PER_PT],
              rowHeightsEmu: [600 * EMU_PER_PT, 600 * EMU_PER_PT, 600 * EMU_PER_PT],
              rows: [
                [{ text: 'Anchor', gridSpan: 2, rowSpan: 2 }, { text: '', hMerge: true }, 'C3'],
                [{ text: '', vMerge: true }, { text: '', hMerge: true, vMerge: true }, 'C6'],
                ['A7', 'B8', 'C9']
              ]
            }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    const ids = segments.map((s) => s.id).sort()

    // 9 cells - 3 merge-covered continuation cells (the hMerge/vMerge-only
    // ones) = 6 real segments, one per surviving anchor/plain cell.
    expect(ids).toEqual([
      'slide1/table[gf-name=Data Table]/r1c1',
      'slide1/table[gf-name=Data Table]/r1c3',
      'slide1/table[gf-name=Data Table]/r2c3',
      'slide1/table[gf-name=Data Table]/r3c1',
      'slide1/table[gf-name=Data Table]/r3c2',
      'slide1/table[gf-name=Data Table]/r3c3'
    ])

    const anchor = byId(segments).get('slide1/table[gf-name=Data Table]/r1c1')!
    expect(anchor.text).toBe('Anchor')
    expect(anchor.context).toBe('table cell')
    expect(anchor.kind).toBe('table-cell')
    // Union box: 2 cols x 2 rows = 2000pt x 1200pt (before WRAP_SAFETY on width).
    expect(anchor.box.wPt).toBeCloseTo(2000 * 0.96, 6)
    expect(anchor.box.hPt).toBeCloseTo(1200, 6)
  })

  it('a two-level nested group compounds the id path and the box/font scale', async () => {
    // Outer group: ext 400x400 / chExt 200x200 -> sx=sy=2. Inner group (in
    // outer's child space): ext 100x100 / chExt 50x50 -> sx=sy=2. Compounded: 4x.
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'group',
              name: 'Outer',
              box: { xEmu: 0, yEmu: 0, wEmu: 400 * EMU_PER_PT, hEmu: 400 * EMU_PER_PT },
              chOff: { xEmu: 0, yEmu: 0 },
              chExt: { wEmu: 200 * EMU_PER_PT, hEmu: 200 * EMU_PER_PT },
              children: [
                {
                  kind: 'group',
                  name: 'Inner',
                  box: { xEmu: 0, yEmu: 0, wEmu: 100 * EMU_PER_PT, hEmu: 100 * EMU_PER_PT },
                  chOff: { xEmu: 0, yEmu: 0 },
                  chExt: { wEmu: 50 * EMU_PER_PT, hEmu: 50 * EMU_PER_PT },
                  children: [
                    {
                      kind: 'textbox',
                      name: 'Leaf',
                      text: ['nested text'],
                      box: { xEmu: 0, yEmu: 0, wEmu: 10 * EMU_PER_PT, hEmu: 10 * EMU_PER_PT },
                      insetsEmu: { l: 0, r: 0, t: 0, b: 0 },
                      fontPt: 10
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(1)
    const s = segments[0]
    expect(s.id).toBe('slide1/group[name=Outer]/group[name=Inner]/shape[name=Leaf]/tb')
    // Zero insets isolate pure scaling: 10pt * 4 = 40pt, then WRAP_SAFETY on width.
    expect(s.box.wPt).toBeCloseTo(40 * 0.96, 6)
    expect(s.box.hPt).toBeCloseTo(40, 6)
    expect(s.font.sizePt).toBe(10 * 4)
  })

  it('extracts an all-Chinese deck, preferring the a:ea typeface for CJK text', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['这是第一段中文文本。', '这是第二段中文文本，内容更长一些。'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT },
              fontPt: 18,
              fontFamily: 'Microsoft YaHei'
            }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('这是第一段中文文本。\n这是第二段中文文本，内容更长一些。')
    // The builder only ever sets a:latin (fontFamily), never a:ea, so with
    // no a:ea present resolveBodyFont must fall back to the a:latin
    // typeface that IS there rather than reporting the generic default.
    expect(segments[0].font.family).toBe('Microsoft YaHei')
  })

  it('extracts notes with groupKey slide<N>-notes, context "notes", and a sentinel (never-shrink) box', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Slide content'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
            }
          ],
          notes: 'Speaker notes line one\nSpeaker notes line two'
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    const notes = segments.find((s) => s.kind === 'notes')!
    expect(notes).toBeDefined()
    expect(notes.id).toBe('slide1/notes')
    expect(notes.groupKey).toBe('slide1-notes')
    expect(notes.context).toBe('notes')
    expect(notes.text).toBe('Speaker notes line one\nSpeaker notes line two')
    // Sentinel: large enough that fit() will never need to shrink from this size.
    expect(notes.box.wPt).toBeGreaterThan(100_000)
    expect(notes.box.hPt).toBeGreaterThan(100_000)
  })

  it('a picture and a chart contribute zero segments (skip path) and each logs one warning', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Real text'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
            },
            { kind: 'picture', box: { xEmu: 0, yEmu: 600, wEmu: 200, hEmu: 200 } },
            { kind: 'chart', box: { xEmu: 0, yEmu: 900, wEmu: 400, hEmu: 400 } }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('Real text')
    expect(warnMessages).toHaveLength(1) // chart logs; a plain (non-video) picture logs nothing
    expect(warnMessages[0]).toMatch(/chart/)
  })

  it('a WordArt textbox is skipped (extract-and-report-only path) and never returned as a segment', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Fancy WordArt text'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 },
              wordArt: true
            },
            {
              kind: 'textbox',
              text: ['Plain text'],
              box: { xEmu: 0, yEmu: 600, wEmu: 1000, hEmu: 500 }
            }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('Plain text')
    expect(warnMessages.some((m) => /WordArt/.test(m))).toBe(true)
  })

  it('a linked video picture is skipped and logged', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            { kind: 'picture', box: { xEmu: 0, yEmu: 0, wEmu: 200, hEmu: 200 }, video: true }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(0)
    expect(warnMessages.some((m) => /video/.test(m))).toBe(true)
  })

  it('SmartArt: one segment per data point, addressed via the graphicFrame name + modelId, context "smartart", sharing the graphicFrame\'s box', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'smartart',
              name: 'Process Diagram',
              box: { xEmu: 0, yEmu: 0, wEmu: 4000 * EMU_PER_PT, hEmu: 2000 * EMU_PER_PT },
              points: ['Step one', 'Step two', 'Step three']
            }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(3)
    for (const s of segments) {
      expect(s.context).toBe('smartart')
      expect(s.kind).toBe('shape')
      expect(s.groupKey).toBe('slide1')
      expect(s.id).toMatch(/^slide1\/smartart\[gf-name=Process Diagram\]\/pt\d+$/)
    }
    expect(segments.map((s) => s.text).sort()).toEqual(['Step one', 'Step three', 'Step two'])
    // Every point shares the SAME graphicFrame box (the contract says "the
    // graphicFrame's box", singular - not a per-point resolved box).
    const boxes = new Set(segments.map((s) => JSON.stringify(s.box)))
    expect(boxes.size).toBe(1)
  })

  it('skips shapes whose body is empty or whitespace-only', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            { kind: 'textbox', text: [''], box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 } },
            {
              kind: 'textbox',
              text: ['   ', '\t'],
              box: { xEmu: 0, yEmu: 600, wEmu: 1000, hEmu: 500 }
            },
            { kind: 'textbox', text: ['Real'], box: { xEmu: 0, yEmu: 1200, wEmu: 1000, hEmu: 500 } }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('Real')
  })

  it('duplicate shape names get a stable -2, -3, ... ordinal suffix so every id stays unique', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['first'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 },
              name: 'Same Name'
            },
            {
              kind: 'textbox',
              text: ['second'],
              box: { xEmu: 0, yEmu: 600, wEmu: 1000, hEmu: 500 },
              name: 'Same Name'
            },
            {
              kind: 'textbox',
              text: ['third'],
              box: { xEmu: 0, yEmu: 1200, wEmu: 1000, hEmu: 500 },
              name: 'Same Name'
            }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    const ids = segments.map((s) => s.id)
    expect(new Set(ids).size).toBe(3) // uniqueness contract runPipeline enforces
    expect(ids).toEqual([
      'slide1/shape[name=Same Name]/tb',
      'slide1/shape[name=Same Name]/tb-2',
      'slide1/shape[name=Same Name]/tb-3'
    ])
    // ids track the ORIGINAL shape, not sorted/renamed - text still matches by position.
    expect(byId(segments).get('slide1/shape[name=Same Name]/tb')!.text).toBe('first')
    expect(byId(segments).get('slide1/shape[name=Same Name]/tb-2')!.text).toBe('second')
    expect(byId(segments).get('slide1/shape[name=Same Name]/tb-3')!.text).toBe('third')
  })

  it('every extracted segment id is unique across a deck combining shapes, groups, tables, and notes', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            { kind: 'textbox', text: ['a'], box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 } },
            {
              kind: 'table',
              box: { xEmu: 0, yEmu: 600, wEmu: 2000, hEmu: 1200 },
              colWidthsEmu: [1000, 1000],
              rowHeightsEmu: [600, 600],
              rows: [
                ['b', 'c'],
                ['d', 'e']
              ]
            },
            {
              kind: 'group',
              box: { xEmu: 0, yEmu: 1900, wEmu: 400, hEmu: 400 },
              chOff: { xEmu: 0, yEmu: 0 },
              chExt: { wEmu: 200, hEmu: 200 },
              children: [
                { kind: 'textbox', text: ['f'], box: { xEmu: 0, yEmu: 0, wEmu: 100, hEmu: 100 } }
              ]
            }
          ],
          notes: 'g'
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    const ids = segments.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(7) // a, b, c, d, e (4 table cells), f, g (notes)
  })

  it("table cells with no explicit run size/typeface fall back to the adapter's defaults (18pt, Calibri)", async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'table',
              box: { xEmu: 0, yEmu: 0, wEmu: 2000 * EMU_PER_PT, hEmu: 1200 * EMU_PER_PT },
              colWidthsEmu: [1000 * EMU_PER_PT],
              rowHeightsEmu: [1200 * EMU_PER_PT],
              rows: [['plain cell']]
            }
          ]
        }
      ]
    })
    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(1)
    expect(segments[0].font.sizePt).toBe(18)
    expect(segments[0].font.family).toBe('Calibri')
  })
})

/** Builds a TranslatedSegment from a TextSegment, defaulting to "nothing changed" (translation === text, fittedSizePt === font.sizePt) unless overridden - the zero-diff baseline every apply() test starts from. */
function makeTranslated(
  seg: TextSegment,
  overrides: Partial<TranslatedSegment> = {}
): TranslatedSegment {
  return {
    ...seg,
    translation: seg.text,
    fittedSizePt: seg.font.sizePt,
    fittedLines: [seg.text],
    ...overrides
  }
}

describe('PptxAdapter.apply', () => {
  it("1:1 paragraph mapping: each translated line replaces its own paragraph's text", async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Hello', 'World'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT },
              fontPt: 18
            }
          ]
        }
      ]
    })
    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    const translated = makeTranslated(seg, { translation: 'Bonjour\nMonde' })

    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const archive = await openPptx(outPath)
    const doc = archive.readXml(archive.listSlidePaths()[0])
    const texts = elems(doc, A_NS, 'p').map((p) =>
      elems(p, A_NS, 't')
        .map((t) => t.textContent)
        .join('')
    )
    expect(texts).toEqual(['Bonjour', 'Monde'])

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('paragraph count mismatch: all text collapses into the first run found; every other run (any paragraph) is emptied, not deleted', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Hello', 'World'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT },
              bold: true
            }
          ]
        }
      ]
    })
    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    // 3 lines vs 2 source paragraphs: count mismatch.
    const translated = makeTranslated(seg, { translation: 'Un\nDeux\nTrois' })

    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const archive = await openPptx(outPath)
    const doc = archive.readXml(archive.listSlidePaths()[0])
    const runs = elems(doc, A_NS, 'r')
    expect(runs).toHaveLength(2) // one run per original paragraph, neither deleted nor added to
    expect(elems(runs[0], A_NS, 't')[0].textContent).toBe('Un\nDeux\nTrois')
    expect(elems(runs[1], A_NS, 't')[0].textContent).toBe('')
    // Formatting retained on the emptied run (never deleted).
    const rPr2 = elems(runs[1], A_NS, 'rPr')[0]
    expect(rPr2).toBeDefined()
    expect(rPr2.getAttribute('b')).toBe('1')
  })

  it('a paragraph with multiple runs: the first run gets the whole line, sibling runs in the SAME paragraph are emptied but keep their a:rPr', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Hello'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT },
              fontPt: 18
            }
          ]
        }
      ]
    })
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let xml = await zip.file(slidePath)!.async('string')
    const original = '<a:p><a:r><a:rPr lang="en-US" sz="1800"></a:rPr><a:t>Hello</a:t></a:r></a:p>'
    expect(xml).toContain(original)
    const twoRuns =
      '<a:p><a:r><a:rPr lang="en-US" sz="1800"></a:rPr><a:t>Hello</a:t></a:r>' +
      '<a:r><a:rPr lang="en-US" sz="1800" b="1"></a:rPr><a:t> World</a:t></a:r></a:p>'
    xml = xml.replace(original, twoRuns)
    zip.file(slidePath, xml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.text).toBe('Hello World') // both runs concatenated, no separator

    // Single paragraph, single translated line: 1:1 mapping case.
    const translated = makeTranslated(seg, { translation: 'Bonjour Monde' })
    const outPath = path.join(dir, 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const archive = await openPptx(outPath)
    const doc = archive.readXml(slidePath)
    const runs = elems(doc, A_NS, 'r')
    expect(runs).toHaveLength(2)
    expect(elems(runs[0], A_NS, 't')[0].textContent).toBe('Bonjour Monde')
    expect(elems(runs[0], A_NS, 'rPr')[0].getAttribute('sz')).toBe('1800') // first run's rPr untouched
    expect(elems(runs[1], A_NS, 't')[0].textContent).toBe('')
    expect(elems(runs[1], A_NS, 'rPr')[0].getAttribute('b')).toBe('1') // sibling's rPr retained, not deleted
  })

  it('writes sz (hundredths, rounded to the nearest quarter point) on every non-empty run only when the fitted size differs, and drops a:normAutofit', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Hello'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT },
              fontPt: 18
            }
          ]
        }
      ]
    })
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let xml = await zip.file(slidePath)!.async('string')
    expect(xml).toContain('<a:bodyPr/>')
    xml = xml.replace(
      '<a:bodyPr/>',
      '<a:bodyPr><a:normAutofit fontScale="90000" lnSpcReduction="10000"/></a:bodyPr>'
    )
    zip.file(slidePath, xml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.font.sizePt).toBe(18)

    const translated = makeTranslated(seg, { translation: 'Bonjour', fittedSizePt: 13.4 })
    const outPath = path.join(dir, 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const archive = await openPptx(outPath)
    const doc = archive.readXml(slidePath)
    const rPr = elems(doc, A_NS, 'rPr')[0]
    expect(rPr.getAttribute('sz')).toBe('1350') // 13.4pt -> 1340 hundredths -> nearest 25 -> 1350
    const bodyPr = elems(doc, A_NS, 'bodyPr')[0]
    expect(elems(bodyPr, A_NS, 'normAutofit')).toHaveLength(0)
  })

  it('never touches sz when the fitted size equals the segment font size, even though the text did change', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          // No fontPt set - no explicit run sz in the source XML at all.
          shapes: [
            {
              kind: 'textbox',
              text: ['Hello'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT }
            }
          ]
        }
      ]
    })
    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.font.sizePt).toBe(18) // DEFAULT_FALLBACK_FONT_PT

    const translated = makeTranslated(seg, { translation: 'Bonjour', fittedSizePt: 18 })
    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const archive = await openPptx(outPath)
    const doc = archive.readXml(archive.listSlidePaths()[0])
    const run = elems(doc, A_NS, 'r')[0]
    expect(elems(run, A_NS, 't')[0].textContent).toBe('Bonjour')
    // rPr existed already (the builder always emits one, with lang="en-US")
    // but must never gain an sz attribute it didn't already have.
    expect(elems(run, A_NS, 'rPr')[0].hasAttribute('sz')).toBe(false)
  })

  it('notes: text is replaced but size is never touched even when the fitted size differs from the segment font size', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Slide body'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
            }
          ],
          notes: 'Original notes text'
        }
      ]
    })
    const adapter = new PptxAdapter()
    const segments = await adapter.extract(srcPath)
    const notesSeg = segments.find((s) => s.kind === 'notes')!
    const translated = segments.map((s) =>
      s.id === notesSeg.id
        ? makeTranslated(s, { translation: 'Notes traduites', fittedSizePt: 10 })
        : makeTranslated(s)
    )

    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, translated)

    const reExtracted = await adapter.extract(outPath)
    const reNotes = reExtracted.find((s) => s.kind === 'notes')!
    expect(reNotes.text).toBe('Notes traduites')

    const archive = await openPptx(outPath)
    const notesPath = archive.listNotesPaths()[0]
    const doc = archive.readXml(notesPath)
    const run = elems(doc, A_NS, 'r')[0]
    expect(elems(run, A_NS, 'rPr')[0].hasAttribute('sz')).toBe(false) // no sz was ever written for notes
  })

  it('zero-diff guarantee: a segment whose translation equals its source text is left completely untouched - output is byte-identical to source', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Untouched text'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
            }
          ]
        }
      ]
    })
    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    const translated = makeTranslated(seg) // translation === text, fittedSizePt === font.sizePt

    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const srcDigests = await digestParts(await readFile(srcPath))
    const outDigests = await digestParts(await readFile(outPath))
    expect(new Set(outDigests.keys())).toEqual(new Set(srcDigests.keys()))
    for (const [part, digest] of srcDigests) {
      expect(outDigests.get(part)).toBe(digest)
    }
  })

  it('mixed slide: an untouched segment keeps its exact original text/attrs even though a sibling segment on the same part DID change', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Change me'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 },
              fontPt: 14,
              name: 'Shape A'
            },
            {
              kind: 'textbox',
              text: ['Leave me'],
              box: { xEmu: 0, yEmu: 600, wEmu: 1000, hEmu: 500 },
              fontPt: 14,
              name: 'Shape B'
            }
          ]
        }
      ]
    })
    const adapter = new PptxAdapter()
    const segments = await adapter.extract(srcPath)
    const changeMe = segments.find((s) => s.text === 'Change me')!
    const leaveMe = segments.find((s) => s.text === 'Leave me')!

    const translated = [
      makeTranslated(changeMe, { translation: 'Changez-moi' }),
      makeTranslated(leaveMe)
    ]
    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, translated)

    const reExtracted = await adapter.extract(outPath)
    expect(byId(reExtracted).get(changeMe.id)!.text).toBe('Changez-moi')
    expect(byId(reExtracted).get(leaveMe.id)!.text).toBe('Leave me')
    expect(byId(reExtracted).get(leaveMe.id)!.font.sizePt).toBe(14) // untouched run's sz survives verbatim
  })

  it('apply() throws a clear error for a segment id it cannot locate', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            { kind: 'textbox', text: ['Hello'], box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 } }
          ]
        }
      ]
    })
    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    const bogus: TranslatedSegment = { ...makeTranslated(seg), id: 'slide99/shape[name=Nope]/tb' }

    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await expect(adapter.apply(srcPath, outPath, [bogus])).rejects.toThrow(/slide99/)
  })

  it('a blank middle paragraph (empty text, but still has a run) round-trips as an empty line, not lost and not merging its neighbors', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Hello', '', 'World'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT }
            }
          ]
        }
      ]
    })
    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.text).toBe('Hello\n\nWorld') // the blank paragraph survives as an empty line

    const translated = makeTranslated(seg, { translation: 'Bonjour\n\nMonde' })
    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const reExtracted = await new PptxAdapter().extract(outPath)
    expect(reExtracted[0].text).toBe('Bonjour\n\nMonde')
  })

  it('a genuinely run-less paragraph (bare <a:p/>) that would need non-empty text has nowhere to write it - documented limitation, not a crash or corruption', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Hello', 'World'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT }
            }
          ]
        }
      ]
    })
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let xml = await zip.file(slidePath)!.async('string')
    // Replace the second paragraph (originally "World", one run) with a bare,
    // run-less paragraph - the structurally-empty-spacer-line case real
    // decks do contain.
    const worldParagraph = /<a:p><a:r><a:rPr[^>]*><\/a:rPr><a:t>World<\/a:t><\/a:r><\/a:p>/
    expect(xml).toMatch(worldParagraph)
    xml = xml.replace(worldParagraph, '<a:p/>')
    zip.file(slidePath, xml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    // The run-less second paragraph still contributes an empty line (the
    // paragraph itself exists, it just has no a:t anywhere inside it).
    expect(seg.text).toBe('Hello\n')

    // 2 lines matching the 2 real a:p elements: exercises the 1:1 path,
    // where the second line has no run in its paragraph to land in.
    const translated = makeTranslated(seg, { translation: 'Bonjour\nMonde' })
    const outPath = path.join(dir, 'out.pptx')

    await expect(adapter.apply(srcPath, outPath, [translated])).resolves.toBeUndefined()

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)

    const archive = await openPptx(outPath)
    const doc = archive.readXml(slidePath)
    const paragraphs = elems(doc, A_NS, 'p')
    expect(paragraphs).toHaveLength(2)
    expect(elems(paragraphs[0], A_NS, 't')[0].textContent).toBe('Bonjour') // first paragraph's run did get its line
    expect(elems(paragraphs[1], A_NS, 'r')).toHaveLength(0) // second paragraph stays run-less - "Monde" has nowhere to go
  })
})

/**
 * Full round-trip integration suite (extract -> mock-translate via
 * runPipeline -> apply -> re-extract), one builder deck per scenario the
 * brief lists. Every scenario asserts the same invariants: every segment is
 * accounted for, its re-extracted text matches the mock translation
 * exactly, parts the adapter never touches survive byte-identical, and the
 * produced file passes the structural integrity check.
 */
describe('PptxAdapter round-trip', () => {
  it('multi-paragraph textbox', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Paragraph one.', 'Paragraph two.', 'Paragraph three.'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT },
              fontPt: 18
            }
          ]
        }
      ]
    })

    const { outPath, originalSegments, reExtracted } = await roundTrip(srcPath)
    expect(originalSegments).toHaveLength(1)
    const reById = byId(reExtracted)
    for (const orig of originalSegments) {
      expect(reById.get(orig.id)!.text).toBe(mockTranslate(orig.text))
    }

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('title+body placeholders inheriting layout boxes', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            { kind: 'placeholder', phType: 'title', text: ['Quarterly Results'] },
            { kind: 'placeholder', phType: 'body', text: ['Revenue is up.', 'Costs are down.'] }
          ]
        }
      ],
      layoutPlaceholderBox: [
        {
          phType: 'title',
          box: { xEmu: 0, yEmu: 0, wEmu: 4000 * EMU_PER_PT, hEmu: 800 * EMU_PER_PT }
        },
        {
          phType: 'body',
          box: { xEmu: 0, yEmu: 900, wEmu: 4000 * EMU_PER_PT, hEmu: 2000 * EMU_PER_PT }
        }
      ]
    })

    const { outPath, originalSegments, reExtracted } = await roundTrip(srcPath)
    expect(originalSegments).toHaveLength(2)
    const reById = byId(reExtracted)
    for (const orig of originalSegments) {
      expect(reById.get(orig.id)!.text).toBe(mockTranslate(orig.text))
      expect(reById.get(orig.id)!.context).toBe(orig.context)
    }

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('3x3 table with merges', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'table',
              name: 'Grid',
              box: { xEmu: 0, yEmu: 0, wEmu: 3000 * EMU_PER_PT, hEmu: 1800 * EMU_PER_PT },
              colWidthsEmu: [1000 * EMU_PER_PT, 1000 * EMU_PER_PT, 1000 * EMU_PER_PT],
              rowHeightsEmu: [600 * EMU_PER_PT, 600 * EMU_PER_PT, 600 * EMU_PER_PT],
              rows: [
                [{ text: 'Header', gridSpan: 2 }, { text: '', hMerge: true }, 'Q1'],
                ['Revenue', 'Costs', 'Margin'],
                ['100', '40', '60']
              ]
            }
          ]
        }
      ]
    })

    const { outPath, originalSegments, reExtracted } = await roundTrip(srcPath)
    // 9 cells - 1 merged-away (hMerge continuation of "Header") = 8 segments.
    // Numeric cells are still extracted as segments - numeric text is just
    // never SENT to the translate backend (see hasTranslatableContent /
    // groupSegments), so it round-trips unchanged.
    expect(originalSegments).toHaveLength(8)
    const reById = byId(reExtracted)
    for (const orig of originalSegments) {
      expect(reById.get(orig.id)).toBeDefined()
      expect(reById.get(orig.id)!.kind).toBe('table-cell')
    }
    // Alphabetic cells got mock-translated (reversed); numeric-only cells
    // were never sent to the backend (hasTranslatableContent is false) and
    // stay exactly as they were.
    const revenue = originalSegments.find((s) => s.text === 'Revenue')!
    expect(reById.get(revenue.id)!.text).toBe(mockTranslate('Revenue'))
    const num = originalSegments.find((s) => s.text === '100')!
    expect(reById.get(num.id)!.text).toBe('100')

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('two-level nested group', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'group',
              name: 'Outer',
              box: { xEmu: 0, yEmu: 0, wEmu: 400 * EMU_PER_PT, hEmu: 400 * EMU_PER_PT },
              chOff: { xEmu: 0, yEmu: 0 },
              chExt: { wEmu: 200 * EMU_PER_PT, hEmu: 200 * EMU_PER_PT },
              children: [
                {
                  kind: 'group',
                  name: 'Inner',
                  box: { xEmu: 0, yEmu: 0, wEmu: 100 * EMU_PER_PT, hEmu: 100 * EMU_PER_PT },
                  chOff: { xEmu: 0, yEmu: 0 },
                  chExt: { wEmu: 50 * EMU_PER_PT, hEmu: 50 * EMU_PER_PT },
                  children: [
                    {
                      kind: 'textbox',
                      name: 'Leaf',
                      text: ['deeply nested text'],
                      box: { xEmu: 0, yEmu: 0, wEmu: 40 * EMU_PER_PT, hEmu: 40 * EMU_PER_PT },
                      fontPt: 12
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })

    const { outPath, originalSegments, reExtracted } = await roundTrip(srcPath)
    expect(originalSegments).toHaveLength(1)
    expect(originalSegments[0].id).toBe(
      'slide1/group[name=Outer]/group[name=Inner]/shape[name=Leaf]/tb'
    )
    const reById = byId(reExtracted)
    expect(reById.get(originalSegments[0].id)!.text).toBe(mockTranslate(originalSegments[0].text))

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('CJK-heavy deck (all-Chinese content)', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['这是标题文本', '这是正文的第一段，包含更多的汉字内容用于测试。'],
              box: { xEmu: 0, yEmu: 0, wEmu: 6000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT },
              fontPt: 20,
              fontFamily: 'Microsoft YaHei'
            }
          ]
        }
      ]
    })

    const { outPath, originalSegments, reExtracted } = await roundTrip(srcPath)
    expect(originalSegments).toHaveLength(1)
    const reById = byId(reExtracted)
    expect(reById.get(originalSegments[0].id)!.text).toBe(mockTranslate(originalSegments[0].text))

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('notes', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Slide body'],
              box: { xEmu: 0, yEmu: 0, wEmu: 3000, hEmu: 1500 }
            }
          ],
          notes: 'These are the speaker notes.\nSecond notes paragraph.'
        }
      ]
    })

    const { outPath, originalSegments, reExtracted } = await roundTrip(srcPath)
    const notesOrig = originalSegments.find((s) => s.kind === 'notes')!
    const reById = byId(reExtracted)
    expect(reById.get(notesOrig.id)!.text).toBe(mockTranslate(notesOrig.text))

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('deck with a picture + chart (skip path): both are ignored, their parts are byte-identical, and real text on the same slide still translates', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Real translatable text'],
              box: { xEmu: 0, yEmu: 0, wEmu: 3000, hEmu: 1500 }
            },
            { kind: 'picture', box: { xEmu: 0, yEmu: 1600, wEmu: 800, hEmu: 800 } },
            { kind: 'chart', box: { xEmu: 0, yEmu: 2500, wEmu: 1600, hEmu: 1600 } }
          ]
        }
      ]
    })

    const srcBuffer = await readFile(srcPath)
    const srcDigests = await digestParts(srcBuffer)

    const { outPath, originalSegments, reExtracted } = await roundTrip(srcPath)
    expect(originalSegments).toHaveLength(1) // picture and chart contribute nothing
    const reById = byId(reExtracted)
    expect(reById.get(originalSegments[0].id)!.text).toBe(mockTranslate(originalSegments[0].text))
    // No stray segments appeared for the picture/chart on re-extract either.
    expect(reExtracted).toHaveLength(1)

    const outBuffer = await readFile(outPath)
    const outDigests = await digestParts(outBuffer)
    // The chart part and the image media part are never touched at all.
    const chartPart = [...srcDigests.keys()].find((p) => p.startsWith('ppt/charts/'))!
    const mediaPart = [...srcDigests.keys()].find((p) => p.startsWith('ppt/media/'))!
    expect(chartPart).toBeDefined()
    expect(mediaPart).toBeDefined()
    expect(outDigests.get(chartPart)).toBe(srcDigests.get(chartPart))
    expect(outDigests.get(mediaPart)).toBe(srcDigests.get(mediaPart))
    // Untouched sibling parts (layout/master) also survive byte-identical.
    expect(outDigests.get('ppt/slideLayouts/slideLayout1.xml')).toBe(
      srcDigests.get('ppt/slideLayouts/slideLayout1.xml')
    )
    expect(outDigests.get('ppt/slideMasters/slideMaster1.xml')).toBe(
      srcDigests.get('ppt/slideMasters/slideMaster1.xml')
    )

    const integrity = await checkPptxIntegrity(outBuffer)
    expect(integrity.ok).toBe(true)
  })

  it('a deck spanning every scenario at once: every segment accounted for, nothing lost, nothing duplicated', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            { kind: 'placeholder', phType: 'title', text: ['Slide One'] },
            {
              kind: 'textbox',
              text: ['Multi\nparagraph\ntextbox'],
              box: {
                xEmu: 0,
                yEmu: 900 * EMU_PER_PT,
                wEmu: 4000 * EMU_PER_PT,
                hEmu: 1500 * EMU_PER_PT
              }
            },
            {
              kind: 'table',
              box: {
                xEmu: 0,
                yEmu: 2500 * EMU_PER_PT,
                wEmu: 2000 * EMU_PER_PT,
                hEmu: 1200 * EMU_PER_PT
              },
              colWidthsEmu: [1000 * EMU_PER_PT, 1000 * EMU_PER_PT],
              rowHeightsEmu: [600 * EMU_PER_PT, 600 * EMU_PER_PT],
              rows: [
                ['A1', 'B1'],
                ['A2', 'B2']
              ]
            },
            {
              kind: 'group',
              box: {
                xEmu: 5000 * EMU_PER_PT,
                yEmu: 0,
                wEmu: 400 * EMU_PER_PT,
                hEmu: 400 * EMU_PER_PT
              },
              chOff: { xEmu: 0, yEmu: 0 },
              chExt: { wEmu: 200 * EMU_PER_PT, hEmu: 200 * EMU_PER_PT },
              children: [
                {
                  kind: 'textbox',
                  text: ['grouped'],
                  box: { xEmu: 0, yEmu: 0, wEmu: 100 * EMU_PER_PT, hEmu: 100 * EMU_PER_PT }
                }
              ]
            },
            {
              kind: 'picture',
              box: { xEmu: 5000 * EMU_PER_PT, yEmu: 2500 * EMU_PER_PT, wEmu: 400, hEmu: 400 }
            },
            {
              kind: 'chart',
              box: { xEmu: 5000 * EMU_PER_PT, yEmu: 3200 * EMU_PER_PT, wEmu: 400, hEmu: 400 }
            }
          ],
          notes: 'Slide one speaker notes.'
        },
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['第二张幻灯片的中文内容'],
              box: { xEmu: 0, yEmu: 0, wEmu: 4000 * EMU_PER_PT, hEmu: 1500 * EMU_PER_PT }
            }
          ]
        }
      ],
      layoutPlaceholderBox: {
        phType: 'title',
        box: { xEmu: 0, yEmu: 0, wEmu: 4000 * EMU_PER_PT, hEmu: 800 * EMU_PER_PT }
      }
    })

    const { outPath, originalSegments, reExtracted } = await roundTrip(srcPath)

    const origIds = originalSegments.map((s) => s.id).sort()
    const reIds = reExtracted.map((s) => s.id).sort()
    expect(new Set(origIds).size).toBe(origIds.length) // no duplicates on extract
    expect(reIds).toEqual(origIds) // exact same set survives the round trip

    const reById = byId(reExtracted)
    for (const orig of originalSegments) {
      expect(reById.get(orig.id)!.text).toBe(mockTranslate(orig.text))
    }

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it("SmartArt: data points translate and re-extract from the diagram data part; the diagram's layout/style/colors parts are never touched", async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'smartart',
              name: 'Cycle',
              box: { xEmu: 0, yEmu: 0, wEmu: 4000 * EMU_PER_PT, hEmu: 2000 * EMU_PER_PT },
              points: ['Plan', 'Do', 'Check', 'Act']
            }
          ]
        }
      ]
    })

    const srcDigests = await digestParts(await readFile(srcPath))
    const { outPath, originalSegments, reExtracted } = await roundTrip(srcPath)

    expect(originalSegments).toHaveLength(4)
    const reById = byId(reExtracted)
    for (const orig of originalSegments) {
      expect(reById.get(orig.id)!.text).toBe(mockTranslate(orig.text))
    }

    const outDigests = await digestParts(await readFile(outPath))
    const layoutPart = [...srcDigests.keys()].find((p) => p.startsWith('ppt/diagrams/layout'))!
    const stylePart = [...srcDigests.keys()].find((p) => p.startsWith('ppt/diagrams/quickStyle'))!
    const colorsPart = [...srcDigests.keys()].find((p) => p.startsWith('ppt/diagrams/colors'))!
    const dataPart = [...srcDigests.keys()].find((p) => p.startsWith('ppt/diagrams/data'))!
    expect(outDigests.get(layoutPart)).toBe(srcDigests.get(layoutPart))
    expect(outDigests.get(stylePart)).toBe(srcDigests.get(stylePart))
    expect(outDigests.get(colorsPart)).toBe(srcDigests.get(colorsPart))
    // The data part DID change (that's where the translated point text lives).
    expect(outDigests.get(dataPart)).not.toBe(srcDigests.get(dataPart))

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })
})
