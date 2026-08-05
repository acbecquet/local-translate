// PNG/JPG FormatAdapter over a RegionEngine (Phase 3, Task 4): turns
// detected text regions into ordinary `image-region` TextSegments so the
// existing pipeline (translate, FitEngine) needs zero changes, then paints
// translations back via overlay.ts on apply(). See plan Task 4:
// docs/superpowers/plans/2026-07-31-phase-3-image-text.md
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadImage } from 'skia-canvas'
import type { FormatAdapter } from '../adapter'
import type { TextSegment, TranslatedSegment } from '../../segments'
import {
  CONFIDENCE_FLOOR,
  validateRegions,
  type RegionEngine,
  type TextRegion
} from '../../images/regions'
import { renderOverlay, type OverlayRegion } from '../../images/overlay'
import { containsCjk, isSourceLanguageRegion } from '../../images/gating'
import { inkMatchedFontSizePt, refinePaintSizes, sizingAxesFor } from '../../images/sizing'

export interface ImageAdapterOpts {
  /** This run's source language, passed straight into isSourceLanguageRegion
   * for every detected region (plan Task 4 behavior contract point 2). */
  sourceLang: string
}

const NOTO_SANS = 'Noto Sans'
const NOTO_SANS_CJK_SC = 'Noto Sans CJK SC'

/**
 * Mirrors fit-engine.ts's own LINE_HEIGHT_FACTOR (module-private there, so
 * not importable) - the same low-risk duplicated-constant approach
 * overlay.ts and pptx-adapter.ts's SPAUTOFIT_LINE_HEIGHT_FACTOR already
 * take. Used ONLY to size the fit BUDGET below (extract()'s emitted
 * `box.hPt`), never for painting - overlay.ts still fills/paints the
 * dilated `bbox` regardless of this value.
 */
const FIT_LINE_HEIGHT_FACTOR = 1.2

/** `{ id, reason }` skip record shape shared with FormatAdapter.collectSkips()'s contract (adapter.ts). */
interface Skip {
  id: string
  reason: string
}

/**
 * Creates a FormatAdapter for standalone .png/.jpg/.jpeg files over `engine`
 * (any RegionEngine - PP-OCR now, a VLM or hybrid later, chosen behind the
 * fixed interface regions.ts defines). `opts.sourceLang` is fixed for this
 * adapter instance's lifetime - registry.ts's buildAdapters() constructs a
 * fresh instance per run with that run's source language (AdapterDeps).
 */
