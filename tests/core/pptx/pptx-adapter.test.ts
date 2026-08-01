import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { Canvas } from 'skia-canvas'
import type { Element } from '@xmldom/xmldom'
import { A_NS, elems, openPptx } from '../../../src/core/adapters/pptx/ooxml'
import { PptxAdapter } from '../../../src/core/adapters/pptx/pptx-adapter'
import { runPipeline } from '../../../src/core/pipeline'
import type { TextSegment, TranslatedSegment } from '../../../src/core/segments'
import {
  CONFIDENCE_FLOOR,
  type RegionEngine,
  type TextRegion
} from '../../../src/core/images/regions'
import type {
  BatchRequest,
  BatchResponse,
  TranslationBackend
} from '../../../src/core/translate/backend'
import { buildPptx, type BuildPptxOptions } from '../../helpers/build-pptx'
import { checkPptxIntegrity } from '../../helpers/pptx-integrity'

/** A real, skia-canvas-decodable solid-color PNG - media region detection decodes real dimensions, so every fixture here must be a genuine encoded image, never a raw/fake buffer. */
async function makePngBytes(width: number, height: number, color = '#ffffff'): Promise<Buffer> {
  const canvas = new Canvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  return canvas.toBuffer('png')
}

async function makeJpegBytes(width: number, height: number, color = '#ffffff'): Promise<Buffer> {
  const canvas = new Canvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  return canvas.toBuffer('jpeg', { quality: 0.9 })
}

/** Routes detectRegions by exact buffer identity - lets one test register several distinct media buffers, each with its own canned detection result (mirrors tests/core/images/image-adapter.test.ts's own per-file routing for the same reason: more than one real media buffer can be in play in a single test). */
function fakeMediaEngine(entries: { bytes: Buffer; regions: TextRegion[] }[]): RegionEngine {
  const detectRegions = vi.fn(async (buf: Buffer) => {
    const match = entries.find((e) => e.bytes.equals(buf))
    return match ? match.regions : []
  })
  return { detectRegions }
}

function rawMediaRegion(
  overrides: Partial<TextRegion> & { bbox: TextRegion['bbox']; text: string }
): TextRegion {
  return { id: 'raw', confidence: 0.9, ...overrides }
}

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

/** Writes a real image buffer to a fresh tmp file - for the gating-parity test, which runs image-adapter.ts (a standalone-file adapter) side by side with the pptx adapter over equivalent content. */
async function writeStandaloneImage(bytes: Buffer): Promise<string> {
  const dir = await tmpDir('lt-pptx-gating-parity-')
  const file = path.join(dir, 'photo.png')
  await writeFile(file, bytes)
  return file
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

function translateBackend(translateFn: (text: string) => string): TranslationBackend {
  return {
    listModels: vi.fn().mockResolvedValue([]),
    pullModel: vi.fn().mockResolvedValue(undefined),
    translateBatch: vi.fn(async (req: BatchRequest): Promise<BatchResponse> => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: translateFn(s.text) }))
    }))
  }
}

/** Appends one extra line to every segment - a count-CHANGING mock translator (more lines out than in), for the paragraph-mismatch round-trip tests. */
function addLineTranslate(text: string): string {
  return `${mockTranslate(text)}\nEXTRA LINE`
}

/** Drops the last line of every multi-line segment - a count-CHANGING mock translator (fewer lines out than in). Single-line segments are still reversed so they're never an echo. */
function dropLineTranslate(text: string): string {
  const lines = mockTranslate(text).split('\n')
  return lines.length > 1 ? lines.slice(0, -1).join('\n') : lines[0]
}

interface RoundTrip {
  outPath: string
  originalSegments: TextSegment[]
  reExtracted: TextSegment[]
}

/** extract -> mock-translate (via runPipeline) -> apply -> re-extract. */
async function roundTrip(
  srcPath: string,
  translateFn: (text: string) => string = mockTranslate
): Promise<RoundTrip> {
  const adapter = new PptxAdapter()
  const originalSegments = await adapter.extract(srcPath)
  const report = await runPipeline({
    file: srcPath,
    sourceLang: 'English',
    targetLang: 'French',
    model: 'test-model',
    adapter,
    backend: translateBackend(translateFn)
  })
  const reExtracted = await adapter.extract(report.outPath)
  return { outPath: report.outPath, originalSegments, reExtracted }
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]))
}

