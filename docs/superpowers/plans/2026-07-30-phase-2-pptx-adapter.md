# Phase 2: PPTX Adapter + Minimal Runner UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Tasks run sequentially (shared OOXML layer evolves across tasks). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real .pptx decks translate end to end with zero text loss and formatting preserved, runnable from a first usable UI.

**Architecture:** An in-house OOXML layer (JSZip + @xmldom/xmldom, lossless DOM round-trip) under `src/core/adapters/pptx/`; geometry resolution turns shapes/placeholders/tables/groups into pt-denominated boxes; the adapter emits shape-level TextSegments with `groupKey = slide<N>` and applies translations by rewriting run text and font sizes. The renderer gets a minimal runner (drop, languages, progress, open result) over a typed IPC contract.

**Tech Stack:** jszip, @xmldom/xmldom (new deps), existing core (FitEngine, batching, backend, pipeline), React renderer, Playwright.

**Master plan:** [2026-07-29-local-translate-master-plan.md](2026-07-29-local-translate-master-plan.md)

## Global Constraints (inherited + phase-specific)

- All master-plan constraints (content preservation, measure-then-single-insert, no cloud calls, conventional commits, no co-author lines, TDD, src/core Electron-free).
- OOXML units: EMU everywhere in the XML; 12700 EMU = 1 pt; `a:rPr sz` is hundredths of a point. All conversions happen at the adapter boundary; core types stay pt.
- Lossless rule: anything the adapter does not deliberately change must survive byte-identical through open->save (verified by test). PowerPoint's repair dialog on any produced file = instant task failure.
- Segment granularity v1: one segment per text body (shape/placeholder), text = paragraphs joined with `\n`; one segment per table cell; one per notes shape. `groupKey = slide<N>` (notes: `slide<N>-notes`), `context` = role ("slide title", "body", "table cell", "notes", ...).
- Fit fidelity margin: PowerPoint's text wrap is not skia's; the adapter passes boxes shrunk by a WRAP_SAFETY factor (default 0.96 of width) and text-frame insets (`a:bodyPr` lIns/rIns/tIns/bIns, defaults 91440/45720 EMU) are subtracted. The factor is a named constant with a doc comment; the phase gate includes visual verification in PowerPoint.
- Notes segments are translated but never font-shrunk (notes pane scrolls); adapter passes a no-op box (sentinel: fit skipped for kind 'notes').
- Unsupported-but-present content (charts, WordArt, OLE, video) is skipped with a per-item log line and counted in the run report; it must never corrupt or be dropped from the file.
- Carried-forward from Phase 1 final review (this phase fixes them where marked):
  - groupContext derivation: when a group's segments have mixed contexts, `pipeline.ts` derives the prompt's groupContext from groupKey + the set of distinct roles (Task 3 fixes this).
  - Fractional font sizes (11.25pt-style autofit values) join the fit regression grid (Task 3 tests).
  - Benchmark/CLI concurrency constraint and think-param verification stay Phase 4 items.

## Task sequence

```
Task 1 (OOXML layer + fixture deck builder)
  -> Task 2 (geometry resolution)
    -> Task 3 (pptx adapter extract/apply + pipeline groupContext fix)
      -> Task 4 (runner UI + typed IPC)
        -> Task 5 (phase gate: real decks, live model, evidence)
```

---

### Task 1: OOXML layer + fixture deck builder (subagent)

**Files:**

- Create: `src/core/adapters/pptx/ooxml.ts`, `tests/helpers/build-pptx.ts`
- Test: `tests/core/pptx/ooxml.test.ts`
- Modify: `package.json` (add jszip, @xmldom/xmldom)

**Interfaces produced:**

```ts
// ooxml.ts
export interface PptxArchive {
  listSlidePaths(): string[] // ppt/slides/slideN.xml, sorted by N
  listNotesPaths(): string[] // ppt/notesSlides/notesSlideN.xml
  readXml(partPath: string): Document // parsed DOM, cached per part
  markDirty(partPath: string): void // only dirty parts are re-serialized
  layoutPathFor(slidePath: string): string | null // via slide rels
  masterPathFor(layoutPath: string): string | null // via layout rels
  save(outPath: string): Promise<void> // untouched parts copied byte-identical
}
export function openPptx(filePath: string): Promise<PptxArchive>
// DOM helpers (namespace-aware, a: and p: URIs as constants)
export function elems(parent: Node, ns: string, local: string): Element[] // descendants
export function childElems(parent: Element, ns: string, local: string): Element[]
export function textOfRun(r: Element): string // a:t content, '' if none
export function setRunText(r: Element, text: string): void
```

