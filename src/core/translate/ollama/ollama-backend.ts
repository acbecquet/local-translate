import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Ollama } from 'ollama'
import { z } from 'zod'
import type {
  BatchRequest,
  BatchResponse,
  ModelCaps,
  ModelInfo,
  TranslationBackend
} from '../backend'
import { type ValidationFailure, validateBatch } from '../batching'
import { buildPrompt } from '../prompts'

const DEFAULT_RETRY_DELAY_MS = 500
const CAPS_FILE_NAME = 'model-caps.json'

type TranslatedEntry = { id: string; translation: string }

const BATCH_SCHEMA = z.object({
  translations: z.array(z.object({ id: z.string(), translation: z.string() }))
})

/** Tiny schema used purely to probe whether a model can honor JSON-schema-constrained output with thinking off. */
const PROBE_SCHEMA = z.object({ ok: z.boolean() })

/**
 * Strips a <think>...</think> block from model output before JSON.parse.
 * The ollama client already separates message.thinking from message.content
 * in v0.6.x, so this should normally be a no-op - but some local models
 * leak their reasoning trace into content anyway even when a `format`
 * schema is supplied, especially at think:true (see
 * https://github.com/ollama/ollama/issues/15260). Stripping defensively
 * here means a leaked trace never breaks JSON.parse downstream.
 */
function stripThinkTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * TranslationBackend implementation backed by a local Ollama server.
 * translateBatch() runs the validation ladder from the task brief:
 *   1. ollama.chat with `format` set to the batch JSON schema and thinking
 *      per this model's cached capability probe.
 *   2. Parse + per-segment validation (validateBatch).
 *   3. On any failure: retry the whole group once; any segments still
 *      unresolved after that go through one per-segment call each; any
 *      still unresolved after THAT are simply absent from the response -
 *      the caller (pipeline) is expected to keep the original text.
 *   4. Model capability (`structuredWithThinkOff`) is probed once per
 *      model and cached in `<appDataDir>/model-caps.json`, both across
 *      calls on this instance and across process restarts.
 */
export class OllamaBackend implements TranslationBackend {
  private readonly client: Ollama
  private readonly capsPath: string
  private readonly retryDelayMs: number

  private capsMemo: Record<string, ModelCaps> | null = null
  // Single-flight guard: concurrent translateBatch() calls needing caps for
  // the same not-yet-cached model share one probe instead of each issuing
  // their own ollama.chat probe call. Checked and populated synchronously
  // (no await before the .set()) so two calls issued back-to-back without
  // an intervening await can never both observe "no in-flight probe" and
  // race into probing twice.
  private readonly capsProbes = new Map<string, Promise<ModelCaps>>()
  // Serializes every read-modify-write of model-caps.json on this
  // instance, so probing two different models concurrently can't have one
  // write clobber the other (each write waits for, and reads the result
  // of, the previous one in the chain).
  private capsWriteChain: Promise<void> = Promise.resolve()

  constructor(opts: { baseUrl: string; appDataDir: string; retryDelayMs?: number }) {
    this.client = new Ollama({ host: opts.baseUrl })
    this.capsPath = path.join(opts.appDataDir, CAPS_FILE_NAME)
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.client.list()
    return res.models.map((m) => ({ name: m.name, sizeBytes: m.size }))
  }

  async pullModel(name: string, onProgress?: (pct: number) => void): Promise<void> {
    const stream = await this.client.pull({ model: name, stream: true })
    for await (const part of stream) {
      if (onProgress && typeof part.total === 'number' && part.total > 0) {
        onProgress((part.completed / part.total) * 100)
      }
    }
  }

  async translateBatch(req: BatchRequest): Promise<BatchResponse> {
    if (req.segments.length === 0) return { translations: [] }

    const caps = await this.getModelCaps(req.model)
    const okById = new Map<string, TranslatedEntry>()

    const attempt1 = await this.attemptGroup(req, caps)
    for (const o of attempt1.ok) okById.set(o.id, o)

    let unresolvedIds = req.segments.map((s) => s.id).filter((id) => !okById.has(id))

    if (unresolvedIds.length > 0) {
      await delay(this.retryDelayMs)
      const attempt2 = await this.attemptGroup(req, caps)
      for (const o of attempt2.ok) {
        if (!okById.has(o.id)) okById.set(o.id, o)
      }
      unresolvedIds = req.segments.map((s) => s.id).filter((id) => !okById.has(id))
    }

    if (unresolvedIds.length > 0) {
      const segById = new Map(req.segments.map((s) => [s.id, s]))
      for (const id of unresolvedIds) {
        const seg = segById.get(id)
        if (!seg) continue
        const singleReq: BatchRequest = { ...req, segments: [seg] }
        const attempt = await this.attemptGroup(singleReq, caps)
        const solved = attempt.ok.find((o) => o.id === id)
        if (solved) okById.set(id, solved)
        // else: still unresolved after per-segment fallback - deliberately
        // absent from the response; the pipeline keeps the original text.
      }
    }

    const translations = req.segments
      .map((s) => okById.get(s.id))
      .filter((t): t is TranslatedEntry => t !== undefined)

    return { translations }
  }

