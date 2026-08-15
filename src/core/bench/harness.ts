/**
 * Sequential (model x corpus item) matrix runner - the heart of the
 * benchmark. Drives the real translation pipeline (runPipeline, ../pipeline)
 * once per cell, exactly the way cli.ts drives it for a single file: same
 * ensureOllama/createBackend shapes (HarnessDeps reuses CliDeps's own types
 * verbatim), same adapter resolution (buildAdapters -> adapterFor by file
 * extension). The two differences from cli.ts's single-file flow: (1) every
 * cell in the whole matrix shares ONE ensureOllama connection and ONE
 * backend instance rather than one per invocation, and (2) every completed
 * cell is checkpointed into a BenchStore (./store.ts's tinbox atomic-write
 * pattern) so a multi-hour run can be killed and resumed - a stored cell
 * whose configHash still matches the current (model, item, langs) tuple is
 * skipped rather than re-run.
 *
 * MACHINE RULE (hard): models run strictly sequentially, one at a time -
 * model B's cells never start until model A's are all done AND model A has
 * been explicitly unloaded (unloadModel: a keep_alive: 0 request) to free
 * its VRAM. Never a retry loop: an ordinary cell failure is recorded and the
 * run moves on to the model's next cell. The one exception is a
 * TRANSPORT-CLASS failure (the connection or the model itself is broken -
 * e.g. the model failed to load), which means every remaining cell for this
 * model would fail identically, so the harness aborts the model's remaining
 * cells instead of burning through them one at a time - see
 * isTransportError below. Retrying a broken model load is exactly the
 * crash-retry pattern that leaks VRAM on this machine.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { adapterFor, type FormatAdapter } from '../adapters/adapter'
import { buildAdapters as buildRealAdapters, type AdapterDeps } from '../adapters/registry'
import type { CliDeps } from '../cli'
import { withCellSplit } from '../images/cellsplit'
import { createPPOcrEngine } from '../images/engines/ppocr'
import { withRotationPasses } from '../images/rotation'
import { runPipeline } from '../pipeline'
import type { TranslationBackend } from '../translate/backend'
import { OllamaBackend } from '../translate/ollama/ollama-backend'
import { ensureOllama as realEnsureOllama } from '../translate/ollama/lifecycle'
import type { Corpus, CorpusItem } from './corpus'
import { BenchStore, configHash, modelSlug, type CellConfig } from './store'

export interface HarnessDeps {
  ensureOllama: CliDeps['ensureOllama']
  createBackend: CliDeps['createBackend']
  /** POST /api/generate { model, keep_alive: 0 } - frees VRAM before the next model loads. */
  unloadModel: (baseUrl: string, model: string) => Promise<void>
  /** Injectable so tests use a fake adapter set instead of loading PP-OCR. Same signature as registry.ts's buildAdapters. */
  buildAdapters: (deps: AdapterDeps) => FormatAdapter[]
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Detects a transport-class failure - the model server itself is
 * unreachable, or the model failed to load - as opposed to an ordinary
 * per-cell failure (a bad extract, a validation-ladder exhaustion, a fit
 * error) that only affects the one cell. A transport-class failure means
 * every remaining cell for this model would fail identically, so the
 * harness aborts the model's REMAINING cells rather than burning through
 * them one at a time; never a retry loop (machine rule: a crash-retry loop
 * on a failed model load leaks VRAM on this machine).
 *
 * Detected by error code/message, since fetch/undici and ollama's client
 * don't expose a stable error class across Node versions - the documented
 * list this predicate matches:
 *  - a message containing "fetch failed" (undici's own wrapper message for
 *    a failed global fetch() call)
 *  - ECONNREFUSED / ECONNRESET, either directly on `err.code` or nested
 *    under `err.cause.code` (how a wrapped fetch failure carries the
 *    underlying socket error)
 *  - a message mentioning both "model" and "load" (covers both word orders,
 *    e.g. "failed to load model" and "model load failed") - ollama's own
 *    reported failure to load a model into memory (e.g. out of VRAM)
 */
function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false

  const code = (err as NodeJS.ErrnoException).code
  const causeCode = (err.cause as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return true
  if (causeCode === 'ECONNREFUSED' || causeCode === 'ECONNRESET') return true

  const message = err.message.toLowerCase()
  if (message.includes('fetch failed')) return true
  if (message.includes('model') && message.includes('load')) return true

  return false
}

/**
 * Runs one (model, item) cell: resolves the adapter, translates via
 * runPipeline, then copies the translated output into the store's artifacts
 * dir and checkpoints the full RunReport - in that order, so a cell record
 * is only ever saved once its artifact evidence already exists on disk
 * (never a StoredCell pointing at a missing artifact).
 */
