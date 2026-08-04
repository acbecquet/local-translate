// CPU-canvas policy (2026-08-04 gate-crash diagnosis): every Canvas in this
// codebase must be constructed through fonts.ts's createCanvas, which forces
// gpu=false BEFORE first use. skia-canvas's GPU default (Vulkan) pulls the
// live GPU driver plus any third-party Vulkan overlay layers into this
// process - which is exactly what killed the phase-3 gate runs with a raw
// access violation the moment ollama's ROCm model load stormed the same
// discrete GPU (see createCanvas's own doc comment for the full evidence
// chain). The static sweep below is the enforcement arm: a raw
// `new Canvas(` anywhere in src/ outside fonts.ts fails this suite.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createCanvas } from '../../../src/core/fit/fonts'

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src')

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFilesUnder(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('createCanvas', () => {
  it('returns a CPU-rendered canvas that actually draws', () => {
    const canvas = createCanvas(20, 10)
    expect(canvas.gpu).toBe(false)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 20, 10)
    const px = ctx.getImageData(5, 5, 1, 1).data
    expect([px[0], px[1], px[2]]).toEqual([255, 0, 0])
  })
})

describe('CPU-canvas policy sweep', () => {
  it('no production module constructs a raw skia-canvas Canvas outside createCanvas', () => {
    const offenders = tsFilesUnder(SRC_DIR)
      .filter((file) => readFileSync(file, 'utf8').includes('new Canvas('))
      .map((file) => path.relative(SRC_DIR, file).replaceAll(path.sep, '/'))
    // fonts.ts is the sole sanctioned constructor; it appearing here also
    // proves the sweep itself is alive (an empty list would mean the scan
    // went blind, not that the codebase is clean).
    expect(offenders).toEqual(['core/fit/fonts.ts'])
  })
})