  /** One ollama.chat call for `req`, parsed and validated. Never throws - unparseable/schema-invalid responses become an all-'parse' failure list. */
  private async attemptGroup(
    req: BatchRequest,
    caps: ModelCaps
  ): Promise<{ ok: TranslatedEntry[]; failed: { id: string; reason: ValidationFailure }[] }> {
    const raw = await this.callChat(req, caps)
    if (raw === null) {
      return {
        ok: [],
        failed: req.segments.map((s) => ({ id: s.id, reason: 'parse' as const }))
      }
    }
    return validateBatch(req, raw.translations)
  }

  private async callChat(
    req: BatchRequest,
    caps: ModelCaps
  ): Promise<{ translations: TranslatedEntry[] } | null> {
    const prompt = buildPrompt(req)
    try {
      const res = await this.client.chat({
        model: req.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ],
        format: z.toJSONSchema(BATCH_SCHEMA),
        // caps.structuredWithThinkOff false means probeModelCaps found this
        // model can't reliably honor a JSON schema with thinking off - fall
        // back to thinking-on (and rely on stripThinkTags above to remove
        // any leaked trace before parsing).
        think: !caps.structuredWithThinkOff,
        stream: false
      })
      const content = stripThinkTags(res.message.content)
      const parsed: unknown = JSON.parse(content)
      const result = BATCH_SCHEMA.safeParse(parsed)
      return result.success ? result.data : null
    } catch {
      return null
    }
  }

  // --- capability probe + model-caps.json cache --------------------------

  private async getModelCaps(model: string): Promise<ModelCaps> {
    const inFlight = this.capsProbes.get(model)
    if (inFlight) return inFlight

    const promise = this.resolveModelCaps(model).finally(() => {
      this.capsProbes.delete(model)
    })
    this.capsProbes.set(model, promise)
    return promise
  }

  private async resolveModelCaps(model: string): Promise<ModelCaps> {
    const cached = (await this.loadCapsFile())[model]
    if (cached) return cached

    const caps = await this.probeModelCaps(model)
    await this.persistModelCaps(model, caps)
    return caps
  }

  /**
   * Capability probe (contract point 4): a tiny schema request with
   * think: false. If the response doesn't parse as valid JSON matching
   * PROBE_SCHEMA - including any transport/client error - the model is
   * recorded as unable to do structured output with thinking off, and
   * every future translateBatch() call for this model uses thinking-on
   * plus trace-stripping instead (see callChat/stripThinkTags).
   */
  private async probeModelCaps(model: string): Promise<ModelCaps> {
    try {
      const res = await this.client.chat({
        model,
        messages: [
          {
            role: 'user',
            content: 'Capability probe: reply with a JSON object matching the schema.'
          }
        ],
        format: z.toJSONSchema(PROBE_SCHEMA),
        think: false,
        stream: false
      })
      const parsed: unknown = JSON.parse(stripThinkTags(res.message.content))
      return { structuredWithThinkOff: PROBE_SCHEMA.safeParse(parsed).success }
    } catch {
      return { structuredWithThinkOff: false }
    }
  }

  private async loadCapsFile(): Promise<Record<string, ModelCaps>> {
    if (this.capsMemo) return this.capsMemo
    try {
      const raw = await readFile(this.capsPath, 'utf8')
      this.capsMemo = JSON.parse(raw) as Record<string, ModelCaps>
    } catch {
      this.capsMemo = {}
    }
    return this.capsMemo
  }

  private async persistModelCaps(model: string, caps: ModelCaps): Promise<void> {
    this.capsWriteChain = this.capsWriteChain.then(async () => {
      let all: Record<string, ModelCaps>
      try {
        all = JSON.parse(await readFile(this.capsPath, 'utf8')) as Record<string, ModelCaps>
      } catch {
        all = {}
      }
      all[model] = caps
      await mkdir(path.dirname(this.capsPath), { recursive: true })
      await writeFile(this.capsPath, JSON.stringify(all, null, 2), 'utf8')
      this.capsMemo = all
    })
    await this.capsWriteChain
  }
}
