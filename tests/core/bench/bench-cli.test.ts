import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TextSegment } from '../../../src/core/segments'
import type { BatchRequest, TranslationBackend } from '../../../src/core/translate/backend'
import type { OllamaConnection } from '../../../src/core/translate/ollama/lifecycle'
import { FakeAdapter } from '../../../src/core/adapters/fake/fake-adapter'
import {
  BenchStore,
  configHash,
  type CellConfig,
  type StoredCell,
  type StoredJudgement
} from '../../../src/core/bench/store'
import { JUDGE_PROMPT_VERSION, type JudgeTransport } from '../../../src/core/bench/judge'
import type { HarnessDeps } from '../../../src/core/bench/harness'
import { _internals, runBenchCli, type BenchCliDeps } from '../../../src/core/bench/bench-cli'
import {
  DEFAULT_OUT_DIR,
  generate as generateBenchDecks
} from '../../../scripts/make-bench-decks.mjs'

const { parseArgs, usage } = _internals

// --- temp dirs ---------------------------------------------------------

const tempDirs: string[] = []
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  _internals.setRepoRootForTesting(null)
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

// --- fixtures ------------------------------------------------------------

function seg(overrides: Partial<TextSegment> & { id: string; text: string }): TextSegment {
  return {
    box: { wPt: 400, hPt: 200 },
    font: { family: 'Noto Sans', sizePt: 18 },
    context: 'doc',
    kind: 'fake',
    ...overrides
  }
}

/** Writes a `.fake.json` fixture under `repoRoot/items/<id>.fake.json`, returns its repo-root-relative path (forward slashes, matching corpus.json's own convention). */
async function writeFakeItemFile(
  repoRoot: string,
  id: string,
  segments: TextSegment[]
): Promise<string> {
  const rel = path.join('items', `${id}.fake.json`)
  const abs = path.join(repoRoot, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, JSON.stringify({ segments }))
  return rel.replace(/\\/g, '/')
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2))
}

async function writeRoster(
  dir: string,
  roster: { models: string[]; judge: string }
): Promise<string> {
  const p = path.join(dir, 'roster.json')
  writeJson(p, roster)
  return p
}

interface FixtureCorpusItem {
  id: string
  file: string
  sourceLang: string
  targetLang: string
  kind: 'pptx' | 'image'
}

async function writeCorpus(dir: string, items: FixtureCorpusItem[]): Promise<string> {
  const p = path.join(dir, 'corpus.json')
  writeJson(p, { items })
  return p
}

function makeConfig(overrides: Partial<CellConfig> = {}): CellConfig {
  return {
    model: 'model-a',
    itemId: 'item-a',
    sourceLang: 'English',
    targetLang: 'German',
    ...overrides
  }
}

function makeCell(overrides: Partial<StoredCell> = {}): StoredCell {
  const config = overrides.config ?? makeConfig()
  return {
    config,
    configHash: configHash(config),
    report: {
      file: 'fixtures/whatever.pptx',
      outPath: 'out/whatever.pptx',
      total: 1,
      translated: 1,
      keptOriginal: [],
      overflowed: [],
      segments: [
        { id: 's1', sourceText: 'hello', translation: 'hallo', fittedSizePt: 12, lineCount: 1 }
      ],
      skippedUnsupported: [],
      durationMs: 100,
      stats: {
        model: config.model,
        phaseMs: { extract: 10, connect: 0, translate: 50, fit: 20, apply: 20 },
        groups: 1,
        modelCalls: 1,
        groupRetries: 0,
        perSegmentFallbacks: 0,
        promptTokens: 10,
        completionTokens: 10,
        tokensPerSec: 5,
        charsSource: 5,
        charsTranslated: 5,
        segmentsPerMin: 1
      }
    },
    artifactPath: path.join('artifacts', config.model, `${config.itemId}.pptx`),
    completedAt: new Date().toISOString(),
    ...overrides
  }
}

function makeJudgement(overrides: Partial<StoredJudgement> = {}): StoredJudgement {
  return {
    judgeModel: 'judge-x',
    promptVersion: JUDGE_PROMPT_VERSION,
    cellConfigHash: 'test-hash',
    scores: [{ segmentId: 's1', accuracy: 5, fluency: 5, format: 5 }],
    judgedAt: new Date().toISOString(),
    ...overrides
  }
}

function fakeConnection(stop = vi.fn().mockResolvedValue(undefined)): OllamaConnection {
  return { baseUrl: 'http://127.0.0.1:1', spawned: false, stop }
}

function fakeBackend(overrides: Partial<TranslationBackend> = {}): TranslationBackend {
  return {
    listModels: vi.fn().mockResolvedValue([]),
    pullModel: vi.fn().mockResolvedValue(undefined),
    translateBatch: vi.fn().mockResolvedValue({ translations: [] }),
    ...overrides
  }
}