/** `localName` of every direct ELEMENT child of `el`, in document order - for asserting exact CT_TextParagraph child sequence (pPr?, (r|br|fld)*, endParaRPr?). */
function directChildElementNames(el: Element): (string | null)[] {
  const names: (string | null)[] = []
  const children = el.childNodes
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i)
    if (child && child.nodeType === 1) names.push((child as Element).localName)
  }
  return names
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

  it('a placeholder shape with no box anywhere in slide/layout/master resolves geometry.box: null and gets SENTINEL_BOX (never a fabricated zero box)', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [{ kind: 'placeholder', phType: 'body', text: ['Unplaced body text'] }]
        }
      ]
      // Deliberately no layoutPlaceholderBox/masterPlaceholderBox for "body":
      // a placeholder <p:sp> never emits its own <a:xfrm> (see buildShapeXml's
      // 'placeholder' case), so with nothing to inherit from either,
      // resolveShapeGeom has no ext at all to compute a box from.
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(1)
    const [s] = segments
    expect(s.kind).toBe('shape')
    // Sentinel: large enough that fit() will never need to shrink from
    // whatever size this segment starts at - same convention as the notes
    // and ragged-table-cell sentinel cases above, exercised here for the
    // handleSp box:null branch specifically.
    expect(s.box.wPt).toBeGreaterThan(100_000)
    expect(s.box.hPt).toBeGreaterThan(100_000)
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
    // Union box: 2 cols x 2 rows = 2000pt x 1200pt, minus the anchor cell's
    // default tcPr margins (91440/45720 EMU = 7.2pt/3.6pt per side, applied
    // ONCE for the whole union, not once per covered cell), before
    // WRAP_SAFETY on width.
    expect(anchor.box.wPt).toBeCloseTo((2000 - 7.2 - 7.2) * 0.96, 6)
    expect(anchor.box.hPt).toBeCloseTo(1200 - 3.6 - 3.6, 6)
  })

  it('a merge-continuation cell that unexpectedly carries text is still dropped (anchor-only is intentional), but logs a warning instead of failing silently', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'table',
              name: 'Malformed Table',
              box: { xEmu: 0, yEmu: 0, wEmu: 2000 * EMU_PER_PT, hEmu: 600 * EMU_PER_PT },
              colWidthsEmu: [1000 * EMU_PER_PT, 1000 * EMU_PER_PT],
              rowHeightsEmu: [600 * EMU_PER_PT],
              rows: [
                [
                  { text: 'Anchor', gridSpan: 2 },
                  { text: 'stray leftover text', hMerge: true }
                ]
              ]
            }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(1) // the continuation cell's stray text is still never extracted
    expect(segments[0].text).toBe('Anchor')
    expect(warnMessages.some((m) => /merge-continuation cell/.test(m) && /r1c2/.test(m))).toBe(true)
  })

  it('a row with more a:tc than gridCol entries keeps the out-of-grid cell at its original size (sentinel box, never a fabricated zero box) and logs a warning', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'table',
              name: 'Ragged Table',
              box: { xEmu: 0, yEmu: 0, wEmu: 2000 * EMU_PER_PT, hEmu: 600 * EMU_PER_PT },
              // Only 1 gridCol, but the row carries 2 a:tc - a malformed/
              // hand-edited deck where the grid and the row disagree.
              colWidthsEmu: [2000 * EMU_PER_PT],
              rowHeightsEmu: [600 * EMU_PER_PT],
              rows: [['Cell1', 'Extra']]
            }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(2)
    const inGrid = segments.find((s) => s.text === 'Cell1')!
    const outOfGrid = segments.find((s) => s.text === 'Extra')!

    // The in-grid cell resolves a real, small box as usual.
    expect(inGrid.box.wPt).toBeLessThan(100_000)
    // The out-of-grid cell falls back to the sentinel (never-shrink) box,
    // never a fabricated { wPt: 0, hPt: 0 } that would shrink its text to
    // the fit floor for no real reason.
    expect(outOfGrid.box.wPt).toBeGreaterThan(100_000)
    expect(outOfGrid.box.hPt).toBeGreaterThan(100_000)

    expect(warnMessages.some((m) => /r1c2/.test(m))).toBe(true)
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
    // Font stays NOMINAL under group scale (PowerPoint scales geometry, not
    // text glyphs - empirically verified 2026-07-31).
    expect(s.font.sizePt).toBe(10)
  })

  it('a table nested one level inside an asymmetrically-scaled group has its cell box scaled by groupScale exactly once (tableCellBoxes is scale-naive; handleTable multiplies externally)', async () => {
    // ext 400x200 / chExt 100x100 -> sx=4, sy=2: distinct axes so a
    // transposed or double-applied scale would produce a visibly different,
    // wrong pair of numbers rather than coincidentally matching.
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'group',
              name: 'Scaler',
              box: { xEmu: 0, yEmu: 0, wEmu: 400 * EMU_PER_PT, hEmu: 200 * EMU_PER_PT },
              chOff: { xEmu: 0, yEmu: 0 },
              chExt: { wEmu: 100 * EMU_PER_PT, hEmu: 100 * EMU_PER_PT },
              children: [
                {
                  kind: 'table',
                  name: 'Inner Table',
                  box: { xEmu: 0, yEmu: 0, wEmu: 20 * EMU_PER_PT, hEmu: 10 * EMU_PER_PT },
                  colWidthsEmu: [20 * EMU_PER_PT],
                  rowHeightsEmu: [10 * EMU_PER_PT],
                  rows: [['Cell text']]
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
    expect(s.id).toBe('slide1/group[name=Scaler]/table[gf-name=Inner Table]/r1c1')
    // Raw cell box from tableCellBoxes (scale-naive, pure gridCol/tr EMU
    // math): 20pt x 10pt, minus the cell's default tcPr margins (7.2pt each
    // side horizontally, 3.6pt each side vertically) -> 5.6pt x 2.8pt.
    // handleTable applies sx to width and sy to height EXTERNALLY, exactly
    // once, then WRAP_SAFETY on width only.
    const marginW = 20 - 7.2 - 7.2
    const marginH = 10 - 3.6 - 3.6
    expect(s.box.wPt).toBeCloseTo(marginW * 4 * 0.96, 6)
    expect(s.box.hPt).toBeCloseTo(marginH * 2, 6)
  })

  it('a SmartArt graphicFrame nested one level inside an asymmetrically-scaled group has its box scaled exactly once via geometry.ts', async () => {
    // Same 400x200 / 100x100 group as the table test above -> sx=4, sy=2.
    // Unlike the table (whose box the adapter scales externally), a
    // SmartArt graphicFrame's box comes from resolveShapeGeom() itself,
    // which applies groupScale internally - a genuinely different code path,
    // worth its own proof that it isn't ALSO scaled a second time externally.
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'group',
              name: 'Scaler',
              box: { xEmu: 0, yEmu: 0, wEmu: 400 * EMU_PER_PT, hEmu: 200 * EMU_PER_PT },
              chOff: { xEmu: 0, yEmu: 0 },
              chExt: { wEmu: 100 * EMU_PER_PT, hEmu: 100 * EMU_PER_PT },
              children: [
                {
                  kind: 'smartart',
                  name: 'Diagram',
                  box: { xEmu: 0, yEmu: 0, wEmu: 40 * EMU_PER_PT, hEmu: 20 * EMU_PER_PT },
                  points: ['Point A']
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
    expect(s.id).toBe('slide1/group[name=Scaler]/smartart[gf-name=Diagram]/pt1')
    // resolveShapeGeom subtracts default insets (91440/45720 EMU = 7.2pt/
    // 3.6pt) from the RAW (unscaled) ext before scaling, then scales the
    // already-inset-adjusted width/height by sx/sy respectively - so
    // box.wPt = (40 - 7.2 - 7.2) * 4, not 40*4 - 7.2 - 7.2 (a double-scale
    // bug would produce (40-7.2-7.2)*4*4, easily distinguished from this).
    const insetW = 40 - 7.2 - 7.2
    const insetH = 20 - 3.6 - 3.6
    expect(s.box.wPt).toBeCloseTo(insetW * 4 * 0.96, 6)
    expect(s.box.hPt).toBeCloseTo(insetH * 2, 6)
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
    // Only a:latin is set here (no a:ea), so with no a:ea present
    // resolveBodyFont must fall back to the a:latin typeface that IS there
    // rather than reporting the generic default. The "prefer a:ea over
    // a:latin when BOTH are present and the text is CJK" branch is covered
    // separately below.
    expect(segments[0].font.family).toBe('Microsoft YaHei')
  })

  it('prefers a:ea over a:latin for CJK text, and a:latin over a:ea for Latin text, when a run carries both typefaces', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              name: 'CJK Box',
              text: ['中文文本'],
              box: { xEmu: 0, yEmu: 0, wEmu: 3000 * EMU_PER_PT, hEmu: 1500 * EMU_PER_PT },
              fontFamily: 'Calibri',
              eaFontFamily: 'Microsoft YaHei'
            },
            {
              kind: 'textbox',
              name: 'Latin Box',
              text: ['English text'],
              box: {
                xEmu: 0,
                yEmu: 1600 * EMU_PER_PT,
                wEmu: 3000 * EMU_PER_PT,
                hEmu: 1500 * EMU_PER_PT
              },
              fontFamily: 'Calibri',
              eaFontFamily: 'Microsoft YaHei'
            }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    const cjk = segments.find((s) => s.text === '中文文本')!
    const latin = segments.find((s) => s.text === 'English text')!
    expect(cjk.font.family).toBe('Microsoft YaHei') // a:ea preferred for CJK text
    expect(latin.font.family).toBe('Calibri') // a:latin preferred for Latin text, even with a:ea also present
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

  it('an OLE object graphicFrame contributes zero segments (skip path) and logs one warning', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Real text'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
            },
            { kind: 'ole', box: { xEmu: 0, yEmu: 600, wEmu: 400, hEmu: 400 } }
          ]
        }
      ]
    })

    const segments = await new PptxAdapter().extract(srcPath)
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('Real text')
    expect(warnMessages).toHaveLength(1)
    expect(warnMessages[0]).toMatch(/OLE/)
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

