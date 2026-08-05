import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  _internals,
  ensureOllama,
  findOllamaExe,
  OllamaNotFoundError
} from '../../../src/core/translate/ollama/lifecycle'
import { OLLAMA_STANDALONE_URL } from '../../../src/core/translate/ollama/download'

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-serve.cjs')

// --- test helpers -----------------------------------------------------

/** Ephemeral free TCP port, obtained by binding to port 0 and releasing it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('could not determine free port'))
        return
      }
      const { port } = addr
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('waitUntil: timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function pingVersion(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(300) })
    return res.ok
  } catch {
    return false
  }
}

/** Spawns the fixture directly (bypassing lifecycle.ts) to simulate a leftover process. */
function spawnRawFixture(port: number): ChildProcess {
  return spawn(process.execPath, [FIXTURE, 'serve'], {
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}` },
    stdio: ['pipe', 'ignore', 'ignore']
  })
}

const envKeys = [
  'LOCALAPPDATA',
  'PATH',
  'Path',
  'OLLAMA_FAKE_SERVE_SCRIPT',
  'OLLAMA_FAKE_HOME_DIR',
  'OLLAMA_STOP_GRACE_MS'
] as const
let savedEnv: Record<string, string | undefined>
let fakeHomeDir: string

// Applies to every test in this file, not just ones that obviously spawn:
// ensureOllama() now runs crash-orphan cleanup (which calls resolveHomeDir()
// indirectly via resolveModelsDir on the spawn path) unconditionally, so any
// test calling ensureOllama() could end up resolving against this machine's
// real ~/.ollama/models if OLLAMA_FAKE_HOME_DIR weren't always set. Giving
// every test its own fresh, empty fake home directory up front means
// resolveModelsDir() deterministically falls back to <appDataDir>/models
// unless a test explicitly populates <fakeHomeDir>/.ollama/models itself.
beforeEach(async () => {
  savedEnv = {}
  for (const k of envKeys) savedEnv[k] = process.env[k]
  fakeHomeDir = await mkdtemp(path.join(tmpdir(), 'lt-fake-home-'))
  process.env.OLLAMA_FAKE_HOME_DIR = fakeHomeDir
})

afterEach(async () => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await rm(fakeHomeDir, { recursive: true, force: true })
})

// --- 1. already-running server: probe succeeds, never spawn, stop() is a no-op ---

describe('ensureOllama: existing server (probeUrl answers)', () => {
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/version') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ version: 'real-user-ollama' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('bad address')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('returns spawned:false pointed at the existing server without touching exePath', async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), 'lt-ollama-'))
    const conn = await ensureOllama({ appDataDir, probeUrl: baseUrl })

    expect(conn.spawned).toBe(false)
    expect(conn.baseUrl).toBe(baseUrl)
    // No pid file should have been written - nothing was spawned.
    expect(existsSync(path.join(appDataDir, 'ollama.pid'))).toBe(false)

    await rm(appDataDir, { recursive: true, force: true })
  })

  it('stop() on an unspawned connection never kills the existing server', async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), 'lt-ollama-'))
    const conn = await ensureOllama({ appDataDir, probeUrl: baseUrl })

    await conn.stop()

    // The server (owned by the test, not by lifecycle.ts) must still be answering.
    const res = await fetch(`${baseUrl}/api/version`)
    expect(res.ok).toBe(true)

    await rm(appDataDir, { recursive: true, force: true })
  })
})

// --- 2 & 3. spawning the fake exe, readiness polling, pid file, stop() ---

describe('ensureOllama: spawns the fake exe when nothing answers probeUrl', () => {
  let appDataDir: string
  let deadPort: number
  let spawnPort: number

  beforeEach(async () => {
    appDataDir = await mkdtemp(path.join(tmpdir(), 'lt-ollama-'))
    // freePort() releases the port immediately, so nothing is listening there.
    deadPort = await freePort()
    spawnPort = await freePort()
    process.env.OLLAMA_FAKE_SERVE_SCRIPT = FIXTURE
  })

  afterEach(async () => {
    await rm(appDataDir, { recursive: true, force: true })
  })

  it('spawns via the seam, waits for readiness, writes the pid file with correct env', async () => {
    const conn = await ensureOllama({
      appDataDir,
      exePath: 'C:\\nonexistent\\ollama.exe', // never actually invoked under the seam
      probeUrl: `http://127.0.0.1:${deadPort}`,
      port: spawnPort
    })

    try {
      expect(conn.spawned).toBe(true)
      expect(conn.baseUrl).toBe(`http://127.0.0.1:${spawnPort}`)

      // It's genuinely reachable - readiness polling actually worked.
      const res = await fetch(`${conn.baseUrl}/api/version`)
      expect(await res.json()).toEqual({ version: '0.0.0-fake' })

      // Env plumbing: OLLAMA_HOST matches the spawn port, OLLAMA_MODELS is set.
      const envRes = await fetch(`${conn.baseUrl}/__test/env`)
      const seenEnv = await envRes.json()
      expect(seenEnv.OLLAMA_HOST).toBe(`127.0.0.1:${spawnPort}`)
      expect(typeof seenEnv.OLLAMA_MODELS).toBe('string')
      expect(seenEnv.OLLAMA_MODELS.length).toBeGreaterThan(0)

      // pid file was written.
      const pidFile = path.join(appDataDir, 'ollama.pid')
      expect(existsSync(pidFile)).toBe(true)
      const parsed = JSON.parse(await readFile(pidFile, 'utf8'))
      expect(typeof parsed.pid).toBe('number')
      expect(isAlive(parsed.pid)).toBe(true)
    } finally {
      await conn.stop()
    }
  })

  it("OLLAMA_MODELS points at <appDataDir>/models when ~/.ollama/models doesn't win", async () => {
    // resolveModelsDir is exercised directly (pure function, no process) so this
    // doesn't depend on whether the real dev machine happens to have ~/.ollama/models.
    const home = await mkdtemp(path.join(tmpdir(), 'lt-fake-home-'))
    const dir = await _internals.resolveModelsDir(appDataDir, home)
    expect(dir).toBe(path.join(appDataDir, 'models'))
  })

  it('OLLAMA_MODELS points at ~/.ollama/models when that directory already exists', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'lt-fake-home-'))
    const existing = path.join(home, '.ollama', 'models')
    await mkdir(existing, { recursive: true })
    const dir = await _internals.resolveModelsDir(appDataDir, home)
    expect(dir).toBe(existing)
  })

  it('resolveSpawnCommand uses the seam when OLLAMA_FAKE_SERVE_SCRIPT is set, exePath otherwise', () => {
    process.env.OLLAMA_FAKE_SERVE_SCRIPT = FIXTURE
    expect(_internals.resolveSpawnCommand('C:\\real\\ollama.exe')).toEqual({
      command: process.execPath,
      args: [FIXTURE, 'serve']
    })

    delete process.env.OLLAMA_FAKE_SERVE_SCRIPT
    expect(_internals.resolveSpawnCommand('C:\\real\\ollama.exe')).toEqual({
      command: 'C:\\real\\ollama.exe',
      args: ['serve']
    })
  })

  it('resolveHomeDir uses OLLAMA_FAKE_HOME_DIR when set (always true in this suite via beforeEach)', () => {
    // The global beforeEach in this file always sets OLLAMA_FAKE_HOME_DIR, so
    // this asserts the seam itself in isolation rather than relying on that
    // as an implicit assumption elsewhere.
    expect(_internals.resolveHomeDir()).toBe(fakeHomeDir)

    delete process.env.OLLAMA_FAKE_HOME_DIR
    expect(_internals.resolveHomeDir()).not.toBe(fakeHomeDir)
  })

  it('ensureOllama actually resolves OLLAMA_MODELS against OLLAMA_FAKE_HOME_DIR, not the real machine home', async () => {
    // End-to-end version of the resolveHomeDir/resolveModelsDir unit tests
    // above: proves the seam is actually wired into ensureOllama's real
    // spawn path (via the fixture's /__test/env endpoint), not just that the
    // pure functions behave correctly in isolation.
    const existing = path.join(fakeHomeDir, '.ollama', 'models')
    await mkdir(existing, { recursive: true })

    const port = await freePort()
    const conn = await ensureOllama({
      appDataDir,
      exePath: 'unused-under-seam',
      probeUrl: `http://127.0.0.1:${deadPort}`,
      port
    })
    try {
      const envRes = await fetch(`${conn.baseUrl}/__test/env`)
      const seenEnv = await envRes.json()
      expect(seenEnv.OLLAMA_MODELS).toBe(existing)
    } finally {
      await conn.stop()
    }
  })
})

