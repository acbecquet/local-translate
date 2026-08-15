// CLI entry point that ties every phase-4 benchmark module into the commands
// the project owner actually runs: `npm run bench -- <run|judge|report|crown|status>
// [--roster <path>] [--corpus <path>] [--store <path>]`. Mirrors src/core/cli.ts's
// shape exactly: a pure `parseArgs` split from the executor, `runBenchCli`
// resolving to an exit code and never calling process.exit() itself, an
// injectable deps object (BenchCliDeps) defaulting to real implementations,
// and an `_internals` export for testing.
//
// Subcommands:
//   run     - loadRoster + loadCorpus, runMatrix, print the summary.
//             Exit 0 when failed === 0, else 1.
//   judge   - for every stored cell lacking a CURRENT judgement (absent,
//             hash-stale, or prompt-version-stale), build JudgeInputs from
//             the cell's translated segments, judgeSegments, save. One
//             ensureOllama connection for the whole pass. On a
//             JudgeBatchFailure the WHOLE PASS aborts (not just the failing
//             cell): nothing is ever saved for the cell that failed, and
//             every cell after it in processing order is never attempted -
//             see the HARD constraint note on judgeOneCell below for why a
//             partial judgement must never reach disk. Exit 0 when every
//             judged cell saved, 1 on any abort.
//   judge --stability - scores the FIRST stored cell (deterministic:
//             sorted by model then itemId, not raw store iteration order)
//             3 times fresh, saving nothing, and gates at
//             max(meanOverall) - min(meanOverall) <= 0.25. PASS -> exit 0,
//             FAIL -> exit 1 - the master plan's judge-prompt stability
//             test.
//   report  - buildReport, write <store>/report.json + <store>/report.html,
//             print the ranking table to stdout. Exit 0 on success.
//   crown [model] - with no arg, recommendChampion (refuse with exit 1 and
//             a stated reason when it returns null - no model is both
//             completedAll and judgedAll yet); with an arg, that model must
//             already have at least one stored cell (appear in the
//             ranking), else refuse. Either way writeChampion into
//             config/champion.json and print "old -> new".
//   status  - a model x item grid (roster models x corpus items) of
//             missing/done, and each done cell's judgement state (current /
//             stale / unjudged). Reads roster+corpus+store only - NEVER
//             touches ensureOllama, harnessDeps, or createJudgeTransport,
//             so it never touches the network even with real deps (a
//             HARD machine rule, verified by this module's own test suite
//             stubbing global fetch to throw and asserting it's never
//             called).
//
// repoRoot (used to resolve corpus item files, and as writeChampion's
// target repo) is resolved once via findAppRoot from this module's own
// location - the same mechanism champion.ts and fonts.ts use - never via a
// CLI flag: the "Interfaces produced" contract for BenchCliDeps has no
// repoRoot field, and crowning must always target the real repo's
// config/champion.json (see champion.ts's writeChampion doc comment: this
// is deliberately a dev-time-only operation, never something a packaged
// install resolves against its own resourcesPath). A test-only override
// (setRepoRootForTesting, exposed via _internals) mirrors champion.ts's own
// configDirOverride escape hatch, so tests never read or write the real
// repo's fixtures/config - see _internals below.
import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findAppRoot } from '../app-root'
import type { CliDeps } from '../cli'
import { writeChampion } from '../champion'
import { ensureOllama as realEnsureOllama } from '../translate/ollama/lifecycle'
import { loadCorpus, loadRoster, type Corpus, type Roster } from './corpus'
import { BenchStore, type StoredCell, type StoredJudgement } from './store'
import { realHarnessDeps, runMatrix, type HarnessDeps, type HarnessEvent } from './harness'
import { aggregate, judgementQuality, rankModels, recommendChampion } from './metrics'
import {
  createOllamaJudgeTransport,
  judgeSegments,
  JudgeBatchFailure,
  JUDGE_PROMPT_VERSION,
  type JudgeInput,
  type JudgeTransport
} from './judge'
import { buildReport, renderHtml, type BenchReport } from './report'

