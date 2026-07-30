# Phase 1: Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (Tasks 2, 3, 4+5 are file-disjoint and can run as parallel subagents after Task 1 lands types and deps). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Headless pipeline proven end to end against a fake adapter: segments in, validated fitted translations out, via a live managed Ollama, runnable from a CLI.

**Architecture:** Pure-Node modules under `src/core` (Electron-free, lint-enforced): typed segments and adapter registry; a skia-canvas-backed FitEngine; an Ollama lifecycle manager that reuses or spawns a headless server; a batch translation protocol with JSON-schema constrained output and a strict validation ladder; a pipeline orchestrator exposed via `npm run translate`.

**Tech Stack:** skia-canvas (fallback: @napi-rs/canvas behind fonts.ts), ollama npm client, zod v4 (`z.toJSONSchema`), tsx (CLI dev runner), vitest.

**Master plan:** [2026-07-29-local-translate-master-plan.md](2026-07-29-local-translate-master-plan.md)

## Global Constraints (inherited + phase-specific)

- All master-plan global constraints apply (content preservation, measure-then-single-insert, no cloud calls, conventional commits, TDD).
- `src/core` never imports Electron (eslint-enforced since Phase 0).
- Unit convention: FitEngine treats 1 canvas px == 1 pt (both absolute units; measuring at `${sizePt}px` against box dims in pt is exact because only ratios matter within one unit space). Every geometry field name carries its unit suffix (`wPt`, `sizePt`).
- Never kill an Ollama server this app did not spawn. App-spawned servers run on 127.0.0.1:11435 (11434 is reserved for detecting a user-run instance).
- Model store: reuse the user's existing `~/.ollama/models` when present (Charlie has ~70 GB of models there); only fall back to the app data dir on machines with no Ollama footprint. (Deviation from the spec's blanket "OLLAMA_MODELS in app data" - recorded here deliberately: re-downloading existing models would be hostile.)
- Subagents run only their own test file (`npx vitest run tests/core/<area>`) to avoid cross-contamination; the integrator runs the full `npm run check` at merge points.

## Task dependency graph

```
Task 1 (types + deps + FakeAdapter)
  ├── Task 2 (fonts + FitEngine)          [parallel]
  ├── Task 3 (lifecycle + download)       [parallel]
  └── Task 4 (prompts + batching + backend) [parallel]
        └── Task 5 (pipeline + CLI)   [needs 1-4]
              └── Task 6 (E2E gate)  [integrator, live Ollama]
```

---

### Task 1: Types, dependencies, FakeAdapter (integrator, inline)

**Files:**

- Create: `src/core/segments.ts`, `src/core/adapters/adapter.ts`, `src/core/adapters/fake/fake-adapter.ts`
- Test: `tests/core/fake-adapter.test.ts`
- Modify: `package.json` (deps + `translate` script)

**Interfaces produced (every later task uses these verbatim):**

```ts
// segments.ts
export interface FontSpec {
  family: string
  sizePt: number
  bold?: boolean
  italic?: boolean
  colorHex?: string
}
export interface Box {
  wPt: number
  hPt: number
}
export type SegmentKind =
  'shape' | 'table-cell' | 'sheet-cell' | 'pdf-block' | 'image-region' | 'notes' | 'fake'
export interface TextSegment {
  id: string
  text: string
  box: Box
  font: FontSpec
  context: string
  kind: SegmentKind
}
export interface TranslatedSegment extends TextSegment {
  translation: string
  fittedSizePt: number
  fittedLines: string[]
}

// adapters/adapter.ts
export interface FormatAdapter {
  readonly name: string
  readonly extensions: string[]
  extract(filePath: string): Promise<TextSegment[]>
  apply(filePath: string, outPath: string, segments: TranslatedSegment[]): Promise<void>
}
export function adapterFor(filePath: string, adapters: FormatAdapter[]): FormatAdapter | null
```

- [x] **Step 1: Install phase deps**

```bash
npm install skia-canvas ollama zod
npm install --save-dev tsx
```

Then add to package.json scripts: `"translate": "tsx src/core/cli.ts"`.
Verify skia-canvas native binary loads on this machine: `node -e "const {Canvas}=require('skia-canvas'); const c=new Canvas(10,10); console.log('skia-ok', typeof c.getContext('2d').measureText('x').width)"`.
Expected: `skia-ok number`.
If the binary fails to load, install `@napi-rs/canvas` instead and note the swap in fonts.ts (Task 2 isolates the choice).

