/**
 * Lossless OOXML layer for .pptx files.
 *
 * Opens a .pptx (a zip of XML "parts" per the OPC spec), exposes each part
 * as a parsed, namespace-aware DOM `Document`, and saves back with the
 * guarantee that any part never explicitly edited (via `markDirty`) is
 * written out byte-identical to how it was read - PowerPoint's repair
 * dialog on a produced file is a bug in this layer.
 *
 * Every part's raw bytes are read eagerly during `openPptx` (JSZip's
 * decompression API is promise-based even for in-memory zips), which is
 * what lets `readXml` be synchronous and cheaply cached per part.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import type { Document, Element, Node } from '@xmldom/xmldom'

export const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
export const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
/** The `.rels` package relationships namespace - distinct from R_NS, which is the
 * namespace of `r:id`/`r:embed` attributes inside content parts. */
export const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

const REL_TYPE_SLIDE_LAYOUT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout'
const REL_TYPE_SLIDE_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster'

const ELEMENT_NODE = 1

export interface PptxArchive {
  /** ppt/slides/slideN.xml parts, sorted numerically by N (slide10 after slide9). */
  listSlidePaths(): string[]
  /** ppt/notesSlides/notesSlideN.xml parts, sorted numerically by N. */
  listNotesPaths(): string[]
  /** Parsed DOM for a part, cached per part path. Throws if the part doesn't exist. */
  readXml(partPath: string): Document
  /** Marks a part as edited; only dirty parts are re-serialized on save(). */
  markDirty(partPath: string): void
  /** Resolves a slide's layout part path via the slide's `_rels`, or null if unresolvable. */
  layoutPathFor(slidePath: string): string | null
  /** Resolves a layout's master part path via the layout's `_rels`, or null if unresolvable. */
  masterPathFor(layoutPath: string): string | null
  /**
   * Raw bytes of a binary (non-XML) part, e.g. a media part - throws if the
   * part doesn't exist. Never goes through the XML DOM cache: media bytes
   * (PNG/JPG/EMF/...) would fail readXml's parse outright.
   */
  readRawBytes(partPath: string): Buffer
  /**
   * Replaces a binary part's bytes and marks it dirty (see markDirty) - only
   * dirty parts are re-serialized on save().
   */
  writeRawBytes(partPath: string, bytes: Buffer): void
  /** Writes a .pptx to outPath: dirty parts re-serialized, everything else byte-identical. */
  save(outPath: string): Promise<void>
}

export async function openPptx(filePath: string): Promise<PptxArchive> {
  let raw: Buffer
  try {
    raw = await readFile(filePath)
  } catch (err) {
    throw new Error(`Cannot read "${filePath}": ${errorMessage(err)}`, { cause: err })
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(raw)
  } catch (err) {
    throw new Error(
      `"${filePath}" could not be opened as a .pptx (invalid zip archive): ${errorMessage(err)}`,
      { cause: err }
    )
  }

  const entries = Object.values(zip.files).filter((f) => !f.dir)
  const buffers = await Promise.all(entries.map((entry) => entry.async('nodebuffer')))
  const parts = new Map<string, Buffer>()
  entries.forEach((entry, i) => parts.set(entry.name, buffers[i]))

  return new PptxArchiveImpl(filePath, parts)
}

class PptxArchiveImpl implements PptxArchive {
  private readonly domCache = new Map<string, Document>()
  private readonly dirty = new Set<string>()
  /** Overrides for parts written via writeRawBytes - checked ahead of the original bytes in `parts` by both readRawBytes and save(). */
  private readonly rawOverrides = new Map<string, Buffer>()

  constructor(
    private readonly filePath: string,
    private readonly parts: Map<string, Buffer>
  ) {}

  listSlidePaths(): string[] {
    return this.listNumberedParts(/^ppt\/slides\/slide(\d+)\.xml$/)
  }

  listNotesPaths(): string[] {
    return this.listNumberedParts(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/)
  }

  private listNumberedParts(re: RegExp): string[] {
    const matches: { path: string; n: number }[] = []
    for (const partPath of this.parts.keys()) {
      const m = re.exec(partPath)
      if (m) matches.push({ path: partPath, n: Number(m[1]) })
    }
    matches.sort((a, b) => a.n - b.n)
    return matches.map((m) => m.path)
  }

  readXml(partPath: string): Document {
    const cached = this.domCache.get(partPath)
    if (cached) return cached

    const raw = this.parts.get(partPath)
    if (raw === undefined) {
      throw new Error(`Part "${partPath}" not found in "${this.filePath}"`)
    }

    const doc = parseXmlPart(raw.toString('utf8'), partPath, this.filePath)
    this.domCache.set(partPath, doc)
    return doc
  }

  markDirty(partPath: string): void {
    if (!this.parts.has(partPath)) {
      throw new Error(`Cannot mark unknown part "${partPath}" dirty in "${this.filePath}"`)
    }
    this.dirty.add(partPath)
  }

