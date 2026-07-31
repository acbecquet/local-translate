// CLI entry point: `npm run translate -- <file> <sourceLang> <targetLang>
// [--model <name>] [--out <path>]`. Wires the FakeAdapter (the only adapter
// landed so far), a managed/adopted Ollama connection, and OllamaBackend
// into runPipeline, then prints the RunReport as a plain readable table.
//
// Exit codes:
//   0 - ran, and at least one segment was translated, the doc had none, or
//       every kept-original segment was legitimately untranslatable
//       (numeric/symbol/whitespace-only content - never sent to the model
//       in the first place, so it never having a `translation` isn't a
//       failure of anything).
//   1 - ran, but every segment fell back to its original text (total > 0
//       and translated === 0) for a reason OTHER than skipped-untranslatable
//       - or a usage/setup error before the pipeline could even start.
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
import { ADAPTERS } from './adapters/registry'
import { runPipeline, UNTRANSLATABLE_REASON, type RunReport } from './pipeline'
import {
  ensureOllama as realEnsureOllama,
  OllamaNotFoundError,
  type OllamaConnection
} from './translate/ollama/lifecycle'
import { OllamaBackend } from './translate/ollama/ollama-backend'
import type { TranslationBackend } from './translate/backend'

// Default model when --model is omitted. Hardcoded for now during the
// benchmark/evaluation phase of picking a default; a later release is
// expected to move this into user-configurable settings instead.
const DEFAULT_MODEL = 'gemma4:e4b'

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
  let model = DEFAULT_MODEL
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
  console.log(`  Duration         ${report.durationMs} ms`)

  if (report.keptOriginal.length > 0) {
    console.log('')
    console.log('  Kept original (id -> reason)')
    for (const k of report.keptOriginal) {
      console.log(`    ${k.id.padEnd(28)} ${k.reason}`)
    }
  }

  if (report.overflowed.length > 0) {
    console.log('')
    console.log('  Overflowed (id -> font size pt)')
    for (const o of report.overflowed) {
      console.log(`    ${o.id.padEnd(28)} ${o.fontSizePt}`)
    }
  }
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
 * A run has genuinely failed (exit 1) only when nothing was translated AND
 * at least one kept-original segment was kept for a reason other than
 * being legitimately untranslatable in the first place. A document that's
 * entirely numbers/symbols/whitespace - e.g. a spec sheet of dimensions -
 * has translated === 0 with total > 0, but every one of those segments was
 * correctly never sent to the model (see UNTRANSLATABLE_REASON in
 * pipeline.ts), so that run succeeded at doing exactly what it should
 * have and must not be reported as a failure.
 */
function isFailedRun(report: RunReport): boolean {
  if (report.translated > 0 || report.total === 0) return false
  return report.keptOriginal.some((k) => k.reason !== UNTRANSLATABLE_REASON)
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

  const adapter = adapterFor(args.file, ADAPTERS)
  if (!adapter) {
    console.error(
      `No adapter registered for "${args.file}" (known extensions: ${ADAPTERS.flatMap((a) => a.extensions).join(', ')})`
    )
    return 1
  }

  const appDataDir = resolveAppDataDir()

  let connection: OllamaConnection
  try {
    connection = await deps.ensureOllama({ appDataDir })
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
