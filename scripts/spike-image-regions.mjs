// Phase-3 region-engine spike harness. Scores any engine implementing
// detectRegions(buffer): Promise<TextRegion[]> against the labeled fixtures
// in fixtures/image-regions/, printing a markdown table (per-image + overall)
// of recall/precision/mean-IoU/text-accuracy at two IoU thresholds (strict
// 0.5, relaxed 0.4), plus a coverage-recall column and an unmatched-detection
// dump. This is the exact interface Task 2's regions.ts ships, so the
// winning engine's code moves over nearly verbatim. See plan Task 1:
// docs/superpowers/plans/2026-07-31-phase-3-image-text.md
//
// Two IoU thresholds, not one, because a single strict cutoff conflates two
// different failure modes: genuine mislocalization vs. a detection that
// found the right text but drew a slightly looser/tighter box around it.
// Coverage recall exists for a THIRD failure mode neither IoU threshold
// catches well: an engine (or its own post-processing, e.g. PP-OCR merging
// nearby same-row cells) that reports fewer, larger detections which still
// jointly cover every ground-truth region - useful signal for dense/table
// content (img08, and the real table crop) where "one bbox per GT region"
// isn't how the engine naturally segments the content.
//
// Usage: node scripts/spike-image-regions.mjs --engine <name>
//   --engine mock:labels    replays labels.json verbatim - self-tests the
//                           scorer, must print recall/precision/IoU/textAcc
//                           of 100% on every row.
//   --engine ocr:ppocr      PP-OCRv4 detection+recognition via
//                           @gutenye/ocr-node, CPU only, Chinese (multilingual)
//                           recognition model - safe to run in an agent
//                           session (no GPU, no model download beyond the
//                           package install).
//   --engine vlm:<model>    Ollama /api/chat with images, JSON-schema output,
//                           temperature 0. NEVER run this from an agent
//                           session (MACHINE RULES: GPU model loads are
//                           Charlie-run only) - a human runs this directly.
import { readFileSync, readdirSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { Image } from 'skia-canvas'
import { Ollama } from 'ollama'
import { z } from 'zod'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturesDir = path.join(root, 'fixtures', 'image-regions')

// ---- CLI ----

function parseArgs(argv) {
  const idx = argv.indexOf('--engine')
  if (idx === -1 || !argv[idx + 1]) {
    throw new Error('usage: node scripts/spike-image-regions.mjs --engine <name>')
  }
  return { engine: argv[idx + 1] }
}

// ---- geometry + text scoring ----

function iou(a, b) {
  const ax2 = a.x + a.w
  const ay2 = a.y + a.h
  const bx2 = b.x + b.w
  const by2 = b.y + b.h
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y))
  const inter = ix * iy
  if (inter <= 0) return 0
  const union = a.w * a.h + b.w * b.h - inter
  return union <= 0 ? 0 : inter / union
}

