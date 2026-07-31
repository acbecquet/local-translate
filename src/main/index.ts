import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { e2eFakeDeps } from './e2e-fakes'
import { registerIpc } from './ipc'
import { TranslateService } from './translate-service'
import { IPC_CHANNELS } from '../shared/ipc-contract'

// Held for the app's lifetime so 'before-quit' can stop the (possibly
// spawned) OllamaConnection it holds - see the before-quit handler below.
let translateService: TranslateService | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    title: 'local_translate',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Test-only seam (never set in production): swaps ensureOllama/the
  // backend (and, for 'dead-silent', onState too) for deterministic,
  // network-free fakes so Playwright can drive this exact built app
  // through the runner UI's error path and a mocked translate run without
  // ever touching a real Ollama install or model - see e2e-fakes.ts's
  // module doc comment. Spread AFTER the real onProgress/onState so a fake
  // mode's override (only 'dead-silent' provides one) wins over the real
  // webContents.send wiring, rather than the other way around.
  const fakeMode = process.env.LT_E2E_FAKE_BACKEND
  const depsOverrides =
    fakeMode === 'dead' || fakeMode === 'ok' || fakeMode === 'dead-silent'
      ? e2eFakeDeps(fakeMode)
      : {}

  translateService = new TranslateService({
    onProgress: (e) => win.webContents.send(IPC_CHANNELS.translateProgress, e),
    onState: (e) => win.webContents.send(IPC_CHANNELS.translateState, e),
    ...depsOverrides
  })
  registerIpc(translateService)

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(createWindow)
  app.on('window-all-closed', () => {
    app.quit()
  })
  app.on('before-quit', (event) => {
    if (!translateService) return
    // Defer the actual quit until the held OllamaConnection (if any) has
    // been stopped, so a spawned server is never left orphaned when the
    // user closes the window. translateService is cleared first so this
    // handler is a no-op on the re-entrant app.quit() call below.
    const service = translateService
    translateService = null
    event.preventDefault()
    void service.stop().finally(() => app.quit())
  })
}
