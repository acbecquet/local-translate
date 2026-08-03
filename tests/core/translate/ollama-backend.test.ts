import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BatchRequest } from '../../../src/core/translate/backend'
import {
  buildFallbackPrompt,
  buildPrompt,
  buildRetryPrompt
} from '../../../src/core/translate/prompts'

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

// Partial-mocks node:fs/promises so a single caps-file write can be made to
// fail on demand (writeFileFailOnce), to exercise persistModelCaps' best-
// effort error handling without touching real disk-failure conditions.
// Everything else (mkdtemp/mkdir/readFile/rm/readdir, and writeFile itself
// whenever the flag is off) delegates straight through to the real
// implementation, so every other test's own file I/O - `seedCaps`,
// `beforeEach`/`afterEach` - is unaffected.
const fsFailure = vi.hoisted(() => ({ writeFileFailOnce: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const mockedWriteFile = vi.fn(
    async (filePath: string, data: string, encoding: BufferEncoding) => {
      if (fsFailure.writeFileFailOnce) {
        fsFailure.writeFileFailOnce = false
        throw new Error('EBUSY: simulated transient write failure')
      }
      await actual.writeFile(filePath, data, encoding)
    }
  )
  return { ...actual, writeFile: mockedWriteFile }
})

const { OllamaBackend } = await import('../../../src/core/translate/ollama/ollama-backend')

/**
 * Builds a mocked ollama ChatResponse. `usage` is optional and, when
 * omitted, produces exactly the bare `{ message: { content } }` shape every
 * other test in this file already relies on - OllamaBackend must treat
 * those missing telemetry fields as 0, not NaN/undefined (see
 * extractUsage() in ollama-backend.ts), so most tests deliberately never
 * pass it.
 */
function chatResponse(
  content: string,
  usage?: {
    promptEvalCount: number
    evalCount: number
    totalDurationNs: number
    /** Defaults to `totalDurationNs` when omitted - most tests don't care about the total-vs-eval split and can just supply one number; the usage-aggregation tests that DO care about the split (evalDurationMs is the tokensPerSec basis, not modelDurationMs) pass this explicitly and distinct from totalDurationNs. */
    evalDurationNs?: number
  }
): {
  message: { content: string }
  prompt_eval_count?: number
  eval_count?: number
  total_duration?: number
  eval_duration?: number
} {
  if (!usage) return { message: { content } }
  return {
    message: { content },
    prompt_eval_count: usage.promptEvalCount,
    eval_count: usage.evalCount,
    total_duration: usage.totalDurationNs,
    eval_duration: usage.evalDurationNs ?? usage.totalDurationNs
  }
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
  fsFailure.writeFileFailOnce = false
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

  // Regression pin (polish-round Task D): the first-attempt group prompt
  // must stay byte-identical to before this task's changes, since the 311
  // segments that already translated fine on the first attempt must not be
  // put at risk by anti-echo wording that belongs on the retry/fallback
  // rungs only. Any intentional future change to the first-attempt prompt
  // must update this string deliberately, not as a side effect of touching
  // buildRetryPrompt/buildFallbackPrompt.
  it('regression pin: exact byte-for-byte template text, unchanged by the retry/fallback anti-echo wording', () => {
    const request = req({
      sourceLang: 'English',
      targetLang: 'Chinese',
      groupContext: 'Slide 3 textbox',
      segments: [{ id: 's1', text: '1-22 Batch User-5 ROSIN' }]
    })
    const rendered = buildPrompt(request)

    expect(rendered.text).toBe(
      'System: You are a professional translator for internal business documents.\n' +
        'Translate each segment from English to Chinese.\n' +
        'Rules: return ONLY the JSON demanded by the schema; translate every segment independently; ' +
        'preserve line breaks inside segments; do not translate numbers, codes, or proper nouns that ' +
        'have no Chinese equivalent; glossary (must-use): (none).\n' +
        'Document context: Slide 3 textbox\n' +
        'User: ' +
        JSON.stringify([{ id: 's1', text: '1-22 Batch User-5 ROSIN' }])
    )
  })
})

