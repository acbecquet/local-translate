/**
 * Turns a BenchStore's contents into the artifact a human reads to pick a
 * champion: a lean JSON model (BenchReport, written as report.json by the
 * bench-cli's `report` subcommand - Task 9), a self-contained HTML page
 * (report.html - renders correctly with zero network access, ever), and a
 * markdown results doc for docs/research/.
 *
 * buildReport is the only place that decides whether a stored judgement is
 * CURRENT: a judgement whose cellConfigHash no longer matches its cell's own
 * configHash (the cell was re-run since it was judged - a corpus edit, a
 * model re-run) or whose promptVersion no longer matches JUDGE_PROMPT_VERSION
 * (the rubric changed) is exactly as good as no judgement at all. Both cases
 * are checked in isCurrentJudgement and fed to metrics.ts as a plain `null`,
 * never the stale StoredJudgement - a stale judgement must never score a
 * newer run. This is decided ONCE and reused for both the model-level
 * aggregation (aggregate, via metrics.ts) and the per-segment A/B rows
 * (buildAbByItem) - the two must never disagree about which judgements are
 * live.
 *
 * renderHtml and renderResultsDoc both consume ONLY the already-built
 * BenchReport for their numbers/ranking/tiers - neither re-derives ranking,
 * tiers, or scores (that is exactly the "do not recompute" rule: all of it
 * is ModelAggregate data metrics.ts already computed inside buildReport).
 * renderHtml also takes the BenchStore, but strictly for filesystem access
 * that a lean, JSON-serializable BenchReport deliberately does not carry:
 * reading each stored cell's translated artifact bytes to embed as a data
 * URI, and reading the cell's own RunReport.file to find an image item's
 * pre-translation original. Nothing about ranking or scoring is read from
 * the store a second time - only bytes and paths.
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Corpus } from './corpus'
import { JUDGE_PROMPT_VERSION } from './judge'
import {
  aggregate,
  MIN_CHAMPION_DELIVERED_PCT,
  pairKey,
  rankModels,
  recommendChampion,
  type ChampionExclusion,
  type ModelAggregate,
  type Tier
} from './metrics'
import type { BenchStore, StoredCell, StoredJudgement } from './store'

export interface BenchReport {
  generatedAt: string
  judgeModel: string | null // null when nothing judged yet
  promptVersion: string
  ranking: ModelAggregate[] // rankModels output
  recommended: string | null
  /** Models that outranked `recommended` on quality but were passed over for delivering too little content (metrics.ts's MIN_CHAMPION_DELIVERED_PCT). Empty when the floor never bit. Carried so the banner can name them: being passed over on the project's top-line content-preservation constraint must never be a silent skip. */
  excludedForCompleteness: ChampionExclusion[]
  corpusItems: { id: string; pair: string; kind: string; segments: number }[]
  /** Per item: rows of segment-level A/B - source + each model's translation with its overall judge score. */
  abByItem: Record<
    string,
    {
      segmentId: string
      source: string
      byModel: Record<string, { translation: string | null; overall: number | null }>
    }[]
  >
}

type CellJudgement = { cell: StoredCell; judgement: StoredJudgement | null }

/**
 * True exactly when `judgement` still scores the cell AS IT CURRENTLY
 * STANDS under the CURRENT rubric - both halves of the correctness trap
 * from the task brief: a hash mismatch means the cell was re-run since this
 * judgement was saved, a prompt-version mismatch means the rubric itself
 * moved on. Either failure makes the judgement stale, and stale is absent.
 */
function isCurrentJudgement(
  cell: StoredCell,
  judgement: StoredJudgement | null
): judgement is StoredJudgement {
  if (judgement === null) return false
  if (judgement.cellConfigHash !== cell.configHash) return false
  if (judgement.promptVersion !== JUDGE_PROMPT_VERSION) return false
  return true
}

/**
 * Per-segment overall: mean of the three rubric dimensions for the one
 * JudgeScore matching segmentId, null when that segment was never scored
 * (no current judgement at all, or the judge omitted this id). This is the
 * segment-level counterpart to metrics.ts's judgementQuality, which averages
 * a whole cell rather than one row of the A/B table.
 */
function segmentOverall(judgement: StoredJudgement | null, segmentId: string): number | null {
  const score = judgement?.scores.find((s) => s.segmentId === segmentId)
  if (score === undefined) return null
  return (score.accuracy + score.fluency + score.format) / 3
}