**Behavior contract (each point encoded by a test):**

1. Open->save with zero edits produces a file whose every part is byte-identical to the input (compare via unzip digest, not zip bytes - zip metadata may differ). Test uses a builder-produced deck AND asserts part-level sha256 equality.
2. `setRunText` + save: only the dirtied slide part changes; all other parts stay byte-identical.
3. `readXml` on a slide exposes `a:t` runs findable via `elems(doc, A_NS, 't')`; `textOfRun`/`setRunText` round-trip CJK and XML-special characters (`<`, `&`, quotes) with correct escaping.
4. `listSlidePaths` orders slide10 after slide9 (numeric, not lexicographic).
5. `layoutPathFor`/`masterPathFor` resolve through `_rels` correctly on the builder's deck.
6. Corrupt/non-zip input -> clear error naming the file; never a hang or a partial write.

**Fixture builder (`tests/helpers/build-pptx.ts`):** programmatically assembles a minimal valid .pptx (content types, rels, presentation.xml, 1 master + 1 layout + N slides) from option structs:

```ts
buildPptx(opts: {
  slides: Array<{
    shapes: Array<{
      kind: 'textbox' | 'placeholder' | 'table' | 'group' | 'picture'
      // textbox: text (string[], paragraphs), box (EMU), fontPt?, bold?, fontFamily?
      // placeholder: phType ('title' | 'body'), text; box OMITTED (inherited)
      // table: rows of cell strings, colWidthsEmu, rowHeightsEmu, box
      // group: children (nested shapes), box + chOff/chExt for transform tests
      // picture: 1x1 png bytes (embedded image part)
    }>
    notes?: string
  }>
  layoutPlaceholderBox?: { phType: string; box: EMU-box }   // on the layout
  masterPlaceholderBox?: { phType: string; box: EMU-box }   // on the master
}): Promise<Buffer>
```

The builder is test infrastructure: plain template literals building the XML parts are fine; it does NOT reuse ooxml.ts (independent construction so tests are not self-referential).

- [ ] Steps: install deps -> failing ooxml tests (use builder) -> implement -> green -> full check -> commit `feat: lossless pptx ooxml layer with fixture deck builder`.

---

### Task 2: Geometry resolution (subagent)

**Files:**

- Create: `src/core/adapters/pptx/geometry.ts`
- Test: `tests/core/pptx/geometry.test.ts`

**Interfaces produced:**

```ts
export interface ResolvedBox {
  wPt: number
  hPt: number
}
export interface ShapeGeom {
  box: ResolvedBox | null // null = no constraint resolvable (fit engine skipped, size preserved)
  fontPt: number | null // explicit run size if present, else placeholder default, else null
  insetsPt: { l: number; r: number; t: number; b: number }
}
export function resolveShapeGeom(opts: {
  shape: Element // p:sp / p:graphicFrame / nested child
  slideDoc: Document
  layoutDoc: Document | null
  masterDoc: Document | null
  groupScale?: { sx: number; sy: number } // accumulated group transform
}): ShapeGeom
export function tableCellBoxes(graphicFrame: Element): ResolvedBox[][] // [row][col], merges unioned
export function groupChildScale(grpSp: Element): { sx: number; sy: number } // chExt vs ext ratio
```

**Behavior contract (tests on builder decks from Task 1):**

1. Textbox with explicit `a:xfrm`: box = ext EMU / 12700, minus bodyPr insets (explicit or default 91440/45720 EMU sides).
2. Placeholder with no slide-level xfrm: box inherited from layout's matching `p:ph` (type+idx), falling back to master; default font size from placeholder-type defaults when no run size (title 44, body 18 - becquet's table).
3. Nested group: child box scaled by ext/chExt ratio, compounded across two levels of nesting.
4. Table: cell w from `a:gridCol` widths, h from `a:tr` heights; horizontal merge (gridSpan) unions column widths; vertical merge (vMerge) unions row heights.
5. `sz="1125"` run -> fontPt 11.25 (fractional preserved, feeds the fit grid).
6. Anything unresolvable returns `box: null` (never a guessed box) - logged by the adapter, size preserved.

