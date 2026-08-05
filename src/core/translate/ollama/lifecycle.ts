import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
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

  await mkdir(opts.appDataDir, { recursive: true })

  // 4. Crash-orphan cleanup: a pid file left over from a previous run that
  // never got to call stop() (app crash / force-quit). This runs
  // unconditionally, before the probe below, and regardless of which
  // branch we end up taking - a stale spawned child from a previous run
  // must be reaped even when *this* run ends up adopting a different,
  // already-running server (e.g. the user started their own Ollama on the
  // default port after our last spawned instance was crash-orphaned on
  // the spawn port). Doing this only inside the "we're about to spawn"
  // branch would leak that orphan indefinitely whenever an external
  // server happens to answer the probe.
  await cleanupStalePidFile(opts.appDataDir)

  // 5. Orphaned-runner sweep (gate round 4): llama-server runners whose
  // parent server died (a crashed run, or any run before the tree-kill-first
  // fix) hold their loaded model in VRAM/host commit FOREVER - nothing else
  // ever reaps them, and a handful of them exhausts the machine's commit
  // until a reboot. Best-effort and Windows-only; see reapOrphanedRunners.
  const reaped = await reapOrphanedRunners().catch(() => [] as number[])
  if (reaped.length > 0) {
    console.warn(
      `ollama lifecycle: reaped ${reaped.length} orphaned llama-server runner(s) (pids ${reaped.join(', ')}) - ` +
        'leaked by a crashed or pre-fix run; their parent server was gone'
    )
  }

  // 1. A server (the user's own, or one from a previous run of this app) is
  // already listening there - use it as-is and never touch its lifecycle.
  if (await probeVersion(probeUrl)) {
    return { baseUrl: probeUrl, spawned: false, stop: async () => {} }
  }

  const exePath = opts.exePath ?? findOllamaExe()
  if (!exePath) {
    throw new OllamaNotFoundError(OLLAMA_STANDALONE_URL)
  }

  const modelsDir = await resolveModelsDir(opts.appDataDir, resolveHomeDir())
  const port = opts.port ?? DEFAULT_SPAWN_PORT
  const baseUrl = `http://127.0.0.1:${port}`
  const { command, args } = resolveSpawnCommand(exePath)

  const spawnOptions: SpawnOptions = {
    env: {
      ...process.env,
      OLLAMA_HOST: `127.0.0.1:${port}`,
      OLLAMA_MODELS: modelsDir,
      // Our backend serializes requests (one group call at a time), so a
      // single scheduler slot is correct - Ollama's default of 4 parallel
      // slots quadruples the KV-cache VRAM for zero benefit and caused a
      // real ~1 GB allocation failure on Charlie's 16 GB card (2026-07-30).
      OLLAMA_NUM_PARALLEL: '1',
      OLLAMA_MAX_LOADED_MODELS: '1'
    },
    windowsHide: true,
    // stdin is piped (never written to, never closed by us) rather than
    // detached or fully ignored: if this app process dies unexpectedly
    // without calling stop(), Windows closes the pipe's write end for us,
    // which is a hint the fake-serve test fixture uses to self-terminate.
    // Real ollama.exe doesn't act on that, so it isn't load-bearing for
    // production cleanup - the pid-file orphan check above is - but it
    // costs nothing and keeps the child from being truly detached.
    // stdout/stderr are captured to a log file: ollama reports GPU
    // discovery (ROCm/Vulkan vs CPU fallback) only on its console, and
    // that evidence is essential when diagnosing why inference ran on CPU.
    stdio: ['pipe', 'pipe', 'pipe']
  }

  const child = await spawnChecked(command, args, spawnOptions)
  // Best-effort serve log; never let logging break the lifecycle.
  try {
    const logStream = createWriteStream(path.join(opts.appDataDir, 'ollama-serve.log'), {
      flags: 'a'
    })
    logStream.write(
      `\n===== ollama serve spawned ${new Date().toISOString()} pid=${child.pid} =====\n`
    )
    child.stdout?.pipe(logStream)
    child.stderr?.pipe(logStream)
  } catch {
    // logging is diagnostics only
  }
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

/**
 * Test-only seam: when OLLAMA_FAKE_HOME_DIR is set, ensureOllama() resolves
 * the OLLAMA_MODELS store against it instead of the real os.homedir().
 * Without this, every integration-style test that spawns through
 * ensureOllama() resolves against *this machine's* real home directory -
 * the fake exe never reads or writes there, so it's not unsafe, but it
 * makes resolveModelsDir()'s branch choice (real ~/.ollama/models vs
 * <appDataDir>/models) depend on whatever happens to exist on the dev/CI
 * box, rather than being deterministic. Read lazily, mirroring
 * OLLAMA_FAKE_SERVE_SCRIPT above.
 */
