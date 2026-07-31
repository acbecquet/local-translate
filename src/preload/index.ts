import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC_CHANNELS,
  type LocalTranslateApi,
  type TranslateProgressEvent,
  type TranslateRunRequest,
  type TranslateStateEvent
} from '../shared/ipc-contract'
import { LANGUAGES } from '../shared/languages'

/**
 * The renderer-facing surface: LocalTranslateApi (the shared IPC contract)
 * plus `getPathForFile`, which is deliberately NOT part of that shared type
 * - it takes a DOM `File`, and ipc-contract.ts has to stay typecheckable
 * from both the DOM-less main process and the DOM-having renderer (see that
 * file's doc comment). Kept local to this file instead.
 */
type PreloadApi = LocalTranslateApi & {
  /** Resolves the absolute filesystem path a File object (from a drop or a <input type="file"> pick) points to, via Electron's webUtils - the renderer never gets raw filesystem access itself. */
  getPathForFile(file: File): string
}

const api: PreloadApi = {
  version: process.env.npm_package_version ?? 'dev',
  languages: LANGUAGES,

  getPathForFile: (file) => webUtils.getPathForFile(file),

  translate: (req: TranslateRunRequest) => ipcRenderer.invoke(IPC_CHANNELS.translateRun, req),
  cancel: () => ipcRenderer.invoke(IPC_CHANNELS.translateCancel),
  openPath: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.appOpenPath, filePath),
  showInFolder: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.appShowInFolder, filePath),

  onProgress: (listener: (e: TranslateProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, e: TranslateProgressEvent): void =>
      listener(e)
    ipcRenderer.on(IPC_CHANNELS.translateProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.translateProgress, handler)
  },

  onState: (listener: (e: TranslateStateEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, e: TranslateStateEvent): void => listener(e)
    ipcRenderer.on(IPC_CHANNELS.translateState, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.translateState, handler)
  }
}

contextBridge.exposeInMainWorld('localTranslate', api)
