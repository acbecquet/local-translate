import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_MODEL } from '../../src/core/defaults'
import { _internals as cliInternals } from '../../src/core/cli'
import { DEFAULT_MODEL as serviceDefaultModel } from '../../src/main/translate-service'

const SRC_ROOT = path.resolve(__dirname, '../../src')
const DEFAULTS_FILE = path.resolve(SRC_ROOT, 'core/defaults.ts')

/** Every .ts/.tsx file under src/, recursively - deliberately independent of any build step (grep the source tree itself, not a compiled out/ tree). */
function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listSourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

describe('DEFAULT_MODEL', () => {
  it('the literal default-model string appears in exactly one src/ module: defaults.ts', () => {
    const files = listSourceFiles(SRC_ROOT)
    const hits = files.filter((f) => {
      if (path.resolve(f) === DEFAULTS_FILE) return false
      return readFileSync(f, 'utf8').includes(DEFAULT_MODEL)
    })
    expect(hits).toEqual([])
  })

  it('cli.ts resolves DEFAULT_MODEL to the same const exported by defaults.ts', () => {
    expect(cliInternals.DEFAULT_MODEL).toBe(DEFAULT_MODEL)
  })

  it('translate-service.ts resolves DEFAULT_MODEL to the same const exported by defaults.ts', () => {
    expect(serviceDefaultModel).toBe(DEFAULT_MODEL)
  })
})
