/**
 * Loads and validates the two benchmark manifests committed under
 * fixtures/bench/: corpus.json (the fixed set of documents/language pairs
 * the benchmark harness runs against) and roster.json (the models compared
 * plus the judge model that scores them).
 *
 * Both loaders fail loud and complete: every problem found is reported in
 * ONE thrown error (every missing file, every duplicate id, every invalid
 * language) rather than stopping at the first issue - a benchmark run that
 * silently limps forward on a partially-broken manifest would produce
 * misleading results, and fixing manifest errors one at a time across
 * repeated runs wastes exactly the kind of long-lived model-inference time
 * this harness exists to spend wisely.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { LANGUAGES, type Language } from '../../shared/languages'

export interface CorpusItem {
  /** Stable slug, e.g. 'real-deck-en-zh'. */
  id: string
  /** Repo-root-relative path. */
  file: string
  sourceLang: Language
  targetLang: Language
  kind: 'pptx' | 'image'
  /** Set on generated files: the command that recreates them, used in the missing-file error. */
  regenerate?: string
}

export interface Corpus {
  items: CorpusItem[]
}

export interface Roster {
  models: string[]
  judge: string
}

const LANGUAGE_SET = new Set<string>(LANGUAGES)

function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && LANGUAGE_SET.has(value)
}

/** Minimal shape check - JSON.parse already guarantees valid JSON; this only guards the top-level "items" array before per-item validation runs. */
function readItemsArray(manifestPath: string): CorpusItem[] {
  const raw = readFileSync(manifestPath, 'utf8')
  const parsed = JSON.parse(raw) as { items?: unknown }
  if (!Array.isArray(parsed.items)) {
    throw new Error(`bench corpus manifest "${manifestPath}" must have an "items" array`)
  }
  return parsed.items as CorpusItem[]
}

export function loadCorpus(manifestPath: string, repoRoot: string): Corpus {
  const items = readItemsArray(manifestPath)

  // Every category below is collected into ONE flat problems array and
  // thrown as ONE error at the end - never an early throw per category.
  // A manifest with, say, a duplicate id AND an unrelated missing file
  // must report both in the same run; throwing as soon as the first
  // category has a hit would only ever surface one problem per run,
  // turning a single fix into a fix-one-rerun cycle across however many
  // categories are actually broken - exactly what this loader's module
  // doc promises never to do.
  const problems: string[] = []

  const idCounts = new Map<string, number>()
  for (const item of items) {
    idCounts.set(item.id, (idCounts.get(item.id) ?? 0) + 1)
  }
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id)
  if (duplicateIds.length > 0) {
    problems.push(`duplicate ids: ${duplicateIds.join(', ')}`)
  }

  for (const item of items) {
    if (!isLanguage(item.sourceLang)) {
      problems.push(`${item.id}: sourceLang "${String(item.sourceLang)}" is not in LANGUAGES`)
    }
    if (!isLanguage(item.targetLang)) {
      problems.push(`${item.id}: targetLang "${String(item.targetLang)}" is not in LANGUAGES`)
    }
  }

  for (const item of items) {
    const absPath = path.resolve(repoRoot, item.file)
    if (!existsSync(absPath)) {
      const regenerateNote = item.regenerate ? ` (regenerate with: ${item.regenerate})` : ''
      problems.push(`${item.id}: missing file ${item.file} (resolved: ${absPath})${regenerateNote}`)
    }
  }

  if (problems.length > 0) {
    throw new Error(`bench corpus manifest "${manifestPath}" has problems:\n${problems.join('\n')}`)
  }

  return { items }
}

export function loadRoster(rosterPath: string): Roster {
  const raw = readFileSync(rosterPath, 'utf8')
  const parsed = JSON.parse(raw) as Partial<Roster>

  if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error(`bench roster manifest "${rosterPath}" must have a non-empty "models" array`)
  }
  if (typeof parsed.judge !== 'string' || parsed.judge.trim().length === 0) {
    throw new Error(`bench roster manifest "${rosterPath}" must have a non-empty "judge" string`)
  }

  return { models: parsed.models, judge: parsed.judge }
}
