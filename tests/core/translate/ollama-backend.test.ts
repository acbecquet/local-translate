import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BatchRequest } from '../../../src/core/translate/backend'
import { buildPrompt } from '../../../src/core/translate/prompts'

// Mock the `ollama` npm client, not our own modules: OllamaBackend calls
// `new Ollama({ host })` and then `.chat()/.list()/.pull()` on the
// instance. vi.hoisted() gives the mock factory below access to the same
// vi.fn() instances the tests configure per-case.
const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  list: vi.fn(),
  pull: vi.fn()
}))

vi.mock('ollama', () => ({
  // A regular `function`, not an arrow function: OllamaBackend calls
  // `new Ollama(...)`, and arrow functions can never be used as
  // constructors (mockImplementation would otherwise throw "is not a
  // constructor" the moment `new` is used on it).
  Ollama: vi.fn().mockImplementation(function Ollama() {
    return { chat: mocks.chat, list: mocks.list, pull: mocks.pull }
  })
}))

const { OllamaBackend } = await import('../../../src/core/translate/ollama/ollama-backend')

function chatResponse(content: string): { message: { content: string } } {
  return { message: { content } }
}

function req(overrides: Partial<BatchRequest> = {}): BatchRequest {
  return {
    model: 'test-model',
    sourceLang: 'en',
    targetLang: 'fr',
    groupContext: 'doc',
    segments: [{ id: 's1', text: 'Hello' }],
    ...overrides
  }
}

async function seedCaps(
  appDataDir: string,
  model: string,
  caps: { structuredWithThinkOff: boolean }
): Promise<void> {
  await mkdir(appDataDir, { recursive: true })
  await writeFile(
    path.join(appDataDir, 'model-caps.json'),
    JSON.stringify({ [model]: caps }),
    'utf8'
  )
}

let appDataDir: string

beforeEach(async () => {
  mocks.chat.mockReset()
  mocks.list.mockReset()
  mocks.pull.mockReset()
  appDataDir = await mkdtemp(path.join(tmpdir(), 'lt-caps-'))
})

afterEach(async () => {
  await rm(appDataDir, { recursive: true, force: true })
})

// --- prompts.ts: exact template text -------------------------------------

describe('buildPrompt', () => {
  it('starts with the exact template text, with substitutions applied', () => {
    const request = req({
      sourceLang: 'English',
      targetLang: 'French',
      groupContext: 'Slide 3 title',
      segments: [
        { id: 's1', text: 'Hello' },
        { id: 's2', text: 'World' }
      ]
    })
    const rendered = buildPrompt(request)

    const expectedStart =
      'System: You are a professional translator for internal business documents.\n' +
      'Translate each segment from English to French.\n' +
      'Rules: return ONLY the JSON demanded by the schema; translate every segment independently; ' +
      'preserve line breaks inside segments; do not translate numbers, codes, or proper nouns that ' +
      'have no French equivalent; glossary (must-use): (none).\n' +
      'Document context: Slide 3 title\n' +
      'User: '

    expect(rendered.text.startsWith(expectedStart)).toBe(true)
    expect(rendered.text).toBe(
      expectedStart +
        JSON.stringify([
          { id: 's1', text: 'Hello' },
          { id: 's2', text: 'World' }
        ])
    )
  })

  it('substitutes a provided glossary into the system message', () => {
    const request = req({ glossary: { widget: 'gadget', foo: 'bar' } })
    const rendered = buildPrompt(request)
    expect(rendered.system).toContain('glossary (must-use): widget -> gadget; foo -> bar.')
  })

  it('splits system and user into separate fields matching the transcript', () => {
    const request = req()
    const rendered = buildPrompt(request)
    expect(rendered.text).toBe(`System: ${rendered.system}\nUser: ${rendered.user}`)
    expect(JSON.parse(rendered.user)).toEqual([{ id: 's1', text: 'Hello' }])
  })
})

// --- translateBatch: validation ladder ------------------------------------

