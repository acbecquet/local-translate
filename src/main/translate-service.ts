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
import { DEFAULT_MODEL } from '../core/defaults'
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

// Re-exported (not just used internally) because tests/main/translate-service.test.ts
// and other main-process callers import DEFAULT_MODEL from this module, not
// from src/core/defaults directly - see defaults.ts for the single source of
// truth this and src/core/cli.ts both now import instead of duplicating.
export { DEFAULT_MODEL }

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
 *
 * Single-flight, two layers deep (reviewer-flagged: concurrent run() calls
 * could otherwise race ensureOllama and orphan a spawned connection past
 * quit):
 *   1. run() itself rejects a second concurrent call outright (`running`
 *      flag, checked and set synchronously before any await - see run()).
 *      This is what makes two overlapping run() calls impossible today.
 *   2. acquireConnection() ALSO dedupes concurrent callers onto one
 *      in-flight ensureOllama() call (`connectionPromise`), and stop()
 *      waits for that in-flight acquisition rather than only checking the
 *      (still-null-until-resolved) `connection` field. Layer 1 makes layer
 *      2 currently unreachable via two run() calls, but it's kept as
 *      defense in depth - and it's what actually fixes the "orphaned
 *      connection past quit" report: quit can land while ensureOllama is
 *      still in flight (stop() called mid-acquisition), which is a single
 *      run(), not a concurrency race between two.
 */
export class TranslateService {
  private readonly deps: TranslateServiceDeps
  private connection: OllamaConnection | null = null
  private connectionPromise: Promise<OllamaConnection> | null = null
  private cancelRequested = false
  private running = false
  /** outPaths of runs that completed successfully this session (path.resolve()-normalized) - see isKnownOutPath(). */
  private readonly knownOutPaths = new Set<string>()

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
   * Whether `filePath` (normalized via path.resolve, so a redundant "./" or
   * ".." segment doesn't cause a false miss) is the outPath of some run
   * that completed successfully this session. Used by ipc.ts to scope
   * app:openPath/app:showInFolder to files this app itself just produced,
   * rather than letting the renderer ask the main process to open or
   * reveal an arbitrary filesystem path.
   */
  isKnownOutPath(filePath: string): boolean {
    return this.knownOutPaths.has(path.resolve(filePath))
  }

  /**
   * Runs one translate job end to end: resolves the adapter, establishes
   * (or reuses) the Ollama connection, runs the pipeline, and reports
   * state/progress via the injected callbacks throughout. Resolves with the
   * RunReport on success; rejects - after emitting a final 'error' state
   * carrying the same message - on any failure, including cancellation.
   *
   * Rejects IMMEDIATELY, before doing anything else (no state event, so it
   * never clobbers whatever run is actually in flight's own state stream),
   * if another run() call hasn't finished yet - see the class doc comment.
   */
  async run(req: TranslateRunRequest): Promise<RunReport> {
    if (this.running) {
      throw new Error('a translation is already running')
    }
    this.running = true
    this.cancelRequested = false

    try {
      const adapter = adapterFor(req.filePath, this.deps.adapters)
      if (!adapter) {
        throw new Error(
          `No adapter registered for "${req.filePath}" (known extensions: ` +
            `${this.deps.adapters.flatMap((a) => a.extensions).join(', ')})`
        )
      }

      // Timed here rather than inside acquireConnection() itself: on a
      // reused connection (the common case - see acquireConnection's own
      // doc comment) this resolves immediately without ever calling
      // ensureOllama, so connectMs naturally comes out ~0 for every run
      // after the first, exactly like the CLI's equivalent timing in
      // cli.ts's runCli.
      const connectStart = Date.now()
      const connection = await this.acquireConnection()
      const connectMs = Date.now() - connectStart

      this.deps.onState({ state: 'translating' })

      const backend = this.deps.createBackend({
        baseUrl: connection.baseUrl,
        appDataDir: this.deps.appDataDir
      })

      const report = await this.deps.runPipeline({
        file: req.filePath,
        sourceLang: req.sourceLang,
        targetLang: req.targetLang,
        model: this.deps.model,
        adapter,
        backend,
        connectMs,
        onProgress: (done, total, phase) => {
          this.deps.onProgress({ done, total, phase })
          if (this.cancelRequested) throw new CancelledError()
        }
      })

      this.knownOutPaths.add(path.resolve(report.outPath))
      this.deps.onState({ state: 'done' })
      return report
    } catch (err) {
      const message = describeError(err)
      this.deps.onState({ state: 'error', message })
      throw err instanceof CancelledError ? new Error(message) : err
    } finally {
      this.running = false
    }
  }

  /**
   * Resolves the held OllamaConnection, establishing one if none exists
   * yet. Concurrent callers share the SAME in-flight ensureOllama() call
   * via `connectionPromise` rather than each racing their own - without
   * this, two overlapping callers could both observe `connection === null`,
   * both call ensureOllama(), and stop() running in between could stop one
   * spawned server while the other keeps running, orphaned, past quit (see
   * the class doc comment for why run()'s own single-flight guard makes
   * this unreachable via two run() calls today, and why this layer is kept
   * anyway). `connectionPromise` is cleared once settled (success OR
   * failure) so a failed attempt doesn't permanently block retrying on the
   * next call.
   */
  private async acquireConnection(): Promise<OllamaConnection> {
    if (this.connection) return this.connection
    if (!this.connectionPromise) {
      this.deps.onState({ state: 'starting-ollama' })
      this.connectionPromise = this.deps
        .ensureOllama({ appDataDir: this.deps.appDataDir })
        .then((connection) => {
          this.connection = connection
          return connection
        })
        .finally(() => {
          this.connectionPromise = null
        })
    }
    return this.connectionPromise
  }

  /**
   * Stops the held OllamaConnection (a no-op unless one was actually
   * spawned - see OllamaConnection.stop()'s own contract in lifecycle.ts)
   * and forgets it, so the next run() re-establishes a fresh one. Safe to
   * call with no run ever having happened. Called once, from
   * main/index.ts's 'before-quit' hook.
   *
   * Waits out any in-flight connection acquisition FIRST: stopping only
   * `this.connection` (still null while ensureOllama is in flight) would
   * otherwise let a just-spawned server outlive quit, orphaned with nothing
   * left holding a reference to stop it - the exact bug this method exists
   * to close.
   */
  async stop(): Promise<void> {
    if (this.connectionPromise) {
      await this.connectionPromise.catch(() => {})
    }
    const connection = this.connection
    this.connection = null
    if (connection) await connection.stop()
  }
}
