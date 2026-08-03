/**
 * PPTX FormatAdapter: reduces a .pptx to TextSegments (extract) and writes
 * translations back into a lossless copy of the original file (apply).
 *
 * Both directions share one tree walk (`collectSites`) that assigns every
 * text-bearing node a stable, addressable id and resolves its box/font -
 * extract() maps the walk's output straight to TextSegment[]; apply() reruns
 * the SAME walk against the SAME source file (the pipeline always calls
 * apply() with the file extract() read) and, for every id it recognizes,
 * mutates that node's DOM in place. Because id derivation is a pure function
 * of the deck's own content, the two walks agree on every id without either
 * side needing to persist anything between calls.
 *
 * Id scheme (addresses, not opaque tokens - documented per the extract
 * contract):
 *   slide<N>/shape[name=<shape name>]/tb            - a shape's text body
 *   slide<N>/group[name=<g>]/.../shape[name=<s>]/tb - shape nested in group(s)
 *   slide<N>/table[gf-name=<name>]/r<R>c<C>          - a table cell (1-based)
 *   slide<N>/smartart[gf-name=<name>]/pt<modelId>    - a SmartArt data point
 *   slide<N>/notes                                   - the slide's notes body
 * A numeric `-2`, `-3`, ... suffix is appended whenever two nodes would
 * otherwise produce the identical id (e.g. two shapes sharing a name).
 */
import path from 'node:path'
import type { Document, Element, Node } from '@xmldom/xmldom'
import { loadImage } from 'skia-canvas'
import type { FormatAdapter } from '../adapter'
import type { Box, FontSpec, SegmentKind, TextSegment, TranslatedSegment } from '../../segments'
import {
  A_NS,
  P_NS,
  R_NS,
  RELS_NS,
  childElems,
  elems,
  listPictureMedia,
  openPptx,
  readMediaBytes,
  setRunText,
  textOfRun,
  writeMediaBytes,
  type PptxArchive
} from './ooxml'
import {
  groupChildScale,
  resolveShapeGeom,
  tableCellBoxes,
  type ResolvedBox,
  type WrapMode
} from './geometry'
import { measureWidestLine, wrapLines } from '../../fit/fit-engine'
import {
  CONFIDENCE_FLOOR,
  validateRegions,
  type RegionEngine,
  type TextRegion
} from '../../images/regions'
import { renderOverlay, type OverlayRegion } from '../../images/overlay'
import { containsCjk, isSourceLanguageRegion } from '../../images/gating'
import { inkMatchedFontSizePt } from '../../images/sizing'

/** DrawingML diagram (SmartArt) namespace - not part of ooxml.ts's exported constants (only a:/p:/r:/rels are). */
const DGM_NS = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
/** Cached-diagram-drawing namespace (Microsoft extension) - real PowerPoint's `ppt/diagrams/drawingN.xml` cached shape-tree parts use this; see resolveSmartArtDrawingPath. Its relationship (found in the DATA part's own `_rels/dataN.xml.rels`, not the slide's) is resolved by relId alone, via the existing resolveRelById helper - its Type isn't needed for that. */
const DSP_NS = 'http://schemas.microsoft.com/office/drawing/2008/diagram'

const REL_TYPE_NOTES_SLIDE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'

const GRAPHIC_URI = {
  chart: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  ole: 'http://schemas.openxmlformats.org/presentationml/2006/ole',
  diagram: 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
}

/**
 * PowerPoint's line-wrapping metrics don't exactly match the skia-canvas
 * measurement fit() uses, so a translated line that just barely fits our
 * measured width can still clip in real PowerPoint. Shrinking only the box
 * WIDTH we hand to fit() by this factor gives PowerPoint's own wrap a safety
 * margin; height is left alone since vertical fit (line count) isn't subject
 * to the same cross-renderer measurement mismatch.
 */
const WRAP_SAFETY = 0.96

/**
 * Box handed to fit() for segments that must never shrink from their
 * starting size: notes (the notes pane scrolls - there's no "overflow" to
 * fix) and any segment whose real geometry is unresolvable
 * (`ShapeGeom.box === null`, which per geometry.ts's contract means "size
 * preserved"). It's larger than any real slide could ever be (EMU slide
 * dimensions top out at a few thousand pt), so fit() always finds the
 * segment's starting size already fits and returns it unchanged - which is
 * exactly what apply() checks (`fittedSizePt === font.sizePt`) to decide
 * whether to touch `sz` at all.
 */
const SENTINEL_BOX: Box = { wPt: 1_000_000, hPt: 1_000_000 }

/**
 * Line-height factor used only by synthesizeSpAutoFitBox's height formula -
 * mirrors fit-engine.ts's own LINE_HEIGHT_FACTOR (module-private there, so
 * not importable - the same low-risk duplicated-constant approach overlay.ts
 * takes for the identical reason: a plain arithmetic constant carries none
 * of the gating-logic divergence risk that would make a real shared import
 * necessary).
 */
const SPAUTOFIT_LINE_HEIGHT_FACTOR = 1.2

/**
 * Sentinel stored in a SmartArt drawing-part update map (see
 * PptxAdapter.apply's `drawingUpdates`) in place of a translation, once a
 * source text is found to map to more than one DIFFERENT translation
 * within the same cached drawing part - i.e. two data points share
 * identical source text but got different translations (independently
 * translated, or one was hand-edited). Applying either translation to
 * every matching cached run would be a coin flip about which data point's
 * text a given cached shape actually corresponds to; applySmartArtDrawingText
 * treats this as "leave every matching run untouched and log it", the same
 * outcome as a text with no match at all, rather than silently picking
 * whichever translation happened to be seen last (last-write-wins).
 */
const AMBIGUOUS_TRANSLATION = Symbol('smartart-ambiguous-translation')

/** Used only when neither an explicit run size nor (for shapes) a placeholder-type default resolves anything. */
const DEFAULT_FALLBACK_FONT_PT = 18
/** Used only when a segment's first non-empty run carries no a:latin/a:ea typeface at all. */
const DEFAULT_FALLBACK_FONT_FAMILY = 'Calibri'

/**
 * Dependencies for the embedded-media (Phase 3, Task 5) hookup - mirrors
 * image-adapter.ts's own ImageAdapterOpts. `regionEngine: null` (the
 * default) means image translation is OFF: extract() adds zero image
 * segments and zero media skips, and apply() never rewrites a media part -
 * exactly Phase 2 behavior (plan Task 5 behavior contract point 4). Every
 * existing `new PptxAdapter()` call site in this codebase (tests included)
 * relies on this default, which is also what makes those call sites double
 * as the null-engine regression suite.
 */
export interface PptxAdapterDeps {
  regionEngine: RegionEngine | null
  /** This run's source language - passed to isSourceLanguageRegion for every detected media region. Unused when regionEngine is null. */
  sourceLang: string
}

const DEFAULT_PPTX_ADAPTER_DEPS: PptxAdapterDeps = { regionEngine: null, sourceLang: '' }

const MEDIA_NOTO_SANS = 'Noto Sans'
const MEDIA_NOTO_SANS_CJK_SC = 'Noto Sans CJK SC'

/** Raster extensions processed for embedded-media translation; anything else (emf/wmf/...) is a vector metafile - skip-with-log, never decoded (decoding one as a raster image would throw) - plan Task 5 behavior contract point 3. */
const RASTER_MEDIA_EXTENSIONS = new Set(['png', 'jpg', 'jpeg'])

/** CJK Unified Ideographs + Hiragana/Katakana + Hangul + compatibility/fullwidth forms - used only to pick a:ea vs a:latin typeface by script, a coarser heuristic than fit-engine's own wrap-break table (different job: family choice, not break opportunities). */
const CJK_RANGE = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

const ELEMENT_NODE = 1

interface Site {
  id: string
  kind: SegmentKind
  context: string
  groupKey: string
  text: string
  font: FontSpec
  box: Box
  /** The part to archive.markDirty() when this site's node is mutated. */
  partPath: string
  /** The `a:txBody` (shape/table cell/notes) or `dgm:t` (SmartArt point) element itself - has `a:bodyPr` + `a:p`* children directly, regardless of which wrapper it is. */
  bodyEl: Element
  /** SmartArt data-point sites only: the resolved cached `dsp:drawing` part path (see resolveSmartArtDrawingPath) mirroring this site's text, when the deck has one wired via the data part's extLst relId - undefined otherwise (no cached drawing, or not a SmartArt site at all). */
  smartArtDrawingPath?: string
  /**
   * `shape` sites only: true when this shape's autofit is spAutoFit AND
   * geom.box resolved to null (no explicit own ext, nothing to inherit
   * either - see handleSp/synthesizeSpAutoFitBox). apply()'s writeSize
   * passes this through to ensureNormAutofit, which skips converting
   * spAutoFit to normAutofit exactly when this is true (see its own doc
   * comment for why) - undefined/false for every other site, where the
   * flag has no effect either way.
   */
  preserveSpAutoFit?: boolean
}

export class PptxAdapter implements FormatAdapter {
  readonly name = 'pptx'
  readonly extensions = ['.pptx']

  /** Skips recorded by the MOST RECENT extract() call; read (and never re-populated) by apply() re-walking the same content, and by collectSkips(). */
  private lastSkips: { id: string; reason: string }[] = []

