import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JudgeScore } from '../../../src/core/bench/store'
import {
  createOllamaJudgeTransport,
  judgeSegments,
  JudgeBatchFailure,
  JUDGE_BATCH_SIZE,
  JUDGE_PROMPT_VERSION,
  type JudgeInput,
  type JudgeTransport
} from '../../../src/core/bench/judge'

// --- fixtures ---------------------------------------------------------------

function input(overrides: Partial<JudgeInput> & { segmentId: string }): JudgeInput {
  return {
    source: 'Hello world',
    translation: 'Bonjour le monde',
    sourceLang: 'English',
    targetLang: 'French',
    ...overrides
  }
}

/**
 * A JudgeTransport whose chat() is a plain vi.fn(), so each test scripts its
 * own sequence of resolved/rejected responses - mirrors ollama-backend.test.ts's
 * mocks.chat. Untyped (bare vi.fn()) deliberately, matching that file's own
 * style: request-shape assertions read fields off the captured call args
 * directly rather than via a generic type parameter.
 */
function fakeTransport(): { transport: JudgeTransport; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn()
  return { transport: { chat }, chat }
}

/**
 * Extracts the `id` values embedded in a captured request's user message, by
 * regex rather than coupling every test to the exact prompt wrapper text -
 * buildJudgeUserPrompt always JSON-serializes {id, source, translation}
 * objects, so `"id":"..."` substrings appear in call order regardless of the
 * surrounding language-pair header text.
 */
function idsFromUserPrompt(user: string): string[] {
  return [...user.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1])
}

/**
 * A well-formed judge response scoring every id present in `req.user` with
 * the same fixed (accuracy, fluency, format) triple - the generic
 * "happy path" responder for tests that only care about call counts/shapes,
 * not particular score values.
 */
function perfectResponse(req: { user: string }): string {
  const ids = idsFromUserPrompt(req.user)
  return JSON.stringify({ scores: ids.map((id) => ({ id, accuracy: 5, fluency: 4, format: 3 })) })
}

function byId(scores: JudgeScore[]): Map<string, JudgeScore> {
  return new Map(scores.map((s) => [s.segmentId, s]))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// --- exported constants ------------------------------------------------

describe('exported constants', () => {
  it('JUDGE_PROMPT_VERSION and JUDGE_BATCH_SIZE match the locked interface', () => {
    expect(JUDGE_PROMPT_VERSION).toBe('v1')
    expect(JUDGE_BATCH_SIZE).toBe(8)
  })
})

// --- contract point 1: chunking ---------------------------------------------

describe('judgeSegments - chunking (contract point 1)', () => {
  it('chunks inputs into batches of JUDGE_BATCH_SIZE: 20 inputs makes 3 transport calls on the happy path', async () => {
    const { transport, chat } = fakeTransport()
    chat.mockImplementation(async (req) => perfectResponse(req))
    const inputs = Array.from({ length: 20 }, (_, i) => input({ segmentId: `s${i}` }))

    const scores = await judgeSegments(inputs, 'judge-model', transport)

    expect(chat).toHaveBeenCalledTimes(3)
    expect(scores).toHaveLength(20)
    const batchSizes = chat.mock.calls.map(([req]) => idsFromUserPrompt(req.user).length)
    expect(batchSizes).toEqual([8, 8, 4])
  })

  it('a batch smaller than JUDGE_BATCH_SIZE makes exactly one call', async () => {
    const { transport, chat } = fakeTransport()
    chat.mockImplementation(async (req) => perfectResponse(req))
    const inputs = [input({ segmentId: 's1' }), input({ segmentId: 's2' })]

    const scores = await judgeSegments(inputs, 'judge-model', transport)

    expect(chat).toHaveBeenCalledTimes(1)
    expect(scores).toHaveLength(2)
  })
})

// --- contract point 2: clean response mapping -------------------------------

describe('judgeSegments - clean response mapping (contract point 2)', () => {
  it('maps ids to scores verbatim and scores round-trip as integers, including the 1 and 5 boundary values', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [input({ segmentId: 's1' }), input({ segmentId: 's2' })]
    chat.mockResolvedValueOnce(
      JSON.stringify({
        scores: [
          { id: 's1', accuracy: 5, fluency: 1, format: 3 },
          { id: 's2', accuracy: 1, fluency: 5, format: 4 }
        ]
      })
    )

    const scores = await judgeSegments(inputs, 'judge-model', transport)

    expect(scores).toEqual([
      { segmentId: 's1', accuracy: 5, fluency: 1, format: 3 },
      { segmentId: 's2', accuracy: 1, fluency: 5, format: 4 }
    ])
    expect(scores.every((s) => Number.isInteger(s.accuracy))).toBe(true)
    expect(scores.every((s) => Number.isInteger(s.fluency))).toBe(true)
    expect(scores.every((s) => Number.isInteger(s.format))).toBe(true)
    expect(chat).toHaveBeenCalledTimes(1)
  })
})

