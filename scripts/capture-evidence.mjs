// Evidence capture: runs the real translation(s) for a phase and stores ONLY
// the original input file(s) and the translated output file(s) under
// EVIDENCE/<phase>/, plus a minimal README recording when/how they were made.
// Regenerate any time with: node scripts/capture-evidence.mjs <phase>
import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const phase = process.argv[2] ?? 'phase-1'
// argv is developer-supplied, but clamp it anyway: it becomes a directory
// name, and nothing else from outside this file ever reaches a shell string
// (every command below is a hardcoded constant).
if (!/^[a-z0-9-]+$/.test(phase)) {
  throw new Error(`phase must be a kebab-case slug, got: ${phase}`)
}

// Per-phase evidence definition: the original document(s) and the live
// translation runs to perform on them. Extend per phase as adapters land
// (phase-2 adds a real .pptx original once the benchmark deck is in).
// Charlie's machine rule: dev/evidence runs stay SMALL (small fixture, small
// model) so a capture never saturates RAM/GPU. The full 50-segment fixture +
// larger models are benchmark-phase territory, run deliberately, not here.
const PHASES = {
  'phase-1': {
    original: 'fixtures/gate-5.fake.json',
    model: 'llama3.2:3b',
    runs: [
      { name: 'translated-en-zh.fake.json', source: 'English', target: 'Chinese (Simplified)' },
      { name: 'translated-zh-en.fake.json', source: 'Chinese (Simplified)', target: 'English' }
    ]
  }
}

const def = PHASES[phase]
if (!def) {
  throw new Error(`no evidence definition for ${phase}; add it to PHASES in this script`)
}

const outDir = path.join(root, 'EVIDENCE', phase)
mkdirSync(outDir, { recursive: true })
const commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()
const stamp = new Date().toISOString()

const originalName = `original-${path.basename(def.original)}`
copyFileSync(path.join(root, def.original), path.join(outDir, originalName))

const rows = []
for (const run of def.runs) {
  const outFile = path.join('EVIDENCE', phase, run.name)
  const cmd = `npx tsx src/core/cli.ts ${def.original} "${run.source}" "${run.target}" --model ${def.model} --out ${outFile}`
  process.stdout.write(`[evidence] ${cmd}\n`)
  execSync(`${cmd} 2>&1`, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], timeout: 900_000 })
  rows.push({ name: run.name, source: run.source, target: run.target })
}

writeFileSync(
  path.join(outDir, 'README.md'),
  [
    `# Evidence - ${phase}`,
    '',
    `Real translation artifacts, captured ${stamp} at commit \`${commit}\`.`,
    `Original document: [${originalName}](${originalName})`,
    '',
    ...rows.map((r) => `- [${r.name}](${r.name}) - ${r.source} -> ${r.target}, translated locally`),
    '',
    `Regenerate: \`node scripts/capture-evidence.mjs ${phase}\``,
    ''
  ].join('\n')
)
process.stdout.write(`[evidence] done -> ${outDir}\n`)