  /**
   * Per SOURCE FILE path (path.resolve'd), every PAINTABLE media-region
   * segment id -> {mediaPath, region} from the MOST RECENT extract() call
   * on that exact path. apply()'s lookup table for embedded-media
   * translation (Phase 3, Task 5): mirrors image-adapter.ts's own
   * regionsByPath cache (Task 4 behavior contract point 4) so apply() never
   * re-runs regionEngine.detectRegions - a second, possibly non-deterministic
   * detection pass must never disagree with what extract() already
   * segmented/reported.
   */
  private readonly mediaSegmentsByPath = new Map<
    string,
    Map<string, { mediaPath: string; region: TextRegion }>
  >()

  constructor(private readonly deps: PptxAdapterDeps = DEFAULT_PPTX_ADAPTER_DEPS) {}

  async extract(filePath: string): Promise<TextSegment[]> {
    const archive = await openPptx(filePath)
    const skips: { id: string; reason: string }[] = []
    const onSkip: SkipRecorder = (id, kind, name) => {
      console.warn(`pptx adapter: skipping unsupported ${kind} "${name}" - left untouched on apply`)
      skips.push({ id, reason: kind })
    }
    const sites = collectSites(archive, onSkip)
    const { segments: mediaSegments, paintableById } = await collectMediaSegments(
      archive,
      this.deps.regionEngine,
      this.deps.sourceLang,
      onSkip
    )

    this.lastSkips = skips
    this.mediaSegmentsByPath.set(path.resolve(filePath), paintableById)

    return [
      ...sites.map((s) => ({
        id: s.id,
        text: s.text,
        box: s.box,
        font: s.font,
        context: s.context,
        groupKey: s.groupKey,
        kind: s.kind
      })),
      ...mediaSegments
    ]
  }

  /** See FormatAdapter.collectSkips's doc comment (adapter.ts). */
  collectSkips(): { id: string; reason: string }[] {
    return this.lastSkips
  }

  /**
   * Reruns collectSites() against `filePath` (the same file extract() was
   * called on - runPipeline always passes the same `opts.file` to both) and,
   * for each segment whose translation actually differs from its extracted
   * source text, rewrites that node's paragraphs/runs and - only when the
   * fitted size differs from the size fitting started from - its run sizes.
   * A segment whose translation equals its source text (keptOriginal, or a
   * translation that legitimately came back unchanged) is never touched at
   * all: no setRunText call, no markDirty - the zero-diff guarantee the
   * apply contract requires. Because markDirty is only ever called for a
   * part that had at least one real mutation, a slide/notes/diagram part
   * with zero net changes is copied out byte-identical by archive.save().
   *
   * A SmartArt data-point site whose deck wires a cached `dsp:drawing` part
   * (site.smartArtDrawingPath - see resolveSmartArtDrawingPath) ALSO
   * collects its {source text -> translation} into `drawingUpdates`, keyed
   * by drawing part, so the cache stays in sync with the data model it
   * mirrors - handled in one batched pass per drawing part AFTER the main
   * loop (see applySmartArtDrawingText), since a drawing part's "which
   * runs are unmatched" question can only be answered once every one of
   * its diagram's data points has been considered, not one segment at a
   * time. When two data points in the SAME diagram share identical source
   * text but got DIFFERENT translations, that source text is recorded as
   * `AMBIGUOUS_TRANSLATION` instead of either translation - see its own
   * doc comment for why silently picking one (last-write-wins) is wrong.
   *
   * A segment id NOT found among the text sites is checked against the
   * MOST RECENT extract() call's cached media-region index instead (Phase
   * 3, Task 5): a matching, actually-changed (translation !== text) entry
   * queues an OverlayRegion for its media part, batched per part (one
   * `<p:pic>` can carry several detected text regions) and painted/rewritten
   * in one pass AFTER the main loop (see the final for-loop below) - only
   * media parts that end up with at least one queued region are ever
   * touched via writeMediaBytes; every other part - including a media part
   * whose regions ALL failed gating or all kept their original text - stays
   * byte-identical. A segment id matching NEITHER a text site NOR a cached
   * media region throws the same error a missing text site always has:
   * apply() must be called with the same file extract() already read
   * (media detection is cached-only - unlike text-site ids, which are pure
   * functions of the deck's own content, media ids can't be re-derived
   * without re-running regionEngine.detectRegions, which apply() never does).
   */
  async apply(filePath: string, outPath: string, segments: TranslatedSegment[]): Promise<void> {
    const archive = await openPptx(filePath)
    const siteById = new Map(collectSites(archive).map((s) => [s.id, s]))
    const drawingUpdates = new Map<string, Map<string, string | typeof AMBIGUOUS_TRANSLATION>>()
    const mediaSegIndex = this.mediaSegmentsByPath.get(path.resolve(filePath))
    const overlaysByMediaPath = new Map<string, OverlayRegion[]>()

    for (const seg of segments) {
      const site = siteById.get(seg.id)
      if (site) {
        if (seg.translation === seg.text) continue

        writeTranslation(site.bodyEl, seg.translation)
        archive.markDirty(site.partPath)

        if (site.smartArtDrawingPath) {
          let bySourceText = drawingUpdates.get(site.smartArtDrawingPath)
          if (!bySourceText) {
            bySourceText = new Map()
            drawingUpdates.set(site.smartArtDrawingPath, bySourceText)
          }
          const existing = bySourceText.get(seg.text)
          if (existing === undefined || existing === seg.translation) {
            bySourceText.set(seg.text, seg.translation)
          } else {
            bySourceText.set(seg.text, AMBIGUOUS_TRANSLATION)
          }
        }

        // Relies on fit-engine's fit() returning font.sizePt back bit-identically
        // (not merely a numerically-equal-but-recomputed value) whenever the
        // text already fits at the starting size - i.e. that this comparison
        // is a reliable proxy for "no shrink happened", not just a close one.
        if (site.kind !== 'notes' && seg.fittedSizePt !== seg.font.sizePt) {
          writeSize(site.bodyEl, seg.fittedSizePt, site.preserveSpAutoFit ?? false)
        }
        continue
      }

      const mediaEntry = mediaSegIndex?.get(seg.id)
      if (!mediaEntry) {
        throw new Error(
          `pptx adapter: apply() could not locate segment "${seg.id}" while re-walking "${filePath}" - ` +
            'apply() must be called with the same file extract() read.'
        )
      }
      // Zero-diff guarantee (mirrors image-adapter.ts's own apply()): a
      // region whose translation is identical to its source text is left
      // unpainted - nothing changed, nothing worth risking a repaint over.
      if (seg.translation === seg.text) continue

      const overlayRegions = overlaysByMediaPath.get(mediaEntry.mediaPath) ?? []
      overlayRegions.push({
        bbox: mediaEntry.region.bbox,
        lines: seg.fittedLines,
        fontSizePt: seg.fittedSizePt,
        font: seg.font
      })
      overlaysByMediaPath.set(mediaEntry.mediaPath, overlayRegions)
    }

    for (const [drawingPath, bySourceText] of drawingUpdates) {
      applySmartArtDrawingText(archive, drawingPath, bySourceText)
    }

    for (const [mediaPath, overlayRegions] of overlaysByMediaPath) {
      const buffer = await readMediaBytes(archive, mediaPath)
      const result = await renderOverlay(buffer, overlayRegions)
      writeMediaBytes(archive, mediaPath, result.image)
    }

    await archive.save(outPath)
  }
}

// ---- tree walk (shared by extract and apply) ----

/** Called for every unsupported-but-present thing collectSites' walk skips - `(id, kind, name)`, the same triple logSkip's console.warn is built from. */
type SkipRecorder = (id: string, kind: string, name: string) => void

interface WalkCtx {
  slideN: number
  slidePath: string
  slideDoc: Document
  layoutDoc: Document | null
  masterDoc: Document | null
  archive: PptxArchive
  usedIds: Set<string>
  sites: Site[]
  /**
   * Undefined when this walk must stay silent - specifically, apply()'s own
   * re-walk of the same content extract() already walked (and already
   * recorded/logged skips for). Passing a recorder only from extract() is
   * what fixes logSkip's double-firing: without this, every skip would be
   * logged/recorded once per collectSites() call, and runPipeline calls
   * extract() then apply() against the same file every run.
   */
  recordSkip?: SkipRecorder
}

/**
 * Walks every slide (and its notes) once, collecting every translatable
 * Site. `onSkip`, when given, is invoked for every unsupported-but-present
 * thing the walk skips along the way (see SkipRecorder) - extract() passes
 * a recorder that both logs AND accumulates into `collectSkips()`'s return
 * value; apply() passes none, since it re-walks the SAME content purely to
 * relocate nodes to write into, and extract() already reported those skips.
 */
