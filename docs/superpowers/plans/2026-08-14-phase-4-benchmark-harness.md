# Phase 4: Benchmark Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.
> Tasks run sequentially (the store schema and RunReport extension feed every later task).
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The model question answered with evidence: a corpus x roster matrix runner crowns a champion model that becomes the app default via config, not code.

**Architecture:** A benchmark package under `src/core/bench/` reuses `runPipeline` verbatim per (model x corpus item) cell, checkpoints every cell atomically into a filesystem store (tinbox pattern: temp+rename, per-cell key, config-hash match validation), judges quality with a rubric-scoring LLM pass, and renders a self-contained static HTML report plus a repo results doc.
`src/core/champion.ts` resolves the app's default model from `config/champion.json` (falling back to `DEFAULT_MODEL`), so crowning is a config write.
The Electron benchmark dashboard is deferred to Phase 6 by decision (2026-08-14): Phase 4 ships the static HTML report only.

**Tech Stack:** existing core only (pipeline, adapters, OllamaBackend, FitEngine, build-pptx test builder, findAppRoot pattern); zod for judge-response validation; zero new npm dependencies.

**Master plan:** [2026-07-29-local-translate-master-plan.md](2026-07-29-local-translate-master-plan.md)
**Knowledge base:** [2026-07-31-translation-knowledge-base.md](../../research/2026-07-31-translation-knowledge-base.md) items 7 (atomic checkpoint/resume), 9 (per-pair tier table), 10 (quant variants as roster axis: free, roster entries are arbitrary ollama tags), 11 (MT specialists: declined for launch, roster config keeps the door open).

## Decisions locked with Charlie (2026-08-14)

- Launch cohort: `gemma4:e2b`, `gemma4:e4b`, `gemma4:12b`, `qwen3.5:4b`, `qwen3.5:9b`, `qwen3:30b` (all installed; vision leg dropped since PP-OCR won Phase 3).
- Judge model: `qwen3.6:35b` (largest installed; slow with partial CPU offload is acceptable, runs are unattended and resumable).
- Report: static self-contained HTML + JSON + repo results doc; no Electron dashboard this phase; no slide-render dependency (A/B is per-segment text plus inline image artifacts).

## Global Constraints (inherited + phase-specific)

- All master-plan constraints: content preservation absolute, no cloud calls, conventional commits, no co-author lines, TDD, `src/core` Electron-free.
- MACHINE RULES (hard): anything that loads a model on the GPU is run by Charlie, not by an agent or background process.
  Agents hand Charlie a run-tagged command block and wait for pasted output.
  Agent-run tests use fakes or CPU-only paths, are scoped (`vitest run tests/core/bench`), and short.
  ONE subagent at a time.
- Never overcommit the GPU, never crash-retry a model load (RX 9070 XT ROCm leak pattern).
  Encoded in the harness contract: models run strictly sequentially, the previous model is explicitly unloaded before the next loads, `bench run` and `bench judge` are separate commands so cohort and judge models are never co-resident, and a transport-class cell failure aborts that model's remaining cells instead of retrying.
- The store, report, and all bench modules must be pure Node (no Electron imports), same as the rest of `src/core`.
- Evidence standard: artifacts only (report.html + report.json + results doc + champion.json) in `EVIDENCE/phase-4/`, no screenshots of terminal output.
- Report HTML is fully self-contained: inline CSS, no CDN, no external fonts, images embedded as data URIs; every model-produced string is HTML-escaped before interpolation.

## Task sequence

```
Task 1 (RunReport per-segment capture - the data every later task consumes)
  -> Task 2 (corpus.ts + roster/corpus manifests + make-bench-decks.mjs)
    -> Task 3 (store.ts: atomic checkpoint store with config-hash resume)
      -> Task 4 (harness.ts: sequential matrix runner over runPipeline)
        -> Task 5 (metrics.ts: completeness/fidelity/speed families + aggregation)
          -> Task 6 (judge.ts: rubric batch scoring with validation ladder)
            -> Task 7 (report.ts: JSON + self-contained HTML + results doc)
              -> Task 8 (champion.ts + config/champion.json wiring into cli/service)
                -> Task 9 (bench-cli.ts: run/judge/report/crown/status)
                  -> Task 10 (phase gate: Charlie runs the cohort, crowns, evidence)
```

---

### Task 1: RunReport per-segment capture (subagent)