export interface BenchCliDeps {
  harnessDeps: HarnessDeps
  ensureOllama: CliDeps['ensureOllama'] // for judge's own connection
  createJudgeTransport: (baseUrl: string) => JudgeTransport
}

// --- repoRoot resolution (test-only override, mirrors champion.ts) ---------

let repoRootOverride: string | null = null

function resolveRepoRoot(): string {
  return repoRootOverride ?? findAppRoot(path.dirname(fileURLToPath(import.meta.url)))
}

function defaultCorpusPath(): string {
  return path.join(resolveRepoRoot(), 'fixtures', 'bench', 'corpus.json')
}

function defaultRosterPath(): string {
  return path.join(resolveRepoRoot(), 'fixtures', 'bench', 'roster.json')
}

/** Not a committed fixture like corpus.json/roster.json - a generated, gitignored working directory (fixtures/bench/store/, mirroring the already-established fixtures/bench/decks/ precedent) that a real run's cells/judgements/artifacts land in by default. */
function defaultStorePath(): string {
  return path.join(resolveRepoRoot(), 'fixtures', 'bench', 'store')
}

/**
 * Same resolution cli.ts's resolveAppDataDir uses (LOCALAPPDATA when set,
 * else homedir()/AppData/Local), duplicated here rather than imported: that
 * function only exists on cli.ts's `_internals` (a test-only-labeled escape
 * hatch), and this is a small, self-contained, four-line computation - the
 * same "duplicate a small helper rather than couple two independent CLI
 * modules" call harness.ts's BACKEND_TRANSPORT_FAILURE_REASON and judge.ts's
 * stripThinkTags both already make.
 */
function resolveAppDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'local_translate')
}

// --- usage/parseArgs (pure) -------------------------------------------------

const KNOWN_COMMANDS = ['run', 'judge', 'report', 'crown', 'status'] as const
type CommandName = (typeof KNOWN_COMMANDS)[number]

interface BaseFlags {
  roster: string
  corpus: string
  store: string
}
type BenchCommand =
  | ({ cmd: 'run' } & BaseFlags)
  | ({ cmd: 'judge'; stability: boolean } & BaseFlags)
  | ({ cmd: 'report' } & BaseFlags)
  | ({ cmd: 'crown'; model: string | null } & BaseFlags)
  | ({ cmd: 'status' } & BaseFlags)

type ParseResult = { ok: true; command: BenchCommand } | { ok: false; error: string }

/**
 * Built fresh on every call, never cached at module scope - the default
 * --corpus/--roster/--store paths it names are resolved via
 * resolveRepoRoot(), which a test can redirect mid-suite
 * (setRepoRootForTesting); a cached string would keep advertising a stale
 * repoRoot. Mirrors cli.ts's own usage() (resolveDefaultModel() read live on
 * every call) - the pattern this task's brief calls out explicitly to
 * mirror, not just cli.ts's specific champion-file reason for it.
 */
function usage(): string {
  return (
    'Usage: bench <run|judge|report|crown|status> [options]\n' +
    '  run                 run the corpus x roster matrix, checkpointing each cell\n' +
    '  judge [--stability] score stored cells with the judge model\n' +
    '                      (--stability: 3 fresh passes on the first cell, no saving)\n' +
    '  report              build report.json/report.html and print the ranking\n' +
    '  crown [model]       crown a champion into config/champion.json\n' +
    '                      (no arg: recommendChampion; with arg: must have stored cells)\n' +
    '  status              print the model x item completion/judgement grid\n' +
    'Options (all subcommands):\n' +
    `  --roster <path>  defaults to "${defaultRosterPath()}"\n` +
    `  --corpus <path>  defaults to "${defaultCorpusPath()}"\n` +
    `  --store <path>   defaults to "${defaultStorePath()}"\n`
  )
}