- [x] **Step 2: Write failing FakeAdapter test**

`tests/core/fake-adapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeAdapter } from '../../src/core/adapters/fake/fake-adapter'
import { adapterFor } from '../../src/core/adapters/adapter'
import type { TranslatedSegment } from '../../src/core/segments'

const seg = {
  id: 's1',
  text: 'Hello world',
  box: { wPt: 200, hPt: 50 },
  font: { family: 'Noto Sans', sizePt: 18 },
  context: 'fake doc',
  kind: 'fake' as const
}

describe('FakeAdapter', () => {
  it('round-trips segments through extract and apply', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lt-'))
    const file = path.join(dir, 'doc.fake.json')
    writeFileSync(file, JSON.stringify({ segments: [seg] }))

    const a = new FakeAdapter()
    const extracted = await a.extract(file)
    expect(extracted).toHaveLength(1)
    expect(extracted[0]).toMatchObject(seg)

    const translated: TranslatedSegment[] = [
      { ...extracted[0], translation: '你好世界', fittedSizePt: 18, fittedLines: ['你好世界'] }
    ]
    const out = path.join(dir, 'doc.out.fake.json')
    await a.apply(file, out, translated)
    const written = JSON.parse(readFileSync(out, 'utf8'))
    expect(written.segments[0].translation).toBe('你好世界')
  })

  it('is selected by adapterFor via extension', () => {
    const a = new FakeAdapter()
    expect(adapterFor('x/doc.fake.json', [a])).toBe(a)
    expect(adapterFor('x/doc.pptx', [a])).toBeNull()
  })
})
```

- [x] **Step 3: Run to verify failure** - `npx vitest run tests/core/fake-adapter.test.ts` fails on missing modules.

- [x] **Step 4: Implement**

`src/core/segments.ts`: exactly the interfaces above.

`src/core/adapters/adapter.ts`:

```ts
import type { TextSegment, TranslatedSegment } from '../segments'

export interface FormatAdapter {
  readonly name: string
  readonly extensions: string[]
  extract(filePath: string): Promise<TextSegment[]>
  apply(filePath: string, outPath: string, segments: TranslatedSegment[]): Promise<void>
}

export function adapterFor(filePath: string, adapters: FormatAdapter[]): FormatAdapter | null {
  const lower = filePath.toLowerCase()
  return adapters.find((a) => a.extensions.some((ext) => lower.endsWith(ext))) ?? null
}
```

`src/core/adapters/fake/fake-adapter.ts`:

```ts
import { readFile, writeFile } from 'node:fs/promises'
import type { FormatAdapter } from '../adapter'
import type { TextSegment, TranslatedSegment } from '../../segments'

/** Test adapter: a "document" is a JSON file { segments: TextSegment[] }. */
export class FakeAdapter implements FormatAdapter {
  readonly name = 'fake'
  readonly extensions = ['.fake.json']

  async extract(filePath: string): Promise<TextSegment[]> {
    const data = JSON.parse(await readFile(filePath, 'utf8'))
    return data.segments
  }

  async apply(_: string, outPath: string, segments: TranslatedSegment[]): Promise<void> {
    await writeFile(outPath, JSON.stringify({ segments }, null, 2))
  }
}
```

- [x] **Step 5: Verify pass, commit** - `npx vitest run tests/core/fake-adapter.test.ts` green, then:

```bash
git add src/core/ tests/core/ package.json package-lock.json
git commit -m "feat: segment types, adapter registry, fake adapter"
```

---

### Task 2: Fonts + FitEngine (subagent-able)

**Files:**

- Create: `src/core/fit/fonts.ts`, `src/core/fit/fit-engine.ts`, `fonts/` (Noto binaries)
- Test: `tests/core/fit/fit-engine.test.ts`, `tests/core/fit/fonts.test.ts`

**Interfaces:**

- Consumes: `FontSpec`, `Box` from `src/core/segments.ts` (Task 1).
- Produces:

