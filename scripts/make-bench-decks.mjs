// Builds the phase-4 benchmark harness's synthetic hard-case fixture decks
// under fixtures/bench/decks/ (gitignored, regenerable), using the SAME
// programmatic builder the test suite uses (tests/helpers/build-pptx.ts) -
// mirrors scripts/make-gate-decks.mjs's own structure and idioms exactly,
// including its JSZip hand-patch technique for XML the declarative builder
// can't express (see buildCjkTable below).
//
// Run: npx tsx scripts/make-bench-decks.mjs [outDir]
// outDir defaults to fixtures/bench/decks/; an explicit argument lets a
// test point the generator at a temp directory instead (task-2-brief.md
// behavior contract point 4) without ever writing into the tracked tree.
//
// Outputs:
//   german-compounds.pptx - 6 textboxes of insurance/engineering-register
//     English (14-18pt) sized so the source text fills ~80% of its box's
//     width - German's compound-noun agglutination reliably produces a
//     single translated token longer than the English line, which must
//     trigger the fit engine's shrink ladder rather than translate at a
//     stable size.
//   cjk-table.pptx - an 8x6 table (48 cells) of short English business
//     phrases at 10pt with tight cell margins - the dense-CJK-table hard
//     case for EN->ZH (translated CJK text is visually denser per
//     character but the source columns leave it almost no lateral room).
//   tiny-boxes.pptx - 8 textboxes at 8pt/9pt, each barely wider than its
//     own English text - the tiny-box hard case (translated text has
//     essentially zero slack before the fit engine must shrink or wrap).
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { buildPptx } from '../tests/helpers/build-pptx'
import { registerBundledFonts } from '../src/core/fit/fonts'
import { measureWidestLine } from '../src/core/fit/fit-engine'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_OUT_DIR = path.join(root, 'fixtures', 'bench', 'decks')

const EMU_PER_PT = 12700
const pt = (n) => n * EMU_PER_PT

const FONT_FAMILY = 'Noto Sans'
/** Zero insets on every synthetic textbox here so the requested fill ratio / "barely wider than its text" claim is exact, not fudged by OOXML's default ~7.2pt-per-side body inset. */
const ZERO_INSETS = { l: 0, r: 0, t: 0, b: 0 }

async function write(outDir, name, buffer) {
  const outPath = path.join(outDir, name)
  writeFileSync(outPath, buffer)
  process.stdout.write(
    `[bench-decks] wrote ${path.relative(root, outPath)} (${buffer.length} bytes)\n`
  )
}

// ---- german-compounds.pptx ----
const FILL_RATIO = 0.8
const GERMAN_COMPOUND_LINES = [
  { text: 'Motor vehicle liability insurance contract termination notice', fontPt: 16 },
  { text: 'High-pressure fluid containment system maintenance schedule', fontPt: 15 },
  { text: 'Property damage liability coverage extension addendum', fontPt: 14 },
  { text: 'Industrial wastewater treatment operating license renewal', fontPt: 17 },
  { text: 'Occupational health and safety compliance requirements', fontPt: 18 },
  { text: 'Reinforced concrete load bearing capacity assessment report', fontPt: 16 }
]

function fillBoxFor(text, fontPt) {
  const font = { family: FONT_FAMILY, sizePt: fontPt }
  const textWPt = measureWidestLine([text], fontPt, font)
  return { wPt: textWPt / FILL_RATIO, hPt: fontPt * 1.5 }
}

async function buildGermanCompounds() {
  let y = 20
  const shapes = GERMAN_COMPOUND_LINES.map((line, i) => {
    const box = fillBoxFor(line.text, line.fontPt)
    const shape = {
      kind: 'textbox',
      name: `Compound ${i + 1}`,
      text: [line.text],
      box: { xEmu: pt(20), yEmu: pt(y), wEmu: pt(box.wPt), hEmu: pt(box.hPt) },
      fontPt: line.fontPt,
      fontFamily: FONT_FAMILY,
      insetsEmu: ZERO_INSETS
    }
    y += box.hPt + 20
    return shape
  })
  return buildPptx({ slides: [{ shapes }] })
}