function parseArgs(argv: string[]): ParseResult {
  const [cmdName, ...rest] = argv
  if (cmdName === undefined || !(KNOWN_COMMANDS as readonly string[]).includes(cmdName)) {
    return { ok: false, error: `Unknown subcommand: ${cmdName ?? '(none)'}\n${usage()}` }
  }

  let roster = defaultRosterPath()
  let corpus = defaultCorpusPath()
  let store = defaultStorePath()
  let stability = false
  const positionals: string[] = []

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--roster') {
      const value = rest[++i]
      if (value === undefined) return { ok: false, error: `Missing value for --roster\n${usage()}` }
      roster = value
    } else if (arg === '--corpus') {
      const value = rest[++i]
      if (value === undefined) return { ok: false, error: `Missing value for --corpus\n${usage()}` }
      corpus = value
    } else if (arg === '--store') {
      const value = rest[++i]
      if (value === undefined) return { ok: false, error: `Missing value for --store\n${usage()}` }
      store = value
    } else if (arg === '--stability') {
      if (cmdName !== 'judge') {
        return { ok: false, error: `--stability is only valid for "judge"\n${usage()}` }
      }
      stability = true
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `Unknown flag: ${arg}\n${usage()}` }
    } else {
      positionals.push(arg)
    }
  }

  if (positionals.length > 0 && cmdName !== 'crown') {
    return { ok: false, error: `Unexpected argument: ${positionals[0]}\n${usage()}` }
  }
  if (positionals.length > 1) {
    return { ok: false, error: `crown takes at most one model argument\n${usage()}` }
  }

  const base: BaseFlags = { roster, corpus, store }
  const name = cmdName as CommandName
  switch (name) {
    case 'run':
      return { ok: true, command: { cmd: 'run', ...base } }
    case 'judge':
      return { ok: true, command: { cmd: 'judge', ...base, stability } }
    case 'report':
      return { ok: true, command: { cmd: 'report', ...base } }
    case 'crown':
      return { ok: true, command: { cmd: 'crown', ...base, model: positionals[0] ?? null } }
    case 'status':
      return { ok: true, command: { cmd: 'status', ...base } }
  }
}

// --- shared helpers ----------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function printError(err: unknown): void {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
}

/** Deterministic processing order (model, then itemId) - store.listCells() has no ordering contract of its own (filesystem readdir order), so "the first stored cell" (judge --stability) and the judge pass's abort-then-resume story are only meaningful/testable against a stable order. */
function sortedCells(cells: StoredCell[]): StoredCell[] {
  return [...cells].sort((a, b) => {
    const byModel = a.config.model.localeCompare(b.config.model)
    if (byModel !== 0) return byModel
    return a.config.itemId.localeCompare(b.config.itemId)
  })
}

/**
 * True exactly when `judgement` still scores `cell` AS IT CURRENTLY STANDS
 * under the CURRENT rubric - both staleness conditions from the task brief,
 * checked independently: a cellConfigHash mismatch means the cell was
 * re-run since this judgement was saved, a promptVersion mismatch means the
 * rubric itself moved on since. Either failure alone makes the judgement
 * stale. Mirrors report.ts's own private isCurrentJudgement exactly (not
 * exported there, so duplicated here rather than reached into another
 * module's internals for a three-line check).
 */
function isJudgementCurrent(cell: StoredCell, judgement: StoredJudgement | null): boolean {
  if (judgement === null) return false
  if (judgement.cellConfigHash !== cell.configHash) return false
  if (judgement.promptVersion !== JUDGE_PROMPT_VERSION) return false
  return true
}

/** JudgeInputs from a cell's translated segments only (translation !== null) - a keptOriginal segment was never translated, so there is nothing for the judge to score. */
function buildJudgeInputs(cell: StoredCell): JudgeInput[] {
  const inputs: JudgeInput[] = []
  for (const segment of cell.report.segments) {
    if (segment.translation === null) continue
    inputs.push({
      segmentId: segment.id,
      source: segment.sourceText,
      translation: segment.translation,
      sourceLang: cell.config.sourceLang,
      targetLang: cell.config.targetLang
    })
  }
  return inputs
}

// --- run ---------------------------------------------------------------

function logHarnessEvent(e: HarnessEvent): void {
  switch (e.type) {
    case 'model-start':
    case 'model-done':
      console.error(`[${e.type}] ${e.model}`)
      break
    case 'cell-start':
    case 'cell-done':
    case 'cell-skipped':
      console.error(`[${e.type}] ${e.model}:${e.itemId}`)
      break
    case 'cell-failed':
    case 'model-aborted':
      console.error(`[${e.type}] ${e.model}:${e.itemId} (${e.error})`)
      break
  }
}