// --- contract point 3: malformed batch -> exactly one whole-batch retry ----

describe('judgeSegments - malformed batch triggers exactly one whole-batch retry (contract point 3)', () => {
  it('unparseable JSON on attempt 1: a clean retry resolves everything with no fallback calls', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [input({ segmentId: 's1' }), input({ segmentId: 's2' })]
    chat.mockResolvedValueOnce('not valid json at all')
    chat.mockResolvedValueOnce(
      JSON.stringify({
        scores: [
          { id: 's1', accuracy: 3, fluency: 3, format: 3 },
          { id: 's2', accuracy: 4, fluency: 4, format: 4 }
        ]
      })
    )

    const scores = await judgeSegments(inputs, 'judge-model', transport)

    expect(chat).toHaveBeenCalledTimes(2) // attempt 1 + retry, no fallback calls
    expect(byId(scores).get('s1')).toEqual({ segmentId: 's1', accuracy: 3, fluency: 3, format: 3 })
    expect(byId(scores).get('s2')).toEqual({ segmentId: 's2', accuracy: 4, fluency: 4, format: 4 })
  })

  it('an unknown id on attempt 1 (response names an id outside the batch): a clean retry resolves everything with no fallback calls', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [input({ segmentId: 's1' })]
    chat.mockResolvedValueOnce(
      JSON.stringify({
        scores: [{ id: 'ghost-id-not-in-batch', accuracy: 3, fluency: 3, format: 3 }]
      })
    )
    chat.mockResolvedValueOnce(
      JSON.stringify({ scores: [{ id: 's1', accuracy: 2, fluency: 2, format: 2 }] })
    )

    const scores = await judgeSegments(inputs, 'judge-model', transport)

    expect(chat).toHaveBeenCalledTimes(2)
    expect(scores).toEqual([{ segmentId: 's1', accuracy: 2, fluency: 2, format: 2 }])
  })

  it('an out-of-range value (0 or 6) on attempt 1: a clean retry resolves everything with no fallback calls', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [input({ segmentId: 's1' }), input({ segmentId: 's2' })]
    chat.mockResolvedValueOnce(
      JSON.stringify({
        scores: [
          { id: 's1', accuracy: 0, fluency: 3, format: 3 }, // 0 is out of bounds
          { id: 's2', accuracy: 3, fluency: 6, format: 3 } // 6 is out of bounds
        ]
      })
    )
    chat.mockResolvedValueOnce(
      JSON.stringify({
        scores: [
          { id: 's1', accuracy: 4, fluency: 4, format: 4 },
          { id: 's2', accuracy: 5, fluency: 5, format: 5 }
        ]
      })
    )

    const scores = await judgeSegments(inputs, 'judge-model', transport)

    expect(chat).toHaveBeenCalledTimes(2)
    expect(byId(scores).get('s1')).toEqual({ segmentId: 's1', accuracy: 4, fluency: 4, format: 4 })
    expect(byId(scores).get('s2')).toEqual({ segmentId: 's2', accuracy: 5, fluency: 5, format: 5 })
  })

  it('a well-formed sibling id in the same response is not poisoned by another id being out of range', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [input({ segmentId: 's1' }), input({ segmentId: 's2' })]
    // s1 is fine, s2 is out of range (0) - only s2 should still be
    // unresolved after attempt 1.
    chat.mockResolvedValueOnce(
      JSON.stringify({
        scores: [
          { id: 's1', accuracy: 4, fluency: 4, format: 4 },
          { id: 's2', accuracy: 0, fluency: 3, format: 3 }
        ]
      })
    )
    chat.mockResolvedValueOnce(
      JSON.stringify({ scores: [{ id: 's2', accuracy: 2, fluency: 2, format: 2 }] })
    )

    const scores = await judgeSegments(inputs, 'judge-model', transport)

    expect(chat).toHaveBeenCalledTimes(2)
    expect(byId(scores).get('s1')).toEqual({ segmentId: 's1', accuracy: 4, fluency: 4, format: 4 })
    expect(byId(scores).get('s2')).toEqual({ segmentId: 's2', accuracy: 2, fluency: 2, format: 2 })
  })
})

