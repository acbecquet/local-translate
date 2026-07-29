import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { OLLAMA_STANDALONE_URL } from './download'

export interface OllamaConnection {
  baseUrl: string
  spawned: boolean
  stop(): Promise<void> // no-op unless spawned
}

/** Thrown by ensureOllama() when no exe was supplied and none could be found. */
export class OllamaNotFoundError extends Error {
  readonly standaloneUrl: string

  constructor(standaloneUrl: string) {
    super(
      `Ollama was not found on this machine. Download it from ${standaloneUrl} or install ` +
        'it, then try again.'
    )
    this.name = 'OllamaNotFoundError'
    this.standaloneUrl = standaloneUrl
  }
}

const DEFAULT_PROBE_URL = 'http://127.0.0.1:11434'
const DEFAULT_SPAWN_PORT = 11435
const READY_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 500
const DEFAULT_STOP_GRACE_MS = 5000
const PID_FILE_NAME = 'ollama.pid'

const execFileAsync = promisify(execFile)

/**
 * Locates a user-installed ollama.exe: first the standard per-user install
 * location, then a scan of PATH. Returns null if neither has it - callers
 * decide what to do next (ensureOllama throws OllamaNotFoundError).
 *
 * Reads process.env lazily (on every call, not at module load) specifically
 * so tests can point LOCALAPPDATA/PATH at temp fixture directories around a
 * single call without any module-level indirection.
 */
export function findOllamaExe(): string | null {
  const env = process.env

  const localAppData = env.LOCALAPPDATA
  if (localAppData) {
    const candidate = path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe')
    if (existsSync(candidate)) return candidate
  }

  const pathVar = env.PATH ?? env.Path ?? ''
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'ollama.exe')
    if (existsSync(candidate)) return candidate
  }

  return null
}

export async function ensureOllama(opts: {
  appDataDir: string
  port?: number // default 11435 for spawned servers
  exePath?: string // override for tests
  probeUrl?: string // override for tests (default http://127.0.0.1:11434)
}): Promise<OllamaConnection> {
  const probeUrl = opts.probeUrl ?? DEFAULT_PROBE_URL

  // 1. A server (the user's own, or one from a previous run of this app) is
  // already listening there - use it as-is and never touch its lifecycle.
  if (await probeVersion(probeUrl)) {
    return { baseUrl: probeUrl, spawned: false, stop: async () => {} }
  }

  const exePath = opts.exePath ?? findOllamaExe()
  if (!exePath) {
    throw new OllamaNotFoundError(OLLAMA_STANDALONE_URL)
  }

  await mkdir(opts.appDataDir, { recursive: true })

  // 4. Crash-orphan cleanup: a pid file left over from a previous run that
  // never got to call stop() (app crash / force-quit). Do this before
  // spawning a new child so it can't collide with the one we're about to
  // start.
  await cleanupStalePidFile(opts.appDataDir)

  const modelsDir = await resolveModelsDir(opts.appDataDir, homedir())
  const port = opts.port ?? DEFAULT_SPAWN_PORT
  const baseUrl = `http://127.0.0.1:${port}`
  const { command, args } = resolveSpawnCommand(exePath)

  const spawnOptions: SpawnOptions = {
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: modelsDir },
    windowsHide: true,
    // stdin is piped (never written to, never closed by us) rather than
    // detached or fully ignored: if this app process dies unexpectedly
    // without calling stop(), Windows closes the pipe's write end for us,
    // which is a hint the fake-serve test fixture uses to self-terminate.
    // Real ollama.exe doesn't act on that, so it isn't load-bearing for
    // production cleanup - the pid-file orphan check above is - but it
    // costs nothing and keeps the child from being truly detached.
    // stdout/stderr are ignored: we don't parse ollama's console output.
    stdio: ['pipe', 'ignore', 'ignore']
  }

  const child = await spawnChecked(command, args, spawnOptions)
  if (child.pid == null) {
    throw new Error(`ollama serve spawned without a pid (${command})`)
  }

  await writePidFile(opts.appDataDir, child.pid, command)

  try {
    await waitForReady(baseUrl, child, READY_TIMEOUT_MS)
  } catch (err) {
    await terminatePid(child.pid, stopGraceMs())
    await safeUnlink(pidFilePath(opts.appDataDir))
    throw err
  }

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    if (child.pid != null) {
      await terminatePid(child.pid, stopGraceMs())
    }
    await safeUnlink(pidFilePath(opts.appDataDir))
  }

  return { baseUrl, spawned: true, stop }
}

// --- spawning -----------------------------------------------------------

/**
 * Test-only seam: when OLLAMA_FAKE_SERVE_SCRIPT is set, spawn
 * `process.execPath <script> serve` instead of `exePath serve`. This lets
 * lifecycle.test.ts exercise the real spawn/probe/pid-file/stop machinery
 * against a tiny node:http fixture (tests/core/ollama/fixtures/fake-serve.cjs)
 * without ever touching a real Ollama install. Read lazily so tests can set
 * it per-call.
 */
function resolveSpawnCommand(exePath: string): { command: string; args: string[] } {
  const fakeScript = process.env.OLLAMA_FAKE_SERVE_SCRIPT
  if (fakeScript) {
    return { command: process.execPath, args: [fakeScript, 'serve'] }
  }
  return { command: exePath, args: ['serve'] }
}