async function runRun(
  command: Extract<BenchCommand, { cmd: 'run' }>,
  deps: BenchCliDeps
): Promise<number> {
  const repoRoot = resolveRepoRoot()
  let roster: Roster
  let corpus: Corpus
  try {
    roster = loadRoster(command.roster)
    corpus = loadCorpus(command.corpus, repoRoot)
  } catch (err) {
    printError(err)
    return 1
  }

  const store = new BenchStore(command.store)

  const summary = await runMatrix(
    {
      models: roster.models,
      corpus,
      store,
      repoRoot,
      appDataDir: resolveAppDataDir(),
      onEvent: logHarnessEvent
    },
    deps.harnessDeps
  )

  console.log(
    `run: completed ${summary.completed}, skipped ${summary.skipped}, failed ${summary.failed}`
  )
  return summary.failed === 0 ? 0 : 1
}

// --- judge ---------------------------------------------------------------

async function judgeOneCell(
  cell: StoredCell,
  judgeModel: string,
  store: BenchStore,
  transport: JudgeTransport
): Promise<{ ok: true } | { ok: false }> {
  const inputs = buildJudgeInputs(cell)
  try {
    const scores = await judgeSegments(inputs, judgeModel, transport)
    store.saveJudgement(cell.config.model, cell.config.itemId, {
      judgeModel,
      promptVersion: JUDGE_PROMPT_VERSION,
      cellConfigHash: cell.configHash,
      scores,
      judgedAt: new Date().toISOString()
    })
    console.log(
      `judge: ${cell.config.model} / ${cell.config.itemId}: ${scores.length}/${inputs.length} segment(s) scored`
    )
    return { ok: true }
  } catch (err) {
    // HARD constraint: judgeSegments can throw JudgeBatchFailure carrying
    // partialScores from earlier, fully-completed batches WITHIN this one
    // cell - those are for logging/diagnosis only (see JudgeBatchFailure's
    // own doc comment, judge.ts). Saving them would be the same
    // poison-the-store failure mode a prior task's review caught in
    // harness.ts: a StoredJudgement whose cellConfigHash/promptVersion
    // already match the current cell is skipped on resume, so a partial
    // save here would lock the gap in permanently and this cell would
    // never be revisited by a later `bench judge`. Nothing is saved for
    // this cell, full stop - the whole pass aborts (the caller stops
    // iterating on a non-ok result) rather than continuing to the next
    // cell, since a transport failure here likely means every remaining
    // judge call would fail identically.
    const partialNote =
      err instanceof JudgeBatchFailure
        ? ` (${err.partialScores.length} segment(s) scored in earlier batches before the failure)`
        : ''
    console.error(
      `judge: aborting the pass - ${cell.config.model} / ${cell.config.itemId} failed${partialNote}: ${errorMessage(err)}`
    )
    console.error(
      'judge: nothing was saved for this cell; cells already saved earlier in this pass remain saved.'
    )
    return { ok: false }
  }
}

async function runJudgeMain(
  store: BenchStore,
  roster: Roster,
  deps: BenchCliDeps
): Promise<number> {
  const cellsToJudge = sortedCells(store.listCells()).filter(
    (cell) =>
      !isJudgementCurrent(
        cell,
        store.loadJudgement(roster.judge, cell.config.model, cell.config.itemId)
      )
  )

  if (cellsToJudge.length === 0) {
    console.log('judge: every stored cell already has a current judgement - nothing to do.')
    return 0
  }

  const connection = await deps.ensureOllama({ appDataDir: resolveAppDataDir() })
  try {
    const transport = deps.createJudgeTransport(connection.baseUrl)

    for (const cell of cellsToJudge) {
      const result = await judgeOneCell(cell, roster.judge, store, transport)
      if (!result.ok) return 1
    }

    console.log(`judge: judged and saved ${cellsToJudge.length} cell(s).`)
    return 0
  } finally {
    await connection.stop()
  }
}