describe('OllamaBackend.translateBatch', () => {
  it('happy path: parses on the first call and returns all translations', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: true })
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }))
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(req())

    expect(res.translations).toEqual([{ id: 's1', translation: 'Bonjour' }])
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(mocks.chat.mock.calls[0][0]).toMatchObject({ model: 'test-model', think: false })
  })

  it('returns immediately without calling the model when there are no segments', async () => {
    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(req({ segments: [] }))
    expect(res).toEqual({ translations: [] })
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('malformed JSON on the first call retries the whole group, then falls back per-segment for what is still unresolved', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: true })
    const request = req({
      segments: [
        { id: 's1', text: 'Hello' },
        { id: 's2', text: 'World' }
      ]
    })

    // Attempt 1: whole group, totally malformed JSON.
    mocks.chat.mockResolvedValueOnce(chatResponse('not valid json at all'))
    // Attempt 2: whole-group retry, still malformed.
    mocks.chat.mockResolvedValueOnce(chatResponse('{ this is not json either'))
    // Per-segment fallback for s1: succeeds.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }))
    )
    // Per-segment fallback for s2: fails again (still malformed).
    mocks.chat.mockResolvedValueOnce(chatResponse('still broken'))

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(request)

    // s2 never resolved: absent from the response, not a thrown error -
    // the pipeline is expected to keep s2's original text.
    expect(res.translations).toEqual([{ id: 's1', translation: 'Bonjour' }])
    expect(mocks.chat).toHaveBeenCalledTimes(4)
  })

  it('a segment that fails validation (not JSON parsing) also goes through retry then per-segment fallback', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: true })
    const request = req({ segments: [{ id: 's1', text: 'Hello' }] })

    // Attempt 1: echoes the source untranslated (fails the echo check).
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Hello' }] }))
    )
    // Attempt 2 (whole-group retry): echoes again.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Hello' }] }))
    )
    // Per-segment fallback: finally translates correctly.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }))
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(request)

    expect(res.translations).toEqual([{ id: 's1', translation: 'Bonjour' }])
    expect(mocks.chat).toHaveBeenCalledTimes(3)
  })

  it('keeps an already-succeeded segment from attempt 1 even if the whole-group retry response omits it', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: true })
    const request = req({
      segments: [
        { id: 's1', text: 'Hello' },
        { id: 's2', text: 'World' }
      ]
    })

    // Attempt 1: s1 succeeds, s2 missing entirely (id-mismatch).
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }))
    )
    // Attempt 2 (whole-group retry): s2 now succeeds too.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(
        JSON.stringify({
          translations: [
            { id: 's1', translation: 'DIFFERENT' },
            { id: 's2', translation: 'Monde' }
          ]
        })
      )
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(request)

    // s1 keeps its attempt-1 result rather than being overwritten by attempt 2.
    expect(res.translations).toEqual([
      { id: 's1', translation: 'Bonjour' },
      { id: 's2', translation: 'Monde' }
    ])
    expect(mocks.chat).toHaveBeenCalledTimes(2)
  })

  it('strips a <think>...</think> block before parsing (ollama#15260)', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: false })
    mocks.chat.mockResolvedValueOnce(
      chatResponse(
        '<think>reasoning about the translation here</think>' +
          JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] })
      )
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(req())

    expect(res.translations).toEqual([{ id: 's1', translation: 'Bonjour' }])
    expect(mocks.chat.mock.calls[0][0]).toMatchObject({ think: true })
  })
})

// --- capability probe + model-caps.json cache -----------------------------

