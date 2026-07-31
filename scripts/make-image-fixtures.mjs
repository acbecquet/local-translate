// Generates the 10 synthetic labeled images for the phase-3 region-engine
// spike (fixtures/image-regions/imgNN.png) plus their ground-truth
// labels.json, and extracts 4 representative real media parts from the
// CCELL benchmark deck into fixtures/image-regions/real/ for qualitative
// (unlabeled) eval. See plan Task 1:
// docs/superpowers/plans/2026-07-31-phase-3-image-text.md
//
// Ground truth is recorded AS drawn, not guessed after the fact: every
// drawRegion() call below both paints the glyphs and returns the bbox that
// is the true painted INK extent, read from skia-canvas's own TextMetrics
// (measureText's actualBoundingBoxLeft/Right/Ascent/Descent), not a
// fontSize*1.2 line-height approximation. That line-height approximation
// was this generator's first cut and was deliberately replaced: it
// systematically over-pads every region vertically relative to what any
// region-detection engine actually paints/detects (glyph ink, not the
// font's full em-box + leading), which put an artificial ~0.5 IoU ceiling
// on an engine that localizes ink correctly - a measurement artifact in the
// fixtures, not a property of engine quality, and it would have unfairly
// distorted the ocr:ppocr-vs-vlm comparison this spike exists to make.
// LINE_HEIGHT_FACTOR mirrors src/core/fit/fit-engine.ts's constant of the
// same name and value; it is re-declared here (not imported, since this
// script lives outside src/core by design) and used ONLY to space
// consecutive lines vertically within a multi-line region - never as a
// substitute for measured ink extent.
//
// Run: npx tsx scripts/make-image-fixtures.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Canvas } from 'skia-canvas'
import JSZip from 'jszip'
import { registerBundledFonts } from '../src/core/fit/fonts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'fixtures', 'image-regions')
const realDir = path.join(outDir, 'real')
mkdirSync(realDir, { recursive: true })

registerBundledFonts()

const LINE_HEIGHT_FACTOR = 1.2
const LATIN = 'Noto Sans'
const CJK = 'Noto Sans CJK SC'

function round2(n) {
  return Math.round(n * 100) / 100
}

// Deterministic PRNG (mulberry32) so the busy (gradient+noise) backgrounds
// are byte-identical across regenerations. These pngs are gitignored and
// regenerable on demand, but non-determinism would still make a rerun's
// diff meaningless when someone wants to confirm nothing drifted.
function mulberry32(seed) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/**
 * The ink-true bbox of one line drawn at (x, y) with textAlign='left',
 * textBaseline='top' - derived from TextMetrics rather than the font's
 * nominal em-box. Per the Canvas 2D spec, actualBoundingBox{Left,Right} are
 * distances from the alignment point (x) going left/right, and
 * actualBoundingBox{Ascent,Descent} are distances from the textBaseline
 * anchor (y, since baseline='top' puts that anchor at the em-box top, ABOVE
 * the real glyph ink - ascent is typically negative here) going up/down to
 * the ink edges. Verified empirically against skia-canvas's own rendered
 * pixels (Latin/CJK, regular/bold, digits-only, punctuation) to within
 * antialiasing-edge rounding before relying on it for ground truth.
 */
function inkBoxForLine(ctx, x, y, text) {
  const m = ctx.measureText(text)
  return {
    left: x - m.actualBoundingBoxLeft,
    right: x + m.actualBoundingBoxRight,
    top: y - m.actualBoundingBoxAscent,
    bottom: y + m.actualBoundingBoxDescent
  }
}

/**
 * Paints one region - one line, or several stacked lines spaced by
 * LINE_HEIGHT_FACTOR*sizePt - and returns its {bbox, text} ground-truth
 * entry as the UNION of each line's ink-true bbox (inkBoxForLine). Every
 * current fixture only ever passes a single-line `text`, in which case the
 * "union" is just that one line's own ink box; the multi-line path exists
 * so a future fixture can add a wrapped block without a second bbox
 * convention to keep in sync.
 */
function drawRegion(ctx, { x, y, text, sizePt, family = LATIN, color, bold = false }) {
  ctx.font = `${bold ? 'bold ' : ''}${sizePt}px "${family}"`
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'

  const lines = Array.isArray(text) ? text : [text]
  const lineHeightPx = sizePt * LINE_HEIGHT_FACTOR
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (let i = 0; i < lines.length; i++) {
    const lineY = y + i * lineHeightPx
    ctx.fillText(lines[i], x, lineY)
    const box = inkBoxForLine(ctx, x, lineY, lines[i])
    left = Math.min(left, box.left)
    top = Math.min(top, box.top)
    right = Math.max(right, box.right)
    bottom = Math.max(bottom, box.bottom)
  }
  return {
    bbox: { x: round2(left), y: round2(top), w: round2(right - left), h: round2(bottom - top) },
    text: lines.join(' ')
  }
}