// --- prompts.ts: retry-rung anti-echo nudge (polish-round Task D) --------

describe('buildRetryPrompt', () => {
  it('is the first-attempt system prompt plus exactly one added anti-echo sentence, no worked example', () => {
    const request = req({ sourceLang: 'English', targetLang: 'Chinese' })
    const base = buildPrompt(request)
    const retry = buildRetryPrompt(request)

    expect(retry.system.startsWith(base.system)).toBe(true)
    const added = retry.system.slice(base.system.length).trim()
    expect(added.length).toBeGreaterThan(0)
    // Exactly one sentence: exactly one terminating period, and that
    // period is the sentence's last character.
    expect(added.indexOf('.')).toBe(added.length - 1)

    // The cheap nudge names the failure mode and the target language, but
    // deliberately carries no worked example (that's the fallback rung's
    // more expensive last resort, not the cheaper retry nudge).
    expect(added).toContain('Chinese')
    expect(added.toLowerCase()).toContain('source text unchanged')
    expect(retry.system).not.toContain('Worked example')
    expect(retry.system).not.toContain('2-10 Batch User-3 RESIN')
  })

  it('user message and transcript gluing are unaffected, only the system message changes', () => {
    const request = req()
    const retry = buildRetryPrompt(request)
    expect(retry.text).toBe(`System: ${retry.system}\nUser: ${retry.user}`)
    expect(JSON.parse(retry.user)).toEqual([{ id: 's1', text: 'Hello' }])
  })

  it('parameterizes the added sentence by target language, not hardcoded to any one language', () => {
    const en = buildRetryPrompt(req({ sourceLang: 'English', targetLang: 'Chinese' }))
    const fr = buildRetryPrompt(req({ sourceLang: 'English', targetLang: 'French' }))
    expect(en.system).toContain('Chinese')
    expect(en.system).not.toContain('French')
    expect(fr.system).toContain('French')
    expect(fr.system).not.toContain('Chinese')
  })
})

// --- prompts.ts: per-segment fallback anti-echo hardening (Task D) -------

