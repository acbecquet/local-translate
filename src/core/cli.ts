// CLI entry point: `npm run translate -- <file> <sourceLang> <targetLang>
// [--model <name>] [--out <path>]`. Wires the FakeAdapter (the only adapter
// landed so far), a managed/adopted Ollama connection, and OllamaBackend
// into runPipeline, then prints the RunReport as a plain readable table.
//
// Exit codes:
//   0 - ran, and at least one segment was translated, the doc had none, or
//       every kept-original segment was legitimately kept without ever
//       being sent to the model: untranslatable content (numeric/symbol/
//       whitespace-only) or content not in the run's declared source
//       language (see LEGITIMATE_KEEP_REASONS).
//   1 - ran, but every segment fell back to its original text (total > 0
//       and translated === 0) for a reason OTHER than one of those
//       legitimate keeps - or a usage/setup error before the pipeline
//       could even start.
//   2 - Ollama could not be found or started (OllamaNotFoundError).
//
// `runCli()` does the actual work and always resolves to an exit code - it
// never calls process.exit() itself, which is what makes it unit-testable
// (tests/core/cli.test.ts calls it directly with injected deps). The block
// at the bottom of this file is the only part that touches process.exit(),
// and only runs when this file is executed directly (not when imported).

import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { adapterFor } from './adapters/adapter'
import { buildAdapters } from './adapters/registry'
import { resolveDefaultModel } from './champion'
import { DEFAULT_MODEL } from './defaults'
import { createPPOcrEngine } from './images/engines/ppocr'
import { withCellSplit } from './images/cellsplit'
import { withRotationPasses } from './images/rotation'
import {
  NOT_SOURCE_LANGUAGE_REASON,
  runPipeline,
  UNTRANSLATABLE_REASON,
  type RunReport
} from './pipeline'
import {
  ensureOllama as realEnsureOllama,
  OllamaNotFoundError,
  type OllamaConnection
} from './translate/ollama/lifecycle'
import { OllamaBackend } from './translate/ollama/ollama-backend'
import type { TranslationBackend } from './translate/backend'

/**
 * Where the CLI keeps its Ollama pid file, model-caps cache, and (for a
 * managed install) downloaded models: `%LOCALAPPDATA%\local_translate`
 * when LOCALAPPDATA is set, otherwise `<homedir>/AppData/Local/local_translate`
 * - the same LOCALAPPDATA-first, homedir-fallback resolution
 * findOllamaExe() (lifecycle.ts) uses to locate the exe, so both agree on
 * where "local app data" lives on a given machine. This resolver is
 * deliberately CLI-only, not part of the core pipeline - runPipeline
 * receives everything it needs via opts and has no notion of "app data
 * directory" of its own.
 */
function resolveAppDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'local_translate')
}

interface CliArgs {
  file: string
  sourceLang: string
  targetLang: string
  model: string
  out?: string
}

type ParseResult = { ok: true; args: CliArgs } | { ok: false; error: string }

const USAGE =
  `Usage: translate <file> <sourceLang> <targetLang> [--model <name>] [--out <path>]\n` +
  `  --model defaults to "${DEFAULT_MODEL}" if omitted`

function parseArgs(argv: string[]): ParseResult {
  const positional: string[] = []
  // The champion crowned by the phase-4 benchmark harness (config/champion.json)
  // when present and well-formed, else DEFAULT_MODEL - see champion.ts.
  let model = resolveDefaultModel()
  let out: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--model') {
      const value = argv[++i]
      if (value === undefined) return { ok: false, error: 'Missing value for --model' }
      model = value
    } else if (arg === '--out') {
      const value = argv[++i]
      if (value === undefined) return { ok: false, error: 'Missing value for --out' }
      out = value
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `Unknown flag: ${arg}\n${USAGE}` }
    } else {
      positional.push(arg)
    }
  }

  const [file, sourceLang, targetLang] = positional
  if (!file || !sourceLang || !targetLang) {
    return { ok: false, error: USAGE }
  }
  return { ok: true, args: { file, sourceLang, targetLang, model, out } }
}