// --- Minor: two individually-valid entries sharing one id are both dropped ---
// (reviewer-flagged: correct behavior in reconcileScores, previously untested)

describe('judgeSegments - two individually-valid entries sharing the same id in one response are both dropped', () => {
  it('drops both same-id entries as ambiguous rather than guessing which is correct, then resolves via retry', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [input({ segmentId: 's1' }), input({ segmentId: 's2' })]
    // s1 appears TWICE, each individually well-formed (passes
    // SCORE_ENTRY_SCHEMA on its own) but with different values - ambiguous,
    // so reconcileScores must drop BOTH, not guess at either. s2 has a
    // single, unambiguous entry and should resolve immediately.
    chat.mockResolvedValueOnce(
      JSON.stringify({
        scores: [
          { id: 's1', accuracy: 5, fluency: 5, format: 5 },
          { id: 's1', accuracy: 1, fluency: 1, format: 1 },
          { id: 's2', accuracy: 3, fluency: 3, format: 3 }
        ]
      })
    )
    chat.mockResolvedValueOnce(
      JSON.stringify({ scores: [{ id: 's1', accuracy: 4, fluency: 4, format: 4 }] })
    )

    const scores = await judgeSegments(inputs, 'judge-model', transport)

    // s1 was NOT resolved by attempt 1 (both entries dropped) - proven by
    // the retry actually happening, not just by the final score value.
    expect(chat).toHaveBeenCalledTimes(2)
    expect(byId(scores).get('s1')).toEqual({ segmentId: 's1', accuracy: 4, fluency: 4, format: 4 })
    expect(byId(scores).get('s2')).toEqual({ segmentId: 's2', accuracy: 3, fluency: 3, format: 3 })
  })
})

// --- contract point 4: per-segment fallback ---------------------------------

