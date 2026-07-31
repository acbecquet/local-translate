import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // Electron .exe launches are heavy on this machine (documented crash
  // history) - force fully serial execution so two instances are never
  // spawned concurrently across test files, which is what caused an
  // intermittent "Target page, context or browser has been closed" launch
  // failure once a second spec file was added.
  workers: 1,
  use: { trace: 'retain-on-failure' }
})
