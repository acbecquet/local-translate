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
const NS_PER_MS = 1_000_000

type TranslatedEntry = { id: string; translation: string }

/** Per-call usage telemetry, already unit-converted (ns -> ms) and defaulted, extracted from one ollama.chat() response. */
type CallUsage = {
  promptTokens: number
  completionTokens: number
  modelDurationMs: number
  evalDurationMs: number
}

/**
 * Pulls usage telemetry off a raw ollama ChatResponse. The ollama npm
 * client's ChatResponse type (v0.6.x) declares prompt_eval_count,
 * eval_count, total_duration, and eval_duration (nanoseconds) as required
 * fields, but this project's own test mocks (and conceivably a real server
 * on an older protocol version) commonly hand back a bare
 * `{ message: { content } }` with none of them - so every field is read
 * defensively and defaulted to 0 rather than trusted as present, keeping
 * aggregation NaN-free.
 */
function extractUsage(res: {
  prompt_eval_count?: number
  eval_count?: number
  total_duration?: number
  eval_duration?: number
}): CallUsage {
  return {
    promptTokens: res.prompt_eval_count ?? 0,
    completionTokens: res.eval_count ?? 0,
    modelDurationMs: (res.total_duration ?? 0) / NS_PER_MS,
    evalDurationMs: (res.eval_duration ?? 0) / NS_PER_MS
  }
}

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
  private readonly capsProbes = new Map<
    string,
    Promise<{ caps: ModelCaps; probeUsage: CallUsage | null }>
  >()
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

    // Accumulates telemetry across every model call this one translateBatch
    // invocation ends up making - the group call, its retry, every
    // per-segment fallback, and the capability probe below if it actually
    // ran (as opposed to being served from cache). See BatchResponse.usage's
    // doc comment (backend.ts) for the exact accounting rules.
    const usage = {
      promptTokens: 0,
      completionTokens: 0,
      modelDurationMs: 0,
      evalDurationMs: 0,
      calls: 0,
      retries: 0,
      perSegmentFallbacks: 0
    }
    const addCall = (call: CallUsage | null): void => {
      // null means that attempt was a transport-level failure - no response
      // ever came back, so there's nothing to sum and it doesn't count as a
      // completed call (unlike the retry/fallback ladder-step counters
      // above, which count the ATTEMPT regardless of outcome).
      if (!call) return
      usage.promptTokens += call.promptTokens
      usage.completionTokens += call.completionTokens
      usage.modelDurationMs += call.modelDurationMs
      usage.evalDurationMs += call.evalDurationMs
      usage.calls += 1
    }

    const { caps, probeUsage } = await this.getModelCaps(req.model)
    addCall(probeUsage)

    const okById = new Map<string, TranslatedEntry>()
    // Reason a segment failed at the most recent attempt that touched it -
    // overwritten as the ladder progresses, and deleted the moment a
    // segment resolves. Whatever's left for an id once the ladder is done
    // is what gets surfaced in BatchResponse.failures.
    const reasonById = new Map<string, ValidationFailure | 'error'>()

    const attempt1 = await this.attemptGroup(req, caps)
    addCall(attempt1.usage)
    for (const o of attempt1.ok) okById.set(o.id, o)
    for (const f of attempt1.failed) reasonById.set(f.id, f.reason)

    let unresolvedIds = req.segments.map((s) => s.id).filter((id) => !okById.has(id))

    if (unresolvedIds.length > 0) {
      usage.retries += 1
      await delay(this.retryDelayMs)
      const attempt2 = await this.attemptGroup(req, caps)
      addCall(attempt2.usage)
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
        usage.perSegmentFallbacks += 1
        const singleReq: BatchRequest = { ...req, segments: [seg] }
        const attempt = await this.attemptGroup(singleReq, caps)
        addCall(attempt.usage)
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

    return failures.length > 0 ? { translations, failures, usage } : { translations, usage }
  }

  /** One ollama.chat call for `req`, parsed and validated. Never throws - a transport-level failure becomes an all-'error' failure list (and a null `usage`, since no response came back to read telemetry from), an unparseable/schema-invalid response becomes an all-'parse' one (with `usage` still populated - the model DID respond and spend real compute, even though its output was unusable). */
  private async attemptGroup(
    req: BatchRequest,
    caps: ModelCaps
  ): Promise<{
    ok: TranslatedEntry[]
    failed: { id: string; reason: ValidationFailure | 'error' }[]
    usage: CallUsage | null
  }> {
    const raw = await this.callChat(req, caps)
    if (raw.kind !== 'ok') {
      return {
        ok: [],
        failed: req.segments.map((s) => ({ id: s.id, reason: raw.kind })),
        usage: raw.kind === 'error' ? null : raw.usage
      }
    }
    return { ...validateBatch(req, raw.translations), usage: raw.usage }
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
  ): Promise<
    | { kind: 'ok'; translations: TranslatedEntry[]; usage: CallUsage }
    | { kind: 'parse'; usage: CallUsage }
    | { kind: 'error' }
  > {
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

    const usage = extractUsage(res)
    try {
      const content = stripThinkTags(res.message.content)
      const parsed: unknown = JSON.parse(content)
      const result = BATCH_SCHEMA.safeParse(parsed)
      return result.success
        ? { kind: 'ok', translations: result.data.translations, usage }
        : { kind: 'parse', usage }
    } catch {
      return { kind: 'parse', usage }
    }
  }

  // --- capability probe + model-caps.json cache --------------------------

  /**
   * Resolves this model's caps, alongside the capability probe's usage
   * telemetry if a probe actually executed while resolving them this call
   * (null when the caps came from the on-disk cache or the in-memory memo -
   * no model call was made at all). Concurrent callers for the same
   * not-yet-cached model share one in-flight probe via `capsProbes` (see
   * the field's own doc comment) - a documented, deliberately-accepted
   * consequence being that if two translateBatch() calls for the same
   * brand-new model race, BOTH observe (and both attribute to their own
   * BatchResponse.usage) the same single probe's telemetry. In practice
   * this never happens from runPipeline, which awaits each group's
   * translateBatch() before starting the next, so no two calls into this
   * backend are ever actually concurrent; it only matters for a caller
   * (or test) that deliberately fires overlapping translateBatch() calls.
   */
  private async getModelCaps(
    model: string
  ): Promise<{ caps: ModelCaps; probeUsage: CallUsage | null }> {
    const inFlight = this.capsProbes.get(model)
    if (inFlight) return inFlight

    const promise = this.resolveModelCaps(model).finally(() => {
      this.capsProbes.delete(model)
    })
    this.capsProbes.set(model, promise)
    return promise
  }

  private async resolveModelCaps(
    model: string
  ): Promise<{ caps: ModelCaps; probeUsage: CallUsage | null }> {
    const cached = (await this.loadCapsFile())[model]
    if (cached) return { caps: cached, probeUsage: null }

    const outcome = await this.probeModelCaps(model)
    if (outcome.kind === 'unknown') return { caps: OPTIMISTIC_UNKNOWN_CAPS, probeUsage: null }

    await this.persistModelCaps(model, outcome.caps)
    return { caps: outcome.caps, probeUsage: outcome.usage }
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
  ): Promise<{ kind: 'known'; caps: ModelCaps; usage: CallUsage } | { kind: 'unknown' }> {
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

    const usage = extractUsage(res)
    try {
      const parsed: unknown = JSON.parse(stripThinkTags(res.message.content))
      return {
        kind: 'known',
        caps: { structuredWithThinkOff: PROBE_SCHEMA.safeParse(parsed).success },
        usage
      }
    } catch {
      return { kind: 'known', caps: { structuredWithThinkOff: false }, usage }
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
