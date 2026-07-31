/**
 * Test-only structural integrity check for a produced .pptx buffer: the zip
 * opens, every XML/rels part parses, and [Content_Types].xml declares a
 * content type (Default by extension, or an Override by exact part name)
 * for every part actually present in the archive.
 *
 * Deliberately independent of `src/core/adapters/pptx/ooxml.ts` (same
 * rationale as `build-pptx.ts`: this checks the ADAPTER's output from a
 * neutral standpoint, not through the same DOM-helper lens that produced
 * it) - it re-parses with `@xmldom/xmldom` directly rather than importing
 * `elems`/`childElems`.
 */
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import type { Element } from '@xmldom/xmldom'

export interface IntegrityResult {
  ok: boolean
  errors: string[]
}

const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const ELEMENT_NODE = 1

function directChildren(el: Element, ns: string, local: string): Element[] {
  const out: Element[] = []
  const children = el.childNodes
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i)
    if (
      child &&
      child.nodeType === ELEMENT_NODE &&
      (child as Element).namespaceURI === ns &&
      (child as Element).localName === local
    ) {
      out.push(child as Element)
    }
  }
  return out
}

export async function checkPptxIntegrity(buffer: Buffer): Promise<IntegrityResult> {
  const errors: string[] = []

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch (err) {
    return { ok: false, errors: [`not a valid zip: ${errorMessage(err)}`] }
  }

  const entries = Object.values(zip.files).filter((f) => !f.dir)

  for (const entry of entries) {
    if (!entry.name.endsWith('.xml') && !entry.name.endsWith('.rels')) continue
    const text = await entry.async('string')
    let parseError: string | null = null
    const parser = new DOMParser({
      onError: (level, msg) => {
        if (level !== 'warning') parseError = msg
      }
    })
    try {
      const doc = parser.parseFromString(text, 'application/xml')
      if (!doc.documentElement) parseError = 'no document element'
    } catch (err) {
      parseError = errorMessage(err)
    }
    if (parseError) errors.push(`${entry.name}: XML parse error: ${parseError}`)
  }

  const ctEntry = zip.file('[Content_Types].xml')
  if (!ctEntry) {
    errors.push('missing [Content_Types].xml')
    return { ok: false, errors }
  }

  const ctXml = await ctEntry.async('string')
  const ctDoc = new DOMParser().parseFromString(ctXml, 'application/xml')
  const typesEl = ctDoc.documentElement
  const defaultExts = new Set<string>()
  const overridePartNames = new Set<string>()
  if (typesEl) {
    for (const def of directChildren(typesEl, CT_NS, 'Default')) {
      const ext = def.getAttribute('Extension')
      if (ext) defaultExts.add(ext.toLowerCase())
    }
    for (const ov of directChildren(typesEl, CT_NS, 'Override')) {
      const partName = ov.getAttribute('PartName')
      if (partName) overridePartNames.add(partName)
    }
  }

  for (const entry of entries) {
    if (entry.name === '[Content_Types].xml') continue
    const partKey = `/${entry.name}`
    if (overridePartNames.has(partKey)) continue
    const ext = entry.name.split('.').pop()?.toLowerCase()
    if (ext && defaultExts.has(ext)) continue
    errors.push(
      `part not declared in [Content_Types].xml (no matching Default or Override): ${entry.name}`
    )
  }

  return { ok: errors.length === 0, errors }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
