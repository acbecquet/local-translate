import { useCallback, useEffect, useState } from 'react'
import type {
  RunReport,
  TranslateProgressEvent,
  TranslateState
} from '../../../shared/ipc-contract'
import { DropZone } from './DropZone'
import { ErrorPanel } from './ErrorPanel'
import { LanguageSelect } from './LanguageSelect'
import { ProgressPanel } from './ProgressPanel'
import { ResultPanel } from './ResultPanel'
import './runner.css'

const SOURCE_LANG_KEY = 'localTranslate.sourceLang'
const TARGET_LANG_KEY = 'localTranslate.targetLang'

const RUNNING_STATES: TranslateState[] = ['starting-ollama', 'translating']

function isRunning(state: TranslateState): boolean {
  return RUNNING_STATES.includes(state)
}

/** Reads a persisted language choice from localStorage, falling back to `fallback` when nothing was stored yet or the stored value is no longer one of the known languages (e.g. the language list changed between app versions). */
function readPersistedLang(key: string, languages: readonly string[], fallback: string): string {
  const stored = localStorage.getItem(key)
  return stored && languages.includes(stored) ? stored : fallback
}

export function Runner(): React.JSX.Element {
  const languages = window.localTranslate.languages

  const [filePath, setFilePath] = useState<string | null>(null)
  const [sourceLang, setSourceLang] = useState(() =>
    readPersistedLang(SOURCE_LANG_KEY, languages, languages[0])
  )
  const [targetLang, setTargetLang] = useState(() =>
    readPersistedLang(TARGET_LANG_KEY, languages, languages[1] ?? languages[0])
  )
  const [state, setState] = useState<TranslateState>('idle')
  const [progress, setProgress] = useState<TranslateProgressEvent | null>(null)
  const [result, setResult] = useState<RunReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem(SOURCE_LANG_KEY, sourceLang)
  }, [sourceLang])

  useEffect(() => {
    localStorage.setItem(TARGET_LANG_KEY, targetLang)
  }, [targetLang])

  useEffect(() => {
    const offProgress = window.localTranslate.onProgress(setProgress)
    const offState = window.localTranslate.onState((e) => {
      setState(e.state)
      if (e.state === 'error') setError(e.message ?? 'Something went wrong.')
    })
    return () => {
      offProgress()
      offState()
    }
  }, [])

  const running = isRunning(state)
  const canRun = filePath !== null && !running

  const handleRun = useCallback(async () => {
    if (!filePath) return
    setError(null)
    setResult(null)
    setProgress(null)
    try {
      const report = await window.localTranslate.translate({ filePath, sourceLang, targetLang })
      setResult(report)
    } catch (err) {
      // The 'translate:state' error event (handled above) is the primary
      // source of the error message; this only backstops the rare case
      // where the invoke rejected without that event having landed first.
      setError((prev) => prev ?? (err instanceof Error ? err.message : String(err)))
    }
  }, [filePath, sourceLang, targetLang])

  const handleCancel = useCallback(() => {
    void window.localTranslate.cancel()
  }, [])

  return (
    <div className="runner">
      <DropZone filePath={filePath} disabled={running} onFileSelected={setFilePath} />

      <div className="runner-languages">
        <LanguageSelect
          label="From"
          languages={languages}
          value={sourceLang}
          disabled={running}
          onChange={setSourceLang}
        />
        <LanguageSelect
          label="To"
          languages={languages}
          value={targetLang}
          disabled={running}
          onChange={setTargetLang}
        />
      </div>

      <div className="runner-actions">
        <button type="button" disabled={!canRun} onClick={() => void handleRun()}>
          Translate
        </button>
        {running && (
          <button type="button" onClick={handleCancel}>
            Cancel
          </button>
        )}
      </div>

      {isRunning(state) && (
        <ProgressPanel state={state as 'starting-ollama' | 'translating'} progress={progress} />
      )}

      {state === 'error' && error && <ErrorPanel message={error} />}

      {state === 'done' && result && <ResultPanel report={result} />}
    </div>
  )
}
