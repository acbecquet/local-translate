import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runPipeline, NOT_SOURCE_LANGUAGE_REASON } from '../../src/core/pipeline'
import { FakeAdapter } from '../../src/core/adapters/fake/fake-adapter'
import type { FormatAdapter } from '../../src/core/adapters/adapter'
import type { TextSegment } from '../../src/core/segments'
import type {
  BatchRequest,
  BatchResponse,
  TranslationBackend
} from '../../src/core/translate/backend'

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
})

/** Writes a fake.json fixture with the given segments and returns its path. */
function writeFixture(segments: TextSegment[]): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'lt-pipeline-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'doc.fake.json')
  writeFileSync(file, JSON.stringify({ segments }))
  return { dir, file }
}

function readApplied(outPath: string): { segments: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(outPath, 'utf8'))
}

/** Hand-rolled TranslationBackend mock - the only thing pipeline tests mock. */
function makeBackend(
  translateBatch: (req: BatchRequest) => Promise<BatchResponse> | BatchResponse
): TranslationBackend {
  return {
    listModels: vi.fn().mockResolvedValue([]),
    pullModel: vi.fn().mockResolvedValue(undefined),
    translateBatch: vi.fn(async (req: BatchRequest) => translateBatch(req))
  }
}

const adapter = new FakeAdapter()