function collectSites(archive: PptxArchive, onSkip?: SkipRecorder): Site[] {
  const sites: Site[] = []
  const usedIds = new Set<string>()

  for (const slidePath of archive.listSlidePaths()) {
    const slideN = slideNumberOf(slidePath)
    const slideDoc = archive.readXml(slidePath)
    const layoutPath = archive.layoutPathFor(slidePath)
    const layoutDoc = layoutPath ? archive.readXml(layoutPath) : null
    const masterPath = layoutPath ? archive.masterPathFor(layoutPath) : null
    const masterDoc = masterPath ? archive.readXml(masterPath) : null

    const ctx: WalkCtx = {
      slideN,
      slidePath,
      slideDoc,
      layoutDoc,
      masterDoc,
      archive,
      usedIds,
      sites,
      recordSkip: onSkip
    }

    const spTree = elems(slideDoc, P_NS, 'spTree')[0]
    if (spTree) walkContainer(spTree, { sx: 1, sy: 1 }, '', ctx)
    handleNotes(ctx)
  }

  return sites
}

// ---- embedded media (Phase 3, Task 5) ----

function mediaExtension(mediaPath: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(mediaPath)
  return m ? m[1].toLowerCase() : ''
}

function mediaBasename(mediaPath: string): string {
  return mediaPath.split('/').pop() ?? mediaPath
}

interface MediaCollectionResult {
  segments: TextSegment[]
  /**
   * Every PAINTABLE (gated-in) region's final segment id -> {mediaPath,
   * region} - the same shape PptxAdapter.mediaSegmentsByPath caches per
   * source file path for apply() to consume without re-detecting.
   */
  paintableById: Map<string, { mediaPath: string; region: TextRegion }>
}

/**
 * Detects and gates translatable text in every embedded picture's media
 * part, DEDUPED by part path (plan Task 5 behavior contract point 1): a
 * media part used by 3 `<p:pic>` elements across the deck is decoded and
 * run through regionEngine.detectRegions ONCE, not once per usage.
 * `regionEngine: null` short-circuits to zero segments/skips - exactly
 * Phase 2 behavior (behavior contract point 4).
 *
 * Segment ids are namespaced `media/<basename>#r<n>` (point 2) - a prefix no
 * text-site id ever uses (see the id scheme's doc comment atop this file),
 * so global uniqueness holds by construction; `uniqueId` is still applied
 * as the same cheap defense every other id in this file gets, in the
 *(real-world impossible, but not worth trusting blindly) case two
 * different media parts share a basename. `groupKey` is the FIRST slide
 * that uses the part (`listPictureMedia`'s usage order is numeric-slide,
 * then document order within a slide, so "first" is well-defined) -
 * formatted identically to a text site's own `slide<N>` groupKey so
 * batching.ts's groupSegments puts a media region's text in the same batch
 * as that slide's other text (point 2). `context` is the fixed
 * 'embedded image text' the plan specifies.
 *
 * Source-language gating (isSourceLanguageRegion) and the CJK font-family
 * pick (containsCjk) are IMPORTED from gating.ts, the exact same functions
 * image-adapter.ts imports - no reimplementation, so the two adapters can
 * never gate a given {sourceLang, text} pair differently (behavior contract
 * point 7).
 */
async function collectMediaSegments(
  archive: PptxArchive,
  regionEngine: RegionEngine | null,
  sourceLang: string,
  onSkip?: SkipRecorder
): Promise<MediaCollectionResult> {
  const paintableById = new Map<string, { mediaPath: string; region: TextRegion }>()
  if (!regionEngine) return { segments: [], paintableById }

  const usages = listPictureMedia(archive)
  const firstSlidePathByMedia = new Map<string, string>()
  for (const usage of usages) {
    if (!firstSlidePathByMedia.has(usage.mediaPath)) {
      firstSlidePathByMedia.set(usage.mediaPath, usage.slidePath)
    }
  }

  const usedIds = new Set<string>()
  const segments: TextSegment[] = []

  for (const [mediaPath, firstSlidePath] of firstSlidePathByMedia) {
    const name = mediaBasename(mediaPath)
    const ext = mediaExtension(mediaPath)
    if (!RASTER_MEDIA_EXTENSIONS.has(ext)) {
      onSkip?.(mediaPath, 'vector metafile image', name)
      continue
    }

    // Per-part isolation: a dangling relationship target, an undecodable
    // raster (mislabeled/corrupt bytes), or an engine failure on one image
    // must degrade to a skip for THAT part, never crash the whole extract -
    // same defensive stance as the SmartArt data-part reads above. The
    // untouched part stays byte-identical through save(), so a skipped
    // image is preserved content, not lost content.
    let img: Awaited<ReturnType<typeof loadImage>>
    let raw: TextRegion[]
    let buffer: Buffer
    try {
      buffer = await readMediaBytes(archive, mediaPath)
      img = await loadImage(buffer)
      raw = await regionEngine.detectRegions(buffer)
    } catch {
      onSkip?.(mediaPath, 'media part unreadable', name)
      continue
    }
    const validated = validateRegions(raw, img.width, img.height)
    const groupKey = `slide${slideNumberOf(firstSlidePath)}`

    for (const region of validated) {
      // Source-language gating: a region whose text isn't in the run's
      // source language is legitimate leave-alone content (a logo, a part
      // number) - NO segment, and it must NOT show up in collectSkips()
      // either, mirroring image-adapter.ts's own extract() (Task 4 point 2).
      if (!isSourceLanguageRegion(sourceLang, region.text)) continue

      const rawId = `media/${name}#${region.id}`
      if (region.confidence < CONFIDENCE_FLOOR) {
        onSkip?.(rawId, 'low-confidence region', name)
        continue
      }
      if (region.rotated) {
        onSkip?.(rawId, 'rotated region', name)
        continue
      }

      const id = uniqueId(rawId, usedIds)
      paintableById.set(id, { mediaPath, region })
      const mediaFamily = containsCjk(region.text) ? MEDIA_NOTO_SANS_CJK_SC : MEDIA_NOTO_SANS
      // SIZE authority is the PRE-dilation ink extent (regions.ts's
      // inkBBox), not the dilated bbox used for painting/fill - mirrors
      // image-adapter.ts's own extract() (polish-round Task C: replacement
      // text must occupy only the original space, exactly). Falls back to
      // the dilated bbox height when inkBBox is absent - the documented
      // TextRegion.inkBBox compatibility contract (regions.ts).
      const mediaInkHeightPx = region.inkBBox?.h ?? region.bbox.h
      segments.push({
        id,
        text: region.text,
        box: { wPt: region.bbox.w, hPt: region.bbox.h },
        font: {
          family: mediaFamily,
          // sizePt here is a required FontSpec field but unused by
          // inkMatchedFontSizePt itself (it measures at each candidate size
          // explicitly) - mediaInkHeightPx is a harmless placeholder.
          sizePt: inkMatchedFontSizePt(
            region.text,
            { family: mediaFamily, sizePt: mediaInkHeightPx },
            mediaInkHeightPx
          )
        },
        context: 'embedded image text',
        groupKey,
        kind: 'image-region'
      })
    }
  }

  return { segments, paintableById }
}

function slideNumberOf(slidePath: string): number {
  const m = /slide(\d+)\.xml$/.exec(slidePath)
  return m ? Number(m[1]) : 0
}

function walkContainer(
  container: Element,
  groupScale: { sx: number; sy: number },
  pathPrefix: string,
  ctx: WalkCtx
): void {
  for (const child of directChildElements(container)) {
    if (child.namespaceURI !== P_NS) continue
    switch (child.localName) {
      case 'sp':
        handleSp(child, groupScale, pathPrefix, ctx)
        break
      case 'pic':
        handlePic(child, pathPrefix, ctx)
        break
      case 'graphicFrame':
        handleGraphicFrame(child, groupScale, pathPrefix, ctx)
        break
      case 'grpSp': {
        const name = shapeName(child)
        const scale = compoundScale(groupScale, groupChildScale(child))
        walkContainer(child, scale, `${pathPrefix}group[name=${escId(name)}]/`, ctx)
        break
      }
      default:
        break // cxnSp / contentPart: never carry translatable text.
    }
  }
}

function handleSp(
  shape: Element,
  groupScale: { sx: number; sy: number },
  pathPrefix: string,
  ctx: WalkCtx
): void {
  const txBody = childElems(shape, P_NS, 'txBody')[0]
  if (!txBody) return

  if (isWordArt(txBody)) {
    const name = shapeName(shape)
    logSkip(ctx, `slide${ctx.slideN}/${pathPrefix}shape[name=${escId(name)}]`, 'WordArt', name)
    return
  }

  const text = paragraphsText(txBody)
  if (!text.trim()) return

  const geom = resolveShapeGeom({
    shape,
    slideDoc: ctx.slideDoc,
    layoutDoc: ctx.layoutDoc,
    masterDoc: ctx.masterDoc,
    groupScale
  })
  const font = resolveBodyFont(txBody)
  const name = shapeName(shape)
  const id = uniqueId(`slide${ctx.slideN}/${pathPrefix}shape[name=${escId(name)}]/tb`, ctx.usedIds)

  const fontSpec: FontSpec = {
    family: font?.family ?? DEFAULT_FALLBACK_FONT_FAMILY,
    sizePt: geom.fontPt ?? DEFAULT_FALLBACK_FONT_PT,
    bold: font?.bold ?? false,
    italic: font?.italic ?? false
  }

  // spAutoFit ("resize shape to fit text"): the shape's own geometry box
  // (geom.box, whatever it resolved to - even null) is never the binding
  // constraint - see synthesizeSpAutoFitBox's doc comment. normAutofit,
  // noAutofit, and "no autofit element at all" all keep the pre-existing
  // geometry-box behavior unchanged.
  const box: Box =
    geom.autofit === 'spAutoFit'
      ? synthesizeSpAutoFitBox(text, fontSpec, geom.wrap, geom.box)
      : geom.box
        ? { wPt: geom.box.wPt * WRAP_SAFETY, hPt: geom.box.hPt }
        : SENTINEL_BOX

  ctx.sites.push({
    id,
    kind: 'shape',
    context: roleForShape(shape),
    groupKey: `slide${ctx.slideN}`,
    text,
    font: fontSpec,
    box,
    partPath: ctx.slidePath,
    bodyEl: txBody,
    // See Site.preserveSpAutoFit's doc comment - only meaningful combined
    // with this shape currently being spAutoFit.
    preserveSpAutoFit: geom.autofit === 'spAutoFit' && geom.box === null
  })
}