- [ ] Steps: failing tests -> implement -> green -> full check -> commit `feat: pptx geometry resolution with placeholder inheritance`.

---

### Task 3: PPTX adapter extract/apply + groupContext derivation (subagent)

**Files:**

- Create: `src/core/adapters/pptx/pptx-adapter.ts`
- Modify: `src/core/pipeline.ts` (groupContext derivation), `src/core/cli.ts` (register PptxAdapter)
- Test: `tests/core/pptx/pptx-adapter.test.ts`, extend `tests/core/pipeline.test.ts`, extend fit grid in `tests/core/fit/fit-engine.test.ts`

**Interfaces produced:** `PptxAdapter implements FormatAdapter` (`name: 'pptx'`, `extensions: ['.pptx']`).

**Extract contract:**

1. Walks every slide in order: top-level shapes, grouped shapes (recursive, transform-aware), tables (per cell), then the slide's notes shape.
2. Segment ids are stable addresses: `slide2/shape[name=Title 1]/tb`, `slide3/table[gf-name]/r2c4`, `slide1/notes` (exact scheme documented in the adapter; uniqueness guaranteed by appending an ordinal when names collide - covered by a test with duplicate shape names).
3. Segment text: paragraphs joined `\n`; runs concatenated within a paragraph; empty/whitespace-only bodies skipped.
4. `font` from first non-empty run (family via `a:latin`/`a:ea` typeface by script, size via geometry resolution); `groupKey = slide<N>`; `context` = role from placeholder type or shape kind.
5. SmartArt (`ppt/diagrams/data*.xml` reachable from the slide): extracted as segments with the graphicFrame's box and context 'smartart'; charts/OLE/WordArt/video: skipped with one log line each, never touched on apply.

**Apply contract:**

1. For each translated segment: locate the same node by id; write the translation's lines... precisely: paragraphs of the translation (split on `\n`) map onto existing `a:p` elements 1:1 when counts match; when counts differ, all text goes into the first paragraph's first run and surplus paragraphs' runs are emptied (formatting elements retained). First run keeps its `a:rPr`; sibling runs in a replaced paragraph are emptied, not deleted.
2. Font size: set `sz` (hundredths, rounded to nearest 25 = quarter-point) on every non-empty run in the body to the fitted size ONLY when fitted size differs from original; autofit elements (`a:normAutofit fontScale/lnSpcReduction`) are removed when we set an explicit size (we are the autofit now).
3. Notes segments: text replaced, size untouched.
4. Untranslated segments (keptOriginal): body untouched entirely (not rewritten with identical text - zero-diff guarantee).
5. Output validity: every produced file passes a structural integrity check (unzips, every XML part parses, content-types complete).

**Pipeline change (carried-forward fix):** groupContext for a group = `"<groupKey>: <sorted unique roles joined ', '>"` (e.g. "slide3: body, slide title, table cell"); falls back to sole context when no groupKey. Unit test updated.

**Fit grid extension:** add fractional sizes (11.25, 12.3) and a 200-char CJK paragraph to the fixture grid.

**Round-trip integration suite:** builder decks covering: multi-paragraph textbox, title+body placeholders inheriting layout boxes, 3x3 table with merges, two-level nested group, CJK-heavy deck (all-Chinese content), notes, deck with a picture + chart (skip path). For each: extract -> mock-translate (reverse strings or fixed map, no live model) -> apply -> re-extract asserts: every segment accounted, translations present, untouched parts byte-identical, integrity check passes.

- [ ] Steps: failing tests -> implement -> green -> full check -> commit `feat: pptx adapter with lossless apply` (+ separate commit for the pipeline groupContext change if cleaner).

---

### Task 4: Minimal runner UI + typed IPC (subagent)

**Files:**

- Create: `src/main/translate-service.ts` (wires pipeline into main process), `src/renderer/src/runner/Runner.tsx` (+ small components), `src/shared/ipc-contract.ts` (types shared by main/preload/renderer)
- Modify: `src/main/index.ts`, `src/main/ipc.ts` (new), `src/preload/index.ts`, `src/renderer/src/App.tsx`
- Test: `tests/e2e/runner.spec.ts` (Playwright), unit tests for translate-service argument mapping

**IPC contract (exact):**