describe('judgeSegments - per-segment fallback after a still-failing retry (contract point 4)', () => {
  it('each fallback call carries exactly one input, and only unresolved ids are retried this way', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [
      input({ segmentId: 's1' }),
      input({ segmentId: 's2' }),
      input({ segmentId: 's3' })
    ]

    // Attempt 1 (whole batch): only s1 resolves.
    chat.mockResolvedValueOnce(
      JSON.stringify({ scores: [{ id: 's1', accuracy: 3, fluency: 3, format: 3 }] })
    )
    // Attempt 2 (whole-batch retry): still only s1 - s2/s3 remain unresolved.
    chat.mockResolvedValueOnce(
      JSON.stringify({ scores: [{ id: 's1', accuracy: 3, fluency: 3, format: 3 }] })
    )
    // Per-segment fallback for s2.
    chat.mockResolvedValueOnce(
      JSON.stringify({ scores: [{ id: 's2', accuracy: 2, fluency: 2, format: 2 }] })
    )
    // Per-segment fallback for s3.
    chat.mockResolvedValueOnce(
      JSON.stringify({ scores: [{ id: 's3', accuracy: 1, fluency: 1, format: 1 }] })
    )

    const scores = await judgeSegments(inputs, 'judge-model', transport)

    expect(chat).toHaveBeenCalledTimes(4)
    const call3Ids = idsFromUserPrompt(chat.mock.calls[2][0].user)
    const call4Ids = idsFromUserPrompt(chat.mock.calls[3][0].user)
    expect(call3Ids).toEqual(['s2'])
    expect(call4Ids).toEqual(['s3'])

    expect(byId(scores).get('s1')).toEqual({ segmentId: 's1', accuracy: 3, fluency: 3, format: 3 })
    expect(byId(scores).get('s2')).toEqual({ segmentId: 's2', accuracy: 2, fluency: 2, format: 2 })
    expect(byId(scores).get('s3')).toEqual({ segmentId: 's3', accuracy: 1, fluency: 1, format: 1 })
  })
})

// --- contract point 5: unresolved after fallback is omitted -----------------

describe('judgeSegments - a segment unresolved after its fallback is omitted, siblings still returned (contract point 5)', () => {
  it('omits the segment that never resolves, but still returns other resolved segments from the same batch', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [input({ segmentId: 's1' }), input({ segmentId: 's2' })]

    // Attempt 1: s1 resolves, s2 does not.
    chat.mockResolvedValueOnce(
      JSON.stringify({ scores: [{ id: 's1', accuracy: 5, fluency: 5, format: 5 }] })
    )
    // Attempt 2 (retry): s2 still does not resolve.
    chat.mockResolvedValueOnce('still broken')
    // Per-segment fallback for s2: fails again.
    chat.mockResolvedValueOnce('broken again')

    const scores = await judgeSegments(inputs, 'judge-model', transport)

    expect(chat).toHaveBeenCalledTimes(3) // attempt 1 + retry + one fallback (for s2 only)
    expect(scores).toEqual([{ segmentId: 's1', accuracy: 5, fluency: 5, format: 5 }])
    expect(byId(scores).has('s2')).toBe(false)
  })
})

// --- contract point 6: createOllamaJudgeTransport ---------------------------

describe('createOllamaJudgeTransport (contract point 6)', () => {
  it('POSTs a temperature-0, think-off structured chat request to <baseUrl>/api/chat and returns message.content', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ message: { content: 'raw judge content' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const transport = createOllamaJudgeTransport('http://127.0.0.1:11434')
    const schema = { type: 'object', properties: {} }
    const result = await transport.chat({
      model: 'qwen3.6:35b',
      system: 'system text',
      user: 'user text',
      schema
    })

    expect(result).toBe('raw judge content')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.toString()).toBe('http://127.0.0.1:11434/api/chat')
    expect(init.method).toBe('POST')

    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      model: 'qwen3.6:35b',
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'user text' }
      ],
      format: schema,
      think: false,
      stream: false,
      options: { temperature: 0 }
    })
  })

  it('throws with the status when ollama responds with a non-ok status', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' })
    vi.stubGlobal('fetch', fetchMock)

    const transport = createOllamaJudgeTransport('http://127.0.0.1:11434')

    await expect(
      transport.chat({ model: 'm', system: 's', user: 'u', schema: {} })
    ).rejects.toThrow(/500/)
  })

  it('throws when the response is missing message.content (Minor, previously untested)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ message: {} }) // no content field at all
    })
    vi.stubGlobal('fetch', fetchMock)

    const transport = createOllamaJudgeTransport('http://127.0.0.1:11434')

    await expect(
      transport.chat({ model: 'm', system: 's', user: 'u', schema: {} })
    ).rejects.toThrow('judge transport: response missing message.content')
  })
})