function fillSolid(ctx, w, h, color) {
  ctx.fillStyle = color
  ctx.fillRect(0, 0, w, h)
}

/** Linear gradient with per-pixel noise added on top - the "busy background" hard case (img06-07). */
function fillGradientNoise(ctx, w, h, stops, amplitude, seed) {
  const g = ctx.createLinearGradient(0, 0, w, h)
  for (const [offset, color] of stops) g.addColorStop(offset, color)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)

  const rng = mulberry32(seed)
  const imgData = ctx.getImageData(0, 0, w, h)
  const d = imgData.data
  for (let i = 0; i < d.length; i += 4) {
    const delta = Math.floor((rng() - 0.5) * 2 * amplitude)
    d[i] = clampByte(d[i] + delta)
    d[i + 1] = clampByte(d[i + 1] + delta)
    d[i + 2] = clampByte(d[i + 2] + delta)
  }
  ctx.putImageData(imgData, 0, 0)
}

/** Fails fast if a region's bbox isn't a true positive-area rect inside the canvas - a bug in this generator, not something spike scoring should have to route around. */
function assertLabelsSane(name, w, h, regions) {
  for (const r of regions) {
    const { x, y, w: rw, h: rh } = r.bbox
    if (rw <= 0 || rh <= 0) {
      throw new Error(`make-image-fixtures: ${name} non-positive bbox for "${r.text}"`)
    }
    if (x < 0 || y < 0 || x + rw > w || y + rh > h) {
      throw new Error(
        `make-image-fixtures: ${name} bbox out of bounds for "${r.text}": ` +
          `${JSON.stringify(r.bbox)} vs canvas ${w}x${h}`
      )
    }
  }
}

const labels = {}

async function finishImage(name, canvas, regions) {
  assertLabelsSane(name, canvas.width, canvas.height, regions)
  labels[name] = regions.map(({ bbox, text }) => ({ bbox, text }))
  const buf = await canvas.toBuffer('png')
  writeFileSync(path.join(outDir, name), buf)
  process.stdout.write(
    `[image-fixtures] wrote fixtures/image-regions/${name} (${buf.length} bytes, ${regions.length} regions)\n`
  )
}

// ---- img01: dark solid bg, 3 latin blocks ----
async function buildImg01() {
  const canvas = new Canvas(800, 600)
  const ctx = canvas.getContext('2d')
  fillSolid(ctx, 800, 600, '#14213d')
  const regions = [
    drawRegion(ctx, {
      x: 40,
      y: 30,
      text: 'Quarterly Results Overview',
      sizePt: 28,
      bold: true,
      color: '#ffffff'
    }),
    drawRegion(ctx, {
      x: 40,
      y: 120,
      text: 'Revenue grew 18 percent year over year',
      sizePt: 18,
      color: '#ffffff'
    }),
    drawRegion(ctx, {
      x: 40,
      y: 170,
      text: 'Report generated automatically',
      sizePt: 14,
      color: '#a8b2c1'
    })
  ]
  await finishImage('img01.png', canvas, regions)
}

// ---- img02: light solid bg, 4 latin blocks ----
async function buildImg02() {
  const canvas = new Canvas(800, 600)
  const ctx = canvas.getContext('2d')
  fillSolid(ctx, 800, 600, '#f5f5f0')
  const regions = [
    drawRegion(ctx, {
      x: 50,
      y: 40,
      text: 'Annual Summary 2025',
      sizePt: 32,
      bold: true,
      color: '#1a1a1a'
    }),
    drawRegion(ctx, {
      x: 50,
      y: 120,
      text: 'Prepared for the board of directors',
      sizePt: 18,
      color: '#1a1a1a'
    }),
    drawRegion(ctx, {
      x: 50,
      y: 170,
      text: 'Confidential - internal use only',
      sizePt: 14,
      color: '#b00020'
    }),
    drawRegion(ctx, { x: 50, y: 210, text: 'Page 1 of 12', sizePt: 12, color: '#555555' })
  ]
  await finishImage('img02.png', canvas, regions)
}

// ---- img03: colored solid bg, 3 latin blocks ----
async function buildImg03() {
  const canvas = new Canvas(800, 600)
  const ctx = canvas.getContext('2d')
  fillSolid(ctx, 800, 600, '#2a9d8f')
  const regions = [
    drawRegion(ctx, {
      x: 60,
      y: 50,
      text: 'Product Launch Timeline',
      sizePt: 30,
      bold: true,
      color: '#ffffff'
    }),
    drawRegion(ctx, {
      x: 60,
      y: 130,
      text: 'Phase one begins next month',
      sizePt: 20,
      color: '#ffffff'
    }),
    drawRegion(ctx, { x: 60, y: 180, text: 'Track progress weekly', sizePt: 16, color: '#ffe66d' })
  ]
  await finishImage('img03.png', canvas, regions)
}