describe('runPipeline', () => {
  it('all-success: every segment gets a validated translation applied', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const s2 = seg({ id: 's2', text: 'World', context: 'doc' })
    const { file } = writeFixture([s1, s2])

    const backend = makeBackend((req) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[${s.text}]` }))
    }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.file).toBe(file)
    expect(report.outPath).toBe(path.join(path.dirname(file), 'doc_translated.fake.json'))
    expect(report.total).toBe(2)
    expect(report.translated).toBe(2)
    expect(report.keptOriginal).toEqual([])
    expect(report.overflowed).toEqual([])
    expect(report.total).toBe(report.translated + report.keptOriginal.length)

    const applied = readApplied(report.outPath)
    expect(applied.segments).toHaveLength(2)
    const byId = new Map(applied.segments.map((s) => [s.id, s]))
    expect(byId.get('s1')).toMatchObject({ translation: '[Hello]' })
    expect(byId.get('s2')).toMatchObject({ translation: '[World]' })
    // every extracted id appears exactly once in the applied output
    expect(applied.segments.map((s) => s.id).sort()).toEqual(['s1', 's2'])
  })

  it('partial failure: segments absent from the response (with a reported reason) fall back to original text and land in keptOriginal', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const s2 = seg({ id: 's2', text: 'World', context: 'doc' })
    const s3 = seg({ id: 's3', text: 'Again', context: 'doc' })
    const { file } = writeFixture([s1, s2, s3])

    const backend = makeBackend(() => ({
      translations: [
        { id: 's1', translation: 'Bonjour' },
        { id: 's3', translation: 'Encore' }
      ],
      failures: [{ id: 's2', reason: 'echo' }]
    }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.total).toBe(3)
    expect(report.translated).toBe(2)
    expect(report.keptOriginal).toEqual([{ id: 's2', reason: 'echo' }])
    expect(report.total).toBe(report.translated + report.keptOriginal.length)

    const applied = readApplied(report.outPath)
    const byId = new Map(applied.segments.map((s) => [s.id, s]))
    expect(byId.get('s1')).toMatchObject({ translation: 'Bonjour' })
    expect(byId.get('s3')).toMatchObject({ translation: 'Encore' })
    // kept-original segment: translation falls back to the original source text
    expect(byId.get('s2')).toMatchObject({ translation: 'World' })
    expect(applied.segments.map((s) => s.id).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('falls back to a generic reason when a segment is absent with no matching failures entry', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])

    // Backend omits s1 from translations and never explains why - pipeline
    // must still account for it in keptOriginal rather than losing it.
    const backend = makeBackend(() => ({ translations: [] }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.total).toBe(1)
    expect(report.translated).toBe(0)
    expect(report.keptOriginal).toHaveLength(1)
    expect(report.keptOriginal[0].id).toBe('s1')
    expect(typeof report.keptOriginal[0].reason).toBe('string')
    expect(report.keptOriginal[0].reason.length).toBeGreaterThan(0)
  })

  it('overflow reporting: a translation that cannot fit its box still gets applied and is reported as overflowed', async () => {
    const huge = seg({
      id: 's1',
      text: 'x',
      context: 'doc',
      box: { wPt: 1, hPt: 1 },
      font: { family: 'Noto Sans', sizePt: 18 }
    })
    const { file } = writeFixture([huge])

    const longTranslation =
      'This is a very long translated sentence that can never fit inside a one point by one point box no matter how small the font gets.'
    const backend = makeBackend(() => ({
      translations: [{ id: 's1', translation: longTranslation }]
    }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.translated).toBe(1)
    expect(report.keptOriginal).toEqual([])
    expect(report.overflowed).toHaveLength(1)
    expect(report.overflowed[0].id).toBe('s1')
    expect(typeof report.overflowed[0].fontSizePt).toBe('number')

    // Content preservation: overflowed segments are still applied, never dropped.
    const applied = readApplied(report.outPath)
    expect(applied.segments).toHaveLength(1)
    expect(applied.segments[0]).toMatchObject({ id: 's1', translation: longTranslation })
  })

  it('untranslatable passthrough accounting: numeric/symbol-only segments are never sent to the backend but are counted and kept', async () => {
    const real = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const numeric = seg({ id: 's2', text: '12345', context: 'doc' })
    const symbols = seg({ id: 's3', text: '---***', context: 'doc' })
    const { file } = writeFixture([real, numeric, symbols])

    const translateBatch = vi.fn(async (req: BatchRequest) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[${s.text}]` }))
    }))
    const backend: TranslationBackend = {
      listModels: vi.fn().mockResolvedValue([]),
      pullModel: vi.fn().mockResolvedValue(undefined),
      translateBatch
    }

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.total).toBe(3)
    expect(report.translated).toBe(1)
    expect(report.keptOriginal).toEqual(
      expect.arrayContaining([
        { id: 's2', reason: 'skipped-untranslatable' },
        { id: 's3', reason: 'skipped-untranslatable' }
      ])
    )
    expect(report.keptOriginal).toHaveLength(2)
    expect(report.total).toBe(report.translated + report.keptOriginal.length)

    // The backend must never see the untranslatable segments.
    expect(translateBatch).toHaveBeenCalledTimes(1)
    const sentIds = translateBatch.mock.calls[0][0].segments.map((s: { id: string }) => s.id)
    expect(sentIds).toEqual(['s1'])

    const applied = readApplied(report.outPath)
    const byId = new Map(applied.segments.map((s) => [s.id, s]))
    expect(byId.get('s2')).toMatchObject({ translation: '12345' })
    expect(byId.get('s3')).toMatchObject({ translation: '---***' })
  })

  it('combined scenario: translated + failure-kept + untranslatable-kept + overflowed all reconcile against the invariant', async () => {
    const translated = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const failed = seg({ id: 's2', text: 'World', context: 'doc' })
    const untranslatable = seg({ id: 's3', text: '999', context: 'doc' })
    const overflowing = seg({
      id: 's4',
      text: 'x',
      context: 'doc',
      box: { wPt: 1, hPt: 1 }
    })
    const { file } = writeFixture([translated, failed, untranslatable, overflowing])

    const backend = makeBackend(() => ({
      translations: [
        { id: 's1', translation: 'Bonjour' },
        { id: 's4', translation: 'Un texte beaucoup trop long pour cette toute petite boite.' }
      ],
      failures: [{ id: 's2', reason: 'empty' }]
    }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.total).toBe(4)
    expect(report.total).toBe(report.translated + report.keptOriginal.length)
    expect(report.translated).toBe(2) // s1, s4
    expect(report.keptOriginal.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 's2', reason: 'empty' },
      { id: 's3', reason: 'skipped-untranslatable' }
    ])
    expect(report.overflowed.map((o) => o.id)).toEqual(['s4'])

    const applied = readApplied(report.outPath)
    expect(applied.segments.map((s) => s.id).sort()).toEqual(['s1', 's2', 's3', 's4'])
  })

  it('groupContext derivation: with a groupKey, the backend receives "<groupKey>: <sorted unique roles>"; without one, it falls back to the sole context', async () => {
    const withGroupKey1 = seg({
      id: 's1',
      text: 'Hello',
      context: 'slide title',
      groupKey: 'slide3'
    })
    const withGroupKey2 = seg({ id: 's2', text: 'World', context: 'body', groupKey: 'slide3' })
    const withGroupKey3 = seg({
      id: 's3',
      text: 'Again',
      context: 'table cell',
      groupKey: 'slide3'
    })
    const noGroupKey = seg({ id: 's4', text: 'Plain', context: 'doc' })
    const { file } = writeFixture([withGroupKey1, withGroupKey2, withGroupKey3, noGroupKey])

    const translateBatch = vi.fn(async (req: BatchRequest) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[${s.text}]` }))
    }))
    const backend: TranslationBackend = {
      listModels: vi.fn().mockResolvedValue([]),
      pullModel: vi.fn().mockResolvedValue(undefined),
      translateBatch
    }

    await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    // groupSegments (batching.ts) groups by groupKey when present, so s1-s3
    // (same groupKey, different context/role each) land in one call; s4 (no
    // groupKey) is grouped by its own context and lands in a separate call.
    expect(translateBatch).toHaveBeenCalledTimes(2)
    const groupContexts = translateBatch.mock.calls.map((c) => c[0].groupContext)
    expect(groupContexts).toContain('slide3: body, slide title, table cell')
    expect(groupContexts).toContain('doc')
  })

  it('respects an explicit out path instead of the default', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file, dir } = writeFixture([s1])
    const customOut = path.join(dir, 'custom-output.fake.json')

    const backend = makeBackend((req) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[${s.text}]` }))
    }))

    const report = await runPipeline({
      file,
      out: customOut,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.outPath).toBe(customOut)
    const applied = readApplied(customOut)
    expect(applied.segments).toHaveLength(1)
  })

  it('reports progress through extract, translate, fit, and apply phases', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const s2 = seg({ id: 's2', text: 'World', context: 'doc' })
    const { file } = writeFixture([s1, s2])

    const backend = makeBackend((req) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[${s.text}]` }))
    }))

    const phasesSeen = new Set<string>()
    let finalFitCall: [number, number] | null = null

    await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend,
      onProgress: (done, total, phase) => {
        phasesSeen.add(phase)
        expect(done).toBeLessThanOrEqual(total)
        if (phase === 'fit') finalFitCall = [done, total]
      }
    })

    expect(phasesSeen).toEqual(new Set(['extract', 'translate', 'fit', 'apply']))
    expect(finalFitCall).toEqual([2, 2])
  })

  it('handles an empty document: zero segments, applied output is empty, all four phases still report via onProgress', async () => {
    const { file } = writeFixture([])

    const translateBatch = vi.fn()
    const backend: TranslationBackend = {
      listModels: vi.fn().mockResolvedValue([]),
      pullModel: vi.fn().mockResolvedValue(undefined),
      translateBatch
    }

    const phaseCalls: { phase: string; done: number; total: number }[] = []

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend,
      onProgress: (done, total, phase) => {
        phaseCalls.push({ phase, done, total })
      }
    })

    expect(report.total).toBe(0)
    expect(report.translated).toBe(0)
    expect(report.keptOriginal).toEqual([])
    expect(report.overflowed).toEqual([])
    expect(translateBatch).not.toHaveBeenCalled()

    const phasesSeen = new Set(phaseCalls.map((c) => c.phase))
    expect(phasesSeen).toEqual(new Set(['extract', 'translate', 'fit', 'apply']))
    // Every phase reports done === total === 0, except apply which is a
    // single atomic step reported as done once it completes (1 of 1).
    for (const call of phaseCalls) {
      if (call.phase === 'apply') {
        expect(call).toMatchObject({ done: 1, total: 1 })
      } else {
        expect(call).toMatchObject({ done: 0, total: 0 })
      }
    }

    const applied = readApplied(report.outPath)
    expect(applied.segments).toEqual([])
  })

  it('rejects with a clear error naming the duplicate id when the adapter extracts one, before any translation work and without touching the input file', async () => {
    const s1 = seg({ id: 'dup', text: 'Hello', context: 'doc' })
    const s2 = seg({ id: 'dup', text: 'World', context: 'doc' })
    const { file } = writeFixture([s1, s2])
    const originalContents = readFileSync(file, 'utf8')

    const translateBatch = vi.fn()
    const backend: TranslationBackend = {
      listModels: vi.fn().mockResolvedValue([]),
      pullModel: vi.fn().mockResolvedValue(undefined),
      translateBatch
    }

    await expect(
      runPipeline({
        file,
        sourceLang: 'English',
        targetLang: 'French',
        model: 'test-model',
        adapter,
        backend
      })
    ).rejects.toThrow(/dup/)

    expect(translateBatch).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(originalContents)
  })

  it('produces a stable RunReport shape with a non-negative duration', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])
    const backend = makeBackend(() => ({ translations: [{ id: 's1', translation: 'Bonjour' }] }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.durationMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(report.durationMs)).toBe(true)
  })

  it('skippedUnsupported defaults to [] for an adapter that never implements the optional collectSkips()', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])
    const backend = makeBackend(() => ({ translations: [{ id: 's1', translation: 'Bonjour' }] }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter, // FakeAdapter - deliberately has no collectSkips method at all
      backend
    })

    expect(report.skippedUnsupported).toEqual([])
  })

  it('skippedUnsupported is populated from adapter.collectSkips() when the adapter implements it', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])
    const backend = makeBackend(() => ({ translations: [{ id: 's1', translation: 'Bonjour' }] }))

    const skippingAdapter: FormatAdapter = {
      name: 'fake-with-skips',
      extensions: ['.fake.json'],
      extract: (p) => adapter.extract(p),
      apply: (p, out, segs) => adapter.apply(p, out, segs),
      collectSkips: () => [{ id: 'slide1/chart[name=Chart 1]', reason: 'chart' }]
    }

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter: skippingAdapter,
      backend
    })

    expect(report.skippedUnsupported).toEqual([
      { id: 'slide1/chart[name=Chart 1]', reason: 'chart' }
    ])
  })
})

describe('runPipeline: RunReport.stats', () => {
  it('reports model, non-negative phase timings for every phase, and connect defaulting to 0 when connectMs is omitted', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])
    const backend = makeBackend(() => ({ translations: [{ id: 's1', translation: 'Bonjour' }] }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.stats.model).toBe('test-model')
    expect(report.stats.phaseMs.extract).toBeGreaterThanOrEqual(0)
    expect(report.stats.phaseMs.translate).toBeGreaterThanOrEqual(0)
    expect(report.stats.phaseMs.fit).toBeGreaterThanOrEqual(0)
    expect(report.stats.phaseMs.apply).toBeGreaterThanOrEqual(0)
    expect(report.stats.phaseMs.connect).toBe(0)
    for (const ms of Object.values(report.stats.phaseMs)) {
      expect(Number.isFinite(ms)).toBe(true)
    }
  })

  it('reports the caller-supplied connectMs verbatim as phaseMs.connect', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])
    const backend = makeBackend(() => ({ translations: [{ id: 's1', translation: 'Bonjour' }] }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend,
      connectMs: 123
    })

    expect(report.stats.phaseMs.connect).toBe(123)
  })

  it('groups/modelCalls/groupRetries/perSegmentFallbacks/tokens: sums BatchResponse.usage across every group', async () => {
    // Two separate groupContexts -> two groups -> two translateBatch calls,
    // each reporting its own usage; the report sums both.
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc-a' })
    const s2 = seg({ id: 's2', text: 'World', context: 'doc-b' })
    const { file } = writeFixture([s1, s2])

    const translateBatch = vi.fn(async (req: BatchRequest) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[${s.text}]` })),
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        modelDurationMs: 100, // whole-call latency (incl. load) - deliberately NOT what tokensPerSec is based on
        evalDurationMs: 50, // pure generation time - distinct from modelDurationMs, on purpose
        calls: 1,
        retries: req.groupContext === 'doc-a' ? 1 : 0,
        perSegmentFallbacks: req.groupContext === 'doc-a' ? 1 : 0
      }
    }))
    const backend: TranslationBackend = {
      listModels: vi.fn().mockResolvedValue([]),
      pullModel: vi.fn().mockResolvedValue(undefined),
      translateBatch
    }

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(translateBatch).toHaveBeenCalledTimes(2)
    expect(report.stats.groups).toBe(2)
    expect(report.stats.modelCalls).toBe(2) // 1 call per group, summed
    expect(report.stats.groupRetries).toBe(1)
    expect(report.stats.perSegmentFallbacks).toBe(1)
    expect(report.stats.promptTokens).toBe(20)
    expect(report.stats.completionTokens).toBe(8)
    // tokensPerSec = completionTokens / (summed evalDurationMs / 1000)
    // = 8 / (100 / 1000) = 80 - NOT 8 / (summed modelDurationMs / 1000) = 40,
    // which would be the answer if this were wrongly based on whole-call
    // latency instead of pure generation time.
    expect(report.stats.tokensPerSec).toBe(80)
  })

  it('tokensPerSec is based on evalDurationMs (pure generation time), not modelDurationMs (whole-call latency incl. load) - a slow-loading, fast-generating call must not be reported as slow throughput', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])

    const backend = makeBackend(() => ({
      translations: [{ id: 's1', translation: 'Bonjour' }],
      usage: {
        promptTokens: 5,
        completionTokens: 10,
        modelDurationMs: 1000, // e.g. a slow cold model load dominates whole-call latency
        evalDurationMs: 200, // but generation itself was fast
        calls: 1,
        retries: 0,
        perSegmentFallbacks: 0
      }
    }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    // 10 / (200 / 1000) = 50, not 10 / (1000 / 1000) = 10.
    expect(report.stats.tokensPerSec).toBe(50)
  })

  it('is 0-safe throughout when the backend never reports usage at all', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])
    // makeBackend's translateBatch response has no `usage` field.
    const backend = makeBackend(() => ({ translations: [{ id: 's1', translation: 'Bonjour' }] }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.stats.modelCalls).toBe(0)
    expect(report.stats.groupRetries).toBe(0)
    expect(report.stats.perSegmentFallbacks).toBe(0)
    expect(report.stats.promptTokens).toBe(0)
    expect(report.stats.completionTokens).toBe(0)
    expect(report.stats.tokensPerSec).toBe(0)
    expect(Number.isFinite(report.stats.tokensPerSec)).toBe(true)
  })

  it('charsSource counts every extracted segment; charsTranslated counts only segments that actually got a translation - keptOriginal segments (untranslatable, or a failed translation) contribute to charsSource but not charsTranslated', async () => {
    const translated = seg({ id: 's1', text: 'Hello', context: 'doc' }) // 5 chars source
    const untranslatable = seg({ id: 's2', text: '12345', context: 'doc' }) // 5 chars source, never sent to backend
    const failed = seg({ id: 's3', text: 'Worldly', context: 'doc' }) // 7 chars source, backend reports failure
    const { file } = writeFixture([translated, untranslatable, failed])

    const backend = makeBackend(() => ({
      translations: [{ id: 's1', translation: 'Bonjour' }], // 7 chars translated
      failures: [{ id: 's3', reason: 'empty' }]
    }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.stats.charsSource).toBe(5 + 5 + 7) // every extracted segment's original text
    expect(report.stats.charsTranslated).toBe(7) // only s1's actual translation
  })

  it('segmentsPerMin is 0-safe and reflects translated / (durationMs / 60000)', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])
    const backend = makeBackend(() => ({ translations: [{ id: 's1', translation: 'Bonjour' }] }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.stats.segmentsPerMin).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(report.stats.segmentsPerMin)).toBe(true)
  })

  it('handles an empty document: groups 0, all sums 0, no division-by-zero NaN anywhere in stats', async () => {
    const { file } = writeFixture([])
    const translateBatch = vi.fn()
    const backend: TranslationBackend = {
      listModels: vi.fn().mockResolvedValue([]),
      pullModel: vi.fn().mockResolvedValue(undefined),
      translateBatch
    }

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.stats.groups).toBe(0)
    expect(report.stats.modelCalls).toBe(0)
    expect(report.stats.charsSource).toBe(0)
    expect(report.stats.charsTranslated).toBe(0)
    expect(report.stats.tokensPerSec).toBe(0)
    expect(report.stats.segmentsPerMin).toBe(0)
    for (const v of Object.values(report.stats)) {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('runPipeline: per-segment source-language gate', () => {
  it('en source + CJK segment: gated as not-source-language before grouping, never reaches the backend, translation stays byte-identical', async () => {
    const cjk = seg({ id: 's1', text: '你好世界', context: 'doc' })
    const { file } = writeFixture([cjk])

    const translateBatch = vi.fn(async (req: BatchRequest) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[${s.text}]` }))
    }))
    const backend: TranslationBackend = {
      listModels: vi.fn().mockResolvedValue([]),
      pullModel: vi.fn().mockResolvedValue(undefined),
      translateBatch
    }

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'Chinese (Simplified)',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.total).toBe(1)
    expect(report.translated).toBe(0)
    expect(report.keptOriginal).toEqual([{ id: 's1', reason: NOT_SOURCE_LANGUAGE_REASON }])
    expect(translateBatch).not.toHaveBeenCalled()

    const applied = readApplied(report.outPath)
    expect(applied.segments[0]).toMatchObject({ translation: '你好世界' })
  })

  it('zh source + latin segment: gated as not-source-language before grouping, never reaches the backend, translation stays byte-identical', async () => {
    const latin = seg({ id: 's1', text: 'Model X200 Instructions', context: 'doc' })
    const { file } = writeFixture([latin])

    const translateBatch = vi.fn(async (req: BatchRequest) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[${s.text}]` }))
    }))
    const backend: TranslationBackend = {
      listModels: vi.fn().mockResolvedValue([]),
      pullModel: vi.fn().mockResolvedValue(undefined),
      translateBatch
    }

    const report = await runPipeline({
      file,
      sourceLang: 'Chinese (Simplified)',
      targetLang: 'English',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.keptOriginal).toEqual([{ id: 's1', reason: NOT_SOURCE_LANGUAGE_REASON }])
    expect(translateBatch).not.toHaveBeenCalled()

    const applied = readApplied(report.outPath)
    expect(applied.segments[0]).toMatchObject({ translation: 'Model X200 Instructions' })
  })

  it('zh source + CJK segment: passes the language gate and is translated normally', async () => {
    const cjk = seg({ id: 's1', text: '你好世界的问候语', context: 'doc' })
    const { file } = writeFixture([cjk])

    const backend = makeBackend((req) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: 'Hello world greeting' }))
    }))

    const report = await runPipeline({
      file,
      sourceLang: 'Chinese (Simplified)',
      targetLang: 'English',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.translated).toBe(1)
    expect(report.keptOriginal).toEqual([])

    const applied = readApplied(report.outPath)
    expect(applied.segments[0]).toMatchObject({ translation: 'Hello world greeting' })
  })

  it('mixed batch: a language-gated segment is excluded from the group sent to the backend, but still counted in report totals', async () => {
    const english = seg({ id: 's1', text: 'Hello there', context: 'doc' })
    const cjk = seg({ id: 's2', text: '你好世界', context: 'doc' })
    const { file } = writeFixture([english, cjk])

    const translateBatch = vi.fn(async (req: BatchRequest) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[${s.text}]` }))
    }))
    const backend: TranslationBackend = {
      listModels: vi.fn().mockResolvedValue([]),
      pullModel: vi.fn().mockResolvedValue(undefined),
      translateBatch
    }

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'Chinese (Simplified)',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.total).toBe(2)
    expect(report.translated).toBe(1)
    expect(report.keptOriginal).toEqual([{ id: 's2', reason: NOT_SOURCE_LANGUAGE_REASON }])
    expect(report.total).toBe(report.translated + report.keptOriginal.length)

    expect(translateBatch).toHaveBeenCalledTimes(1)
    const sentIds = translateBatch.mock.calls[0][0].segments.map((s: { id: string }) => s.id)
    expect(sentIds).toEqual(['s1'])
  })

  it('precedence: a segment that is BOTH not-source-language and numbers-only gets exactly one reason - the language gate runs first', async () => {
    // '12345' under a Chinese source: 0% CJK ratio -> fails the language
    // gate (not-source-language); it also has no \p{L} letters -> would
    // separately fail hasTranslatableContent (skipped-untranslatable). Only
    // one reason must be recorded, and it must be the language-gate one,
    // since a segment excluded by language never even reaches the
    // untranslatable check (see translateSegments in pipeline.ts).
    const numeric = seg({ id: 's1', text: '12345', context: 'doc' })
    const { file } = writeFixture([numeric])

    const translateBatch = vi.fn()
    const backend: TranslationBackend = {
      listModels: vi.fn().mockResolvedValue([]),
      pullModel: vi.fn().mockResolvedValue(undefined),
      translateBatch
    }

    const report = await runPipeline({
      file,
      sourceLang: 'Chinese (Simplified)',
      targetLang: 'English',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.keptOriginal).toEqual([{ id: 's1', reason: NOT_SOURCE_LANGUAGE_REASON }])
    expect(translateBatch).not.toHaveBeenCalled()
  })

  it('fit still runs for a gated segment: fittedSizePt matches the original size (no resize), since translation === original text', async () => {
    const cjk = seg({
      id: 's1',
      text: '你好',
      context: 'doc',
      font: { family: 'Noto Sans', sizePt: 18 }
    })
    const { file } = writeFixture([cjk])

    const backend = makeBackend((req) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[${s.text}]` }))
    }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'Chinese (Simplified)',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.keptOriginal).toEqual([{ id: 's1', reason: NOT_SOURCE_LANGUAGE_REASON }])
    expect(report.overflowed).toEqual([])

    const applied = readApplied(report.outPath)
    expect(applied.segments[0]).toMatchObject({ fittedSizePt: 18, translation: '你好' })
  })
})