async function runCell(
  model: string,
  item: CorpusItem,
  config: CellConfig,
  hash: string,
  opts: HarnessOpts,
  deps: HarnessDeps,
  backend: TranslationBackend
): Promise<void> {
  const adapters = deps.buildAdapters({ regionEngine: null, sourceLang: item.sourceLang })
  const adapter = adapterFor(item.file, adapters)
  if (!adapter) {
    throw new Error(
      `No adapter registered for "${item.file}" (known extensions: ${adapters.flatMap((a) => a.extensions).join(', ')})`
    )
  }

  const absFile = path.resolve(opts.repoRoot, item.file)
  // Scratch output, staged under appDataDir rather than next to the corpus
  // file - a real run must never litter fixtures/ (part of the repo working
  // tree) with generated _translated files. Scoped by model so cells never
  // collide even though the harness only runs one at a time.
  const outPath = path.join(
    opts.appDataDir,
    'bench-runs',
    modelSlug(model),
    `${item.id}${path.extname(item.file)}`
  )
  mkdirSync(path.dirname(outPath), { recursive: true })

  const report = await runPipeline({
    file: absFile,
    out: outPath,
    sourceLang: item.sourceLang,
    targetLang: item.targetLang,
    model,
    adapter,
    backend
  })

  const artifactRelPath = opts.store.artifactPathFor(model, item.id, report.outPath)
  const artifactAbsPath = path.join(opts.store.dir, artifactRelPath)
  // KNOWN TRAP: artifactPathFor only computes a path, it never creates the
  // per-model directory (unlike saveCell/saveJudgement, which mkdir lazily) -
  // this is the first thing to ever touch that directory for a given model,
  // so it must mkdir here or the first artifact for every model ENOENTs.
  mkdirSync(path.dirname(artifactAbsPath), { recursive: true })
  copyFileSync(report.outPath, artifactAbsPath)

  opts.store.saveCell({
    config,
    configHash: hash,
    report,
    artifactPath: artifactRelPath,
    completedAt: new Date().toISOString()
  })
}

export async function runMatrix(opts: HarnessOpts, deps: HarnessDeps): Promise<HarnessSummary> {
  const summary: HarnessSummary = { completed: 0, skipped: 0, failed: 0 }

  // Once for the whole matrix, not once per model/cell - mirrors cli.ts's
  // single ensureOllama call, just amortized across every cell instead of
  // one file.
  const connection = await deps.ensureOllama({ appDataDir: opts.appDataDir })
  try {
    const backend = deps.createBackend({ baseUrl: connection.baseUrl, appDataDir: opts.appDataDir })

    for (const model of opts.models) {
      opts.onEvent?.({ type: 'model-start', model })
      // Non-null once a transport-class failure hits this model: every
      // remaining item is short-circuited to a model-aborted event instead
      // of being attempted (never a retry).
      let abortError: string | null = null

      for (const item of opts.corpus.items) {
        if (abortError !== null) {
          opts.onEvent?.({ type: 'model-aborted', model, itemId: item.id, error: abortError })
          summary.failed += 1
          continue
        }

        const config: CellConfig = {
          model,
          itemId: item.id,
          sourceLang: item.sourceLang,
          targetLang: item.targetLang
        }
        const hash = configHash(config)
        const stored = opts.store.loadCell(model, item.id)
        if (stored !== null && stored.configHash === hash) {
          opts.onEvent?.({ type: 'cell-skipped', model, itemId: item.id })
          summary.skipped += 1
          continue
        }

        opts.onEvent?.({ type: 'cell-start', model, itemId: item.id })
        try {
          await runCell(model, item, config, hash, opts, deps, backend)
          opts.onEvent?.({ type: 'cell-done', model, itemId: item.id })
          summary.completed += 1
        } catch (err) {
          const message = errorMessage(err)
          if (isTransportError(err)) {
            abortError = message
            opts.onEvent?.({ type: 'model-aborted', model, itemId: item.id, error: message })
          } else {
            opts.onEvent?.({ type: 'cell-failed', model, itemId: item.id, error: message })
          }
          summary.failed += 1
        }
      }

      // Runs even for an aborted model - freeing VRAM is the whole point,
      // and matters MORE, not less, after a broken load.
      await deps.unloadModel(connection.baseUrl, model)
      opts.onEvent?.({ type: 'model-done', model })
    }
  } finally {
    await connection.stop()
  }

  return summary
}

/** Plain HTTP POST to <baseUrl>/api/generate with { model, keep_alive: 0 } - how ollama frees a loaded model's VRAM without waiting out its normal keep-alive window. */
async function unloadModel(baseUrl: string, model: string): Promise<void> {
  await fetch(new URL('/api/generate', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 })
  })
}

/**
 * Production wiring: real ensureOllama/OllamaBackend (same as cli.ts's own
 * defaultDeps), the real unloadModel, and buildAdapters closed over ONE
 * PP-OCR region engine built here (withCellSplit(withRotationPasses(...))),
 * identical to cli.ts's construction. The engine is built ONCE per harness
 * run (not per cell) and reused for every buildAdapters call the matrix
 * makes - only `sourceLang` varies per call (AdapterDeps needs it fresh per
 * item; see registry.ts), so the returned closure ignores whatever
 * `regionEngine` a caller passes in `AdapterDeps` and always substitutes
 * this one.
 */
export function realHarnessDeps(): HarnessDeps {
  const regionEngine = withCellSplit(withRotationPasses(createPPOcrEngine()))
  return {
    ensureOllama: realEnsureOllama,
    createBackend: (opts) => new OllamaBackend(opts),
    unloadModel,
    buildAdapters: (deps) => buildRealAdapters({ regionEngine, sourceLang: deps.sourceLang })
  }
}

export const _internals = { isTransportError }