function resolveHomeDir(): string {
  return process.env.OLLAMA_FAKE_HOME_DIR || homedir()
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
    // Known limitation: Windows reuses pids. If the recorded pid has since
    // exited and been reassigned to an unrelated process that happens to
    // share the same image name (e.g. another node.exe, or a second
    // ollama.exe the user launched independently), this match is a false
    // positive and we'd terminate a process we don't actually own. There's
    // no cheap, race-free way to rule this out without also recording a
    // process start-time/handle at spawn time, which the pid-file format
    // doesn't do; accepted as a rare-edge-case tradeoff for the simpler format.
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
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'])
    } catch {
      // Already gone, or we lack permission - either way there's nothing more we can do.
    }
    return
  }
  // POSIX has no taskkill: SIGKILL the pid directly (the graceful SIGTERM in
  // terminatePid below already gave real ollama the chance to reap its own
  // runners - posix ollama traps SIGTERM; Windows TerminateProcess never
  // delivers one, which is why the win32 path can't rely on that at all).
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/**
 * Terminates the spawned server AND its process tree (contract point 3) -
 * real ollama.exe spawns a separate llama-server runner subprocess holding
 * the loaded model, and reaping only the parent leaks that runner (with the
 * model pinned in VRAM/host memory) forever.
 *
 * ORDER IS LOAD-BEARING, and platform-specific:
 *
 * Windows: the tree-kill (`taskkill /pid <pid> /T /F`) runs FIRST, while
 * the root is still alive. `/T` enumerates descendants BY WALKING FROM THE
 * ROOT - against an already-dead root it reports "not found" and kills
 * NOTHING, leaving the children orphaned beyond its reach (Windows does not
 * re-parent orphans, but taskkill can't start a walk from a pid that no
 * longer exists). The previous order here - polite kill(), grace window,
 * then taskkill - therefore leaked exactly one immortal llama-server per
 * spawned-server run: process.kill() on Windows is TerminateProcess (never
 * graceful, near-instant), so by the time taskkill ran, the root was gone
 * and the runner unreachable. Found live at gate round 4: four orphaned
 * runners, every parent dead, ~25 GB of system commit unattributed. The
 * grace loop after the tree-kill just waits for the root's disappearance to
 * be observable before stop() returns.
 *
 * POSIX: polite SIGTERM first - posix ollama traps it and shuts its runners
 * down itself - then the grace window, then SIGKILL as the fallback.
 *
 * All primitives (including `platform`) are injectable so both orders are
 * unit-tested deterministically (see _internals.terminatePid in
 * lifecycle.test.ts) without a real OS process or the real 5s default.
 */
async function terminatePid(
  pid: number,
  graceMs: number,
  deps: {
    isAlive?: (pid: number) => boolean
    kill?: (pid: number) => void
    forceKill?: (pid: number) => Promise<void>
    delay?: (ms: number) => Promise<void>
    platform?: NodeJS.Platform
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
  const platform = deps.platform ?? process.platform

  if (platform === 'win32') {
    // Tree-kill FIRST - see the doc comment: /T needs a LIVING root.
    await forceKill(pid)
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline && isAlive(pid)) {
      await wait(Math.min(50, Math.max(0, deadline - Date.now())))
    }
    return
  }

  if (isAlive(pid)) {
    kill(pid)

    const deadline = Date.now() + graceMs
    while (Date.now() < deadline && isAlive(pid)) {
      await wait(Math.min(50, Math.max(0, deadline - Date.now())))
    }
  }

  await forceKill(pid)
}

// --- orphaned-runner sweep -------------------------------------------------

/**
 * Pure decision arm of the sweep: among `processes`, the llama-server
 * runners whose PARENT is no longer alive. A runner's parent is the ollama
 * server that spawned it (our managed serve, or the user's desktop app);
 * Windows never re-parents, so a dead ppid means that server is gone and
 * nothing will ever reap or reuse this runner - it just sits on its loaded
 * model forever (the gate-round-4 leak: one such orphan per crashed or
 * pre-tree-kill-fix run, ~GBs of commit each). A runner whose parent is
 * ALIVE belongs to a running server (e.g. the desktop app) and is never
 * touched.
 */
function findOrphanedRunnerPids(
  processes: { pid: number; ppid: number; name: string }[],
  isAlive: (pid: number) => boolean = isProcessAlive
): number[] {
  return processes
    .filter((p) => /^llama-server(\.exe)?$/i.test(p.name) && !isAlive(p.ppid))
    .map((p) => p.pid)
}

/** Windows-only process listing for the sweep (CIM via powershell -
 * tasklist can't report parent pids). Returns [] on any failure or off
 * Windows: the sweep is a best-effort repair, never a gate. */
async function listRunnerProcesses(): Promise<{ pid: number; ppid: number; name: string }[]> {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'llama-server.exe\'" | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
    ])
    const raw = stdout.trim()
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
      .filter(
        (r): r is { ProcessId: number; ParentProcessId: number; Name: string } =>
          r !== null &&
          typeof r === 'object' &&
          typeof (r as { ProcessId?: unknown }).ProcessId === 'number' &&
          typeof (r as { ParentProcessId?: unknown }).ParentProcessId === 'number'
      )
      .map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name ?? '' }))
  } catch {
    return []
  }
}

/**
 * Reaps llama-server runners whose parent server is dead - the leak class
 * the tree-kill-first fix prevents going FORWARD; this sweep also repairs
 * what past runs (and crashes, which never reach stop() at all) already
 * left behind. Runs at every ensureOllama() start, mirroring
 * cleanupStalePidFile's own crash-orphan contract. Returns the reaped pids
 * so the caller can surface what happened.
 */
async function reapOrphanedRunners(): Promise<number[]> {
  const runners = await listRunnerProcesses()
  const orphans = findOrphanedRunnerPids(runners)
  for (const pid of orphans) {
    await forceKillPid(pid)
  }
  return orphans
}

export const _internals = {
  resolveModelsDir,
  resolveSpawnCommand,
  resolveHomeDir,
  terminatePid,
  isProcessAlive,
  imageNameForPid,
  findOrphanedRunnerPids,
  reapOrphanedRunners
}
