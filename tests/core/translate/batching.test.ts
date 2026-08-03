import { describe, expect, it } from 'vitest'
import {
  groupSegments,
  hasTranslatableContent,
  validateBatch,
  type ValidationFailure
} from '../../../src/core/translate/batching'
import type { BatchRequest } from '../../../src/core/translate/backend'
import type { TextSegment } from '../../../src/core/segments'

function seg(overrides: Partial<TextSegment> & { id: string; text: string }): TextSegment {
  return {
    box: { wPt: 100, hPt: 20 },
    font: { family: 'Noto Sans', sizePt: 12 },
    context: 'doc',
    kind: 'fake',
    ...overrides
  }
}

function req(overrides: Partial<BatchRequest> = {}): BatchRequest {
  return {
    model: 'llama3.1',
    sourceLang: 'en',
    targetLang: 'fr',
    groupContext: 'doc',
    segments: [{ id: 's1', text: 'Hello' }],
    ...overrides
  }
}

describe('hasTranslatableContent', () => {
  it('is true for alphabetic text', () => {
    expect(hasTranslatableContent('Hello world')).toBe(true)
  })

  it('is true for CJK text', () => {
    expect(hasTranslatableContent('你好世界')).toBe(true)
  })

  it('is false for numeric-only text', () => {
    expect(hasTranslatableContent('12345')).toBe(false)
  })

  it('is false for symbol-only text', () => {
    expect(hasTranslatableContent('***%%%--')).toBe(false)
  })

  it('is false for whitespace-only text', () => {
    expect(hasTranslatableContent('   \n\t ')).toBe(false)
  })

  it('is true for mixed alphanumeric text', () => {
    expect(hasTranslatableContent('Invoice #12345')).toBe(true)
  })
})

describe('groupSegments', () => {
  it('groups consecutive segments sharing a context into one group when under maxChars', () => {
    const segments = [
      seg({ id: 's1', text: 'Hello', context: 'slide1' }),
      seg({ id: 's2', text: 'World', context: 'slide1' })
    ]
    expect(groupSegments(segments)).toEqual([segments])
  })

  it('starts a new group when the context changes, even under maxChars', () => {
    const a = seg({ id: 's1', text: 'Hello', context: 'slide1' })
    const b = seg({ id: 's2', text: 'World', context: 'slide2' })
    expect(groupSegments([a, b])).toEqual([[a], [b]])
  })

  it('splits within the same context once the running total would exceed maxChars', () => {
    // 5 chars each; a maxChars of 11 fits two segments (10) but not three (15).
    const a = seg({ id: 's1', text: 'abcde', context: 'slide1' })
    const b = seg({ id: 's2', text: 'fghij', context: 'slide1' })
    const c = seg({ id: 's3', text: 'klmno', context: 'slide1' })
    expect(groupSegments([a, b, c], 11)).toEqual([[a, b], [c]])
  })

  it('gives an oversized single segment its own group rather than splitting its text', () => {
    const huge = seg({ id: 's1', text: 'a'.repeat(50), context: 'slide1' })
    const next = seg({ id: 's2', text: 'b'.repeat(50), context: 'slide1' })
    expect(groupSegments([huge, next], 10)).toEqual([[huge], [next]])
  })

  it('drops segments with no translatable content and never sends them to the model', () => {
    const real = seg({ id: 's1', text: 'Hello', context: 'slide1' })
    const numeric = seg({ id: 's2', text: '42', context: 'slide1' })
    const blank = seg({ id: 's3', text: '   ', context: 'slide1' })
    expect(groupSegments([real, numeric, blank])).toEqual([[real]])
  })

  it('returns an empty array when every segment lacks translatable content', () => {
    const numeric = seg({ id: 's1', text: '42', context: 'slide1' })
    const symbols = seg({ id: 's2', text: '---', context: 'slide1' })
    expect(groupSegments([numeric, symbols])).toEqual([])
  })

  it('defaults maxChars to 2000', () => {
    const a = seg({ id: 's1', text: 'x'.repeat(1000), context: 'slide1' })
    const b = seg({ id: 's2', text: 'y'.repeat(1000), context: 'slide1' })
    const c = seg({ id: 's3', text: 'z'.repeat(1000), context: 'slide1' })
    expect(groupSegments([a, b, c])).toEqual([[a, b], [c]])
  })

  it('groups by groupKey (exact match) instead of context when an adapter sets it, even across different context strings', () => {
    const title = seg({ id: 's1', text: 'Hello', context: 'slide title', groupKey: 'slide-3' })
    const body = seg({ id: 's2', text: 'World', context: 'body paragraph', groupKey: 'slide-3' })
    expect(groupSegments([title, body])).toEqual([[title, body]])
  })

  it('still breaks into a new group when groupKey changes, even if context stays the same', () => {
    const a = seg({ id: 's1', text: 'Hello', context: 'slide title', groupKey: 'slide-3' })
    const b = seg({ id: 's2', text: 'World', context: 'slide title', groupKey: 'slide-4' })
    expect(groupSegments([a, b])).toEqual([[a], [b]])
  })

  it('falls back to grouping by context, unchanged, when groupKey is absent', () => {
    const a = seg({ id: 's1', text: 'Hello', context: 'slide1' })
    const b = seg({ id: 's2', text: 'World', context: 'slide1' })
    const c = seg({ id: 's3', text: 'Again', context: 'slide2' })
    expect(groupSegments([a, b, c])).toEqual([[a, b], [c]])
  })
})

