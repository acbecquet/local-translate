// Central registry of every FormatAdapter this app knows about. Both entry
// points that need to resolve a file to its adapter - the CLI (cli.ts) and
// the Electron main process (main/translate-service.ts) - import this same
// list via adapterFor(), so wiring up a new adapter here is enough to make
// it available from both without either entry point needing its own copy.
import type { FormatAdapter } from './adapter'
import { FakeAdapter } from './fake/fake-adapter'
import { PptxAdapter } from './pptx/pptx-adapter'

export const ADAPTERS: FormatAdapter[] = [new FakeAdapter(), new PptxAdapter()]