describe('PptxAdapter.collectSkips', () => {
  it('returns the unsupported-content skips recorded during the most recent extract() call, as {id, reason}', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Real text'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
            },
            { kind: 'chart', box: { xEmu: 0, yEmu: 900, wEmu: 400, hEmu: 400 } }
          ]
        }
      ]
    })

    const adapter = new PptxAdapter()
    await adapter.extract(srcPath)

    const skips = adapter.collectSkips!()
    expect(skips).toHaveLength(1)
    expect(skips[0].id).toContain('slide1')
    expect(skips[0].reason).toMatch(/chart/)
  })

  it('an adapter that has extracted nothing skippable reports an empty list', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Nothing unsupported here'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
            }
          ]
        }
      ]
    })

    const adapter = new PptxAdapter()
    await adapter.extract(srcPath)
    expect(adapter.collectSkips!()).toEqual([])
  })

  it('apply() re-walking the same skip-bearing content does not re-log or re-count it (fix for logSkip double-firing across extract + apply)', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Real text'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
            },
            { kind: 'chart', box: { xEmu: 0, yEmu: 900, wEmu: 400, hEmu: 400 } }
          ]
        }
      ]
    })

    const adapter = new PptxAdapter()
    const segments = await adapter.extract(srcPath)
    expect(warnMessages).toHaveLength(1) // extract() logs the chart skip once
    expect(adapter.collectSkips!()).toHaveLength(1)

    const translated = segments.map((s) => makeTranslated(s, { translation: 'Translated' }))
    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, translated)

    // apply() re-walks the same deck internally (to relocate nodes to write
    // into) - the chart is "seen" again by that walk, but must not log or
    // record a second time: extract() already reported it once.
    expect(warnMessages).toHaveLength(1)
    expect(adapter.collectSkips!()).toHaveLength(1)
  })

  it('records an OLE object skip', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Real text'],
              box: { xEmu: 0, yEmu: 0, wEmu: 1000, hEmu: 500 }
            },
            { kind: 'ole', box: { xEmu: 0, yEmu: 900, wEmu: 400, hEmu: 400 } }
          ]
        }
      ]
    })

    const adapter = new PptxAdapter()
    await adapter.extract(srcPath)

    const skips = adapter.collectSkips!()
    expect(skips).toHaveLength(1)
    expect(skips[0].id).toContain('slide1')
    expect(skips[0].reason).toMatch(/OLE/)
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

  it('MORE translated lines than source paragraphs: first k lines map 1:1, the rest append to the last paragraph as a:br-separated runs (no new a:p)', async () => {
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
    // 3 lines vs 2 source paragraphs: k = 2, "Trois" is the overflow line.
    const translated = makeTranslated(seg, { translation: 'Un\nDeux\nTrois' })

    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const archive = await openPptx(outPath)
    const doc = archive.readXml(archive.listSlidePaths()[0])
    const paragraphs = elems(doc, A_NS, 'p')
    expect(paragraphs).toHaveLength(2) // no paragraph was added

    expect(elems(paragraphs[0], A_NS, 'r').map((r) => elems(r, A_NS, 't')[0].textContent)).toEqual([
      'Un'
    ])
    expect(elems(paragraphs[0], A_NS, 'br')).toHaveLength(0)

    const secondRuns = elems(paragraphs[1], A_NS, 'r')
    expect(secondRuns.map((r) => elems(r, A_NS, 't')[0].textContent)).toEqual(['Deux', 'Trois'])
    expect(elems(paragraphs[1], A_NS, 'br')).toHaveLength(1) // one real visual line break
    // The appended run's formatting matches the paragraph's original run (bold carried over).
    expect(elems(secondRuns[1], A_NS, 'rPr')[0]?.getAttribute('b')).toBe('1')

    // Round-trips back to the exact translation: a:br re-extracts as \n.
    const reExtracted = await adapter.extract(outPath)
    expect(reExtracted[0].text).toBe('Un\nDeux\nTrois')

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('FEWER translated lines than source paragraphs: first k lines map 1:1, the surplus paragraphs are deleted outright (no phantom blank lines)', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['One', 'Two', 'Three'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT }
            }
          ]
        }
      ]
    })
    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    // 1 line vs 3 source paragraphs: k = 1, paragraphs 2 and 3 are deleted.
    const translated = makeTranslated(seg, { translation: 'Uno' })

    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const archive = await openPptx(outPath)
    const doc = archive.readXml(archive.listSlidePaths()[0])
    const paragraphs = elems(doc, A_NS, 'p')
    expect(paragraphs).toHaveLength(1) // the 2 surplus paragraphs are gone, not just emptied
    expect(elems(paragraphs[0], A_NS, 't')[0].textContent).toBe('Uno')

    const reExtracted = await adapter.extract(outPath)
    expect(reExtracted[0].text).toBe('Uno') // no phantom blank lines from emptied-but-retained paragraphs

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('a:br within a paragraph re-extracts as \\n (extract/apply agree on what a "line" is)', async () => {
    // Build a plain 1-paragraph, 1-run textbox, then hand-insert an a:br +
    // a second run - simulating either a hand-authored deck with a manual
    // line break, or this adapter's own overflow-append output.
    const buffer = await buildPptx({
      slides: [
        {
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
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let xml = await zip.file(slidePath)!.async('string')
    const original = /<a:p>(<a:r>.*?<\/a:r>)<\/a:p>/
    expect(xml).toMatch(original)
    xml = xml.replace(original, '<a:p>$1<a:br/><a:r><a:t>World</a:t></a:r></a:p>')
    zip.file(slidePath, xml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const [seg] = await new PptxAdapter().extract(srcPath)
    expect(seg.text).toBe('Hello\nWorld')
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

  it('writes sz (hundredths, floored to the quarter point - never rounded up past the fitted size) on every non-empty run only when the fitted size differs, and resets a stale a:normAutofit to a bare one', async () => {
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
    // Simulates a deck PowerPoint had already autofit-shrunk the ORIGINAL
    // text at the ORIGINAL size - those scale numbers are meaningless for
    // the translated text/fitted size we're about to write, so they must
    // not survive into the output.
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
    // 13.4pt -> 1340 hundredths -> floored to the nearest 25 below -> 1325
    // (never 1350: rounding UP would write a size larger than what fit()
    // actually measured as fitting).
    expect(rPr.getAttribute('sz')).toBe('1325')
    const bodyPr = elems(doc, A_NS, 'bodyPr')[0]
    const normAutofit = elems(bodyPr, A_NS, 'normAutofit')
    expect(normAutofit).toHaveLength(1) // belt-and-suspenders: PowerPoint may still autofit further
    expect(normAutofit[0].hasAttribute('fontScale')).toBe(false) // stale scale numbers dropped, not carried forward
    expect(normAutofit[0].hasAttribute('lnSpcReduction')).toBe(false)
  })

  it('replaces a:spAutoFit with a bare a:normAutofit when writing a fitted size', async () => {
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
    xml = xml.replace('<a:bodyPr/>', '<a:bodyPr><a:spAutoFit/></a:bodyPr>')
    zip.file(slidePath, xml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    const translated = makeTranslated(seg, { translation: 'Bonjour', fittedSizePt: 13.4 })
    const outPath = path.join(dir, 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const archive = await openPptx(outPath)
    const doc = archive.readXml(slidePath)
    const bodyPr = elems(doc, A_NS, 'bodyPr')[0]
    expect(elems(bodyPr, A_NS, 'spAutoFit')).toHaveLength(0)
    expect(elems(bodyPr, A_NS, 'normAutofit')).toHaveLength(1)
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
    const bodyPr = elems(doc, A_NS, 'bodyPr')[0]
    expect(elems(bodyPr, A_NS, 'normAutofit')).toHaveLength(0) // bodyPr itself untouched for notes too
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

  it('SmartArt cached drawing: a run whose text matches no translated data point is left untouched and logs a warning, while matching runs still get translated', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'smartart',
              name: 'Cycle',
              box: { xEmu: 0, yEmu: 0, wEmu: 4000 * EMU_PER_PT, hEmu: 2000 * EMU_PER_PT },
              points: ['Only'],
              cachedDrawing: true
            }
          ]
        }
      ]
    })
    const zip = await JSZip.loadAsync(buffer)
    const drawingPath = 'ppt/diagrams/drawing1.xml'
    let drawingXml = await zip.file(drawingPath)!.async('string')
    // Inject a decorative shape the data model has no corresponding
    // translated point for (a legitimate drift between cache and data
    // model - e.g. a title/legend shape the cache renders but the data
    // model doesn't track as a dgm:pt).
    drawingXml = drawingXml.replace(
      '</dsp:spTree>',
      '<dsp:sp modelId="99"><dsp:nvSpPr><dsp:cNvPr id="99" name=""/><dsp:cNvSpPr/></dsp:nvSpPr>' +
        '<dsp:spPr/><dsp:txBody><a:bodyPr/><a:lstStyle/>' +
        '<a:p><a:r><a:t>Decorative Label</a:t></a:r></a:p></dsp:txBody></dsp:sp></dsp:spTree>'
    )
    zip.file(drawingPath, drawingXml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.text).toBe('Only')

    const translated = makeTranslated(seg, { translation: 'Seulement' })
    const outPath = path.join(dir, 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    expect(
      warnMessages.some(
        (m) => /has no matching translated data point/.test(m) && /Decorative Label/.test(m)
      )
    ).toBe(true)

    const outDrawingXml = await (
      await JSZip.loadAsync(await readFile(outPath))
    )
      .file(drawingPath)!
      .async('string')
    expect(outDrawingXml).toContain('<a:t>Seulement</a:t>') // matched run translated
    expect(outDrawingXml).toContain('<a:t>Decorative Label</a:t>') // unmatched run left untouched

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('SmartArt cached drawing: two data points sharing identical source text but DIFFERENT translations are left untouched in the cache and logged as ambiguous (no last-write-wins)', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'smartart',
              name: 'Cycle',
              box: { xEmu: 0, yEmu: 0, wEmu: 4000 * EMU_PER_PT, hEmu: 2000 * EMU_PER_PT },
              points: ['Same', 'Same'],
              cachedDrawing: true
            }
          ]
        }
      ]
    })

    const adapter = new PptxAdapter()
    const segments = await adapter.extract(srcPath)
    expect(segments).toHaveLength(2)
    expect(segments.every((s) => s.text === 'Same')).toBe(true)

    // Same source text, deliberately DIFFERENT translations - the exact
    // ambiguous scenario a naive last-write-wins map would mis-resolve.
    const translated = [
      makeTranslated(segments[0], { translation: 'First' }),
      makeTranslated(segments[1], { translation: 'Second' })
    ]
    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, translated)

    expect(warnMessages.some((m) => /ambiguous/.test(m) && /Same/.test(m))).toBe(true)

    // The DATA MODEL still gets each point's own distinct translation -
    // the ambiguity only affects the cached drawing's mirrored text.
    const reExtracted = await adapter.extract(outPath)
    expect(reExtracted.map((s) => s.text).sort()).toEqual(['First', 'Second'])

    // The cached drawing leaves BOTH mirrored runs untouched (still
    // "Same"), rather than guessing which translation applies to which.
    const outDrawingXml = await (
      await JSZip.loadAsync(await readFile(outPath))
    )
      .file('ppt/diagrams/drawing1.xml')!
      .async('string')
    const sameCount = (outDrawingXml.match(/<a:t>Same<\/a:t>/g) ?? []).length
    expect(sameCount).toBe(2)
    expect(outDrawingXml).not.toContain('<a:t>First</a:t>')
    expect(outDrawingXml).not.toContain('<a:t>Second</a:t>')

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
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

  it('a run-less middle paragraph (bare <a:p/>) gets a newly created run for its translated line instead of silently dropping it', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['One', 'Two', 'Three'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT }
            }
          ]
        }
      ]
    })
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let xml = await zip.file(slidePath)!.async('string')
    // Replace the MIDDLE paragraph ("Two", one run) with a bare, run-less
    // paragraph - the structurally-empty-spacer-line case real decks do
    // contain (e.g. <a:p/> or <a:p><a:endParaRPr/></a:p>).
    const twoParagraph = /<a:p><a:r><a:rPr[^>]*><\/a:rPr><a:t>Two<\/a:t><\/a:r><\/a:p>/
    expect(xml).toMatch(twoParagraph)
    xml = xml.replace(twoParagraph, '<a:p/>')
    zip.file(slidePath, xml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    // The run-less middle paragraph still contributes an empty line on extract.
    expect(seg.text).toBe('One\n\nThree')

    const translated = makeTranslated(seg, { translation: 'Un\nDeux\nTrois' })
    const outPath = path.join(dir, 'out.pptx')

    await expect(adapter.apply(srcPath, outPath, [translated])).resolves.toBeUndefined()

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)

    // The middle line is no longer silently dropped: it round-trips exactly.
    const reExtracted = await adapter.extract(outPath)
    expect(reExtracted[0].text).toBe('Un\nDeux\nTrois')

    const archive = await openPptx(outPath)
    const doc = archive.readXml(slidePath)
    const paragraphs = elems(doc, A_NS, 'p')
    expect(paragraphs).toHaveLength(3)
    const middleRuns = elems(paragraphs[1], A_NS, 'r')
    expect(middleRuns).toHaveLength(1) // a run was created where there was none
    expect(elems(middleRuns[0], A_NS, 't')[0].textContent).toBe('Deux')
  })

  it('a run-less paragraph carrying only a:endParaRPr clones it as the newly created run\'s a:rPr (the "would-be formatting")', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['One', 'Two'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT }
            }
          ]
        }
      ]
    })
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let xml = await zip.file(slidePath)!.async('string')
    const twoParagraph = /<a:p><a:r><a:rPr[^>]*><\/a:rPr><a:t>Two<\/a:t><\/a:r><\/a:p>/
    expect(xml).toMatch(twoParagraph)
    xml = xml.replace(twoParagraph, '<a:p><a:endParaRPr lang="en-US" b="1"/></a:p>')
    zip.file(slidePath, xml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.text).toBe('One\n')

    const translated = makeTranslated(seg, { translation: 'Un\nDeux' })
    const outPath = path.join(dir, 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)

    const archive = await openPptx(outPath)
    const doc = archive.readXml(slidePath)
    const paragraphs = elems(doc, A_NS, 'p')
    const runs = elems(paragraphs[1], A_NS, 'r')
    expect(runs).toHaveLength(1)
    expect(elems(runs[0], A_NS, 't')[0].textContent).toBe('Deux')
    expect(elems(runs[0], A_NS, 'rPr')[0]?.getAttribute('b')).toBe('1') // cloned from endParaRPr

    const reExtracted = await adapter.extract(outPath)
    expect(reExtracted[0].text).toBe('Un\nDeux')
  })

  it('a run-less paragraph carrying a:pPr gets its fabricated run inserted AFTER a:pPr (schema order pPr -> r -> endParaRPr), never before it', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['One', 'Two'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT }
            }
          ]
        }
      ]
    })
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let xml = await zip.file(slidePath)!.async('string')
    const twoParagraph = /<a:p><a:r><a:rPr[^>]*><\/a:rPr><a:t>Two<\/a:t><\/a:r><\/a:p>/
    expect(xml).toMatch(twoParagraph)
    // A run-less paragraph carrying BOTH paragraph properties (e.g. a
    // bullet/indent level) and end-paragraph run properties - the real
    // shape of a "spacer at list level 1" paragraph.
    xml = xml.replace(twoParagraph, '<a:p><a:pPr lvl="1"/><a:endParaRPr lang="en-US" b="1"/></a:p>')
    zip.file(slidePath, xml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.text).toBe('One\n')

    const translated = makeTranslated(seg, { translation: 'Un\nDeux' })
    const outPath = path.join(dir, 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)

    const archive = await openPptx(outPath)
    const doc = archive.readXml(slidePath)
    const paragraphs = elems(doc, A_NS, 'p')
    // CT_TextParagraph schema order: pPr?, (r|br|fld)*, endParaRPr? - the
    // fabricated run must land strictly between pPr and endParaRPr, never
    // before pPr (which would be schema-invalid child order).
    expect(directChildElementNames(paragraphs[1])).toEqual(['pPr', 'r', 'endParaRPr'])
    expect(elems(paragraphs[1], A_NS, 't')[0].textContent).toBe('Deux')
    expect(elems(paragraphs[1], A_NS, 'rPr')[0]?.getAttribute('b')).toBe('1') // still cloned from endParaRPr
    expect(elems(paragraphs[1], A_NS, 'pPr')[0]?.getAttribute('lvl')).toBe('1') // pPr itself untouched

    const reExtracted = await adapter.extract(outPath)
    expect(reExtracted[0].text).toBe('Un\nDeux')
  })

  it('a fld-only paragraph (auto-field placeholder) round-trips to exactly the translation - no duplicate run alongside the field', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Auto Date'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT },
              fldParagraphs: [0]
            }
          ]
        }
      ]
    })
    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.text).toBe('Auto Date')

    const translated = makeTranslated(seg, { translation: 'Date Automatique' })
    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)

    const archive = await openPptx(outPath)
    const doc = archive.readXml(archive.listSlidePaths()[0])
    const paragraph = elems(doc, A_NS, 'p')[0]
    // Exactly the original a:fld, rewritten in place - no sibling a:r
    // fabricated alongside it (the duplication bug).
    expect(elems(paragraph, A_NS, 'fld')).toHaveLength(1)
    expect(elems(paragraph, A_NS, 'r')).toHaveLength(0)
    expect(elems(paragraph, A_NS, 't')[0].textContent).toBe('Date Automatique')

    const reExtracted = await adapter.extract(outPath)
    expect(reExtracted[0].text).toBe('Date Automatique')
  })

  it('a mixed run+fld paragraph: the translated line writes into the first carrier, the other carrier is emptied (not duplicated)', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Placeholder'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT }
            }
          ]
        }
      ]
    })
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let xml = await zip.file(slidePath)!.async('string')
    const original = /<a:p><a:r><a:rPr[^>]*><\/a:rPr><a:t>Placeholder<\/a:t><\/a:r><\/a:p>/
    expect(xml).toMatch(original)
    // A "Page " run followed by a slide-number field on the SAME line - the
    // classic mixed run+fld paragraph a real deck's footer/header carries.
    xml = xml.replace(
      original,
      '<a:p><a:r><a:t>Page </a:t></a:r>' +
        '<a:fld id="{6E4B2C10-0000-0000-0000-000000000099}" type="slidenum"><a:t>1</a:t></a:fld></a:p>'
    )
    zip.file(slidePath, xml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.text).toBe('Page 1') // run + fld text concatenated, no separator

    const translated = makeTranslated(seg, { translation: 'Page Un' })
    const outPath = path.join(dir, 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)

    const archive = await openPptx(outPath)
    const doc = archive.readXml(slidePath)
    const paragraph = elems(doc, A_NS, 'p')[0]
    const run = elems(paragraph, A_NS, 'r')[0]
    const fld = elems(paragraph, A_NS, 'fld')[0]
    expect(elems(run, A_NS, 't')[0].textContent).toBe('Page Un') // first carrier gets the whole line
    expect(elems(fld, A_NS, 't')[0].textContent).toBe('') // second carrier emptied, not left duplicated

    const reExtracted = await adapter.extract(outPath)
    expect(reExtracted[0].text).toBe('Page Un') // no duplication in the round trip
  })

  it('a:br apply symmetry: a paragraph with an existing a:br consumes one translated line per br-group, not per-paragraph (no phantom blank line)', async () => {
    const buffer = await buildPptx({
      slides: [
        {
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
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let xml = await zip.file(slidePath)!.async('string')
    const original = /<a:p>(<a:r>.*?<\/a:r>)<\/a:p>/
    expect(xml).toMatch(original)
    xml = xml.replace(original, '<a:p>$1<a:br/><a:r><a:t>World</a:t></a:r></a:p>')
    zip.file(slidePath, xml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.text).toBe('Hello\nWorld')

    const translated = makeTranslated(seg, { translation: 'Bonjour\nMonde' })
    const outPath = path.join(dir, 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)

    // Exact match - a naive per-paragraph writer would append a SECOND a:br
    // on top of the existing one, producing "Bonjour\n\nMonde".
    const reExtracted = await adapter.extract(outPath)
    expect(reExtracted[0].text).toBe('Bonjour\nMonde')

    const archive = await openPptx(outPath)
    const doc = archive.readXml(slidePath)
    const paragraphs = elems(doc, A_NS, 'p')
    expect(paragraphs).toHaveLength(1)
    expect(elems(paragraphs[0], A_NS, 'br')).toHaveLength(1) // still exactly one break, not two
    const runs = elems(paragraphs[0], A_NS, 'r')
    expect(runs.map((r) => elems(r, A_NS, 't')[0].textContent)).toEqual(['Bonjour', 'Monde'])
  })

  it('a:br apply symmetry, fewer lines than br-capacity: the surplus br and its run are removed, not left as a phantom blank line', async () => {
    const buffer = await buildPptx({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['A'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT }
            }
          ]
        }
      ]
    })
    const zip = await JSZip.loadAsync(buffer)
    const slidePath = 'ppt/slides/slide1.xml'
    let xml = await zip.file(slidePath)!.async('string')
    const original = /<a:p>(<a:r>.*?<\/a:r>)<\/a:p>/
    expect(xml).toMatch(original)
    // 3 br-groups in one paragraph: "A", "B", "C".
    xml = xml.replace(
      original,
      '<a:p>$1<a:br/><a:r><a:t>B</a:t></a:r><a:br/><a:r><a:t>C</a:t></a:r></a:p>'
    )
    zip.file(slidePath, xml)
    const patchedBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const dir = await tmpDir('lt-pptx-adapter-')
    const srcPath = path.join(dir, 'src.pptx')
    await writeFile(srcPath, patchedBuffer)

    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.text).toBe('A\nB\nC')

    // Only 2 lines for a 3-line-capacity paragraph: the 3rd br-group is surplus.
    const translated = makeTranslated(seg, { translation: 'X\nY' })
    const outPath = path.join(dir, 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)

    const reExtracted = await adapter.extract(outPath)
    expect(reExtracted[0].text).toBe('X\nY') // no phantom blank line from a leftover br

    const archive = await openPptx(outPath)
    const doc = archive.readXml(slidePath)
    const paragraphs = elems(doc, A_NS, 'p')
    expect(paragraphs).toHaveLength(1)
    expect(elems(paragraphs[0], A_NS, 'br')).toHaveLength(1) // the surplus br was removed
    const runs = elems(paragraphs[0], A_NS, 'r')
    expect(runs.map((r) => elems(r, A_NS, 't')[0].textContent)).toEqual(['X', 'Y'])
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

  it('OLE object graphicFrame (skip path): a slide containing only an OLE object is extracted as zero segments, reported by collectSkips, and left byte-identical by apply', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [{ kind: 'ole', box: { xEmu: 0, yEmu: 0, wEmu: 800, hEmu: 800 } }]
        }
      ]
    })

    const srcBuffer = await readFile(srcPath)
    const srcDigests = await digestParts(srcBuffer)

    const adapter = new PptxAdapter()
    const segments = await adapter.extract(srcPath)
    expect(segments).toHaveLength(0)
    expect(adapter.collectSkips!()).toHaveLength(1)
    expect(adapter.collectSkips!()[0].reason).toMatch(/OLE/)

    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, [])

    const outBuffer = await readFile(outPath)
    const outDigests = await digestParts(outBuffer)
    expect(outDigests.get('ppt/slides/slide1.xml')).toBe(srcDigests.get('ppt/slides/slide1.xml'))

    const integrity = await checkPptxIntegrity(outBuffer)
    expect(integrity.ok).toBe(true)
  })

  it('a placeholder shape resolving to box: null (SENTINEL_BOX) has its font size preserved verbatim through apply, even as its text changes', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [{ kind: 'placeholder', phType: 'body', text: ['Unplaced body text'] }]
        }
      ]
    })
    const adapter = new PptxAdapter()
    const [seg] = await adapter.extract(srcPath)
    expect(seg.box.wPt).toBeGreaterThan(100_000) // SENTINEL_BOX (see the dedicated extract-level test above)
    expect(seg.font.sizePt).toBe(18) // PLACEHOLDER_DEFAULT_FONT_PT['body']

    // SENTINEL_BOX guarantees fit() never needs to shrink from the starting
    // size, so fittedSizePt === font.sizePt here is exactly what the real
    // pipeline would hand back for this segment, not a test-only shortcut.
    const translated = makeTranslated(seg, { translation: 'Texte de corps non place' })
    const outPath = path.join(path.dirname(srcPath), 'out.pptx')
    await adapter.apply(srcPath, outPath, [translated])

    const archive = await openPptx(outPath)
    const doc = archive.readXml(archive.listSlidePaths()[0])
    const run = elems(doc, A_NS, 'r')[0]
    expect(elems(run, A_NS, 't')[0].textContent).toBe('Texte de corps non place')
    // Verbatim: no sz attribute written at all - matches the "never touches
    // sz when the fitted size equals the segment font size" convention
    // exercised elsewhere for a normal (non-sentinel) box.
    expect(elems(run, A_NS, 'rPr')[0].hasAttribute('sz')).toBe(false)
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

  it('SmartArt with a cached dsp:drawing part: apply() keeps BOTH the data model and the cached drawing in sync with the translation', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'smartart',
              name: 'Cycle',
              box: { xEmu: 0, yEmu: 0, wEmu: 4000 * EMU_PER_PT, hEmu: 2000 * EMU_PER_PT },
              points: ['Plan', 'Do', 'Check', 'Act'],
              cachedDrawing: true
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
    // No mismatch warnings: the builder's cached drawing mirrors the data
    // part's text exactly, so every drawing run should find its match.
    expect(warnMessages.some((m) => /has no matching translated data point/.test(m))).toBe(false)

    const outDigests = await digestParts(await readFile(outPath))
    const dataPart = [...srcDigests.keys()].find((p) => p.startsWith('ppt/diagrams/data'))!
    const drawingPart = [...srcDigests.keys()].find((p) => p.startsWith('ppt/diagrams/drawing'))!
    expect(drawingPart).toBeDefined()
    expect(outDigests.get(dataPart)).not.toBe(srcDigests.get(dataPart))
    // The cached drawing part DID change too - both parts carry the translation.
    expect(outDigests.get(drawingPart)).not.toBe(srcDigests.get(drawingPart))

    const outZip = await JSZip.loadAsync(await readFile(outPath))
    const drawingXml = await outZip.file(drawingPart)!.async('string')
    for (const orig of originalSegments) {
      expect(drawingXml).toContain(`<a:t>${mockTranslate(orig.text)}</a:t>`)
      expect(drawingXml).not.toContain(`<a:t>${orig.text}</a:t>`)
    }

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('count-changing translator, MORE lines: a multi-paragraph textbox round-trips exactly even when every translation gains a line', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Paragraph one.', 'Paragraph two.'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT }
            }
          ]
        }
      ]
    })

    const { outPath, originalSegments, reExtracted } = await roundTrip(srcPath, addLineTranslate)
    expect(originalSegments).toHaveLength(1)
    const reById = byId(reExtracted)
    for (const orig of originalSegments) {
      // Exact match - not just "contains the text somewhere" - proves the
      // a:br-appended overflow line re-extracts as \n, matching exactly
      // what was applied.
      expect(reById.get(orig.id)!.text).toBe(addLineTranslate(orig.text))
    }

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })

  it('count-changing translator, FEWER lines: a multi-paragraph textbox round-trips exactly even when every translation loses a line', async () => {
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Paragraph one.', 'Paragraph two.', 'Paragraph three.'],
              box: { xEmu: 0, yEmu: 0, wEmu: 5000 * EMU_PER_PT, hEmu: 3000 * EMU_PER_PT }
            }
          ]
        }
      ]
    })

    const { outPath, originalSegments, reExtracted } = await roundTrip(srcPath, dropLineTranslate)
    expect(originalSegments).toHaveLength(1)
    const reById = byId(reExtracted)
    for (const orig of originalSegments) {
      // Exact match - proves the deleted surplus paragraph doesn't leave a
      // phantom blank line (which would show up here as an extra trailing \n).
      expect(reById.get(orig.id)!.text).toBe(dropLineTranslate(orig.text))
    }

    const integrity = await checkPptxIntegrity(await readFile(outPath))
    expect(integrity.ok).toBe(true)
  })
})