describe('validateBatch', () => {
  it('happy path: every segment translated, non-empty, not an echo', () => {
    const request = req({
      segments: [
        { id: 's1', text: 'Hello' },
        { id: 's2', text: 'World' }
      ]
    })
    const result = validateBatch(request, [
      { id: 's1', translation: 'Bonjour' },
      { id: 's2', translation: 'Monde' }
    ])
    expect(result.ok).toEqual([
      { id: 's1', translation: 'Bonjour' },
      { id: 's2', translation: 'Monde' }
    ])
    expect(result.failed).toEqual([])
  })

  it('flags a missing id as id-mismatch', () => {
    const request = req({
      segments: [
        { id: 's1', text: 'Hello' },
        { id: 's2', text: 'World' }
      ]
    })
    const result = validateBatch(request, [{ id: 's1', translation: 'Bonjour' }])
    expect(result.ok).toEqual([{ id: 's1', translation: 'Bonjour' }])
    expect(result.failed).toEqual([{ id: 's2', reason: 'id-mismatch' satisfies ValidationFailure }])
  })

  it('flags a duplicated id as id-mismatch and excludes it from ok', () => {
    const request = req({ segments: [{ id: 's1', text: 'Hello' }] })
    const result = validateBatch(request, [
      { id: 's1', translation: 'Bonjour' },
      { id: 's1', translation: 'Salut' }
    ])
    expect(result.ok).toEqual([])
    expect(result.failed).toEqual([{ id: 's1', reason: 'id-mismatch' }])
  })

  it('flags an unknown id (not part of the request) as id-mismatch, without affecting other segments', () => {
    const request = req({ segments: [{ id: 's1', text: 'Hello' }] })
    const result = validateBatch(request, [
      { id: 's1', translation: 'Bonjour' },
      { id: 'ghost', translation: 'huh?' }
    ])
    expect(result.ok).toEqual([{ id: 's1', translation: 'Bonjour' }])
    expect(result.failed).toEqual([{ id: 'ghost', reason: 'id-mismatch' }])
  })

  it('flags an empty (or whitespace-only) translation as empty', () => {
    const request = req({ segments: [{ id: 's1', text: 'Hello' }] })
    const result = validateBatch(request, [{ id: 's1', translation: '   ' }])
    expect(result.failed).toEqual([{ id: 's1', reason: 'empty' }])
  })

  it('flags an unchanged alphabetic translation as echo when languages differ', () => {
    const request = req({
      sourceLang: 'en',
      targetLang: 'fr',
      segments: [{ id: 's1', text: 'Hello' }]
    })
    const result = validateBatch(request, [{ id: 's1', translation: 'hello' }]) // case-insensitive match
    expect(result.failed).toEqual([{ id: 's1', reason: 'echo' }])
  })

  it('exempts numeric-only segments from the echo check', () => {
    const request = req({
      sourceLang: 'en',
      targetLang: 'fr',
      segments: [{ id: 's1', text: '12345' }]
    })
    const result = validateBatch(request, [{ id: 's1', translation: '12345' }])
    expect(result.ok).toEqual([{ id: 's1', translation: '12345' }])
    expect(result.failed).toEqual([])
  })

  it('exempts symbol-only segments from the echo check', () => {
    const request = req({
      sourceLang: 'en',
      targetLang: 'fr',
      segments: [{ id: 's1', text: '---***' }]
    })
    const result = validateBatch(request, [{ id: 's1', translation: '---***' }])
    expect(result.ok).toEqual([{ id: 's1', translation: '---***' }])
  })

  it('does not flag echo when source and target languages are the same', () => {
    const request = req({
      sourceLang: 'en',
      targetLang: 'en',
      segments: [{ id: 's1', text: 'Hello' }]
    })
    const result = validateBatch(request, [{ id: 's1', translation: 'Hello' }])
    expect(result.ok).toEqual([{ id: 's1', translation: 'Hello' }])
    expect(result.failed).toEqual([])
  })

  it('does not flag a genuinely different translation as echo', () => {
    const request = req({
      sourceLang: 'en',
      targetLang: 'fr',
      segments: [{ id: 's1', text: 'Hello' }]
    })
    const result = validateBatch(request, [{ id: 's1', translation: 'Bonjour' }])
    expect(result.ok).toEqual([{ id: 's1', translation: 'Bonjour' }])
  })

  // Polish-round Task D verification: a terse mixed alphanumeric label
  // (from the live EN->ZH gate run, "1-22 Batch User-5 ROSIN" on slide 3)
  // where only the translatable words changed and the code/brand tokens
  // were correctly kept as-is must NOT be flagged as echo - the strings
  // differ, so isEcho's normalize-then-compare already passes this case.
  // This test exists to confirm that (not to change echo detection, which
  // is out of scope for this task).
  it('does not flag a translation that differs from source only by keeping code/brand tokens unchanged', () => {
    const request = req({
      sourceLang: 'en',
      targetLang: 'zh',
      segments: [{ id: 's1', text: '1-22 Batch User-5 ROSIN' }]
    })
    const result = validateBatch(request, [{ id: 's1', translation: '1-22批 用户5 ROSIN' }])
    expect(result.ok).toEqual([{ id: 's1', translation: '1-22批 用户5 ROSIN' }])
    expect(result.failed).toEqual([])
  })
})
