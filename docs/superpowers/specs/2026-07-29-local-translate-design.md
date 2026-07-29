# local_translate - Design

**Date:** 2026-07-29
**Status:** Approved by Charlie (design review 2026-07-29)
**License decision:** AGPL-3.0 (approved; unlocks the official `mupdf` engine)
**Repo:** https://github.com/acbecquet/local-translate

## Problem

Every existing translator worth using requires a cloud service.
Most of document translation is deterministic processing, and the part that needs AI can now run entirely locally.
The goal: select any file on the computer, click "Translate", and get an intelligently translated file in the target language with formatting intact.

Translation itself is the easy part.
The hard part is maintaining formatting across languages, and the solution is a hard constraint: every translated string must fit its original text box, with font size adjusted until ALL text fits with zero cutoffs.

Open models evolve constantly, so the app is built as an evolving service: new models can be quickly battle-tested against the current champion and promoted if better.

## Predecessor lessons (becquet-translator)

The Python predecessor (tkinter + Anthropic API) proved the workflow and taught three hard PDF lessons that now apply to every format:

1. Measure fit on a throwaway surface first, then do a single real insert at the chosen size.
   Never retry inserts on the real document.
2. Redact/clear text regions in a way that preserves images and line art.
   Compute tight rects from visible (non-whitespace) spans only.
3. A failed translation or missing font must never remove content.
   Better to leave the original text than to blank a region.

Its weaknesses drive this redesign: cloud dependency, one API call per text box, crude font halving on CJK-to-Latin pptx paths, and a Python/PyInstaller distribution chain.

## Decisions (settled 2026-07-29)