const STABILITY_PASSES = 3
const STABILITY_SPREAD_GATE = 0.25

async function runJudgeStability(
  store: BenchStore,
  judgeModel: string,
  deps: BenchCliDeps
): Promise<number> {
  const cells = sortedCells(store.listCells())
  if (cells.length === 0) {
    console.error('judge --stability: no stored cells to score - run "bench run" first.')
    return 1
  }
  const cell = cells[0]
  const inputs = buildJudgeInputs(cell)
  if (inputs.length === 0) {
    console.error(
      `judge --stability: ${cell.config.model} / ${cell.config.itemId} has no translated segments to score.`
    )
    return 1
  }

  console.log(
    `judge --stability: scoring ${cell.config.model} / ${cell.config.itemId} ${STABILITY_PASSES} times fresh (nothing will be saved).`
  )

  const connection = await deps.ensureOllama({ appDataDir: resolveAppDataDir() })
  try {
    const transport = deps.createJudgeTransport(connection.baseUrl)
    const meanOveralls: number[] = []

    for (let pass = 1; pass <= STABILITY_PASSES; pass++) {
      let scores
      try {
        scores = await judgeSegments(inputs, judgeModel, transport)
      } catch (err) {
        const partialNote =
          err instanceof JudgeBatchFailure
            ? ` (${err.partialScores.length} segment(s) scored before the failure)`
            : ''
        console.error(`judge --stability: pass ${pass} failed${partialNote}: ${errorMessage(err)}`)
        return 1
      }

      // Reuses metrics.ts's own mean-of-three-dimension-means math (rather
      // than reimplementing it) so a stability check's meanOverall can never
      // drift from what report.ts/status would compute for the same scores.
      const { meanOverall } = judgementQuality(
        {
          judgeModel,
          promptVersion: JUDGE_PROMPT_VERSION,
          cellConfigHash: cell.configHash,
          scores,
          judgedAt: new Date().toISOString()
        },
        inputs.length
      )

      if (meanOverall === null) {
        console.error(
          `judge --stability: pass ${pass} scored 0 of ${inputs.length} segment(s) - cannot compute a mean.`
        )
        return 1
      }

      console.log(`  pass ${pass}: meanOverall ${meanOverall.toFixed(3)}`)
      meanOveralls.push(meanOverall)
    }

    const spread = Math.max(...meanOveralls) - Math.min(...meanOveralls)
    console.log(`  spread ${spread.toFixed(3)} (gate <= ${STABILITY_SPREAD_GATE})`)

    if (spread <= STABILITY_SPREAD_GATE) {
      console.log('judge --stability: PASS')
      return 0
    }
    console.log('judge --stability: FAIL')
    return 1
  } finally {
    await connection.stop()
  }
}

async function runJudge(
  command: Extract<BenchCommand, { cmd: 'judge' }>,
  deps: BenchCliDeps
): Promise<number> {
  let roster: Roster
  try {
    roster = loadRoster(command.roster)
  } catch (err) {
    printError(err)
    return 1
  }

  const store = new BenchStore(command.store)

  return command.stability
    ? runJudgeStability(store, roster.judge, deps)
    : runJudgeMain(store, roster, deps)
}

// --- report ----------------------------------------------------------------

function printRankingTable(report: BenchReport): void {
  console.log('')
  console.log('Ranking')
  console.log('-'.repeat(60))
  if (report.ranking.length === 0) {
    console.log('  (no stored cells yet)')
  }
  for (const m of report.ranking) {
    const overall = m.meanOverall === null ? '-' : m.meanOverall.toFixed(2)
    console.log(
      `  ${m.model.padEnd(20)} quality ${overall.padStart(5)}  completeness ${m.completenessPct.toFixed(1)}%  seg/min ${m.segmentsPerMin.toFixed(2)}`
    )
  }
  console.log('')
  console.log(
    report.recommended
      ? `Recommended champion: ${report.recommended}`
      : 'No champion recommended yet.'
  )
}

