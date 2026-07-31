// Types shared by main, preload, and renderer for the typed IPC surface
// (see task-4-brief.md for the exact channel list). Deliberately free of
// Node/Electron imports - types and constants only - so the renderer bundle
// can import this file directly instead of reaching into src/core, which it
// must never do (src/core is the headless engine; the renderer only ever
// talks to it indirectly, through the main process, over this contract).
//
// `RunReport` below is a hand-kept structural copy of src/core/pipeline.ts's
// RunReport, not an import of it - same reasoning. Passing a real RunReport
// value across ipcMain.handle's structured-clone boundary satisfies this
// type automatically as long as the two shapes are kept in sync.

export interface TranslateRunRequest {
  filePath: string
  sourceLang: string
  targetLang: string
}

export interface RunReport {
  file: string
  outPath: string
  total: number
  translated: number
  keptOriginal: { id: string; reason: string }[]
  overflowed: { id: string; fontSizePt: number }[]
  skippedUnsupported: { id: string; reason: string }[]
  durationMs: number
  stats: {
    model: string
    phaseMs: { extract: number; connect: number; translate: number; fit: number; apply: number }
    groups: number
    modelCalls: number
    groupRetries: number
    perSegmentFallbacks: number
    promptTokens: number
    completionTokens: number
    tokensPerSec: number
    charsSource: number
    charsTranslated: number
    segmentsPerMin: number
  }
}

export interface TranslateProgressEvent {
  done: number
  total: number
  phase: string
}

export type TranslateState = 'idle' | 'starting-ollama' | 'translating' | 'done' | 'error'

export interface TranslateStateEvent {
  state: TranslateState
  message?: string
}

/** IPC channel names - the single source of truth used by both the main-process registration (src/main/ipc.ts) and the preload bridge (src/preload/index.ts), so the two can never drift apart. */
export const IPC_CHANNELS = {
  translateRun: 'translate:run',
  translateCancel: 'translate:cancel',
  appOpenPath: 'app:openPath',
  appShowInFolder: 'app:showInFolder',
  translateProgress: 'translate:progress',
  translateState: 'translate:state'
} as const

/**
 * The surface preload/index.ts exposes on `window.localTranslate` via
 * contextBridge. `onProgress`/`onState` return an unsubscribe function
 * (mirrors the common DOM/React "cleanup callback" convention) rather than
 * requiring the renderer to hold onto and pass back a raw ipcRenderer
 * listener reference, which would leak an Electron type into renderer code.
 *
 * `getPathForFile` is deliberately NOT part of this interface: it takes a
 * DOM `File`, and this file must stay usable from both the renderer
 * (DOM lib) and the main/preload process (Node lib, no DOM) without either
 * side's ambient `File` type fighting the other. See
 * src/renderer/src/global.d.ts, which extends this interface with that one
 * DOM-typed extra member for renderer code only.
 */
export interface LocalTranslateApi {
  version: string
  languages: readonly string[]
  translate(req: TranslateRunRequest): Promise<RunReport>
  cancel(): Promise<void>
  openPath(filePath: string): Promise<void>
  showInFolder(filePath: string): Promise<void>
  onProgress(listener: (e: TranslateProgressEvent) => void): () => void
  onState(listener: (e: TranslateStateEvent) => void): () => void
}
