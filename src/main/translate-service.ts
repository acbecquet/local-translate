// Main-process (but Electron-free) service that wires the core engine's
// runPipeline into the app: resolves the app data dir the same way the CLI
// does, holds a single OllamaConnection across every run (so translating a
// second file doesn't pay the ensureOllama cost again, and never spawns a
// second server), and reports progress/state via injected callbacks so this
// file never has to import electron itself - src/main/index.ts constructs
// the real instance and forwards those callbacks to webContents.send.
//
// Deliberately importable and unit-testable without ever touching electron:
// every collaborator that talks to the outside world (Ollama lifecycle, the
// translation backend, the pipeline itself, the adapter registry) is
// injectable via TranslateServiceDeps, mirroring cli.ts's CliDeps pattern -
// see tests/main/translate-service.test.ts.

import os from 'node:os'
import path from 'node:path'
import { adapterFor, type FormatAdapter } from '../core/adapters/adapter'
import { ADAPTERS } from '../core/adapters/registry'
import { runPipeline as realRunPipeline, type PipelineOpts, type RunReport } from '../core/pipeline'
import type { TranslationBackend } from '../core/translate/backend'
import {
  ensureOllama as realEnsureOllama,
  OllamaNotFoundError,
  type OllamaConnection
} from '../core/translate/ollama/lifecycle'
import { OllamaBackend } from '../core/translate/ollama/ollama-backend'
import type {
  TranslateProgressEvent,
  TranslateRunRequest,
  TranslateStateEvent
} from '../shared/ipc-contract'

/**
 * Default translation model. Duplicated from src/core/cli.ts's own
 * DEFAULT_MODEL (rather than imported) so the Electron main process doesn't
 * pull in cli.ts - a process-entry module with its own argv parsing and
 * process.exit() branch that has no business being reachable from here.
 * Keep in sync with cli.ts's DEFAULT_MODEL if that default ever changes.
 */
export const DEFAULT_MODEL = 'gemma4:e4b'

/**
 * Where the app keeps its Ollama pid file, model-caps cache, and (for a
 * managed install) downloaded models - identical LOCALAPPDATA-first,
 * homedir-fallback resolution to cli.ts's own resolveAppDataDir(),
 * duplicated here for the same "don't import cli.ts" reason as
 * DEFAULT_MODEL above.
 */
export function resolveAppDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'local_translate')
}

export interface TranslateServiceDeps {
  adapters: FormatAdapter[]
  ensureOllama: (opts: { appDataDir: string }) => Promise<OllamaConnection>
  createBackend: (opts: { baseUrl: string; appDataDir: string }) => TranslationBackend
  runPipeline: (opts: PipelineOpts) => Promise<RunReport>
  appDataDir: string
  model: string
  onProgress: (e: TranslateProgressEvent) => void
  onState: (e: TranslateStateEvent) => void
}

function defaultDeps(): TranslateServiceDeps {
  return {
    adapters: ADAPTERS,
    ensureOllama: realEnsureOllama,
    createBackend: (opts) => new OllamaBackend(opts),
    runPipeline: realRunPipeline,
    appDataDir: resolveAppDataDir(),
    model: DEFAULT_MODEL,
    onProgress: () => {},
    onState: () => {}
  }
}

/**
 * Thrown internally, from inside the onProgress callback handed to
 * runPipeline, when translate:cancel was requested. Never leaks past run():
 * callers see a plain `Error('cancelled')` instead (see describeError /
 * the catch block in run()), matching the IPC contract's "report state
 * 'error' with message 'cancelled'".
 */
class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

/**
 * Turns any error run() might catch into the actionable, user-facing string
 * reported via both the 'error' state event and the rejected run() promise.
 * OllamaNotFoundError gets the download URL appended on its own line
 * (mirrors cli.ts's printError+standaloneUrl console output) so the
 * renderer's error panel can show it without special-casing the error type
 * itself - the message text already carries everything actionable.
 */
function describeError(err: unknown): string {
  if (err instanceof OllamaNotFoundError) {
    return `${err.message}\nDownload: ${err.standaloneUrl}`
  }
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Wires the core engine into the app for one BrowserWindow's worth of
 * translate runs. One instance is expected to live for the app's lifetime -
 * constructed once in main/index.ts, stopped from its 'before-quit' hook -
 * see the module doc comment above for why it never imports electron
 * directly.
 */
export class TranslateService {
  private readonly deps: TranslateServiceDeps
  private connection: OllamaConnection | null = null
  private cancelRequested = false

  constructor(overrides: Partial<TranslateServiceDeps> = {}) {
    this.deps = { ...defaultDeps(), ...overrides }
  }

  /**
   * Requests cancellation of whatever run() call is currently in flight.
   * v1 semantics (per the IPC contract): takes effect at the next group
   * boundary inside the pipeline's translate phase, not immediately - the
   * flag is only ever read from the onProgress callback passed to
   * runPipeline in run() below. A no-op if no run is in flight; the flag is
   * cleared again at the start of the next run().
   */
  cancel(): void {
    this.cancelRequested = true
  }

  /**
   * Runs one translate job end to end: resolves the adapter, establishes
   * (or reuses) the Ollama connection, runs the pipeline, and reports
   * state/progress via the injected callbacks throughout. Resolves with the
   * RunReport on success; rejects - after emitting a final 'error' state
   * carrying the same message - on any failure, including cancellation.
   */
  async run(req: TranslateRunRequest): Promise<RunReport> {
    this.cancelRequested = false

    try {
      const adapter = adapterFor(req.filePath, this.deps.adapters)
      if (!adapter) {
        throw new Error(
          `No adapter registered for "${req.filePath}" (known extensions: ` +
            `${this.deps.adapters.flatMap((a) => a.extensions).join(', ')})`
        )
      }

      if (!this.connection) {
        this.deps.onState({ state: 'starting-ollama' })
        this.connection = await this.deps.ensureOllama({ appDataDir: this.deps.appDataDir })
      }

      this.deps.onState({ state: 'translating' })

      const backend = this.deps.createBackend({
        baseUrl: this.connection.baseUrl,
        appDataDir: this.deps.appDataDir
      })

      const report = await this.deps.runPipeline({
        file: req.filePath,
        sourceLang: req.sourceLang,
        targetLang: req.targetLang,
        model: this.deps.model,
        adapter,
        backend,
        onProgress: (done, total, phase) => {
          this.deps.onProgress({ done, total, phase })
          if (this.cancelRequested) throw new CancelledError()
        }
      })

      this.deps.onState({ state: 'done' })
      return report
    } catch (err) {
      const message = describeError(err)
      this.deps.onState({ state: 'error', message })
      throw err instanceof CancelledError ? new Error(message) : err
    }
  }

  /**
   * Stops the held OllamaConnection (a no-op unless one was actually
   * spawned - see OllamaConnection.stop()'s own contract in lifecycle.ts)
   * and forgets it, so the next run() re-establishes a fresh one. Safe to
   * call with no run ever having happened. Called once, from
   * main/index.ts's 'before-quit' hook.
   */
  async stop(): Promise<void> {
    const connection = this.connection
    this.connection = null
    if (connection) await connection.stop()
  }
}