describe('ensureOllama: the chosen spawn port is already occupied by something else (EADDRINUSE)', () => {
  it('rejects promptly instead of waiting out the full readiness timeout, and cleans up the pid file', async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), 'lt-ollama-'))
    const deadPort = await freePort()
    const occupiedPort = await freePort()
    process.env.OLLAMA_FAKE_SERVE_SCRIPT = FIXTURE

    // Hold the port open so the spawned fake exe's own listen() fails with EADDRINUSE,
    // mirroring what happens if some unrelated process already owns the spawn port.
    const blocker = http.createServer()
    await new Promise<void>((resolve) => blocker.listen(occupiedPort, '127.0.0.1', resolve))

    const started = Date.now()
    try {
      await expect(
        ensureOllama({
          appDataDir,
          exePath: 'unused-under-seam',
          probeUrl: `http://127.0.0.1:${deadPort}`,
          port: occupiedPort
        })
      ).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }

    // Well under the 30s readiness timeout - the exit is detected, not waited out.
    expect(Date.now() - started).toBeLessThan(5000)
    expect(existsSync(path.join(appDataDir, 'ollama.pid'))).toBe(false)

    await rm(appDataDir, { recursive: true, force: true })
  })
})

// Important-1 regression: crash-orphan cleanup must run even when this call
// ends up adopting a *different*, already-running server rather than
// spawning its own - otherwise a spawned child crash-orphaned on a previous
// run would never get reaped once the user (or a later launch) started a
// real Ollama that answers probeUrl first.
describe('ensureOllama: orphan cleanup runs even when a different server answers probeUrl', () => {
  it('terminates a stale spawned orphan and still returns the probed connection', async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), 'lt-ollama-'))
    process.env.OLLAMA_FAKE_SERVE_SCRIPT = FIXTURE

    // The orphan: a fake-serve process left running from a previous crashed
    // run, recorded in the pid file exactly as writePidFile() would have.
    const orphanPort = await freePort()
    const orphan = spawnRawFixture(orphanPort)
    try {
      await waitUntil(() => pingVersion(`http://127.0.0.1:${orphanPort}`))
      if (!orphan.pid) throw new Error('orphan did not get a pid')
      await writeFile(
        path.join(appDataDir, 'ollama.pid'),
        JSON.stringify({ pid: orphan.pid, exe: process.execPath })
      )

      // The "different, already-running server" - e.g. the user's own real
      // Ollama, started independently on the default probe port.
      const probeServer = http.createServer((req, res) => {
        if (req.url === '/api/version') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ version: 'real-user-ollama' }))
          return
        }
        res.writeHead(404)
        res.end()
      })
      await new Promise<void>((resolve) => probeServer.listen(0, '127.0.0.1', resolve))
      const addr = probeServer.address()
      if (addr === null || typeof addr === 'string') throw new Error('bad address')
      const probeUrl = `http://127.0.0.1:${addr.port}`

      try {
        const conn = await ensureOllama({ appDataDir, probeUrl })

        expect(conn.spawned).toBe(false)
        expect(conn.baseUrl).toBe(probeUrl)
        // The orphan was cleaned up as part of this call, not left running.
        expect(isAlive(orphan.pid)).toBe(false)
        expect(existsSync(path.join(appDataDir, 'ollama.pid'))).toBe(false)
      } finally {
        await new Promise<void>((resolve) => probeServer.close(() => resolve()))
      }
    } finally {
      if (orphan.pid && isAlive(orphan.pid)) orphan.kill()
      await rm(appDataDir, { recursive: true, force: true })
    }
  })
})