/**
 * A spAutoFit ("resize shape to fit text") shape's declared/inherited
 * `a:ext` - what resolveShapeGeom's `box` reports - is at best PowerPoint's
 * own cached LAST-COMPUTED size for whatever text the shape held when it
 * was last saved, and at worst (no explicit `a:ext` at all - a freshly
 * inserted or never-resaved textbox, e.g. the real deck's slide6/14
 * "TextBox 18") not even that. Either way it is not the binding constraint
 * on a TRANSLATED segment: PowerPoint recomputes the shape's own size from
 * whatever text it actually contains, every time it renders. The binding
 * constraint is the ORIGINAL text's own measured extent - fit the
 * translation into a box no larger than that and the shape PowerPoint
 * recomputes can never grow past its original size, regardless of what
 * `a:ext` (if any) currently says.
 *
 * ECMA-376's CT_TextBodyProperties `@wrap` (default "square" when absent -
 * see geometry.ts's WrapMode) decides what "the original text's measured
 * extent" even means, so this function branches on it:
 *
 *  - wrap="square" (the common case) WITH a real declared/inherited width
 *    (`geomBox` non-null): PowerPoint wraps text at that FIXED width and
 *    grows/shrinks only the shape's HEIGHT. The width ceiling is therefore
 *    that real width (same WRAP_SAFETY convention as every other box below -
 *    see WRAP_SAFETY's own doc comment), and the height ceiling must be the
 *    ORIGINAL text's TRUE wrapped line count AT THAT WIDTH, not the raw
 *    paragraph count - a wrapping paragraph's raw count under-counts its
 *    real visual lines, which would under-shrink a longer translation and
 *    let PowerPoint's own re-wrap at the fixed width push it onto more
 *    lines than budgeted, growing the shape taller (the exact Task B bug,
 *    just relocated to the height axis instead of the width axis). The true
 *    wrapped count comes from wrapLines - fit-engine.ts's own wrapping
 *    machinery, not a reimplementation - run against the RAW (not
 *    WRAP_SAFETY-reduced) width, since that's what PowerPoint itself
 *    actually wrapped the original text at.
 *  - wrap="none" (text grows the shape horizontally and never wraps), OR no
 *    resolvable width at all (`geomBox` null - own ext absent and nothing to
 *    inherit): there is no fixed width to wrap the original text against in
 *    either case, so this falls back to the raw, unwrapped per-paragraph
 *    line model (widest raw line x WRAP_SAFETY for width, raw paragraph
 *    count for height) - the same formula this function used before wrap
 *    awareness existed.
 *
 * Deliberately NOT scaled by groupScale in either branch: width/height here
 * come from nominal-point-size text measurement (and, in the square-wrap
 * case, from geomBox - which resolveShapeGeom already scaled by groupScale
 * once), never re-derived from a raw `a:ext`, mirroring ShapeGeom.fontPt's
 * own no-group-scaling rule for the same "PowerPoint renders grouped text
 * at nominal size" reason (see that field's doc comment).
 *
 * Mixed per-run sizes within one shape: `font.sizePt` is the segment's
 * single resolved size (the adapter's existing one-size-per-segment
 * contract, unchanged by this function) - every line is measured/wrapped at
 * that one size even when the source paragraphs actually differ in size,
 * the same approximation fit()'s own single-sizePt-per-segment contract
 * already makes.
 */
function synthesizeSpAutoFitBox(
  text: string,
  font: FontSpec,
  wrap: WrapMode,
  geomBox: ResolvedBox | null
): Box {
  if (wrap !== 'none' && geomBox) {
    const wPt = geomBox.wPt * WRAP_SAFETY
    const wrappedLines = wrapLines(text, font.sizePt, geomBox.wPt, font)
    const hPt = wrappedLines.length * font.sizePt * SPAUTOFIT_LINE_HEIGHT_FACTOR
    return { wPt, hPt }
  }

  const lines = text.split('\n')
  const wPt = measureWidestLine(lines, font.sizePt, font) * WRAP_SAFETY
  const hPt = lines.length * font.sizePt * SPAUTOFIT_LINE_HEIGHT_FACTOR
  return { wPt, hPt }
}

function handlePic(pic: Element, pathPrefix: string, ctx: WalkCtx): void {
  const nvPicPr = childElems(pic, P_NS, 'nvPicPr')[0]
  const nvPr = nvPicPr && childElems(nvPicPr, P_NS, 'nvPr')[0]
  if (!nvPr) return
  const isVideo =
    elems(nvPr, A_NS, 'videoFile').length > 0 || elems(nvPr, P_NS, 'videoFile').length > 0
  if (isVideo) {
    const name = shapeName(pic)
    logSkip(ctx, `slide${ctx.slideN}/${pathPrefix}pic[name=${escId(name)}]`, 'video', name)
  }
  // Pictures never carry a txBody - nothing else to do either way.
}

function handleGraphicFrame(
  gf: Element,
  groupScale: { sx: number; sy: number },
  pathPrefix: string,
  ctx: WalkCtx
): void {
  if (elems(gf, A_NS, 'tbl')[0]) {
    handleTable(gf, groupScale, pathPrefix, ctx)
    return
  }

  const graphic = childElems(gf, A_NS, 'graphic')[0]
  const graphicData = graphic && childElems(graphic, A_NS, 'graphicData')[0]
  const uri = graphicData?.getAttribute('uri') ?? ''
  const name = shapeName(gf)
  const id = `slide${ctx.slideN}/${pathPrefix}graphicFrame[name=${escId(name)}]`

  if (uri === GRAPHIC_URI.chart) {
    logSkip(ctx, id, 'chart', name)
    return
  }
  if (uri === GRAPHIC_URI.ole) {
    logSkip(ctx, id, 'OLE object', name)
    return
  }
  if (uri === GRAPHIC_URI.diagram && graphicData) {
    handleSmartArt(gf, graphicData, groupScale, pathPrefix, ctx)
    return
  }
  if (uri) logSkip(ctx, id, `graphic frame (${uri})`, name)
}

function handleTable(
  gf: Element,
  groupScale: { sx: number; sy: number },
  pathPrefix: string,
  ctx: WalkCtx
): void {
  const tbl = elems(gf, A_NS, 'tbl')[0]
  if (!tbl) return

  const boxes = tableCellBoxes(gf)
  const trs = childElems(tbl, A_NS, 'tr')
  const name = shapeName(gf)

  for (let r = 0; r < trs.length; r++) {
    const tcs = childElems(trs[r], A_NS, 'tc')
    for (let c = 0; c < tcs.length; c++) {
      const tc = tcs[c]
      // Only the merge's anchor cell carries the real txBody text; every
      // other cell covered by a merge carries hMerge and/or vMerge with no
      // text of its own (see tableCellBoxes's doc comment) - skip those so
      // a merged region is emitted exactly once, not once per covered cell.
      // This is intentional per OOXML merge semantics (a continuation cell
      // is a layout placeholder for the anchor's span, not an independent
      // cell) - if one somehow DOES carry stray text anyway (a malformed or
      // hand-edited deck), that text is still dropped, but loudly logged
      // rather than silently, since silently dropping real content is
      // exactly the failure mode this adapter otherwise refuses to allow.
      if (tc.hasAttribute('hMerge') || tc.hasAttribute('vMerge')) {
        const strayTxBody = childElems(tc, A_NS, 'txBody')[0]
        const strayText = strayTxBody && paragraphsText(strayTxBody).trim()
        if (strayText) {
          logSkip(
            ctx,
            `slide${ctx.slideN}/${pathPrefix}table[gf-name=${escId(name)}]/r${r + 1}c${c + 1}`,
            'merge-continuation cell with unexpected text (anchor-only extraction is intentional)',
            `${name} r${r + 1}c${c + 1}`
          )
        }
        continue
      }

      const txBody = childElems(tc, A_NS, 'txBody')[0]
      if (!txBody) continue
      const text = paragraphsText(txBody)
      if (!text.trim()) continue

      const font = resolveBodyFont(txBody)
      const resolvedCellBox = boxes[r]?.[c]
      const cellLabel = `${name} r${r + 1}c${c + 1}`
      const rawId = `slide${ctx.slideN}/${pathPrefix}table[gf-name=${escId(name)}]/r${r + 1}c${c + 1}`
      if (!resolvedCellBox) {
        // A row carrying more a:tc than the table's own tblGrid defines
        // columns for (malformed/hand-edited deck) - tableCellBoxes has no
        // real box to report. Falling back to a fabricated { wPt: 0, hPt: 0 }
        // would shrink this cell's text to the fit floor for no real
        // reason; the SENTINEL_BOX convention (fit skipped, size preserved)
        // is the same fallback every other unresolvable-geometry case uses.
        logSkip(ctx, rawId, 'table cell (no matching grid column - size preserved)', cellLabel)
      }
      const id = uniqueId(rawId, ctx.usedIds)

      ctx.sites.push({
        id,
        kind: 'table-cell',
        context: 'table cell',
        groupKey: `slide${ctx.slideN}`,
        text,
        font: {
          family: font?.family ?? DEFAULT_FALLBACK_FONT_FAMILY,
          sizePt: resolveExplicitSizePt(txBody) ?? DEFAULT_FALLBACK_FONT_PT,
          bold: font?.bold ?? false,
          italic: font?.italic ?? false
        },
        box: resolvedCellBox
          ? {
              wPt: resolvedCellBox.wPt * groupScale.sx * WRAP_SAFETY,
              hPt: resolvedCellBox.hPt * groupScale.sy
            }
          : SENTINEL_BOX,
        partPath: ctx.slidePath,
        bodyEl: txBody
      })
    }
  }
}