The bench store persists `RunReport` as its cell payload, but today the report carries counts, not texts.
The judge needs (source, translation) pairs, the A/B report needs the same, and the fidelity metric needs per-segment fitted sizes.
Adding a per-segment detail array to `RunReport` makes every stored cell self-contained.

**Files:**

- Modify: `src/core/pipeline.ts`
- Test: `tests/core/pipeline.test.ts` (additions)

**Interfaces produced:**

```ts
// pipeline.ts - RunReport gains one field:
export interface SegmentDetail {
  id: string
  sourceText: string
  /** null when the segment kept its original text (untranslatable, gated, failed). */
  translation: string | null
  /** Populated for every segment that went through fit (i.e. translation !== null). */
  fittedSizePt?: number
  lineCount?: number
}
export interface RunReport {
  // ...existing fields unchanged...
  segments: SegmentDetail[] // one entry per extracted segment, in extract order
}
```

**Behavior contract (each point a test):**

1. Every extracted segment appears exactly once in `report.segments`, in extract order, with `sourceText` verbatim.
2. A translated segment has `translation` set to the resolved translation and `fittedSizePt`/`lineCount` matching what apply() received.
3. A keptOriginal segment (untranslatable, not-source-language, or backend failure) has `translation: null` and no fit fields.
4. `report.segments.length === report.total` always (including the zero-segment document case: empty array).
5. Existing printReport output is unchanged (the field is additive; no formatting change).

- [x] Steps: failing tests on the new field -> implement (collect during the existing translate/fit loops, no extra passes) -> green -> scoped check (`vitest run tests/core/pipeline.test.ts`) -> full `npm run check` -> commit `feat: per-segment detail array in RunReport for benchmark consumption`.

---

### Task 2: Corpus manifests + synthetic hard-case decks (subagent)

**Files:**

- Create: `src/core/bench/corpus.ts`, `fixtures/bench/corpus.json`, `fixtures/bench/roster.json`, `scripts/make-bench-decks.mjs`
- Modify: `.gitignore` (add `fixtures/bench/decks/`), `package.json` (script `"make-bench-decks": "tsx scripts/make-bench-decks.mjs"`)
- Test: `tests/core/bench/corpus.test.ts`

**Interfaces produced:**

```ts
// src/core/bench/corpus.ts
import type { Language } from '../../shared/languages'
export interface CorpusItem {
  id: string // stable slug, e.g. 'real-deck-en-zh'
  file: string // repo-root-relative path
  sourceLang: Language
  targetLang: Language
  kind: 'pptx' | 'image'
  /** Set on generated files: the command that recreates them, used in the missing-file error. */
  regenerate?: string
}
export interface Corpus {
  items: CorpusItem[]
}
export interface Roster {
  models: string[]
  judge: string
}
export function loadCorpus(manifestPath: string, repoRoot: string): Corpus
export function loadRoster(rosterPath: string): Roster
```

**Committed manifest content (`fixtures/bench/corpus.json`):**

```json
{
  "items": [
    {
      "id": "real-deck-en-zh",
      "file": "fixtures/real/CCELL 3.0 AIO Lab Test Updates Mandarin.pptx",
      "sourceLang": "English",
      "targetLang": "Chinese (Simplified)",
      "kind": "pptx"
    },
    {
      "id": "real-deck-zh-en",
      "file": "fixtures/real/CCELL 3.0 AIO Lab Test Updates Mandarin.pptx",
      "sourceLang": "Chinese (Simplified)",
      "targetLang": "English",
      "kind": "pptx"
    },
    {
      "id": "german-compounds-en-de",
      "file": "fixtures/bench/decks/german-compounds.pptx",
      "sourceLang": "English",
      "targetLang": "German",
      "kind": "pptx",
      "regenerate": "npm run make-bench-decks"
    },
    {
      "id": "cjk-table-en-zh",
      "file": "fixtures/bench/decks/cjk-table.pptx",
      "sourceLang": "English",
      "targetLang": "Chinese (Simplified)",
      "kind": "pptx",
      "regenerate": "npm run make-bench-decks"
    },
    {
      "id": "tiny-boxes-en-zh",
      "file": "fixtures/bench/decks/tiny-boxes.pptx",
      "sourceLang": "English",
      "targetLang": "Chinese (Simplified)",
      "kind": "pptx",
      "regenerate": "npm run make-bench-decks"
    },
    {
      "id": "chart-image-en-zh",
      "file": "fixtures/image-regions/real/real-chart-en.png",
      "sourceLang": "English",
      "targetLang": "Chinese (Simplified)",
      "kind": "image"
    },
    {
      "id": "photo-image-en-zh",
      "file": "fixtures/image-regions/real/real-photo-1.jpg",
      "sourceLang": "English",
      "targetLang": "Chinese (Simplified)",
      "kind": "image"
    }
  ]
}
```