describe('OllamaConnection.stop(): terminates the spawned child and removes the pid file', () => {
  let appDataDir: string
  let deadPort: number
  let spawnPort: number

  beforeEach(async () => {
    appDataDir = await mkdtemp(path.join(tmpdir(), 'lt-ollama-'))
    deadPort = await freePort()
    spawnPort = await freePort()
    process.env.OLLAMA_FAKE_SERVE_SCRIPT = FIXTURE
    process.env.OLLAMA_STOP_GRACE_MS = '300' // keep the test fast; see _internals.terminatePid for the fallback-path unit test
  })

  afterEach(async () => {
    await rm(appDataDir, { recursive: true, force: true })
  })

  it('kills the process and deletes the pid file', async () => {
    const conn = await ensureOllama({
      appDataDir,
      exePath: 'unused-under-seam',
      probeUrl: `http://127.0.0.1:${deadPort}`,
      port: spawnPort
    })
    const pidFile = path.join(appDataDir, 'ollama.pid')
    const { pid } = JSON.parse(await readFile(pidFile, 'utf8'))
    expect(isAlive(pid)).toBe(true)

    await conn.stop()

    expect(isAlive(pid)).toBe(false)
    expect(existsSync(pidFile)).toBe(false)
    await expect(pingVersion(conn.baseUrl)).resolves.toBe(false)
  })

  it('is idempotent - calling stop() twice does not throw', async () => {
    const conn = await ensureOllama({
      appDataDir,
      exePath: 'unused-under-seam',
      probeUrl: `http://127.0.0.1:${deadPort}`,
      port: spawnPort
    })
    await conn.stop()
    await expect(conn.stop()).resolves.toBeUndefined()
  })

  // Gate round 4 regression, REAL process tree: the fixture spawns a child
  // standing in for real ollama's llama-server runner - a process that
  // ignores its parent's death entirely. stop() must reap it via the
  // Windows tree-kill; the old kill-then-taskkill order left exactly this
  // child alive forever (one leaked runner with a loaded model per run).
  // Windows-only: the tree-kill primitive is taskkill; posix ollama reaps
  // its own runners on SIGTERM instead (see terminatePid's doc comment).
  it.skipIf(process.platform !== 'win32')(
    'reaps the spawned server\'s CHILD process too (the "llama-server runner" leak)',
    async () => {
      const childPidFile = path.join(appDataDir, 'runner-child.pid')
      process.env.OLLAMA_FAKE_SERVE_SPAWN_CHILD = childPidFile
      let childPid: number | null = null
      try {
        const conn = await ensureOllama({
          appDataDir,
          exePath: 'unused-under-seam',
          probeUrl: `http://127.0.0.1:${deadPort}`,
          port: spawnPort
        })
        childPid = Number(await readFile(childPidFile, 'utf8'))
        expect(isAlive(childPid)).toBe(true)

        await conn.stop()

        // taskkill /T /F is synchronous-ish but give the OS a beat.
        const deadline = Date.now() + 3000
        while (Date.now() < deadline && isAlive(childPid)) {
          await new Promise((r) => setTimeout(r, 50))
        }
        expect(isAlive(childPid)).toBe(false)
      } finally {
        delete process.env.OLLAMA_FAKE_SERVE_SPAWN_CHILD
        if (childPid && isAlive(childPid)) {
          try {
            process.kill(childPid)
          } catch {
            // already gone
          }
        }
      }
    }
  )
})

