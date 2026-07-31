import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { _internals, runCli, type CliDeps } from '../../src/core/cli'
import type { TextSegment } from '../../src/core/segments'
import type { BatchRequest, TranslationBackend } from '../../src/core/translate/backend'
import {
  OllamaNotFoundError,
  type OllamaConnection
} from '../../src/core/translate/ollama/lifecycle'

const { parseArgs, DEFAULT_MODEL } = _internals

function seg(overrides: Partial<TextSegment> & { id: string; text: string }): TextSegment {
  return {
    box: { wPt: 400, hPt: 200 },
    font: { family: 'Noto Sans', sizePt: 18 },
    context: 'doc',
    kind: 'fake',
    ...overrides
  }
}

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs.length = 0
  vi.restoreAllMocks()
})

function newTmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'lt-cli-'))
  tmpDirs.push(dir)
  return dir
}

/** Writes a fake.json fixture with the given segments and returns its path. */
function writeFixture(segments: TextSegment[]): string {
  const dir = newTmpDir()
  const file = path.join(dir, 'doc.fake.json')
  writeFileSync(file, JSON.stringify({ segments }))
  return file
}

function fakeBackend(overrides: Partial<TranslationBackend> = {}): TranslationBackend {
  return {
    listModels: vi.fn().mockResolvedValue([]),
    pullModel: vi.fn().mockResolvedValue(undefined),
    translateBatch: vi.fn().mockResolvedValue({ translations: [] }),
    ...overrides
  }
}

function fakeConnection(stop = vi.fn().mockResolvedValue(undefined)): OllamaConnection {
  return { baseUrl: 'http://127.0.0.1:1', spawned: false, stop }
}

describe('_internals.parseArgs', () => {
  it('applies the default model when --model is omitted', () => {
    const result = parseArgs(['doc.fake.json', 'English', 'French'])
    expect(result).toEqual({
      ok: true,
      args: {
        file: 'doc.fake.json',
        sourceLang: 'English',
        targetLang: 'French',
        model: DEFAULT_MODEL,
        out: undefined
      }
    })
  })

  it('honors an explicit --model override', () => {
    const result = parseArgs(['doc.fake.json', 'English', 'French', '--model', 'llama3.1'])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.args.model).toBe('llama3.1')
  })

  it('honors --out', () => {
    const result = parseArgs(['doc.fake.json', 'English', 'French', '--out', 'x.fake.json'])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.args.out).toBe('x.fake.json')
  })

  it('reports a usage error when positionals are missing', () => {
    const result = parseArgs(['doc.fake.json'])
    expect(result.ok).toBe(false)
  })

  it('reports an error when --model is given with no value', () => {
    const result = parseArgs(['doc.fake.json', 'English', 'French', '--model'])
    expect(result.ok).toBe(false)
  })

  it('reports an error when --out is given with no value', () => {
    const result = parseArgs(['doc.fake.json', 'English', 'French', '--out'])
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown flag, naming it in the error', () => {
    const result = parseArgs(['doc.fake.json', 'English', 'French', '--bogus'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('--bogus')
  })
})

describe('_internals.resolveAppDataDir', () => {
  const savedLocalAppData = process.env.LOCALAPPDATA

  afterEach(() => {
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = savedLocalAppData
  })

  it('prefers %LOCALAPPDATA% when set, aligning with findOllamaExe', () => {
    process.env.LOCALAPPDATA = path.join('C:', 'Users', 'someone', 'AppData', 'Local')
    expect(_internals.resolveAppDataDir()).toBe(
      path.join(process.env.LOCALAPPDATA, 'local_translate')
    )
  })

  it('falls back to homedir()/AppData/Local when LOCALAPPDATA is unset', () => {
    delete process.env.LOCALAPPDATA
    expect(_internals.resolveAppDataDir()).toBe(
      path.join(os.homedir(), 'AppData', 'Local', 'local_translate')
    )
  })
})