/**
 * One A/B row list per corpus item. The segment id/source-text order for an
 * item is read off ONE of its cells (sorted by model name for a
 * deterministic pick) - every model translating the same corpus item
 * extracts from the same source file, so the segment set is the same
 * regardless of which cell supplies it. Each row's byModel only contains an
 * entry for a model that actually has a cell for this item (never a
 * fabricated placeholder for a model that was never run here); within that,
 * a segment the model kept original carries `translation: null` straight
 * through, never dropped and never coerced to the string "null".
 */
function buildAbByItem(
  corpus: Corpus,
  cellsWithJudgement: CellJudgement[]
): BenchReport['abByItem'] {
  const abByItem: BenchReport['abByItem'] = {}

  for (const item of corpus.items) {
    const itemCells = cellsWithJudgement
      .filter((c) => c.cell.config.itemId === item.id)
      .sort((a, b) => a.cell.config.model.localeCompare(b.cell.config.model))

    if (itemCells.length === 0) {
      abByItem[item.id] = []
      continue
    }

    const baseSegments = itemCells[0].cell.report.segments

    abByItem[item.id] = baseSegments.map((segment) => {
      const byModel: Record<string, { translation: string | null; overall: number | null }> = {}
      for (const { cell, judgement } of itemCells) {
        const modelSegment = cell.report.segments.find((s) => s.id === segment.id)
        byModel[cell.config.model] = {
          translation: modelSegment ? modelSegment.translation : null,
          overall: segmentOverall(judgement, segment.id)
        }
      }
      return { segmentId: segment.id, source: segment.sourceText, byModel }
    })
  }

  return abByItem
}

export function buildReport(store: BenchStore, corpus: Corpus, judgeModel: string): BenchReport {
  const cells = store.listCells()
  const cellsWithJudgement: CellJudgement[] = cells.map((cell) => {
    const stored = store.loadJudgement(judgeModel, cell.config.model, cell.config.itemId)
    return { cell, judgement: isCurrentJudgement(cell, stored) ? stored : null }
  })

  const ranking = rankModels(aggregate(cellsWithJudgement, corpus))
  const recommendation = recommendChampion(ranking)
  const anyCurrentJudgement = cellsWithJudgement.some((c) => c.judgement !== null)

  const firstCellByItemId = new Map(cells.map((c) => [c.config.itemId, c]))
  const corpusItems = corpus.items.map((item) => ({
    id: item.id,
    pair: pairKey(item.sourceLang, item.targetLang),
    kind: item.kind,
    segments: firstCellByItemId.get(item.id)?.report.total ?? 0
  }))

  return {
    generatedAt: new Date().toISOString(),
    judgeModel: anyCurrentJudgement ? judgeModel : null,
    promptVersion: JUDGE_PROMPT_VERSION,
    ranking,
    recommended: recommendation.model,
    excludedForCompleteness: recommendation.excludedForCompleteness,
    corpusItems,
    abByItem: buildAbByItem(corpus, cellsWithJudgement)
  }
}

// --- renderHtml --------------------------------------------------------

/** Over this size, an artifact renders its path as text instead of embedding - see the task brief's self-containment-without-ballooning rule. */
const MAX_INLINE_ARTIFACT_BYTES = 2 * 1024 * 1024

/** The one escaping choke point for every model-produced or otherwise untrusted string this module interpolates into HTML - translations, source text, model names, corpus ids. Never bypassed, never applied twice. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatNumber(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0'
}

function formatNullableNumber(value: number | null, digits: number): string {
  return value === null ? '-' : value.toFixed(digits)
}

function tierClass(tier: Tier | null): string {
  return tier === null ? 'tier-none' : `tier-${tier.toLowerCase()}`
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return 'application/octet-stream'
}

/**
 * Reads `absPath` and returns an <img> tag with its bytes inlined as a data
 * URI, UNLESS the file is missing or over MAX_INLINE_ARTIFACT_BYTES - either
 * way this falls back to escaped text naming `fallbackLabel` instead, so the
 * page can never balloon on an oversized artifact and never throws on a
 * missing one (HTML content requirement 5 / contract point 4).
 */
