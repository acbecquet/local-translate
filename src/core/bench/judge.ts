/**
 * LLM-judge rubric scoring: turns (source, translation) pairs from a
 * completed benchmark cell into per-segment JudgeScore rows by asking a
 * large judge model to rate each segment 1-5 on three fixed dimensions
 * (accuracy, fluency, format - see JUDGE_SYSTEM_PROMPT for the exact
 * wording, locked verbatim against the phase-4 plan's rubric). This is the
 * quality half of the benchmark: metrics.ts's judgementQuality turns the
 * JudgeScore[] this module produces into the meanOverall/tier numbers the
 * report and champion ranking read.
 *
 * The validation ladder mirrors translate/batching.ts's shape at the same
 * granularity: one whole-batch call, then - only if something is still
 * unresolved - exactly one whole-batch retry (re-sending every input in the
 * batch, not just the unresolved ones, same as buildRetryPrompt's own doc
 * comment describes for translation), then exactly one per-segment fallback
 * call per id still unresolved after that. A segment unresolved even after
 * its own fallback call is OMITTED from the result rather than given a
 * fabricated score - metrics.ts's `judged` vs `ofSegments` makes that
 * shortfall visible instead of silently padding the average. Never a loop:
 * every rung of the ladder runs at most once per id, so a batch of N inputs
 * makes at most 2 + N transport calls, full stop.
 *
 * Response validation is deliberately two-layered, not one flat zod schema
 * over the whole array, so one malformed entry never discards its
 * well-formed siblings in the same response (the same per-segment partial
 * credit batching.ts's validateBatch already gives translations - only a
 * broken TOP-LEVEL shape, not a single entry's own out-of-range value,
 * counts as a whole-response parse failure here). The three rubric
 * dimensions' 1-5 integer bounds are enforced by ONE schema
 * (SCORE_ENTRY_SCHEMA), reused both as the structured-output constraint
 * handed to the model (JUDGE_RESPONSE_JSON_SCHEMA, via z.toJSONSchema) and
 * as the per-entry validator run against whatever the model actually sent
 * back - never duplicated as a second set of manual comparisons.
 *
 * Transport-failure handling is a deliberate DEPARTURE from
 * ollama-backend.ts's translateBatch, not an oversight: that backend
 * swallows a transport-level throw into a per-segment 'error' failure so
 * translateBatch always resolves (the pipeline needs a decision - translate
 * or keep original - for every segment to keep processing the document).
 * JudgeTransport.chat() returns a bare Promise<string> with no error
 * channel, so this module instead lets a transport throw propagate straight
 * out of judgeSegments() uncaught, rather than absorbing it into the retry/
 * fallback ladder. This is the only way the caller (bench-cli.ts's `judge`
 * subcommand, Task 9) can tell "the judge is down" (a rejected promise -
 * abort the run, matching harness.ts's own transport-class-failure-aborts-
 * remaining-work philosophy) apart from "the judge scored badly" (a
 * resolved but shorter-than-`inputs` array - a normal, honest outcome of
 * the ladder). It also avoids a worse failure mode: a genuinely down judge
 * would otherwise fail every attempt identically, and burning the full
 * retry-plus-per-segment-fallback ladder on every batch of every remaining
 * cell against a server that can never answer would multiply one outage
 * into thousands of wasted calls during an unattended multi-hour judge pass.
 */
import { z } from 'zod'
import type { JudgeScore } from './store'

/** Bump on ANY rubric or prompt-text change - stored judgements keyed on it go stale automatically. */
export const JUDGE_PROMPT_VERSION = 'v1'

export const JUDGE_BATCH_SIZE = 8

/**
 * One (source, translation) pair to score. Carries its own sourceLang/
 * targetLang (rather than those living once at the judgeSegments() call
 * level) so the type stays self-contained; in practice every real call's
 * inputs share one pair, since one judgeSegments() call scores one stored
 * cell (one model x one corpus item x one language pair) - see
 * buildJudgeUserPrompt, which derives the "language pair" header from
 * whichever chunk is currently being sent.
 */
