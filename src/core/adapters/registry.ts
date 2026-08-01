// Central registry of every FormatAdapter this app knows about. Both entry
// points that need to resolve a file to its adapter call buildAdapters()
// with this run's dependencies and pass the result to adapterFor()
// (adapter.ts): the CLI (cli.ts) does so directly; the Electron main
// process's TranslateService (main/translate-service.ts) calls it once per
// run() (its `sourceLang` varies per request - see AdapterDeps below).
import type { FormatAdapter } from './adapter'
import { createImageAdapter } from './images/image-adapter'
import { FakeAdapter } from './fake/fake-adapter'
import { PptxAdapter } from './pptx/pptx-adapter'
import type { RegionEngine } from '../images/regions'

export interface AdapterDeps {
  /**
   * null when no region engine is available (e.g. PP-OCR failed to load) -
   * excludes the image adapter entirely; pptx/fake are registered either
   * way (plan Task 4 behavior contract point 5).
   */
  regionEngine: RegionEngine | null
  /**
   * This run's source language, plumbed straight into the image adapter's
   * constructor opts - image-adapter.ts's extract() needs it for
   * source-language gating (see ../images/gating.ts).
   */
  sourceLang: string
}

/**
 * Builds the adapter list for one run. Always includes fake + pptx; the
 * image adapter is included only when `deps.regionEngine` is non-null,
 * constructed fresh (with this run's `sourceLang` baked in) every call -
 * see AdapterDeps's doc comments for why sourceLang can't just be a static
 * module-level constant the way the old `ADAPTERS` array was.
 */
export function buildAdapters(deps: AdapterDeps): FormatAdapter[] {
  const adapters: FormatAdapter[] = [new FakeAdapter(), new PptxAdapter()]
  if (deps.regionEngine) {
    adapters.push(createImageAdapter(deps.regionEngine, { sourceLang: deps.sourceLang }))
  }
  return adapters
}
