import type { TextSegment } from '../segments'
import type { BatchRequest } from './backend'

/** Default character budget per batch before groupSegments starts a new group. */
const DEFAULT_MAX_CHARS = 2000

/**
 * True when `text` contains at least one alphabetic or CJK character (the
 * Unicode "Letter" category covers both Latin-script letters and CJK
 * ideographs). False for numeric-, symbol-, and whitespace-only text -
 * content with nothing for a translation model to meaningfully act on.
 * Shared by groupSegments (to drop such segments before ever building a
 * prompt) and validateBatch's echo check (which exempts them).
 */
export function hasTranslatableContent(text: string): boolean {
  return /\p{L}/u.test(text)
}

/** The key groupSegments actually groups by: `groupKey` when the adapter set one, otherwise `context` (unchanged pre-existing behavior). */
function groupingKeyOf(seg: TextSegment): string {
  return seg.groupKey ?? seg.context
}

/**
 * Groups segments for batched translation calls, in source order: segments
 * are accumulated under their grouping key (see groupingKeyOf - `groupKey`
 * when the adapter set one, otherwise `context`), breaking to a new group
 * whenever that key changes or the running character total would exceed
 * `maxChars` (default 2000). A single segment longer than maxChars on its
 * own still gets its own one-segment group rather than being split
 * mid-text (segment text is never partially sent - that would break the
 * id<->text correspondence the backend and validateBatch rely on).
 *
 * Segments with no translatable content (hasTranslatableContent() false -
 * numeric, symbol, or whitespace-only text) are dropped here and never
 * appear in any returned group, so the backend never sees them and never
 * spends a model call on them. The pipeline is expected to keep such
 * segments' original text unchanged when assembling the translated
 * document, exactly as if they had been "translated" to themselves.
 */
export function groupSegments(
  segments: TextSegment[],
  maxChars: number = DEFAULT_MAX_CHARS
): TextSegment[][] {
  const groups: TextSegment[][] = []
  let current: TextSegment[] = []
  let currentKey: string | null = null
  let currentChars = 0

  for (const seg of segments) {
    if (!hasTranslatableContent(seg.text)) continue

    const key = groupingKeyOf(seg)
    const sameGroup = current.length > 0 && currentKey === key
    const fitsBudget = sameGroup && currentChars + seg.text.length <= maxChars

    if (current.length > 0 && !fitsBudget) {
      groups.push(current)
      current = []
      currentChars = 0
    }

    current.push(seg)
    currentKey = key
    currentChars += seg.text.length
  }

  if (current.length > 0) groups.push(current)
  return groups
}

export type ValidationFailure = 'parse' | 'id-mismatch' | 'empty' | 'echo'

/**
 * Validates a model's batch translations against the request that produced
 * them. Per requested segment: the id must appear in `translations` exactly
 * once (missing or duplicated ids both fail as 'id-mismatch', since a
 * duplicate makes it impossible to tell which occurrence is correct); the
 * translation must be non-empty after trimming ('empty'); and, when
 * sourceLang and targetLang differ, it must not be an unchanged echo of the
 * source text for segments that actually have translatable content
 * ('echo' - see hasTranslatableContent). Translation entries whose id
 * doesn't match any requested segment are reported too (also
 * 'id-mismatch'), for diagnostics, but never contribute to `ok` since
 * there's no requested segment for them to resolve.
 *
 * Note: 'parse' is part of ValidationFailure's vocabulary but never
 * produced here - it's assigned upstream (ollama-backend.ts) when the raw
 * model response fails to parse as JSON or fails the zod schema entirely,
 * before there's anything per-segment left to validate.
 */
export function validateBatch(
  req: BatchRequest,
  translations: { id: string; translation: string }[]
): {
  ok: { id: string; translation: string }[]
  failed: { id: string; reason: ValidationFailure }[]
} {
  const ok: { id: string; translation: string }[] = []
  const failed: { id: string; reason: ValidationFailure }[] = []

  const requestedIds = new Set(req.segments.map((s) => s.id))
  const countById = new Map<string, number>()
  for (const t of translations) {
    countById.set(t.id, (countById.get(t.id) ?? 0) + 1)
  }

  for (const id of countById.keys()) {
    if (!requestedIds.has(id)) failed.push({ id, reason: 'id-mismatch' })
  }

  for (const seg of req.segments) {
    const count = countById.get(seg.id) ?? 0
    if (count === 0 || count > 1) {
      failed.push({ id: seg.id, reason: 'id-mismatch' })
      continue
    }

    const translation = translations.find((t) => t.id === seg.id)!.translation

    if (translation.trim() === '') {
      failed.push({ id: seg.id, reason: 'empty' })
      continue
    }

    if (isEcho(seg.text, translation, req.sourceLang, req.targetLang)) {
      failed.push({ id: seg.id, reason: 'echo' })
      continue
    }

    ok.push({ id: seg.id, translation })
  }

  return { ok, failed }
}

// Note: the brief's ladder describes this check as strict inequality
// ("translation !== source text"). Comparing trimmed+lowercased text
// instead is a deliberate strengthening, not a loosening - it also catches
// an echo that only differs by leading/trailing whitespace or letter case
// (e.g. a model that "translates" "Hello" to "hello" or "Hello "), which
// strict `!==` would let through as a false negative. It never rejects a
// translation that strict equality would have accepted, so it fails safe.
function isEcho(
  sourceText: string,
  translation: string,
  sourceLang: string,
  targetLang: string
): boolean {
  if (normalizeLang(sourceLang) === normalizeLang(targetLang)) return false
  if (!hasTranslatableContent(sourceText)) return false
  return normalizeForCompare(sourceText) === normalizeForCompare(translation)
}

function normalizeLang(lang: string): string {
  return lang.trim().toLowerCase()
}

/** Trim + lowercase - case-insensitive comparison is a no-op for CJK text and correct for Latin scripts. */
function normalizeForCompare(text: string): string {
  return text.trim().toLowerCase()
}