function handleSmartArt(
  gf: Element,
  graphicData: Element,
  groupScale: { sx: number; sy: number },
  pathPrefix: string,
  ctx: WalkCtx
): void {
  const name = shapeName(gf)
  const id = `slide${ctx.slideN}/${pathPrefix}smartart[gf-name=${escId(name)}]`
  const relIds = elems(graphicData, DGM_NS, 'relIds')[0]
  const dmRid = relIds?.getAttributeNS(R_NS, 'dm')
  if (!dmRid) {
    logSkip(ctx, id, 'SmartArt (no data relationship)', name)
    return
  }

  const dataPath = resolveRelById(ctx.archive, ctx.slidePath, dmRid)
  if (!dataPath) {
    logSkip(ctx, id, 'SmartArt (data part unresolved)', name)
    return
  }

  let dataDoc: Document
  try {
    dataDoc = ctx.archive.readXml(dataPath)
  } catch {
    logSkip(ctx, id, 'SmartArt (data part unreadable)', name)
    return
  }

  const geom = resolveShapeGeom({
    shape: gf,
    slideDoc: ctx.slideDoc,
    layoutDoc: ctx.layoutDoc,
    masterDoc: ctx.masterDoc,
    groupScale
  })
  const box = geom.box ? { wPt: geom.box.wPt * WRAP_SAFETY, hPt: geom.box.hPt } : SENTINEL_BOX
  const drawingPath = resolveSmartArtDrawingPath(ctx.archive, dataDoc, dataPath)

  for (const pt of elems(dataDoc, DGM_NS, 'pt')) {
    const t = childElems(pt, DGM_NS, 't')[0]
    if (!t) continue
    const text = paragraphsText(t)
    if (!text.trim()) continue

    const font = resolveBodyFont(t)
    const modelId = pt.getAttribute('modelId') ?? 'unknown'
    const id = uniqueId(
      `slide${ctx.slideN}/${pathPrefix}smartart[gf-name=${escId(name)}]/pt${escId(modelId)}`,
      ctx.usedIds
    )

    ctx.sites.push({
      id,
      kind: 'shape',
      context: 'smartart',
      groupKey: `slide${ctx.slideN}`,
      text,
      font: {
        family: font?.family ?? DEFAULT_FALLBACK_FONT_FAMILY,
        sizePt: resolveExplicitSizePt(t) ?? DEFAULT_FALLBACK_FONT_PT,
        bold: font?.bold ?? false,
        italic: font?.italic ?? false
      },
      box,
      partPath: dataPath,
      bodyEl: t,
      smartArtDrawingPath: drawingPath ?? undefined
    })
  }
}

/**
 * Resolves a diagram's cached drawing part, mirroring how real PowerPoint
 * wires one: the data part's own `dgm:extLst/a:ext/dsp:dataModelExt/@relId`
 * names a relationship in the DATA part's OWN `_rels` file (not the
 * slide's) of type diagramDrawing, pointing at `ppt/diagrams/drawingN.xml`.
 * Returns null when the deck has no cached drawing wired up at all (a
 * perfectly normal, common case - PowerPoint doesn't always cache one).
 */
function resolveSmartArtDrawingPath(
  archive: PptxArchive,
  dataDoc: Document,
  dataPath: string
): string | null {
  const extLst = elems(dataDoc, DGM_NS, 'extLst')[0]
  if (!extLst) return null
  for (const ext of childElems(extLst, A_NS, 'ext')) {
    const dataModelExt = childElems(ext, DSP_NS, 'dataModelExt')[0]
    const relId = dataModelExt?.getAttribute('relId')
    if (relId) return resolveRelById(archive, dataPath, relId)
  }
  return null
}

function handleNotes(ctx: WalkCtx): void {
  const notesPath = resolveRelTarget(ctx.archive, ctx.slidePath, REL_TYPE_NOTES_SLIDE)
  if (!notesPath) return

  let notesDoc: Document
  try {
    notesDoc = ctx.archive.readXml(notesPath)
  } catch {
    return
  }

  const spTree = elems(notesDoc, P_NS, 'spTree')[0]
  if (!spTree) return

  for (const sp of childElems(spTree, P_NS, 'sp')) {
    const nvSpPr = childElems(sp, P_NS, 'nvSpPr')[0]
    const nvPr = nvSpPr && childElems(nvSpPr, P_NS, 'nvPr')[0]
    const ph = nvPr && childElems(nvPr, P_NS, 'ph')[0]
    // A notes slide's body placeholder is the one text-bearing shape we
    // care about; other placeholders on a notes page (slide image, footer,
    // slide number) aren't translatable body content.
    if (!ph || (ph.getAttribute('type') || 'obj') !== 'body') continue

    const txBody = childElems(sp, P_NS, 'txBody')[0]
    if (!txBody) continue
    const text = paragraphsText(txBody)
    if (!text.trim()) continue

    const font = resolveBodyFont(txBody)
    const id = uniqueId(`slide${ctx.slideN}/notes`, ctx.usedIds)

    ctx.sites.push({
      id,
      kind: 'notes',
      context: 'notes',
      groupKey: `slide${ctx.slideN}-notes`,
      text,
      font: {
        family: font?.family ?? DEFAULT_FALLBACK_FONT_FAMILY,
        sizePt: resolveExplicitSizePt(txBody) ?? DEFAULT_FALLBACK_FONT_PT,
        bold: font?.bold ?? false,
        italic: font?.italic ?? false
      },
      box: SENTINEL_BOX,
      partPath: notesPath,
      bodyEl: txBody
    })
  }
}

// ---- apply-side writers ----

/**
 * One "line slot" within a paragraph: the text-carrying element(s) between
 * two successive `a:br` siblings (or the paragraph's start/end when there's
 * no `a:br` on that side). `precedingBr` is the `a:br` that opens this
 * group (null for the paragraph's first group, which has nothing before
 * it). A paragraph's line CAPACITY - how many translation lines it can
 * hold without inventing or losing an `a:br` - is exactly
 * `paragraphGroups(p).length`, which is always `(direct-child a:br count) +
 * 1`, matching how paragraphText() (the extraction side) turns each `a:br`
 * into its own `\n`.
 *
 * `runs` holds both `a:r` AND `a:fld` elements - despite the field's name
 * (kept for brevity/continuity with pre-fld code), an `a:fld` (an
 * auto-field placeholder, e.g. slide number or date) is just as much a
 * text carrier as an `a:r`: it has the exact same `a:rPr?, a:t?` shape, so
 * `textOfRun`/`setRunText` (ooxml.ts) work on it identically. Treating it
 * as a carrier here is what paragraphText() (the extraction side) already
 * effectively assumes by reading `a:fld` text too - see its own doc
 * comment.
 */
interface RunGroup {
  runs: Element[]
  precedingBr: Element | null
}

/**
 * Splits `p`'s direct children into its `a:br`-delimited line groups, in
 * document order. Every paragraph has at least one group (possibly empty),
 * even a bare `<a:p/>` with no children at all - so `groups.length` is a
 * safe, always-positive line-capacity count for writeTranslation.
 */
function paragraphGroups(p: Element): RunGroup[] {
  const groups: RunGroup[] = []
  let current: RunGroup = { runs: [], precedingBr: null }
  const children = p.childNodes
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i)
    if (!child || child.nodeType !== ELEMENT_NODE) continue
    const el = child as Element
    if (el.namespaceURI !== A_NS) continue
    if (el.localName === 'br') {
      groups.push(current)
      current = { runs: [], precedingBr: el }
    } else if (el.localName === 'r' || el.localName === 'fld') {
      current.runs.push(el)
    }
  }
  groups.push(current)
  return groups
}