function renderArtifactImage(absPath: string, fallbackLabel: string, altText: string): string {
  let size: number
  try {
    size = statSync(absPath).size
  } catch {
    return `<p class="artifact-missing">(artifact unavailable: ${escapeHtml(fallbackLabel)})</p>`
  }

  if (size > MAX_INLINE_ARTIFACT_BYTES) {
    const sizeMb = (size / (1024 * 1024)).toFixed(1)
    return `<p class="artifact-toolarge">(${sizeMb} MB, too large to embed) ${escapeHtml(fallbackLabel)}</p>`
  }

  const bytes = readFileSync(absPath)
  const dataUri = `data:${mimeFor(absPath)};base64,${bytes.toString('base64')}`
  return `<img class="artifact-image" alt="${escapeHtml(altText)}" src="${dataUri}">`
}

const STYLE = `
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 2rem; line-height: 1.5; }
h1, h2, h3 { line-height: 1.25; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #8888; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: rgba(128, 128, 128, 0.15); }
.banner { padding: 0.75rem 1rem; border-radius: 0.5rem; font-weight: 600; margin: 1rem 0; }
.banner-ok { background: rgba(26, 127, 55, 0.1); border: 1px solid #1a7f37; }
.banner-pending { background: rgba(154, 103, 0, 0.1); border: 1px solid #9a6700; }
.tier-a { background: rgba(26, 127, 55, 0.2); }
.tier-b { background: rgba(9, 105, 218, 0.2); }
.tier-c { background: rgba(154, 103, 0, 0.2); }
.tier-d { background: rgba(207, 34, 46, 0.2); }
.tier-none { color: #888; }
.translation { white-space: pre-wrap; }
.score { color: #888; font-size: 0.85em; }
.images { display: flex; flex-wrap: wrap; gap: 1rem; }
.images figure { margin: 0; max-width: 320px; }
.artifact-image { max-width: 100%; height: auto; border: 1px solid #8888; }
.artifact-missing, .artifact-toolarge, .no-data { color: #888; font-style: italic; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
dl.meta dt { font-weight: 600; }
`

/**
 * The sentences naming every model the completeness floor passed over, or an
 * empty array when the floor never bit. Shared wording between the HTML
 * banner and the results doc so the two artifacts can never disagree about
 * why a higher-scoring model was not crowned - a silent skip on the
 * project's top-line content-preservation constraint is exactly what this
 * exists to prevent.
 *
 * Returned as one string PER SENTENCE rather than one joined paragraph
 * because the markdown caller writes each on its own physical line (this
 * repo's docs convention, which renderResultsDoc's own doc comment states);
 * the HTML caller joins them back into one banner.
 */
function completenessExclusionSentences(exclusions: ChampionExclusion[]): string[] {
  if (exclusions.length === 0) return []
  const named = exclusions
    .map((e) => `${e.model} (delivered ${e.deliveredPct.toFixed(1)}%)`)
    .join(', ')
  const subject = exclusions.length === 1 ? 'model was' : 'models were'
  return [
    `Higher-ranked ${subject} passed over for insufficient completeness: ${named}.`,
    `A champion must deliver at least ${MIN_CHAMPION_DELIVERED_PCT}% of the content it was asked ` +
      'to translate, however well it scores on what it did translate.'
  ]
}

function renderHeader(report: BenchReport): string {
  const bannerText = report.recommended
    ? `Recommended champion: ${escapeHtml(report.recommended)}`
    : 'No champion recommended yet - a model needs every corpus item completed and judged.'

  const exclusionSentences = completenessExclusionSentences(report.excludedForCompleteness)
  const exclusionBanner =
    exclusionSentences.length === 0
      ? ''
      : `\n  <div class="banner banner-pending">${escapeHtml(exclusionSentences.join(' '))}</div>`

  return `
<header>
  <h1>Benchmark Report</h1>
  <dl class="meta">
    <dt>Generated</dt><dd>${escapeHtml(report.generatedAt)}</dd>
    <dt>Judge model</dt><dd>${escapeHtml(report.judgeModel ?? 'not judged yet')}</dd>
    <dt>Prompt version</dt><dd>${escapeHtml(report.promptVersion)}</dd>
  </dl>
  <div class="banner ${report.recommended ? 'banner-ok' : 'banner-pending'}">${bannerText}</div>${exclusionBanner}
</header>`
}