function fakeHarnessDeps(overrides: Partial<HarnessDeps> = {}): HarnessDeps {
  return {
    ensureOllama: vi.fn().mockResolvedValue(fakeConnection()),
    createBackend: vi.fn().mockReturnValue(fakeBackend()),
    unloadModel: vi.fn().mockResolvedValue(undefined),
    buildAdapters: vi.fn().mockReturnValue([new FakeAdapter()]),
    ...overrides
  }
}

function fakeDeps(overrides: Partial<BenchCliDeps> = {}): BenchCliDeps {
  return {
    harnessDeps: fakeHarnessDeps(),
    ensureOllama: vi.fn().mockResolvedValue(fakeConnection()),
    createJudgeTransport: vi.fn().mockReturnValue({ chat: vi.fn() } satisfies JudgeTransport),
    ...overrides
  }
}

/** Extracts the `id` values embedded in a captured judge request's user message - mirrors judge.test.ts's own helper. */
function idsFromUserPrompt(user: string): string[] {
  return [...user.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1])
}

/** A well-formed judge response scoring every id present in `req.user` with the same (accuracy, fluency, format) = `score` triple - so meanOverall for a pass equals `score` exactly. */
function uniformScoreResponse(req: { user: string }, score = 5): string {
  const ids = idsFromUserPrompt(req.user)
  return JSON.stringify({
    scores: ids.map((id) => ({ id, accuracy: score, fluency: score, format: score }))
  })
}

function silenceConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

// --- contract point 1: unknown subcommand / bad flag -> usage + exit 1 -----