```ts
// fonts.ts
export function registerBundledFonts(): void // idempotent
export function resolveFamily(requested: string): { family: string; substituted: boolean }
// fit-engine.ts
export interface FitResult {
  fontSizePt: number
  lines: string[]
  overflowed: boolean // true only if even the 0.5pt floor could not fit
}
export function fit(text: string, box: Box, font: FontSpec): FitResult
```

- [x] **Step 1: Fetch Noto fonts into `fonts/`**

```bash
curl -sL -o fonts/NotoSans-Regular.ttf  https://github.com/notofonts/latin-greek-cyrillic/raw/main/fonts/NotoSans/googlefonts/ttf/NotoSans-Regular.ttf
curl -sL -o fonts/NotoSans-Bold.ttf     https://github.com/notofonts/latin-greek-cyrillic/raw/main/fonts/NotoSans/googlefonts/ttf/NotoSans-Bold.ttf
curl -sL -o fonts/NotoSansSC-Regular.otf https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf
```

If a URL 404s (repo layout moves), locate the current release asset on github.com/notofonts and record the final URL in this plan.
Add `fonts/README.md` noting the SIL OFL 1.1 license of the bundled fonts.
Expected: three files present, each > 100 KB; the SC font is several MB.

- [x] **Step 2: Write failing fonts test**

`tests/core/fit/fonts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { registerBundledFonts, resolveFamily } from '../../../src/core/fit/fonts'

describe('fonts', () => {
  it('registers bundled fonts idempotently and resolves known families', () => {
    registerBundledFonts()
    registerBundledFonts() // second call must not throw or duplicate
    expect(resolveFamily('Noto Sans')).toEqual({ family: 'Noto Sans', substituted: false })
  })

  it('substitutes unknown families to a bundled fallback', () => {
    registerBundledFonts()
    const r = resolveFamily('Calibri-Not-Installed-XYZ')
    expect(r.substituted).toBe(true)
    expect(['Noto Sans', 'Noto Sans CJK SC']).toContain(r.family)
  })
})
```

- [x] **Step 3: Implement fonts.ts**

```ts
import { FontLibrary } from 'skia-canvas'
import path from 'node:path'

const FONTS_DIR = path.resolve(__dirname, '../../../fonts')
let registered = false
const knownFamilies = new Set<string>()

export function registerBundledFonts(): void {
  if (registered) return
  const entries = [
    { family: 'Noto Sans', files: ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'] },
    { family: 'Noto Sans CJK SC', files: ['NotoSansSC-Regular.otf'] }
  ]
  for (const e of entries) {
    FontLibrary.use(
      e.family,
      e.files.map((f) => path.join(FONTS_DIR, f))
    )
    knownFamilies.add(e.family)
  }
  for (const fam of FontLibrary.families) knownFamilies.add(fam)
  registered = true
}

export function resolveFamily(requested: string): { family: string; substituted: boolean } {
  if (knownFamilies.has(requested)) return { family: requested, substituted: false }
  return { family: 'Noto Sans', substituted: true }
}
```

(Adjust `FontLibrary` calls if @napi-rs/canvas was swapped in Task 1; keep this file the only place that knows which canvas lib is used - export a `measureCtx()` helper for fit-engine.)

- [x] **Step 4: Write failing fit-engine test (the regression fixture matrix)**