async function runReport(command: Extract<BenchCommand, { cmd: 'report' }>): Promise<number> {
  let roster: Roster
  let corpus: Corpus
  try {
    roster = loadRoster(command.roster)
    corpus = loadCorpus(command.corpus, resolveRepoRoot())
  } catch (err) {
    printError(err)
    return 1
  }

  const store = new BenchStore(command.store)
  const report = buildReport(store, corpus, roster.judge)
  const html = renderHtml(report, store)

  try {
    writeFileSync(path.join(store.dir, 'report.json'), JSON.stringify(report, null, 2))
    writeFileSync(path.join(store.dir, 'report.html'), html)
  } catch (err) {
    printError(err)
    return 1
  }

  printRankingTable(report)
  return 0
}

// --- crown -------------------------------------------------------------

/**
 * Reads just the `model` field out of `<repoRoot>/config/champion.json` for
 * the "old ->" half of crown's printed transition, WITHOUT going through
 * champion.ts's own readChampion() - that function resolves its OWN
 * (independently overridable) config directory rather than taking a
 * repoRoot parameter the way writeChampion does, so calling it here would
 * make "old" and "new" potentially name two DIFFERENT directories under
 * test. Reading directly off the exact same repoRoot writeChampion is about
 * to write to keeps this single-source-of-truth and trivially safe to test
 * via this module's own repoRoot override alone. Malformed/missing file -> null,
 * same as champion.ts's own leniency; this is a display nicety, not a gate.
 */
function readChampionModelAt(repoRoot: string): string | null {
  try {
    const raw = readFileSync(path.join(repoRoot, 'config', 'champion.json'), 'utf8')
    const data = JSON.parse(raw) as { model?: unknown }
    return typeof data.model === 'string' && data.model.trim().length > 0 ? data.model : null
  } catch {
    return null
  }
}

async function runCrown(command: Extract<BenchCommand, { cmd: 'crown' }>): Promise<number> {
  const repoRoot = resolveRepoRoot()
  let roster: Roster
  let corpus: Corpus
  try {
    roster = loadRoster(command.roster)
    corpus = loadCorpus(command.corpus, repoRoot)
  } catch (err) {
    printError(err)
    return 1
  }

  const store = new BenchStore(command.store)
  const cellsWithJudgement = sortedCells(store.listCells()).map((cell) => {
    const judgement = store.loadJudgement(roster.judge, cell.config.model, cell.config.itemId)
    return { cell, judgement: isJudgementCurrent(cell, judgement) ? judgement : null }
  })
  const ranking = rankModels(aggregate(cellsWithJudgement, corpus))

  let chosen: string
  if (command.model !== null) {
    // Explicit crown: the model just needs SOME evidence (at least one
    // stored cell here), not full completeness/judgement - that stricter
    // bar is recommendChampion's own, for the no-arg auto-recommend path
    // only. An explicit crown is a human accepting responsibility for an
    // incomplete or unproven model.
    if (!ranking.some((r) => r.model === command.model)) {
      console.error(
        `crown: model "${command.model}" has no stored cells under this store/corpus - run "bench run" for it first.`
      )
      return 1
    }
    chosen = command.model
  } else {
    const recommended = recommendChampion(ranking)
    if (recommended === null) {
      console.error(
        'crown: no model qualifies yet - recommendChampion requires a model with every corpus item ' +
          'completed AND judged, and no model meets that bar yet. Run "bench run" then "bench judge" ' +
          'first, or crown an explicit model with "bench crown <model>".'
      )
      return 1
    }
    chosen = recommended
  }

  const previous = readChampionModelAt(repoRoot) ?? '(none)'

  writeChampion(
    { model: chosen, crownedAt: new Date().toISOString(), note: 'crowned via bench crown' },
    repoRoot
  )

  console.log(`crown: ${previous} -> ${chosen}`)
  return 0
}

// --- status ------------------------------------------------------------
//
// Deliberately takes NO deps: status is documented (and tested, including
// against REAL deps via the contract-point-7 integration smoke test) to
// never touch the network, so its signature simply has no access to
// ensureOllama/harnessDeps/createJudgeTransport to touch in the first
// place.