describe('OllamaBackend capability probe', () => {
  it('probes with think:false, records structuredWithThinkOff:false on a schema violation, persists it, and uses think:true afterward', async () => {
    // Probe call: response is not valid JSON at all.
    mocks.chat.mockResolvedValueOnce(chatResponse('nope, not json'))
    // The subsequent group call, now expected to run with think:true.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }))
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(req())

    expect(res.translations).toEqual([{ id: 's1', translation: 'Bonjour' }])
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(mocks.chat.mock.calls[0][0]).toMatchObject({ think: false }) // the probe itself
    expect(mocks.chat.mock.calls[1][0]).toMatchObject({ think: true }) // the group call, adapted to caps

    const written = JSON.parse(await readFile(path.join(appDataDir, 'model-caps.json'), 'utf8'))
    expect(written['test-model']).toEqual({ structuredWithThinkOff: false })
  })

  it('records structuredWithThinkOff:true when the probe succeeds', async () => {
    mocks.chat.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true })))
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }))
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    await backend.translateBatch(req())

    const written = JSON.parse(await readFile(path.join(appDataDir, 'model-caps.json'), 'utf8'))
    expect(written['test-model']).toEqual({ structuredWithThinkOff: true })
  })

  it('rereads a cached caps file on a fresh instance instead of probing again', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: true })
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }))
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    await backend.translateBatch(req())

    expect(mocks.chat).toHaveBeenCalledTimes(1) // no probe call - went straight to the group call
    expect(mocks.chat.mock.calls[0][0]).toMatchObject({ think: false })
  })

  it('does not probe twice when two translateBatch calls for the same uncached model overlap', async () => {
    // Branch on message content, not `think`: once the probe records
    // structuredWithThinkOff:true, the real group call also uses
    // think:false, so `think` alone can't tell the two apart.
    mocks.chat.mockImplementation(
      async (arg: { messages: { content: string }[]; think?: boolean }) => {
        const isProbe = arg.messages.some((m) => m.content.includes('Capability probe'))
        if (isProbe) return chatResponse(JSON.stringify({ ok: true }))
        return chatResponse(
          JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] })
        )
      }
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const [res1, res2] = await Promise.all([
      backend.translateBatch(req()),
      backend.translateBatch(req())
    ])

    expect(res1.translations).toEqual([{ id: 's1', translation: 'Bonjour' }])
    expect(res2.translations).toEqual([{ id: 's1', translation: 'Bonjour' }])

    const probeCalls = mocks.chat.mock.calls.filter(([arg]) =>
      arg.messages.some((m: { content: string }) => m.content.includes('Capability probe'))
    )
    expect(probeCalls).toHaveLength(1) // exactly one probe, not two
    expect(mocks.chat).toHaveBeenCalledTimes(3) // 1 probe + 1 group call per translateBatch

    const written = JSON.parse(await readFile(path.join(appDataDir, 'model-caps.json'), 'utf8'))
    expect(written['test-model']).toEqual({ structuredWithThinkOff: true })
  })

  it('persists caps for two different models probed concurrently without either write clobbering the other', async () => {
    // Branch on message content, not `think`: once each model's probe
    // records structuredWithThinkOff:true, that model's real group call
    // also uses think:false, so `think` alone can't tell them apart.
    mocks.chat.mockImplementation(
      async (arg: { model: string; messages: { content: string }[] }) => {
        const isProbe = arg.messages.some((m) => m.content.includes('Capability probe'))
        if (isProbe) return chatResponse(JSON.stringify({ ok: true }))
        return chatResponse(
          JSON.stringify({
            translations: [{ id: 's1', translation: `translated-by-${arg.model}` }]
          })
        )
      }
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const [resA, resB] = await Promise.all([
      backend.translateBatch(req({ model: 'model-a' })),
      backend.translateBatch(req({ model: 'model-b' }))
    ])

    expect(resA.translations).toEqual([{ id: 's1', translation: 'translated-by-model-a' }])
    expect(resB.translations).toEqual([{ id: 's1', translation: 'translated-by-model-b' }])

    const written = JSON.parse(await readFile(path.join(appDataDir, 'model-caps.json'), 'utf8'))
    expect(written['model-a']).toEqual({ structuredWithThinkOff: true })
    expect(written['model-b']).toEqual({ structuredWithThinkOff: true })
  })
})

// --- listModels / pullModel ------------------------------------------------

describe('OllamaBackend.listModels', () => {
  it('maps client.list() into ModelInfo[]', async () => {
    mocks.list.mockResolvedValueOnce({
      models: [
        {
          name: 'llama3.1',
          model: 'llama3.1',
          size: 4700000000,
          digest: 'x',
          modified_at: new Date(),
          details: {
            parent_model: '',
            format: 'gguf',
            family: 'llama',
            families: ['llama'],
            parameter_size: '8B',
            quantization_level: 'Q4_0'
          },
          expires_at: new Date(),
          size_vram: 0
        }
      ]
    })

    const backend = new OllamaBackend({ baseUrl: 'http://127.0.0.1:1', appDataDir })
    const models = await backend.listModels()
    expect(models).toEqual([{ name: 'llama3.1', sizeBytes: 4700000000 }])
  })
})

describe('OllamaBackend.pullModel', () => {
  it('reports progress derived from client.pull()', async () => {
    mocks.pull.mockResolvedValueOnce([
      { status: 'downloading', digest: 'x', completed: 50, total: 100 },
      { status: 'success', digest: 'x', completed: 100, total: 100 }
    ])

    const backend = new OllamaBackend({ baseUrl: 'http://127.0.0.1:1', appDataDir })
    const pcts: number[] = []
    await backend.pullModel('llama3.1', (pct) => pcts.push(pct))

    expect(pcts).toEqual([50, 100])
    expect(mocks.pull).toHaveBeenCalledWith({ model: 'llama3.1', stream: true })
  })

  it('does not throw when onProgress is omitted', async () => {
    mocks.pull.mockResolvedValueOnce([
      { status: 'success', digest: 'x', completed: 100, total: 100 }
    ])
    const backend = new OllamaBackend({ baseUrl: 'http://127.0.0.1:1', appDataDir })
    await expect(backend.pullModel('llama3.1')).resolves.toBeUndefined()
  })
})