/** spawn() that resolves once the child has actually started, or rejects on spawn error (e.g. ENOENT). */
function spawnChecked(
  command: string,
  args: string[],
  options: SpawnOptions
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn)
      reject(err)
    }
    const onSpawn = (): void => {
      child.off('error', onError)
      resolve(child)
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
}

async function resolveModelsDir(appDataDir: string, home: string): Promise<string> {
  const existing = path.join(home, '.ollama', 'models')
  if (await pathExists(existing)) return existing
  return path.join(appDataDir, 'models')
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// --- readiness polling ----------------------------------------------------

async function probeVersion(baseUrl: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/version', baseUrl), {
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res.ok
  } catch {
    return false
  }
}

async function waitForReady(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `ollama serve exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode})`
      )
    }
    if (await probeVersion(baseUrl)) return
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ollama serve to become ready at ${baseUrl}`)
    }
    await delay(100)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- pid file -------------------------------------------------------------

interface PidFileContents {
  pid: number
  exe: string
}

function pidFilePath(appDataDir: string): string {
  return path.join(appDataDir, PID_FILE_NAME)
}

async function writePidFile(appDataDir: string, pid: number, exe: string): Promise<void> {
  const contents: PidFileContents = { pid, exe }
  await writeFile(pidFilePath(appDataDir), JSON.stringify(contents), 'utf8')
}

async function readPidFile(appDataDir: string): Promise<PidFileContents | null> {
  try {
    const raw = await readFile(pidFilePath(appDataDir), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as PidFileContents).pid === 'number'
    ) {
      return parsed as PidFileContents
    }
    return null
  } catch {
    return null
  }
}

async function safeUnlink(file: string): Promise<void> {
  await unlink(file).catch(() => {})
}

/**
 * Contract point 4: on ensureOllama start, a pid file left over from a
 * previous run means either (a) that process is still alive and is the
 * ollama we spawned before - terminate it (crash-orphan cleanup) - or (b)
 * it's dead, or its pid now belongs to an unrelated program - just remove
 * the stale file. "Belongs to us" is decided by comparing the currently
 * running image name at that pid against the exe name we recorded when we
 * spawned it (ollama.exe in production; node.exe under the fake-serve test
 * seam), not by hardcoding "ollama.exe" - which is what makes this checkable
 * under the seam without special-casing tests.
 */
async function cleanupStalePidFile(appDataDir: string): Promise<void> {
  const contents = await readPidFile(appDataDir)
  if (!contents) {
    await safeUnlink(pidFilePath(appDataDir))
    return
  }

  if (isProcessAlive(contents.pid)) {
    const currentImage = await imageNameForPid(contents.pid)
    const expectedImage = path.basename(contents.exe || '')
    if (
      currentImage &&
      expectedImage &&
      currentImage.toLowerCase() === expectedImage.toLowerCase()
    ) {
      await terminatePid(contents.pid, stopGraceMs())
    }
    // else: alive but belongs to another program - leave it running, just drop the file below.
  }

  await safeUnlink(pidFilePath(appDataDir))
}

// --- process termination ---------------------------------------------------

function stopGraceMs(): number {
  const raw = process.env.OLLAMA_STOP_GRACE_MS
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STOP_GRACE_MS
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Image (exe basename only) currently running at `pid`, via `tasklist`, or null if not found. */
async function imageNameForPid(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('tasklist', [
      '/fi',
      `PID eq ${pid}`,
      '/fo',
      'csv',
      '/nh'
    ])
    const firstLine = stdout.trim().split(/\r?\n/)[0] ?? ''
    const match = /^"([^"]+)"/.exec(firstLine)
    return match ? match[1] : null
  } catch {
    return null
  }
}

async function forceKillPid(pid: number): Promise<void> {
  try {
    await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'])
  } catch {
    // Already gone, or we lack permission - either way there's nothing more we can do.
  }
}

/**
 * Graceful-then-forceful termination (contract point 3): `kill()` the pid,
 * and if it's still alive once `graceMs` elapses, fall back to
 * `taskkill /pid <pid> /T /F` to reap the whole process tree (important for
 * real ollama.exe, which can spawn a separate runner subprocess that a plain
 * kill of the parent wouldn't touch). All primitives are injectable so the
 * grace-window/fallback branch itself can be unit-tested deterministically
 * (see _internals.terminatePid in lifecycle.test.ts) without waiting on a
 * real OS process or the real 5s default.
 */
async function terminatePid(
  pid: number,
  graceMs: number,
  deps: {
    isAlive?: (pid: number) => boolean
    kill?: (pid: number) => void
    forceKill?: (pid: number) => Promise<void>
    delay?: (ms: number) => Promise<void>
  } = {}
): Promise<void> {
  const isAlive = deps.isAlive ?? isProcessAlive
  const kill =
    deps.kill ??
    ((p: number) => {
      try {
        process.kill(p)
      } catch {
        // already gone
      }
    })
  const forceKill = deps.forceKill ?? forceKillPid
  const wait = deps.delay ?? delay

  if (!isAlive(pid)) return

  kill(pid)

  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return
    await wait(Math.min(50, Math.max(0, deadline - Date.now())))
  }

  if (isAlive(pid)) {
    await forceKill(pid)
  }
}

export const _internals = {
  resolveModelsDir,
  resolveSpawnCommand,
  terminatePid,
  isProcessAlive,
  imageNameForPid
}