// --- 4. crash-orphan cleanup on ensureOllama start ---

describe('ensureOllama: crash-orphan pid file cleanup', () => {
  let appDataDir: string
  let deadPort: number
  const rawChildren: ChildProcess[] = []

  beforeEach(async () => {
    appDataDir = await mkdtemp(path.join(tmpdir(), 'lt-ollama-'))
    deadPort = await freePort()
    process.env.OLLAMA_FAKE_SERVE_SCRIPT = FIXTURE
    process.env.OLLAMA_STOP_GRACE_MS = '300'
  })

  afterEach(async () => {
    for (const c of rawChildren) {
      if (c.pid && isAlive(c.pid)) c.kill()
    }
    rawChildren.length = 0
    await rm(appDataDir, { recursive: true, force: true })
  })

  it('kills a stale pid that is alive and matches the recorded executable', async () => {
    const orphanPort = await freePort()
    const orphan = spawnRawFixture(orphanPort)
    rawChildren.push(orphan)
    await waitUntil(() => pingVersion(`http://127.0.0.1:${orphanPort}`))
    if (!orphan.pid) throw new Error('orphan did not get a pid')

    await writeFile(
      path.join(appDataDir, 'ollama.pid'),
      JSON.stringify({ pid: orphan.pid, exe: process.execPath })
    )

    const newPort = await freePort()
    const conn = await ensureOllama({
      appDataDir,
      exePath: 'unused-under-seam',
      probeUrl: `http://127.0.0.1:${deadPort}`,
      port: newPort
    })
    try {
      expect(isAlive(orphan.pid)).toBe(false) // the orphan was terminated as part of startup
      expect(conn.spawned).toBe(true)
      const pidFile = JSON.parse(await readFile(path.join(appDataDir, 'ollama.pid'), 'utf8'))
      expect(pidFile.pid).not.toBe(orphan.pid)
    } finally {
      await conn.stop()
    }
  })

  it('deletes the pid file without killing anything when the recorded pid is dead', async () => {
    const short = spawn(process.execPath, ['-e', 'process.exit(0)'])
    await new Promise((resolve) => short.once('exit', resolve))
    const deadPid = short.pid
    if (!deadPid) throw new Error('short-lived process did not get a pid')
    expect(isAlive(deadPid)).toBe(false)

    await writeFile(
      path.join(appDataDir, 'ollama.pid'),
      JSON.stringify({ pid: deadPid, exe: process.execPath })
    )

    const newPort = await freePort()
    const conn = await ensureOllama({
      appDataDir,
      exePath: 'unused-under-seam',
      probeUrl: `http://127.0.0.1:${deadPort}`,
      port: newPort
    })
    try {
      expect(conn.spawned).toBe(true)
      expect(existsSync(path.join(appDataDir, 'ollama.pid'))).toBe(true)
    } finally {
      await conn.stop()
    }
  })

  it('leaves an alive pid alone and just deletes the file when it belongs to another program', async () => {
    const bystanderPort = await freePort()
    const bystander = spawnRawFixture(bystanderPort)
    rawChildren.push(bystander)
    await waitUntil(() => pingVersion(`http://127.0.0.1:${bystanderPort}`))
    if (!bystander.pid) throw new Error('bystander did not get a pid')

    // Recorded exe deliberately does NOT match the bystander's actual image (node.exe).
    await writeFile(
      path.join(appDataDir, 'ollama.pid'),
      JSON.stringify({ pid: bystander.pid, exe: 'C:\\some\\other\\program.exe' })
    )

    const newPort = await freePort()
    const conn = await ensureOllama({
      appDataDir,
      exePath: 'unused-under-seam',
      probeUrl: `http://127.0.0.1:${deadPort}`,
      port: newPort
    })
    try {
      expect(isAlive(bystander.pid)).toBe(true) // never touched
      const pidFile = JSON.parse(await readFile(path.join(appDataDir, 'ollama.pid'), 'utf8'))
      expect(pidFile.pid).not.toBe(bystander.pid)
    } finally {
      await conn.stop()
    }
  })
})

