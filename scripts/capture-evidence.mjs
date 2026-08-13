// Evidence capture: runs the real translation(s) for a phase and stores ONLY
// the original input file(s) and the translated output file(s) under
// EVIDENCE/<phase>/, plus a minimal README recording when/how they were made.
// Regenerate any time with: node scripts/capture-evidence.mjs <phase>
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const phase = process.argv[2] ?? 'phase-1'
// argv is developer-supplied, but clamp it anyway: it becomes a directory
// name, and nothing else from outside this file ever reaches a shell string
// (every command below - including per-run `original` paths - is a
// hardcoded constant from the PHASES table in this file; execSync stays
// safe ONLY as long as that invariant holds).
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
  },
  // Phase 3 gate: the same real deck re-run with the region engine live, so
  // embedded images translate in place - plus standalone image runs: one
  // synthetic CJK fixture (regenerate first if missing:
  // `npm run make-image-fixtures`), one real chart crop with English text,
  // and one textless glossy photo whose evidence value is precisely that the
  // output contains NO hallucinated paint. Deck runs are GPU (Charlie-run);
  // the image runs are OCR-on-CPU plus a few short model calls.
  'phase-3': {
    original: 'fixtures/real/CCELL 3.0 AIO Lab Test Updates Mandarin.pptx',
    model: 'gemma4:e4b',
    runs: [
      { name: 'CCELL-3.0-AIO-english.pptx', source: 'Chinese (Simplified)', target: 'English' },
      { name: 'CCELL-3.0-AIO-mandarin.pptx', source: 'English', target: 'Chinese (Simplified)' },
      {
        name: 'img04-english.png',
        original: 'fixtures/image-regions/img04.png',
        source: 'Chinese (Simplified)',
        target: 'English'
      },
      {
        name: 'real-chart-mandarin.png',
        original: 'fixtures/image-regions/real/real-chart-en.png',
        source: 'English',
        target: 'Chinese (Simplified)'
      },
      {
        name: 'real-photo-mandarin.jpg',
        original: 'fixtures/image-regions/real/real-photo-1.jpg',
        source: 'English',
        target: 'Chinese (Simplified)'
      }
    ]
  }
}

const def = PHASES[phase]
if (!def) {
  throw new Error(`no evidence definition for ${phase}; add it to PHASES in this script`)
}

// --report-only rebuilds the README (incl. fit tables) from artifacts already
// on disk, without re-running any translations (no model, no GPU).
const reportOnly = process.argv.includes('--report-only')