/**
 * Embedded-media (pptx picture) translation via media re-embedding - Phase
 * 3 Task 5. Every describe block below is named after one of the plan's 7
 * behavior-contract points (see docs/superpowers/plans/2026-07-31-phase-3-
 * image-text.md, "Task 5: pptx embedded-media hookup"). All engine-mocked,
 * builder decks, no model loads.
 */
const PIC_BOX = { xEmu: 0, yEmu: 0, wEmu: 200 * EMU_PER_PT, hEmu: 100 * EMU_PER_PT }

describe('embedded media - dedup by part path (behavior contract point 1)', () => {
  it('a media part used on 3 slides is detected once and produces exactly one segment', async () => {
    const png = await makePngBytes(200, 100, '#ffffff')
    const engine = fakeMediaEngine([
      {
        bytes: png,
        regions: [rawMediaRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Hello' })]
      }
    ])
    const srcPath = await writeDeck({
      slides: [
        { shapes: [{ kind: 'picture', box: PIC_BOX, mediaBytes: png, sharedMediaKey: 'shared' }] },
        { shapes: [{ kind: 'picture', box: PIC_BOX, sharedMediaKey: 'shared' }] },
        { shapes: [{ kind: 'picture', box: PIC_BOX, sharedMediaKey: 'shared' }] }
      ]
    })

    const adapter = new PptxAdapter({ regionEngine: engine, sourceLang: 'English' })
    const segments = await adapter.extract(srcPath)
    const imageSegs = segments.filter((s) => s.kind === 'image-region')

    expect(imageSegs).toHaveLength(1)
    expect(engine.detectRegions).toHaveBeenCalledTimes(1)
  })

  it('translated once, rewritten once: the deck ends up with exactly one changed media part, still valid', async () => {
    const png = await makePngBytes(200, 100, '#ffffff')
    const engine = fakeMediaEngine([
      {
        bytes: png,
        regions: [rawMediaRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Hello' })]
      }
    ])
    const srcPath = await writeDeck({
      slides: [
        { shapes: [{ kind: 'picture', box: PIC_BOX, mediaBytes: png, sharedMediaKey: 'shared' }] },
        { shapes: [{ kind: 'picture', box: PIC_BOX, sharedMediaKey: 'shared' }] },
        { shapes: [{ kind: 'picture', box: PIC_BOX, sharedMediaKey: 'shared' }] }
      ]
    })
    const srcDigests = await digestParts(await readFile(srcPath))

    const adapter = new PptxAdapter({ regionEngine: engine, sourceLang: 'English' })
    const report = await runPipeline({
      file: srcPath,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend: translateBackend(mockTranslate)
    })

    const outBuffer = await readFile(report.outPath)
    const outDigests = await digestParts(outBuffer)
    const mediaParts = [...outDigests.keys()].filter((p) => p.startsWith('ppt/media/'))
    expect(mediaParts).toHaveLength(1) // one part in the deck to begin with, still one - dedup shares it
    expect(outDigests.get(mediaParts[0])).not.toBe(srcDigests.get(mediaParts[0]))

    const integrity = await checkPptxIntegrity(outBuffer)
    expect(integrity.ok).toBe(true)
  })
})

describe('embedded media - id/groupKey/context (behavior contract point 2)', () => {
  it('ids are namespaced media/<basename>#r<n>, globally unique against text-site ids by construction', async () => {
    const png = await makePngBytes(200, 100, '#ffffff')
    const engine = fakeMediaEngine([
      {
        bytes: png,
        regions: [rawMediaRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Hello' })]
      }
    ])
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Real text'],
              box: { xEmu: 0, yEmu: 0, wEmu: 3000 * EMU_PER_PT, hEmu: 1500 * EMU_PER_PT }
            },
            { kind: 'picture', box: PIC_BOX, mediaBytes: png }
          ]
        }
      ]
    })

    const adapter = new PptxAdapter({ regionEngine: engine, sourceLang: 'English' })
    const segments = await adapter.extract(srcPath)

    expect(new Set(segments.map((s) => s.id)).size).toBe(segments.length) // no id collisions at all
    const mediaSeg = segments.find((s) => s.kind === 'image-region')!
    expect(mediaSeg.id).toMatch(/^media\/image\d+\.png#r1$/)
    expect(mediaSeg.context).toBe('embedded image text')
  })

  it('groupKey is the FIRST slide that uses the part, not a later slide sharing it', async () => {
    const png = await makePngBytes(200, 100, '#ffffff')
    const engine = fakeMediaEngine([
      {
        bytes: png,
        regions: [rawMediaRegion({ bbox: { x: 20, y: 20, w: 100, h: 30 }, text: 'Hello' })]
      }
    ])
    const srcPath = await writeDeck({
      slides: [
        { shapes: [{ kind: 'textbox', text: ['Slide one text'], box: PIC_BOX }] }, // no picture here
        { shapes: [{ kind: 'picture', box: PIC_BOX, mediaBytes: png, sharedMediaKey: 'shared' }] }, // first usage
        { shapes: [{ kind: 'picture', box: PIC_BOX, sharedMediaKey: 'shared' }] } // second usage, later slide
      ]
    })

    const adapter = new PptxAdapter({ regionEngine: engine, sourceLang: 'English' })
    const segments = await adapter.extract(srcPath)
    const mediaSeg = segments.find((s) => s.kind === 'image-region')!

    expect(mediaSeg.groupKey).toBe('slide2') // the first slide that uses the shared part, not slide3
  })
})