/**
 * Writes `translation` into `bodyEl`'s existing `a:p` paragraphs, honoring
 * each paragraph's real line capacity - `(direct-child a:br count) + 1`,
 * see `paragraphGroups` - rather than treating every paragraph as exactly
 * one line slot (that mismatch is what let extraction and apply disagree
 * on what a "line" is whenever a paragraph already contained a manual
 * `a:br`).
 *
 * Lines are consumed in document order, each paragraph taking up to its own
 * capacity (see writeLineIntoGroup for how one line lands in one group).
 * Let totalCapacity = sum of every paragraph's capacity. Beyond that:
 *
 *  - MORE lines than totalCapacity: once every paragraph/group is full,
 *    every remaining line is appended to the LAST paragraph as its own new
 *    `a:br`-preceded run - a real visual line break, but never a new `a:p`
 *    (a translation gaining an extra line is not license to invent a whole
 *    new paragraph's worth of formatting/list-level the source never had).
 *  - FEWER lines than totalCapacity: a paragraph that receives zero lines
 *    (because every earlier paragraph together already exhausted the
 *    translation) is DELETED outright, exactly as before this line-capacity
 *    redesign. A paragraph that receives SOME but not all of its groups'
 *    worth of lines keeps only the groups it actually got text for; its
 *    surplus trailing `a:br` + run(s) are removed - symmetric with whole
 *    surplus-paragraph deletion, for exactly the same reason: an emptied
 *    but retained `a:br` is a phantom blank line PowerPoint still renders
 *    and a subsequent extract() would still see as an extra `\n`.
 */
function writeTranslation(bodyEl: Element, translation: string): void {
  const lines = translation.split('\n')
  const paragraphs = childElems(bodyEl, A_NS, 'p')
  // Unreachable in practice: a segment only ever reaches apply() if extract()
  // found non-empty text in this same bodyEl, which requires at least one
  // a:p to have existed. Guarded anyway so a malformed/hand-edited deck
  // degrades to a no-op here instead of indexing paragraphs[0] below.
  if (paragraphs.length === 0) return

  let lineIdx = 0
  let lastWrittenParagraph = paragraphs[0]

  for (const paragraph of paragraphs) {
    if (lineIdx >= lines.length) {
      bodyEl.removeChild(paragraph)
      continue
    }

    lastWrittenParagraph = paragraph
    const groups = paragraphGroups(paragraph)
    const fillCount = Math.min(groups.length, lines.length - lineIdx)
    for (let gi = 0; gi < fillCount; gi++) {
      writeLineIntoGroup(paragraph, groups[gi], lines[lineIdx])
      lineIdx++
    }
    for (let gi = groups.length - 1; gi >= fillCount; gi--) removeGroup(paragraph, groups[gi])
  }

  for (; lineIdx < lines.length; lineIdx++) appendBreakLine(lastWrittenParagraph, lines[lineIdx])
}

/**
 * Writes `text` into one br-delimited line group: the group's first
 * carrier (an `a:r` OR an `a:fld` - see RunGroup's doc comment) gets all
 * of it (keeping its a:rPr - the element is rewritten in place, never
 * recreated); every sibling carrier in that SAME group is emptied, not
 * deleted, so its formatting markers survive even though it no longer
 * carries text - this is also what prevents the mixed "run(s) + fld"
 * case from duplicating text: an existing `a:fld` counts as the group
 * already having a carrier, so a translated line lands on the first
 * carrier (whichever kind it is) instead of a new `a:r` being fabricated
 * alongside the untouched field. A group with zero carriers at all (a bare
 * `<a:p/>` spacer line, or an empty slot between two `a:br`s) has nothing
 * to reuse - a new `a:r` is created at the group's position (see
 * createGroupRun) rather than silently dropping non-empty text, mirroring
 * appendBreakLine's own prefix-resolved run creation.
 */
function writeLineIntoGroup(paragraph: Element, group: RunGroup, text: string): void {
  if (group.runs.length > 0) {
    group.runs.forEach((run, i) => setRunText(run, i === 0 ? text : ''))
    return
  }
  if (text === '') return // nothing to show, nothing worth fabricating a run for
  createGroupRun(paragraph, group, text)
}

/**
 * Creates a new `a:r` holding `text` at the exact position group's (empty)
 * content belongs: right after `group.precedingBr`, or - for the
 * paragraph's opening group (no preceding br) - right after the
 * paragraph's own `a:pPr` when one is present, else as the paragraph's very
 * first child. Either way, the run always lands BEFORE a trailing
 * `a:endParaRPr` (whether that's because we insert relative to
 * `precedingBr`/`pPr`, both of which necessarily precede it, or because
 * `paragraph.firstChild`/`pPr.nextSibling` naturally IS `endParaRPr` on a
 * paragraph with nothing else in it). This matters because
 * CT_TextParagraph's schema is a strict sequence - `pPr?, (r|br|fld)*,
 * endParaRPr?` - so a run inserted before `pPr` (a run-less paragraph
 * carrying paragraph properties, e.g. `<a:p><a:pPr lvl="1"/></a:p>`) would
 * produce schema-invalid child order that real PowerPoint may flag with
 * its repair dialog. The run's namespace prefix matches whatever's already
 * bound in scope (same resolution approach as setRunText/ensureRPr/
 * appendBreakLine). If the paragraph carries an `a:endParaRPr` - the run
 * PowerPoint would otherwise have used as this paragraph's "would-be
 * formatting" - its attributes/children are cloned onto the new run's
 * `a:rPr` so the fabricated line doesn't silently fall back to bare
 * defaults; no `a:endParaRPr` present is fine too (bare rPr-less run).
 */
function createGroupRun(paragraph: Element, group: RunGroup, text: string): Element {
  const doc = paragraph.ownerDocument
  if (!doc) throw new Error('Cannot create run: <a:p> element has no owner document')
  const prefix = paragraph.lookupPrefix(A_NS)
  const qualified = (local: string): string =>
    prefix === null ? `a:${local}` : prefix === '' ? local : `${prefix}:${local}`

  const run = doc.createElementNS(A_NS, qualified('r'))

  const endParaRPr = childElems(paragraph, A_NS, 'endParaRPr')[0]
  if (endParaRPr) {
    const rPr = doc.createElementNS(A_NS, qualified('rPr'))
    for (let i = 0; i < endParaRPr.attributes.length; i++) {
      const attr = endParaRPr.attributes.item(i)
      if (attr) rPr.setAttribute(attr.name, attr.value)
    }
    for (let i = 0; i < endParaRPr.childNodes.length; i++) {
      const child = endParaRPr.childNodes.item(i)
      if (child) rPr.appendChild(child.cloneNode(true))
    }
    run.appendChild(rPr)
  }

  if (group.precedingBr) {
    paragraph.insertBefore(run, group.precedingBr.nextSibling)
  } else {
    const pPr = childElems(paragraph, A_NS, 'pPr')[0]
    paragraph.insertBefore(run, pPr ? pPr.nextSibling : paragraph.firstChild)
  }

  setRunText(run, text)
  group.runs.push(run)
  return run
}

/** Removes a surplus line group entirely: its opening `a:br` (if any - the paragraph's first group has none) and every run it held. Symmetric with whole surplus-paragraph deletion in writeTranslation. */
function removeGroup(paragraph: Element, group: RunGroup): void {
  if (group.precedingBr) paragraph.removeChild(group.precedingBr)
  for (const run of group.runs) paragraph.removeChild(run)
}

/**
 * Appends `text` to `paragraph` as a new visual line: an `a:br` followed by
 * a fresh `a:r` run carrying `text`. The new run's namespace prefix matches
 * whatever's already bound in scope (same resolution approach as
 * setRunText/ensureRPr), and it clones the paragraph's own first run's
 * `a:rPr` (if any) so the appended line's formatting matches rather than
 * silently falling back to bare paragraph/list defaults.
 */
function appendBreakLine(paragraph: Element, text: string): void {
  const doc = paragraph.ownerDocument
  if (!doc) return
  const prefix = paragraph.lookupPrefix(A_NS)
  const qualified = (local: string): string =>
    prefix === null ? `a:${local}` : prefix === '' ? local : `${prefix}:${local}`

  paragraph.appendChild(doc.createElementNS(A_NS, qualified('br')))

  const run = doc.createElementNS(A_NS, qualified('r'))
  const sourceRun = childElems(paragraph, A_NS, 'r')[0]
  const sourceRPr = sourceRun && childElems(sourceRun, A_NS, 'rPr')[0]
  if (sourceRPr) run.appendChild(sourceRPr.cloneNode(true))
  paragraph.appendChild(run)

  setRunText(run, text)
}

/**
 * Sets `sz` (hundredths of a point, FLOORED to the quarter point) on every
 * run in `bodyEl` whose current text is non-empty, and marks `bodyEl`'s
 * `a:bodyPr` with a bare `<a:normAutofit/>` (see ensureNormAutofit's own
 * doc comment for why) as a belt-and-suspenders safety net on top of our
 * explicit size. Must run AFTER writeTranslation so "non-empty run"
 * reflects the post-translation state (runs writeTranslation just emptied
 * are correctly left untouched here).
 *
 * Floored, not rounded: `sizePt` is the fit engine's own measured "this
 * size fits" answer. Rounding to the NEAREST quarter point can round UP -
 * writing a size larger than what was actually measured to fit, silently
 * reintroducing the very overflow fit() was asked to prevent. Flooring
 * only ever writes a size at or below what was measured, which can only
 * ever make the fit margin more conservative, never less.
 *
 * `preserveSpAutoFit` is Site.preserveSpAutoFit (default false for every
 * caller outside this shape's own apply() branch) - see ensureNormAutofit's
 * doc comment for what it does and why.
 */