```ts
// invoke channels
'translate:run'    (req: { filePath: string; sourceLang: string; targetLang: string }) -> RunReport
'translate:cancel' () -> void        // v1: cancels between groups (flag checked in pipeline onProgress)
'app:openPath'     (path: string) -> void
// renderer-bound events
'translate:progress' (e: { done: number; total: number; phase: string })
'translate:state'    (e: { state: 'idle' | 'starting-ollama' | 'translating' | 'done' | 'error'; message?: string })
```

- Language list: the 20 becquet languages as a shared constant in `src/shared/languages.ts` (English, Chinese (Simplified), Chinese (Traditional), Japanese, Korean, Spanish, French, German, Portuguese (Brazilian), Italian, Dutch, Polish, Swedish, Indonesian, Vietnamese, Turkish, Thai, Arabic, Hindi, Russian).
- UI: drop zone (accepts .pptx and .fake.json via registered adapters) + file picker fallback, source/target dropdowns (persisted to localStorage), progress bar with phase label, result panel with "Open result" and "Show in folder", error panel with the actionable message (incl. Ollama download URL case).
- Main process: preload exposes `window.localTranslate.translate(...)` etc. via contextBridge (no direct ipcRenderer leak); translate-service holds the OllamaConnection across runs and stops it on app quit.
- E2E: Playwright drives the built app: drop the mini fake fixture, assert progress appears and a result path renders. Live-model E2E is LOCAL-ONLY (skipped when `LT_E2E_LIVE!=1`) so CI stays hermetic; CI still runs the UI smoke against a dead-backend error path (asserts the actionable error panel).

- [ ] Steps: failing e2e/unit -> implement -> green (local live run once with LT_E2E_LIVE=1) -> full check -> commit `feat: minimal runner ui over typed ipc`.

---

### Task 5: Phase gate (integrator, live)

- [ ] 1. Obtain real decks: Charlie's benchmark pptx (requested; place under `fixtures/real/` - git-lfs or local-only, decision recorded when it lands) plus at least one CJK business deck. Until the benchmark deck arrives, gate on builder decks + any real deck available.
- [ ] 2. CLI live run: `npm run translate -- <real-deck>.pptx English "Chinese (Simplified)"` -> zero missing segments in the report, output passes integrity check, opens clean in PowerPoint (no repair dialog), visual spot-check: no text overflows its box (Charlie or screenshot review).
- [ ] 3. UI live run: same deck through the runner UI with LT_E2E_LIVE=1.
- [ ] 4. Evidence per Charlie's standard (artifacts only, no process screenshots): extend `PHASES` in `scripts/capture-evidence.mjs` with phase-2 (original deck + translated deck per direction) and run it, so `EVIDENCE/phase-2/` holds the original .pptx and its translated outputs for direct inspection.
- [ ] 5. Full `npm run check` + CI green + evidence committed.

## Risks

| Risk                                                                    | Mitigation                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| skia wrap != PowerPoint wrap -> fitted text still clips in PowerPoint   | WRAP_SAFETY margin + insets subtracted + visual gate step; factor tunable in one place                                                                                    |
| xmldom serialization subtly reorders/loses XML (namespaces, attributes) | Lossless rule tested at part level from Task 1 day one; only dirty parts re-serialized                                                                                    |
| Placeholder inheritance edge cases (missing layout, odd idx matching)   | box:null fallback preserves size rather than guessing; logged                                                                                                             |
| Real-world decks break assumptions builder decks never hit              | Task 5 gates on real decks; every skip/fallback logs loudly; repair-dialog = fail                                                                                         |
| SmartArt apply corrupts diagrams                                        | SmartArt apply covered by integrity + re-extract tests; if it proves fragile mid-phase, downgrade SmartArt to extract-and-report-only and record the descope in this plan |

## Self-review

- Master-plan coverage: master Phase 2 tasks 1-5 map 1:1 (ooxml -> 1, geometry -> 2, adapter -> 3, round-trip suite -> 3, minimal UI -> 4 + gate 5).
- Interfaces consistent with Phase 1: PptxAdapter implements the existing FormatAdapter; boxes/fonts in pt with unit suffixes; groupKey per the sanctioned contract.
- No placeholders: every task carries either code-level interfaces or numbered behavior contracts with test mappings.
- Carried-forward items from the Phase 1 final review are explicitly placed (Task 3) or explicitly deferred to Phase 4 (benchmark-related).