describe('embedded media - raster filter (behavior contract point 3)', () => {
  it('png/jpg parts are processed (produce segments)', async () => {
    const png = await makePngBytes(150, 80, '#ffffff')
    const jpeg = await makeJpegBytes(150, 80, '#ffffff')
    const engine = fakeMediaEngine([
      {
        bytes: png,
        regions: [rawMediaRegion({ bbox: { x: 10, y: 10, w: 80, h: 20 }, text: 'PngText' })]
      },
      {
        bytes: jpeg,
        regions: [rawMediaRegion({ bbox: { x: 10, y: 10, w: 80, h: 20 }, text: 'JpgText' })]
      }
    ])
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            { kind: 'picture', box: PIC_BOX, mediaBytes: png, mediaExt: 'png' },
            { kind: 'picture', box: PIC_BOX, mediaBytes: jpeg, mediaExt: 'jpg' }
          ]
        }
      ]
    })

    const adapter = new PptxAdapter({ regionEngine: engine, sourceLang: 'English' })
    const segments = await adapter.extract(srcPath)
    const mediaTexts = segments.filter((s) => s.kind === 'image-region').map((s) => s.text)

    expect(mediaTexts.sort()).toEqual(['JpgText', 'PngText'])
    expect(adapter.collectSkips!()).toEqual([])
  })

  it('emf/wmf parts are never decoded and are reported as "vector metafile image", not processed', async () => {
    const engine = fakeMediaEngine([]) // must never be asked to detect on the emf bytes
    const garbageMetafile = Buffer.from('not a real EMF, but that is exactly the point')
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [{ kind: 'picture', box: PIC_BOX, mediaBytes: garbageMetafile, mediaExt: 'emf' }]
        }
      ]
    })

    const adapter = new PptxAdapter({ regionEngine: engine, sourceLang: 'English' })
    const segments = await adapter.extract(srcPath)

    expect(segments.filter((s) => s.kind === 'image-region')).toEqual([])
    const skips = adapter.collectSkips!()
    expect(skips).toHaveLength(1)
    expect(skips[0].reason).toBe('vector metafile image')
    expect(skips[0].id).toMatch(/\.emf$/)
    expect(engine.detectRegions).not.toHaveBeenCalled() // never attempted to decode garbage bytes as an image
  })
})