function renderRankingTable(ranking: ModelAggregate[]): string {
  const rows = ranking
    .map(
      (m) => `
      <tr>
        <td>${escapeHtml(m.model)}</td>
        <td>${formatNullableNumber(m.meanOverall, 2)}</td>
        <td>${m.judged} / ${m.ofSegments}</td>
        <td>${formatNumber(m.completenessPct, 1)}%</td>
        <td>${formatNumber(m.deliveredPct, 1)}%</td>
        <td>${m.overflowed}</td>
        <td>${formatNullableNumber(m.minFittedSizePt, 1)}</td>
        <td>${m.ladderHits}</td>
        <td>${formatNumber(m.segmentsPerMin, 2)}</td>
        <td>${formatNumber(m.tokensPerSec, 2)}</td>
      </tr>`
    )
    .join('')

  return `
<table class="ranking">
  <thead>
    <tr>
      <th>Model</th><th>Quality (mean overall)</th><th>Judged (of translated)</th>
      <th>Completeness</th><th>Delivered</th><th>Overflow</th>
      <th>Min fitted pt</th><th>Ladder hits</th><th>Seg/min</th><th>Tok/s</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`
}

function renderTierTable(report: BenchReport): string {
  const pairs = [...new Set(report.corpusItems.map((i) => i.pair))]
  const headerCells = pairs.map((pair) => `<th>${escapeHtml(pair)}</th>`).join('')

  const rows = report.ranking
    .map((m) => {
      const cells = pairs
        .map((pair) => {
          const tier = m.tiersByPair[pair] ?? null
          return `<td class="${tierClass(tier)}">${tier ?? '-'}</td>`
        })
        .join('')
      return `<tr><td>${escapeHtml(m.model)}</td>${cells}</tr>`
    })
    .join('')

  return `
<table class="tiers">
  <thead><tr><th>Model</th>${headerCells}</tr></thead>
  <tbody>${rows}</tbody>
</table>`
}

/** The original + each model's translated artifact for one image-kind corpus item, as inline data URIs (or a text fallback - see renderArtifactImage). */
function renderImageArtifacts(
  itemId: string,
  models: string[],
  store: BenchStore,
  cellByKey: Map<string, StoredCell>
): string {
  const anyCell = models.map((m) => cellByKey.get(`${m}::${itemId}`)).find((c) => c !== undefined)
  // basename, never the full report.file path: unlike the per-model
  // artifacts below (whose labels are store-RELATIVE and therefore portable),
  // report.file is an absolute path on whichever machine ran the benchmark,
  // and this page is destined for EVIDENCE/phase-4/, which is committed and
  // shared. The filename is all a reader needs to identify the original.
  const originalHtml = anyCell
    ? renderArtifactImage(
        anyCell.report.file,
        path.basename(anyCell.report.file),
        `${itemId} original`
      )
    : '<p class="artifact-missing">(no runs recorded, nothing to show)</p>'

  const perModelHtml = models
    .map((model) => {
      const cell = cellByKey.get(`${model}::${itemId}`)
      if (!cell) return ''
      const absPath = path.join(store.dir, cell.artifactPath)
      return `
      <figure>
        <figcaption>${escapeHtml(model)}</figcaption>
        ${renderArtifactImage(absPath, cell.artifactPath, `${itemId} translated by ${model}`)}
      </figure>`
    })
    .join('')

  return `
<div class="images">
  <figure><figcaption>Original</figcaption>${originalHtml}</figure>
  ${perModelHtml}
</div>`
}

function renderItemSection(
  item: BenchReport['corpusItems'][number],
  report: BenchReport,
  store: BenchStore,
  cellByKey: Map<string, StoredCell>
): string {
  const rows = report.abByItem[item.id] ?? []
  const models = rows.length > 0 ? Object.keys(rows[0].byModel) : []

  const headerCells = models.map((m) => `<th>${escapeHtml(m)}</th>`).join('')
  const bodyRows = rows
    .map((row) => {
      const cells = models
        .map((model) => {
          const cell = row.byModel[model]
          const translationText = cell.translation === null ? '(kept original)' : cell.translation
          const overallText = cell.overall === null ? '-' : cell.overall.toFixed(2)
          return `<td><div class="translation">${escapeHtml(translationText)}</div><div class="score">${overallText}</div></td>`
        })
        .join('')
      return `<tr><td class="source">${escapeHtml(row.source)}</td>${cells}</tr>`
    })
    .join('')

  const table =
    rows.length === 0
      ? '<p class="no-data">(no runs recorded yet for this item)</p>'
      : `<table class="ab-table"><thead><tr><th>Source</th>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`

  const imagesHtml =
    item.kind === 'image' ? renderImageArtifacts(item.id, models, store, cellByKey) : ''

  return `
<article class="item">
  <h3>${escapeHtml(item.id)} <span class="pair">${escapeHtml(item.pair)}</span></h3>
  ${table}
  ${imagesHtml}
</article>`
}