function printReport(report: RunReport): void {
  const line = '-'.repeat(60)
  console.log('')
  console.log(`Translation report: ${report.file}`)
  console.log(line)
  console.log(`  Output file      ${report.outPath}`)
  console.log(`  Total segments   ${report.total}`)
  console.log(`  Translated       ${report.translated}`)
  console.log(`  Kept original    ${report.keptOriginal.length}`)
  console.log(`  Overflowed       ${report.overflowed.length}`)
  console.log(`  Skipped          ${report.skippedUnsupported.length}`)
  console.log(`  Duration         ${report.durationMs} ms`)

  if (report.keptOriginal.length > 0) {
    console.log('')
    console.log('  Kept original (id -> reason)')
    for (const k of report.keptOriginal) {
      console.log(`    ${k.id.padEnd(28)} ${k.reason}`)
    }
  }

  // An all-untranslatable doc (a spec sheet of numbers) is a normal shape;
  // a doc where EVERY segment gated as not-source-language is exactly the
  // shape a mislabeled sourceLang argument produces - it still exits 0
  // (each keep is individually legitimate), so this warning is the one
  // signal separating "nothing to translate" from "wrong language flag".
  if (
    report.total > 0 &&
    report.keptOriginal.length === report.total &&
    report.keptOriginal.every((k) => k.reason === NOT_SOURCE_LANGUAGE_REASON)
  ) {
    console.log('')
    console.log(
      '  WARNING: every segment was kept because its text is not in the declared source language. If you expected translations, check the source language argument.'
    )
  }

  if (report.overflowed.length > 0) {
    console.log('')
    console.log('  Overflowed (id -> font size pt)')
    for (const o of report.overflowed) {
      console.log(`    ${o.id.padEnd(28)} ${o.fontSizePt}`)
    }
  }
  console.log('')

  printStats(report.stats)
}

/** `ms` under 1000 as "N ms", otherwise as "N.NN s" - the human-readable rule requirement 3 asks for on every phaseMs entry. */
function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}

/**
 * Prints the "Processing stats" block after the existing report table: the
 * model, per-phase timings, group/call/retry/fallback counts, token
 * throughput (only when the backend actually reported any - a 0/0 line
 * would just be noise for a backend that never tracks usage), character
 * counts, and segments/min. Plain aligned text matching printReport's own
 * style above, not a second table format.
 */
function printStats(stats: RunReport['stats']): void {
  console.log('Processing stats')
  console.log('-'.repeat(60))
  console.log(`  Model            ${stats.model}`)
  console.log(
    `  Phases           extract ${formatMs(stats.phaseMs.extract)}, ` +
      `connect ${formatMs(stats.phaseMs.connect)}, ` +
      `translate ${formatMs(stats.phaseMs.translate)}, ` +
      `fit ${formatMs(stats.phaseMs.fit)}, ` +
      `apply ${formatMs(stats.phaseMs.apply)}`
  )
  console.log(
    `  Groups/calls     ${stats.groups} groups, ${stats.modelCalls} model calls, ` +
      `${stats.groupRetries} retries, ${stats.perSegmentFallbacks} per-segment fallbacks`
  )
  // Token throughput is only meaningful when the backend actually reported
  // usage - printing "0 prompt, 0 completion, 0.0 tok/s" for every run of a
  // backend that never tracks it would just be noise.
  if (stats.promptTokens > 0 || stats.completionTokens > 0) {
    console.log(
      `  Tokens           ${stats.promptTokens} prompt, ${stats.completionTokens} completion, ` +
        `${stats.tokensPerSec.toFixed(1)} tok/s`
    )
  }
  console.log(
    `  Chars            ${stats.charsSource} source -> ${stats.charsTranslated} translated`
  )
  console.log(`  Throughput       ${stats.segmentsPerMin.toFixed(1)} segments/min`)
  console.log('')
}

/** Progress line printed to stderr so it never interleaves with the report table on stdout. */
function logProgress(done: number, total: number, phase: string): void {
  console.error(`[${phase}] ${done}/${total}`)
}

function printError(err: unknown): void {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
}

/**
 * Reasons a kept-original segment was legitimately never sent to the model
 * in the first place, rather than failing to translate: either it had
 * nothing translatable to act on (UNTRANSLATABLE_REASON - numbers/symbols/
 * whitespace) or its text isn't in the run's source language
 * (NOT_SOURCE_LANGUAGE_REASON - e.g. an already-translated textbox left
 * over in a mixed-language deck). Both are expected passthroughs, not
 * failures.
 */
const LEGITIMATE_KEEP_REASONS: ReadonlySet<string> = new Set([
  UNTRANSLATABLE_REASON,
  NOT_SOURCE_LANGUAGE_REASON
])

/**
 * A run has genuinely failed (exit 1) only when nothing was translated AND
 * at least one kept-original segment was kept for a reason other than one of
 * LEGITIMATE_KEEP_REASONS above. A document that's entirely
 * numbers/symbols/whitespace (a spec sheet of dimensions), or entirely
 * content already in the target language (a deck the source-language gate
 * correctly left untouched), has translated === 0 with total > 0, but every
 * one of those segments was correctly never sent to the model, so that run
 * succeeded at doing exactly what it should have and must not be reported
 * as a failure.
 */
