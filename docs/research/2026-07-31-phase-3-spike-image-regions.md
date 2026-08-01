# Phase 3 Spike: Region-Engine Decision

**Date:** 2026-08-01 (spike run window 2026-07-31 to 2026-08-01)
**Decision:** PP-OCR (CPU, `@gutenye/ocr-node`, ch_PP-OCRv4) is the Task 2 region engine.
**Harness:** `scripts/spike-image-regions.mjs` against 10 ink-true-labeled synthetic fixtures + 4 unlabeled real crops from the benchmark deck (`scripts/make-image-fixtures.mjs`).
**Scoring:** greedy IoU matching at 0.5 (strict) and 0.4 (relaxed), exact union-coverage recall at 70% area, text accuracy as 1 - normalized Levenshtein, per-image wall time.
The scorer self-tests to 100% on every metric via the `mock:labels` replay engine.

## Results

| engine                       | run by  | recall@.5                                                               | precision@.5    | mean IoU | text acc           | wall/img | VRAM            |
| ---------------------------- | ------- | ----------------------------------------------------------------------- | --------------- | -------- | ------------------ | -------- | --------------- |
| ocr:ppocr (CPU)              | agent   | 73.5%                                                                   | 89.3%           | 68.2%    | 98.9%              | ~100ms   | 0               |
| vlm:glm-ocr                  | Charlie | 0% (no usable boxes)                                                    | 0%              | N/A      | ~perfect (eyeball) | ~1s      | 2.2GB           |
| vlm:qwen3.5:9b               | Charlie | no scored run (see failure ladder below)                                |                 |          |                    | ~3.4s    | 6.6GB           |
| vlm:qwen3.6:35b (a3b q4_K_M) | Charlie | 50.0% as-emitted; 94% (17/18) on the 6 images with decodable convention | 100% of matched | 70.4%    | 100.0%             | 5-29s    | 16GB + ~9GB RAM |

qwen3.6:35b detail (offline corner-convention rescore of the live run):
region counts were perfect on all 10 images (including the 8-cell grid and zero regions on the textless probe - no hallucinations), reading was perfect including CJK, but the model filled the schema's `w,h` fields with `x2,y2` corner coordinates on most images, emitted true `w,h` on others, and MIXED both conventions within single images on 3 of 10.
The harness now auto-detects per-image corner convention (positive-extent + lower-mutual-overlap rule), but intra-image mixing is undecodable in principle.

## Why PP-OCR wins (decision criteria 2 and 3 from the plan)

1. Box quality is at parity with the best VLM this machine can load (68.2% vs 70.4% mean IoU), and PP-OCR's convention is stable by construction.
2. Two orders of magnitude faster (100ms vs 5-29s per image; the real deck has 39 raster images).
3. Zero VRAM: the GPU stays fully available for the translation model - no model swapping, no allocation pressure on a machine already at its limit (qwen3.6:35b required a clean reboot to load at all and is disqualified as a product engine on fit alone).
4. Reading accuracy 98.9% on matched regions including CJK - the hybrid "OCR boxes + VLM crop-read" upgrade (criteria case 3) is NOT needed v1; it remains a documented option if real-deck reading quality disappoints at the phase gate.
5. Its known weaknesses are bounded and handleable (below), while the VLM weakness (convention instability) is unbounded and per-request.

## Known PP-OCR limitations (Task 2 must handle)

1. Same-row cell merging in table-like content: 8-cell grid detected as 2 full-row lines (0% per-cell recall, but rows read at 96-99% confidence with correct text).
   v1 behavior: accept merged-row regions as single segments (translate + repaint the row); per-cell splitting is a possible future refinement via column-gap splitting on the detection polygon.
2. Small-CJK boxes run slightly tight: img04 missed strict but hit 100% at relaxed.
   Task 2 uses a small symmetric box dilation (1-2px) before painting to absorb this plus antialiasing fringes.
3. Confident hallucinations on glossy textless photos ("@" at 0.89, "02 DWWC" at 0.70 on the real coil-photo crops) - confidence gating alone is insufficient.
   Task 2 adds content gates on top of `CONFIDENCE_FLOOR`: minimum 2 non-punctuation characters AND a source-language check (the existing gating rule) AND a minimum region size floor; gated regions are skip-with-log, never painted.
4. Rotated text garbles (rotated y-axis label on the real chart crop) - already out-of-scope v1 per the plan (skip-with-log).

## Spike learnings that bind later phases

1. THINKING MODE MUST ALWAYS BE EXPLICITLY RESOLVED (Charlie directive, 2026-08-01).
   qwen3.5:9b under a forced JSON schema with thinking active returned empty content on every image.
   Every model interaction - spike legs, Task 2 ladder, Phase 4 benchmark harness, backend probes - must disable or explicitly account for thinking, with a fallback retry for models that reject the `think` parameter.
2. Ollama's `format` JSON-schema enforcement is NOT reliable across model families: with `think: false`, qwen3.5:9b ignored the schema entirely and returned a markdown-fenced bare array.
   Any future VLM integration needs the harness's full lenient-parse ladder (fence stripping, bare-array unwrap, bbox key/convention aliases, corner disambiguation) - schema forcing is an optimization, never a guarantee.
3. Machine envelope confirmed (31.2GB RAM, RX 9070 XT 16GB): qwen3.6:35b a3b q4_K_M (24GB) loads only on a clean boot with pinned host offload of ~9GB and is the hard ceiling.
   Models known to require less than this envelope are safe; anything at or above it is not a product-viable dependency.
   Failed loads leak ROCm pinned/nonpaged memory until reboot - the harness aborts a leg on the first allocation-class failure and this circuit-breaker pattern should carry into the Phase 4 benchmark harness.
4. The benchmark deck contains zero CJK-bearing raster images (all PNGs are English chart/table screenshots, all JPGs textless photos), so the phase gate exercises embedded-image translation almost entirely in the EN to ZH direction.

## Rejected alternatives

- VLM as primary engine: convention instability (above) plus speed plus VRAM contention.
- glm-ocr as primary: perfect transcription but no localization under any parseable convention we could elicit (degenerate 0,0,1,1-class boxes); noted as the leading candidate crop-reader if the hybrid upgrade is ever needed.
- qwen3.5:9b / gemma4:e4b legs: left unrun after the 35b ceiling run made the decision insensitive to their results; either can be run later with the current harness for curiosity without changing the Task 2 contract.
