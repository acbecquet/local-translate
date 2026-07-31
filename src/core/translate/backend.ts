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
  /**
   * Telemetry aggregated across every actual model call a backend made
   * while serving this one BatchResponse - the whole-group call, its retry,
   * any per-segment fallbacks, and (for OllamaBackend) the model capability
   * probe if one happened to run during this request. Optional: omitted
   * entirely for requests that never called the model at all (e.g. an
   * empty `segments` array), and any backend that doesn't track usage
   * (or a test double) simply never sets it - the pipeline treats a
   * missing `usage` as all-zero when aggregating for RunReport.stats.
   */
  usage?: {
    /** Sum of prompt tokens (ollama's `prompt_eval_count`) across every call counted below. */
    promptTokens: number
    /** Sum of completion tokens (ollama's `eval_count`) across every call counted below. */
    completionTokens: number
    /** Sum of per-call model duration, converted from ollama's nanosecond `total_duration` to milliseconds. */
    modelDurationMs: number
    /**
     * Number of model calls that actually returned a response and
     * contributed to the sums above - a transport-level failure (the
     * client call itself threw, so no response ever came back) contributes
     * nothing to sum against and is therefore not counted here, even
     * though `retries`/`perSegmentFallbacks` below still count it as an
     * attempted ladder step.
     */
    calls: number
    /** Number of whole-group retry attempts made (0 or 1 given the current ladder), regardless of whether the retry itself succeeded. */
    retries: number
    /** Number of per-segment fallback calls attempted (0..N, one per segment still unresolved after the retry), regardless of whether each fallback succeeded. */
    perSegmentFallbacks: number
  }
}

export interface TranslationBackend {
  listModels(): Promise<ModelInfo[]>
  pullModel(name: string, onProgress?: (pct: number) => void): Promise<void>
  translateBatch(req: BatchRequest): Promise<BatchResponse>
}