**Committed roster content (`fixtures/bench/roster.json`):**

```json
{
  "models": ["gemma4:e2b", "gemma4:e4b", "gemma4:12b", "qwen3.5:4b", "qwen3.5:9b", "qwen3:30b"],
  "judge": "qwen3.6:35b"
}
```

**Generator (`scripts/make-bench-decks.mjs`):** mirrors `scripts/make-gate-decks.mjs` exactly (same `buildPptx` builder from `tests/helpers/build-pptx`, same output-and-log helper), writing three decks to `fixtures/bench/decks/` (gitignored, regenerable):

- `german-compounds.pptx`: 6 text boxes of insurance/engineering register English prone to long German compound translations (e.g. "Motor vehicle liability insurance contract termination notice", "High-pressure fluid containment system maintenance schedule"), 14-18pt in boxes sized so the English fills roughly 80% of the width - compounds must trigger the fit ladder.
- `cjk-table.pptx`: an 8x6 table (48 cells) of short English business phrases at 10pt with tight margins - the dense-CJK-table hard case for EN->ZH.
- `tiny-boxes.pptx`: 8 text boxes at 8pt and 9pt, each barely wider than its English text - the tiny-box hard case.

**Behavior contract (each point a test; generator tested by running it into a temp dir):**

1. `loadCorpus` resolves every `file` against `repoRoot` and throws listing ALL missing files in one error; a missing item with `regenerate` includes that command in the message.
2. `loadCorpus` rejects duplicate ids and any `sourceLang`/`targetLang` not in `LANGUAGES` (import from `src/shared/languages`).
3. `loadRoster` rejects an empty `models` array or a missing/empty `judge`.
4. Generator: running `make-bench-decks.mjs` with a temp out dir produces the three decks, each of which the real `PptxAdapter` (regionEngine null) extracts more than zero segments from - proves the decks are structurally valid the same way gate decks are.
5. The committed `corpus.json`/`roster.json` parse through their loaders in a test (guards manifest drift forever).

- [x] Steps: failing loader tests -> implement loaders -> generator (reusing build-pptx) -> generator test green -> run `npm run make-bench-decks` once locally to confirm output -> scoped check -> commit `feat: benchmark corpus and roster manifests with hard-case deck generator`.

---

### Task 3: store.ts - atomic checkpoint store (subagent)

Knowledge-base item 7 verbatim: temp+rename atomic writes, per-input key, config-match validation on resume.

**Files:**

- Create: `src/core/bench/store.ts`
- Test: `tests/core/bench/store.test.ts`

**Interfaces produced:**

```ts
// src/core/bench/store.ts
import type { RunReport } from '../pipeline'
export interface CellConfig {
  model: string
  itemId: string
  sourceLang: string
  targetLang: string
}
export interface StoredCell {
  config: CellConfig
  configHash: string
  report: RunReport
  /** Store-relative path of the translated artifact copied under artifacts/. */
  artifactPath: string
  completedAt: string // ISO
}
export interface JudgeScore {
  segmentId: string
  accuracy: number // 1..5 integer
  fluency: number // 1..5 integer
  format: number // 1..5 integer
}
export interface StoredJudgement {
  judgeModel: string
  promptVersion: string
  /** configHash of the cell this judgement scored - a re-run cell invalidates it. */
  cellConfigHash: string
  scores: JudgeScore[]
  judgedAt: string
}
export function configHash(config: CellConfig): string // sha256 hex of stable-key-order JSON
export class BenchStore {
  constructor(dir: string) // creates dir/cells, dir/judgements, dir/artifacts on demand
  loadCell(model: string, itemId: string): StoredCell | null
  /** Atomic: writes to <path>.tmp then renames over the destination. */
  saveCell(cell: StoredCell): void
  loadJudgement(judgeModel: string, model: string, itemId: string): StoredJudgement | null
  saveJudgement(model: string, itemId: string, judgement: StoredJudgement): void
  listCells(): StoredCell[]
  /** dir-relative artifact destination for a cell, extension preserved from srcPath. */
  artifactPathFor(model: string, itemId: string, srcPath: string): string
}
export function modelSlug(model: string): string // ':' and '/' -> '-', for filesystem paths
```