describe('buildFallbackPrompt', () => {
  it('contains an explicit anti-echo instruction naming source-unchanged as a failure mode', () => {
    const request = req({ sourceLang: 'English', targetLang: 'Chinese' })
    const fallback = buildFallbackPrompt(request)

    expect(fallback.system.startsWith(buildPrompt(request).system)).toBe(true)
    expect(fallback.system.toLowerCase()).toContain('source text unchanged')
    expect(fallback.system.toLowerCase()).toContain('failure')
  })

  it('contains a worked example translating a terse mixed alphanumeric label', () => {
    const request = req({ sourceLang: 'English', targetLang: 'Chinese' })
    const fallback = buildFallbackPrompt(request)

    expect(fallback.system).toContain('Worked example')
    expect(fallback.system).toContain('2-10 Batch User-3 RESIN')
    // The worked example calls out which tokens stay as-is (the code and
    // the brand name) versus which words get translated.
    expect(fallback.system).toContain('2-10')
    expect(fallback.system).toContain('RESIN')
  })

  it('names the target language in both the anti-echo instruction and the worked example, without hardcoding Chinese in the template', () => {
    const zh = buildFallbackPrompt(req({ sourceLang: 'English', targetLang: 'Chinese' }))
    const fr = buildFallbackPrompt(req({ sourceLang: 'English', targetLang: 'French' }))

    expect(zh.system).toContain('Chinese')
    expect(zh.system).not.toContain('French')
    expect(fr.system).toContain('French')
    expect(fr.system).not.toContain('Chinese')

    // The worked example itself is present regardless of target language -
    // it is a generic template, not a per-language special case.
    expect(zh.system).toContain('2-10 Batch User-3 RESIN')
    expect(fr.system).toContain('2-10 Batch User-3 RESIN')
  })

  it('mentions keeping genuinely untranslatable tokens such as product codes and brand names as-is', () => {
    const request = req({ sourceLang: 'English', targetLang: 'Chinese' })
    const fallback = buildFallbackPrompt(request)
    expect(fallback.system).toContain('HTHH-1')
  })

  it('user message and transcript gluing are unaffected, only the system message changes', () => {
    const request = req()
    const fallback = buildFallbackPrompt(request)
    expect(fallback.text).toBe(`System: ${fallback.system}\nUser: ${fallback.user}`)
    expect(JSON.parse(fallback.user)).toEqual([{ id: 's1', text: 'Hello' }])
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
    expect(res.failures).toBeUndefined() // nothing to report when everything resolved
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
    // s2's failure is surfaced with its reason (from the per-segment
    // fallback, which is what actually determined it stayed unresolved).
    expect(res.failures).toEqual([{ id: 's2', reason: 'parse' }])
  })

  it('a transport-level failure (the chat call itself throwing) is reported as reason "error", not "parse"', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: true })
    const request = req({ segments: [{ id: 's1', text: 'Hello' }] })

    // Every attempt (initial, whole-group retry, per-segment fallback) hits
    // a transport-level failure - the model never actually responds.
    mocks.chat.mockRejectedValueOnce(new Error('ECONNRESET'))
    mocks.chat.mockRejectedValueOnce(new Error('ECONNRESET'))
    mocks.chat.mockRejectedValueOnce(new Error('ECONNRESET'))

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(request)

    expect(res.translations).toEqual([])
    expect(res.failures).toEqual([{ id: 's1', reason: 'error' }])
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

  it('failures reports the reason from the most recent attempt, not a stale earlier one', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: true })
    const request = req({ segments: [{ id: 's1', text: 'Hello' }] })

    // Attempt 1: echo (fails as 'echo').
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Hello' }] }))
    )
    // Attempt 2 (whole-group retry): still echo.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Hello' }] }))
    )
    // Per-segment fallback: this time it's an empty translation - a
    // different failure reason than the two prior attempts.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: '   ' }] }))
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(request)

    expect(res.translations).toEqual([])
    expect(res.failures).toEqual([{ id: 's1', reason: 'empty' }]) // not 'echo'
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

// --- translateBatch: ladder wiring uses the right prompt at each rung -----
// (polish-round Task D: the ladder STRUCTURE is unchanged - same number of
// calls, same retry-then-per-segment-fallback order - only which prompt
// text gets sent at each rung changes.)

describe('OllamaBackend.translateBatch: prompt selection per ladder rung', () => {
  it('sends the plain first-attempt prompt on attempt 1, the retry-nudge prompt on the whole-group retry, and the fallback anti-echo prompt on the per-segment fallback', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: true })
    const request = req({
      sourceLang: 'English',
      targetLang: 'Chinese',
      segments: [{ id: 's1', text: '1-22 Batch User-5 ROSIN' }]
    })

    // Attempt 1 (whole group): echoes the source, unresolved.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(
        JSON.stringify({ translations: [{ id: 's1', translation: '1-22 Batch User-5 ROSIN' }] })
      )
    )
    // Attempt 2 (whole-group retry): echoes again, still unresolved.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(
        JSON.stringify({ translations: [{ id: 's1', translation: '1-22 Batch User-5 ROSIN' }] })
      )
    )
    // Per-segment fallback: finally translates.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(
        JSON.stringify({ translations: [{ id: 's1', translation: '1-22批 用户5 ROSIN' }] })
      )
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(request)

    expect(res.translations).toEqual([{ id: 's1', translation: '1-22批 用户5 ROSIN' }])
    expect(mocks.chat).toHaveBeenCalledTimes(3)

    const systemContentAt = (callIndex: number): string =>
      mocks.chat.mock.calls[callIndex][0].messages[0].content

    const attempt1System = systemContentAt(0)
    const retrySystem = systemContentAt(1)
    const fallbackSystem = systemContentAt(2)

    // Attempt 1: exactly the unchanged first-attempt prompt, no anti-echo wording at all.
    expect(attempt1System).not.toContain('source text unchanged')
    expect(attempt1System).not.toContain('Worked example')

    // Retry: the one added nudge sentence, but no worked example.
    expect(retrySystem).toContain('source text unchanged')
    expect(retrySystem).not.toContain('Worked example')
    expect(retrySystem.startsWith(attempt1System)).toBe(true)

    // Per-segment fallback: full anti-echo instruction plus worked example.
    expect(fallbackSystem).toContain('source text unchanged')
    expect(fallbackSystem).toContain('failure')
    expect(fallbackSystem).toContain('Worked example')
    expect(fallbackSystem).toContain('2-10 Batch User-3 RESIN')
  })
})