// ---- img04: CJK, light bg, mixed sizes incl. the 10pt small-text case ----
async function buildImg04() {
  const canvas = new Canvas(800, 600)
  const ctx = canvas.getContext('2d')
  fillSolid(ctx, 800, 600, '#ffffff')
  const regions = [
    drawRegion(ctx, {
      x: 40,
      y: 30,
      text: '季度业绩报告',
      sizePt: 24,
      bold: true,
      family: CJK,
      color: '#111111'
    }),
    drawRegion(ctx, {
      x: 40,
      y: 90,
      text: '电池测试结果合格',
      sizePt: 16,
      family: CJK,
      color: '#333333'
    }),
    drawRegion(ctx, {
      x: 40,
      y: 130,
      text: '生成时间 2026 年 7 月',
      sizePt: 10,
      family: CJK,
      color: '#777777'
    })
  ]
  await finishImage('img04.png', canvas, regions)
}

// ---- img05: CJK, dark bg, mixed sizes ----
async function buildImg05() {
  const canvas = new Canvas(800, 600)
  const ctx = canvas.getContext('2d')
  fillSolid(ctx, 800, 600, '#1a1a1a')
  const regions = [
    drawRegion(ctx, {
      x: 40,
      y: 30,
      text: '产品发布时间表',
      sizePt: 26,
      bold: true,
      family: CJK,
      color: '#ffffff'
    }),
    drawRegion(ctx, {
      x: 40,
      y: 100,
      text: '第一阶段下月开始',
      sizePt: 18,
      family: CJK,
      color: '#ffffff'
    }),
    drawRegion(ctx, {
      x: 40,
      y: 150,
      text: '每周跟踪进度',
      sizePt: 14,
      family: CJK,
      color: '#ffe66d'
    })
  ]
  await finishImage('img05.png', canvas, regions)
}

// ---- img06: gradient + noise busy bg, latin (hard case 1) ----
async function buildImg06() {
  const canvas = new Canvas(800, 600)
  const ctx = canvas.getContext('2d')
  fillGradientNoise(
    ctx,
    800,
    600,
    [
      [0, '#ff6b6b'],
      [1, '#4ecdc4']
    ],
    24,
    12345
  )
  const regions = [
    drawRegion(ctx, {
      x: 50,
      y: 40,
      text: 'System Status: Operational',
      sizePt: 22,
      bold: true,
      color: '#ffffff'
    }),
    drawRegion(ctx, {
      x: 50,
      y: 100,
      text: 'Last updated 3 minutes ago',
      sizePt: 16,
      color: '#ffffff'
    }),
    drawRegion(ctx, {
      x: 400,
      y: 300,
      text: 'Contact support if issues persist',
      sizePt: 14,
      color: '#ffffff'
    })
  ]
  await finishImage('img06.png', canvas, regions)
}

// ---- img07: gradient + noise busy bg, CJK (hard case 2, heavier noise) ----
async function buildImg07() {
  const canvas = new Canvas(800, 600)
  const ctx = canvas.getContext('2d')
  fillGradientNoise(
    ctx,
    800,
    600,
    [
      [0, '#5f0f40'],
      [1, '#9a031e']
    ],
    34,
    67890
  )
  const regions = [
    drawRegion(ctx, {
      x: 50,
      y: 40,
      text: '警告 高温风险',
      sizePt: 22,
      bold: true,
      family: CJK,
      color: '#ffffff'
    }),
    drawRegion(ctx, {
      x: 50,
      y: 110,
      text: '请勿触摸金属部件',
      sizePt: 16,
      family: CJK,
      color: '#ffffff'
    }),
    drawRegion(ctx, {
      x: 50,
      y: 170,
      text: '损坏样品需要标记',
      sizePt: 14,
      family: CJK,
      color: '#ffe6a8'
    })
  ]
  await finishImage('img07.png', canvas, regions)
}

// ---- img08: dense grid, 8 small latin regions (table-like) ----
async function buildImg08() {
  const canvas = new Canvas(900, 300)
  const ctx = canvas.getContext('2d')
  fillSolid(ctx, 900, 300, '#ffffff')

  // Decorative cell borders only - not tracked as regions, just makes the
  // grid read as a table to a human eyeballing the fixture.
  ctx.strokeStyle = '#cccccc'
  const cols = [20, 240, 460, 680]
  const rowYs = [20, 140]
  for (const cy of rowYs) {
    for (const cx of cols) {
      ctx.strokeRect(cx, cy, 200, 100)
    }
  }

  const row1 = ['Tester: Charlie', 'Media: D8', 'Power: 4.2 W', 'Voltage: 3.2 V']
  const row2 = ['Resistance: 2.3', 'Storage: 60C', 'Time: 48 h', 'Humidity: 60%']
  const regions = []
  cols.forEach((cx, i) => {
    regions.push(
      drawRegion(ctx, { x: cx + 15, y: rowYs[0] + 40, text: row1[i], sizePt: 13, color: '#111111' })
    )
  })
  cols.forEach((cx, i) => {
    regions.push(
      drawRegion(ctx, { x: cx + 15, y: rowYs[1] + 40, text: row2[i], sizePt: 13, color: '#111111' })
    )
  })
  await finishImage('img08.png', canvas, regions)
}