Layout: `cells/<modelSlug>/<itemId>.json`, `judgements/<judgeSlug>/<modelSlug>/<itemId>.json`, `artifacts/<modelSlug>/<itemId><ext>`.

**Behavior contract (each point a test, temp dirs):**

1. `configHash` is stable under key insertion order and changes when any field changes.
2. `saveCell` + `loadCell` round-trips; `loadCell` of an absent cell returns null.
3. `saveCell` never leaves a partial file: the write goes to a `.tmp` sibling then renames (test: the final path either absent or fully parseable after a simulated crash, i.e. write the tmp then assert the destination untouched until rename).
4. A corrupt cell file (truncated JSON) makes `loadCell` return null rather than throw - a damaged checkpoint re-runs, never wedges the harness.
5. Judgement round-trip works and is keyed under the judge model, so a judge-model change never collides with old scores.
6. `listCells` returns every stored cell across models, skipping corrupt files.
7. `modelSlug('qwen3.5:9b') === 'qwen3.5-9b'` and slugs never contain path separators.

- [x] Steps: failing tests -> implement -> green -> scoped check -> commit `feat: atomic benchmark checkpoint store with config-hash cells`.

---

### Task 4: harness.ts - sequential matrix runner (subagent)

**Files:**

- Create: `src/core/bench/harness.ts`
- Test: `tests/core/bench/harness.test.ts`

**Interfaces produced:**

```ts
// src/core/bench/harness.ts
import type { CliDeps } from '../cli'
import type { Corpus } from './corpus'
import type { BenchStore } from './store'
export interface HarnessDeps {
  ensureOllama: CliDeps['ensureOllama']
  createBackend: CliDeps['createBackend']
  /** POST /api/generate { model, keep_alive: 0 } - frees VRAM before the next model loads. */
  unloadModel: (baseUrl: string, model: string) => Promise<void>
  /** Injectable so tests use a fake adapter set instead of loading PP-OCR. Same signature as registry.ts's buildAdapters. */
  buildAdapters: (
    deps: import('../adapters/registry').AdapterDeps
  ) => import('../adapters/adapter').FormatAdapter[]
}
export type HarnessEvent =
  | { type: 'model-start' | 'model-done'; model: string }
  | { type: 'cell-start' | 'cell-done' | 'cell-skipped'; model: string; itemId: string }
  | { type: 'cell-failed' | 'model-aborted'; model: string; itemId: string; error: string }
export interface HarnessOpts {
  models: string[]
  corpus: Corpus
  store: BenchStore
  repoRoot: string
  appDataDir: string
  onEvent?: (e: HarnessEvent) => void
}
export interface HarnessSummary {
  completed: number
  skipped: number
  failed: number
}
export async function runMatrix(opts: HarnessOpts, deps: HarnessDeps): Promise<HarnessSummary>
export function realHarnessDeps(): HarnessDeps // production wiring incl. PP-OCR region engine
```

**Behavior contract (each point a test with fake deps; no model, no GPU, no network):**

1. Model-major order: all of model A's cells run before model B starts (model switch is the expensive operation), and `unloadModel` is called exactly once per model, after its last cell and before the next model's first cell.
2. Resume: a cell whose stored `configHash` matches the current config is skipped (`cell-skipped`, backend never called for it); a stored cell with a MISMATCHED hash (e.g. corpus lang edited) re-runs and overwrites.
3. Every completed cell is saved with the full `RunReport`, and the translated output file is copied into the store's artifacts dir at `artifactPathFor(...)` (cells are self-contained: deleting the out dir later never loses evidence).
4. A cell where `runPipeline` throws records `cell-failed`, saves NOTHING for that cell, and continues with the model's next cell - EXCEPT when the error is transport-class (fetch/ECONNREFUSED/failed-to-load detection by error name/message), in which case the model's remaining cells are aborted with `model-aborted` events and the harness moves to the next model.
   Never a retry loop in either case (machine rule: no crash-retry; a resume is Charlie re-running the command).
5. `ensureOllama` is called once for the whole matrix, `connection.stop()` runs exactly once in a finally block even when a model aborts.
6. Summary counts add up: completed + skipped + failed(+aborted, counted in failed) === models x items.
7. Adapter resolution mirrors cli.ts (`buildAdapters` -> `adapterFor` by file extension); an image item resolves the image adapter, a pptx item the pptx adapter.

- [ ] Steps: failing tests (fake backend translating deterministically, FakeAdapter-based corpus items in a temp repo root) -> implement -> green -> scoped check -> commit `feat: resumable corpus x roster benchmark matrix runner`.