// --- translateBatch: BatchResponse.usage aggregation ----------------------

describe('OllamaBackend.translateBatch usage aggregation', () => {
  it('happy path: usage reflects exactly the one group call, with no retries or fallbacks - modelDurationMs (whole-call) and evalDurationMs (pure generation) tracked independently', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: true })
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }), {
        promptEvalCount: 10,
        evalCount: 4,
        totalDurationNs: 2_000_000, // 2 ms whole-call latency (incl. model load + prompt eval)
        evalDurationNs: 1_500_000 // 1.5 ms pure generation - deliberately less than total, to prove the two are read from separate response fields, not derived from one another.
      })
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(req())

    // No probe (caps were pre-seeded), so this is the group call alone.
    expect(res.usage).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      modelDurationMs: 2,
      evalDurationMs: 1.5,
      calls: 1,
      retries: 0,
      perSegmentFallbacks: 0
    })
  })

  it('sums usage across the group call, its retry, and every per-segment fallback', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: true })
    const request = req({
      segments: [
        { id: 's1', text: 'Hello' },
        { id: 's2', text: 'World' }
      ]
    })

    // Attempt 1: whole group, malformed JSON - still spends tokens/time.
    mocks.chat.mockResolvedValueOnce(
      chatResponse('not valid json at all', {
        promptEvalCount: 20,
        evalCount: 5,
        totalDurationNs: 1_000_000
      })
    )
    // Attempt 2: whole-group retry, still malformed.
    mocks.chat.mockResolvedValueOnce(
      chatResponse('{ this is not json either', {
        promptEvalCount: 20,
        evalCount: 5,
        totalDurationNs: 1_000_000
      })
    )
    // Per-segment fallback for s1: succeeds.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }), {
        promptEvalCount: 6,
        evalCount: 2,
        totalDurationNs: 500_000
      })
    )
    // Per-segment fallback for s2: fails again, but the model still responded.
    mocks.chat.mockResolvedValueOnce(
      chatResponse('still broken', {
        promptEvalCount: 6,
        evalCount: 1,
        totalDurationNs: 500_000
      })
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(request)

    expect(mocks.chat).toHaveBeenCalledTimes(4)
    // 4 calls, all of which returned a (parseable-or-not) response: every
    // one contributes to the sums. Both segments went through exactly one
    // per-segment fallback attempt each -> perSegmentFallbacks: 2. Exactly
    // one whole-group retry was attempted -> retries: 1.
    expect(res.usage).toEqual({
      promptTokens: 20 + 20 + 6 + 6,
      completionTokens: 5 + 5 + 2 + 1,
      modelDurationMs: 1 + 1 + 0.5 + 0.5,
      evalDurationMs: 1 + 1 + 0.5 + 0.5, // evalDurationNs omitted -> defaults to totalDurationNs per call
      calls: 4,
      retries: 1,
      perSegmentFallbacks: 2
    })
  })

  it('a transport-level failure contributes zero to the token/duration/calls sums, but still counts as an attempted retry and fallback step', async () => {
    await seedCaps(appDataDir, 'test-model', { structuredWithThinkOff: true })
    const request = req({ segments: [{ id: 's1', text: 'Hello' }] })

    mocks.chat.mockRejectedValueOnce(new Error('ECONNRESET')) // group call
    mocks.chat.mockRejectedValueOnce(new Error('ECONNRESET')) // retry
    mocks.chat.mockRejectedValueOnce(new Error('ECONNRESET')) // per-segment fallback

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(request)

    expect(res.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      modelDurationMs: 0,
      evalDurationMs: 0,
      calls: 0, // no response ever came back on any attempt
      retries: 1,
      perSegmentFallbacks: 1
    })
  })

  it('includes the capability probe call in usage when it actually runs during this request', async () => {
    // No seeded caps file - the probe runs as part of this translateBatch call.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ ok: true }), {
        promptEvalCount: 3,
        evalCount: 1,
        totalDurationNs: 300_000
      })
    )
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }), {
        promptEvalCount: 10,
        evalCount: 4,
        totalDurationNs: 2_000_000
      })
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(req())

    expect(mocks.chat).toHaveBeenCalledTimes(2) // probe + group call
    expect(res.usage).toEqual({
      promptTokens: 3 + 10,
      completionTokens: 1 + 4,
      modelDurationMs: 0.3 + 2,
      evalDurationMs: 0.3 + 2,
      calls: 2, // probe counts as a call too
      retries: 0,
      perSegmentFallbacks: 0
    })
  })

  it('excludes the probe from usage on a later call once caps are cached from an earlier probe on the same instance', async () => {
    mocks.chat.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true }))) // probe, no usage fields
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }))
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    await backend.translateBatch(req()) // probes and caches caps

    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour again' }] }), {
        promptEvalCount: 8,
        evalCount: 3,
        totalDurationNs: 1_000_000
      })
    )
    const res2 = await backend.translateBatch(req())

    // Only the group call this time - no second probe.
    expect(res2.usage).toEqual({
      promptTokens: 8,
      completionTokens: 3,
      modelDurationMs: 1,
      evalDurationMs: 1,
      calls: 1,
      retries: 0,
      perSegmentFallbacks: 0
    })
  })

  it('omits usage entirely for a request with no segments (never calls the model)', async () => {
    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res = await backend.translateBatch(req({ segments: [] }))
    expect(res.usage).toBeUndefined()
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

    // The atomic write-then-rename never leaves its temp file behind.
    const entries = await readdir(appDataDir)
    expect(entries.filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a transport-level probe failure persists nothing, proceeds optimistically with think:false for that call, and re-probes on the next translateBatch call', async () => {
    // Probe call: transport-level failure (server down, connection reset,
    // model still loading, ...) - the model never actually responded.
    mocks.chat.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    // The group call still proceeds for this request, optimistically,
    // with think:false (same as a model that genuinely passed the probe).
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
    expect(mocks.chat.mock.calls[1][0]).toMatchObject({ think: false })

    // Nothing was written - a transport failure is not a capability verdict.
    await expect(readFile(path.join(appDataDir, 'model-caps.json'), 'utf8')).rejects.toThrow()

    // A second translateBatch call for the same model re-probes from
    // scratch rather than trusting a memoized negative from the failure.
    mocks.chat.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true })))
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour again' }] }))
    )
    const res2 = await backend.translateBatch(req())
    expect(res2.translations).toEqual([{ id: 's1', translation: 'Bonjour again' }])

    const probeCalls = mocks.chat.mock.calls.filter(([arg]) =>
      arg.messages.some((m: { content: string }) => m.content.includes('Capability probe'))
    )
    expect(probeCalls).toHaveLength(2) // the failed attempt, then the successful re-probe

    const written = JSON.parse(await readFile(path.join(appDataDir, 'model-caps.json'), 'utf8'))
    expect(written['test-model']).toEqual({ structuredWithThinkOff: true })
  })

  it('discards a malformed model-caps.json entry (wrong-typed field) instead of trusting it, and re-probes', async () => {
    await mkdir(appDataDir, { recursive: true })
    await writeFile(
      path.join(appDataDir, 'model-caps.json'),
      // structuredWithThinkOff must be a boolean - this corrupt/hand-edited
      // entry has it as a string, which must be discarded, not trusted.
      JSON.stringify({ 'test-model': { structuredWithThinkOff: 'yes' } }),
      'utf8'
    )

    mocks.chat.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true }))) // probe
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
    const probeCalls = mocks.chat.mock.calls.filter(([arg]) =>
      arg.messages.some((m: { content: string }) => m.content.includes('Capability probe'))
    )
    expect(probeCalls).toHaveLength(1) // malformed entry treated as absent -> re-probed

    const written = JSON.parse(await readFile(path.join(appDataDir, 'model-caps.json'), 'utf8'))
    expect(written['test-model']).toEqual({ structuredWithThinkOff: true }) // corrected on disk now
  })
})