export interface JudgeInput {
  segmentId: string
  source: string
  translation: string
  sourceLang: string
  targetLang: string
}

export interface JudgeTransport {
  /** One structured chat call: format = the given JSON schema, temperature 0, think off. Returns the raw content string. */
  chat(req: { model: string; system: string; user: string; schema: object }): Promise<string>
}

/**
 * The rubric, locked verbatim against the phase-4 plan's three dimension
 * descriptions. Only those three lines and the "each an integer from 1 to
 * 5" constraint are load-bearing for judgement quality; the rest is output-
 * format instruction. Bump JUDGE_PROMPT_VERSION on any change to this text.
 */
const JUDGE_SYSTEM_PROMPT =
  'You are an expert translation quality judge for internal business documents.\n' +
  'Score every listed segment on three dimensions, each an integer from 1 to 5:\n' +
  'accuracy 1-5: the translation preserves the full meaning; numbers, names, and codes are intact.\n' +
  'fluency 1-5: the text reads naturally in the target language for a business document.\n' +
  'format 1-5: units, placeholders, punctuation conventions, and casing survive appropriately.\n' +
  'Score every segment independently, using its own id from the input. ' +
  'Return ONLY the JSON demanded by the schema, with exactly one score object per input id and no extra ids.'

/**
 * One score entry's full shape - the id plus the three rubric dimensions,
 * each a 1-5 integer. Bounds are enforced HERE, in the schema, not via
 * manual comparisons: reused both as the model's structured-output
 * constraint (JUDGE_RESPONSE_JSON_SCHEMA below) and as the per-entry
 * validator in reconcileScores, so the bounds are defined exactly once.
 */
const SCORE_ENTRY_SCHEMA = z.object({
  id: z.string(),
  accuracy: z.int().min(1).max(5),
  fluency: z.int().min(1).max(5),
  format: z.int().min(1).max(5)
})

/**
 * The full strict shape - {scores: [...]} with every entry already bounded -
 * used only as the source for JUDGE_RESPONSE_JSON_SCHEMA below, never to
 * parse an actual response (see RAW_RESPONSE_SCHEMA/reconcileScores for why
 * parsing a real response is deliberately more lenient than the constraint
 * we ask the model to honor).
 */
const JUDGE_RESPONSE_SCHEMA = z.object({ scores: z.array(SCORE_ENTRY_SCHEMA) })

/** JSON schema sent as `format` on every judge chat call. Computed once at module load since it never varies per call. */
const JUDGE_RESPONSE_JSON_SCHEMA: object = z.toJSONSchema(JUDGE_RESPONSE_SCHEMA)

/**
 * Loose top-level shape used to parse an ACTUAL response: only requires
 * `scores` to be present and an array, leaving each element `unknown` until
 * reconcileScores validates it individually against SCORE_ENTRY_SCHEMA. A
 * response that isn't even this shape (not JSON at all, or a missing/
 * non-array `scores`) is a whole-response parse failure; a response that
 * has this shape but contains one bad entry among good ones is not - see
 * the module doc comment.
 */
const RAW_RESPONSE_SCHEMA = z.object({ scores: z.array(z.unknown()) })