`tests/core/fit/fit-engine.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { fit } from '../../../src/core/fit/fit-engine'
import { registerBundledFonts } from '../../../src/core/fit/fonts'

registerBundledFonts()
const font = { family: 'Noto Sans', sizePt: 24 }

describe('fit-engine', () => {
  it('keeps short text at its original size', () => {
    const r = fit('Hi', { wPt: 300, hPt: 100 }, font)
    expect(r.fontSizePt).toBe(24)
    expect(r.lines).toEqual(['Hi'])
    expect(r.overflowed).toBe(false)
  })

  it('wraps long text at box width', () => {
    const r = fit('The quick brown fox jumps over the lazy dog', { wPt: 150, hPt: 200 }, font)
    expect(r.lines.length).toBeGreaterThan(1)
    expect(r.overflowed).toBe(false)
  })

  it('shrinks font until everything fits', () => {
    const r = fit('word '.repeat(60).trim(), { wPt: 150, hPt: 60 }, font)
    expect(r.fontSizePt).toBeLessThan(24)
    expect(r.overflowed).toBe(false)
  })

  it('wraps CJK text without spaces', () => {
    const r = fit(
      '这是一个没有空格的很长的中文句子需要正确换行',
      { wPt: 100, hPt: 200 },
      {
        family: 'Noto Sans CJK SC',
        sizePt: 18
      }
    )
    expect(r.lines.length).toBeGreaterThan(1)
    expect(r.overflowed).toBe(false)
  })

  it('honors explicit line breaks', () => {
    const r = fit('line one\nline two', { wPt: 300, hPt: 100 }, font)
    expect(r.lines.length).toBeGreaterThanOrEqual(2)
  })

  it('flags overflow only at the 0.5pt floor', () => {
    const r = fit('x'.repeat(5000), { wPt: 4, hPt: 4 }, font)
    expect(r.fontSizePt).toBe(0.5)
    expect(r.overflowed).toBe(true)
  })

  // Fit invariant over a grid: whatever fits must actually measure inside the box,
  // and one descent step larger must NOT fit (else we shrank too far).
  it('fit invariant + minimality across a fixture grid', () => {
    const texts = [
      'Hello',
      'The quick brown fox jumps over the lazy dog. '.repeat(3).trim(),
      '技术规格和测试程序的内部业务文档',
      'Antidisestablishmentarianism supercalifragilistic'
    ]
    const boxes = [
      { wPt: 60, hPt: 30 },
      { wPt: 150, hPt: 60 },
      { wPt: 300, hPt: 20 }
    ]
    for (const text of texts)
      for (const box of boxes) {
        const r = fit(text, box, font)
        if (!r.overflowed) {
          expect(measuredFits(r.lines, r.fontSizePt, box, font)).toBe(true)
          const bigger = stepUp(r.fontSizePt)
          if (bigger <= font.sizePt) {
            const rBigger = layoutAt(text, bigger, box, font)
            expect(rBigger.fits).toBe(false)
          }
        }
      }
  })
})
```

`measuredFits`, `stepUp`, `layoutAt` are exported test helpers from fit-engine (`export const _internals` object) so the invariant checks use the engine's own measurement, not a reimplementation.

- [x] **Step 5: Implement fit-engine.ts**

```ts
import { Canvas } from 'skia-canvas'
import type { Box, FontSpec } from '../segments'
import { resolveFamily } from './fonts'

export interface FitResult {
  fontSizePt: number
  lines: string[]
  overflowed: boolean
}

const FLOOR_PT = 0.5
const LINE_HEIGHT_FACTOR = 1.2
const canvas = new Canvas(8, 8) // throwaway measurement surface, never rendered
const ctx = canvas.getContext('2d')

function setFont(sizePt: number, font: FontSpec): void {
  const { family } = resolveFamily(font.family)
  const weight = font.bold ? 'bold ' : ''
  const style = font.italic ? 'italic ' : ''
  // 1px == 1pt convention (see plan Global Constraints)
  ctx.font = `${style}${weight}${sizePt}px "${family}"`
}

function width(s: string): number {
  return ctx.measureText(s).width
}

/** Break opportunities: after spaces, and after every CJK char. */
function tokens(text: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    if (ch === ' ') {
      if (cur) out.push(cur)
      out.push(' ')
      cur = ''
    } else if (/[　-鿿豈-﫿぀-ヿ＀-￯]/.test(ch)) {
      if (cur) out.push(cur)
      out.push(ch)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

function wrapParagraph(par: string, maxW: number): { lines: string[]; fits: boolean } {
  const lines: string[] = []
  let line = ''
  let fits = true
  for (const tok of tokens(par)) {
    const cand = line + tok
    if (width(cand.trimEnd()) <= maxW || line === '') {
      line = cand
      // single token wider than the box: force character breaks
      if (line !== '' && width(line.trimEnd()) > maxW) {
        const chars = [...line]
        let piece = ''
        for (const ch of chars) {
          if (width(piece + ch) > maxW && piece) {
            lines.push(piece)
            piece = ch
          } else piece += ch
        }
        line = piece
        fits = fits && true
      }
    } else {
      lines.push(line.trimEnd())
      line = tok === ' ' ? '' : tok
    }
  }
  if (line.trimEnd()) lines.push(line.trimEnd())
  return { lines: lines.length ? lines : [''], fits }
}

function layout(text: string, sizePt: number, box: Box, font: FontSpec) {
  setFont(sizePt, font)
  const lines = text.split('\n').flatMap((p) => wrapParagraph(p, box.wPt).lines)
  const maxLineW = Math.max(...lines.map((l) => width(l)))
  const totalH = lines.length * sizePt * LINE_HEIGHT_FACTOR
  return { lines, fits: maxLineW <= box.wPt && totalH <= box.hPt }
}

function stepDown(sizePt: number): number {
  return sizePt > 6 ? sizePt - 1 : sizePt - 0.5
}
function stepUp(sizePt: number): number {
  return sizePt >= 6 ? sizePt + 1 : sizePt + 0.5
}

export function fit(text: string, box: Box, font: FontSpec): FitResult {
  let size = font.sizePt
  while (size >= FLOOR_PT) {
    const r = layout(text, size, box, font)
    if (r.fits) return { fontSizePt: size, lines: r.lines, overflowed: false }
    size = stepDown(size)
  }
  const r = layout(text, FLOOR_PT, box, font)
  return { fontSizePt: FLOOR_PT, lines: r.lines, overflowed: true }
}

export const _internals = {
  layoutAt: (text: string, sizePt: number, box: Box, font: FontSpec) =>
    layout(text, sizePt, box, font),
  measuredFits: (lines: string[], sizePt: number, box: Box, font: FontSpec) => {
    setFont(sizePt, font)
    const maxW = Math.max(...lines.map((l) => width(l)))
    return maxW <= box.wPt && lines.length * sizePt * LINE_HEIGHT_FACTOR <= box.hPt
  },
  stepUp
}
```