describe('_internals.parseArgs (contract point 1) - pure, testable without any I/O side effects beyond default-path resolution', () => {
  it('rejects an unknown subcommand', () => {
    const result = parseArgs(['bogus'])
    expect(result.ok).toBe(false)
  })

  it('rejects an empty argv (no subcommand at all)', () => {
    const result = parseArgs([])
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown flag, naming it in the error', () => {
    const result = parseArgs(['run', '--bogus'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('--bogus')
  })

  it('accepts --roster/--corpus/--store on every subcommand', () => {
    for (const cmd of ['run', 'judge', 'report', 'crown', 'status']) {
      const result = parseArgs([
        cmd,
        '--roster',
        'r.json',
        '--corpus',
        'c.json',
        '--store',
        's-dir'
      ])
      expect(result.ok).toBe(true)
    }
  })

  it('parses --stability only under judge', () => {
    const judgeResult = parseArgs(['judge', '--stability'])
    expect(judgeResult.ok).toBe(true)
    if (judgeResult.ok && judgeResult.command.cmd === 'judge') {
      expect(judgeResult.command.stability).toBe(true)
    }

    const runResult = parseArgs(['run', '--stability'])
    expect(runResult.ok).toBe(false)
  })

  it('parses an optional crown model positional, and rejects a positional on other subcommands', () => {
    const crowned = parseArgs(['crown', 'some-model'])
    expect(crowned.ok).toBe(true)
    if (crowned.ok && crowned.command.cmd === 'crown') {
      expect(crowned.command.model).toBe('some-model')
    }

    const crownedNoArg = parseArgs(['crown'])
    expect(crownedNoArg.ok).toBe(true)
    if (crownedNoArg.ok && crownedNoArg.command.cmd === 'crown') {
      expect(crownedNoArg.command.model).toBeNull()
    }

    const statusWithPositional = parseArgs(['status', 'unexpected'])
    expect(statusWithPositional.ok).toBe(false)
  })

  it('reports a missing value for --roster/--corpus/--store', () => {
    expect(parseArgs(['run', '--roster']).ok).toBe(false)
    expect(parseArgs(['run', '--corpus']).ok).toBe(false)
    expect(parseArgs(['run', '--store']).ok).toBe(false)
  })
})

describe('runBenchCli - unknown subcommand or bad flag prints usage and exits 1 (contract point 1)', () => {
  it('returns 1 on an unknown subcommand', async () => {
    silenceConsole()
    const code = await runBenchCli(['bogus'], fakeDeps())
    expect(code).toBe(1)
  })

  it('returns 1 on a bad flag', async () => {
    silenceConsole()
    const code = await runBenchCli(['run', '--nope'], fakeDeps())
    expect(code).toBe(1)
  })

  it('returns 1 and prints something on empty argv', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await runBenchCli([], fakeDeps())
    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('_internals.usage - dynamic default paths, never a hardcoded runtime-resolved value (mirrors cli.ts)', () => {
  it('names the current repoRoot override in the default --corpus/--roster paths, and the store default under resolveAppDataDir()', async () => {
    const tempRepoRoot = await makeTempDir('bench-cli-usage-')
    _internals.setRepoRootForTesting(tempRepoRoot)

    const text = usage()

    expect(text).toContain(path.join(tempRepoRoot, 'fixtures', 'bench', 'corpus.json'))
    expect(text).toContain(path.join(tempRepoRoot, 'fixtures', 'bench', 'roster.json'))
    // --store deliberately does NOT live under repoRoot - see bench-cli.ts's
    // defaultStorePath doc comment (must never litter the repo working tree
    // with the store's unbounded, ever-growing checkpoint database).
    expect(text).toContain(path.join(_internals.resolveAppDataDir(), 'bench-store'))
    expect(text).not.toContain(path.join(tempRepoRoot, 'fixtures', 'bench', 'store'))
  })

  it('--corpus/--roster change when the repoRoot override changes (proves the text is computed fresh, not cached), but --store stays anchored to appDataDir regardless - it must never depend on repoRoot', async () => {
    const rootOne = await makeTempDir('bench-cli-usage-one-')
    const rootTwo = await makeTempDir('bench-cli-usage-two-')

    _internals.setRepoRootForTesting(rootOne)
    const textOne = usage()
    _internals.setRepoRootForTesting(rootTwo)
    const textTwo = usage()

    expect(textOne).not.toBe(textTwo)
    expect(textTwo).toContain(rootTwo)
    expect(textTwo).not.toContain(rootOne)

    const storeDefault = path.join(_internals.resolveAppDataDir(), 'bench-store')
    expect(textOne).toContain(storeDefault)
    expect(textTwo).toContain(storeDefault)
  })
})

// --- contract point 2: run exit codes ---------------------------------------

describe('run - exit codes (contract point 2)', () => {
  it('exits 0 when every cell completes', async () => {
    const repoRoot = await makeTempDir('bench-cli-run-ok-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-run-ok-store-')

    const itemFile = await writeFakeItemFile(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hello' })])
    const corpusPath = await writeCorpus(repoRoot, [
      { id: 'item-1', file: itemFile, sourceLang: 'English', targetLang: 'German', kind: 'pptx' }
    ])
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    const translateBatch = vi.fn().mockImplementation(async (req: BatchRequest) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[DE] ${s.text}` }))
    }))
    const deps = fakeDeps({
      harnessDeps: fakeHarnessDeps({
        createBackend: vi.fn().mockReturnValue(fakeBackend({ translateBatch }))
      })
    })

    silenceConsole()

    const code = await runBenchCli(
      ['run', '--roster', rosterPath, '--corpus', corpusPath, '--store', storeDir],
      deps
    )

    expect(code).toBe(0)
    const store = new BenchStore(storeDir)
    expect(store.loadCell('model-a', 'item-1')).not.toBeNull()
  })

  it('exits 1 when a cell fails (a transport-class backend failure aborts the model)', async () => {
    const repoRoot = await makeTempDir('bench-cli-run-fail-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-run-fail-store-')

    const itemFile = await writeFakeItemFile(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hello' })])
    const corpusPath = await writeCorpus(repoRoot, [
      { id: 'item-1', file: itemFile, sourceLang: 'English', targetLang: 'German', kind: 'pptx' }
    ])
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    // Exactly what OllamaBackend produces for a real transport failure: it
    // RESOLVES (never rejects), nothing translated, failure reason 'error'.
    const translateBatch = vi.fn().mockResolvedValue({
      translations: [],
      failures: [{ id: 's1', reason: 'error' }]
    })
    const deps = fakeDeps({
      harnessDeps: fakeHarnessDeps({
        createBackend: vi.fn().mockReturnValue(fakeBackend({ translateBatch }))
      })
    })

    silenceConsole()

    const code = await runBenchCli(
      ['run', '--roster', rosterPath, '--corpus', corpusPath, '--store', storeDir],
      deps
    )

    expect(code).toBe(1)
    const store = new BenchStore(storeDir)
    expect(store.loadCell('model-a', 'item-1')).toBeNull()
  })

  it('exits 1 and never touches the harness when the corpus manifest is invalid', async () => {
    const repoRoot = await makeTempDir('bench-cli-run-badcorpus-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-run-badcorpus-store-')
    const corpusPath = path.join(repoRoot, 'corpus.json')
    // 'file' points at nothing on disk - loadCorpus must throw before runMatrix ever starts.
    writeJson(corpusPath, {
      items: [
        {
          id: 'item-1',
          file: 'items/does-not-exist.fake.json',
          sourceLang: 'English',
          targetLang: 'German',
          kind: 'pptx'
        }
      ]
    })
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    const ensureOllama = vi.fn()
    const deps = fakeDeps({ harnessDeps: fakeHarnessDeps({ ensureOllama }) })

    silenceConsole()

    const code = await runBenchCli(
      ['run', '--roster', rosterPath, '--corpus', corpusPath, '--store', storeDir],
      deps
    )

    expect(code).toBe(1)
    expect(ensureOllama).not.toHaveBeenCalled()
  })
})

// --- report (not one of the seven numbered contract points, but required
// subcommand behavior per the brief - still verified end to end) -----------

describe('report - buildReport, writes report.json/report.html, prints the ranking', () => {
  it('writes both report files under the store dir and prints a ranking line for each model, returning 0', async () => {
    const repoRoot = await makeTempDir('bench-cli-report-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-report-store-')
    const store = new BenchStore(storeDir)
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })
    const itemFile = await writeFakeItemFile(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hi' })])
    const corpusPath = await writeCorpus(repoRoot, [
      { id: 'item-1', file: itemFile, sourceLang: 'English', targetLang: 'German', kind: 'pptx' }
    ])

    const cell = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-1' }) })
    store.saveCell(cell)
    store.saveJudgement(
      'model-a',
      'item-1',
      makeJudgement({ judgeModel: 'judge-x', cellConfigHash: cell.configHash })
    )

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ''))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await runBenchCli(
      ['report', '--roster', rosterPath, '--corpus', corpusPath, '--store', storeDir],
      fakeDeps()
    )

    expect(code).toBe(0)
    expect(existsSync(path.join(storeDir, 'report.json'))).toBe(true)
    expect(existsSync(path.join(storeDir, 'report.html'))).toBe(true)

    const writtenReport = JSON.parse(readFileSync(path.join(storeDir, 'report.json'), 'utf8'))
    expect(writtenReport.ranking[0].model).toBe('model-a')
    expect(writtenReport.recommended).toBe('model-a')

    const html = readFileSync(path.join(storeDir, 'report.html'), 'utf8')
    expect(html).toContain('model-a')

    const output = logs.join('\n')
    expect(output).toContain('Ranking')
    expect(output).toContain('model-a')
    expect(output).toContain('Recommended champion: model-a')
    // The store defaults outside the repo tree now - report must print
    // exactly where it (and report.json/report.html) landed, resolved to
    // an absolute path.
    expect(output).toContain(`Store: ${path.resolve(storeDir)}`)
    expect(output).toContain(`Wrote ${path.resolve(path.join(storeDir, 'report.json'))}`)
    expect(output).toContain(`Wrote ${path.resolve(path.join(storeDir, 'report.html'))}`)
  })

  it('exits 1 and writes nothing when the corpus manifest is invalid', async () => {
    const repoRoot = await makeTempDir('bench-cli-report-badcorpus-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-report-badcorpus-store-')
    const corpusPath = path.join(repoRoot, 'corpus.json')
    writeJson(corpusPath, {
      items: [
        {
          id: 'item-1',
          file: 'items/does-not-exist.fake.json',
          sourceLang: 'English',
          targetLang: 'German',
          kind: 'pptx'
        }
      ]
    })
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    silenceConsole()

    const code = await runBenchCli(
      ['report', '--roster', rosterPath, '--corpus', corpusPath, '--store', storeDir],
      fakeDeps()
    )

    expect(code).toBe(1)
    expect(existsSync(path.join(storeDir, 'report.json'))).toBe(false)
  })
})

// --- contract point 3: judge skips current, re-judges stale ----------------

describe('judge - skips current judgements, re-judges stale ones, exact transport call count (contract point 3)', () => {
  it('skips a current cell, re-judges a hash-stale and a prompt-version-stale cell, judges an unjudged one - transport called exactly 3 times', async () => {
    const repoRoot = await makeTempDir('bench-cli-judge-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-judge-store-')
    const store = new BenchStore(storeDir)
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    const currentCell = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'current' }) })
    const hashStaleCell = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'hash-stale' })
    })
    const promptStaleCell = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'prompt-stale' })
    })
    const unjudgedCell = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'unjudged' }) })
    store.saveCell(currentCell)
    store.saveCell(hashStaleCell)
    store.saveCell(promptStaleCell)
    store.saveCell(unjudgedCell)

    store.saveJudgement(
      'model-a',
      'current',
      makeJudgement({ judgeModel: 'judge-x', cellConfigHash: currentCell.configHash })
    )
    store.saveJudgement(
      'model-a',
      'hash-stale',
      makeJudgement({ judgeModel: 'judge-x', cellConfigHash: 'deliberately-wrong-hash' })
    )
    store.saveJudgement(
      'model-a',
      'prompt-stale',
      makeJudgement({
        judgeModel: 'judge-x',
        cellConfigHash: promptStaleCell.configHash,
        promptVersion: 'v0-retired'
      })
    )
    // 'unjudged': no saveJudgement call at all.

    const originalCurrentJudgement = store.loadJudgement('judge-x', 'model-a', 'current')

    const chat = vi
      .fn()
      .mockImplementation(async (req: { user: string }) => uniformScoreResponse(req))
    const deps = fakeDeps({ createJudgeTransport: vi.fn().mockReturnValue({ chat }) })

    silenceConsole()

    const code = await runBenchCli(['judge', '--roster', rosterPath, '--store', storeDir], deps)

    expect(code).toBe(0)
    expect(chat).toHaveBeenCalledTimes(3)

    // Untouched: same object, byte for byte.
    expect(store.loadJudgement('judge-x', 'model-a', 'current')).toEqual(originalCurrentJudgement)

    for (const itemId of ['hash-stale', 'prompt-stale', 'unjudged']) {
      const j = store.loadJudgement('judge-x', 'model-a', itemId)
      expect(j).not.toBeNull()
      expect(j!.cellConfigHash).toBe(store.loadCell('model-a', itemId)!.configHash)
      expect(j!.promptVersion).toBe(JUDGE_PROMPT_VERSION)
    }
  })

  it('never connects when every stored cell already has a current judgement', async () => {
    const repoRoot = await makeTempDir('bench-cli-judge-nothing-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-judge-nothing-store-')
    const store = new BenchStore(storeDir)
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    const cell = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-1' }) })
    store.saveCell(cell)
    store.saveJudgement(
      'model-a',
      'item-1',
      makeJudgement({ judgeModel: 'judge-x', cellConfigHash: cell.configHash })
    )

    const ensureOllama = vi.fn()
    const deps = fakeDeps({ ensureOllama })

    silenceConsole()

    const code = await runBenchCli(['judge', '--roster', rosterPath, '--store', storeDir], deps)

    expect(code).toBe(0)
    expect(ensureOllama).not.toHaveBeenCalled()
  })

  it('exits 1 with a distinct message (not "nothing to do") and never connects when the store has no cells at all', async () => {
    const repoRoot = await makeTempDir('bench-cli-judge-emptystore-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-judge-emptystore-store-')
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    const ensureOllama = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const code = await runBenchCli(
      ['judge', '--roster', rosterPath, '--store', storeDir],
      fakeDeps({ ensureOllama })
    )

    expect(code).toBe(1)
    expect(ensureOllama).not.toHaveBeenCalled()
    const errText = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')
    expect(errText).toContain('no stored cells to judge')
    // Must NOT be the "already has a current judgement" message - a genuinely
    // empty store is a setup mistake, not "judging already happened".
    const logText = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')
    expect(logText).not.toContain('already has a current judgement')
  })

  it('exits 1 and never connects when the roster manifest is invalid', async () => {
    const repoRoot = await makeTempDir('bench-cli-judge-badroster-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-judge-badroster-store-')
    const rosterPath = path.join(repoRoot, 'roster.json')
    writeJson(rosterPath, { models: [] }) // empty models AND missing judge - invalid

    const ensureOllama = vi.fn()
    silenceConsole()

    const code = await runBenchCli(
      ['judge', '--roster', rosterPath, '--store', storeDir],
      fakeDeps({ ensureOllama })
    )

    expect(code).toBe(1)
    expect(ensureOllama).not.toHaveBeenCalled()
  })
})

// --- HARD constraint: never persist a partial judgement ---------------------

describe('judge - a JudgeBatchFailure aborts the whole pass without ever persisting a partial judgement (HARD constraint)', () => {
  it('saves the cell processed before the failure, saves NOTHING for the failing cell, never attempts the cell after it, and exits 1', async () => {
    const repoRoot = await makeTempDir('bench-cli-judge-partial-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-judge-partial-store-')
    const store = new BenchStore(storeDir)
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    // Deterministic processing order is model then itemId, so these three
    // sort as a-first, b-second, c-third.
    const cellFirst = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'a-first' }) })
    const cellSecond = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'b-second' }) })
    const cellThird = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'c-third' }) })
    store.saveCell(cellFirst)
    store.saveCell(cellSecond)
    store.saveCell(cellThird)

    const chat = vi
      .fn()
      .mockImplementationOnce(async (req: { user: string }) => uniformScoreResponse(req)) // a-first succeeds
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // b-second's transport dies

    const stop = vi.fn().mockResolvedValue(undefined)
    const deps = fakeDeps({
      ensureOllama: vi.fn().mockResolvedValue(fakeConnection(stop)),
      createJudgeTransport: vi.fn().mockReturnValue({ chat })
    })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const code = await runBenchCli(['judge', '--roster', rosterPath, '--store', storeDir], deps)

    expect(code).toBe(1)
    expect(chat).toHaveBeenCalledTimes(2) // a-first (1) + b-second's failing attempt (1) - c-third never reached

    expect(store.loadJudgement('judge-x', 'model-a', 'a-first')).not.toBeNull()
    expect(store.loadJudgement('judge-x', 'model-a', 'b-second')).toBeNull()
    expect(store.loadJudgement('judge-x', 'model-a', 'c-third')).toBeNull()

    expect(errSpy).toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

// --- contract point 4: judge --stability ------------------------------------

describe('judge --stability - 3 independent passes with the 0.25 spread gate (contract point 4)', () => {
  it('PASSes when all three passes agree, prints each meanOverall, and never saves anything', async () => {
    const repoRoot = await makeTempDir('bench-cli-stability-pass-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-stability-pass-store-')
    const store = new BenchStore(storeDir)
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    const cell = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-1' }) })
    store.saveCell(cell)

    const chat = vi
      .fn()
      .mockImplementation(async (req: { user: string }) => uniformScoreResponse(req, 5))
    const saveJudgementSpy = vi.spyOn(BenchStore.prototype, 'saveJudgement')

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ''))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await runBenchCli(
      ['judge', '--stability', '--roster', rosterPath, '--store', storeDir],
      fakeDeps({ createJudgeTransport: vi.fn().mockReturnValue({ chat }) })
    )

    expect(code).toBe(0)
    expect(chat).toHaveBeenCalledTimes(3)
    expect(saveJudgementSpy).not.toHaveBeenCalled()

    const output = logs.join('\n')
    expect(output).toMatch(/pass 1.*5\.000/)
    expect(output).toMatch(/pass 2.*5\.000/)
    expect(output).toMatch(/pass 3.*5\.000/)
    expect(output).toMatch(/spread.*0\.000/)
    expect(output).toContain('PASS')
  })

  it('FAILs when the passes disagree by more than 0.25, and never saves anything', async () => {
    const repoRoot = await makeTempDir('bench-cli-stability-fail-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-stability-fail-store-')
    const store = new BenchStore(storeDir)
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    const cell = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-1' }) })
    store.saveCell(cell)

    const chat = vi
      .fn()
      .mockImplementationOnce(async (req: { user: string }) => uniformScoreResponse(req, 5))
      .mockImplementationOnce(async (req: { user: string }) => uniformScoreResponse(req, 1))
      .mockImplementationOnce(async (req: { user: string }) => uniformScoreResponse(req, 5))
    const saveJudgementSpy = vi.spyOn(BenchStore.prototype, 'saveJudgement')

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ''))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await runBenchCli(
      ['judge', '--stability', '--roster', rosterPath, '--store', storeDir],
      fakeDeps({ createJudgeTransport: vi.fn().mockReturnValue({ chat }) })
    )

    expect(code).toBe(1)
    expect(chat).toHaveBeenCalledTimes(3)
    expect(saveJudgementSpy).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('FAIL')
  })

  it('refuses with exit 1 when the store has no cells at all', async () => {
    const repoRoot = await makeTempDir('bench-cli-stability-empty-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-stability-empty-store-')
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    const ensureOllama = vi.fn()
    silenceConsole()

    const code = await runBenchCli(
      ['judge', '--stability', '--roster', rosterPath, '--store', storeDir],
      fakeDeps({ ensureOllama })
    )

    expect(code).toBe(1)
    expect(ensureOllama).not.toHaveBeenCalled()
  })

  it('refuses with exit 1 and never connects when the first stored cell has no translated segments', async () => {
    const repoRoot = await makeTempDir('bench-cli-stability-notranslated-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-stability-notranslated-store-')
    const store = new BenchStore(storeDir)
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })

    // Every segment kept original (translation: null) - nothing for the judge to score.
    const cell = makeCell({
      config: makeConfig({ model: 'model-a', itemId: 'item-1' }),
      report: {
        file: 'fixtures/whatever.pptx',
        outPath: 'out/whatever.pptx',
        total: 1,
        translated: 0,
        keptOriginal: [{ id: 's1', reason: 'skipped-untranslatable' }],
        overflowed: [],
        segments: [{ id: 's1', sourceText: '12345', translation: null }],
        skippedUnsupported: [],
        durationMs: 100,
        stats: {
          model: 'model-a',
          phaseMs: { extract: 10, connect: 0, translate: 0, fit: 20, apply: 20 },
          groups: 0,
          modelCalls: 0,
          groupRetries: 0,
          perSegmentFallbacks: 0,
          promptTokens: 0,
          completionTokens: 0,
          tokensPerSec: 0,
          charsSource: 5,
          charsTranslated: 0,
          segmentsPerMin: 0
        }
      }
    })
    store.saveCell(cell)

    const ensureOllama = vi.fn()
    silenceConsole()

    const code = await runBenchCli(
      ['judge', '--stability', '--roster', rosterPath, '--store', storeDir],
      fakeDeps({ ensureOllama })
    )

    expect(code).toBe(1)
    expect(ensureOllama).not.toHaveBeenCalled()
  })
})

// --- contract point 5: crown -------------------------------------------------

describe('crown - refuses with no stored cells, writes+round-trips otherwise (contract point 5)', () => {
  it('refuses with exit 1 and a reason when the store has no cells (recommendChampion returns null)', async () => {
    const repoRoot = await makeTempDir('bench-cli-crown-empty-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-crown-empty-store-')
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })
    const itemFile = await writeFakeItemFile(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hi' })])
    const corpusPath = await writeCorpus(repoRoot, [
      { id: 'item-1', file: itemFile, sourceLang: 'English', targetLang: 'German', kind: 'pptx' }
    ])

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await runBenchCli(
      ['crown', '--roster', rosterPath, '--corpus', corpusPath, '--store', storeDir],
      fakeDeps()
    )

    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalled()
    expect(existsSync(path.join(repoRoot, 'config', 'champion.json'))).toBe(false)
  })

  it('crowns the recommended model with no arg, writes through writeChampion, and the file round-trips (old -> new printed)', async () => {
    const repoRoot = await makeTempDir('bench-cli-crown-ok-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-crown-ok-store-')
    const store = new BenchStore(storeDir)
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })
    const itemFile = await writeFakeItemFile(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hi' })])
    const corpusPath = await writeCorpus(repoRoot, [
      { id: 'item-1', file: itemFile, sourceLang: 'English', targetLang: 'German', kind: 'pptx' }
    ])

    const cell = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-1' }) })
    store.saveCell(cell)
    store.saveJudgement(
      'model-a',
      'item-1',
      makeJudgement({ judgeModel: 'judge-x', cellConfigHash: cell.configHash })
    )

    // Seed an existing champion.json so the "old -> new" transition is meaningful.
    mkdirSync(path.join(repoRoot, 'config'), { recursive: true })
    writeFileSync(
      path.join(repoRoot, 'config', 'champion.json'),
      JSON.stringify({ model: 'old-model', crownedAt: '2020-01-01T00:00:00.000Z' })
    )

    const logs: string[] = []
    const errs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ''))
    })
    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
      errs.push(String(msg ?? ''))
    })

    const code = await runBenchCli(
      ['crown', '--roster', rosterPath, '--corpus', corpusPath, '--store', storeDir],
      fakeDeps()
    )

    expect(code).toBe(0)
    expect(logs.join('\n')).toContain('old-model -> model-a')
    // model-a IS completedAll and judgedAll here (its one item is done and
    // judged) - no "deliberate override" note should fire for a fully
    // vetted crown, whether via the no-arg or explicit-model path.
    expect(errs.join('\n')).not.toContain('deliberate override')

    const written = JSON.parse(readFileSync(path.join(repoRoot, 'config', 'champion.json'), 'utf8'))
    expect(written.model).toBe('model-a')
  })

  it('refuses an explicit model argument that has no stored cells', async () => {
    const repoRoot = await makeTempDir('bench-cli-crown-badmodel-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-crown-badmodel-store-')
    const store = new BenchStore(storeDir)
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })
    const itemFile = await writeFakeItemFile(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hi' })])
    const corpusPath = await writeCorpus(repoRoot, [
      { id: 'item-1', file: itemFile, sourceLang: 'English', targetLang: 'German', kind: 'pptx' }
    ])
    store.saveCell(makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-1' }) }))

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await runBenchCli(
      [
        'crown',
        'never-run-model',
        '--roster',
        rosterPath,
        '--corpus',
        corpusPath,
        '--store',
        storeDir
      ],
      fakeDeps()
    )

    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalled()
    expect(existsSync(path.join(repoRoot, 'config', 'champion.json'))).toBe(false)
  })

  it('crowns an explicit model that has stored cells even without full completeness or judgement', async () => {
    const repoRoot = await makeTempDir('bench-cli-crown-explicit-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-crown-explicit-store-')
    const store = new BenchStore(storeDir)
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })
    const itemFile1 = await writeFakeItemFile(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hi' })])
    const itemFile2 = await writeFakeItemFile(repoRoot, 'item-2', [seg({ id: 's1', text: 'Bye' })])
    const corpusPath = await writeCorpus(repoRoot, [
      { id: 'item-1', file: itemFile1, sourceLang: 'English', targetLang: 'German', kind: 'pptx' },
      { id: 'item-2', file: itemFile2, sourceLang: 'English', targetLang: 'German', kind: 'pptx' }
    ])
    // model-a only has item-1 - incomplete, unjudged - still crownable explicitly.
    store.saveCell(makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-1' }) }))

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const code = await runBenchCli(
      ['crown', 'model-a', '--roster', rosterPath, '--corpus', corpusPath, '--store', storeDir],
      fakeDeps()
    )

    expect(code).toBe(0)
    const written = JSON.parse(readFileSync(path.join(repoRoot, 'config', 'champion.json'), 'utf8'))
    expect(written.model).toBe('model-a')

    // The bar itself stays exactly as-is (still crowns) - but since this
    // model is NOT completedAll (missing item-2) and NOT judgedAll, a
    // deliberate-override note must fire so this doesn't print an "old ->
    // new" line indistinguishable from a fully-vetted crown.
    const errText = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')
    expect(errText).toContain('deliberate override')
    expect(errText).toContain('completedAll: false')
    expect(errText).toContain('judgedAll: false')
  })
})

// --- contract point 6: status grid ------------------------------------------

describe('status - lists every roster model x corpus item with its state (contract point 6)', () => {
  it('spot-checks missing / done-unjudged / done-judged / done-stale-judgement states', async () => {
    const repoRoot = await makeTempDir('bench-cli-status-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-status-store-')
    const store = new BenchStore(storeDir)
    const rosterPath = await writeRoster(repoRoot, {
      models: ['model-a', 'model-b'],
      judge: 'judge-x'
    })

    const file1 = await writeFakeItemFile(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hi' })])
    const file2 = await writeFakeItemFile(repoRoot, 'item-2', [seg({ id: 's1', text: 'Bye' })])
    const corpusPath = await writeCorpus(repoRoot, [
      { id: 'item-1', file: file1, sourceLang: 'English', targetLang: 'German', kind: 'pptx' },
      { id: 'item-2', file: file2, sourceLang: 'English', targetLang: 'German', kind: 'pptx' }
    ])

    // model-a / item-1: done + current judgement.
    const cellA1 = makeCell({ config: makeConfig({ model: 'model-a', itemId: 'item-1' }) })
    store.saveCell(cellA1)
    store.saveJudgement(
      'model-a',
      'item-1',
      makeJudgement({ judgeModel: 'judge-x', cellConfigHash: cellA1.configHash })
    )
    // model-a / item-2: MISSING (never run).

    // model-b / item-1: done, unjudged.
    store.saveCell(makeCell({ config: makeConfig({ model: 'model-b', itemId: 'item-1' }) }))

    // model-b / item-2: done, stale judgement (hash mismatch).
    const cellB2 = makeCell({ config: makeConfig({ model: 'model-b', itemId: 'item-2' }) })
    store.saveCell(cellB2)
    store.saveJudgement(
      'model-b',
      'item-2',
      makeJudgement({ judgeModel: 'judge-x', cellConfigHash: 'deliberately-wrong' })
    )

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ''))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await runBenchCli(
      ['status', '--roster', rosterPath, '--corpus', corpusPath, '--store', storeDir],
      fakeDeps()
    )

    expect(code).toBe(0)
    const out = logs.join('\n')
    expect(out).toContain('model-a')
    expect(out).toContain('model-b')
    expect(out).toContain('item-1:done/judged')
    expect(out).toContain('item-2:missing')
    expect(out).toContain('item-1:done/unjudged')
    expect(out).toContain('item-2:done/stale-judgement')
  })

  it('prints the resolved absolute store path, so the store is discoverable now that it defaults outside the repo tree', async () => {
    const repoRoot = await makeTempDir('bench-cli-status-storepath-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-status-storepath-store-')
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })
    const itemFile = await writeFakeItemFile(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hi' })])
    const corpusPath = await writeCorpus(repoRoot, [
      { id: 'item-1', file: itemFile, sourceLang: 'English', targetLang: 'German', kind: 'pptx' }
    ])

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ''))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await runBenchCli(
      ['status', '--roster', rosterPath, '--corpus', corpusPath, '--store', storeDir],
      fakeDeps()
    )

    expect(code).toBe(0)
    expect(logs.join('\n')).toContain(`Store: ${path.resolve(storeDir)}`)
  })

  it('never touches ensureOllama/harnessDeps/createJudgeTransport', async () => {
    const repoRoot = await makeTempDir('bench-cli-status-nonetwork-')
    _internals.setRepoRootForTesting(repoRoot)
    const storeDir = await makeTempDir('bench-cli-status-nonetwork-store-')
    const rosterPath = await writeRoster(repoRoot, { models: ['model-a'], judge: 'judge-x' })
    const itemFile = await writeFakeItemFile(repoRoot, 'item-1', [seg({ id: 's1', text: 'Hi' })])
    const corpusPath = await writeCorpus(repoRoot, [
      { id: 'item-1', file: itemFile, sourceLang: 'English', targetLang: 'German', kind: 'pptx' }
    ])

    const ensureOllama = vi.fn()
    const createJudgeTransport = vi.fn()
    const harnessEnsureOllama = vi.fn()

    silenceConsole()

    const code = await runBenchCli(
      ['status', '--roster', rosterPath, '--corpus', corpusPath, '--store', storeDir],
      fakeDeps({
        ensureOllama,
        createJudgeTransport,
        harnessDeps: fakeHarnessDeps({ ensureOllama: harnessEnsureOllama })
      })
    )

    expect(code).toBe(0)
    expect(ensureOllama).not.toHaveBeenCalled()
    expect(createJudgeTransport).not.toHaveBeenCalled()
    expect(harnessEnsureOllama).not.toHaveBeenCalled()
  })
})

// --- contract point 7: integration smoke against real defaults -------------

describe('status - integration smoke against real defaults and an empty store, no network touched (contract point 7)', () => {
  beforeAll(async () => {
    // fixtures/bench/corpus.json references the three generated decks at
    // their default (non-temp) location - regenerate them there so this
    // suite is self-sufficient on a clean checkout (fixtures/bench/decks/
    // is gitignored), mirroring corpus.test.ts's own precedent.
    await generateBenchDecks(DEFAULT_OUT_DIR)
  }, 30_000)

  it('runBenchCli(["status", "--store", tempDir]) works end to end with real default deps and touches no network', async () => {
    const storeDir = await makeTempDir('bench-cli-status-smoke-store-')

    const fetchMock = vi.fn().mockImplementation(() => {
      throw new Error('network touched during status - this must never happen')
    })
    vi.stubGlobal('fetch', fetchMock)
    silenceConsole()

    const code = await runBenchCli(['status', '--store', storeDir])

    expect(code).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