export function renderHtml(report: BenchReport, store: BenchStore): string {
  const cellByKey = new Map<string, StoredCell>()
  for (const cell of store.listCells()) {
    cellByKey.set(`${cell.config.model}::${cell.config.itemId}`, cell)
  }

  const sections = report.corpusItems
    .map((item) => renderItemSection(item, report, store, cellByKey))
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Benchmark Report</title>
<style>${STYLE}</style>
</head>
<body>
${renderHeader(report)}
<section class="ranking-section">
  <h2>Ranking</h2>
  ${renderRankingTable(report.ranking)}
</section>
<section class="tiers-section">
  <h2>Per-pair quality tiers</h2>
  ${renderTierTable(report)}
</section>
<section class="ab-section">
  <h2>A/B comparison by corpus item</h2>
  ${sections}
</section>
</body>
</html>`
}

// --- renderResultsDoc ----------------------------------------------------

/**
 * Escapes the one character that can structurally break a markdown table
 * cell: a literal `|`, which would otherwise read as a column separator and
 * silently split one cell into two for the rest of that row. Model names are
 * arbitrary ollama tags read from roster.json, and corpus ids and language
 * pair labels are equally free-form, so every interpolated cell value goes
 * through this - the table-cell counterpart to renderHtml's escapeHtml choke
 * point, applied for the same reason (this doc is committed under
 * docs/research/).
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|')
}

/**
 * Markdown for docs/research/: one full sentence per physical line (this
 * repo's markdown convention) outside of headings and table rows, which are
 * structural, not prose.
 */
export function renderResultsDoc(report: BenchReport): string {
  const lines: string[] = []

  lines.push('# Benchmark Results')
  lines.push('')
  lines.push(`This report was generated at ${report.generatedAt}.`)
  lines.push(
    report.judgeModel
      ? `Scores come from judge model ${report.judgeModel} using prompt version ${report.promptVersion}.`
      : `No judgement scores are available yet for prompt version ${report.promptVersion}.`
  )
  lines.push(
    report.recommended
      ? `The recommended champion is ${report.recommended}.`
      : 'No model qualifies as champion yet - every corpus item must be completed and judged.'
  )
  lines.push(...completenessExclusionSentences(report.excludedForCompleteness))
  lines.push('')

  lines.push('## Ranking')
  lines.push('')
  lines.push(
    '| Rank | Model | Quality | Judged | Completeness | Delivered | Overflow | Min fitted pt | Ladder hits | Seg/min | Tok/s |'
  )
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  report.ranking.forEach((m, i) => {
    lines.push(
      `| ${i + 1} | ${escapeCell(m.model)} | ${formatNullableNumber(m.meanOverall, 2)} | ` +
        `${m.judged} / ${m.ofSegments} | ${formatNumber(m.completenessPct, 1)}% | ` +
        `${formatNumber(m.deliveredPct, 1)}% | ${m.overflowed} | ` +
        `${formatNullableNumber(m.minFittedSizePt, 1)} | ${m.ladderHits} | ` +
        `${formatNumber(m.segmentsPerMin, 2)} | ${formatNumber(m.tokensPerSec, 2)} |`
    )
  })
  lines.push('')

  lines.push('## Per-pair quality tiers')
  lines.push('')
  const pairs = [...new Set(report.corpusItems.map((i) => i.pair))]
  lines.push(`| Model | ${pairs.map(escapeCell).join(' | ')} |`)
  lines.push(`| --- | ${pairs.map(() => '---').join(' | ')} |`)
  for (const m of report.ranking) {
    const cells = pairs.map((pair) => m.tiersByPair[pair] ?? '-')
    lines.push(`| ${escapeCell(m.model)} | ${cells.join(' | ')} |`)
  }
  lines.push('')

  return lines.join('\n')
}
