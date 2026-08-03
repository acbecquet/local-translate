import type { BatchRequest } from './backend'

/**
 * A rendered prompt, split by role for `ollama.chat`'s `messages` array,
 * plus the full "System: ...\nUser: ..." transcript (`text`) for logging
 * and for asserting the exact template text in tests.
 */
export interface RenderedPrompt {
  system: string
  user: string
  text: string
}

/**
 * Builds the translation prompt for one batch. The system message is the
 * fixed instruction template with {source}/{target}/{glossary}/
 * {groupContext} substituted; the user message is the JSON array of
 * {id, text} the model must translate. `text` glues both together behind
 * literal "System: "/"User: " prefixes purely as a readable transcript -
 * `system`/`user` are what actually get sent as separate chat messages.
 *
 * This is the FIRST-ATTEMPT (whole-group) rung of the validation ladder.
 * Its output must stay byte-identical over time (see the regression pin in
 * tests/core/translate/ollama-backend.test.ts): it is what the vast
 * majority of segments already translate correctly against on the first
 * try, so it must never be touched to chase a fix that belongs on the
 * retry/fallback rungs instead (see buildRetryPrompt/buildFallbackPrompt
 * below).
 */
export function buildPrompt(req: BatchRequest): RenderedPrompt {
  return renderPrompt(req, buildSystemPrompt(req))
}

/**
 * Validation ladder's SECOND rung (the whole-group retry after attempt 1's
 * response failed validation for at least one segment). Identical to
 * buildPrompt's system message, plus exactly one added sentence telling the
 * model that echoing the source text unchanged is a failure - a cheap
 * nudge, cheaper than the per-segment fallback's worked example, since a
 * whole-group retry re-sends every segment in the batch (not just the
 * unresolved ones).
 */
export function buildRetryPrompt(req: BatchRequest): RenderedPrompt {
  const system = `${buildSystemPrompt(req)} ${retryAntiEchoSentence(req.targetLang)}`
  return renderPrompt(req, system)
}

/**
 * Validation ladder's THIRD and LAST rung: one call per segment still
 * unresolved after the whole-group retry. An echo here is the most costly
 * outcome in the ladder - there is no further attempt after this one, so
 * whatever this call returns (or fails to) is what the pipeline keeps. This
 * is why only this rung earns the full anti-echo instruction plus a worked
 * example (buildRetryPrompt's single added sentence is a cheaper nudge for
 * the whole-group retry, not this fallback).
 */
export function buildFallbackPrompt(req: BatchRequest): RenderedPrompt {
  const system = `${buildSystemPrompt(req)}\n${fallbackAntiEchoInstructions(req.targetLang)}`
  return renderPrompt(req, system)
}

function renderPrompt(req: BatchRequest, system: string): RenderedPrompt {
  const user = buildUserPrompt(req)
  return { system, user, text: `System: ${system}\nUser: ${user}` }
}

/**
 * The retry rung's one added sentence (see buildRetryPrompt). Parameterized
 * by target language the same way buildSystemPrompt already is - plain
 * string interpolation, no per-language special-casing.
 */
function retryAntiEchoSentence(targetLang: string): string {
  return (
    `Do not return any segment's source text unchanged: short labels, codes, and other terse ` +
    `alphanumeric segments must still be translated into ${targetLang} wherever they contain ` +
    `translatable words.`
  )
}

/**
 * The per-segment fallback rung's anti-echo block (see buildFallbackPrompt):
 * an explicit statement that an unchanged echo is a failure mode, followed
 * by one worked example. Parameterized by target language the same way
 * buildSystemPrompt already is - plain string interpolation, no
 * per-language special-casing - so the worked example is a generic template
 * describing which kinds of tokens get translated versus kept, not a
 * hardcoded translation into any specific language.
 */
function fallbackAntiEchoInstructions(targetLang: string): string {
  return (
    `Anti-echo rule: returning a segment's source text unchanged is a failure, not a safe fallback. ` +
    `This applies even to short labels, codes, and technical fragments - they must still be rendered ` +
    `in ${targetLang}: translate every translatable word, and keep only genuinely untranslatable ` +
    `tokens (product codes like "HTHH-1", proper-noun brand names) exactly as they appear in the source.\n` +
    // The keep-token in the example is an ACRONYM brand (MPX), deliberately
    // not a real dictionary word in caps: an all-caps real word (RESIN,
    // ROSIN) is usually still translatable, and an example that kept one
    // would teach the model to preserve exactly the tokens Charlie's gate
    // feedback wants translated.
    `Worked example: given the label "2-10 Batch User-3 MPX", a correct ${targetLang} translation ` +
    `renders "Batch" and "User" in ${targetLang} while keeping the code "2-10" and the brand acronym ` +
    `"MPX" unchanged, producing a mixed string rather than a verbatim copy of the source label. ` +
    `An ordinary dictionary word is still translatable even when written in capital letters.`
  )
}

function buildSystemPrompt(req: BatchRequest): string {
  return (
    `You are a professional translator for internal business documents.\n` +
    `Translate each segment from ${req.sourceLang} to ${req.targetLang}.\n` +
    `Rules: return ONLY the JSON demanded by the schema; translate every segment independently; ` +
    `preserve line breaks inside segments; do not translate numbers, codes, or proper nouns that ` +
    `have no ${req.targetLang} equivalent; glossary (must-use): ${formatGlossary(req.glossary)}.\n` +
    `Document context: ${req.groupContext}`
  )
}

function buildUserPrompt(req: BatchRequest): string {
  return JSON.stringify(req.segments.map((s) => ({ id: s.id, text: s.text })))
}

function formatGlossary(glossary: Record<string, string> | undefined): string {
  if (!glossary) return '(none)'
  const entries = Object.entries(glossary)
  if (entries.length === 0) return '(none)'
  return entries.map(([term, translation]) => `${term} -> ${translation}`).join('; ')
}