function cellState(
  store: BenchStore,
  roster: Roster,
  model: string,
  itemId: string
): 'missing' | 'done/unjudged' | 'done/judged' | 'done/stale-judgement' {
  const cell = store.loadCell(model, itemId)
  if (cell === null) return 'missing'
  const judgement = store.loadJudgement(roster.judge, model, itemId)
  if (judgement === null) return 'done/unjudged'
  return isJudgementCurrent(cell, judgement) ? 'done/judged' : 'done/stale-judgement'
}

async function runStatus(command: Extract<BenchCommand, { cmd: 'status' }>): Promise<number> {
  let roster: Roster
  let corpus: Corpus
  try {
    roster = loadRoster(command.roster)
    corpus = loadCorpus(command.corpus, resolveRepoRoot())
  } catch (err) {
    printError(err)
    return 1
  }

  const store = new BenchStore(command.store)

  console.log(`Status: ${roster.models.length} model(s) x ${corpus.items.length} item(s)`)
  console.log('')

  let missing = 0
  let judged = 0
  let stale = 0
  let unjudged = 0

  for (const model of roster.models) {
    const cells = corpus.items.map((item) => {
      const state = cellState(store, roster, model, item.id)
      if (state === 'missing') missing++
      else if (state === 'done/judged') judged++
      else if (state === 'done/stale-judgement') stale++
      else unjudged++
      return `${item.id}:${state}`
    })
    console.log(`  ${model.padEnd(20)} ${cells.join('  ')}`)
  }

  console.log('')
  const totalCells = roster.models.length * corpus.items.length
  console.log(`Cells: ${totalCells - missing} completed, ${missing} missing (of ${totalCells})`)
  console.log(`Judgements: ${judged} current, ${stale} stale, ${unjudged} unjudged`)

  return 0
}

// --- entry point ---------------------------------------------------------

/**
 * Production wiring: realHarnessDeps() (safe to construct eagerly - see its
 * own doc comment, PP-OCR's actual model load is lazy) plus the real
 * ensureOllama/createOllamaJudgeTransport - the same real implementations
 * cli.ts and harness.ts each wire up for their own default deps. A module-
 * level constant (not a function recomputed per call), mirroring cli.ts's
 * own `defaultDeps`.
 */
const defaultBenchCliDeps: BenchCliDeps = {
  harnessDeps: realHarnessDeps(),
  ensureOllama: realEnsureOllama,
  createJudgeTransport: createOllamaJudgeTransport
}

/**
 * Runs the bench CLI end to end and resolves to the process exit code -
 * never calls process.exit() itself, so it is directly callable from tests
 * (mirrors cli.ts's runCli). `status` is the only subcommand exercised here
 * against the REAL default deps in this module's own test suite (contract
 * point 7) - every other subcommand always receives injected fakes, per the
 * machine rule that no test may load a model, touch the GPU, or hit the
 * network.
 */
export async function runBenchCli(argv: string[], deps?: BenchCliDeps): Promise<number> {
  const effectiveDeps = deps ?? defaultBenchCliDeps

  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    console.error(parsed.error)
    return 1
  }

  const command = parsed.command
  switch (command.cmd) {
    case 'run':
      return runRun(command, effectiveDeps)
    case 'judge':
      return runJudge(command, effectiveDeps)
    case 'report':
      return runReport(command)
    case 'crown':
      return runCrown(command)
    case 'status':
      return runStatus(command)
  }
}

export const _internals = {
  parseArgs,
  usage,
  resolveAppDataDir,
  resolveRepoRoot,
  /** Test-only: redirects resolveRepoRoot() (and therefore every default path, and writeChampion's target) away from the real repo. Pass null to restore real findAppRoot()-based resolution. Mirrors champion.ts's own setConfigDirForTesting escape hatch. */
  setRepoRootForTesting(dir: string | null): void {
    repoRootOverride = dir
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fileURLToPath(import.meta.url) === path.resolve(entry)
  } catch {
    return false
  }
}

/* c8 ignore start -- thin process entry, exercised via runBenchCli tests instead */
if (isMainModule()) {
  runBenchCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      printError(err)
      process.exit(1)
    })
}
/* c8 ignore stop */
