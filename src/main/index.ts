import { app, BrowserWindow } from 'electron'
import path from 'node:path'

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
}