// --- contract point 7: empty inputs -----------------------------------------

describe('judgeSegments - empty inputs (contract point 7)', () => {
  it('an empty inputs array returns [] with zero transport calls', async () => {
    const { transport, chat } = fakeTransport()

    const scores = await judgeSegments([], 'judge-model', transport)

    expect(scores).toEqual([])
    expect(chat).not.toHaveBeenCalled()
  })
})

// --- transport-failure propagation (design decision - see judge.ts's module doc comment) ---
//
// JudgeTransport.chat() returns a bare Promise<string> with no error
// channel, so a transport-level throw is let propagate out of
// judgeSegments() - wrapped in JudgeBatchFailure (see that class's own doc
// comment, and the dedicated describe block below) rather than being
// absorbed into the retry/fallback ladder - this is the only way the
// caller (bench-cli.ts's `judge` subcommand, Task 9) can tell "the judge is
// down" (a rejected promise) apart from "the judge scored badly" (a
// resolved but partial array).

describe('judgeSegments - a transport-level failure propagates instead of being absorbed by the ladder', () => {
  it('rejects when the whole-batch call itself throws, without burning a retry/fallback on a down transport', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [input({ segmentId: 's1' })]
    chat.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    await expect(judgeSegments(inputs, 'judge-model', transport)).rejects.toThrow('ECONNREFUSED')
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('rejects when a per-segment fallback call throws, after the ladder already tried retrying normally', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [input({ segmentId: 's1' }), input({ segmentId: 's2' })]

    chat.mockResolvedValueOnce(
      JSON.stringify({ scores: [{ id: 's1', accuracy: 3, fluency: 3, format: 3 }] })
    ) // attempt 1: s1 resolves, s2 does not
    chat.mockResolvedValueOnce('still broken') // retry: s2 still unresolved
    chat.mockRejectedValueOnce(new Error('ECONNRESET')) // per-segment fallback for s2: transport down

    await expect(judgeSegments(inputs, 'judge-model', transport)).rejects.toThrow('ECONNRESET')
    expect(chat).toHaveBeenCalledTimes(3)
  })
})

// --- JudgeBatchFailure: partial results survive a later batch's failure (reviewer fix) ---
//
// judgeSegments has no per-batch checkpoint (unlike harness.ts's cells,
// which are written to disk before an abort can even be detected - see the
// module doc comment's full comparison). Without JudgeBatchFailure, a later
// batch throwing would silently discard the already-correct scores an
// earlier, fully-completed batch already produced. This needs MORE than
// JUDGE_BATCH_SIZE inputs specifically: the two single-batch tests above
// can never exercise cross-batch loss, since they only ever make one
// judgeBatch call in the first place.

describe("judgeSegments - a multi-batch failure carries the earlier batches' scores out via JudgeBatchFailure", () => {
  it('a later batch throwing after an earlier batch resolved cleanly rejects with JudgeBatchFailure carrying exactly the earlier batchs scores', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = Array.from({ length: JUDGE_BATCH_SIZE + 1 }, (_, i) =>
      input({ segmentId: `s${i}` })
    )
    const firstBatchIds = inputs.slice(0, JUDGE_BATCH_SIZE).map((i) => i.segmentId)

    // Batch 1 (s0..s7, JUDGE_BATCH_SIZE items): resolves cleanly on attempt 1.
    chat.mockImplementationOnce(async (req) => perfectResponse(req))
    // Batch 2 (s8 alone): the transport itself throws on the very first call.
    chat.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const err = await judgeSegments(inputs, 'judge-model', transport).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(JudgeBatchFailure)
    const failure = err as JudgeBatchFailure
    expect(failure.partialScores).toHaveLength(JUDGE_BATCH_SIZE)
    expect(failure.partialScores.map((s) => s.segmentId).sort()).toEqual([...firstBatchIds].sort())
    // Nothing fabricated or defaulted for the failed batch's own segment.
    expect(failure.partialScores.some((s) => s.segmentId === 's8')).toBe(false)
    expect(failure.cause).toBeInstanceOf(Error)
    expect((failure.cause as Error).message).toBe('ECONNREFUSED')
    // Batch 1: one happy-path call. Batch 2: one call, which throws.
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('a failure on the very first batch carries an empty partialScores array, not undefined or a fabricated entry', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [input({ segmentId: 's1' })]
    chat.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const err = await judgeSegments(inputs, 'judge-model', transport).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(JudgeBatchFailure)
    expect((err as JudgeBatchFailure).partialScores).toEqual([])
  })
})

