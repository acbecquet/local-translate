// CLI entry point: `npm run translate -- <file> <sourceLang> <targetLang>
// [--model <name>] [--out <path>]`. Wires the FakeAdapter (the only adapter
// landed so far), a managed/adopted Ollama connection, and OllamaBackend
// into runPipeline, then prints the RunReport as a plain readable table.
//
// Exit codes:
//   0 - ran, and at least one segment was translated (or the doc had none).
//   1 - ran, but every segment fell back to its original text (total > 0
//       and translated === 0) - or a usage/setup error before the pipeline
//       could even start.
//   2 - Ollama could not be found or started (OllamaNotFoundError).

import os from 'node:os'
import path from 'node:path'
import { adapterFor, type FormatAdapter } from './adapters/adapter'
import { FakeAdapter } from './adapters/fake/fake-adapter'
import { runPipeline, type RunReport } from './pipeline'
import { ensureOllama, OllamaNotFoundError } from './translate/ollama/lifecycle'
import { OllamaBackend } from './translate/ollama/ollama-backend'

const ADAPTERS: FormatAdapter[] = [new FakeAdapter()]

/**
 * Where the CLI keeps its Ollama pid file, model-caps cache, and (for a
 * managed install) downloaded models: `$LOCAL_TRANSLATE_DATA_DIR` when set
 * (tests and power users), otherwise `%LOCALAPPDATA%`-equivalent under the
 * user's home directory. This resolver is deliberately CLI-only, not part
 * of the core pipeline - runPipeline receives everything it needs via opts
 * and has no notion of "app data directory" of its own.
 */
function resolveAppDataDir(): string {
  return (
    process.env.LOCAL_TRANSLATE_DATA_DIR ??
    path.join(os.homedir(), 'AppData', 'Local', 'local_translate')
  )
}

interface CliArgs {
  file: string
  sourceLang: string
  targetLang: string
  model: string
  out?: string
}

const USAGE = 'Usage: translate <file> <sourceLang> <targetLang> --model <name> [--out <path>]'

function parseArgs(argv: string[]): CliArgs | null {
  const positional: string[] = []
  let model: string | undefined
  let out: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--model') {
      model = argv[++i]
    } else if (arg === '--out') {
      out = argv[++i]
    } else {
      positional.push(arg)
    }
  }

  const [file, sourceLang, targetLang] = positional
  if (!file || !sourceLang || !targetLang || !model) return null
  return { file, sourceLang, targetLang, model, out }
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  const adapter = adapterFor(args.file, ADAPTERS)
  if (!adapter) {
    console.error(
      `No adapter registered for "${args.file}" (known extensions: ${ADAPTERS.flatMap((a) => a.extensions).join(', ')})`
    )
    process.exitCode = 1
    return
  }

  const appDataDir = resolveAppDataDir()

  const connection = await ensureOllama({ appDataDir }).catch((err: unknown) => {
    if (err instanceof OllamaNotFoundError) {
      console.error(err.message)
      console.error(`Download: ${err.standaloneUrl}`)
      process.exitCode = 2
      return null
    }
    throw err
  })
  if (!connection) return

  try {
    const backend = new OllamaBackend({ baseUrl: connection.baseUrl, appDataDir })
    const report = await runPipeline({
      file: args.file,
      out: args.out,
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      model: args.model,
      adapter,
      backend
    })

    printReport(report)

    if (report.total > 0 && report.translated === 0) {
      process.exitCode = 1
    }
  } finally {
    // no-ops for a connection we adopted rather than spawned (Task 3 contract).
    await connection.stop()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exitCode = 1
})