---

### Task 5: metrics.ts - metric families + aggregation (subagent)

**Files:**

- Create: `src/core/bench/metrics.ts`
- Test: `tests/core/bench/metrics.test.ts`

**Interfaces produced:**

```ts
// src/core/bench/metrics.ts
import type { RunReport } from '../pipeline'
import type { StoredCell, StoredJudgement } from './store'
import type { Corpus } from './corpus'
export interface MetricFamilies {
  completeness: {
    total: number
    translated: number
    pct: number // 0..100, 100 for a zero-segment document
    keptByReason: Record<string, number>
    skippedUnsupported: number
  }
  fidelity: {
    overflowed: number
    minFittedSizePt: number | null // null when nothing was fitted
    ladderHits: number // groupRetries + perSegmentFallbacks
    unresolvedFailures: number // keptOriginal entries whose reason is NOT an expected passthrough (untranslatable / not-source-language)
  }
  speed: {
    segmentsPerMin: number
    tokensPerSec: number
    durationMs: number
    phaseMs: RunReport['stats']['phaseMs']
  }
}
export function cellMetrics(report: RunReport): MetricFamilies
export interface QualityMetric {
  judged: number
  ofSegments: number
  meanAccuracy: number | null
  meanFluency: number | null
  meanFormat: number | null
  meanOverall: number | null // mean of the three dimension means; null when judged === 0
}
export function judgementQuality(
  judgement: StoredJudgement | null,
  translatedCount: number
): QualityMetric
export type Tier = 'A' | 'B' | 'C' | 'D'
export function tierFor(meanOverall: number): Tier // >= 4.5 A, >= 3.5 B, >= 2.5 C, else D
export function pairKey(sourceLang: string, targetLang: string): string // 'English -> German'
export interface ModelAggregate {
  model: string
  cells: number
  completedAll: boolean // every corpus item has a stored cell
  judgedAll: boolean
  completenessPct: number // segment-weighted across cells
  overflowed: number
  minFittedSizePt: number | null
  ladderHits: number
  segmentsPerMin: number // duration-weighted
  tokensPerSec: number // eval-weighted mean across cells
  meanOverall: number | null // judged-segment-weighted
  tiersByPair: Record<string, Tier | null> // pairKey -> tier, null when unjudged
}
export function aggregate(
  cells: { cell: StoredCell; judgement: StoredJudgement | null }[],
  corpus: Corpus
): ModelAggregate[]
/** Ranking: meanOverall desc (null sorts last), then completenessPct desc, then segmentsPerMin desc. */
export function rankModels(aggregates: ModelAggregate[]): ModelAggregate[]
/** The top-ranked model with completedAll && judgedAll, else null - the crown recommendation. */
export function recommendChampion(ranked: ModelAggregate[]): string | null
```

**Behavior contract (each point a test on hand-built RunReports):**

1. `cellMetrics` completeness: pct = translated/total*100, keptByReason groups the report's keptOriginal reasons, zero-segment report yields pct 100 and zeros elsewhere.
2. Fidelity: `unresolvedFailures` counts only reasons outside {`skipped-untranslatable`, `not-source-language`} (import both constants from pipeline.ts, never re-type the strings); `minFittedSizePt` is the min over `report.segments[].fittedSizePt` and null when none.
3. `judgementQuality` averages each dimension over scores, `meanOverall` is the mean of the three dimension means, and a null judgement yields all-null with judged 0.
4. `tierFor` boundary cases: 4.5 -> A, 3.5 -> B, 2.5 -> C, 2.49 -> D.
5. `aggregate` weights completeness by segment counts (not per-cell mean of pcts), fills `tiersByPair` per corpus pair, and sets `completedAll` false when any corpus item lacks a cell.
6. `rankModels` orders by the documented tri-key and `recommendChampion` skips a higher-scored model that is missing cells or judgements.

- [ ] Steps: failing tests -> implement (pure functions only, no I/O) -> green -> scoped check -> commit `feat: benchmark metric families, per-pair tiers, and champion ranking`.

---

### Task 6: judge.ts - rubric batch scoring (subagent)

**Files:**

- Create: `src/core/bench/judge.ts`
- Test: `tests/core/bench/judge.test.ts`

**Interfaces produced:**

