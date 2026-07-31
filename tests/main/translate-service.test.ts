import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { FormatAdapter } from '../../src/core/adapters/adapter'
import type { PipelineOpts, RunReport } from '../../src/core/pipeline'
import type { TranslationBackend } from '../../src/core/translate/backend'
import {
  OllamaNotFoundError,
  type OllamaConnection
} from '../../src/core/translate/ollama/lifecycle'
import {
  DEFAULT_MODEL,
  resolveAppDataDir,
  TranslateService,
  type TranslateServiceDeps
} from '../../src/main/translate-service'
import type { TranslateProgressEvent, TranslateStateEvent } from '../../src/shared/ipc-contract'

const FAKE_ADAPTER: FormatAdapter = {
  name: 'fake',
  extensions: ['.fake.json'],
  extract: vi.fn(),
  apply: vi.fn()
}

const FAKE_REPORT: RunReport = {
  file: 'doc.fake.json',
  outPath: 'doc_translated.fake.json',
  total: 1,
  translated: 1,
  keptOriginal: [],
  overflowed: [],
  durationMs: 5
}

function fakeConnection(stop = vi.fn().mockResolvedValue(undefined)): OllamaConnection {
  return { baseUrl: 'http://127.0.0.1:1', spawned: false, stop }
}

function fakeBackend(): TranslationBackend {
  return {
    listModels: vi.fn().mockResolvedValue([]),
    pullModel: vi.fn().mockResolvedValue(undefined),
    translateBatch: vi.fn().mockResolvedValue({ translations: [] })
  }
}

/** Builds a TranslateService with every collaborator faked, capturing state/progress events for assertions. Individual tests override whichever deps they care about. */
function harness(overrides: Partial<TranslateServiceDeps> = {}) {
  const states: TranslateStateEvent[] = []
  const progressEvents: TranslateProgressEvent[] = []
  const ensureOllama = vi.fn().mockResolvedValue(fakeConnection())
  const createBackend = vi.fn().mockReturnValue(fakeBackend())
  const runPipeline = vi.fn().mockResolvedValue(FAKE_REPORT)

  const service = new TranslateService({
    adapters: [FAKE_ADAPTER],
    ensureOllama,
    createBackend,
    runPipeline,
    appDataDir: 'C:\\fake\\appdata',
    model: 'test-model',
    onProgress: (e) => progressEvents.push(e),
    onState: (e) => states.push(e),
    ...overrides
  })

  return { service, states, progressEvents, ensureOllama, createBackend, runPipeline }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveAppDataDir', () => {
  const saved = process.env.LOCALAPPDATA

  afterEach(() => {
    if (saved === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = saved
  })

  it('prefers %LOCALAPPDATA% when set', () => {
    process.env.LOCALAPPDATA = path.join('C:', 'Users', 'someone', 'AppData', 'Local')
    expect(resolveAppDataDir()).toBe(path.join(process.env.LOCALAPPDATA, 'local_translate'))
  })

  it('falls back to homedir()/AppData/Local when unset', () => {
    delete process.env.LOCALAPPDATA
    expect(resolveAppDataDir()).toBe(path.join(os.homedir(), 'AppData', 'Local', 'local_translate'))
  })
})

describe('TranslateService.run: argument mapping', () => {
  it('maps the request + resolved adapter + injected model into PipelineOpts', async () => {
    const { service, runPipeline, createBackend } = harness()

    const report = await service.run({
      filePath: 'doc.fake.json',
      sourceLang: 'English',
      targetLang: 'French'
    })

    expect(report).toBe(FAKE_REPORT)
    expect(createBackend).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir: 'C:\\fake\\appdata'
    })

    const opts = runPipeline.mock.calls[0][0] as PipelineOpts
    expect(opts.file).toBe('doc.fake.json')
    expect(opts.sourceLang).toBe('English')
    expect(opts.targetLang).toBe('French')
    expect(opts.model).toBe('test-model')
    expect(opts.adapter).toBe(FAKE_ADAPTER)
    expect(typeof opts.onProgress).toBe('function')
  })

  it('rejects with a descriptive error and never touches Ollama when no adapter matches', async () => {
    const { service, ensureOllama, states } = harness()

    await expect(
      service.run({ filePath: 'doc.docx', sourceLang: 'English', targetLang: 'French' })
    ).rejects.toThrow(/No adapter registered/)

    expect(ensureOllama).not.toHaveBeenCalled()
    expect(states).toEqual([
      { state: 'error', message: expect.stringContaining('No adapter registered') }
    ])
  })
})

describe('TranslateService.run: state events + connection reuse', () => {
  it('emits starting-ollama -> translating -> done on a fresh connection', async () => {
    const { service, states } = harness()

    await service.run({ filePath: 'doc.fake.json', sourceLang: 'English', targetLang: 'French' })

    expect(states).toEqual([
      { state: 'starting-ollama' },
      { state: 'translating' },
      { state: 'done' }
    ])
  })

  it('reuses the OllamaConnection across runs: ensureOllama is called exactly once', async () => {
    const { service, ensureOllama, states } = harness()
    const req = { filePath: 'doc.fake.json', sourceLang: 'English', targetLang: 'French' }

    await service.run(req)
    states.length = 0
    await service.run(req)

    expect(ensureOllama).toHaveBeenCalledTimes(1)
    // Second run has no 'starting-ollama' - the connection was already held.
    expect(states).toEqual([{ state: 'translating' }, { state: 'done' }])
  })

  it('propagates progress events with done/total/phase', async () => {
    const runPipeline = vi.fn().mockImplementation(async (opts: PipelineOpts) => {
      opts.onProgress?.(1, 1, 'extract')
      opts.onProgress?.(2, 4, 'translate')
      return FAKE_REPORT
    })
    const { service, progressEvents } = harness({ runPipeline })

    await service.run({ filePath: 'doc.fake.json', sourceLang: 'English', targetLang: 'French' })

    expect(progressEvents).toEqual([
      { done: 1, total: 1, phase: 'extract' },
      { done: 2, total: 4, phase: 'translate' }
    ])
  })
})

