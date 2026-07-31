import type { TranslateProgressEvent } from '../../../shared/ipc-contract'

export interface ProgressPanelProps {
  state: 'starting-ollama' | 'translating'
  progress: TranslateProgressEvent | null
}

const PHASE_LABELS: Record<string, string> = {
  extract: 'Reading document',
  translate: 'Translating',
  fit: 'Fitting text to layout',
  apply: 'Writing result'
}

export function ProgressPanel({ state, progress }: ProgressPanelProps): React.JSX.Element {
  if (state === 'starting-ollama') {
    return (
      <div className="progress-panel" data-testid="progress-panel">
        <p className="progress-phase">Starting Ollama...</p>
      </div>
    )
  }

  const phaseLabel = progress ? (PHASE_LABELS[progress.phase] ?? progress.phase) : 'Translating'
  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="progress-panel" data-testid="progress-panel">
      <p className="progress-phase">{phaseLabel}</p>
      <div
        className="progress-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {progress && (
        <p className="progress-count">
          {progress.done} / {progress.total}
        </p>
      )}
    </div>
  )
}