// --- 5. no exe found and none supplied ---

describe('ensureOllama: OllamaNotFoundError', () => {
  it('throws OllamaNotFoundError carrying OLLAMA_STANDALONE_URL when no exe can be found', async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), 'lt-ollama-'))
    const deadPort = await freePort()
    const emptyDir = await mkdtemp(path.join(tmpdir(), 'lt-empty-'))
    // Sandbox the lookup so this doesn't find the real Ollama install on this machine.
    process.env.LOCALAPPDATA = emptyDir
    process.env.PATH = emptyDir
    process.env.Path = emptyDir
    delete process.env.OLLAMA_FAKE_SERVE_SCRIPT

    await expect(
      ensureOllama({ appDataDir, probeUrl: `http://127.0.0.1:${deadPort}` })
    ).rejects.toThrow(OllamaNotFoundError)

    try {
      await ensureOllama({ appDataDir, probeUrl: `http://127.0.0.1:${deadPort}` })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaNotFoundError)
      expect((err as OllamaNotFoundError).standaloneUrl).toBe(OLLAMA_STANDALONE_URL)
    }

    await rm(appDataDir, { recursive: true, force: true })
    await rm(emptyDir, { recursive: true, force: true })
  })
})

// --- findOllamaExe() ---

describe('findOllamaExe', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'lt-exe-'))
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('returns null when nothing is found on LOCALAPPDATA or PATH', () => {
    process.env.LOCALAPPDATA = tmpRoot
    process.env.PATH = ''
    process.env.Path = ''
    expect(findOllamaExe()).toBeNull()
  })

  it('finds the exe under %LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe first', async () => {
    const dir = path.join(tmpRoot, 'Programs', 'Ollama')
    await mkdir(dir, { recursive: true })
    const exe = path.join(dir, 'ollama.exe')
    await writeFile(exe, '')

    process.env.LOCALAPPDATA = tmpRoot
    process.env.PATH = ''
    expect(findOllamaExe()).toBe(exe)
  })

  it('falls back to scanning PATH entries when not under LOCALAPPDATA', async () => {
    const pathDir = path.join(tmpRoot, 'somewhere-on-path')
    await mkdir(pathDir, { recursive: true })
    const exe = path.join(pathDir, 'ollama.exe')
    await writeFile(exe, '')

    process.env.LOCALAPPDATA = path.join(tmpRoot, 'does-not-exist')
    process.env.PATH = [path.join(tmpRoot, 'also-missing'), pathDir].join(path.delimiter)
    expect(findOllamaExe()).toBe(exe)
  })
})

