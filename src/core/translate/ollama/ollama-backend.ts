import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
 * What resolveModelCaps() falls back to for exactly one caller when
 * probeModelCaps() couldn't reach a verdict at all (a transport-level
 * failure - see probeModelCaps' doc comment). Optimistic (think:false +
 * the schema format) rather than the old pessimistic "assume it can't"
 * default: a wrong optimistic guess just means translateBatch's validation
 * ladder (retry, then per-segment fallback) burns an extra call or two,
 * whereas a wrong PERSISTED pessimistic guess would send think:true on
 * every call to a model that never actually failed the probe. This value
 * is deliberately never written to model-caps.json.
 */
const OPTIMISTIC_UNKNOWN_CAPS: ModelCaps = { structuredWithThinkOff: true }

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
      // Both fields must be present numbers before computing a percentage -
      // a progress event with only one of them (or a zero/undefined total)
      // would otherwise divide into NaN and hand the caller garbage.
      if (
        onProgress &&
        typeof part.completed === 'number' &&
        typeof part.total === 'number' &&
        part.total > 0
      ) {
        onProgress((part.completed / part.total) * 100)
      }
    }
  }

  async translateBatch(req: BatchRequest): Promise<BatchResponse> {
    if (req.segments.length === 0) return { translations: [] }

    const caps = await this.getModelCaps(req.model)
    const okById = new Map<string, TranslatedEntry>()
    // Reason a segment failed at the most recent attempt that touched it -
    // overwritten as the ladder progresses, and deleted the moment a
    // segment resolves. Whatever's left for an id once the ladder is done
    // is what gets surfaced in BatchResponse.failures.
    const reasonById = new Map<string, ValidationFailure | 'error'>()

    const attempt1 = await this.attemptGroup(req, caps)
    for (const o of attempt1.ok) okById.set(o.id, o)
    for (const f of attempt1.failed) reasonById.set(f.id, f.reason)

    let unresolvedIds = req.segments.map((s) => s.id).filter((id) => !okById.has(id))

    if (unresolvedIds.length > 0) {
      await delay(this.retryDelayMs)
      const attempt2 = await this.attemptGroup(req, caps)
      for (const o of attempt2.ok) {
        if (!okById.has(o.id)) {
          okById.set(o.id, o)
          reasonById.delete(o.id)
        }
      }
      for (const f of attempt2.failed) {
        if (!okById.has(f.id)) reasonById.set(f.id, f.reason)
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
        if (solved) {
          okById.set(id, solved)
          reasonById.delete(id)
        } else {
          // else: still unresolved after per-segment fallback -
          // deliberately absent from the response; the pipeline keeps the
          // original text. Record why, falling back to 'error' in the
          // (normally unreachable) case attemptGroup didn't report a
          // reason for this specific id.
          const failure = attempt.failed.find((f) => f.id === id)
          reasonById.set(id, failure?.reason ?? 'error')
        }
      }
    }

    const translations = req.segments
      .map((s) => okById.get(s.id))
      .filter((t): t is TranslatedEntry => t !== undefined)

    const failures = req.segments
      .filter((s) => !okById.has(s.id))
      .map((s) => ({ id: s.id, reason: reasonById.get(s.id) ?? 'error' }))

    return failures.length > 0 ? { translations, failures } : { translations }
  }

  /** One ollama.chat call for `req`, parsed and validated. Never throws - a transport-level failure becomes an all-'error' failure list, an unparseable/schema-invalid response becomes an all-'parse' one. */
  private async attemptGroup(
    req: BatchRequest,
    caps: ModelCaps
  ): Promise<{
    ok: TranslatedEntry[]
    failed: { id: string; reason: ValidationFailure | 'error' }[]
  }> {
    const raw = await this.callChat(req, caps)
    if (raw.kind !== 'ok') {
      return {
        ok: [],
        failed: req.segments.map((s) => ({ id: s.id, reason: raw.kind }))
      }
    }
    return validateBatch(req, raw.translations)
  }

  /**
   * Distinguishes, in the return value rather than by collapsing both into
   * `null`, WHY this call didn't produce usable translations: 'error' means
   * the ollama.chat call itself threw (server down, connection reset,
   * model still loading, any other transport-level failure) - the model
   * never actually responded, so there's nothing to blame on its output.
   * 'parse' means the model DID respond but that response wasn't valid
   * JSON matching BATCH_SCHEMA - a genuine output problem. Callers
   * (attemptGroup) surface this distinction as the failure reason instead
   * of reporting every kind of failure as 'parse'.
   */
  private async callChat(
    req: BatchRequest,
    caps: ModelCaps
  ): Promise<{ kind: 'ok'; translations: TranslatedEntry[] } | { kind: 'error' | 'parse' }> {
    const prompt = buildPrompt(req)
    let res: Awaited<ReturnType<Ollama['chat']>>
    try {
      res = await this.client.chat({
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
    } catch {
      return { kind: 'error' }
    }

    try {
      const content = stripThinkTags(res.message.content)
      const parsed: unknown = JSON.parse(content)
      const result = BATCH_SCHEMA.safeParse(parsed)
      return result.success
        ? { kind: 'ok', translations: result.data.translations }
        : { kind: 'parse' }
    } catch {
      return { kind: 'parse' }
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

    const outcome = await this.probeModelCaps(model)
    if (outcome.kind === 'unknown') return OPTIMISTIC_UNKNOWN_CAPS

    await this.persistModelCaps(model, outcome.caps)
    return outcome.caps
  }

  /**
   * Capability probe (contract point 4): a tiny schema request with
   * think: false. Two genuinely different outcomes here, which must NOT be
   * conflated (that was the bug: both used to become a persisted, permanent
   * structuredWithThinkOff:false):
   *   - The model responds, but that response doesn't parse as valid JSON
   *     matching PROBE_SCHEMA: a real, reproducible capability result -
   *     this model can't honor a JSON schema with thinking off. Safe (and
   *     meant) to cache forever.
   *   - The ollama.chat call itself throws (server down, connection reset,
   *     model still loading, any other transport error): we learned
   *     nothing about the model at all. Caching `false` here would
   *     permanently and incorrectly saddle a perfectly capable model with
   *     think:true on every future call, for a failure that had nothing to
   *     do with its capabilities.
   */
  private async probeModelCaps(
    model: string
  ): Promise<{ kind: 'known'; caps: ModelCaps } | { kind: 'unknown' }> {
    let res: Awaited<ReturnType<Ollama['chat']>>
    try {
      res = await this.client.chat({
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
    } catch {
      return { kind: 'unknown' }
    }

    try {
      const parsed: unknown = JSON.parse(stripThinkTags(res.message.content))
      return {
        kind: 'known',
        caps: { structuredWithThinkOff: PROBE_SCHEMA.safeParse(parsed).success }
      }
    } catch {
      return { kind: 'known', caps: { structuredWithThinkOff: false } }
    }
  }

  private async loadCapsFile(): Promise<Record<string, ModelCaps>> {
    if (this.capsMemo) return this.capsMemo
    try {
      const raw = await readFile(this.capsPath, 'utf8')
      this.capsMemo = sanitizeCapsFile(JSON.parse(raw))
    } catch {
      this.capsMemo = {}
    }
    return this.capsMemo
  }

  /**
   * Caps persistence is best-effort. The model was already successfully
   * probed by the time this runs - all this does is remember the result so
   * a *future* call/instance doesn't have to re-probe. A transient I/O
   * failure here (AV lock, disk full, permissions) must never propagate:
   * if it did, it would reject the shared capsWriteChain, and every later
   * persistModelCaps() call chains its `.then()` onto that already-
   * rejected promise and re-rejects forever - permanently poisoning caps
   * persistence for the rest of this instance's lifetime, and (worse)
   * bubbling out of resolveModelCaps()/getModelCaps()/translateBatch(),
   * bypassing the whole graceful-degradation ladder over something that
   * isn't even a translation failure. So every step below is caught
   * internally: the chained callback always resolves, never rejects, and
   * a failure still updates the in-memory memo (so this process won't
   * bother re-probing the same model again this run) even though the
   * on-disk file didn't get the update.
   */
  private async persistModelCaps(model: string, caps: ModelCaps): Promise<void> {
    this.capsWriteChain = this.capsWriteChain.then(async () => {
      let all: Record<string, ModelCaps>
      try {
        all = sanitizeCapsFile(JSON.parse(await readFile(this.capsPath, 'utf8')))
      } catch {
        all = {}
      }
      all[model] = caps

      try {
        await this.writeCapsFileAtomic(all)
        this.capsMemo = all
      } catch (err) {
        this.capsMemo = { ...(this.capsMemo ?? {}), [model]: caps }
        this.notePersistFailure(model, err)
      }
    })
    await this.capsWriteChain
  }

  /** Writes model-caps.json via write-to-temp-then-rename, so a crash or failure mid-write can never leave a truncated/corrupt JSON file at capsPath - readers only ever see the old complete file or the new complete file, never a partial one. */
  private async writeCapsFileAtomic(all: Record<string, ModelCaps>): Promise<void> {
    await mkdir(path.dirname(this.capsPath), { recursive: true })
    const tmpPath = `${this.capsPath}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    try {
      await writeFile(tmpPath, JSON.stringify(all, null, 2), 'utf8')
      await rename(tmpPath, this.capsPath)
    } catch (err) {
      await unlink(tmpPath).catch(() => {})
      throw err
    }
  }

  /** Best-effort visibility only - never thrown, and deliberately not spammed since persistModelCaps doesn't retry the write itself (one failure -> one note). */
  private notePersistFailure(model: string, err: unknown): void {
    console.warn(
      `OllamaBackend: failed to persist caps for model "${model}" to ${this.capsPath} ` +
        `(kept in memory for this process only): ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Validates the on-disk shape of model-caps.json entry by entry: only an
 * entry that is a plain object with a boolean `structuredWithThinkOff` is
 * kept. Anything else for a given model key - the parsed value not being
 * an object at all, a non-object entry, a missing field, or a field of the
 * wrong type (hand-edited or corrupted file, or a future format this
 * version doesn't understand) - is silently discarded rather than trusted
 * or allowed to crash a probe: a discarded entry is treated exactly like
 * that model was never cached, so resolveModelCaps() just re-probes it.
 */
function sanitizeCapsFile(parsed: unknown): Record<string, ModelCaps> {
  if (typeof parsed !== 'object' || parsed === null) return {}

  const out: Record<string, ModelCaps> = {}
  for (const [model, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { structuredWithThinkOff?: unknown }).structuredWithThinkOff === 'boolean'
    ) {
      out[model] = {
        structuredWithThinkOff: (entry as { structuredWithThinkOff: boolean })
          .structuredWithThinkOff
      }
    }
  }
  return out
}