function isFailedRun(report: RunReport): boolean {
  if (report.translated > 0 || report.total === 0) return false
  return report.keptOriginal.some((k) => !LEGITIMATE_KEEP_REASONS.has(k.reason))
}

/**
 * The two collaborators runCli needs but doesn't own the lifecycle of -
 * injectable so tests can exercise every exit path (not-found, zero
 * translations, success, stop-on-throw) without spawning or probing a real
 * Ollama process. Defaults to the real implementations; everything else
 * (adapters, the pipeline itself) uses the genuine production code even
 * under test, per the brief - only these two touch an external process.
 */
export interface CliDeps {
  ensureOllama: (opts: { appDataDir: string }) => Promise<OllamaConnection>
  createBackend: (opts: { baseUrl: string; appDataDir: string }) => TranslationBackend
}

const defaultDeps: CliDeps = {
  ensureOllama: realEnsureOllama,
  createBackend: (opts) => new OllamaBackend(opts)
}

/**
 * Runs the CLI end to end and resolves to the process exit code - never
 * calls process.exit() itself, so it can be called directly from tests.
 * `connection.stop()` is guaranteed to run exactly once, in a finally
 * block, for every path that successfully obtained a connection (including
 * when runPipeline throws) - and is never called at all on the
 * OllamaNotFoundError path, since no connection was ever obtained there.
 */
export async function runCli(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    console.error(parsed.error)
    return 1
  }
  const args = parsed.args

  // Cheap and side-effect-free to construct regardless of whether this run
  // ends up needing it: createPPOcrEngine() only returns a lazily-loading
  // closure - the actual ONNX model load (CPU-only; MACHINE RULES bar GPU
  // loads from an agent-run process) happens on the engine's first
  // detectRegions() call, inside runPipeline's extract() phase, not here.
  // Built before resolving the adapter (rather than after connecting to
  // Ollama) so an unsupported file extension still fails fast without ever
  // touching Ollama - the same property this file already guaranteed before
  // image support existed.
  // withRotationPasses (polish round Task E) wraps the engine so vertical/
  // rotated chart-axis-style text also gets detected (via extra rotated-copy
  // passes) instead of only ever being flagged rotated-and-skipped - see its
  // own module doc comment (images/rotation.ts) for why this must rotate the
  // IMAGE rather than trust an in-place read. withCellSplit (gate round 5)
  // wraps OUTSIDE that so row-merged table detections get split at true cell
  // gutters in final original-frame coordinates - see images/cellsplit.ts.
  const regionEngine = withCellSplit(withRotationPasses(createPPOcrEngine()))
  const adapters = buildAdapters({ regionEngine, sourceLang: args.sourceLang })
  const adapter = adapterFor(args.file, adapters)
  if (!adapter) {
    console.error(
      `No adapter registered for "${args.file}" (known extensions: ${adapters.flatMap((a) => a.extensions).join(', ')})`
    )
    return 1
  }

  const appDataDir = resolveAppDataDir()

  let connection: OllamaConnection
  let connectMs: number
  const connectStart = Date.now()
  try {
    connection = await deps.ensureOllama({ appDataDir })
    connectMs = Date.now() - connectStart
  } catch (err) {
    if (err instanceof OllamaNotFoundError) {
      console.error(err.message)
      console.error(`Download: ${err.standaloneUrl}`)
      return 2
    }
    printError(err)
    return 1
  }

  try {
    const backend = deps.createBackend({ baseUrl: connection.baseUrl, appDataDir })
    const report = await runPipeline({
      file: args.file,
      out: args.out,
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      model: args.model,
      adapter,
      backend,
      connectMs,
      onProgress: logProgress
    })

    printReport(report)

    return isFailedRun(report) ? 1 : 0
  } catch (err) {
    printError(err)
    return 1
  } finally {
    // no-ops for a connection we adopted rather than spawned (Task 3 contract).
    await connection.stop()
  }
}

export const _internals = { parseArgs, DEFAULT_MODEL, USAGE, resolveAppDataDir }

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fileURLToPath(import.meta.url) === path.resolve(entry)
  } catch {
    return false
  }
}

/* c8 ignore start -- thin process entry, exercised via runCli tests instead */
if (isMainModule()) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      printError(err)
      process.exit(1)
    })
}
/* c8 ignore stop */