// --- _internals.terminatePid: deterministic unit tests of both platform orders ---

describe('_internals.terminatePid - Windows order (gate round 4 regression: tree-kill FIRST)', () => {
  // taskkill /T can only enumerate descendants of a LIVING root: the old
  // kill-then-taskkill order terminated the root instantly (TerminateProcess
  // is never graceful), so the later tree-kill found nothing and every
  // spawned-server run leaked one immortal llama-server runner. Found live:
  // four orphaned runners, all parents dead, ~25 GB of commit unattributed.

  it('runs the tree-kill FIRST, while the root is still alive, then waits out its disappearance', async () => {
    let alive = true
    const calls: string[] = []
    await _internals.terminatePid(4242, 50, {
      platform: 'win32',
      isAlive: () => {
        calls.push(`isAlive:${alive}`)
        return alive
      },
      kill: () => calls.push('kill'),
      forceKill: async (pid: number) => {
        calls.push(`forceKill:${pid}`)
        alive = false // taskkill /T /F reaps root + descendants together
      },
      delay: (ms: number) => new Promise((r) => setTimeout(r, ms))
    })
    // forceKill is the FIRST call of any kind - notably BEFORE any liveness
    // check or polite kill could take the root down and orphan the tree.
    expect(calls[0]).toBe('forceKill:4242')
    expect(calls).not.toContain('kill')
  })

  it('returns after the grace window even if the root somehow survives the tree-kill', async () => {
    const calls: string[] = []
    await _internals.terminatePid(4242, 20, {
      platform: 'win32',
      isAlive: () => true,
      kill: () => calls.push('kill'),
      forceKill: async (pid: number) => {
        calls.push(`forceKill:${pid}`)
      },
      delay: (ms: number) => new Promise((r) => setTimeout(r, ms))
    })
    expect(calls).toEqual(['forceKill:4242'])
  })
})