(The plan shows the intended algorithm; the implementer refines the force-break branch as tests demand, keeping the invariant test green.)

- [x] **Step 6: Verify, commit**

```bash
npx vitest run tests/core/fit
git add src/core/fit tests/core/fit fonts/
git commit -m "feat: font registration and shrink-to-fit engine"
```

---

### Task 3: Ollama lifecycle + downloader (subagent-able)

**Files:**

- Create: `src/core/translate/ollama/lifecycle.ts`, `src/core/translate/ollama/download.ts`
- Test: `tests/core/ollama/lifecycle.test.ts`, `tests/core/ollama/download.test.ts`

**Interfaces:**

- Produces:

```ts
// lifecycle.ts
export interface OllamaConnection {
  baseUrl: string
  spawned: boolean
  stop(): Promise<void> // no-op unless spawned
}
export function findOllamaExe(): string | null
export async function ensureOllama(opts: {
  appDataDir: string
  port?: number // default 11435 for spawned servers
  exePath?: string // override for tests
  probeUrl?: string // override for tests (default http://127.0.0.1:11434)
}): Promise<OllamaConnection>
// download.ts
export async function downloadFile(opts: {
  url: string
  dest: string
  expectedSha256?: string
  onProgress?: (received: number, total: number | null) => void
}): Promise<void>
export const OLLAMA_STANDALONE_URL: string // windows amd64 zip, latest release
```

**Behavior contract (tests encode each line):**

1. If `probeUrl` answers `/api/version`, return `{ spawned: false }` connection to it; `stop()` never kills it.
2. Else spawn `exePath serve` detached-safe with env `OLLAMA_HOST=127.0.0.1:<port>` and `OLLAMA_MODELS=<store>` where store = existing `~/.ollama/models` if present else `<appDataDir>/models`; poll `/api/version` until ready (timeout 30 s); write `<appDataDir>/ollama.pid`.
3. `stop()` on a spawned connection terminates the child (tree-kill on Windows: `taskkill /pid <pid> /T /F` after a 5 s graceful window) and removes the pid file.
4. On `ensureOllama` start, if a stale pid file exists and that pid is alive and is an `ollama` process, terminate it first (crash-orphan cleanup); if the pid is dead or belongs to another program, just delete the file.
5. If no exe is found and none supplied: throw `OllamaNotFoundError` carrying `OLLAMA_STANDALONE_URL` (the app layer decides to download; core never downloads implicitly).

**Test strategy (no real Ollama in unit tests):**

