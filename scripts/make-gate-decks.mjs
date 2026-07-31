// Builds the Phase 2 live-gate fixture decks under fixtures/gate-decks/, using
// the SAME programmatic builder the test suite uses (tests/helpers/build-pptx.ts)
// so every fixture here is guaranteed structurally valid the same way the unit
// tests already prove that builder to be. These are hand-authored, targeted
// decks for a HUMAN gate reviewer (open in real PowerPoint, run through the CLI,
// eyeball the result) - not test fixtures consumed by vitest.
//
// Run: npx tsx scripts/make-gate-decks.mjs
//
// Outputs (gitignored - regenerate any time, never commit the .pptx files,
// only this script):
//   fixtures/gate-decks/scaled-group.pptx - text inside a 2x and a 0.5x
//     scaled group, for the empirical font-scale check at the gate.
//   fixtures/gate-decks/tables.pptx       - margin-heavy 3x3 table with a
//     merge, for the table-cell-margin fix (finding 4).
//   fixtures/gate-decks/breaks.pptx       - a manual a:br mid-paragraph plus
//     a run-less spacer paragraph, for the line-writing fixes (findings 1-2).
//   fixtures/gate-decks/smartart.pptx     - a SmartArt diagram with a cached
//     dsp:drawing part, for the SmartArt cache rewrite (finding 5).
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { buildPptx } from '../tests/helpers/build-pptx'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'fixtures', 'gate-decks')
mkdirSync(outDir, { recursive: true })

const EMU_PER_PT = 12700
const pt = (n) => n * EMU_PER_PT

async function write(name, buffer) {
  const outPath = path.join(outDir, name)
  writeFileSync(outPath, buffer)
  process.stdout.write(
    `[gate-decks] wrote ${path.relative(root, outPath)} (${buffer.length} bytes)\n`
  )
}

// ---- scaled-group.pptx ----
// One group scaled 2x (chExt half of ext) and one scaled 0.5x (chExt double
// ext), each holding a plain textbox at the SAME nominal font size - so the
// gate reviewer can visually confirm the rendered text is genuinely bigger
// in the 2x group and smaller in the 0.5x group, both before and after
// translation (the group-scale font math is geometry.ts's resolveFontPt).
async function buildScaledGroup() {
  return buildPptx({
    slides: [
      {
        shapes: [
          {
            kind: 'group',
            name: 'Scaled 2x Group',
            box: { xEmu: pt(50), yEmu: pt(50), wEmu: pt(400), hEmu: pt(150) },
            chOff: { xEmu: 0, yEmu: 0 },
            chExt: { wEmu: pt(200), hEmu: pt(75) },
            children: [
              {
                kind: 'textbox',
                name: 'Scaled 2x Text',
                text: [
                  'This text sits inside a group scaled 2x.',
                  'It should render noticeably larger.'
                ],
                box: { xEmu: 0, yEmu: 0, wEmu: pt(200), hEmu: pt(75) },
                fontPt: 18
              }
            ]
          },
          {
            kind: 'group',
            name: 'Scaled 0.5x Group',
            box: { xEmu: pt(50), yEmu: pt(230), wEmu: pt(200), hEmu: pt(75) },
            chOff: { xEmu: 0, yEmu: 0 },
            chExt: { wEmu: pt(400), hEmu: pt(150) },
            children: [
              {
                kind: 'textbox',
                name: 'Scaled 0.5x Text',
                text: [
                  'This text sits inside a group scaled 0.5x.',
                  'It should render noticeably smaller.'
                ],
                box: { xEmu: 0, yEmu: 0, wEmu: pt(400), hEmu: pt(150) },
                fontPt: 18
              }
            ]
          }
        ]
      }
    ]
  })
}

