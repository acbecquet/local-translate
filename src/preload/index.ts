import { contextBridge } from 'electron'

// IPC surface lands in Phase 1/2; keep the bridge in place so renderer code
// can rely on window.localTranslate existing from day one.
contextBridge.exposeInMainWorld('localTranslate', {
  version: process.env.npm_package_version ?? 'dev'
})