- Fake server: `node:http` server answering `/api/version` on an ephemeral port -> case 1.
- Fake exe: a tiny node script (fixture) that starts an http server on `OLLAMA_HOST` and exits on SIGTERM -> cases 2-3 use `exePath: process.execPath` with args injection via a `OLLAMA_FAKE_SERVE_SCRIPT` env the lifecycle passes through when set (test-only seam, documented in code).
- Orphan cleanup: write a pid file pointing at a spawned fake, call `ensureOllama`, assert the old pid is gone.
- `downloadFile`: local http server serving a known buffer; assert bytes, progress calls, and sha mismatch -> rejects and deletes partial file.

- [x] Steps: failing tests -> implement -> `npx vitest run tests/core/ollama` green -> commit `feat: managed ollama lifecycle and downloader`.

---

### Task 4: Prompts, batching, OllamaBackend (subagent-able)

**Files:**

- Create: `src/core/translate/backend.ts`, `src/core/translate/prompts.ts`, `src/core/translate/batching.ts`, `src/core/translate/ollama/ollama-backend.ts`
- Test: `tests/core/translate/batching.test.ts`, `tests/core/translate/ollama-backend.test.ts`

**Interfaces:**

- Consumes: `TextSegment` (Task 1); `OllamaConnection` (Task 3, constructor takes `baseUrl`).
- Produces:

```ts
// backend.ts
export interface ModelInfo {
  name: string
  sizeBytes: number
}
export interface ModelCaps {
  structuredWithThinkOff: boolean
}
export interface BatchRequest {
  model: string
  sourceLang: string
  targetLang: string
  groupContext: string
  glossary?: Record<string, string>
  segments: { id: string; text: string }[]
}
export interface BatchResponse {
  translations: { id: string; translation: string }[]
}
export interface TranslationBackend {
  listModels(): Promise<ModelInfo[]>
  pullModel(name: string, onProgress?: (pct: number) => void): Promise<void>
  translateBatch(req: BatchRequest): Promise<BatchResponse>
}
// batching.ts
export function groupSegments(segments: TextSegment[], maxChars?: number): TextSegment[][] // groups by context prefix, splits at maxChars (default 2000)
export type ValidationFailure = 'parse' | 'id-mismatch' | 'empty' | 'echo'
export function validateBatch(
  req: BatchRequest,
  translations: { id: string; translation: string }[]
): {
  ok: { id: string; translation: string }[]
  failed: { id: string; reason: ValidationFailure }[]
}
```

**Validation ladder (encoded in ollama-backend.translateBatch):**