// ---- tables.pptx ----
// 3x3 table, one 2x2 merge, and deliberately non-default a:tcPr margins on
// both the merge anchor and a plain cell - the visual proof that finding
// 4's margin subtraction (not just the raw gridCol/tr box) drives text fit.
async function buildTables() {
  return buildPptx({
    slides: [
      {
        shapes: [
          {
            kind: 'table',
            name: 'Margin-Heavy Table',
            box: { xEmu: pt(50), yEmu: pt(50), wEmu: pt(600), hEmu: pt(300) },
            colWidthsEmu: [pt(200), pt(200), pt(200)],
            rowHeightsEmu: [pt(100), pt(100), pt(100)],
            rows: [
              [
                {
                  text: 'Merged header cell with wide margins on all sides',
                  gridSpan: 2,
                  marginsEmu: { l: pt(20), r: pt(20), t: pt(10), b: pt(10) }
                },
                { text: '', hMerge: true },
                { text: 'Q1' }
              ],
              [
                { text: 'Revenue', marginsEmu: { l: pt(15), r: pt(15), t: pt(5), b: pt(5) } },
                { text: 'Costs' },
                { text: 'Margin' }
              ],
              [{ text: '100' }, { text: '40' }, { text: '60' }]
            ]
          }
        ]
      }
    ]
  })
}

// ---- breaks.pptx ----
// buildPptx's declarative API can't express a manual a:br or a run-less
// paragraph directly (every paragraph it emits gets exactly one real run),
// so this deck starts from a plain 3-paragraph textbox and hand-patches the
// slide XML afterward - the same technique tests/core/pptx/pptx-adapter.test.ts
// uses for these exact scenarios.
async function buildBreaks() {
  const buffer = await buildPptx({
    slides: [
      {
        shapes: [
          {
            kind: 'textbox',
            name: 'Breaks And Run-less Paragraph',
            text: ['First paragraph, unbroken.', 'RUNLESS_PLACEHOLDER', 'Third paragraph.'],
            box: { xEmu: pt(50), yEmu: pt(50), wEmu: pt(500), hEmu: pt(300) },
            fontPt: 18
          }
        ]
      }
    ]
  })

  const zip = await JSZip.loadAsync(buffer)
  const slidePath = 'ppt/slides/slide1.xml'
  let xml = await zip.file(slidePath).async('string')

  // Turn the first paragraph's single run into two runs joined by a manual
  // a:br - exercises the a:br line-capacity fix (finding 2).
  const firstParagraph =
    /<a:p><a:r>(<a:rPr[^>]*>[^<]*<\/a:rPr>)?<a:t>First paragraph, unbroken\.<\/a:t><\/a:r><\/a:p>/
  if (!firstParagraph.test(xml)) {
    throw new Error(
      'make-gate-decks: first-paragraph pattern not found - builder output shape changed'
    )
  }
  xml = xml.replace(
    firstParagraph,
    '<a:p><a:r><a:t>First paragraph,</a:t></a:r><a:br/><a:r><a:t>manually broken.</a:t></a:r></a:p>'
  )

  // Turn the middle paragraph into a bare run-less spacer - exercises the
  // run-less-paragraph fix (finding 1).
  const runlessParagraph =
    /<a:p><a:r>(<a:rPr[^>]*>[^<]*<\/a:rPr>)?<a:t>RUNLESS_PLACEHOLDER<\/a:t><\/a:r><\/a:p>/
  if (!runlessParagraph.test(xml)) {
    throw new Error(
      'make-gate-decks: run-less-placeholder pattern not found - builder output shape changed'
    )
  }
  xml = xml.replace(runlessParagraph, '<a:p/>')

  zip.file(slidePath, xml)
  return zip.generateAsync({ type: 'nodebuffer' })
}

// ---- smartart.pptx ----
// A SmartArt diagram wired with a cached dsp:drawing part (finding 5) - the
// round trip a live PowerPoint open/re-save would exercise for real.
async function buildSmartArt() {
  return buildPptx({
    slides: [
      {
        shapes: [
          {
            kind: 'smartart',
            name: 'Process Cycle',
            box: { xEmu: pt(50), yEmu: pt(50), wEmu: pt(500), hEmu: pt(250) },
            points: ['Plan', 'Do', 'Check', 'Act'],
            cachedDrawing: true
          }
        ]
      }
    ]
  })
}

async function main() {
  await write('scaled-group.pptx', await buildScaledGroup())
  await write('tables.pptx', await buildTables())
  await write('breaks.pptx', await buildBreaks())
  await write('smartart.pptx', await buildSmartArt())
  process.stdout.write(`[gate-decks] done -> ${path.relative(root, outDir)}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
