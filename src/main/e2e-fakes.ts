// Deterministic, network-free fake TranslateServiceDeps used ONLY when the
// LT_E2E_FAKE_BACKEND env var is set (see main/index.ts). This lets
// Playwright drive the real, built app through the runner UI's dead-backend
// error path and a fully mocked translate run - without ever touching a
// real Ollama install, spawning any process, or invoking a model. Per this
// project's machine rules, live-model E2E is a separate, explicitly-gated
// path (LT_E2E_LIVE=1) that this file has nothing to do with and never
// reads.
//
// Ships in every build (same pattern as lifecycle.ts's
// OLLAMA_FAKE_SERVE_SCRIPT seam) but is completely inert unless that env
// var is present - production runs never set it.

import type { TranslationBackend } from '../core/translate/backend'
import { OllamaNotFoundError, type OllamaConnection } from '../core/translate/ollama/lifecycle'
import type { TranslateServiceDeps } from './translate-service'

export type E2EFakeBackendMode = 'dead' | 'ok'

/** Small delay so the runner UI's progress panel has a moment to render before the mocked run completes - not a stand-in for real model latency, just enough padding for Playwright's assertions to observe the transient 'translating' state reliably. */
const FAKE_TRANSLATE_DELAY_MS = 200

/**
 * `'dead'` - ensureOllama always rejects with OllamaNotFoundError, exactly
 * as it would on a machine with no Ollama install, for exercising the
 * runner's actionable error panel.
 *
 * `'ok'` - ensureOllama resolves instantly to a fake connection, and the
 * backend echoes back canned translations (prefixed with the target
 * language) for every segment it's asked to translate, for exercising the
 * progress bar and result panel end to end.
 */
export function e2eFakeDeps(
  mode: E2EFakeBackendMode
): Partial<Pick<TranslateServiceDeps, 'ensureOllama' | 'createBackend'>> {
  if (mode === 'dead') {
    return {
      ensureOllama: (): Promise<OllamaConnection> => {
        throw new OllamaNotFoundError('https://ollama.com/download')
      }
    }
  }

  return {
    ensureOllama: async (): Promise<OllamaConnection> => ({
      baseUrl: 'http://127.0.0.1:0',
      spawned: false,
      stop: async () => {}
    }),
    createBackend: (): TranslationBackend => ({
      listModels: async () => [],
      pullModel: async () => {},
      translateBatch: async (req) => {
        await new Promise((resolve) => setTimeout(resolve, FAKE_TRANSLATE_DELAY_MS))
        return {
          translations: req.segments.map((s) => ({
            id: s.id,
            translation: `[${req.targetLang}] ${s.text}`
          }))
        }
      }
    })
  }
}
