// Evidence capture: runs the real translation(s) for a phase and stores ONLY
// the original input file(s) and the translated output file(s) under
// EVIDENCE/<phase>/, plus a minimal README recording when/how they were made.
// Regenerate any time with: node scripts/capture-evidence.mjs <phase>
import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  },
  // Phase 2 gate: Charlie's real mixed-language benchmark deck, both target
  // languages, champion model. This is a deliberate GPU run (Charlie-run per
  // machine rules): expect several minutes per direction.
  'phase-2': {
    original: 'fixtures/real/CCELL 3.0 AIO Lab Test Updates Mandarin.pptx',
    model: 'gemma4:e4b',
    runs: [
      { name: 'CCELL-3.0-AIO-english.pptx', source: 'Chinese (Simplified)', target: 'English' },
      { name: 'CCELL-3.0-AIO-mandarin.pptx', source: 'English', target: 'Chinese (Simplified)' }
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

// --report-only rebuilds the README (incl. fit tables) from artifacts already
// on disk, without re-running any translations (no model, no GPU).
const reportOnly = process.argv.includes('--report-only')

const rows = []
for (const run of def.runs) {
  const outFile = path.join('EVIDENCE', phase, run.name)
  if (!reportOnly) {
    const cmd = `npx tsx src/core/cli.ts "${def.original}" "${run.source}" "${run.target}" --model ${def.model} --out "${outFile}"`
    process.stdout.write(`[evidence] ${cmd}\n`)
    execSync(`${cmd} 2>&1`, {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 900_000
    })
  }
  rows.push({ name: run.name, source: run.source, target: run.target })
}

// Fit-proof table: shows per segment that the translated text fits its box
// (fitted size, wrapped line count, share of box height used). Width fitting
// was verified with real glyph measurement inside the fit engine at run time;
// height math here is recomputed from the artifact itself (lineH = 1.2 x pt).
function fitTable(fileName) {
  const data = JSON.parse(readFileSync(path.join(outDir, fileName), 'utf8'))
  const lines = [
    '| id | box (pt) | font pt orig -> fitted | lines | box height used |',
    '|---|---|---|---|---|'
  ]
  for (const s of data.segments) {
    const usedH = (s.fittedLines?.length ?? 0) * s.fittedSizePt * 1.2
    const pct = s.box?.hPt ? Math.round((usedH / s.box.hPt) * 100) : 0
    lines.push(
      `| ${s.id} | ${s.box.wPt}x${s.box.hPt} | ${s.font.sizePt} -> ${s.fittedSizePt} | ` +
        `${s.fittedLines?.length ?? 0} | ${pct}% |`
    )
  }
  return lines
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
    // Fit tables introspect the .fake.json artifact shape; pptx evidence is
    // judged by opening the decks side by side (that IS the artifact).
    ...rows
      .filter((r) => r.name.endsWith('.fake.json'))
      .flatMap((r) => [`## Fit proof: ${r.name}`, '', ...fitTable(r.name), '']),
    `Regenerate: \`node scripts/capture-evidence.mjs ${phase}\` (or \`--report-only\` to rebuild this README without re-translating).`,
    ''
  ].join('\n')
)
process.stdout.write(`[evidence] done -> ${outDir}\n`)