  readRawBytes(partPath: string): Buffer {
    const override = this.rawOverrides.get(partPath)
    if (override) return override
    const raw = this.parts.get(partPath)
    if (raw === undefined) {
      throw new Error(`Part "${partPath}" not found in "${this.filePath}"`)
    }
    return raw
  }

  writeRawBytes(partPath: string, bytes: Buffer): void {
    if (!this.parts.has(partPath)) {
      throw new Error(`Cannot write unknown part "${partPath}" in "${this.filePath}"`)
    }
    this.rawOverrides.set(partPath, bytes)
    this.markDirty(partPath)
  }

  layoutPathFor(slidePath: string): string | null {
    return this.resolveRelTarget(slidePath, REL_TYPE_SLIDE_LAYOUT)
  }

  masterPathFor(layoutPath: string): string | null {
    return this.resolveRelTarget(layoutPath, REL_TYPE_SLIDE_MASTER)
  }

  private resolveRelTarget(partPath: string, relType: string): string | null {
    const relsPath = relsPathFor(partPath)
    if (!this.parts.has(relsPath)) return null

    const relsDoc = this.readXml(relsPath)
    for (const rel of elems(relsDoc, RELS_NS, 'Relationship')) {
      if (rel.getAttribute('Type') === relType) {
        const target = rel.getAttribute('Target')
        if (!target) continue
        return resolvePartPath(partPath, target)
      }
    }
    return null
  }

  async save(outPath: string): Promise<void> {
    const outZip = new JSZip()

    for (const [partPath, raw] of this.parts) {
      if (this.dirty.has(partPath)) {
        const rawOverride = this.rawOverrides.get(partPath)
        if (rawOverride) {
          outZip.file(partPath, rawOverride)
        } else {
          const doc = this.domCache.get(partPath)
          if (!doc) {
            throw new Error(
              `Part "${partPath}" was marked dirty but was never read via readXml() or written via ` +
                'writeRawBytes() - nothing to serialize'
            )
          }
          outZip.file(partPath, serializeXmlPart(doc))
        }
      } else {
        outZip.file(partPath, raw)
      }
    }

    const buffer = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

    // Write to a sibling temp file next to outPath, then rename, so a
    // failure partway through never leaves a partially-written outPath. The
    // temp file must live in outPath's own directory (not the OS tmpdir,
    // which may be a different drive/filesystem) so the rename is an
    // atomic same-filesystem move rather than a cross-device copy that
    // could itself fail partway through.
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const tmpPath = path.join(path.dirname(outPath), `.${path.basename(outPath)}.tmp-${unique}`)
    try {
      await writeFile(tmpPath, buffer)
      await rename(tmpPath, outPath)
    } catch (err) {
      throw new Error(`Failed to write "${outPath}": ${errorMessage(err)}`, { cause: err })
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}

function relsPathFor(partPath: string): string {
  const dir = path.posix.dirname(partPath)
  const base = path.posix.basename(partPath)
  return path.posix.join(dir, '_rels', `${base}.rels`)
}

function resolvePartPath(basePartPath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const dir = path.posix.dirname(basePartPath)
  return path.posix.normalize(path.posix.join(dir, target))
}

function parseXmlPart(xml: string, partPath: string, filePath: string): Document {
  try {
    const parser = new DOMParser({
      onError: (level, msg) => {
        if (level !== 'warning') throw new Error(msg)
      }
    })
    return parser.parseFromString(xml, 'application/xml')
  } catch (err) {
    throw new Error(
      `Failed to parse XML part "${partPath}" of "${filePath}": ${errorMessage(err)}`,
      {
        cause: err
      }
    )
  }
}

function serializeXmlPart(doc: Document): string {
  if (!doc.documentElement) {
    throw new Error('Cannot serialize an XML document with no root element')
  }
  const serializer = new XMLSerializer()
  const body = serializer.serializeToString(doc.documentElement)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${body}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- DOM helpers ----

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE
}

/** Every descendant element of `parent` matching {ns, local}, in document order. */
export function elems(parent: Node, ns: string, local: string): Element[] {
  const out: Element[] = []
  const walk = (node: Node): void => {
    const children = node.childNodes
    for (let i = 0; i < children.length; i++) {
      const child = children.item(i)
      if (!child || !isElement(child)) continue
      if (child.namespaceURI === ns && child.localName === local) out.push(child)
      walk(child)
    }
  }
  walk(parent)
  return out
}

/** Direct child elements of `parent` matching {ns, local}, in document order. */
export function childElems(parent: Element, ns: string, local: string): Element[] {
  const out: Element[] = []
  const children = parent.childNodes
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i)
    if (child && isElement(child) && child.namespaceURI === ns && child.localName === local) {
      out.push(child)
    }
  }
  return out
}

/** The `a:t` text content of a run element, or '' if the run has no text. */
export function textOfRun(r: Element): string {
  const t = childElems(r, A_NS, 't')[0]
  return t?.textContent ?? ''
}