// ---- img09: mixed latin + CJK on one image (source-language gating case) ----
async function buildImg09() {
  const canvas = new Canvas(800, 600)
  const ctx = canvas.getContext('2d')
  fillSolid(ctx, 800, 600, '#ffffff')
  const regions = [
    drawRegion(ctx, {
      x: 40,
      y: 30,
      text: 'CCELL AIO Device',
      sizePt: 24,
      bold: true,
      color: '#111111'
    }),
    drawRegion(ctx, {
      x: 40,
      y: 90,
      text: '标准测试结果',
      sizePt: 20,
      bold: true,
      family: CJK,
      color: '#111111'
    }),
    drawRegion(ctx, {
      x: 40,
      y: 140,
      text: 'Serial Number: A19082',
      sizePt: 14,
      color: '#555555'
    }),
    drawRegion(ctx, {
      x: 40,
      y: 180,
      text: '测试员：Charlie',
      sizePt: 14,
      family: CJK,
      color: '#333333'
    })
  ]
  await finishImage('img09.png', canvas, regions)
}

// ---- img10: no text at all (hallucination probe - zero labeled regions) ----
async function buildImg10() {
  const canvas = new Canvas(800, 600)
  const ctx = canvas.getContext('2d')
  fillSolid(ctx, 800, 600, '#e8e8e8')
  // Decorative, non-text shapes only - a plausible "photo/screenshot with no
  // text" case rather than a suspiciously blank canvas.
  ctx.strokeStyle = '#c0c0c0'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(400, 300, 180, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(0, 500)
  ctx.lineTo(800, 420)
  ctx.stroke()
  await finishImage('img10.png', canvas, [])
}

// ---- real/: 4 representative media parts extracted from the CCELL deck ----
// Selection rationale: every PNG in this deck is a baked-in matplotlib chart
// or Excel-table screenshot (all English) and every JPG is a textless macro
// photo of vape hardware internals - confirmed by eyeballing all 19 PNG / 20
// JPG media parts during fixture authoring (dimension probe + direct view).
// The plan's "2 CJK-bearing pngs" target does not exist anywhere in this
// deck. Picked instead, as the closest available real-world stress tests:
// two of the most text-dense PNGs (small multi-column table text, and a
// chart with title/axis/legend text) and two representative textless JPGs
// (a real photographic zero-text hallucination probe, same spirit as img10
// but lossy-compressed and textured instead of synthetic).
const REAL_PICKS = [
  { src: 'ppt/media/image16.png', out: 'real-table-en.png' },
  { src: 'ppt/media/image35.png', out: 'real-chart-en.png' },
  { src: 'ppt/media/image25.jpg', out: 'real-photo-1.jpg' },
  { src: 'ppt/media/image10.jpg', out: 'real-photo-2.jpg' }
]

async function extractRealCrops() {
  const pptxPath = path.join(
    root,
    'fixtures',
    'real',
    'CCELL 3.0 AIO Lab Test Updates Mandarin.pptx'
  )
  const zip = await JSZip.loadAsync(readFileSync(pptxPath))
  for (const { src, out } of REAL_PICKS) {
    const file = zip.file(src)
    if (!file) {
      throw new Error(`make-image-fixtures: expected media part missing from deck: ${src}`)
    }
    const buf = await file.async('nodebuffer')
    writeFileSync(path.join(realDir, out), buf)
    process.stdout.write(
      `[image-fixtures] extracted ${src} -> fixtures/image-regions/real/${out} (${buf.length} bytes)\n`
    )
  }
}

async function main() {
  await buildImg01()
  await buildImg02()
  await buildImg03()
  await buildImg04()
  await buildImg05()
  await buildImg06()
  await buildImg07()
  await buildImg08()
  await buildImg09()
  await buildImg10()
  await extractRealCrops()

  writeFileSync(path.join(outDir, 'labels.json'), JSON.stringify(labels, null, 2) + '\n')
  const totalRegions = Object.values(labels).reduce((n, r) => n + r.length, 0)
  process.stdout.write(
    `[image-fixtures] wrote fixtures/image-regions/labels.json ` +
      `(${Object.keys(labels).length} images, ${totalRegions} labeled regions)\n`
  )
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
