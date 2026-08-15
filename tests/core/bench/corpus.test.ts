import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadCorpus, loadRoster } from '../../../src/core/bench/corpus'
import { PptxAdapter } from '../../../src/core/adapters/pptx/pptx-adapter'
import {
  DEFAULT_OUT_DIR,
  generate as generateBenchDecks
} from '../../../scripts/make-bench-decks.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const CORPUS_PATH = path.join(REPO_ROOT, 'fixtures', 'bench', 'corpus.json')
const ROSTER_PATH = path.join(REPO_ROOT, 'fixtures', 'bench', 'roster.json')

const tempDirs: string[] = []
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('loadCorpus - missing files (contract point 1)', () => {
  it('throws one error listing every missing file, including the regenerate command for items that set it', async () => {
    const root = await makeTempDir('bench-corpus-missing-')
    const manifestPath = path.join(root, 'corpus.json')
    await writeFile(
      manifestPath,
      JSON.stringify({
        items: [
          {
            id: 'missing-plain',
            file: 'fixtures/does-not-exist.pptx',
            sourceLang: 'English',
            targetLang: 'German',
            kind: 'pptx'
          },
          {
            id: 'missing-regenerable',
            file: 'fixtures/bench/decks/also-missing.pptx',
            sourceLang: 'English',
            targetLang: 'Chinese (Simplified)',
            kind: 'pptx',
            regenerate: 'npm run make-bench-decks'
          }
        ]
      })
    )

    let thrown: Error | null = null
    try {
      loadCorpus(manifestPath, root)
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown).not.toBeNull()
    const message = thrown!.message
    expect(message).toContain('missing-plain')
    expect(message).toContain('fixtures/does-not-exist.pptx')
    expect(message).toContain('missing-regenerable')
    expect(message).toContain('fixtures/bench/decks/also-missing.pptx')
    expect(message).toContain('npm run make-bench-decks')
  })

  it('resolves every file against repoRoot and does not throw when every file exists', async () => {
    const root = await makeTempDir('bench-corpus-present-')
    const relFile = 'fixtures/present.pptx'
    await mkdir(path.join(root, 'fixtures'), { recursive: true })
    await writeFile(path.join(root, relFile), 'not a real pptx, existence is all that matters')

    const manifestPath = path.join(root, 'corpus.json')
    await writeFile(
      manifestPath,
      JSON.stringify({
        items: [
          {
            id: 'present',
            file: relFile.replace(/\\/g, '/'),
            sourceLang: 'English',
            targetLang: 'German',
            kind: 'pptx'
          }
        ]
      })
    )

    const corpus = loadCorpus(manifestPath, root)
    expect(corpus.items).toHaveLength(1)
    expect(corpus.items[0].id).toBe('present')
  })
})

describe('loadCorpus - id and language validation (contract point 2)', () => {
  it('rejects duplicate ids', async () => {
    const root = await makeTempDir('bench-corpus-dupe-')
    const manifestPath = path.join(root, 'corpus.json')
    const item = {
      id: 'dupe-id',
      file: 'fixtures/whatever.pptx',
      sourceLang: 'English',
      targetLang: 'German',
      kind: 'pptx'
    }
    await writeFile(manifestPath, JSON.stringify({ items: [item, { ...item }] }))

    expect(() => loadCorpus(manifestPath, root)).toThrowError(/dupe-id/)
  })

  it('rejects a sourceLang not in LANGUAGES', async () => {
    const root = await makeTempDir('bench-corpus-badlang-src-')
    const manifestPath = path.join(root, 'corpus.json')
    await writeFile(
      manifestPath,
      JSON.stringify({
        items: [
          {
            id: 'bad-source',
            file: 'fixtures/whatever.pptx',
            sourceLang: 'Klingon',
            targetLang: 'German',
            kind: 'pptx'
          }
        ]
      })
    )

    expect(() => loadCorpus(manifestPath, root)).toThrowError(/Klingon/)
  })

  it('rejects a targetLang not in LANGUAGES', async () => {
    const root = await makeTempDir('bench-corpus-badlang-tgt-')
    const manifestPath = path.join(root, 'corpus.json')
    await writeFile(
      manifestPath,
      JSON.stringify({
        items: [
          {
            id: 'bad-target',
            file: 'fixtures/whatever.pptx',
            sourceLang: 'English',
            targetLang: 'Klingon',
            kind: 'pptx'
          }
        ]
      })
    )

    expect(() => loadCorpus(manifestPath, root)).toThrowError(/Klingon/)
  })
})

describe('loadRoster (contract point 3)', () => {
  it('rejects an empty models array', async () => {
    const root = await makeTempDir('bench-roster-empty-models-')
    const rosterPath = path.join(root, 'roster.json')
    await writeFile(rosterPath, JSON.stringify({ models: [], judge: 'some-judge' }))

    expect(() => loadRoster(rosterPath)).toThrowError(/models/)
  })

  it('rejects a missing judge', async () => {
    const root = await makeTempDir('bench-roster-missing-judge-')
    const rosterPath = path.join(root, 'roster.json')
    await writeFile(rosterPath, JSON.stringify({ models: ['some-model'] }))

    expect(() => loadRoster(rosterPath)).toThrowError(/judge/)
  })

  it('rejects an empty-string judge', async () => {
    const root = await makeTempDir('bench-roster-empty-judge-')
    const rosterPath = path.join(root, 'roster.json')
    await writeFile(rosterPath, JSON.stringify({ models: ['some-model'], judge: '   ' }))

    expect(() => loadRoster(rosterPath)).toThrowError(/judge/)
  })
})

describe('make-bench-decks generator (contract point 4)', () => {
  it('writes three structurally valid decks into a temp out-dir, each yielding more than zero extracted segments', async () => {
    const outDir = await makeTempDir('bench-decks-')
    await generateBenchDecks(outDir)

    const adapter = new PptxAdapter({ regionEngine: null, sourceLang: 'English' })
    for (const name of ['german-compounds.pptx', 'cjk-table.pptx', 'tiny-boxes.pptx']) {
      const segments = await adapter.extract(path.join(outDir, name))
      expect(segments.length).toBeGreaterThan(0)
    }
  }, 30_000)
})

describe('committed manifests parse through their own loaders (contract point 5)', () => {
  beforeAll(async () => {
    // fixtures/bench/corpus.json references the three generated decks at
    // their default (non-temp) location - regenerate them there so this
    // suite is self-sufficient on a clean checkout (fixtures/bench/decks/
    // is gitignored) rather than depending on a manual `npm run
    // make-bench-decks` having been run first.
    await generateBenchDecks(DEFAULT_OUT_DIR)
  }, 30_000)

  it('fixtures/bench/corpus.json parses through loadCorpus with no error', () => {
    const corpus = loadCorpus(CORPUS_PATH, REPO_ROOT)
    expect(corpus.items.map((i) => i.id)).toEqual([
      'real-deck-en-zh',
      'real-deck-zh-en',
      'german-compounds-en-de',
      'cjk-table-en-zh',
      'tiny-boxes-en-zh',
      'chart-image-en-zh',
      'photo-image-en-zh'
    ])
  })

  it('fixtures/bench/roster.json parses through loadRoster with no error', () => {
    const roster = loadRoster(ROSTER_PATH)
    expect(roster.models).toEqual([
      'gemma4:e2b',
      'gemma4:e4b',
      'gemma4:12b',
      'qwen3.5:4b',
      'qwen3.5:9b',
      'qwen3:30b'
    ])
    expect(roster.judge).toBe('qwen3.6:35b')
  })
})