/** Sets a run's `a:t` text content, creating the `a:t` child if missing. */
export function setRunText(r: Element, text: string): void {
  let t = childElems(r, A_NS, 't')[0]
  if (!t) {
    const doc = r.ownerDocument
    if (!doc) throw new Error('Cannot set run text: <a:r> element has no owner document')
    // DrawingML isn't always bound to the conventional 'a:' prefix (e.g.
    // LibreOffice/Keynote/third-party decks may use a different prefix, or
    // in principle no prefix at all via a default namespace). Resolve the
    // prefix actually in scope at this point in the tree; a hardcoded 'a:'
    // would serialize an unbound prefix on decks that use something else,
    // producing invalid XML that PowerPoint's repair dialog would flag.
    const prefix = r.lookupPrefix(A_NS)
    const qualifiedName = prefix === null ? 'a:t' : prefix === '' ? 't' : `${prefix}:t`
    t = doc.createElementNS(A_NS, qualifiedName)
    r.appendChild(t)
  }
  t.textContent = text
  // Preserve leading/trailing whitespace through XML whitespace normalization.
  if (text !== text.trim()) {
    t.setAttribute('xml:space', 'preserve')
  } else if (t.hasAttribute('xml:space')) {
    t.removeAttribute('xml:space')
  }
}

// ---- embedded-media enumeration (Phase 3, Task 5) ----

/** One `<p:pic>`'s embedded media usage - see listPictureMedia. */
export interface MediaRef {
  mediaPath: string
  slidePath: string
}

/**
 * Every embedded picture's media part, one MediaRef per USAGE (not deduped -
 * a media part referenced by 3 `<p:pic>` elements across the deck yields 3
 * entries here; deduping by `mediaPath` is the caller's job - see
 * pptx-adapter.ts's embedded-media hookup, Phase 3 Task 5 behavior contract
 * point 1). Resolves through `<p:pic>/<p:blipFill>/<a:blip r:embed="...">`
 * on every slide, via a deep search (elems), so pictures nested inside
 * `<p:grpSp>` groups are found too, not just direct spTree children.
 *
 * Only EMBEDDED media is returned: a `<a:blip>` with `r:link` instead of
 * `r:embed` (a LINKED, external image with no local part) has nothing for
 * `mediaPath` to name and is silently skipped - there is no local media part
 * to read or rewrite for it.
 *
 * Returns BOTH raster (png/jpg/jpeg) and vector metafile (emf/wmf) media
 * refs without filtering by format - real PowerPoint stores a pasted
 * EMF/WMF exactly like any other picture (a `<p:pic>` with a normal
 * `r:embed` blip), and the caller needs to know it exists to report it as a
 * skip (Task 5 behavior contract point 3), which it could never do if this
 * enumeration silently dropped it. The raster/vector split is the caller's
 * decision, not this function's.
 */
export function listPictureMedia(archive: PptxArchive): MediaRef[] {
  const refs: MediaRef[] = []
  for (const slidePath of archive.listSlidePaths()) {
    const slideDoc = archive.readXml(slidePath)
    for (const pic of elems(slideDoc, P_NS, 'pic')) {
      const blipFill = childElems(pic, P_NS, 'blipFill')[0]
      const blip = blipFill && childElems(blipFill, A_NS, 'blip')[0]
      const rId = blip?.getAttributeNS(R_NS, 'embed')
      if (!rId) continue
      const mediaPath = resolveEmbedTarget(archive, slidePath, rId)
      if (mediaPath) refs.push({ mediaPath, slidePath })
    }
  }
  return refs
}

/**
 * Resolves a relationship by exact Id (not Type) in `partPath`'s own
 * `_rels` file. Reimplements pptx-adapter.ts's private resolveRelById
 * (not exported - it resolves OTHER relationship kinds this module doesn't
 * cover: notesSlide, SmartArt data) since relationship-by-Id resolution
 * belongs at this layer for the relationship kind ooxml.ts itself now
 * needs (image).
 */
function resolveEmbedTarget(archive: PptxArchive, partPath: string, rId: string): string | null {
  let relsDoc: Document
  try {
    relsDoc = archive.readXml(relsPathFor(partPath))
  } catch {
    return null
  }
  for (const rel of elems(relsDoc, RELS_NS, 'Relationship')) {
    if (rel.getAttribute('Id') === rId) {
      const target = rel.getAttribute('Target')
      if (target) return resolvePartPath(partPath, target)
    }
  }
  return null
}

/** Reads a media part's raw bytes (PNG/JPG/EMF/... - never parsed as XML). */
export async function readMediaBytes(archive: PptxArchive, mediaPath: string): Promise<Buffer> {
  return archive.readRawBytes(mediaPath)
}

/** Replaces a media part's bytes and marks it dirty - see PptxArchive.writeRawBytes. */
export function writeMediaBytes(archive: PptxArchive, mediaPath: string, bytes: Buffer): void {
  archive.writeRawBytes(mediaPath, bytes)
}
