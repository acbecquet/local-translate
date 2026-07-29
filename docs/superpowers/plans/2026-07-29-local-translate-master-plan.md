# local_translate Master Implementation Plan

> **For agentic workers:** This is the master multi-phase roadmap.
> Each phase is executed via its own detailed phase plan written at phase start (REQUIRED SUB-SKILL at that point: superpowers:writing-plans, then superpowers:subagent-driven-development or superpowers:executing-plans).
> Do not begin implementing a phase without its phase plan.

**Goal:** Build local_translate, a fully local Electron app that translates any file (pptx, xlsx, pdf, png, jpg at release) into a target language while fitting every translated string into its original text box, backed by managed Ollama models and a benchmark harness that keeps the model choice evidence-based.

**Architecture:** Format adapters reduce every file to positioned TextSegments; a format-agnostic pipeline batch-translates them through a TranslationBackend abstraction (managed Ollama first); a shared FitEngine guarantees zero text cutoffs; a BenchmarkHarness ranks models on a fixed corpus and crowns the champion default.

**Tech Stack:** Electron + TypeScript + Vite, vitest, Playwright, skia-canvas, sharp, JSZip + @xmldom/xmldom (OOXML), @protobi/exceljs (xlsx), mupdf npm (pdf, AGPL), ollama npm client, zod + zod-to-json-schema, electron-builder (NSIS), electron-updater.

**Spec:** [2026-07-29-local-translate-design.md](../specs/2026-07-29-local-translate-design.md)

## Global Constraints

- License: AGPL-3.0. LICENSE file present from Phase 0; all deps must be AGPL-compatible.
- Windows first. Nothing may hard-block later macOS/Linux ports (no registry access outside the installer/context-menu module).
- GPU is AMD (RX 9070 XT, 16 GB): never assume CUDA. Ollama handles GPU; any future embedded backend must use Vulkan.
- Content preservation is absolute: no segment is cleared unless a validated translation exists for it; input files are never modified in place.
- Measure-then-single-insert: fit measurement happens on throwaway surfaces; the real document receives exactly one write per segment.
- Context-menu label is exactly "Translate with local translate".
- No cloud calls, ever. Allowed network: localhost Ollama, ollama.com model pulls, GitHub release checks.
- Commit style: conventional commits (feat:/fix:/docs:/test:/chore:), no co-author lines, commit at every green-test checkpoint.
- Markdown files: one sentence per line. No em dashes anywhere (use "-").
- TDD throughout: every module lands with its failing test written first.
- Node >= 24, npm >= 11 (dev machine has 24.14.0 / 11.9.0).

## File Structure (locked at master level)

```
local_translate/
  LICENSE                      AGPL-3.0
  package.json
  tsconfig.json
  electron-builder.yml
  vite.config.ts
  src/
    main/                      Electron main process only
      index.ts                 app lifecycle, window, single-instance lock
      ipc.ts                   typed IPC contract main<->renderer
      context-menu.ts          Explorer verb registration (Windows-only module)
      updater.ts               electron-updater wiring
    core/                      zero Electron imports; pure Node, fully unit-testable
      segments.ts              TextSegment, TranslatedSegment, FontSpec types
      pipeline.ts              extract -> translate -> fit -> apply orchestration
      fit/
        fonts.ts               font registration + Noto CJK fallbacks
        fit-engine.ts          wrap + measure + descend algorithm
      translate/
        backend.ts             TranslationBackend interface + ModelInfo types
        ollama/
          lifecycle.ts         detect / spawn standalone serve / stop
          download.ts          standalone build fetch with progress
          ollama-backend.ts    TranslationBackend impl
        batching.ts            grouping, zod schema, validation ladder
        prompts.ts             prompt templates + glossary injection
      adapters/
        adapter.ts             FormatAdapter interface + registry by extension
        pptx/
          ooxml.ts             zip open/save, XML DOM helpers (shared with docx later)
          geometry.ts          shape box resolution incl. placeholder inheritance
          pptx-adapter.ts
        xlsx/
          xlsx-adapter.ts
        pdf/
          pdf-adapter.ts       mupdf structured text, redaction, insertion
        image/
          regions.ts           vision-model region reading + bbox validation
          overlay.ts           skia-canvas draw + sharp composite
          image-adapter.ts     png/jpg entry; also serves embedded pptx media
      bench/
        corpus.ts              corpus registry + fixture manifest
        harness.ts             run matrix: corpus x roster
        metrics.ts             completeness / fidelity / speed
        judge.ts               LLM-judge quality scoring
        report.ts              JSON persistence + HTML report
        champion.ts            champion/challenger state
    renderer/                  UI (Vite + minimal framework chosen in Phase 0)
      runner/                  drop zone, language pick, progress, open result
      settings/
      models/
      bench/                   dashboard + A/B viewer
  fonts/                       bundled Noto Sans + Noto Sans CJK
  fixtures/                    test documents (small, committed) + benchmark deck (git-lfs or local-only)
  tests/                       mirrors src/core structure
  docs/superpowers/specs/
  docs/superpowers/plans/
```

