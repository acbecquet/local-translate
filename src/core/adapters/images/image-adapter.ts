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

export interface ImageAdapterOpts {
  /** This run's source language, passed straight into isSourceLanguageRegion
   * for every detected region (plan Task 4 behavior contract point 2). */
  sourceLang: string
}

/** One-line-region font size estimate (plan Task 4 behavior contract point
 * 1): a region's bbox height IS its rendered line height, and line height
 * is fontSizePt * lineHeightFactor everywhere else in this codebase
 * (fit-engine.ts's own LINE_HEIGHT_FACTOR, mirrored - not exported - by
 * overlay.ts too; see overlay.ts's doc comment on why it can't just import
 * fit-engine's). Multi-line regions are out of scope v1 - PP-OCR/VLM
 * detection emits one box per text line, never a merged paragraph box, so
 * "one line fills the whole box height" is always the right estimate here. */
const ONE_LINE_HEIGHT_FACTOR = 1.2

const NOTO_SANS = 'Noto Sans'
const NOTO_SANS_CJK_SC = 'Noto Sans CJK SC'

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
        if (region.rotated) {
          skips.push({ id: region.id, reason: 'rotated region' })
          continue
        }

        paintable.set(region.id, region)
        segments.push({
          id: region.id,
          text: region.text,
          box: { wPt: region.bbox.w, hPt: region.bbox.h },
          font: {
            family: containsCjk(region.text) ? NOTO_SANS_CJK_SC : NOTO_SANS,
            sizePt: region.bbox.h / ONE_LINE_HEIGHT_FACTOR
          },
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
      const overlayRegions: OverlayRegion[] = []
      for (const [id, region] of paintable) {
        const seg = bySegId.get(id)
        if (!seg) continue
        if (seg.translation === seg.text) continue

        overlayRegions.push({
          bbox: region.bbox,
          lines: seg.fittedLines,
          fontSizePt: seg.fittedSizePt,
          font: seg.font
        })
      }

      const buffer = await readFile(filePath)
      const result = await renderOverlay(buffer, overlayRegions)
      await writeFile(outPath, result.image)
    }
  }
}