describe('embedded media - regionEngine null is exactly Phase 2 behavior (behavior contract point 4)', () => {
  it('zero image segments, zero media rewrites, and no skips added for media', async () => {
    const png = await makePngBytes(150, 80, '#ffffff')
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['Real text'],
              box: { xEmu: 0, yEmu: 0, wEmu: 3000 * EMU_PER_PT, hEmu: 1500 * EMU_PER_PT }
            },
            { kind: 'picture', box: PIC_BOX, mediaBytes: png }
          ]
        }
      ]
    })
    const srcDigests = await digestParts(await readFile(srcPath))

    // Both the default (no-arg) construction and an explicit null engine
    // must behave identically - the default IS { regionEngine: null, ... }.
    for (const adapter of [
      new PptxAdapter(),
      new PptxAdapter({ regionEngine: null, sourceLang: 'English' })
    ]) {
      const segments = await adapter.extract(srcPath)
      expect(segments.filter((s) => s.kind === 'image-region')).toEqual([])
      expect(adapter.collectSkips!()).toEqual([]) // no "vector metafile image" or any other media skip

      const outPath = path.join(
        path.dirname(srcPath),
        `out-${Math.random().toString(36).slice(2)}.pptx`
      )
      await adapter.apply(srcPath, outPath, [])
      const outDigests = await digestParts(await readFile(outPath))
      const mediaPart = [...srcDigests.keys()].find((p) => p.startsWith('ppt/media/'))!
      expect(outDigests.get(mediaPart)).toBe(srcDigests.get(mediaPart)) // never rewritten
    }
  })
})

