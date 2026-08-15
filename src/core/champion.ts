// Resolves the app's default translation model from config/champion.json -
// the phase-4 benchmark harness's crowning mechanism (`bench crown`, Task 9)
// writes the winning model here once a cohort run recommends one, so the
// CLI and the Electron app pick up a new default without a code change.
// DEFAULT_MODEL (defaults.ts) stays the ultimate fallback for a missing or
// malformed config - see resolveDefaultModel below - so a corrupt or absent
// champion.json can never make the app unusable, only fall back to the
// pre-benchmark hardcoded default.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findAppRoot } from './app-root'
import { DEFAULT_MODEL } from './defaults'

export interface ChampionState {
  model: string
  crownedAt: string // ISO
  note?: string // e.g. 'phase-4 launch cohort, report 2026-08-xx'
}

const CHAMPION_FILENAME = 'champion.json'

/**
 * Resolves the directory holding config/champion.json, preferring the
 * packaged app's extraResources config folder over the dev-mode
 * findAppRoot() walk - identical precedence to fonts.ts's resolveFontsDir
 * (see that function's doc comment for the full rationale this mirrors):
 *
 * 1. `<resourcesPath>/config` - electron-builder.yml ships repo-root
 *    config/** to `resources/config` via extraResources, landing as a
 *    SIBLING of the packaged app root (app.asar or its unpacked
 *    equivalent), not a child of it - findAppRoot's package.json walk stops
 *    one level too deep to ever see it, so it's tried explicitly. Only
 *    trusted when it actually exists on disk, so electron-vite dev (where
 *    resourcesPath points at Electron's own bundled resources, with no
 *    config/ of ours) and every non-Electron run correctly fall through to
 *    (2).
 * 2. `findAppRoot(moduleDir)/config` - the repo-root config/ directory,
 *    correct for dev, the CLI (always run from source via tsx), and tests.
 *
 * `exists` is injected (default fs.existsSync) so this is testable against
 * a faked resources layout without touching the real filesystem layout -
 * see tests/core/champion.test.ts.
 */
function resolveConfigDir(
  moduleDir: string,
  resourcesPath: string | undefined,
  exists: (p: string) => boolean = existsSync
): string {
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'config')
    if (exists(packaged)) return packaged
  }
  return path.join(findAppRoot(moduleDir), 'config')
}

const CONFIG_DIR = resolveConfigDir(
  path.dirname(fileURLToPath(import.meta.url)),
  // Cast, not the ambient electron.d.ts type: see fonts.ts's identical cast
  // for the full rationale (that augmentation only reaches a file while
  // something in the same TS program imports 'electron', and it also
  // declares resourcesPath always-present when it's genuinely undefined
  // outside Electron) - keeps src/core's typecheck self-sufficient.
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
)

// Test-only escape hatch: points readChampion()/resolveDefaultModel() at a
// fake config directory instead of the real resolved CONFIG_DIR above, so
// tests can exercise every branch of the zero-arg public API (a champion
// file that wins over DEFAULT_MODEL, a missing file, a malformed one)
// without ever touching the repo's own committed config/champion.json.
// Mutating that real file in place would risk cross-test-file races:
// Vitest runs test files in parallel by default and this repo's
// vitest.config.ts doesn't disable that, so a shared real file being
// rewritten by one test file while another reads it would be flaky. null
// (the default) means "use the real CONFIG_DIR". See
// _internals.setConfigDirForTesting.
let configDirOverride: string | null = null

/**
 * True for a usable model string: non-empty after trimming. Anything else
 * (missing, not a string, empty/whitespace-only) is what makes a champion
 * entry malformed per the `model` field.
 */
function isValidModel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Parses and validates raw champion.json text into a ChampionState, or null
 * for anything that doesn't qualify: unparseable JSON, a non-object value,
 * or a `model` field that's missing, empty, or not a string. `crownedAt`/
 * `note` are passed through as-is - the only documented malformation
 * criterion is the `model` field (resolveDefaultModel only ever reads
 * `.model` off the result; `crownedAt`/`note` are informational, written by
 * writeChampion, never load-bearing here).
 */
function parseChampion(raw: string): ChampionState | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const candidate = data as Partial<ChampionState>
  if (!isValidModel(candidate.model)) return null
  return candidate as ChampionState
}

/**
 * Reads and validates champion.json from `configDir`, returning null for a
 * missing file (silent - the normal pre-crowning state, see the initial
 * committed config/champion.json) or a malformed one (JSON parse failure,
 * or a missing/empty/non-string `model` field - warns exactly once, via
 * console.warn, so a corrupt file is visible without ever throwing: a
 * damaged config must not make the whole app unusable, only fall back to
 * DEFAULT_MODEL).
 */
function readChampionFrom(configDir: string): ChampionState | null {
  const filePath = path.join(configDir, CHAMPION_FILENAME)
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  const parsed = parseChampion(raw)
  if (parsed === null) {
    console.warn(
      `champion.ts: ${filePath} is malformed (invalid JSON, or a missing/empty/non-string ` +
        `"model" field) - falling back to DEFAULT_MODEL`
    )
  }
  return parsed
}

/**
 * config/champion.json resolved like fonts.ts resolves fonts/: packaged
 * resources path first, then the findAppRoot walk (see resolveConfigDir
 * above). Null on a missing or malformed file - see readChampionFrom for
 * the exact malformed criteria and its one-warning-per-call contract.
 */
export function readChampion(): ChampionState | null {
  return readChampionFrom(configDirOverride ?? CONFIG_DIR)
}

/**
 * The app's effective default translation model: the crowned champion's
 * model when config/champion.json is present and well-formed, else
 * DEFAULT_MODEL. This is the one function cli.ts and translate-service.ts
 * call to pick their own default - see defaults.ts's doc comment.
 */
export function resolveDefaultModel(): string {
  return readChampion()?.model ?? DEFAULT_MODEL
}

/**
 * Writes `state` to <repoRoot>/config/champion.json atomically: a `.tmp`
 * sibling is written first, then a single fs rename puts it at the
 * destination, so a reader can only ever see the previous complete
 * contents or the new complete contents, never a partial write - the same
 * tinbox checkpoint pattern as src/core/bench/store.ts's writeJsonAtomic
 * and src/core/translate/ollama/ollama-backend.ts's writeCapsFileAtomic.
 * Used by the bench CLI's `crown` subcommand (Task 9) after a benchmark
 * cohort run recommends a champion. `repoRoot` is explicit (not resolved
 * via CONFIG_DIR) because crowning always targets the real repo-root
 * config/ directory the app itself will later read via findAppRoot, never
 * a packaged resourcesPath - crowning is a dev-time operation, never
 * something a packaged install does to itself.
 */
export function writeChampion(state: ChampionState, repoRoot: string): void {
  const dest = path.join(repoRoot, 'config', CHAMPION_FILENAME)
  mkdirSync(path.dirname(dest), { recursive: true })
  const tmpPath = `${dest}.tmp`
  writeFileSync(tmpPath, JSON.stringify(state, null, 2))
  renameSync(tmpPath, dest)
}

export const _internals = {
  resolveConfigDir,
  readChampionFrom,
  /** Test-only: see configDirOverride above. Pass null to restore real resolution. */
  setConfigDirForTesting(dir: string | null): void {
    configDirOverride = dir
  }
}
