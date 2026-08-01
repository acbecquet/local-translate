# Phase 3: Image Text (Vision Pipeline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.
> Tasks run sequentially (the region engine chosen by the Task 1 spike feeds every later task).
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standalone PNG/JPG files and images embedded in pptx get in-place translated text, closing the one gap Charlie saw at the Phase 2 gate.

**Architecture:** A region engine (`regions.ts`) turns an image into validated text regions behind a fixed interface, with the concrete engine (local VLM via Ollama vs PP-OCR ONNX on CPU) chosen by a measured spike.
Regions become ordinary `image-region` TextSegments, so the existing pipeline translates and FitEngine-sizes them with zero pipeline changes.
`overlay.ts` paints translations back (background-sampled fill + skia-canvas text), `image-adapter.ts` wraps this as a FormatAdapter, and the pptx adapter re-embeds translated media parts losslessly.

**Tech Stack:** skia-canvas (already a dep: decode, sample, draw, encode), ollama client chat-with-images (if VLM wins the spike), onnxruntime-based PP-OCR (if OCR wins), existing core (FitEngine, batching, pipeline, OOXML layer).

**Master plan:** [2026-07-29-local-translate-master-plan.md](2026-07-29-local-translate-master-plan.md)
**Knowledge base:** [2026-07-31-translation-knowledge-base.md](../../research/2026-07-31-translation-knowledge-base.md) (item 12 mandates the OCR-vs-VLM spike comparison)

## Global Constraints (inherited + phase-specific)

- All master-plan constraints: content preservation absolute, measure-then-single-insert, no cloud calls, conventional commits, no co-author lines, TDD, `src/core` Electron-free.
- MACHINE RULES (hard): anything that loads a model on the GPU is run by Charlie, not by an agent or background process.
  Agents hand Charlie a run-tagged command block and wait for pasted output.
  Agent-run tests use mocks or CPU-only paths, are scoped (`vitest run tests/core/images`), and short.
  ONE subagent at a time.
- Units convention: image pixels ARE points (1px == 1pt), matching FitEngine's existing convention.
  A region bbox `{x, y, w, h}` in px maps directly to `Box { wPt: w, hPt: h }` with no DPI math anywhere.
- The original image is never discarded or painted in place: apply() always writes a copy; in pptx, only media parts with translated regions are rewritten, all others stay byte-identical (part-level sha256, same lossless rule as Phase 2).
- Confidence gating: low-confidence regions are REPORTED (RunReport.skippedUnsupported via collectSkips), never painted.
  A wrong overlay is worse than no overlay.
- Source-language gating: only regions whose text is in the source language are translated.
  For a zh source that means CJK-bearing regions; pure-latin regions (logos, part numbers) are left untouched.
  For an en source the logo risk is real and is explicitly a Charlie-eyeball item at the phase gate.
- Rotated/vertical text is out of scope v1: detected-but-rotated regions are skip-with-log, never painted.
- EMF/WMF and other vector metafiles are skip-with-log (`reason: 'vector metafile image'`); the real deck has exactly one.
- Evidence standard: artifacts only (original + translated files) in `EVIDENCE/phase-3/`, fit/region proof tables in its README, no screenshots of test output.

## Task sequence

```
Task 0 (carried riders: fonts packaging, DEFAULT_MODEL dedup, OLE/box-null tests)
  -> Task 1 (labeled fixtures + spike harness + ENGINE DECISION - gates the phase)
    -> Task 2 (regions.ts: chosen engine behind fixed interface + validation ladder)
      -> Task 3 (overlay.ts: background-sampled fill + fitted text draw)
        -> Task 4 (image-adapter.ts + registry/CLI/UI wiring)
          -> Task 5 (pptx embedded-media hookup)
            -> Task 6 (phase gate: real deck both directions, live, evidence)
```

---

### Task 0: Carried riders from the Phase 2 ledger (subagent)

Three small items the Phase 2 reviews flagged as fix-before-phase-3.
One task because each is minutes of work; a reviewer can still reject any one independently.

**Files:**

- Create: `src/core/defaults.ts`
- Modify: `src/core/cli.ts`, `src/main/translate-service.ts` (import DEFAULT_MODEL instead of local consts), `electron-builder.yml` (fonts packaging)
- Test: `tests/core/defaults.test.ts` (both call sites import the shared const), additions to `tests/core/pptx/pptx-adapter.test.ts` (OLE skip, box-null shape)

**Interfaces produced:**

```ts
// src/core/defaults.ts
export const DEFAULT_MODEL = 'gemma4:e4b'
```

