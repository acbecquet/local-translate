// Thin electron-aware wiring: registers the ipcMain.handle() handlers the
// preload bridge's ipcRenderer.invoke() calls target, delegating every bit
// of actual logic to TranslateService (translate-service.ts, which stays
// electron-free) or to electron's own `shell` module for the two
// file-system-integration channels. See src/shared/ipc-contract.ts for the
// exact channel names/payload shapes this file and preload/index.ts both
// depend on.

import { ipcMain, shell } from 'electron'
import { IPC_CHANNELS, type TranslateRunRequest } from '../shared/ipc-contract'
import type { TranslateService } from './translate-service'

/** Narrows an ipcRenderer.invoke() payload to TranslateRunRequest, throwing a clear error instead of letting a malformed shape reach adapterFor()/runPipeline() with a confusing failure downstream. Renderer code is first-party (not remote content), but the IPC boundary is still untyped at runtime. */
function assertRunRequest(value: unknown): asserts value is TranslateRunRequest {
  const req = value as Partial<TranslateRunRequest> | null
  if (
    typeof req !== 'object' ||
    req === null ||
    typeof req.filePath !== 'string' ||
    req.filePath.length === 0 ||
    typeof req.sourceLang !== 'string' ||
    typeof req.targetLang !== 'string'
  ) {
    throw new Error('translate:run requires { filePath, sourceLang, targetLang }')
  }
}

function assertPath(value: unknown, channel: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${channel} requires a non-empty file path`)
  }
}

/**
 * Scopes app:openPath/app:showInFolder to files this app itself just
 * produced this session (TranslateService.isKnownOutPath - see its own doc
 * comment), rather than letting the renderer ask the main process to open
 * or reveal an arbitrary filesystem path. The renderer only ever calls
 * these with `report.outPath` verbatim, so this should never actually
 * reject in normal use - it's a hardening boundary, not a workflow the UI
 * is expected to hit.
 */
function assertKnownOutPath(service: TranslateService, filePath: string, channel: string): void {
  if (!service.isKnownOutPath(filePath)) {
    throw new Error(
      `${channel}: "${filePath}" was not produced by a completed translation this session`
    )
  }
}

export function registerIpc(service: TranslateService): void {
  ipcMain.handle(IPC_CHANNELS.translateRun, (_event, req: unknown) => {
    assertRunRequest(req)
    return service.run(req)
  })

  ipcMain.handle(IPC_CHANNELS.translateCancel, () => {
    service.cancel()
  })

  ipcMain.handle(IPC_CHANNELS.appOpenPath, async (_event, filePath: unknown) => {
    assertPath(filePath, IPC_CHANNELS.appOpenPath)
    assertKnownOutPath(service, filePath, IPC_CHANNELS.appOpenPath)
    // shell.openPath resolves to an empty string on success, or a
    // human-readable failure reason (e.g. "No application registered") -
    // never rejects on its own, so a failure has to be surfaced explicitly.
    const err = await shell.openPath(filePath)
    if (err) throw new Error(err)
  })

  ipcMain.handle(IPC_CHANNELS.appShowInFolder, (_event, filePath: unknown) => {
    assertPath(filePath, IPC_CHANNELS.appShowInFolder)
    assertKnownOutPath(service, filePath, IPC_CHANNELS.appShowInFolder)
    shell.showItemInFolder(filePath)
  })
}
