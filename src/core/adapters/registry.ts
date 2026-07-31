// Central registry of every FormatAdapter this app knows about. Both entry
// points that need to resolve a file to its adapter import this same list
// and pass it to adapterFor() (adapter.ts): the CLI (cli.ts) does so
// directly; the Electron main process's TranslateService (main/translate-
// service.ts) takes its adapters as an injectable dependency and uses this
// list as that dependency's default value. Either way, wiring up a new
// adapter here is enough to make it available from both without either
// entry point needing its own copy.
import type { FormatAdapter } from './adapter'
import { FakeAdapter } from './fake/fake-adapter'
import { PptxAdapter } from './pptx/pptx-adapter'

export const ADAPTERS: FormatAdapter[] = [new FakeAdapter(), new PptxAdapter()]