/** Splits `items` into fixed-size chunks of at most `size`, preserving order; the last chunk may be smaller. */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * Strips a <think>...</think> block from model output before JSON.parse -
 * the same defensive step ollama-backend.ts's own stripThinkTags takes
 * (some local models leak a reasoning trace into content even with a
 * format schema supplied and thinking requested off - see
 * https://github.com/ollama/ollama/issues/15260). Duplicated here rather
 * than imported: bench/ and translate/ollama/ are independent modules, and
 * this is a one-line regex, not shared state.
 */
function stripThinkTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

/**
 * The user message half of one judge chat call: "Language pair: X -> Y"
 * followed by the JSON array of {id, source, translation} the brief
 * specifies. The pair is read off the first item, since every real call's
 * inputs share one pair (see JudgeInput's doc comment) - each chunk this
 * runs against (whole batch, retry, or a one-item fallback) derives the
 * header from its own first item.
 */
function buildJudgeUserPrompt(items: JudgeInput[]): string {
  const pair = items.length > 0 ? `${items[0].sourceLang} -> ${items[0].targetLang}` : '(none)'
  const payload = items.map((i) => ({
    id: i.segmentId,
    source: i.source,
    translation: i.translation
  }))
  return `Language pair: ${pair}\n${JSON.stringify(payload)}`
}

/**
 * Validates each raw scores-array entry independently against
 * SCORE_ENTRY_SCHEMA and reconciles against `items`' requested ids: an
 * entry must both pass the schema AND its id must appear exactly once
 * among the valid entries to be kept (a missing, out-of-bounds, or
 * duplicated id is simply absent from the result - never fabricated,
 * never guessed at). Mirrors batching.ts's validateBatch reconciliation at
 * the same granularity, minus the failure-reason bookkeeping JudgeScore
 * has no room for.
 */
function reconcileScores(items: JudgeInput[], rawScores: unknown[]): JudgeScore[] {
  const requestedIds = new Set(items.map((i) => i.segmentId))
  const countById = new Map<string, number>()
  const validById = new Map<string, JudgeScore>()

  for (const raw of rawScores) {
    const parsed = SCORE_ENTRY_SCHEMA.safeParse(raw)
    if (!parsed.success) continue
    const { id, accuracy, fluency, format } = parsed.data
    countById.set(id, (countById.get(id) ?? 0) + 1)
    validById.set(id, { segmentId: id, accuracy, fluency, format })
  }

  const resolved: JudgeScore[] = []
  for (const id of countById.keys()) {
    if (!requestedIds.has(id)) continue // not part of this request - ignore
    if (countById.get(id) !== 1) continue // duplicate - ambiguous, drop
    const score = validById.get(id)
    if (score) resolved.push(score)
  }
  return resolved
}

/**
 * One structured chat call for `items` (a whole batch, or a single item for
 * a per-segment fallback call), parsed and reconciled into JudgeScore[] -
 * possibly empty, possibly partial, NEVER throwing for a bad response
 * (unparseable JSON or a schema-invalid top-level shape both just resolve
 * to []). A transport-level failure is the one thing this does NOT catch:
 * `transport.chat()` is awaited un-guarded, so a rejection propagates
 * straight out of callJudge (and from there out of judgeBatch and
 * judgeSegments) - see the module doc comment for why that is the
 * deliberate, documented behavior for a transport failure specifically, as
 * opposed to a content validation failure.
 */
async function callJudge(
  items: JudgeInput[],
  judgeModel: string,
  transport: JudgeTransport
): Promise<JudgeScore[]> {
  const raw = await transport.chat({
    model: judgeModel,
    system: JUDGE_SYSTEM_PROMPT,
    user: buildJudgeUserPrompt(items),
    schema: JUDGE_RESPONSE_JSON_SCHEMA
  })

  let outer: unknown
  try {
    outer = JSON.parse(stripThinkTags(raw))
  } catch {
    return []
  }

  const parsedOuter = RAW_RESPONSE_SCHEMA.safeParse(outer)
  if (!parsedOuter.success) return []

  return reconcileScores(items, parsedOuter.data.scores)
}

/**
 * The validation ladder for one batch (at most JUDGE_BATCH_SIZE items): one
 * whole-batch call; on anything still unresolved, one whole-batch retry
 * (re-sending every item in `batch`, not just the unresolved ones); on
 * anything STILL unresolved after that, one per-segment fallback call each.
 * Whatever remains unresolved after its own fallback call is omitted from
 * the return - see the module doc comment. Provably bounded: at most
 * 2 + batch.length transport calls, never a loop.
 */
async function judgeBatch(
  batch: JudgeInput[],
  judgeModel: string,
  transport: JudgeTransport
): Promise<JudgeScore[]> {
  const resolvedById = new Map<string, JudgeScore>()
  const applyScores = (scores: JudgeScore[]): void => {
    for (const score of scores) {
      // Never overwrite an id an earlier rung already resolved - mirrors
      // ollama-backend.ts's translateBatch, which keeps attempt 1's result
      // even if the whole-group retry response also mentions that id.
      if (!resolvedById.has(score.segmentId)) resolvedById.set(score.segmentId, score)
    }
  }
  const unresolvedOf = (items: JudgeInput[]): JudgeInput[] =>
    items.filter((i) => !resolvedById.has(i.segmentId))

  applyScores(await callJudge(batch, judgeModel, transport))

  let unresolved = unresolvedOf(batch)
  if (unresolved.length > 0) {
    applyScores(await callJudge(batch, judgeModel, transport)) // whole-batch retry: resend everything
    unresolved = unresolvedOf(batch)
  }

  if (unresolved.length > 0) {
    for (const item of unresolved) {
      applyScores(await callJudge([item], judgeModel, transport)) // per-segment fallback: exactly one input
    }
  }

  return batch
    .map((i) => resolvedById.get(i.segmentId))
    .filter((s): s is JudgeScore => s !== undefined)
}

/**
 * Scores `inputs` against the fixed accuracy/fluency/format rubric via
 * `transport`, chunked into JUDGE_BATCH_SIZE-sized batches (see judgeBatch
 * for the per-batch validation ladder). Batches run strictly sequentially -
 * matching this codebase's machine rule that nothing overcommits a
 * single-slot local model server (lifecycle.ts sets
 * OLLAMA_NUM_PARALLEL=1). A transport-level failure at any point propagates
 * out of this function uncaught (see the module doc comment); anything this
 * function DOES return completed without incident, even if shorter than
 * `inputs` - an honest gap, not a fabricated score (see judgeBatch).
 */
export async function judgeSegments(
  inputs: JudgeInput[],
  judgeModel: string,
  transport: JudgeTransport
): Promise<JudgeScore[]> {
  if (inputs.length === 0) return []

  const results: JudgeScore[] = []
  for (const batch of chunk(inputs, JUDGE_BATCH_SIZE)) {
    results.push(...(await judgeBatch(batch, judgeModel, transport)))
  }
  return results
}

/**
 * JudgeTransport backed by a raw POST to <baseUrl>/api/chat - the same
 * minimal-fetch style as lifecycle.ts's probeVersion and harness.ts's
 * unloadModel (both one-shot ollama REST calls), rather than the `ollama`
 * npm client OllamaBackend uses: this transport needs exactly one endpoint
 * and no capability-probing/caching state, so the npm client's extra
 * surface (list/pull, caps memoization) would be pure unused weight here.
 * Always requests temperature 0 (via `options.temperature`) and thinking
 * off, and forwards the caller's JSON schema as `format` verbatim - the
 * rubric/parsing logic lives in judge.ts's callJudge, not here; this
 * function is pure I/O. Checks `res.ok` explicitly (mirrors unloadModel/
 * probeVersion): fetch() only rejects on a network-level failure, so a
 * 4xx/5xx response would otherwise read as a successful call with unusable
 * content.
 */
export function createOllamaJudgeTransport(baseUrl: string): JudgeTransport {
  return {
    async chat(req): Promise<string> {
      const res = await fetch(new URL('/api/chat', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user }
          ],
          format: req.schema,
          think: false,
          stream: false,
          options: { temperature: 0 }
        })
      })
      if (!res.ok) {
        throw new Error(
          `judge transport: POST ${baseUrl}/api/chat responded ${res.status} ${res.statusText}`
        )
      }
      const data = (await res.json()) as { message?: { content?: string } }
      const content = data.message?.content
      if (typeof content !== 'string') {
        throw new Error('judge transport: response missing message.content')
      }
      return content
    }
  }
}