describe('_internals.terminatePid - POSIX order (graceful SIGTERM, then grace window, then force)', () => {
  // posix ollama traps SIGTERM and reaps its own runners, so the polite
  // phase is genuinely useful there - and forceKillPid falls back to
  // SIGKILL (no taskkill on posix).

  it('kills, then still runs the force-kill even though the process died immediately', async () => {
    let alive = true
    const calls: string[] = []
    await _internals.terminatePid(4242, 50, {
      platform: 'linux',
      isAlive: () => alive,
      kill: () => {
        calls.push('kill')
        alive = false // simulate the process reacting to SIGTERM promptly
      },
      forceKill: async (pid: number) => {
        calls.push(`forceKill:${pid}`)
      },
      delay: (ms: number) => new Promise((r) => setTimeout(r, ms))
    })
    expect(calls).toEqual(['kill', 'forceKill:4242'])
  })

  it('kills, waits out the grace window, then force-kills when the pid stays alive throughout', async () => {
    const calls: string[] = []
    await _internals.terminatePid(4242, 20, {
      platform: 'linux',
      isAlive: () => true, // never reacts to kill() on its own
      kill: () => calls.push('kill'),
      forceKill: async (pid: number) => {
        calls.push(`forceKill:${pid}`)
      },
      delay: (ms: number) => new Promise((r) => setTimeout(r, ms))
    })
    expect(calls).toEqual(['kill', 'forceKill:4242'])
  })

  it('skips kill() but still runs the force-kill (as a safe no-op) when the pid was already dead at entry', async () => {
    const calls: string[] = []
    await _internals.terminatePid(4242, 50, {
      platform: 'linux',
      isAlive: () => false,
      kill: () => calls.push('kill'),
      forceKill: async (pid: number) => {
        calls.push(`forceKill:${pid}`)
      },
      delay: (ms: number) => new Promise((r) => setTimeout(r, ms))
    })
    expect(calls).toEqual(['forceKill:4242'])
  })
})

// --- _internals.findOrphanedRunnerPids: pure decision arm of the orphan sweep ---

describe('_internals.findOrphanedRunnerPids', () => {
  const processes = [
    { pid: 100, ppid: 50, name: 'llama-server.exe' }, // parent alive -> keep
    { pid: 101, ppid: 51, name: 'llama-server.exe' }, // parent dead -> orphan
    { pid: 102, ppid: 52, name: 'llama-server' }, // exe-less name variant, parent dead -> orphan
    { pid: 103, ppid: 53, name: 'notepad.exe' }, // not a runner -> never touched
    { pid: 104, ppid: 54, name: 'my-llama-server.exe' } // name must match exactly, not substring
  ]
  const livePids = new Set([50])

  it('returns exactly the llama-server processes whose parent is dead', () => {
    const orphans = _internals.findOrphanedRunnerPids(processes, (pid) => livePids.has(pid))
    expect(orphans).toEqual([101, 102])
  })

  it('returns nothing when every runner has a living parent (e.g. the desktop app is up)', () => {
    const orphans = _internals.findOrphanedRunnerPids(
      processes.filter((p) => p.name.startsWith('llama-server')),
      () => true
    )
    expect(orphans).toEqual([])
  })
})