function writeSize(bodyEl: Element, sizePt: number, preserveSpAutoFit: boolean): void {
  const QUARTER_POINT = 25
  const hundredths = Math.floor((sizePt * 100) / QUARTER_POINT) * QUARTER_POINT

  for (const run of elems(bodyEl, A_NS, 'r')) {
    if (textOfRun(run).trim() === '') continue
    ensureRPr(run).setAttribute('sz', String(hundredths))
  }

  ensureNormAutofit(bodyEl, preserveSpAutoFit)
}

/**
 * Research-adopted belt-and-suspenders (credit: LinguaHaru's approach to
 * the same problem, per the Phase 2 research/knowledge-base adoption).
 * writeSize() above already writes an explicit fitted `sz` computed from
 * our own skia-canvas-based wrap measurement (with the WRAP_SAFETY margin
 * on top - see its doc comment), but that measurement can still diverge
 * slightly from PowerPoint's real text layout engine on some fonts/scripts
 * - and unlike our earlier "explicit size means autofit must not ALSO
 * apply on top of it" stance, a residual mismatch there would silently
 * clip text with no recourse. So instead: ensure `bodyEl`'s `a:bodyPr`
 * carries a bare `<a:normAutofit/>` (no `fontScale`/`lnSpcReduction`
 * attributes - those would be PowerPoint's own record of a PREVIOUS
 * autofit computed for different text/size, so carrying stale values
 * forward here would be actively wrong for what we just wrote). This asks
 * PowerPoint to keep autofitting on top of our size if it still doesn't
 * fit once opened/edited, rather than leaving an uncorrectable overflow.
 *
 * Replaces whichever EG_TextAutofit choice element (`a:noAutofit`,
 * `a:spAutoFit`, or a stale `a:normAutofit`) was already there, and
 * creates `a:bodyPr` itself in the (schema-invalid on any real deck, so
 * normally unreachable) case a body somehow lacks one - `a:bodyPr` is
 * `CT_TextBody`'s first required child, so every body this codebase can
 * actually extract a segment from will already have one.
 *
 * EXCEPT when `preserveSpAutoFit` is true and the body currently carries
 * `a:spAutoFit`: this is an ext-absent spAutoFit shape (Site.preserveSpAutoFit
 * - own ext absent, nothing to inherit either), and the conversion is
 * skipped entirely, leaving `a:spAutoFit` in place untouched. Converting it
 * here would write "shrink text on overflow" into a file that never gains
 * an `a:ext` for that to mean anything against (apply() never writes one),
 * losing spAutoFit's own recompute-on-open self-healing for no benefit: the
 * `sz` writeSize() already wrote is measured against synthesizeSpAutoFitBox's
 * box, which IS the original text's extent - the shape PowerPoint recomputes
 * from that `sz` is already guaranteed to stay within it, so there is
 * nothing left for normAutofit to additionally guard here. A shape WITH an
 * explicit/inherited ext keeps the conversion unchanged: there, a real ext
 * exists for normAutofit's belt-and-suspenders to fall back against, same
 * as every other autofit case.
 */
function ensureNormAutofit(bodyEl: Element, preserveSpAutoFit: boolean): void {
  const doc = bodyEl.ownerDocument
  if (!doc) return

  const qualified = (el: Element, local: string): string => {
    const prefix = el.lookupPrefix(A_NS)
    return prefix === null ? `a:${local}` : prefix === '' ? local : `${prefix}:${local}`
  }

  let bodyPr = childElems(bodyEl, A_NS, 'bodyPr')[0]

  if (preserveSpAutoFit && bodyPr && childElems(bodyPr, A_NS, 'spAutoFit')[0]) {
    return
  }

  if (!bodyPr) {
    bodyPr = doc.createElementNS(A_NS, qualified(bodyEl, 'bodyPr'))
    bodyEl.insertBefore(bodyPr, bodyEl.firstChild)
  }

  for (const stale of [
    ...childElems(bodyPr, A_NS, 'noAutofit'),
    ...childElems(bodyPr, A_NS, 'normAutofit'),
    ...childElems(bodyPr, A_NS, 'spAutoFit')
  ]) {
    bodyPr.removeChild(stale)
  }

  const normAutofit = doc.createElementNS(A_NS, qualified(bodyPr, 'normAutofit'))
  const insertBefore = firstAutofitSuccessorSibling(bodyPr)
  if (insertBefore) bodyPr.insertBefore(normAutofit, insertBefore)
  else bodyPr.appendChild(normAutofit)
}

/**
 * The first of `a:scene3d`/`a:sp3d`/`a:flatTx`/`a:extLst` among `bodyPr`'s
 * direct children, in document order. CT_TextBodyProperties's schema
 * places the EG_TextAutofit choice (`noAutofit`|`normAutofit`|`spAutoFit`)
 * immediately before these, after an optional `a:prstTxWarp` - which this
 * function deliberately does NOT match against, so it never returns a
 * position before that warp shape (WordArt bodies never actually reach
 * ensureNormAutofit() in practice - isWordArt() skips them entirely in
 * handleSp() - but stay schema-correct regardless of that). Returns null
 * when none of those trailing elements exist, meaning the new
 * `a:normAutofit` can simply be appended as bodyPr's last child - the
 * common case for every body this adapter actually writes to.
 */
function firstAutofitSuccessorSibling(bodyPr: Element): Element | null {
  const TRAILING_LOCAL_NAMES = new Set(['scene3d', 'sp3d', 'flatTx', 'extLst'])
  const children = bodyPr.childNodes
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i)
    if (!child || child.nodeType !== ELEMENT_NODE) continue
    const el = child as Element
    if (el.namespaceURI !== A_NS) continue
    if (el.localName && TRAILING_LOCAL_NAMES.has(el.localName)) return el
  }
  return null
}

/** Finds (or creates, matching the run's own bound DrawingML prefix - mirrors setRunText's approach) a run's `a:rPr`, inserted as its first child per CT_TextRun's schema order. */
function ensureRPr(run: Element): Element {
  const existing = childElems(run, A_NS, 'rPr')[0]
  if (existing) return existing

  const doc = run.ownerDocument
  if (!doc) throw new Error('Cannot create rPr: <a:r> element has no owner document')
  const prefix = run.lookupPrefix(A_NS)
  const qualifiedName = prefix === null ? 'a:rPr' : prefix === '' ? 'rPr' : `${prefix}:rPr`
  const rPr = doc.createElementNS(A_NS, qualifiedName)
  if (run.firstChild) run.insertBefore(rPr, run.firstChild)
  else run.appendChild(rPr)
  return rPr
}

/**
 * Keeps a SmartArt's cached `dsp:drawing` part in sync with its data model:
 * every `a:r` anywhere in the drawing doc (regardless of nesting - `elems`
 * is a descendant search, and `dsp:txBody` reuses plain `a:r`/`a:t` runs
 * exactly like every other DrawingML text body) whose text EXACTLY matches
 * a key in `bySourceText` is rewritten to that key's translation - ALL
 * occurrences, not just the first, since the cache can repeat the same
 * label in more than one cached shape. A run whose non-empty text matches
 * no key is left untouched and logged once per distinct unmatched text
 * (not once per occurrence, to avoid warning spam from a decorative label
 * - e.g. a placeholder shape - repeated many times in the cache): the
 * drawing simply has no corresponding translated data point for it, which
 * can legitimately happen (the cache and the data model are allowed to
 * drift in a hand-edited or unusual deck). A key mapped to
 * `AMBIGUOUS_TRANSLATION` (two data points shared this source text but got
 * different translations) is likewise left untouched and logged, distinctly
 * from a plain unmatched text - see AMBIGUOUS_TRANSLATION's doc comment.
 * The drawing part is marked dirty only when at least one run actually
 * changed - an all-unmatched/all-ambiguous drawing is left byte-identical.
 */
function applySmartArtDrawingText(
  archive: PptxArchive,
  drawingPath: string,
  bySourceText: Map<string, string | typeof AMBIGUOUS_TRANSLATION>
): void {
  let drawingDoc: Document
  try {
    drawingDoc = archive.readXml(drawingPath)
  } catch {
    console.warn(
      `pptx adapter: SmartArt cached drawing part "${drawingPath}" could not be read - left untouched`
    )
    return
  }

  let changed = false
  const unmatched = new Set<string>()
  const ambiguous = new Set<string>()
  for (const run of elems(drawingDoc, A_NS, 'r')) {
    const text = textOfRun(run)
    if (text.trim() === '') continue
    const translation = bySourceText.get(text)
    if (translation === undefined) {
      unmatched.add(text)
      continue
    }
    if (translation === AMBIGUOUS_TRANSLATION) {
      ambiguous.add(text)
      continue
    }
    setRunText(run, translation)
    changed = true
  }

  for (const text of unmatched) {
    console.warn(
      `pptx adapter: SmartArt cached drawing text "${text}" has no matching translated data point - left untouched`
    )
  }
  for (const text of ambiguous) {
    console.warn(
      `pptx adapter: SmartArt cached drawing text "${text}" is ambiguous (multiple data points share ` +
        'this source text with different translations) - left untouched'
    )
  }

  if (changed) archive.markDirty(drawingPath)
}