Boundary rule: `src/core` never imports Electron or renderer code, so the whole engine runs headless (CLI, tests, CI) by construction.

---

## Phase 0: Scaffold

**Goal:** A committed, building, testable Electron+TS skeleton wired to the GitHub repo.

**Tasks:**

1. `npm create` Electron+Vite+TS scaffold; pin versions; `LICENSE` (AGPL-3.0), `.gitignore`, `README.md` stub with the problem statement.
2. vitest + first trivial test green; Playwright smoke test launches the empty window.
3. lint (eslint + prettier) + `npm run check` script (typecheck + lint + test).
4. electron-builder config producing an unsigned NSIS installer locally.
5. GitHub Actions: check + build on push.
6. Renderer framework decision recorded in phase plan (default: React, matching ecosystem weight; revisit only if Charlie objects).

**Verification gate:** `npm run check` green; installer builds; CI green on GitHub; empty app launches from installer.

**Risks:** none material.

---

## Phase 1: Core engine

**Goal:** Headless pipeline proven end to end against a fake adapter: segments in, validated fitted translations out, via a live managed Ollama.

**Tasks:**

1. `segments.ts` types + `adapter.ts` interface + in-memory FakeAdapter for tests.
2. `fonts.ts`: bundle Noto Sans + Noto Sans CJK, registration with skia-canvas, family-fallback resolution, substitution logging.
3. `fit-engine.ts` (TDD against metrics fixtures): wrap at box width, measure block, descend 1 pt steps above 6 pt / 0.5 pt below, floor 0.5 pt; returns `{ fontSize, lines[] }`; property test: result always fits, larger size never fits.
4. `lifecycle.ts`: probe 127.0.0.1:11434; spawn standalone `ollama serve` with app-scoped `OLLAMA_HOST`/`OLLAMA_MODELS`; never kill a server we did not spawn; graceful stop.
5. `download.ts`: fetch standalone Windows build with streamed progress + checksum.
6. `ollama-backend.ts` + `batching.ts` + `prompts.ts`: per-group prompts, zod schema `[{id, translation}]`, validation ladder (schema -> id match -> non-empty -> no source echo), retry once -> per-segment fallback -> keep original.
   Probe per model for the think/format bug (ollama#15260); persist per-model capability flags.
7. `pipeline.ts`: orchestration with progress events; CLI entry (`npm run translate -- <file> <src> <tgt>`) using FakeAdapter.

**Interfaces produced (later phases rely on these exact shapes):**

```ts
FormatAdapter { extensions: string[]; extract(path): Promise<TextSegment[]>; apply(path, out, translated: TranslatedSegment[]): Promise<void> }
FitEngine.fit(text, box, font): { fontSize: number; lines: string[] }
TranslationBackend.translateBatch(req: BatchRequest): Promise<BatchResponse>
Pipeline.run(file, langPair, opts, onProgress): Promise<RunReport>
```

**Verification gate:** with Ollama not running, CLI run on FakeAdapter spawns serve, translates a 50-segment fixture EN->ZH and ZH->EN on gemma4:e4b with 100% segment accounting; kill -9 mid-run leaves no orphan ollama process on next run.

**Risks:** think/format bug behavior differs per model (mitigated by capability probing); skia-canvas native binary in Electron (validated in this phase, fallback @napi-rs/canvas behind fonts.ts).

---

## Phase 2: PPTX adapter + minimal runner UI

**Goal:** Real decks translate end to end with zero text loss; first usable UI.

**Tasks:**

1. `ooxml.ts` (TDD on hand-built minimal decks): open zip, DOM-parse slide XML, enumerate `a:t` runs grouped by paragraph/shape, write back losslessly (byte-identical when nothing edited).
2. `geometry.ts`: shape box from `spPr`; placeholder box + default font size inheritance layout -> master; table cell boxes from grid geometry; grouped shape recursion with child transform.
3. `pptx-adapter.ts`: extract (text boxes, placeholders, tables, grouped shapes, SmartArt text, speaker notes) -> apply with FitEngine sizes; run-format preservation (first-run formatting carries, becquet style); skip-list for non-translatable runs (numbers, whitespace).
4. Round-trip integration suite on fixture decks incl. a CJK-heavy deck; segment accounting report: every extracted id present in output.
5. Minimal runner UI: drop file, language pick, per-slide progress, open result; wired over typed IPC to pipeline.

**Verification gate:** benchmark deck (text portion) translates EN<->ZH with zero missing segments, zero overflow incidents in the run report, opens clean in PowerPoint; PowerPoint repair dialog = instant fail.

**Risks:** OOXML edge cases (SmartArt, WordArt, charts) - handled by explicit skip-with-log rather than corruption; charts deferred to post-release, logged visibly.

---

## Phase 3: Image text (vision pipeline)

**Goal:** PNG/JPG files and images embedded in pptx get in-place translated text.

**Tasks:**

1. Spike (gates the phase): bbox accuracy of qwen3-vl and gemma4 vision on 10 labeled fixture images; decide prompt strategy (normalized coords, region re-verification crop pass) and accuracy threshold.
2. `regions.ts`: readImageText via backend vision call; bbox sanity validation (bounds, overlap, min size); confidence gating - low-confidence regions are reported, not painted.
3. `overlay.ts`: background sampling for fill color, FitEngine sizing, skia-canvas text draw, sharp composite; original image never discarded (output is a copy).
4. `image-adapter.ts` for standalone png/jpg.
5. pptx embedded-media hookup: extract media parts, run image sub-pipeline, re-embed; skip decorative/logo images via VLM classification prompt.

**Verification gate:** fixture set of photographed/screenshot text images round-trips with all regions translated and readable; benchmark deck now fully translates including its embedded images.

**Risks:** VLM bboxes are the weakest link (spike + re-crop verification pass + confidence gating); text-on-busy-background rendering quality (background sampling; acceptable-quality bar set by Charlie during phase review).

---

## Phase 4: Benchmark harness

**Goal:** The model question answered with evidence; champion crowned.

**Tasks:**

1. `corpus.ts` + fixture manifest: benchmark deck + synthetic hard cases (long German compounds, dense CJK tables, tiny boxes, image text).
2. `harness.ts`: corpus x roster matrix runner reusing Pipeline; resumable; per-run isolation of model + settings.
3. `metrics.ts`: completeness %, fidelity (overflow count, min font size, fallback-ladder hits), speed (segments/min, tokens/s).
4. `judge.ts`: LLM-judge rubric scoring with the largest fitting local model; judge prompt stability test (same input scores within tolerance across 3 runs).
5. `report.ts`: JSON run store + HTML report; `champion.ts` state.
6. Dashboard UI + side-by-side A/B slide viewer (rendered via headless export of before/after).
7. Run the launch cohort: gemma4:e2b/e4b/12b, qwen3.5:4b/8b, qwen3:30b + qwen3-vl vision dimension; crown champion; record results doc in repo.

**Verification gate:** full cohort run completes unattended on the benchmark deck; report ranks models on all four metric families; champion set as app default via config, not code.

**Risks:** LLM-judge reliability (stability test + human A/B viewer as backstop); 30B-class runs are slow - acceptable, runs are resumable and unattended.

---

## Phase 5: XLSX + PDF adapters

**Goal:** Release-gate formats complete.

**Tasks:**

1. `xlsx-adapter.ts` on @protobi/exceljs (TDD): cell text + rich-text runs, box from column width x row height (with merged-cell union), becquet CJK font logic ported, number/date/formula cells skipped; round-trip suite incl. styles.
2. PDF spike (gates PDF work): mupdf npm redaction behavior over images/line art on fixture PDFs; verify structured-text rects + insertion positioning (upstream issue #157); go/no-go on mupdf vs escalation options.
3. `pdf-adapter.ts`: structured text blocks -> tight rects from visible spans -> segments; redact with image/line-art preservation; measure via FitEngine (fontkit metrics for PDF font advances where canvas metrics diverge); single insertion per block; CJK font embedding fallback chain.
4. PDF round-trip suite: the becquet golden checklist (every block present, logos intact, line art preserved) reproduced on fixture PDFs.

**Verification gate:** xlsx fixture with merged cells + CJK round-trips clean in Excel; fixture PDFs pass the golden checklist; both formats runnable from the runner UI.

**Risks:** mupdf.js redaction image-preservation is under-documented (spike first; fallback: explicit image-rect exclusion from redaction rects, same trick becquet used); WASM memory on large PDFs (page-by-page processing).

---

## Phase 6: App completion + distribution

**Goal:** The "right-click any file" product experience, installable.

**Tasks:**

1. Full settings UI backed by user-editable JSON config: model per task (text/vision/judge), language pairs, fit rules, glossary file path.
2. Model manager UI: list/pull/remove, per-model capability flags, champion indicator.
3. `context-menu.ts` + installer integration: Explorer verb "Translate with local translate" for .pptx/.xlsx/.pdf/.png/.jpg; invoking it opens the app straight into a translation run for that file.
4. electron-builder NSIS installer: bundles fonts; Ollama standalone handled at first run (download flow), not bundled (3+ GB).
5. electron-updater against GitHub Releases; version sync from package.json only.
6. First-run experience: detect/download Ollama, pull champion model with progress, sample translation.

**Verification gate:** clean Windows VM (or pristine user account): install from GitHub release, right-click a pptx, "Translate with local translate", get output with zero manual Ollama interaction; auto-update from a previous tagged build verified.

**Risks:** unsigned-binary SmartScreen friction (documented for users; signing decision deferred to Charlie); context-menu registry hygiene on uninstall (covered in installer tests).

---

## Phase 7: Evolving-model loop + release

**Goal:** The service that outlives any single model.

**Tasks:**

1. Challenger flow UI: enter any Ollama model name -> pull -> benchmark vs champion on stored corpus -> promote/reject with one click; result appended to results history.
2. Model watchlist doc + lightweight check: surface new notable Ollama library releases in the model manager (manual refresh, no telemetry).
3. Docs: README (install, privacy stance, how it works), CONTRIBUTING, benchmark methodology page with launch-cohort results.
4. DOCX adapter noted as first post-release milestone (reuses ooxml.ts).
5. Release v1.0.0: tag, GitHub release with installer, release-gate checklist executed (all five formats, zero-text-loss corpus run, clean-VM install).

**Verification gate:** the release-gate checklist from the spec passes end to end; a never-before-tested model goes from name -> pulled -> benchmarked -> promoted entirely through the UI.

---

## Phase sequencing rationale

- PPTX before everything format-shaped because the benchmark deck is pptx and drives the model decision (Charlie's stated priority).
- Image text before the benchmark so the benchmark measures the full deck, including its embedded images.
- Benchmark before the remaining formats so xlsx/pdf work runs on the evidence-chosen champion.
- Spikes (VLM bbox, mupdf redaction) sit at the head of their phases and gate them, so surprises surface before dependent work.

## Master-level self-review notes

- Spec coverage: every spec section maps to a phase (adapters -> 2/3/5, fit -> 1, backend -> 1, benchmark -> 4, UI/distribution -> 2/6, evolving loop -> 7, error principles -> global constraints + per-phase gates).
- Interfaces are named once in Phase 1 and referenced verbatim afterwards.
- No placeholder work items: every task names its files and its proof.