describe('embedded media - apply() rewrites only painted media parts; everything else stays lossless (behavior contract point 5)', () => {
  it('a gated-out (non-CJK under CJK source) media part and every other part stay byte-identical; only the painted part changes', async () => {
    const paintedPng = await makePngBytes(150, 80, '#ffffff')
    const gatedPng = await makePngBytes(120, 60, '#000000')
    const engine = fakeMediaEngine([
      {
        bytes: paintedPng,
        regions: [rawMediaRegion({ bbox: { x: 10, y: 10, w: 60, h: 20 }, text: '你好世界' })]
      },
      {
        bytes: gatedPng,
        regions: [rawMediaRegion({ bbox: { x: 10, y: 10, w: 60, h: 20 }, text: 'Model X200' })] // pure-latin, gated out under a CJK source
      }
    ])
    const srcPath = await writeDeck({
      slides: [
        {
          shapes: [
            {
              kind: 'textbox',
              text: ['这是标题文本'],
              box: { xEmu: 0, yEmu: 0, wEmu: 3000 * EMU_PER_PT, hEmu: 1500 * EMU_PER_PT }
            },
            { kind: 'picture', box: PIC_BOX, mediaBytes: paintedPng, name: 'Painted' },
            { kind: 'picture', box: PIC_BOX, mediaBytes: gatedPng, name: 'Gated' }
          ]
        }
      ]
    })
    const srcDigests = await digestParts(await readFile(srcPath))

    const adapter = new PptxAdapter({ regionEngine: engine, sourceLang: 'Chinese (Simplified)' })
    const report = await runPipeline({
      file: srcPath,
      sourceLang: 'Chinese (Simplified)',
      targetLang: 'English',
      model: 'test-model',
      adapter,
      backend: translateBackend(mockTranslate)
    })

    const outBuffer = await readFile(report.outPath)
    const outDigests = await digestParts(outBuffer)
    const mediaParts = [...srcDigests.keys()].filter((p) => p.startsWith('ppt/media/'))
    expect(mediaParts).toHaveLength(2)

    let changedCount = 0
    for (const part of mediaParts) {
      if (outDigests.get(part) !== srcDigests.get(part)) changedCount++
    }
    expect(changedCount).toBe(1) // only the CJK (painted) region's media part changed

    // Every part OTHER than the painted media part and the slide xml (which
    // legitimately changed due to the translated textbox) stays byte-identical.
    for (const [part, digest] of srcDigests) {
      if (part.startsWith('ppt/media/')) continue
      if (part === 'ppt/slides/slide1.xml') continue
      expect(outDigests.get(part)).toBe(digest)
    }

    const integrity = await checkPptxIntegrity(outBuffer)
    expect(integrity.ok).toBe(true)
  })

  it('translating an embedded image never touches the slide XML that displays it (picture-only slide)', async () => {
    const png = await makePngBytes(150, 80, '#ffffff')
    const engine = fakeMediaEngine([
      {
        bytes: png,
        regions: [rawMediaRegion({ bbox: { x: 10, y: 10, w: 60, h: 20 }, text: 'Hello' })]
      }
    ])
    const srcPath = await writeDeck({
      slides: [{ shapes: [{ kind: 'picture', box: PIC_BOX, mediaBytes: png }] }]
    })
    const srcDigests = await digestParts(await readFile(srcPath))

    const adapter = new PptxAdapter({ regionEngine: engine, sourceLang: 'English' })
    const report = await runPipeline({
      file: srcPath,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend: translateBackend(mockTranslate)
    })

    const outDigests = await digestParts(await readFile(report.outPath))
    expect(outDigests.get('ppt/slides/slide1.xml')).toBe(srcDigests.get('ppt/slides/slide1.xml'))
    const mediaPart = [...srcDigests.keys()].find((p) => p.startsWith('ppt/media/'))!
    expect(outDigests.get(mediaPart)).not.toBe(srcDigests.get(mediaPart))
  })
})

