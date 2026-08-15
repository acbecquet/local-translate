/**
 * Filesystem checkpoint store for benchmark runs. A benchmark run is a
 * matrix of (model x corpus item) cells; each completed cell - and each
 * completed judge score for a cell - is checkpointed here so a multi-hour
 * run can be killed and resumed instead of restarted from scratch. This is
 * the tinbox checkpoint pattern (translation knowledge base item 7): every
 * write lands on a `.tmp` sibling first and is renamed into place, so the
 * destination file is always either its previous complete contents or its
 * new complete contents - never a partial write, even if the process dies
 * mid-save. Every read tolerates a corrupt/truncated file by returning null
 * instead of throwing: a damaged checkpoint means "re-run this cell", never
 * "wedge the harness".
 *
 * `configHash` is the config-match half of the resume contract: it is a
 * pure function of a cell's (model, itemId, sourceLang, targetLang), so a
 * caller resuming a run can compare a freshly computed hash against
 * `StoredCell.configHash` and tell a still-valid checkpoint apart from one
 * whose inputs changed underneath it (a corpus edit, a language-pair swap).
 * Comparing hashes is the caller's job (harness.ts) - this module only
 * produces and stores them.
 *
 * Layout, all paths relative to the store's own `dir`:
 *   cells/<modelSlug>/<itemId>.json
 *   judgements/<judgeSlug>/<modelSlug>/<itemId>.json
 *   artifacts/<modelSlug>/<itemId><ext>
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { RunReport } from '../pipeline'

export interface CellConfig {
  model: string
  itemId: string
  sourceLang: string
  targetLang: string
}

export interface StoredCell {
  config: CellConfig
  configHash: string
  report: RunReport
  /** Store-relative path of the translated artifact copied under artifacts/. */
  artifactPath: string
  completedAt: string // ISO
}

export interface JudgeScore {
  segmentId: string
  accuracy: number // 1..5 integer
  fluency: number // 1..5 integer
  format: number // 1..5 integer
}

export interface StoredJudgement {
  judgeModel: string
  promptVersion: string
  /** configHash of the cell this judgement scored - a re-run cell invalidates it. */
  cellConfigHash: string
  scores: JudgeScore[]
  judgedAt: string
}

/** ':' and '/' -> '-', for filesystem paths - slugs never contain a path separator. */
export function modelSlug(model: string): string {
  return model.replace(/[:/]/g, '-')
}

/**
 * sha256 hex of `config`, serialized with its keys in sorted order via
 * JSON.stringify's array-replacer form - this makes the hash depend only on
 * the four field values, never on the insertion order the caller happened
 * to build the object literal in.
 */
export function configHash(config: CellConfig): string {
  const sortedKeys = Object.keys(config).sort()
  const stableJson = JSON.stringify(config, sortedKeys)
  return createHash('sha256').update(stableJson).digest('hex')
}

/**
 * Writes `data` as JSON to `dest` atomically: the write lands on a `.tmp`
 * sibling first, then a single fs rename puts it at `dest` - a reader can
 * only ever see `dest` as absent, its previous complete contents, or its
 * new complete contents, never a half-written file.
 */
function writeJsonAtomic(dest: string, data: unknown): void {
  const tmpPath = `${dest}.tmp`
  writeFileSync(tmpPath, JSON.stringify(data, null, 2))
  renameSync(tmpPath, dest)
}

/**
 * Reads and JSON-parses `filePath`, returning null instead of throwing for
 * both a missing file and a corrupt/truncated one - callers treat both
 * outcomes identically: there is no usable checkpoint, re-run the cell.
 */
function readJsonSafe<T>(filePath: string): T | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export class BenchStore {
  private readonly cellsDir: string
  private readonly judgementsDir: string

  constructor(dir: string) {
    this.cellsDir = path.join(dir, 'cells')
    this.judgementsDir = path.join(dir, 'judgements')
    mkdirSync(this.cellsDir, { recursive: true })
    mkdirSync(this.judgementsDir, { recursive: true })
    // artifactPathFor returns a store-relative path (no absolute-path field
    // needed for it) - the directory itself still needs to exist on demand
    // for harness.ts to copy translated artifacts into.
    mkdirSync(path.join(dir, 'artifacts'), { recursive: true })
  }

  private cellPath(model: string, itemId: string): string {
    return path.join(this.cellsDir, modelSlug(model), `${itemId}.json`)
  }

  private judgementPath(judgeModel: string, model: string, itemId: string): string {
    return path.join(this.judgementsDir, modelSlug(judgeModel), modelSlug(model), `${itemId}.json`)
  }

  loadCell(model: string, itemId: string): StoredCell | null {
    return readJsonSafe<StoredCell>(this.cellPath(model, itemId))
  }

  /** Atomic: writes to <path>.tmp then renames over the destination. */
  saveCell(cell: StoredCell): void {
    const dest = this.cellPath(cell.config.model, cell.config.itemId)
    mkdirSync(path.dirname(dest), { recursive: true })
    writeJsonAtomic(dest, cell)
  }

  loadJudgement(judgeModel: string, model: string, itemId: string): StoredJudgement | null {
    return readJsonSafe<StoredJudgement>(this.judgementPath(judgeModel, model, itemId))
  }

  saveJudgement(model: string, itemId: string, judgement: StoredJudgement): void {
    const dest = this.judgementPath(judgement.judgeModel, model, itemId)
    mkdirSync(path.dirname(dest), { recursive: true })
    writeJsonAtomic(dest, judgement)
  }

  listCells(): StoredCell[] {
    const cells: StoredCell[] = []
    let modelDirs: string[]
    try {
      modelDirs = readdirSync(this.cellsDir)
    } catch {
      return cells
    }

    for (const modelDir of modelDirs) {
      const modelPath = path.join(this.cellsDir, modelDir)
      if (!statSync(modelPath).isDirectory()) continue

      for (const file of readdirSync(modelPath)) {
        if (!file.endsWith('.json')) continue
        const cell = readJsonSafe<StoredCell>(path.join(modelPath, file))
        if (cell !== null) cells.push(cell)
      }
    }

    return cells
  }

  /** dir-relative artifact destination for a cell, extension preserved from srcPath. */
  artifactPathFor(model: string, itemId: string, srcPath: string): string {
    const ext = path.extname(srcPath)
    return path.join('artifacts', modelSlug(model), `${itemId}${ext}`)
  }
}