```ts
// src/core/bench/judge.ts
import type { JudgeScore } from './store'
/** Bump on ANY rubric or prompt-text change - stored judgements keyed on it go stale automatically. */
export const JUDGE_PROMPT_VERSION = 'v1'
export const JUDGE_BATCH_SIZE = 8
export interface JudgeInput {
  segmentId: string
  source: string
  translation: string
  sourceLang: string
  targetLang: string
}
export interface JudgeTransport {
  /** One structured chat call: format = the given JSON schema, temperature 0, think off. Returns the raw content string. */
  chat(req: { model: string; system: string; user: string; schema: object }): Promise<string>
}
export function createOllamaJudgeTransport(baseUrl: string): JudgeTransport
export async function judgeSegments(
  inputs: JudgeInput[],
  judgeModel: string,
  transport: JudgeTransport
): Promise<JudgeScore[]>
```

**Rubric (locked here; the system prompt encodes exactly these three dimensions):**

- accuracy 1-5: the translation preserves the full meaning; numbers, names, and codes are intact.
- fluency 1-5: the text reads naturally in the target language for a business document.
- format 1-5: units, placeholders, punctuation conventions, and casing survive appropriately.

The user prompt carries the language pair and a JSON array of `{id, source, translation}`.
The schema demands `{ scores: [{ id, accuracy, fluency, format }] }` with integer bounds 1-5.
Validation ladder mirroring batching.ts's shape: whole-batch call -> on parse failure/id mismatch/out-of-range values, one whole-batch retry -> per-segment fallback calls for the still-unresolved ids -> segments still unresolved after that are OMITTED from the result (the quality metric's `judged` vs `ofSegments` makes the shortfall visible, and a partial score is worse than an honest gap).

**Behavior contract (each point a test with a scripted fake transport; zod parses the response):**

1. Inputs are chunked into batches of `JUDGE_BATCH_SIZE`; a 20-input call makes 3 transport calls on the happy path.
2. A clean response maps ids to scores verbatim; scores round-trip as integers.
3. A malformed batch response (unparseable, unknown id, or a 0/6 value) triggers exactly one whole-batch retry; a clean retry resolves everything with no fallback calls.
4. A still-failing batch after retry falls back per segment; each fallback call carries exactly one input, and only unresolved ids are retried this way.
5. A segment unresolved after its fallback is absent from the result; resolved segments from the same batch are still returned.
6. The transport is called with temperature-0/think-off structured requests (assert on the fake's captured request shape in `createOllamaJudgeTransport`'s own unit test, mocking fetch).
7. An empty `inputs` array returns `[]` with zero transport calls.

- [ ] Steps: failing tests -> implement (zod schema, ladder, chunking) -> green -> scoped check -> commit `feat: llm-judge rubric scoring with batch validation ladder`.

---

### Task 7: report.ts - JSON + self-contained HTML + results doc (subagent)

**Files:**

- Create: `src/core/bench/report.ts`
- Test: `tests/core/bench/report.test.ts`

**Interfaces produced:**

```ts
// src/core/bench/report.ts
import type { Corpus } from './corpus'
import type { BenchStore } from './store'
import type { ModelAggregate } from './metrics'
export interface BenchReport {
  generatedAt: string
  judgeModel: string | null // null when nothing judged yet
  promptVersion: string
  ranking: ModelAggregate[] // rankModels output
  recommended: string | null
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
export function buildReport(store: BenchStore, corpus: Corpus, judgeModel: string): BenchReport
export function renderHtml(report: BenchReport, store: BenchStore): string
export function renderResultsDoc(report: BenchReport): string // markdown, one sentence per line
```

**HTML content (single template-literal document, no framework):**

1. Header: generated timestamp, judge model, prompt version, recommendation banner.
2. Ranking table: model, quality meanOverall, completeness pct, overflow count, min fitted pt, ladder hits, seg/min, tok/s - one row per model, ranked.
3. Per-pair tier table (knowledge-base item 9): rows = models, columns = corpus pairs, cell = tier letter (A-D) color-coded, `-` when unjudged.
4. A/B section per corpus item: a table of source | one column per model showing the translation and its overall score; keptOriginal shows `(kept original)`.
5. Image items additionally show the original and each model's translated artifact inline as data URIs (read via the store's artifact paths; an artifact over 2 MB falls back to its store-relative path as text instead of embedding).
6. Every interpolated string passes through one `escapeHtml` helper - model outputs are untrusted text.

**Behavior contract (each point a test on a store seeded with hand-built cells/judgements in a temp dir):**

