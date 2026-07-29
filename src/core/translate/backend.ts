// Protocol layer: the shapes every translation backend (currently just
// OllamaBackend, see ./ollama/ollama-backend.ts) must implement, and the
// request/response contract batching.ts and the pipeline build against.
// Deliberately dependency-free (no zod, no ollama import) so the pipeline
// can depend on this file without pulling in a specific backend's runtime.

export interface ModelInfo {
  name: string
  sizeBytes: number
}

export interface ModelCaps {
  structuredWithThinkOff: boolean
}

export interface BatchRequest {
  model: string
  sourceLang: string
  targetLang: string
  groupContext: string
  glossary?: Record<string, string>
  segments: { id: string; text: string }[]
}

export interface BatchResponse {
  translations: { id: string; translation: string }[]
  /**
   * Segments that ended up absent from `translations` after the full
   * validation ladder (whole-group call, whole-group retry, per-segment
   * fallback ran and still couldn't resolve them), and why - one of
   * 'parse' | 'id-mismatch' | 'empty' | 'echo' | 'error' (kept as `string`
   * here rather than importing ValidationFailure, since backend.ts stays
   * dependency-free of batching.ts). Optional and present only when
   * non-empty. The pipeline keeps each such segment's original text and
   * can use this instead of guessing why - e.g. for its RunReport's
   * keptOriginal reasons.
   */
  failures?: { id: string; reason: string }[]
}

export interface TranslationBackend {
  listModels(): Promise<ModelInfo[]>
  pullModel(name: string, onProgress?: (pct: number) => void): Promise<void>
  translateBatch(req: BatchRequest): Promise<BatchResponse>
}