1. Call `ollama.chat` with `format: z.toJSONSchema(batchSchema)` (zod v4) and thinking per cached model caps.
2. Response must parse against the zod schema; then per-segment: id present exactly once, translation non-empty, translation !== source text when source/target languages differ (echo check skips numeric/symbol-only segments).
3. Failures retry once (whole group), then failing segments go through one per-segment call each, then remaining failures return absent - the pipeline keeps original text and reports.
4. Capability probe `probeModelCaps(model)`: tiny schema request with `think: false`; if output violates schema, record `{ structuredWithThinkOff: false }` in `<appDataDir>/model-caps.json` and use thinking-on + trace-strip for that model (ollama#15260).

**Test strategy:** mock the `ollama` client module (vitest `vi.mock`) - no live server in unit tests. Cases: happy path; malformed JSON -> retry -> per-segment fallback; echo detection; id mismatch; caps probe writes and rereads cache file.

**Prompt template (prompts.ts, exact starting text):**

```
System: You are a professional translator for internal business documents.
Translate each segment from {source} to {target}.
Rules: return ONLY the JSON demanded by the schema; translate every segment independently; preserve line breaks inside segments; do not translate numbers, codes, or proper nouns that have no {target} equivalent; glossary (must-use): {glossary}.
Document context: {groupContext}
User: {json array of {id, text}}
```

- [x] Steps: failing tests -> implement -> `npx vitest run tests/core/translate` green -> commit `feat: batch translation protocol with ollama backend`.

---

### Task 5: Pipeline + CLI (integrator, after 1-4)

**Files:**

- Create: `src/core/pipeline.ts`, `src/core/cli.ts`
- Test: `tests/core/pipeline.test.ts`

**Interfaces:**

```ts
export interface RunReport {
  file: string
  outPath: string
  total: number
  translated: number
  keptOriginal: { id: string; reason: string }[]
  overflowed: { id: string; fontSizePt: number }[]
  durationMs: number
}
export interface PipelineOpts {
  file: string
  out?: string
  sourceLang: string
  targetLang: string
  model: string
  adapter: FormatAdapter
  backend: TranslationBackend
  onProgress?: (
    done: number,
    total: number,
    phase: 'extract' | 'translate' | 'fit' | 'apply'
  ) => void
}
export async function runPipeline(opts: PipelineOpts): Promise<RunReport>
```

Flow: extract -> groupSegments -> translateBatch per group -> fit each translation -> apply -> report.
Content preservation: a segment with no validated translation is passed to `apply` with `translation = original text` and appears in `keptOriginal`.
Default out path: `<name>_translated.<ext>` beside the input.

CLI (`src/core/cli.ts`): `npm run translate -- <file> <sourceLang> <targetLang> [--model gemma4:e4b] [--out path]`.
Wires FakeAdapter (only adapter so far), `ensureOllama`, `OllamaBackend`, prints the RunReport as a table and exits nonzero if `translated === 0`.

**Test:** pipeline unit test with FakeAdapter + mocked backend covering: all-success, partial failure -> keptOriginal populated, overflow reporting. Commit `feat: pipeline orchestration and translate CLI`.

---

### Task 6: Live E2E gate (integrator, real Ollama + gemma4:e4b)

- [x] **Step 1: Build the 50-segment fixture** `fixtures/gate-50.fake.json`: 25 EN business segments (varied lengths, a table-cell-sized 3-word one, a 60-word paragraph, numbers-only, an acronym-heavy one) and 25 ZH equivalents, boxes sized to force some shrinking.
- [x] **Step 2: Stop any running Ollama** (`taskkill` the tray/serve processes - they were incidentally started earlier; verify port 11434 is dead).
- [x] **Step 3: Run** `npm run translate -- fixtures/gate-50.fake.json English "Chinese (Simplified)" --model gemma4:e4b` -> expect: lifecycle spawns serve on 11435, report shows total=50, translated=50 (or every miss listed in keptOriginal with reasons), no overflowed=floor cases.
- [x] **Step 4: Reverse direction** ZH->EN on the same fixture.
- [x] **Step 5: Orphan check** - kill the CLI mid-run (second invocation), rerun, assert no duplicate ollama processes after completion (`tasklist | findstr ollama`).
- [x] **Step 6: Full gates** - `npm run check` green; commit fixture + any fixes; push; CI green.
- [x] **Step 7: Tick this plan's checkboxes, update .remember, report** with the real RunReport numbers.

## Self-review

- Master-plan coverage: all 7 master Phase-1 tasks map here (types->1, fonts+fit->2, lifecycle+download->3, backend+batching+prompts->4, pipeline+CLI->5, gate->6). Interfaces match the master plan's `FormatAdapter`/`fit`/`translateBatch`/`runPipeline` shapes with unit-suffixed fields as the only refinement.
- No placeholders: every module has real code or an exact behavior contract + test strategy; the two "implementer refines" notes are bounded by concrete invariant tests that define done.
- Type consistency: `FitResult.fontSizePt`/`overflowed` names match between Tasks 2 and 5; `BatchRequest`/`BatchResponse` match between Tasks 4 and 5; `OllamaConnection.baseUrl` consumed by backend constructor.
- Deviation recorded: OLLAMA_MODELS reuses an existing user store (contra spec's blanket app-data rule) - deliberate, documented above.

## Execution notes (2026-07-29)

- Task 2 Step 1 correction: the brief's original notofonts URLs 404'd (served HTML error pages disguised as .ttf, caught by magic-byte checks).
  Final working sources are recorded in [fonts/README.md](../../../fonts/README.md) (notofonts/NotoSans instance_ttf for Latin, notofonts/noto-cjk for SC).
- Task 5 ruling: --model is optional with DEFAULT_MODEL gemma4:e4b.
- Post-gate final-review fix wave (04ca077, 3142e93): fit floor clamp for fractional sizes, probe transport errors no longer persisted as caps, binary-search line breaking (pathological fit test 4320ms -> ~50ms, fixes CI timeout on slow runners), groupKey added to TextSegment, adapterFor longest-match, duplicate-id guard in runPipeline, exit 0 for all-skipped-untranslatable runs, numbers-only segment in gate fixture.
- LOCAL_TRANSLATE_DATA_DIR env override removed in favor of LOCALAPPDATA (nothing depended on it).