/** Plain Levenshtein edit distance, two-row DP (no dependency - this is ~15 lines). */
function levenshtein(a, b) {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

function textAccuracy(gtText, detText) {
  const maxLen = Math.max(gtText.length, detText.length, 1)
  return 1 - levenshtein(gtText, detText) / maxLen
}

// Greedy IoU>=threshold matching: highest-scoring pairs are claimed first,
// each ground-truth region and each detection used in at most one match.
// Unmatched detections are hallucinations (hurt precision); unmatched
// ground-truth regions are misses (hurt recall). Run once per threshold
// (STRICT, RELAXED) rather than filtering one match set post hoc: lowering
// the threshold changes which pairs are ELIGIBLE, which can change the
// greedy assignment itself, not just add extra matches on top.
const IOU_STRICT = 0.5
const IOU_RELAXED = 0.4

function matchRegions(gtRegions, detected, threshold) {
  const pairs = []
  for (let gi = 0; gi < gtRegions.length; gi++) {
    for (let di = 0; di < detected.length; di++) {
      const score = iou(gtRegions[gi].bbox, detected[di].bbox)
      if (score >= threshold) pairs.push({ gi, di, score })
    }
  }
  pairs.sort((a, b) => b.score - a.score)
  const usedGt = new Set()
  const usedDet = new Set()
  const matches = []
  for (const p of pairs) {
    if (usedGt.has(p.gi) || usedDet.has(p.di)) continue
    usedGt.add(p.gi)
    usedDet.add(p.di)
    matches.push(p)
  }
  return { matches, usedDet }
}

function summarizeMatches(gtRegions, detected, matches) {
  const matched = matches.length
  const totalGt = gtRegions.length
  const totalDet = detected.length
  const meanIoU = matched > 0 ? matches.reduce((s, m) => s + m.score, 0) / matched : null
  const meanTextAcc =
    matched > 0
      ? matches.reduce((s, m) => s + textAccuracy(gtRegions[m.gi].text, detected[m.di].text), 0) /
        matched
      : null
  return {
    matched,
    totalGt,
    totalDet,
    recall: totalGt > 0 ? matched / totalGt : null,
    precision: totalDet > 0 ? matched / totalDet : null,
    meanIoU,
    meanTextAcc
  }
}

// ---- coverage recall ----
// "Covered" is a looser bar than any single IoU match: a GT region counts
// as covered when >= 70% of its area is jointly covered by the UNION of all
// detections on that image, regardless of how many separate detections it
// took. clipRect intersects one detection with the GT box; unionArea sums
// the covered area of a set of (possibly overlapping) sub-rectangles via
// coordinate-compression sweep - exact, not a Monte-Carlo estimate, and
// cheap at fixture scale (single digits to low tens of rects per image).
const COVERAGE_THRESHOLD = 0.7

function clipRect(a, b) {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

function unionArea(rects) {
  if (rects.length === 0) return 0
  const xs = [...new Set(rects.flatMap((r) => [r.x, r.x + r.w]))].sort((a, b) => a - b)
  const ys = [...new Set(rects.flatMap((r) => [r.y, r.y + r.h]))].sort((a, b) => a - b)
  let area = 0
  for (let i = 0; i < xs.length - 1; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2
    const cellW = xs[i + 1] - xs[i]
    for (let j = 0; j < ys.length - 1; j++) {
      const cy = (ys[j] + ys[j + 1]) / 2
      const cellH = ys[j + 1] - ys[j]
      const covered = rects.some(
        (r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h
      )
      if (covered) area += cellW * cellH
    }
  }
  return area
}

function coverageRecall(gtRegions, detected) {
  if (gtRegions.length === 0) return null
  let covered = 0
  for (const gt of gtRegions) {
    const clipped = detected.map((d) => clipRect(gt.bbox, d.bbox)).filter((r) => r !== null)
    const gtArea = gt.bbox.w * gt.bbox.h
    if (gtArea > 0 && unionArea(clipped) / gtArea >= COVERAGE_THRESHOLD) covered++
  }
  return covered / gtRegions.length
}

// ---- per-image / overall scoring ----

function scoreImage(gtRegions, detected) {
  const strict = matchRegions(gtRegions, detected, IOU_STRICT)
  const relaxed = matchRegions(gtRegions, detected, IOU_RELAXED)
  const unmatchedAtRelaxed = detected
    .map((d, di) => ({ d, di }))
    .filter(({ di }) => !relaxed.usedDet.has(di))
    .map(({ d }) => d)
  return {
    totalGt: gtRegions.length,
    totalDet: detected.length,
    strict: summarizeMatches(gtRegions, detected, strict.matches),
    relaxed: summarizeMatches(gtRegions, detected, relaxed.matches),
    coverageRecall: coverageRecall(gtRegions, detected),
    unmatchedAtRelaxed
  }
}

// Micro-average across images (sum matches/totals, not average of per-image
// ratios) - correctly lets a zero-region image (img10) contribute 0/0 to
// every sum without perturbing the overall ratio, which is exactly what
// makes the mock:labels self-test come out at a clean 100% on every column.
function aggregateBucket(summaries, totalsGt) {
  let matched = 0
  let totalDet = 0
  let iouSum = 0
  let iouCount = 0
  let taSum = 0
  let taCount = 0
  for (const s of summaries) {
    matched += s.matched
    totalDet += s.totalDet
    if (s.meanIoU !== null) {
      iouSum += s.meanIoU * s.matched
      iouCount += s.matched
    }
    if (s.meanTextAcc !== null) {
      taSum += s.meanTextAcc * s.matched
      taCount += s.matched
    }
  }
  const totalGt = totalsGt.reduce((a, b) => a + b, 0)
  return {
    matched,
    totalGt,
    totalDet,
    recall: totalGt > 0 ? matched / totalGt : null,
    precision: totalDet > 0 ? matched / totalDet : null,
    meanIoU: iouCount > 0 ? iouSum / iouCount : null,
    meanTextAcc: taCount > 0 ? taSum / taCount : null
  }
}

function aggregate(perImage) {
  const totalsGt = perImage.map((r) => r.totalGt)
  let coveredSum = 0
  let coveredCount = 0
  for (const r of perImage) {
    if (r.coverageRecall !== null) {
      coveredSum += r.coverageRecall * r.totalGt
      coveredCount += r.totalGt
    }
  }
  return {
    totalGt: totalsGt.reduce((a, b) => a + b, 0),
    totalDet: perImage.reduce((a, r) => a + r.totalDet, 0),
    strict: aggregateBucket(
      perImage.map((r) => r.strict),
      totalsGt
    ),
    relaxed: aggregateBucket(
      perImage.map((r) => r.relaxed),
      totalsGt
    ),
    coverageRecall: coveredCount > 0 ? coveredSum / coveredCount : null
  }
}

// ---- markdown report ----

function pct(v) {
  return v === null ? 'N/A' : `${(v * 100).toFixed(1)}%`
}

function renderRow(label, totalGt, totalDet, strict, relaxed, coverage, wallMs) {
  return (
    `| ${label} | ${totalGt} | ${totalDet} | ` +
    `${strict.matched} | ${pct(strict.recall)} | ${pct(strict.precision)} | ${pct(strict.meanIoU)} | ${pct(strict.meanTextAcc)} | ` +
    `${relaxed.matched} | ${pct(relaxed.recall)} | ${pct(relaxed.precision)} | ${pct(relaxed.meanIoU)} | ${pct(relaxed.meanTextAcc)} | ` +
    `${pct(coverage)} | ${wallMs} |`
  )
}

function renderTable(engineName, rows, overall, totalWallMs) {
  const lines = [
    `## Spike results: ${engineName}`,
    '',
    '@.5 = strict IoU>=0.5 match. @.4 = relaxed IoU>=0.4 match. coverage = fraction of GT ' +
      'regions >=70% covered by the union of all detections (see COVERAGE_THRESHOLD).',
    '',
    '| image | gt | det | m@.5 | recall@.5 | precision@.5 | IoU@.5 | text@.5 | ' +
      'm@.4 | recall@.4 | precision@.4 | IoU@.4 | text@.4 | coverage | wall ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  ]
  for (const r of rows) {
    lines.push(
      renderRow(
        r.name,
        r.scored.totalGt,
        r.scored.totalDet,
        r.scored.strict,
        r.scored.relaxed,
        r.scored.coverageRecall,
        r.wallMs
      )
    )
  }
  lines.push(
    renderRow(
      '**overall**',
      overall.totalGt,
      overall.totalDet,
      overall.strict,
      overall.relaxed,
      overall.coverageRecall,
      totalWallMs
    )
  )

  const unmatched = rows.flatMap((r) =>
    r.scored.unmatchedAtRelaxed.map((d) => ({ image: r.name, d }))
  )
  if (unmatched.length > 0) {
    lines.push('', '### Unmatched detections (no GT region even at relaxed IoU>=0.4)', '')
    lines.push('| image | bbox | text | confidence |', '|---|---|---|---|')
    for (const { image, d } of unmatched) {
      const bbox = `x=${d.bbox.x.toFixed(0)},y=${d.bbox.y.toFixed(0)},w=${d.bbox.w.toFixed(0)},h=${d.bbox.h.toFixed(0)}`
      lines.push(`| ${image} | ${bbox} | ${JSON.stringify(d.text)} | ${d.confidence.toFixed(2)} |`)
    }
  } else {
    lines.push('', '_No unmatched detections at relaxed IoU>=0.4 - zero hallucinations._')
  }

  return lines.join('\n')
}

// ---- engines ----
// Every engine below exports the one method the harness (and later
// regions.ts) needs: detectRegions(buffer) -> TextRegion[] with
// { id, bbox: {x,y,w,h} px, text, confidence }.

/**
 * Replays fixtures/image-regions/labels.json verbatim. Identifies which
 * fixture a buffer came from by content hash rather than by filename (the
 * engine interface is buffer-only, deliberately, since that's the real
 * interface Task 2 ships) - so this stays a genuine, if trivial,
 * detectRegions(buffer) implementation instead of a filename side channel.
 * This is the scorer's own self-test: replaying ground truth verbatim must
 * score recall = precision = mean IoU = text accuracy = 100%.
 */
function createMockLabelsEngine() {
  const labels = JSON.parse(readFileSync(path.join(fixturesDir, 'labels.json'), 'utf8'))
  const byHash = new Map()
  for (const name of Object.keys(labels)) {
    const buf = readFileSync(path.join(fixturesDir, name))
    const hash = createHash('sha256').update(buf).digest('hex')
    byHash.set(hash, labels[name])
  }
  return {
    async detectRegions(buffer) {
      const hash = createHash('sha256').update(buffer).digest('hex')
      const regions = byHash.get(hash)
      if (!regions) {
        throw new Error('mock:labels engine: buffer does not match any known fixture image')
      }
      return regions.map((r, i) => ({
        id: `r${i + 1}`,
        bbox: { ...r.bbox },
        text: r.text,
        confidence: 1
      }))
    }
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8])

function sniffExtension(buffer) {
  if (buffer.subarray(0, 4).equals(PNG_MAGIC)) return '.png'
  if (buffer.subarray(0, 2).equals(JPEG_MAGIC)) return '.jpg'
  throw new Error('sniffExtension: buffer is neither PNG nor JPEG (unexpected magic bytes)')
}

/**
 * PP-OCRv4 detection + recognition via @gutenye/ocr-node, CPU only. Its
 * bundled default model IS the Chinese ("ch_PP-OCRv4") det+rec model
 * (multilingual: reads CJK and Latin both), not an English-only model - no
 * extra model selection needed. detect() takes a file path (its ImageRaw
 * loader wraps `sharp(path)`), so each buffer is spilled to a short-lived
 * temp file rather than relying on any undocumented Buffer-input behavior.
 */
async function createPPOcrEngine() {
  const { default: Ocr } = await import('@gutenye/ocr-node')
  const ocr = await Ocr.create()
  return {
    async detectRegions(buffer) {
      const ext = sniffExtension(buffer)
      const tmpPath = path.join(
        os.tmpdir(),
        `spike-ppocr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      )
      await writeFile(tmpPath, buffer)
      try {
        const lines = await ocr.detect(tmpPath)
        return lines.map((line, i) => {
          const xs = line.box.map((p) => p[0])
          const ys = line.box.map((p) => p[1])
          const x = Math.min(...xs)
          const y = Math.min(...ys)
          const w = Math.max(...xs) - x
          const h = Math.max(...ys) - y
          return { id: `r${i + 1}`, bbox: { x, y, w, h }, text: line.text, confidence: line.mean }
        })
      } finally {
        await unlink(tmpPath).catch(() => {})
      }
    }
  }
}

const VLM_REGION_SCHEMA = z.object({
  regions: z.array(
    z.object({
      bbox: z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number()
      }),
      text: z.string()
    })
  )
})

/**
 * Ollama /api/chat with images, forcing the {regions:[{bbox,text}]} JSON
 * schema above, temperature 0. Bboxes come back normalized to a 0-1000
 * range per the plan (independent of the image's actual pixel size) and are
 * denormalized here using the real decoded width/height. WRITTEN but NEVER
 * INVOKED by an agent session (MACHINE RULES: GPU model loads are
 * Charlie-run only, in a run-tagged command block) - this function is only
 * ever called when a human runs this script directly with --engine vlm:<model>.
 */
function createVlmEngine(model) {
  const baseUrl = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'
  const client = new Ollama({ host: baseUrl })
  return {
    async detectRegions(buffer) {
      const img = new Image(buffer)
      await img.decode()
      const { width, height } = img

      const res = await client.chat({
        model,
        messages: [
          {
            role: 'user',
            content:
              'Detect every text region in this image. For each region, report its bounding ' +
              'box normalized to a 0-1000 scale (x, y, w, h all in 0-1000, independent of the ' +
              "image's actual pixel dimensions) and the exact text it contains, read in the " +
              "image's source language.",
            images: [buffer.toString('base64')]
          }
        ],
        format: z.toJSONSchema(VLM_REGION_SCHEMA),
        options: { temperature: 0 },
        stream: false
      })

      const parsed = VLM_REGION_SCHEMA.parse(JSON.parse(res.message.content))
      return parsed.regions.map((r, i) => ({
        id: `r${i + 1}`,
        bbox: {
          x: (r.bbox.x / 1000) * width,
          y: (r.bbox.y / 1000) * height,
          w: (r.bbox.w / 1000) * width,
          h: (r.bbox.h / 1000) * height
        },
        text: r.text,
        confidence: 1
      }))
    }
  }
}

async function createEngine(name) {
  if (name === 'mock:labels') return createMockLabelsEngine()
  if (name === 'ocr:ppocr') return await createPPOcrEngine()
  if (name.startsWith('vlm:')) return createVlmEngine(name.slice(4))
  throw new Error(`unknown --engine "${name}" (expected mock:labels, ocr:ppocr, or vlm:<model>)`)
}

// ---- harness driver ----

async function main() {
  const { engine: engineName } = parseArgs(process.argv.slice(2))
  const labels = JSON.parse(readFileSync(path.join(fixturesDir, 'labels.json'), 'utf8'))
  const imageNames = readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.png'))
    .sort()

  const engine = await createEngine(engineName)

  const rows = []
  const perImageForAgg = []
  const failures = []
  let totalWallMs = 0
  for (const name of imageNames) {
    const buffer = readFileSync(path.join(fixturesDir, name))
    const t0 = Date.now()
    // Per-image isolation: an engine failure on one image (malformed VLM
    // JSON, an ollama transport error, a model without vision support) must
    // not discard the images already scored - a manual GPU run has to come
    // back with every result it managed to produce plus a named failure
    // list, never a bare stack trace and an empty table.
    let detected
    try {
      detected = await engine.detectRegions(buffer)
    } catch (err) {
      failures.push({ name, error: err instanceof Error ? err.message : String(err) })
      totalWallMs += Date.now() - t0
      continue
    }
    const wallMs = Date.now() - t0
    totalWallMs += wallMs
    const scored = scoreImage(labels[name] ?? [], detected)
    perImageForAgg.push(scored)
    rows.push({ name, scored, wallMs })
  }
  const overall = aggregate(perImageForAgg)

  process.stdout.write(renderTable(engineName, rows, overall, totalWallMs) + '\n')
  if (failures.length > 0) {
    process.stdout.write(
      `\n${failures.length}/${imageNames.length} images FAILED (excluded from the table above):\n`
    )
    for (const f of failures) {
      process.stdout.write(`  ${f.name}: ${f.error}\n`)
    }
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