// ---- shape/text helpers ----

function paragraphsText(bodyEl: Element): string {
  return childElems(bodyEl, A_NS, 'p').map(paragraphText).join('\n')
}

/**
 * One paragraph's text, walking its direct children in document order so an
 * `a:br` (an explicit line break WITHIN a paragraph - e.g. one appended by
 * writeTranslation's own overflow path, or authored by hand in a source
 * deck) becomes a `\n`, matching how the paragraph-vs-line accounting in
 * writeTranslation treats it on the way back in. `a:r` and `a:fld` runs
 * contribute their own `a:t` text; nothing else (end-paragraph run
 * properties, etc.) carries text.
 */
function paragraphText(p: Element): string {
  const parts: string[] = []
  const children = p.childNodes
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i)
    if (!child || child.nodeType !== ELEMENT_NODE) continue
    const el = child as Element
    if (el.namespaceURI !== A_NS) continue
    if (el.localName === 'br') {
      parts.push('\n')
    } else if (el.localName === 'r' || el.localName === 'fld') {
      parts.push(childElems(el, A_NS, 't')[0]?.textContent ?? '')
    }
  }
  return parts.join('')
}

function isWordArt(bodyEl: Element): boolean {
  const bodyPr = childElems(bodyEl, A_NS, 'bodyPr')[0]
  const warp = bodyPr && childElems(bodyPr, A_NS, 'prstTxWarp')[0]
  return !!warp && warp.getAttribute('prst') !== 'none'
}

/**
 * First explicit `a:rPr/@sz` found in document order (mirrors
 * geometry.ts's resolveRawFontPt run-scan for the "sp" case, reimplemented
 * here because that function only resolves shapes whose element is itself
 * `p:sp` - table cells, notes, and SmartArt data points are never that, so
 * resolveShapeGeom can't be asked about them directly). NOT group-scaled:
 * PowerPoint renders grouped text at nominal point size (see
 * geometry.ts resolveFontPt's rendering-model note, verified 2026-07-31).
 * No placeholder-type default fallback here: `p:ph` only exists on shapes.
 */
function resolveExplicitSizePt(bodyEl: Element): number | null {
  for (const r of elems(bodyEl, A_NS, 'r')) {
    const rPr = childElems(r, A_NS, 'rPr')[0]
    if (rPr?.hasAttribute('sz')) {
      return Number(rPr.getAttribute('sz')) / 100
    }
  }
  return null
}

/**
 * Family/bold/italic from the FIRST run with non-empty text (per the
 * extract contract's point 4 - deliberately a different run-selection rule
 * than resolveExplicitSizePt's "first rPr with @sz regardless of text",
 * since geometry.ts's own resolveRawFontPt already established that size
 * comes from the first explicit size in document order, empty run or not).
 * Family prefers `a:ea` over `a:latin` when the run's own text looks CJK,
 * and vice versa - falling back to whichever of the two IS present.
 */
function resolveBodyFont(
  bodyEl: Element
): { family: string; bold: boolean; italic: boolean } | null {
  for (const r of elems(bodyEl, A_NS, 'r')) {
    const text = textOfRun(r)
    if (text.trim() === '') continue

    const rPr = childElems(r, A_NS, 'rPr')[0]
    const latin = rPr && childElems(rPr, A_NS, 'latin')[0]?.getAttribute('typeface')
    const ea = rPr && childElems(rPr, A_NS, 'ea')[0]?.getAttribute('typeface')
    const isCjk = CJK_RANGE.test(text)
    const family = (isCjk ? ea || latin : latin || ea) || DEFAULT_FALLBACK_FONT_FAMILY

    return {
      family,
      bold: rPr?.getAttribute('b') === '1',
      italic: rPr?.getAttribute('i') === '1'
    }
  }
  return null
}

const PH_ALIAS: Record<string, string> = { ctrTitle: 'title', subTitle: 'body' }

/** Human-readable role: placeholder type maps to a fixed vocabulary ('slide title', 'body'), any other placeholder type is named literally, and a non-placeholder shape is a generic 'text box'. */
function roleForShape(shape: Element): string {
  const type = placeholderType(shape)
  if (type === null) return 'text box'
  const normalized = PH_ALIAS[type] ?? type
  if (normalized === 'title') return 'slide title'
  if (normalized === 'body') return 'body'
  return `placeholder (${type})`
}

function placeholderType(shape: Element): string | null {
  if (shape.localName !== 'sp') return null
  const nvSpPr = childElems(shape, P_NS, 'nvSpPr')[0]
  const nvPr = nvSpPr && childElems(nvSpPr, P_NS, 'nvPr')[0]
  const ph = nvPr && childElems(nvPr, P_NS, 'ph')[0]
  if (!ph) return null
  return ph.getAttribute('type') || 'obj' // CT_Placeholder default (ECMA-376 19.7.9)
}

const NV_CONTAINER_BY_KIND: Record<string, string> = {
  sp: 'nvSpPr',
  pic: 'nvPicPr',
  grpSp: 'nvGrpSpPr',
  graphicFrame: 'nvGraphicFramePr'
}

function shapeName(shape: Element): string {
  const containerLocal = NV_CONTAINER_BY_KIND[shape.localName ?? '']
  const container = containerLocal ? childElems(shape, P_NS, containerLocal)[0] : undefined
  const cNvPr = container && childElems(container, P_NS, 'cNvPr')[0]
  const name = cNvPr?.getAttribute('name')?.trim()
  if (name) return name
  const id = cNvPr?.getAttribute('id')
  return id ? `Shape ${id}` : 'Shape'
}

/** Routes one skip through `ctx.recordSkip` (a no-op when undefined - apply()'s silent re-walk, see WalkCtx's doc comment) rather than logging directly; extract()'s recorder is what actually does the console.warn AND the collectSkips() accounting, in one place, exactly once per real skip. */
function logSkip(ctx: WalkCtx, id: string, kind: string, name: string): void {
  ctx.recordSkip?.(id, kind, name)
}

// ---- small generic/id/relationship utilities ----

function directChildElements(parent: Element): Element[] {
  const out: Element[] = []
  const children = parent.childNodes
  for (let i = 0; i < children.length; i++) {
    const child: Node | null = children.item(i)
    if (child && child.nodeType === ELEMENT_NODE) out.push(child as Element)
  }
  return out
}

function compoundScale(
  a: { sx: number; sy: number },
  b: { sx: number; sy: number }
): { sx: number; sy: number } {
  return { sx: a.sx * b.sx, sy: a.sy * b.sy }
}

/** Keeps the id scheme's `/` and `[]` delimiters unambiguous when a real shape name happens to contain them. */
function escId(name: string): string {
  return name.replace(/[[\]/]/g, '_')
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base}-${n}`)) n++
  const id = `${base}-${n}`
  used.add(id)
  return id
}

/**
 * Reimplements ooxml.ts's private relsPathFor/resolvePartPath (not
 * exported - only layoutPathFor/masterPathFor, which are hardcoded to their
 * own specific relationship types, are) so this adapter can resolve the two
 * relationship kinds those don't cover: a slide's notesSlide, and a
 * SmartArt graphicFrame's diagram-data relationship by explicit r:id rather
 * than by type.
 */
function relsPathFor(partPath: string): string {
  const dir = path.posix.dirname(partPath)
  const base = path.posix.basename(partPath)
  return path.posix.join(dir, '_rels', `${base}.rels`)
}

function resolveRelPartPath(basePartPath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const dir = path.posix.dirname(basePartPath)
  return path.posix.normalize(path.posix.join(dir, target))
}

function resolveRelTarget(archive: PptxArchive, partPath: string, relType: string): string | null {
  let relsDoc: Document
  try {
    relsDoc = archive.readXml(relsPathFor(partPath))
  } catch {
    return null
  }
  for (const rel of elems(relsDoc, RELS_NS, 'Relationship')) {
    if (rel.getAttribute('Type') === relType) {
      const target = rel.getAttribute('Target')
      if (target) return resolveRelPartPath(partPath, target)
    }
  }
  return null
}

function resolveRelById(archive: PptxArchive, partPath: string, rId: string): string | null {
  let relsDoc: Document
  try {
    relsDoc = archive.readXml(relsPathFor(partPath))
  } catch {
    return null
  }
  for (const rel of elems(relsDoc, RELS_NS, 'Relationship')) {
    if (rel.getAttribute('Id') === rId) {
      const target = rel.getAttribute('Target')
      if (target) return resolveRelPartPath(partPath, target)
    }
  }
  return null
}

// Test-only visibility into the mirrored constant above (drift-guard test in
// tests/core/pptx/pptx-adapter.test.ts) - not part of this module's real
// interface, matching fit-engine.ts's own _internals convention (and
// overlay.ts's identical mirroring of the same constant).
export const _internals = { SPAUTOFIT_LINE_HEIGHT_FACTOR }