describe('runPipeline: RunReport.segments', () => {
  it('every extracted segment appears exactly once in report.segments, in extract order, with sourceText verbatim', async () => {
    // Extract order deliberately not id-sorted, to prove the report follows
    // extract order rather than re-sorting by id.
    const s1 = seg({ id: 's3', text: 'Third', context: 'doc' })
    const s2 = seg({ id: 's1', text: 'First', context: 'doc' })
    const s3 = seg({ id: 's2', text: 'Second', context: 'doc' })
    const { file } = writeFixture([s1, s2, s3])

    const backend = makeBackend((req) => ({
      translations: req.segments.map((s) => ({ id: s.id, translation: `[${s.text}]` }))
    }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    expect(report.segments.map((s) => s.id)).toEqual(['s3', 's1', 's2'])
    expect(report.segments.map((s) => s.sourceText)).toEqual(['Third', 'First', 'Second'])
  })

  it('translated segment: translation is the resolved translation, and fittedSizePt/lineCount match what apply() received', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])

    const multiline = 'Line one\nLine two\nLine three'
    const backend = makeBackend(() => ({
      translations: [{ id: 's1', translation: multiline }]
    }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    const detail = report.segments.find((s) => s.id === 's1')
    expect(detail?.translation).toBe(multiline)

    const applied = readApplied(report.outPath)
    const appliedSeg = applied.segments.find((s) => s.id === 's1') as {
      fittedSizePt: number
      fittedLines: string[]
    }
    // "matching what apply() received" - compared against the exact
    // TranslatedSegment the adapter's apply() wrote, not a hardcoded guess.
    expect(detail?.fittedSizePt).toBe(appliedSeg.fittedSizePt)
    expect(detail?.lineCount).toBe(appliedSeg.fittedLines.length)
    expect(detail?.lineCount).toBeGreaterThan(1)
  })

  it('a keptOriginal segment (untranslatable, not-source-language, or backend failure) has translation: null and no fit fields', async () => {
    const untranslatable = seg({ id: 's1', text: '12345', context: 'doc' })
    const gated = seg({ id: 's2', text: '你好世界', context: 'doc' })
    const failed = seg({ id: 's3', text: 'Sometext', context: 'doc' })
    const translated = seg({ id: 's4', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([untranslatable, gated, failed, translated])

    const backend = makeBackend((req) => ({
      translations: req.segments
        .filter((s) => s.id !== 's3')
        .map((s) => ({ id: s.id, translation: `[${s.text}]` })),
      failures: [{ id: 's3', reason: 'echo' }]
    }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    const byId = new Map(report.segments.map((s) => [s.id, s]))
    for (const id of ['s1', 's2', 's3']) {
      const detail = byId.get(id)
      expect(detail?.translation).toBeNull()
      expect(detail?.fittedSizePt).toBeUndefined()
      expect(detail?.lineCount).toBeUndefined()
    }

    expect(byId.get('s4')).toMatchObject({ translation: '[Hello]' })
  })

  it('report.segments.length === report.total always, including the zero-segment document case (empty array)', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])
    const backend = makeBackend(() => ({ translations: [{ id: 's1', translation: 'Bonjour' }] }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })
    expect(report.segments.length).toBe(report.total)

    const { file: emptyFile } = writeFixture([])
    const translateBatch = vi.fn()
    const emptyBackend: TranslationBackend = {
      listModels: vi.fn().mockResolvedValue([]),
      pullModel: vi.fn().mockResolvedValue(undefined),
      translateBatch
    }

    const emptyReport = await runPipeline({
      file: emptyFile,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend: emptyBackend
    })

    expect(emptyReport.total).toBe(0)
    expect(emptyReport.segments).toEqual([])
    expect(emptyReport.segments.length).toBe(emptyReport.total)
  })

  it('adding segments is purely additive: every pre-existing RunReport field keeps its previous shape and value, unchanged for printReport', async () => {
    const s1 = seg({ id: 's1', text: 'Hello', context: 'doc' })
    const { file } = writeFixture([s1])
    const backend = makeBackend(() => ({ translations: [{ id: 's1', translation: 'Bonjour' }] }))

    const report = await runPipeline({
      file,
      sourceLang: 'English',
      targetLang: 'French',
      model: 'test-model',
      adapter,
      backend
    })

    // segments is the ONLY new top-level key - nothing pre-existing was
    // renamed or removed alongside it.
    expect(Object.keys(report).sort()).toEqual(
      [
        'file',
        'outPath',
        'total',
        'translated',
        'keptOriginal',
        'overflowed',
        'skippedUnsupported',
        'durationMs',
        'stats',
        'segments'
      ].sort()
    )

    // The pre-existing fields printReport (cli.ts) actually reads keep
    // their exact previous values - the same values asserted for this
    // fixture/backend pair by the pre-segments tests above.
    expect(report.file).toBe(file)
    expect(report.total).toBe(1)
    expect(report.translated).toBe(1)
    expect(report.keptOriginal).toEqual([])
    expect(report.overflowed).toEqual([])
    expect(report.skippedUnsupported).toEqual([])
    expect(typeof report.durationMs).toBe('number')
    expect(report.stats.model).toBe('test-model')
  })
})