1. `buildReport` joins cells and judgements through `aggregate`/`rankModels`/`recommendChampion` and carries the A/B rows for every stored cell (translation null shows through, never dropped).
2. A judgement whose `cellConfigHash` mismatches its cell's current hash is treated as absent (stale judgement never scores a newer run).
3. `renderHtml` output contains no `<script src`, no `http://`/`https://` URL anywhere (self-containment guard), and HTML-escapes a seeded `<script>alert(1)</script>` translation.
4. Small png artifact embeds as a `data:image/png;base64,` URI; an oversized artifact (seed a >2 MB file) renders its path instead.
5. `renderResultsDoc` contains the ranking order, the recommended champion, and the tier table in markdown, with each sentence on its own line.

- [ ] Steps: failing tests -> implement -> green -> scoped check -> commit `feat: benchmark json report, self-contained html, and results doc renderer`.

---

### Task 8: champion.ts + config wiring (subagent)

**Files:**

- Create: `src/core/champion.ts`, `config/champion.json` (initial content: current default, see below)
- Modify: `src/core/cli.ts` (default model = `resolveDefaultModel()`), `src/main/translate-service.ts` (same), `electron-builder.yml` (extraResources ships `config/**` into `resources/config/`)
- Test: `tests/core/champion.test.ts`, additions to `tests/core/cli.test.ts`

**Interfaces produced:**

```ts
// src/core/champion.ts
export interface ChampionState {
  model: string
  crownedAt: string // ISO
  note?: string // e.g. 'phase-4 launch cohort, report 2026-08-xx'
}
/** config/champion.json resolved like fonts.ts resolves fonts/: packaged resources path first, then findAppRoot walk. */
export function readChampion(): ChampionState | null // null on missing or malformed (one console.warn on malformed)
export function resolveDefaultModel(): string // readChampion()?.model ?? DEFAULT_MODEL
export function writeChampion(state: ChampionState, repoRoot: string): void // atomic temp+rename, used by bench crown
```

Initial committed `config/champion.json`:

```json
{
  "model": "gemma4:e4b",
  "crownedAt": "2026-08-14T00:00:00.000Z",
  "note": "pre-benchmark placeholder, equals DEFAULT_MODEL until the phase-4 cohort crowns"
}
```

