import type { LocalTranslateApi } from '../../shared/ipc-contract'

declare global {
  interface Window {
    localTranslate: LocalTranslateApi & {
      /** Resolves the absolute filesystem path behind a File from a drop or a <input type="file"> pick - see src/preload/index.ts. */
      getPathForFile(file: File): string
    }
  }
}

export {}