// Commit-headroom preflight (Windows): a live run charges system commit from
// two sides at once - the CLI's node process (OCR sessions, image buffers,
// extract working set) plus ollama's model load (ROCm host allocations).
// Exhausting commit mid-load dies as a raw access violation AND deepens the
// damage. Refusing up front with a clear message is the machine rule ("never
// overcommit, never crash-retry") in code.
//
// Headroom = STATIC free commit (limit - committed) PLUS the pagefile's
// EXPANDABLE room (configured maximum minus current size, bounded by free
// disk on its volume). The static number alone systematically undercounts
// on this box: the pagefile floor is 1.5 GB against a 48 GB configured max,
// so the advertised limit sits ~1.5 GB above RAM while any ordinary desktop
// day charges most of it - yet Windows demonstrably (measured 2026-08-12: an
// 18 GB untouched commit granted in seconds, auto-trimmed after release)
// expands the file on demand well past the static limit. A truly exhausted
// machine fails BOTH terms: commit charged high AND no expandable room left.
const MIN_COMMIT_HEADROOM_GB = 12
function commitHeadroomGb() {
  if (process.platform !== 'win32') return Infinity
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$os = Get-CimInstance Win32_OperatingSystem; ' +
          '$free = [double]$os.FreeVirtualMemory; ' +
          '$exp = 0.0; ' +
          'foreach ($u in @(Get-CimInstance Win32_PageFileUsage)) { ' +
          '$s = @(Get-CimInstance Win32_PageFileSetting) | Where-Object { $_.Name -ieq $u.Name } | Select-Object -First 1; ' +
          'if ($s -and $s.MaximumSize -gt 0) { ' +
          '$roomMb = [math]::Max(0, $s.MaximumSize - $u.AllocatedBaseSize); ' +
          '$qual = Split-Path $u.Name -Qualifier; ' +
          "$freeDiskMb = ((Get-PSDrive ($qual.TrimEnd(':'))).Free / 1MB) - 10240; " +
          '$exp += [math]::Max(0, [math]::Min($roomMb, $freeDiskMb)) } }; ' +
          'Write-Output ("{0} {1}" -f $free, [math]::Floor($exp))'
      ],
      { timeout: 30_000 }
    )
      .toString()
      .trim()
    const [freeKb, expandableMb] = out.split(/\s+/).map(Number)
    // Unparseable output must not block a run - this guard only ever refuses
    // on a POSITIVE reading of exhaustion, never on a failed measurement.
    if (!Number.isFinite(freeKb) || freeKb <= 0) return Infinity
    const staticGb = (freeKb * 1024) / 1024 ** 3
    const expandableGb =
      Number.isFinite(expandableMb) && expandableMb > 0 ? (expandableMb * 1024 ** 2) / 1024 ** 3 : 0
    return staticGb + expandableGb
  } catch {
    return Infinity
  }
}
// Orphaned-runner sweep BEFORE the headroom check (gate round 4): a
// llama-server runner whose parent ollama server died holds its loaded
// model's commit forever - past runs left several of these behind, eating
// 5+ GB each until a reboot. lifecycle.ts now prevents (tree-kill-first
// stop) and repairs (its own sweep at ensureOllama) this, but that code
// only runs AFTER this script's headroom guard - so a machine whose
// headroom is held hostage by dead runners would refuse here without ever
// reaching the code that frees it. Same rule as lifecycle.ts's sweep: only
// runners whose parent process is GONE are touched; a live server's
// (e.g. the Ollama desktop app's) runners are never candidates.
function reapOrphanedRunners() {
  if (process.platform !== 'win32') return
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$reaped = 0; foreach ($p in Get-CimInstance Win32_Process -Filter "Name=\'llama-server.exe\'") { ' +
          'if (-not (Get-Process -Id $p.ParentProcessId -ErrorAction SilentlyContinue)) { ' +
          'Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $reaped++ } }; ' +
          'Write-Output $reaped'
      ],
      { timeout: 30_000 }
    )
      .toString()
      .trim()
    const count = Number(out)
    if (Number.isFinite(count) && count > 0) {
      process.stdout.write(
        `[evidence] reaped ${count} orphaned llama-server runner(s) left by earlier runs\n`
      )
    }
  } catch {
    // best-effort repair only - never blocks a run
  }
}

if (!reportOnly) {
  reapOrphanedRunners()
  const headroom = commitHeadroomGb()
  if (headroom < MIN_COMMIT_HEADROOM_GB) {
    console.error(
      `[evidence] REFUSING to run: only ${headroom.toFixed(1)} GB of usable commit ` +
        `headroom (static free + expandable pagefile room) is available (need ` +
        `${MIN_COMMIT_HEADROOM_GB} GB). Commit is genuinely near its ceiling: free ` +
        `disk on the pagefile volume or a larger configured pagefile maximum would ` +
        `raise it; otherwise reboot to clear leaked commit, then re-run.`
    )
    process.exit(3)
  }
}

const outDir = path.join(root, 'EVIDENCE', phase)
mkdirSync(outDir, { recursive: true })
const commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()
const stamp = new Date().toISOString()

// Runs may override the phase-level original (phase-3's standalone image
// runs); every distinct original is copied in, since some (the synthetic
// fixtures) are gitignored-regenerable and the EVIDENCE copy is what
// preserves the exact input alongside its output.
const originals = [...new Set([def.original, ...def.runs.map((r) => r.original ?? def.original)])]
const originalNames = new Map()
for (const orig of originals) {
  const name = `original-${path.basename(orig)}`
  originalNames.set(orig, name)
  copyFileSync(path.join(root, orig), path.join(outDir, name))
}
const originalName = originalNames.get(def.original)

const rows = []
for (const run of def.runs) {
  const outFile = path.join('EVIDENCE', phase, run.name)
  const runOriginal = run.original ?? def.original
  if (!reportOnly) {
    const cmd = `npx tsx src/core/cli.ts "${runOriginal}" "${run.source}" "${run.target}" --model ${def.model} --out "${outFile}"`
    process.stdout.write(`[evidence] ${cmd}\n`)
    execSync(`${cmd} 2>&1`, {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 900_000
    })
  }
  rows.push({
    name: run.name,
    source: run.source,
    target: run.target,
    originalName: originalNames.get(runOriginal)
  })
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
    ...rows.map(
      (r) =>
        `- [${r.name}](${r.name}) - ${r.source} -> ${r.target}, translated locally` +
        ` (original: [${r.originalName}](${r.originalName}))`
    ),
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