**Behavior contract (each point encoded by a test where testable):**

1. `src/core/defaults.ts` is the ONLY place the literal default model string appears in `src/` (test greps the built source tree or asserts both modules re-export the same const identity).
2. pptx adapter: a slide with an OLE object (`p:graphicFrame` wrapping `ole` graphicData) extracts zero segments from it, `collectSkips()` reports it, and apply leaves the part byte-identical - a dedicated test, not incidental coverage.
3. pptx adapter: a shape whose geometry resolves to `box: null` gets `SENTINEL_BOX` and its font size is preserved verbatim through apply - dedicated test.
4. `electron-builder.yml` gains an `extraResources` entry shipping `src/core/fit/fonts/**` into `resources/fonts/`, and `fonts.ts`'s `findAppRoot` resolution order already covers that path (add a unit test on the resolution helper with a faked resources layout).
   Full installer verification stays a Phase 6 gate item; this task only makes the config + resolution correct.

- [ ] Steps: failing tests -> implement -> green -> scoped check -> commit `fix: phase-2 review riders (default model dedup, fonts packaging, ole/box-null tests)`.

---

### Task 1: Labeled image fixtures + spike harness + engine decision (subagent authors, Charlie runs GPU legs - GATES THE PHASE)

The weakest link in the whole phase is region detection.
This task produces ground-truth fixtures, a harness that scores any engine against them, and a written decision.

**Files:**

- Create: `scripts/make-image-fixtures.mjs`, `scripts/spike-image-regions.mjs`, `docs/research/2026-07-31-phase-3-spike-image-regions.md` (decision doc, written at the end)
- Output (gitignored except labels): `fixtures/image-regions/img01.png ... img10.png`, `fixtures/image-regions/labels.json` (committed - it is small text), real-media crops pulled from the CCELL deck into `fixtures/image-regions/real/` (committed - they are the actual gate workload)

**Fixture generator (`make-image-fixtures.mjs`):** renders 10 synthetic images with skia-canvas, writing exact ground truth as it draws, so labels are free and perfect:

- img01-03: dark/light/colored solid backgrounds, 2-4 latin text blocks each, 12-32pt.
- img04-05: CJK text blocks (Noto Sans CJK SC), mixed sizes, incl. one 10pt small-text case.
- img06-07: gradient + noise backgrounds (text on busy background - the known hard case).
- img08: dense case - 8 small regions in a table-like grid.
- img09: mixed latin + CJK on one image (source-language gating case).
- img10: no text at all (hallucination probe - correct answer is zero regions).