// ---- cjk-table.pptx ----
const CJK_TABLE_ROWS = 6
const CJK_TABLE_COLS = 8
const CJK_TABLE_FONT_PT = 10
const TIGHT_MARGIN_PT = 2
const BUSINESS_PHRASES = [
  'Revenue',
  'Net Profit',
  'Gross Margin',
  'Operating Cost',
  'Market Share',
  'Growth Rate',
  'Cash Flow',
  'Fixed Assets',
  'Total Equity',
  'Debt Ratio',
  'Tax Expense',
  'Net Income',
  'Unit Price',
  'Order Volume',
  'Lead Time',
  'Fill Rate',
  'Return Rate',
  'Churn Rate',
  'Retention Rate',
  'Customer Base',
  'Sales Target',
  'Quota Met',
  'Region Code',
  'Branch Office',
  'Account Manager',
  'Contract Term',
  'Renewal Date',
  'Payment Due',
  'Credit Limit',
  'Late Fee',
  'Audit Trail',
  'Risk Score',
  'Compliance Flag',
  'Vendor Name',
  'Supplier ID',
  'Batch Number',
  'Lot Code',
  'Ship Date',
  'Delivery ETA',
  'Tracking ID',
  'Return Reason',
  'Warranty Term',
  'Service Level',
  'Escalation Tier',
  'Ticket Status',
  'Priority Level',
  'Assigned Team',
  'Close Date'
]

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * buildPptx's declarative table API never emits an `a:rPr` on a cell's run
 * (see tests/helpers/build-pptx.ts's 'table' case) - there is no per-cell
 * fontPt option, so a font size never lands in the XML at all and the
 * adapter's DEFAULT_FALLBACK_FONT_PT (18) would apply instead of this
 * deck's actual 10pt. Same technique make-gate-decks.mjs's buildBreaks()
 * uses for a shape the declarative builder can't express: build the table
 * normally, then hand-patch the slide XML via JSZip. Every run in this
 * slide is a table-cell run (the slide holds nothing else), so a global
 * `<a:r><a:t>` -> `<a:r><a:rPr sz="..."/><a:t>` replacement is safe and
 * unambiguous; the count check guards against silent builder-shape drift.
 */
async function buildCjkTable() {
  const grid = chunk(BUSINESS_PHRASES, CJK_TABLE_COLS)
  const font = { family: FONT_FAMILY, sizePt: CJK_TABLE_FONT_PT }

  const colWidthsPt = []
  for (let c = 0; c < CJK_TABLE_COLS; c++) {
    let maxW = 0
    for (let r = 0; r < CJK_TABLE_ROWS; r++) {
      const w = measureWidestLine([grid[r][c]], CJK_TABLE_FONT_PT, font)
      if (w > maxW) maxW = w
    }
    colWidthsPt.push(maxW + TIGHT_MARGIN_PT * 2 + 2)
  }
  const rowHeightPt = CJK_TABLE_FONT_PT * 1.2 + TIGHT_MARGIN_PT * 2
  const marginsEmu = {
    l: pt(TIGHT_MARGIN_PT),
    r: pt(TIGHT_MARGIN_PT),
    t: pt(TIGHT_MARGIN_PT),
    b: pt(TIGHT_MARGIN_PT)
  }
  const rows = grid.map((row) => row.map((text) => ({ text, marginsEmu })))
  const totalWPt = colWidthsPt.reduce((a, b) => a + b, 0)

  const buffer = await buildPptx({
    slides: [
      {
        shapes: [
          {
            kind: 'table',
            name: 'Dense Business Table',
            box: {
              xEmu: pt(20),
              yEmu: pt(20),
              wEmu: pt(totalWPt),
              hEmu: pt(rowHeightPt * CJK_TABLE_ROWS)
            },
            colWidthsEmu: colWidthsPt.map(pt),
            rowHeightsEmu: new Array(CJK_TABLE_ROWS).fill(pt(rowHeightPt)),
            rows
          }
        ]
      }
    ]
  })

  const zip = await JSZip.loadAsync(buffer)
  const slidePath = 'ppt/slides/slide1.xml'
  let xml = await zip.file(slidePath).async('string')

  const cellRunPattern = /<a:r><a:t>/g
  const expectedCount = CJK_TABLE_ROWS * CJK_TABLE_COLS
  const matches = xml.match(cellRunPattern)
  if (!matches || matches.length !== expectedCount) {
    throw new Error(
      `make-bench-decks: expected ${expectedCount} table-cell runs in cjk-table.pptx, found ` +
        `${matches ? matches.length : 0} - builder output shape changed`
    )
  }
  xml = xml.replace(cellRunPattern, `<a:r><a:rPr sz="${CJK_TABLE_FONT_PT * 100}"/><a:t>`)

  zip.file(slidePath, xml)
  return zip.generateAsync({ type: 'nodebuffer' })
}

// ---- tiny-boxes.pptx ----
const TINY_BOX_PAD_RATIO = 1.05
const TINY_BOX_ITEMS = [
  { text: 'Save', fontPt: 8 },
  { text: 'Cancel', fontPt: 8 },
  { text: 'Submit', fontPt: 8 },
  { text: 'Delete', fontPt: 8 },
  { text: 'Confirm', fontPt: 9 },
  { text: 'Export', fontPt: 9 },
  { text: 'Refresh', fontPt: 9 },
  { text: 'Settings', fontPt: 9 }
]
const TINY_BOX_COLS = 4
const TINY_BOX_COL_SPACING_PT = 220
const TINY_BOX_ROW_SPACING_PT = 80

async function buildTinyBoxes() {
  const shapes = TINY_BOX_ITEMS.map((item, i) => {
    const font = { family: FONT_FAMILY, sizePt: item.fontPt }
    const textWPt = measureWidestLine([item.text], item.fontPt, font)
    const wPt = textWPt * TINY_BOX_PAD_RATIO
    const hPt = item.fontPt * 1.5
    const col = i % TINY_BOX_COLS
    const row = Math.floor(i / TINY_BOX_COLS)
    return {
      kind: 'textbox',
      name: `Tiny ${i + 1}`,
      text: [item.text],
      box: {
        xEmu: pt(30 + col * TINY_BOX_COL_SPACING_PT),
        yEmu: pt(30 + row * TINY_BOX_ROW_SPACING_PT),
        wEmu: pt(wPt),
        hEmu: pt(hPt)
      },
      fontPt: item.fontPt,
      fontFamily: FONT_FAMILY,
      insetsEmu: ZERO_INSETS
    }
  })
  return buildPptx({ slides: [{ shapes }] })
}

export async function generate(outDir = DEFAULT_OUT_DIR) {
  const resolvedOutDir = path.resolve(outDir)
  mkdirSync(resolvedOutDir, { recursive: true })
  registerBundledFonts()

  await write(resolvedOutDir, 'german-compounds.pptx', await buildGermanCompounds())
  await write(resolvedOutDir, 'cjk-table.pptx', await buildCjkTable())
  await write(resolvedOutDir, 'tiny-boxes.pptx', await buildTinyBoxes())
  process.stdout.write(`[bench-decks] done -> ${path.relative(root, resolvedOutDir)}\n`)
  return resolvedOutDir
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain) {
  const outDirArg = process.argv[2]
  generate(outDirArg ? path.resolve(process.cwd(), outDirArg) : DEFAULT_OUT_DIR).catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