**Behavior contract (each point a test; resolution helper takes an injectable candidate-dir list like fonts.ts's internals do):**

1. A valid champion file wins over `DEFAULT_MODEL`; a missing file falls back to `DEFAULT_MODEL` silently; malformed JSON falls back with a single warn.
2. A champion entry with an empty/non-string `model` counts as malformed.
3. `writeChampion` + `readChampion` round-trips and the write is atomic (tmp sibling then rename).
4. cli.ts: a run without `--model` uses `resolveDefaultModel()` (test via `_internals`/parseArgs default and a fabricated champion file); `--model` still overrides.
5. translate-service.ts compiles against the same helper (its existing service test keeps passing with the import swapped).
6. `defaults.ts`'s doc comment is updated to point at champion.ts as the config layer (DEFAULT_MODEL stays as the ultimate fallback; no literal duplication anywhere - the existing defaults test still enforces it).

- [ ] Steps: failing tests -> implement -> wire both call sites + electron-builder.yml -> green -> full `npm run check` -> commit `feat: champion model config resolved as app default`.

---

### Task 9: bench-cli.ts - subcommands (subagent)

**Files:**

- Create: `src/core/bench/bench-cli.ts`
- Modify: `package.json` (script `"bench": "tsx src/core/bench/bench-cli.ts"`)
- Test: `tests/core/bench/bench-cli.test.ts`

**Interfaces produced:**

```ts
// src/core/bench/bench-cli.ts
export interface BenchCliDeps {
  harnessDeps: import('./harness').HarnessDeps
  ensureOllama: import('../cli').CliDeps['ensureOllama'] // for judge's own connection
  createJudgeTransport: (baseUrl: string) => import('./judge').JudgeTransport
}
export async function runBenchCli(argv: string[], deps?: BenchCliDeps): Promise<number>
```

Subcommands (all take `--roster`, `--corpus`, `--store` with the fixture-path defaults):

- `run`: load roster + corpus, `runMatrix`, print the summary; exit 0 when failed === 0, else 1.
- `judge`: for every stored cell lacking a current judgement (absent, stale hash, or old prompt version), build `JudgeInput`s from `report.segments` (translated ones only), `judgeSegments`, save; one ensureOllama connection for the whole pass; exit 0 when every judged cell saved.
- `judge --stability`: score the first stored cell 3 times fresh (no saving), print each pass's meanOverall and the max-min spread; PASS at spread <= 0.25, exit 1 on FAIL - the master plan's judge-prompt stability test.
- `report`: buildReport -> write `<store>/report.json` + `<store>/report.html` + print the ranking table to stdout.
- `crown [model]`: with no arg, `recommendChampion` (refuse with exit 1 and a reason when null); with an arg, that model (must exist in the ranking); `writeChampion` into `config/champion.json`, print old -> new.
- `status`: cells completed/missing per model x item grid, judgements current/stale counts.

**Behavior contract (each point a test with injected fakes, temp store dirs):**

1. Unknown subcommand or bad flag prints usage and exits 1 (mirror cli.ts's parse-then-run split so parsing is testable pure).
2. `run` exit codes: 0 all-complete, 1 when any cell failed.
3. `judge` skips cells whose judgement is current and re-judges stale ones (hash or prompt-version mismatch); the transport fake records exactly the expected call count.
4. `judge --stability` makes 3 independent passes and applies the 0.25 spread gate.
5. `crown` with no stored cells refuses; `crown` writes through `writeChampion` and the file round-trips.
6. `status` output lists every roster model x corpus item with its state (spot-check the grid string).
7. `npm run bench -- status` works end to end against an empty store (integration smoke in the test via runBenchCli with real deps constructed but no network touched by `status`).

- [ ] Steps: failing tests -> implement -> green -> scoped check + full `npm run check` -> commit `feat: bench cli - run, judge, report, crown, status`.

---

### Task 10: Phase gate - launch cohort run, crown, evidence (Charlie runs)

**Files:**

- Create: `EVIDENCE/phase-4/` (report.html, report.json, README), `docs/research/<date>-phase-4-benchmark-results.md` (from `renderResultsDoc`, plus Charlie's verdict notes)
- Modify: `config/champion.json` (the real crowning), ledger + this plan's checkboxes

**Gate checklist (Charlie's run-tagged blocks + eyeball):**

1. `npm run make-bench-decks` then `npm run bench -- run` completes the 6x7 matrix unattended (GPU, Charlie); a mid-run Ctrl+C followed by re-run demonstrably resumes (skipped counts > 0 on the second invocation) - the resumability requirement live.
2. `npm run bench -- judge --stability` PASSES (spread <= 0.25) before the full judge pass; then `npm run bench -- judge` completes.
3. `npm run bench -- report`: ranking covers all four metric families for all six models; per-pair tier table populated; A/B section spot-checked on the real deck and both image items.
4. `npm run bench -- crown` writes the champion; a fresh `npm run translate` WITHOUT `--model` reports the champion in its stats block (proves config-not-code).
5. Challenger flow proven cheap: add any installed model to roster.json, `bench -- run` runs ONLY the new cells (status shows the rest skipped) - then revert the roster edit or keep it, Charlie's call.
6. Evidence: report.html + report.json copied to `EVIDENCE/phase-4/` with a README naming the commit and crowning; results doc committed under docs/research/.

- [ ] Steps: hand Charlie the run blocks -> collect pasted outputs -> evidence + results doc -> commit `docs: phase 4 evidence (benchmark report, champion crowned)` -> ledger + master-plan progress + this plan's checkboxes.

---

## Self-review notes

- Spec coverage: master-plan tasks 1-5 and 7 map to Tasks 2-9 and 10 here; master-plan task 6 (dashboard UI + A/B slide viewer) is descoped to the static HTML A/B by Charlie's 2026-08-14 decision and the Electron dashboard moves to Phase 6 (where "full app: benchmark dashboard" already lives in the design doc's UI phase 2); the design doc's challenger flow is gate item 5, delivered by resume semantics instead of new code.
- Knowledge-base coverage: item 7 -> Task 3; item 9 -> Tasks 5/7; item 10 -> free via roster tags (noted in header); item 11 -> declined for launch, no task.
- Type consistency: `StoredCell`/`StoredJudgement`/`JudgeScore` (Task 3) are consumed verbatim by Tasks 4-7 and 9; `SegmentDetail` (Task 1) feeds judge inputs (Task 9's judge subcommand) and the A/B rows (Task 7); `CliDeps` reuse keeps ensureOllama/createBackend types identical to cli.ts.
- The judge pass costs roughly 42 cells x ~10-100 batches on a partially-offloaded 35B - hours, not minutes; accepted per master plan ("runs are resumable and unattended") and mitigated by judgement checkpointing (Task 3) and the separate `bench judge` command.