`labels.json` schema (also the spike harness's input):

```json
{ "img01.png": [{ "bbox": { "x": 40, "y": 30, "w": 300, "h": 42 }, "text": "Quarterly results" }] }
```

Plus `real/`: extract 4 representative media parts from the benchmark deck (2 png screenshots with CJK, 2 jpg photos), no labels - qualitative eval only.

**Spike harness (`spike-image-regions.mjs`):** `node scripts/spike-image-regions.mjs --engine <name>` runs one engine over all fixtures and prints a markdown table:

- Per image and overall: recall (ground-truth region matched at IoU >= 0.5), precision (unmatched detections = hallucinations), mean IoU of matches, text accuracy (1 - normalized Levenshtein on matched regions), wall ms.
- Engines: `vlm:<model>` (Ollama `/api/chat` with `images:[...]`, JSON-schema output, bboxes in normalized 0-1000 coords, temperature 0) and `ocr:ppocr` (PP-OCR detection+recognition via an ONNX runtime package - candidates in order: `@gutenye/ocr-node` (PP-OCRv4), `ppu-paddle-ocr` (TS, multilingual, RapidOCR-integrated), raw `onnxruntime-node` + PP-OCRv4 det/rec models; the spike's first step is proving ONE of these installs and runs on Windows CPU with the CHINESE recognition model, not just the default latin one).
- The harness is engine-agnostic: an engine is any module exporting `detectRegions(buffer): Promise<TextRegion[]>` - the exact interface Task 2 ships, so the winning spike code moves into `regions.ts` nearly verbatim.

**Execution split (machine rules):**

- Agent runs: fixture generation, harness self-test (a `mock:labels` engine that replays labels.json must score recall=precision=IoU=1.0 - proves the scorer), and the `ocr:ppocr` leg (CPU, light).
- Charlie runs (run-tagged blocks, pasted output): the VLM legs.
  AMENDED 2026-08-01 (Charlie: qwen3-vl is outdated; leaderboard-informed reselect): `vlm:glm-ocr` (2.2GB document-OCR specialist VLM, vision-confirmed on ollama) and `vlm:qwen3.5:9b` (current multimodal Qwen line, 6.6GB, leaderboard intelligence 21).
  `vlm:gemma4:e4b` stays as an optional zero-download leg: the ollama library confirms the whole gemma4 family is vision-capable, so the original "does e4b accept images" probe is already answered yes; running it only measures quality.

**Decision criteria (recorded in the decision doc):**

1. An engine is viable at recall >= 0.9, precision >= 0.8, mean IoU >= 0.6, text accuracy >= 0.85 on the synthetic set, plus no garbage on the real crops (eyeball).
2. Both viable -> the cheaper/faster one wins (CPU OCR beats GPU VLM at equal quality: frees VRAM for the translation model).
3. VLM bboxes fail but VLM reading is good AND OCR detection is good -> hybrid fallback design: OCR detection boxes, crop each box, VLM/OCR reads the crop.
   The decision doc must say which single design Task 2 implements.
4. Nothing viable -> STOP, phase re-plan with Charlie.

- [ ] Steps: fixture generator -> labels sanity check -> harness + mock-engine self-test -> agent runs OCR leg -> hand Charlie the VLM legs -> decision doc -> commit `feat: phase-3 image fixtures and region-engine spike harness` (+ decision doc commit).

---

### Task 2: regions.ts - chosen engine behind the fixed interface (subagent)

**Files:**

- Create: `src/core/images/regions.ts` (+ `src/core/images/engines/<winner>.ts`)
- Test: `tests/core/images/regions.test.ts`

**Interfaces produced (fixed regardless of spike winner):**

```ts
// src/core/images/regions.ts
export interface RegionBBox {
  x: number
  y: number
  w: number
  h: number
} // px
export interface TextRegion {
  id: string // 'r1', 'r2', ... stable ordering within one image
  bbox: RegionBBox // clamped to image bounds
  text: string // source text as read
  confidence: number // 0..1
  rotated?: boolean // true -> caller must skip-with-log, never paint
}
export interface RegionEngine {
  detectRegions(image: Buffer): Promise<TextRegion[]>
}
export const CONFIDENCE_FLOOR = 0.6 // below -> report, don't paint (doc comment req'd)
// Validation ladder applied over ANY raw engine output:
export function validateRegions(raw: TextRegion[], imgW: number, imgH: number): TextRegion[]
```

**Behavior contract (each point encoded by a test - validateRegions is pure, engine mocked):**

1. Bboxes are clamped to image bounds; zero/negative-area regions are dropped.
2. Regions under 8px in either dimension are dropped (noise floor).
3. Two regions with IoU > 0.5, or one containing >= 80% of the other, merge into their union bbox with texts joined in reading order and min confidence.
4. Output is sorted in reading order: by y band (overlapping vertical extents = same band), then x.
5. `id`s are assigned AFTER validation ('r1'...'rN') so ids are dense and stable for a given image.
6. Region text is trimmed; empty-after-trim regions are dropped.
7. The engine implementation matches the spike decision doc exactly (VLM: normalized-coord denormalization + JSON-schema request + temperature 0; OCR: det/rec invocation + box conversion; hybrid: det boxes -> crop -> read).
   Engine tests mock the transport (fake Ollama response / fake ONNX session) - no model loads in tests.

- [ ] Steps: failing validateRegions tests -> implement -> engine impl w/ mocked transport tests -> green -> scoped check -> commit `feat: image text regions with validation ladder (<winner> engine)`.

---

### Task 3: overlay.ts - paint translations back (subagent)

**Files:**

- Create: `src/core/images/overlay.ts`
- Test: `tests/core/images/overlay.test.ts`

**Interfaces produced:**

```ts
// src/core/images/overlay.ts
import type { FontSpec } from '../segments'
import type { RegionBBox } from './regions'
export interface OverlayRegion {
  bbox: RegionBBox
  lines: string[] // FitEngine's fittedLines
  fontSizePt: number // FitEngine's fittedSizePt
  font: FontSpec // family/bold/italic; colorHex ignored (sampled instead)
}
export interface OverlayResult {
  image: Buffer
  format: 'png' | 'jpeg'
}
export function renderOverlay(image: Buffer, regions: OverlayRegion[]): Promise<OverlayResult>
```

**Algorithm (locked here so the implementer doesn't improvise):**

1. Decode via skia-canvas `loadImage`, draw onto a canvas of identical dimensions.
2. Per region - background fill: read a 3px border ring OUTSIDE the bbox (clamped at edges) via `getImageData`, take the per-channel MEDIAN (median, not mean: robust to stray text pixels in the ring), fill the bbox rect with it.
3. Per region - text color: collect interior bbox pixels, pick the cluster farthest from the fill color (simple 2-means on RGB distance to fill); if max distance < 40 (uniform region, text was anti-aliased away), fall back to black/white by fill luminance (>= 140 -> black text, else white).
4. Draw `lines` at `fontSizePt` with the bundled Noto family (registered once via fonts.ts), vertically centered in the bbox, left-aligned, line height 1.2 (FitEngine's LINE_HEIGHT_FACTOR - import it or mirror the constant with a drift-guard test).
5. Encode back to the INPUT format: png in -> png out, jpg in -> jpeg quality 90.
   Format detection by magic bytes (0x89 PNG / 0xFF 0xD8 JPEG), not filename.

**Behavior contract (each point a test - synthetic canvases, no model, no GPU):**

1. Round trip with zero regions returns a pixel-identical decode (png) / same dimensions (jpeg).
2. A red-background image with a white text bbox painted over: sampled fill within delta<8 of red per channel, and interior of bbox after overlay contains no white pixels outside the drawn glyphs' rows.
3. Text color contrast: dark fill -> light text and vice versa (assert via drawn-pixel luminance vs fill luminance).
4. Border-ring sampling at image edges (bbox flush to x=0) does not throw and clamps correctly.
5. Output format matches input magic bytes for both png and jpeg inputs.
6. CJK lines render non-empty glyphs (draw, then assert bbox interior is not 100% fill color) - proves CJK font registration reaches skia draw, not just measure.

- [ ] Steps: failing tests -> implement -> green -> scoped check -> commit `feat: image overlay rendering with background-sampled fill`.

---

### Task 4: image-adapter.ts + wiring (subagent)

**Files:**

- Create: `src/core/adapters/images/image-adapter.ts`
- Modify: `src/core/adapters/registry.ts` (factory takes deps), `src/core/cli.ts` + `src/main/translate-service.ts` (construct registry with the region engine after connect), `src/shared/languages.ts`/renderer file-accept list if it hardcodes extensions
- Test: `tests/core/images/image-adapter.test.ts`

**Interfaces produced:**

```ts
// image-adapter.ts
export function createImageAdapter(engine: RegionEngine): FormatAdapter
// extensions: ['.png', '.jpg', '.jpeg']

// registry.ts (breaking change to its export, both call sites updated here)
export interface AdapterDeps {
  regionEngine: RegionEngine | null
}
export function buildAdapters(deps: AdapterDeps): FormatAdapter[]
// regionEngine null (e.g. engine unavailable) -> image adapter excluded; pptx/fake still present
```

**Behavior contract (each point a test - engine mocked):**

1. extract(): decodes dimensions, calls `engine.detectRegions`, runs `validateRegions`, emits one TextSegment per PAINTABLE region:
   `id` = region id, `kind: 'image-region'`, `context: 'image text region'`, `groupKey` = input file basename, `box = { wPt: bbox.w, hPt: bbox.h }`,
   `font.sizePt` = estimated from bbox height / 1.2 (single most common case: one-line region), `font.family` = Noto Sans (CJK variant when region text contains CJK).
2. Source-language gating: regions not in the source language produce NO segment and ARE NOT painted (they also don't appear in skips - they are legitimate leave-alone content).
   CJK detection: >= 30% of non-space chars in CJK unicode ranges = CJK region.
   extract() receives sourceLang via the adapter's constructor opts (registry passes the run's sourceLang - registry factory gains it in AdapterDeps).
3. Low-confidence (< CONFIDENCE_FLOOR) and rotated regions: no segment, but `collectSkips()` reports `{ id, reason: 'low-confidence region' | 'rotated region' }`.
4. apply(): uses the regions CACHED from the most recent extract() (same statefulness pattern as collectSkips), builds OverlayRegions from TranslatedSegments (matching by id; segments missing from the translated set - keptOriginal case - are NOT painted: original pixels preserved beats painting the source text back on), calls renderOverlay, writes outPath.
   apply() without a prior extract() on the same path throws a clear error.
5. Registry: `buildAdapters({ regionEngine: null })` yields no image adapter; with an engine, `adapterFor('x.png', ...)` resolves it; cli/translate-service construct the engine right after backend connect and pass it in.
6. img10-style no-text image: extract() returns zero segments and runPipeline completes with a zero-segment report (already supported - test proves it end-to-end through the adapter with a mocked engine).

- [ ] Steps: failing tests -> implement -> green -> wire cli/service/renderer accept-list -> scoped check + one full `npm run check` -> commit `feat: png/jpg image adapter over region engine`.

---

### Task 5: pptx embedded-media hookup (subagent)

**Files:**

- Modify: `src/core/adapters/pptx/pptx-adapter.ts`, `src/core/adapters/pptx/ooxml.ts` (media enumeration helpers), registry wiring (pptx adapter now also takes `regionEngine | null`)
- Test: additions to `tests/core/pptx/pptx-adapter.test.ts` (builder already supports `kind: 'picture'`)

**Interfaces produced:**

```ts
// ooxml.ts additions
export interface MediaRef {
  mediaPath: string
  slidePath: string
} // one per usage
export function listPictureMedia(archive: PptxArchive): MediaRef[] // via a:blip r:embed rels, raster only
export function readMediaBytes(archive: PptxArchive, mediaPath: string): Promise<Buffer>
export function writeMediaBytes(archive: PptxArchive, mediaPath: string, bytes: Buffer): void // marks part dirty
```

**Behavior contract (each point a test - engine mocked, builder decks):**

1. Media parts are DEDUPED by part path: an image used on 3 slides is detected once, translated once, rewritten once (segments carry the mediaPath, not the usage).
2. Segment ids namespace under the part: `media/image3.png#r1` - globally unique against shape/cell ids by construction; `groupKey` = the FIRST slide that uses the part (keeps its regions batched with that slide's text for context); `context: 'embedded image text'`.
3. Raster filter: png/jpg/jpeg parts processed; emf/wmf/other -> `collectSkips` `{ id: mediaPath, reason: 'vector metafile image' }`.
4. `regionEngine: null` (engine unavailable) -> pptx adapter behaves exactly as Phase 2: zero image segments, zero media rewrites, no skips added for media (a null engine means image translation is off, not that every image is "skipped content").
5. apply(): only media parts that have >= 1 painted region are rewritten (via writeMediaBytes + markDirty); every other part - including media with regions that all failed gating - stays byte-identical (extends the existing part-level sha256 lossless test).
6. Image bytes written back keep their original format (overlay.ts guarantees it; the test asserts magic bytes of the rewritten part match the original part).
7. Source-language gating + confidence gating behave identically to Task 4 (shared code path through validateRegions + the same gating helper - no copy-paste divergence; test imports both adapters and asserts the same helper instance).

- [ ] Steps: failing tests -> implement -> green -> scoped check + full check -> commit `feat: pptx embedded image translation via media re-embedding`.

---

### Task 6: Phase gate - real deck, live models, evidence (Charlie runs)

**Files:**

- Modify: `scripts/capture-evidence.mjs` (phase-3 entry: re-run both real-deck directions with the region engine on, plus 2 standalone image fixtures)
- Create: `EVIDENCE/phase-3/` (original + translated artifacts + README with region/fit proof tables)

**Gate checklist (Charlie's eyeball + pasted CLI output):**

1. `CCELL 3.0 AIO Lab Test Updates Mandarin.pptx` -> full EN and full ZH runs, now INCLUDING embedded images; zero PowerPoint repair dialog; stats block (from the stats feature) pasted into the README.
2. Embedded-image spot check on >= 5 image-bearing slides: translated text readable, backgrounds plausible, no logo mangled (en source logo risk item).
3. Standalone: one synthetic fixture png + one real crop jpg through the CLI; artifacts into EVIDENCE.
4. Run report: every skip is one of the sanctioned reasons (vector metafile, low-confidence, rotated); keptOriginal regions left unpainted (verified on at least one).
5. All commands GPU-touching -> run-tagged blocks for Charlie; capture script stays `--report-only`-capable.

- [ ] Steps: extend capture script -> hand Charlie the run block -> collect artifacts -> README tables -> commit `docs: phase 3 evidence (image translation artifacts)` -> ledger + master-plan checkboxes.

---

## Self-review notes

- Spec coverage: master-plan Phase 3 tasks 1-5 map to Tasks 1-5 here; the master plan's "skip decorative/logo images via VLM classification" is deliberately narrowed to source-language gating v1 (a VLM classification pass costs a GPU call per image and the spike must first prove the VLM is trustworthy at all); flagged as a gate-review item and a Phase 4 candidate metric instead.
- Type consistency: `TextRegion`/`RegionBBox`/`RegionEngine` (Task 2) are consumed verbatim by Tasks 3-5; `OverlayRegion.lines/fontSizePt` line up with `TranslatedSegment.fittedLines/fittedSizePt` (Phase 1 types, unchanged).
- The stats feature (landing separately) needs no changes for images: detection time lands in the extract phase timing by construction.
