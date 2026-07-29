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
 */
export function buildPrompt(req: BatchRequest): RenderedPrompt {
  const system = buildSystemPrompt(req)
  const user = buildUserPrompt(req)
  return { system, user, text: `System: ${system}\nUser: ${user}` }
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