describe('runCli: exit codes and dependency injection', () => {
  it('returns 1 and never touches Ollama on a usage error (missing positionals)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ensureOllama = vi.fn()
    const createBackend = vi.fn()

    const code = await runCli(['doc.fake.json'], { ensureOllama, createBackend })

    expect(code).toBe(1)
    expect(ensureOllama).not.toHaveBeenCalled()
    expect(createBackend).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
  })

  it('returns 1 and never touches Ollama when no adapter matches the file extension', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ensureOllama = vi.fn()
    const createBackend = vi.fn()

    const code = await runCli(['doc.docx', 'English', 'French'], { ensureOllama, createBackend })

    expect(code).toBe(1)
    expect(ensureOllama).not.toHaveBeenCalled()
  })

  it('returns 2 and prints an actionable message including the download URL on OllamaNotFoundError', async () => {
    const file = writeFixture([seg({ id: 's1', text: 'Hello' })])
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ensureOllama = vi
      .fn()
      .mockRejectedValue(new OllamaNotFoundError('https://example.test/dl'))
    const createBackend = vi.fn()

    const code = await runCli([file, 'English', 'French'], { ensureOllama, createBackend })

    expect(code).toBe(2)
    expect(createBackend).not.toHaveBeenCalled()
    const printed = errSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(printed).toContain('https://example.test/dl')
  })

  it('propagates a default model to the pipeline when --model is omitted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const file = writeFixture([seg({ id: 's1', text: 'Hello' })])
    const stop = vi.fn().mockResolvedValue(undefined)
    const ensureOllama = vi.fn().mockResolvedValue(fakeConnection(stop))
    const translateBatch = vi
      .fn()
      .mockResolvedValue({ translations: [{ id: 's1', translation: 'Bonjour' }] })
    const createBackend = vi.fn().mockReturnValue(fakeBackend({ translateBatch }))

    const code = await runCli([file, 'English', 'French'], { ensureOllama, createBackend })

    expect(code).toBe(0)
    const req = translateBatch.mock.calls[0][0] as BatchRequest
    expect(req.model).toBe(DEFAULT_MODEL)
  })

  it('returns 1 when nothing gets translated, and still calls stop exactly once', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = writeFixture([seg({ id: 's1', text: 'Hello' })])
    const stop = vi.fn().mockResolvedValue(undefined)
    const ensureOllama = vi.fn().mockResolvedValue(fakeConnection(stop))
    const backend = fakeBackend({
      translateBatch: vi.fn().mockResolvedValue({
        translations: [],
        failures: [{ id: 's1', reason: 'error' }]
      })
    })
    const createBackend = vi.fn().mockReturnValue(backend)

    const code = await runCli([file, 'English', 'French'], { ensureOllama, createBackend })

    expect(code).toBe(1)
    expect(stop).toHaveBeenCalledTimes(1)
    // Progress lines went to stderr.
    const printed = errSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(printed).toContain('[extract]')
  })

  it('returns 0 for an all-numeric document where every segment is legitimately skipped-untranslatable', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = writeFixture([seg({ id: 's1', text: '12345' }), seg({ id: 's2', text: '99.9%' })])
    const stop = vi.fn().mockResolvedValue(undefined)
    const ensureOllama = vi.fn().mockResolvedValue(fakeConnection(stop))
    const translateBatch = vi.fn()
    const createBackend = vi.fn().mockReturnValue(fakeBackend({ translateBatch }))

    const code = await runCli([file, 'English', 'French'], { ensureOllama, createBackend })

    expect(code).toBe(0)
    // Never sent to the model - groupSegments drops untranslatable segments
    // before the backend is ever called.
    expect(translateBatch).not.toHaveBeenCalled()
  })

  it('returns 0, prints the report table to stdout, progress to stderr, and calls stop exactly once on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = writeFixture([seg({ id: 's1', text: 'Hello' })])
    const stop = vi.fn().mockResolvedValue(undefined)
    const ensureOllama = vi.fn().mockResolvedValue(fakeConnection(stop))
    const backend = fakeBackend({
      translateBatch: vi
        .fn()
        .mockResolvedValue({ translations: [{ id: 's1', translation: 'Bonjour' }] })
    })
    const createBackend = vi.fn().mockReturnValue(backend)

    const code = await runCli([file, 'English', 'French', '--model', 'llama3.1'], {
      ensureOllama,
      createBackend
    })

    expect(code).toBe(0)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(createBackend).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir: expect.any(String)
    })

    const table = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(table).toContain('Translation report')
    expect(table).toContain('Translated       1')

    // Processing stats block: model, phase timings, group/call/retry
    // counts, chars, and throughput always render; the Tokens line is
    // omitted here since this backend's mocked response carries no `usage`
    // (asserted separately below).
    expect(table).toContain('Processing stats')
    expect(table).toContain('Model            llama3.1')
    expect(table).toContain('Phases           extract')
    expect(table).toContain('Groups/calls')
    expect(table).toContain('Chars            5 source -> 7 translated')
    expect(table).toContain('Throughput')
    expect(table).not.toContain('Tokens ')

    const progress = errSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(progress).toContain('[extract]')
    expect(progress).toContain('[translate]')
    expect(progress).toContain('[fit]')
    expect(progress).toContain('[apply]')
  })

  it('prints the Tokens line only when the backend reports non-zero usage', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = writeFixture([seg({ id: 's1', text: 'Hello' })])
    const stop = vi.fn().mockResolvedValue(undefined)
    const ensureOllama = vi.fn().mockResolvedValue(fakeConnection(stop))
    const backend = fakeBackend({
      translateBatch: vi.fn().mockResolvedValue({
        translations: [{ id: 's1', translation: 'Bonjour' }],
        usage: {
          promptTokens: 12,
          completionTokens: 5,
          modelDurationMs: 250,
          calls: 1,
          retries: 0,
          perSegmentFallbacks: 0
        }
      })
    })
    const createBackend = vi.fn().mockReturnValue(backend)

    const code = await runCli([file, 'English', 'French'], { ensureOllama, createBackend })

    expect(code).toBe(0)
    const table = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(table).toContain('Tokens           12 prompt, 5 completion, 20.0 tok/s')
  })

  it('still calls stop exactly once when the pipeline throws (e.g. the input file cannot be read)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = newTmpDir()
    const missingFile = path.join(dir, 'missing.fake.json') // never written
    const stop = vi.fn().mockResolvedValue(undefined)
    const ensureOllama = vi.fn().mockResolvedValue(fakeConnection(stop))
    const createBackend = vi.fn().mockReturnValue(fakeBackend())

    const code = await runCli([missingFile, 'English', 'French'], { ensureOllama, createBackend })

    expect(code).toBe(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('respects an explicit --out path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = newTmpDir()
    const file = path.join(dir, 'doc.fake.json')
    writeFileSync(file, JSON.stringify({ segments: [seg({ id: 's1', text: 'Hello' })] }))
    const customOut = path.join(dir, 'custom.fake.json')

    const stop = vi.fn().mockResolvedValue(undefined)
    const ensureOllama = vi.fn().mockResolvedValue(fakeConnection(stop))
    const backend = fakeBackend({
      translateBatch: vi
        .fn()
        .mockResolvedValue({ translations: [{ id: 's1', translation: 'Bonjour' }] })
    })
    const createBackend = vi.fn().mockReturnValue(backend)

    const code = await runCli([file, 'English', 'French', '--out', customOut], {
      ensureOllama,
      createBackend
    } satisfies CliDeps)

    expect(code).toBe(0)
  })
})