export function createImageAdapter(engine: RegionEngine, opts: ImageAdapterOpts): FormatAdapter {
  /** Skips recorded by the MOST RECENT extract() call - the standard
   * FormatAdapter.collectSkips() contract (adapter.ts): "the MOST RECENT
   * extract() call", a single slot, not per-path - runPipeline always calls
   * extract() then collectSkips() then apply() on the same file in one
   * sequential run. Mirrors pptx-adapter.ts's own `lastSkips` field. */
  let lastSkips: Skip[] = []

  /**
   * Paintable (gated-in) regions from each path's most recent extract()
   * call, keyed by path.resolve(filePath) -> region id -> TextRegion.
   * Unlike lastSkips above, this IS keyed by path: apply()'s "was extract()
   * ever run for THIS exact path" check (behavior contract point 4) needs
   * per-path history, not just "was extract() ever called at all" - an
   * adapter instance could in principle extract() more than one file
   * before either gets applied.
   */
  const regionsByPath = new Map<string, Map<string, TextRegion>>()

  return {
    name: 'image',
    extensions: ['.png', '.jpg', '.jpeg'],

    async extract(filePath: string): Promise<TextSegment[]> {
      const buffer = await readFile(filePath)
      const img = await loadImage(buffer)
      const raw = await engine.detectRegions(buffer)
      const validated = validateRegions(raw, img.width, img.height)

      const skips: Skip[] = []
      const paintable = new Map<string, TextRegion>()
      const segments: TextSegment[] = []
      const groupKey = path.basename(filePath)

      for (const region of validated) {
        // Source-language gating: a region whose text isn't in the run's
        // source language is legitimate leave-alone content (a logo, a part
        // number) - NO segment, and it must NOT show up in collectSkips()
        // either (plan behavior contract point 2 - this isn't "unsupported
        // content", it's correctly left untouched). Checked before
        // confidence/rotation so a region we'd never translate anyway is
        // never reported as merely low-confidence or rotated.
        if (!isSourceLanguageRegion(opts.sourceLang, region.text)) continue

        if (region.confidence < CONFIDENCE_FLOOR) {
          skips.push({ id: region.id, reason: 'low-confidence region' })
          continue
        }
        // A rotated region is only paintable once it carries a known
        // rotation ANGLE (from withRotationPasses/rotation.ts - it actually
        // read the text upright in a rotated copy of the image). `rotated:
        // true` WITHOUT an angle is the in-place skew guess the spike doc
        // proved unreliable to size/paint from - that keeps the original,
        // conservative skip path (TextRegion.rotated's own doc comment,
        // regions.ts).
        if (region.rotated && !region.rotation) {
          skips.push({ id: region.id, reason: 'rotated region' })
          continue
        }

        paintable.set(region.id, region)
        const family = containsCjk(region.text) ? NOTO_SANS_CJK_SC : NOTO_SANS
        // {ink height target, fit box width, fit box height floor} - swapped
        // for a rotated (+-90) region since its text reads along the bbox's
        // HEIGHT (the run length) with ink thickness along its WIDTH; see
        // sizing.ts's sizingAxesFor for the full derivation. Horizontal
        // regions (the pre-rotation-support case) get back exactly what this
        // block used to compute inline: ink height = inkBBox.h (falling back
        // to the dilated bbox.h when inkBBox is absent, per the documented
        // TextRegion.inkBBox compatibility contract), fit width = bbox.w, fit
        // height floor = bbox.h.
        const axes = sizingAxesFor(region)
        // sizePt here is a required FontSpec field but unused by
        // inkMatchedFontSizePt itself (it measures at each candidate size
        // explicitly) - axes.inkHeightPx is a harmless placeholder.
        const sizePt = inkMatchedFontSizePt(
          region.text,
          { family, sizePt: axes.inkHeightPx },
          axes.inkHeightPx
        )
        // fit-engine.ts's height gate is `lines * sizePt * LINE_HEIGHT_FACTOR
        // <= box.hPt` (pipeline.ts calls fit(translation, seg.box, seg.font)
        // starting from THIS sizePt). Real ink-to-em ratios run well under
        // fit's 1.2 line-height assumption, so sizePt * FIT_LINE_HEIGHT_FACTOR
        // is almost always LARGER than the fit height floor alone - passing
        // the floor alone as box.hPt would make fit() immediately shrink back
        // toward the old bbox.h/1.2 heuristic on essentially every single-
        // line region, defeating ink-matching entirely (this was caught
        // live: see this commit's own fix). box.hPt is therefore a fit
        // BUDGET sized to accommodate the ink-matched size at fit's own
        // line-height assumption - NOT the paint region (bbox stays the
        // paint region; overlay.ts still fills/paints it exactly as before,
        // untouched by this value). Math.max keeps the fit height floor as
        // an absolute floor (never claim less room than the real dilated
        // region), though in practice the sizePt term dominates for any
        // realistic ink ratio.
        const fitHeightPt = Math.max(axes.fitBoxHPtFloor, sizePt * FIT_LINE_HEIGHT_FACTOR)
        segments.push({
          id: region.id,
          text: region.text,
          box: { wPt: axes.fitBoxWPt, hPt: fitHeightPt },
          font: { family, sizePt },
          context: 'image text region',
          groupKey,
          kind: 'image-region'
        })
      }

      lastSkips = skips
      regionsByPath.set(path.resolve(filePath), paintable)
      return segments
    },

    /** See FormatAdapter.collectSkips's doc comment (adapter.ts). */
    collectSkips(): Skip[] {
      return lastSkips
    },

    /**
     * Builds OverlayRegions from the regions CACHED by the most recent
     * extract() call on this exact path (never re-running engine.detectRegions
     * - that would risk a different, possibly non-deterministic detection
     * pass disagreeing with what extract() already reported/segmented), then
     * paints via renderOverlay and writes a copy to outPath - the original
     * file at `filePath` is never modified in place (plan Global
     * Constraints). A region whose id has no matching entry in `segments`
     * (keptOriginal, or simply absent) is left unpainted: original pixels
     * preserved beats painting the source text back on. A region whose
     * translation is identical to its source text is also left unpainted -
     * nothing changed, so there is nothing worth risking a repaint over.
     */
    async apply(filePath: string, outPath: string, segments: TranslatedSegment[]): Promise<void> {
      const key = path.resolve(filePath)
      const paintable = regionsByPath.get(key)
      if (!paintable) {
        throw new Error(
          `image adapter: apply() called for "${filePath}" without a prior extract() on this ` +
            'exact path - apply() must be called with the same file extract() read.'
        )
      }

      const bySegId = new Map(segments.map((s) => [s.id, s]))
      const pending: { region: TextRegion; seg: TranslatedSegment }[] = []
      for (const [id, region] of paintable) {
        const seg = bySegId.get(id)
        if (!seg) continue
        if (seg.translation === seg.text) continue
        pending.push({ region, seg })
      }
      // Final paint sizes resolved over the image's whole batch (sizing.ts's
      // refinePaintSizes): each single-line TRANSLATION's ink re-matched to
      // its region's original ink target, then noise-level size differences
      // snapped to a shared per-image value - mirrors pptx-adapter.ts's
      // media path so the two adapters can never paint-size differently.
      const sizes = refinePaintSizes(
        pending.map(({ region, seg }) => ({
          lines: seg.fittedLines,
          fittedSizePt: seg.fittedSizePt,
          font: seg.font,
          region
        }))
      )
      const overlayRegions: OverlayRegion[] = pending.map(({ region, seg }, i) => ({
        bbox: region.bbox,
        lines: seg.fittedLines,
        fontSizePt: sizes[i],
        font: seg.font,
        rotation: region.rotation
      }))

      const buffer = await readFile(filePath)
      const result = await renderOverlay(buffer, overlayRegions)
      await writeFile(outPath, result.image)
    }
  }
}

// Test-only visibility into FIT_LINE_HEIGHT_FACTOR (drift-guard test in
// tests/core/images/image-adapter.test.ts) - not part of this module's real
// interface, matching overlay.ts's/pptx-adapter.ts's own _internals convention.
export const _internals = { FIT_LINE_HEIGHT_FACTOR }