// --- caps persistence is best-effort (Important fix) -----------------------

describe('OllamaBackend caps persistence: best-effort, never breaks translateBatch', () => {
  it('a transient model-caps.json write failure does not fail translateBatch, remembers the caps in-memory, and does not poison later writes', async () => {
    fsFailure.writeFileFailOnce = true

    // Probe + group call for test-model; the caps file write will fail.
    mocks.chat.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true })))
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour' }] }))
    )

    const backend = new OllamaBackend({
      baseUrl: 'http://127.0.0.1:1',
      appDataDir,
      retryDelayMs: 0
    })
    const res1 = await backend.translateBatch(req())
    expect(res1.translations).toEqual([{ id: 's1', translation: 'Bonjour' }])

    // Calling translateBatch again for the SAME model must not re-probe:
    // the failed on-disk write shouldn't have discarded the in-memory memo.
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Bonjour again' }] }))
    )
    const res2 = await backend.translateBatch(req())
    expect(res2.translations).toEqual([{ id: 's1', translation: 'Bonjour again' }])

    const probeCallsSoFar = mocks.chat.mock.calls.filter(([arg]) =>
      arg.messages.some((m: { content: string }) => m.content.includes('Capability probe'))
    )
    expect(probeCallsSoFar).toHaveLength(1) // still just the one probe from before

    // A later persist for a *different* model proves the shared write
    // chain recovered rather than staying permanently rejected.
    mocks.chat.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true })))
    mocks.chat.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ translations: [{ id: 's1', translation: 'Hola' }] }))
    )
    const res3 = await backend.translateBatch(req({ model: 'other-model' }))
    expect(res3.translations).toEqual([{ id: 's1', translation: 'Hola' }])

    const written = JSON.parse(await readFile(path.join(appDataDir, 'model-caps.json'), 'utf8'))
    expect(written['other-model']).toEqual({ structuredWithThinkOff: true })
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

  it('skips onProgress for events missing completed/total instead of reporting NaN', async () => {
    mocks.pull.mockResolvedValueOnce([
      { status: 'pulling manifest' }, // neither field present
      { status: 'downloading', digest: 'x', total: 100 }, // completed missing
      { status: 'downloading', digest: 'x', completed: 10 }, // total missing
      { status: 'downloading', digest: 'x', completed: 0, total: 0 }, // total not > 0
      { status: 'downloading', digest: 'x', completed: 50, total: 100 }, // well-formed
      { status: 'success', digest: 'x', completed: 100, total: 100 } // well-formed
    ])

    const backend = new OllamaBackend({ baseUrl: 'http://127.0.0.1:1', appDataDir })
    const pcts: number[] = []
    await backend.pullModel('llama3.1', (pct) => pcts.push(pct))

    expect(pcts).toEqual([50, 100]) // only the two well-formed events, never NaN
    expect(pcts.every((p) => Number.isFinite(p))).toBe(true)
  })
})