describe('TranslateService.run: OllamaNotFoundError', () => {
  it('formats an actionable error including the download URL, and rejects', async () => {
    const ensureOllama = vi
      .fn()
      .mockRejectedValue(new OllamaNotFoundError('https://example.test/dl'))
    const { service, states } = harness({ ensureOllama })

    await expect(
      service.run({ filePath: 'doc.fake.json', sourceLang: 'English', targetLang: 'French' })
    ).rejects.toThrow(/https:\/\/example\.test\/dl/)

    expect(states).toEqual([
      { state: 'starting-ollama' },
      { state: 'error', message: expect.stringContaining('https://example.test/dl') }
    ])
  })
})

describe('TranslateService: cancellation', () => {
  it('cancels at the next onProgress call, reporting state error with message "cancelled"', async () => {
    const runPipeline = vi.fn().mockImplementation(async (opts: PipelineOpts) => {
      opts.onProgress?.(1, 4, 'translate') // group 1 boundary - not yet cancelled
      service.cancel()
      opts.onProgress?.(2, 4, 'translate') // group 2 boundary - should throw now
      opts.onProgress?.(3, 4, 'translate') // must be unreachable
      return FAKE_REPORT
    })
    const { service, states } = harness({ runPipeline })

    await expect(
      service.run({ filePath: 'doc.fake.json', sourceLang: 'English', targetLang: 'French' })
    ).rejects.toThrow('cancelled')

    expect(states.at(-1)).toEqual({ state: 'error', message: 'cancelled' })
  })

  it('resets the cancel flag at the start of the next run', async () => {
    const runPipeline = vi.fn().mockImplementation(async (opts: PipelineOpts) => {
      opts.onProgress?.(1, 1, 'translate')
      return FAKE_REPORT
    })
    const { service } = harness({ runPipeline })
    const req = { filePath: 'doc.fake.json', sourceLang: 'English', targetLang: 'French' }

    // Cancel before any run - should not leak into the next run().
    service.cancel()
    await expect(service.run(req)).resolves.toBe(FAKE_REPORT)

    // A run that itself gets cancelled (only on its first invocation - the
    // second run() call below must NOT be cancelled again). `service2` is
    // referenced inside the closure before its own declaration below, but
    // that's fine: the closure only runs once run() is called, by which
    // point `service2` has long since been assigned.
    let cancelledOnce = false
    const cancellingPipeline = vi.fn().mockImplementation(async (opts: PipelineOpts) => {
      if (!cancelledOnce) {
        cancelledOnce = true
        service2.cancel()
      }
      opts.onProgress?.(1, 1, 'translate')
      return FAKE_REPORT
    })
    const service2 = harness({ runPipeline: cancellingPipeline }).service
    await expect(service2.run(req)).rejects.toThrow('cancelled')
    // ...must not affect a subsequent run on the same instance.
    await expect(service2.run(req)).resolves.toBe(FAKE_REPORT)
  })

  it('cancel() is a no-op when no run is in flight', () => {
    const { service } = harness()
    expect(() => service.cancel()).not.toThrow()
  })
})

describe('TranslateService.stop', () => {
  it('stops a held connection and forgets it, so the next run re-establishes one', async () => {
    const stop = vi.fn().mockResolvedValue(undefined)
    const ensureOllama = vi.fn().mockResolvedValue(fakeConnection(stop))
    const { service, states } = harness({ ensureOllama })
    const req = { filePath: 'doc.fake.json', sourceLang: 'English', targetLang: 'French' }

    await service.run(req)
    expect(stop).not.toHaveBeenCalled()

    await service.stop()
    expect(stop).toHaveBeenCalledTimes(1)

    states.length = 0
    await service.run(req)
    expect(ensureOllama).toHaveBeenCalledTimes(2)
    expect(states[0]).toEqual({ state: 'starting-ollama' })
  })

  it('is a no-op when no connection was ever established', async () => {
    const { service } = harness()
    await expect(service.stop()).resolves.toBeUndefined()
  })
})

describe('DEFAULT_MODEL', () => {
  it('is used when no model override is supplied', async () => {
    const runPipeline = vi.fn().mockResolvedValue(FAKE_REPORT)
    const service = new TranslateService({
      adapters: [FAKE_ADAPTER],
      ensureOllama: vi.fn().mockResolvedValue(fakeConnection()),
      createBackend: vi.fn().mockReturnValue(fakeBackend()),
      runPipeline
    })

    await service.run({ filePath: 'doc.fake.json', sourceLang: 'English', targetLang: 'French' })

    const opts = runPipeline.mock.calls[0][0] as PipelineOpts
    expect(opts.model).toBe(DEFAULT_MODEL)
  })
})
