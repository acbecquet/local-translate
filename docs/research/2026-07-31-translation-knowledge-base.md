# Translation knowledge base: LinguaHaru, tinbox, RTranslator

Distilled from source-level research (2026-07-30/31) of three open translation projects, per Charlie's direction to use them as an optimization knowledge base.
Full research reports live in the session records; this doc keeps only the actionable distillate and the adoption decision for each item.

## Sources

- [LinguaHaru](https://github.com/YANG-Haruka/LinguaHaru) (GPL-3.0, Python, v6.6 2026-07-21): broad-format document translator; strong batching/validation; heuristic-only document text fit; measured fit for images only.
- [tinbox](https://github.com/strickvl/tinbox) (Python CLI, 2026-04): LLM document translation with three chunking algorithms, checkpoint/resume, LLM-emitted glossary.
- [RTranslator](https://github.com/niedev/RTranslator) (Android, 10.3k stars, v2.00): fully offline NLLB-600M + Whisper via ONNX Runtime, aggressive on-device optimization.

## Adoption decisions

| #   | Technique (source)                                                                                                                         | Decision                                                                                                                                                 | Where                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | Insert `a:normAutofit` IN ADDITION to our explicit fitted `sz` (LinguaHaru `_set_shrink_to_fit`)                                           | ADOPT - belt and suspenders: PowerPoint re-shrinks if our wrap model diverges residually; our explicit size remains the deterministic primary            | Phase 2 gate follow-up (pptx adapter apply)      |
| 2   | Repetition-degeneracy detection via compression ratio > ~4 (LinguaHaru `translation_checker.py`)                                           | ADOPT - cheap addition to the validation ladder ('degenerate' failure reason); catches runaway small-model loops                                         | Validation ladder (batching.ts), Phase 4 window  |
| 3   | Batch token budget scaled to model context window (~40% for local models) (LinguaHaru backend)                                             | ADOPT - replaces our fixed 2000-char group cap once model context is queryable via ollama show                                                           | Phase 4 (harness needs per-model configs anyway) |
| 4   | Structural-token validation: placeholders/format sentinels must survive translation verbatim (LinguaHaru `_structural_intact`)             | ADOPT when we have structured tokens worth protecting (numbers, codes already echo-exempt; revisit at xlsx formulas/pdf)                                 | Phase 5                                          |
| 5   | Rolling context window in prompts: previous group's source + translation + next-group lookahead (tinbox context-aware mode)                | ADOPT - terminology/tone coherence across slides without extra calls; maps 1:1 onto our group batching                                                   | prompts.ts/batching.ts, Phase 4                  |
| 6   | LLM-emitted glossary growth in the same structured call (`glossary_extension` field) (tinbox)                                              | ADOPT LATER - pairs with the glossary config file; adds schema field + accumulation, no extra pass                                                       | Post-release glossary milestone                  |
| 7   | Atomic checkpoint/resume with config-match validation (tinbox `checkpoint.py`)                                                             | ALREADY PLANNED for benchmark harness resumability; tinbox pattern (temp+rename, per-input key, restore rolling context) is the reference implementation | Phase 4 harness                                  |
| 8   | Boundary-priority splitting (paragraph > sentence > line > clause > word) for oversized single segments (tinbox `chunks.py`)               | ADOPT for PDF blocks / giant single segments exceeding batch budget                                                                                      | Phase 5 (pdf adapter)                            |
| 9   | Per-language-pair quality TIER LIST with warned opt-in for weak pairs (RTranslator's 31-language curated set)                              | ADOPT - benchmark harness output becomes a per-model, per-pair tier table, surfaced in the UI as quality badges                                          | Phase 4 metrics/report                           |
| 10  | Prefer quality-aware quantizations (selective precision; K-quants over naive) (RTranslator int8-with-exclusions)                           | ADOPT as benchmark dimension: same model at different quants is a roster axis                                                                            | Phase 4 roster config                            |
| 11  | Small dedicated MT models as challengers: MADLAD-400-3B, HY-MT1.5-1.8B (RTranslator v3.0 roadmap; HY-MT claims 235B-class quality at 1.8B) | ADOPT - add to the benchmark cohort where GGUF/Ollama builds exist; license-check each (NLLB itself is non-commercial - excluded)                        | Phase 4 cohort                                   |
| 12  | OCR stack alternative: RapidOCR/PP-OCRv6 ONNX + LaMa inpainting for image text (LinguaHaru image pipeline)                                 | EVALUATE in Phase 3 spike alongside our VLM-region plan; their measured `_fit_text` independently validates our fit-engine-drives-overlay design         | Phase 3 spike                                    |
| 13  | Offline asset pre-provisioning (fonts/models bundled as versioned zips) (LinguaHaru v6.6)                                                  | ADOPT principle for installer: first-run must work on an offline machine except model pulls                                                              | Phase 6                                          |

## Explicitly rejected

- Sliding-window translation with exact-substring overlap merging (tinbox, deprecated by its own author): fragile against LLM output variance.
- Page-by-page with zero cross-page context (tinbox PDF mode): the "seam repair" its design promised was never shipped; our grouping + rolling context (item 5) is the better shape.
- Delegating document text fit to host-app autofit alone (LinguaHaru pptx): leaves the file without correct sizes and has a 70%-scale floor beyond which text overflows; our measured fit stays primary (item 1 adds their mechanism only as a secondary net).
- Cloud-default engine configuration (LinguaHaru ships DeepSeek cloud as default): violates our no-cloud constraint.
- Dollar-cost tracking (tinbox): meaningless for all-local; token/latency estimation patterns fold into benchmark metrics instead.
- NLLB-600M as an embedded model (RTranslator): non-commercial license and no instruction-following/JSON capability; its optimization PIPELINE (graph splitting, KV-cache surgery) is noted for any future embedded ONNX backend, the model itself is not.

## Quality-evidence gap worth knowing

None of the three projects has a rigorous small-model translation-quality benchmark for business documents (tinbox: none; RTranslator: informal hand-curated language list; LinguaHaru: none).
Our Phase 4 harness remains the differentiator and should produce exactly what the ecosystem lacks: per-model, per-language-pair, per-metric evidence on a fixed corpus.