| Decision           | Choice                                                                           |
| ------------------ | -------------------------------------------------------------------------------- |
| App shell          | Electron + TypeScript, one language end to end                                   |
| LLM runtime        | Managed Ollama behind a backend abstraction; embedded engine possible later      |
| Release gate       | PPTX, XLSX, PDF, PNG, JPG all translating with zero text loss                    |
| Image text         | Full in-place translation via local vision models                                |
| License            | AGPL-3.0                                                                         |
| Context menu label | "Translate with local translate"                                                 |
| Platform           | Windows first (Charlie's machine); nothing chosen precludes cross-platform later |

## Target hardware profile

- AMD Radeon RX 9070 XT (16 GB VRAM) + 32 GB RAM.
- GPU acceleration is Vulkan/ROCm territory, not CUDA. Ollama handles this natively; node-llama-cpp has Vulkan prebuilts if the embedded backend ever lands.
- Comfortable model range: 2B to ~30B MoE.

## Architecture

Electron main process orchestrates; renderer is UI only; document processing and inference calls run off the UI thread (utility process / worker threads).

```
┌─ Renderer (UI) ──────────────────────────────────────────┐
│ drop zone / progress / settings / model manager /        │
│ benchmark dashboard                                       │
└──────────────────────────┬───────────────────────────────┘
                           │ IPC
┌─ Main + workers ─────────┴───────────────────────────────┐
│                                                          │
│  FormatAdapter (per format)                              │
│    extract(file) -> TextSegment[]                        │
│    apply(file, TranslatedSegment[]) -> outputFile        │
│                                                          │
│  TranslationService                                      │
│    batches segments -> TranslationBackend                │
│                                                          │
│  FitEngine                                               │
│    (text, box, font) -> { fontSize, wrappedLines }       │
│                                                          │
│  OllamaBackend (implements TranslationBackend)           │
│    lifecycle: detect -> spawn standalone `ollama serve`  │
│    auto-pull, structured output, vision calls            │
│                                                          │
│  BenchmarkHarness                                        │
│    corpus x roster x metrics -> report + champion        │
└──────────────────────────────────────────────────────────┘
```

## Core abstraction: TextSegment

Every format reduces to positioned text segments.

```ts
interface TextSegment {
  id: string // stable address, e.g. "slide3/shape7/para2"
  text: string // source text, line breaks preserved
  box: { w: number; h: number } // fit constraint (pt or px)
  font: FontSpec // family, size, bold, italic, color
  context: string // "slide title", "table cell", "image region"
  kind: 'shape' | 'table-cell' | 'sheet-cell' | 'pdf-block' | 'image-region' | 'notes'
}
```

Adapters extract segments and apply translations back.
The pipeline between those two calls is format-agnostic.
A new file format is exactly one new adapter.

## FitEngine

The differentiator.
One shared module used by every adapter and the image overlay renderer.

- Registers the document's actual font files plus bundled CJK fallbacks (Noto Sans CJK) with skia-canvas, whose `measureText` is font-fallback-aware and returns per-run metrics.
- Algorithm: wrap text at box width, measure wrapped block, descend font size (1 pt steps above 6 pt, 0.5 pt steps below, floor 0.5 pt) until both dimensions fit.
  Returns final size and wrapped lines.
- Measurement always happens on a throwaway canvas; the real document gets exactly one write.
- The same skia-canvas instance later draws image overlays, so measured layout and rendered output are pixel-identical.
- Font metrics fixtures (known strings at known sizes in known boxes) form the regression suite.

## TranslationService and backends

```ts
interface TranslationBackend {
  listModels(): Promise<ModelInfo[]>
  pullModel(name: string, onProgress): Promise<void>
  translateBatch(req: BatchRequest): Promise<BatchResponse> // JSON-schema constrained
  readImageText(image: Buffer, langPair): Promise<ImageRegion[]>
}
```

### OllamaBackend lifecycle

1. Probe `http://127.0.0.1:11434` for an existing server; use it if present.
2. Otherwise spawn the standalone CLI build (`ollama serve` as a child process) with `OLLAMA_HOST` on an app-chosen port and `OLLAMA_MODELS` in the app data directory.
   The tray/desktop app is never launched.
   The standalone zip is the documented path for embedding; the GUI installer's silent mode is known-broken (ollama#7969) and is not used.
3. If no Ollama exists at all, offer in-app download of the standalone build with streamed progress.
4. Graceful shutdown of any server the app spawned (never kill a server the user was already running).

### Batch translation protocol

- Segments are grouped per slide/sheet/page with document-level context (source/target language, domain glossary such as SDR/HC expansions).
- One prompt per group; response is JSON-schema constrained: `[{ id, translation }]`.
- Validation: response parses against schema, ids match 1:1, no empty translations, no source-language echoes.
  Any failure retries once, then falls back to per-segment calls, then leaves original text.
- Known Ollama bug designed around: `think=false` on reasoning models (gemma4, qwen3.5) silently drops the schema constraint (ollama#15260).
  Per-model capability probing at first use decides thinking mode; when thinking stays on, the reasoning trace is stripped before parsing.
- Content preservation is absolute: no segment is ever cleared unless a validated translation exists for it.

## Format adapters

| Format                  | Engine                                                                            | Notes                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PPTX                    | In-house OOXML layer: JSZip + XML walk of `a:r`/`a:t` runs, `a:rPr sz` for size   | No python-pptx equivalent exists in JS (verified 2026-07); wrappers are pre-1.0 and do this internally anyway. Covers text boxes, placeholders (with layout/master inheritance for box geometry and default sizes), tables, grouped shapes, SmartArt, speaker notes. |
| XLSX                    | `@protobi/exceljs` (live community fork; upstream ExcelJS stalled ~3 years)       | Box = column width x row height. CJK font-size logic ported from becquet. Known fork gaps (pivot tables, exotic conditional formats) accepted and documented.                                                                                                        |
| PDF                     | `mupdf` npm 1.28+ (official Artifex WASM port, AGPL)                              | Structured text with rects, redaction annotations, text insertion. All three becquet lessons implemented. Image-preservation behavior of JS redactions is under-documented upstream, so a spike test gates this adapter's phase.                                     |
| PNG/JPG                 | Vision model -> FitEngine -> skia-canvas overlay -> sharp for I/O and compositing | Vision model returns text regions with bounding boxes. jimp ruled out (bitmap fonts, no CJK).                                                                                                                                                                        |
| Embedded images in PPTX | Same image sub-pipeline; media part is extracted, translated, re-embedded         | Required for the benchmark deck.                                                                                                                                                                                                                                     |
| DOCX                    | Post-release: same in-house OOXML approach walking `w:r`/`w:t`                    | Not in the release gate.                                                                                                                                                                                                                                             |

## Benchmark harness

The "constantly evolving service" mechanism.

- **Corpus:** Charlie's complicated benchmark pptx (embedded images with text) plus synthetic fixtures covering known-hard cases (long German compounds, dense CJK tables, tiny text boxes).
- **Roster:** any Ollama model by name. Launch cohort: gemma4:e2b, gemma4:e4b, gemma4:12b, qwen3.5:4b, qwen3.5:8b, qwen3:30b, plus qwen3-vl for the vision dimension.
- **Metrics per run:**
  - Completeness: % segments with validated translations (no echoes, no empties).
  - Format fidelity: overflow incidents, minimum font size reached, fit-engine retry counts.
  - Quality: LLM-judge scoring by a larger local model, plus a side-by-side A/B human viewer (reference-free MT metrics alone are weak).
  - Speed: segments/minute, wall-clock per document, tokens/second.
- **Output:** persisted JSON runs + HTML report; champion model becomes the app default.
- **Challenger flow:** `ollama pull` new model, one click to run it against the champion on the stored corpus, promote if it wins.

## UI and distribution

- UI phases: (1) minimal runner: drop file, pick languages, progress, open result; (2) full app: settings (model per task, language pairs, fit rules), model manager, benchmark dashboard.
  Layout and settings live in a user-editable JSON config for full flexibility.
- Explorer integration: installer registers a right-click verb "Translate with local translate" for supported extensions.
- Installer: electron-builder -> NSIS. Auto-update: electron-updater against GitHub Releases.
- Privacy stance: no network calls except localhost Ollama, model pulls from ollama.com, and update checks against GitHub.

## Error handling principles

| Failure                       | Behavior                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| Backend/model call fails      | Retry once, then per-segment fallback, then keep original text; log with segment id |
| Structured output invalid     | Same ladder; never trust unparsed text into a document                              |
| Font missing for measurement  | Fall back to bundled Noto fonts; log substitution                                   |
| Fit impossible even at 0.5 pt | Insert at 0.5 pt anyway, flag segment in the run report                             |
| Ollama spawn fails            | Surface actionable error with log path; app remains usable for benchmark browsing   |
| Any unexpected adapter error  | Original file is never modified in place; output is always written to a new file    |

## Testing

- Unit: FitEngine metrics fixtures, OOXML walkers on minimal hand-built documents, batch protocol validation.
- Integration: round-trip tests per adapter on real fixture documents; every segment accounted for in the output.
- E2E: Playwright driving the Electron app through drop-translate-open flows.
- Golden corpus: the benchmark deck round-trips with zero missing segments before any release.
- Verification rule inherited from becquet: no "done" claim without opening the produced artifact.

## Non-goals (v1)

- No cloud translation backends of any kind.
- No DOCX in the release gate (first post-release adapter).
- No macOS/Linux builds in the release gate.
- No custom model distribution/fine-tuning; Ollama registry models only.
- No translation memory/glossary editor UI (glossary is a config file for now).

## Success criteria

1. Right-click any pptx/xlsx/pdf/png/jpg, click "Translate with local translate", get a translated file with every source segment present and fitted, with no cloud calls.
2. Ollama never has to be manually started or its UI opened.
3. The benchmark harness ranks the launch cohort on the benchmark deck and crowns a champion with evidence.
4. A brand-new Ollama model can be battle-tested against the champion in one sitting without code changes.