// --- rubric text integrity (self-review: system prompt encodes the locked rubric verbatim) ---

describe('system prompt carries the locked rubric verbatim', () => {
  it('the captured system message contains all three dimension descriptions from the phase-4 plan, word for word', async () => {
    const { transport, chat } = fakeTransport()
    chat.mockImplementation(async (req) => perfectResponse(req))
    const inputs = [input({ segmentId: 's1' })]

    await judgeSegments(inputs, 'judge-model', transport)

    const system: string = chat.mock.calls[0][0].system
    expect(system).toContain(
      'accuracy 1-5: the translation preserves the full meaning; numbers, names, and codes are intact.'
    )
    expect(system).toContain(
      'fluency 1-5: the text reads naturally in the target language for a business document.'
    )
    expect(system).toContain(
      'format 1-5: units, placeholders, punctuation conventions, and casing survive appropriately.'
    )
  })
})

// --- user prompt shape (self-review: language pair + {id, source, translation} JSON) ---

describe('judgeSegments - user prompt carries the language pair and {id, source, translation} JSON', () => {
  it('the captured user message contains the language pair and each requested id/source/translation', async () => {
    const { transport, chat } = fakeTransport()
    chat.mockImplementation(async (req) => perfectResponse(req))
    const inputs = [
      input({
        segmentId: 's1',
        source: 'Hello',
        translation: 'Bonjour',
        sourceLang: 'English',
        targetLang: 'French'
      })
    ]

    await judgeSegments(inputs, 'judge-model', transport)

    const user: string = chat.mock.calls[0][0].user
    expect(user).toContain('English -> French')
    const jsonPart = user.slice(user.indexOf('['))
    expect(JSON.parse(jsonPart)).toEqual([{ id: 's1', source: 'Hello', translation: 'Bonjour' }])
  })
})

// --- attempt-1 winners survive the retry (self-review, mirrors ollama-backend.test.ts precedent) ---

describe('judgeSegments - an id already resolved by attempt 1 is not overwritten by the retry', () => {
  it('keeps attempt 1s score even when the retry response has a different value for the same id', async () => {
    const { transport, chat } = fakeTransport()
    const inputs = [input({ segmentId: 's1' }), input({ segmentId: 's2' })]

    chat.mockResolvedValueOnce(
      JSON.stringify({ scores: [{ id: 's1', accuracy: 5, fluency: 5, format: 5 }] })
    ) // s2 unresolved
    chat.mockResolvedValueOnce(
      JSON.stringify({
        scores: [
          { id: 's1', accuracy: 1, fluency: 1, format: 1 }, // different value - must be ignored
          { id: 's2', accuracy: 4, fluency: 4, format: 4 }
        ]
      })
    )

    const scores = await judgeSegments(inputs, 'judge-model', transport)

    expect(byId(scores).get('s1')).toEqual({ segmentId: 's1', accuracy: 5, fluency: 5, format: 5 })
    expect(byId(scores).get('s2')).toEqual({ segmentId: 's2', accuracy: 4, fluency: 4, format: 4 })
    expect(chat).toHaveBeenCalledTimes(2)
  })
})