describe('embedded media - rewritten parts keep their original format (behavior contract point 6)', () => {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const JPEG_MAGIC = Buffer.from([0xff, 0xd8])

  it.each([
    { label: 'png', make: () => makePngBytes(150, 80, '#ffffff'), ext: 'png', magic: PNG_MAGIC },
    { label: 'jpg', make: () => makeJpegBytes(150, 80, '#ffffff'), ext: 'jpg', magic: JPEG_MAGIC }
  ])(
    'a rewritten $label media part still starts with $label magic bytes',
    async ({ make, ext, magic }) => {
      const bytes = await make()
      const engine = fakeMediaEngine([
        {
          bytes,
          regions: [rawMediaRegion({ bbox: { x: 10, y: 10, w: 60, h: 20 }, text: 'Hello' })]
        }
      ])
      const srcPath = await writeDeck({
        slides: [{ shapes: [{ kind: 'picture', box: PIC_BOX, mediaBytes: bytes, mediaExt: ext }] }]
      })

      const adapter = new PptxAdapter({ regionEngine: engine, sourceLang: 'English' })
      const report = await runPipeline({
        file: srcPath,
        sourceLang: 'English',
        targetLang: 'French',
        model: 'test-model',
        adapter,
        backend: translateBackend(mockTranslate)
      })

      const outZip = await JSZip.loadAsync(await readFile(report.outPath))
      const mediaEntry = Object.keys(outZip.files).find((p) => /^ppt\/media\/[^/]+$/.test(p))!
      const outBytes = await outZip.file(mediaEntry)!.async('nodebuffer')
      expect(outBytes.subarray(0, magic.length).equals(magic)).toBe(true)
    }
  )
})

describe('embedded media - confidence/rotated gating mirrors image-adapter.ts (behavior contract point 7)', () => {
  it('a low-confidence media region is skipped with reason "low-confidence region", no segment', async () => {
    const png = await makePngBytes(150, 80, '#ffffff')
    const engine = fakeMediaEngine([
      {
        bytes: png,
        regions: [
          rawMediaRegion({
            bbox: { x: 10, y: 10, w: 60, h: 20 },
            text: 'Hello',
            confidence: CONFIDENCE_FLOOR - 0.1
          })
        ]
      }
    ])
    const srcPath = await writeDeck({
      slides: [{ shapes: [{ kind: 'picture', box: PIC_BOX, mediaBytes: png }] }]
    })

    const adapter = new PptxAdapter({ regionEngine: engine, sourceLang: 'English' })
    const segments = await adapter.extract(srcPath)

    expect(segments.filter((s) => s.kind === 'image-region')).toEqual([])
    const skips = adapter.collectSkips!()
    expect(skips).toHaveLength(1)
    expect(skips[0].reason).toBe('low-confidence region')
  })

  it('a rotated media region is skipped with reason "rotated region", no segment', async () => {
    const png = await makePngBytes(150, 80, '#ffffff')
    const engine = fakeMediaEngine([
      {
        bytes: png,
        regions: [
          rawMediaRegion({ bbox: { x: 10, y: 10, w: 60, h: 20 }, text: 'Hello', rotated: true })
        ]
      }
    ])
    const srcPath = await writeDeck({
      slides: [{ shapes: [{ kind: 'picture', box: PIC_BOX, mediaBytes: png }] }]
    })

    const adapter = new PptxAdapter({ regionEngine: engine, sourceLang: 'English' })
    const segments = await adapter.extract(srcPath)

    expect(segments.filter((s) => s.kind === 'image-region')).toEqual([])
    const skips = adapter.collectSkips!()
    expect(skips).toHaveLength(1)
    expect(skips[0].reason).toBe('rotated region')
  })
})

describe('embedded media - gating parity with image-adapter.ts (behavior contract point 7)', () => {
  it('pptx-adapter.ts and image-adapter.ts both import isSourceLanguageRegion from the single gating.ts module (no copy-paste divergence)', () => {
    const pptxAdapterPath = path.resolve(
      __dirname,
      '../../../src/core/adapters/pptx/pptx-adapter.ts'
    )
    const imageAdapterPath = path.resolve(
      __dirname,
      '../../../src/core/adapters/images/image-adapter.ts'
    )
    const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g

    function resolveGatingImport(filePath: string): string | null {
      const src = readFileSync(filePath, 'utf8')
      let m: RegExpExecArray | null
      importRe.lastIndex = 0
      while ((m = importRe.exec(src))) {
        const names = m[1]
        const specifier = m[2]
        if (/\bisSourceLanguageRegion\b/.test(names)) {
          return path.resolve(path.dirname(filePath), `${specifier}.ts`)
        }
      }
      return null
    }

    const pptxGatingPath = resolveGatingImport(pptxAdapterPath)
    const imageGatingPath = resolveGatingImport(imageAdapterPath)

    expect(pptxGatingPath).not.toBeNull()
    expect(imageGatingPath).not.toBeNull()
    expect(pptxGatingPath).toBe(imageGatingPath)
    expect(pptxGatingPath).toBe(path.resolve(__dirname, '../../../src/core/images/gating.ts'))
  })

  it('behavioral parity: pptx-adapter and image-adapter make the IDENTICAL accept/reject decision for the same {sourceLang, text} region across a matrix of cases', async () => {
    const cases: { sourceLang: string; text: string; expectKept: boolean }[] = [
      { sourceLang: 'Chinese (Simplified)', text: '你好世界的问候语', expectKept: true },
      { sourceLang: 'Chinese (Simplified)', text: 'Model X200', expectKept: false },
      { sourceLang: 'English', text: '你好世界的问候语', expectKept: true }, // v1: non-CJK source doesn't filter
      { sourceLang: 'English', text: 'Model X200', expectKept: true }
    ]

    for (const { sourceLang, text, expectKept } of cases) {
      const png = await makePngBytes(150, 80, '#ffffff')
      const region = rawMediaRegion({ bbox: { x: 10, y: 10, w: 100, h: 20 }, text })
      const engine = fakeMediaEngine([{ bytes: png, regions: [region] }])

      const srcPath = await writeDeck({
        slides: [{ shapes: [{ kind: 'picture', box: PIC_BOX, mediaBytes: png }] }]
      })
      const pptxAdapter = new PptxAdapter({ regionEngine: engine, sourceLang })
      const pptxSegments = await pptxAdapter.extract(srcPath)
      const pptxKept = pptxSegments.some((s) => s.kind === 'image-region')

      const { createImageAdapter } = await import('../../../src/core/adapters/images/image-adapter')
      const imgFile = await writeStandaloneImage(png)
      const imageAdapter = createImageAdapter(engine, { sourceLang })
      const imageSegments = await imageAdapter.extract(imgFile)
      const imageKept = imageSegments.length > 0

      expect(pptxKept).toBe(expectKept)
      expect(imageKept).toBe(expectKept)
      expect(pptxKept).toBe(imageKept) // the parity assertion itself
    }
  })
})
