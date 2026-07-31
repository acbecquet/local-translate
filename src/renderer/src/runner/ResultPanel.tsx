import { useCallback } from 'react'
import type { RunReport } from '../../../shared/ipc-contract'

export interface ResultPanelProps {
  report: RunReport
  /** Reports a secondary failure (e.g. Open result/Show in folder rejecting) into the shared error area, alongside - not instead of - this still-valid result. */
  onError: (message: string) => void
}

function describeCatch(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function ResultPanel({ report, onError }: ResultPanelProps): React.JSX.Element {
  const handleOpen = useCallback(() => {
    window.localTranslate
      .openPath(report.outPath)
      .catch((err: unknown) => onError(`could not open file: ${describeCatch(err)}`))
  }, [report.outPath, onError])

  const handleShowInFolder = useCallback(() => {
    window.localTranslate
      .showInFolder(report.outPath)
      .catch((err: unknown) => onError(`could not show file in folder: ${describeCatch(err)}`))
  }, [report.outPath, onError])

  return (
    <div className="result-panel" data-testid="result-panel">
      <p>
        Translated {report.translated} of {report.total} segments in {report.durationMs} ms.
      </p>
      <p className="result-path">{report.outPath}</p>
      <div className="result-actions">
        <button type="button" onClick={handleOpen}>
          Open result
        </button>
        <button type="button" onClick={handleShowInFolder}>
          Show in folder
        </button>
      </div>
      {report.overflowed.length > 0 && (
        <p className="result-warning">
          {report.overflowed.length} segment{report.overflowed.length === 1 ? '' : 's'} could not be
          fitted (at minimum size, may overflow).
        </p>
      )}
      {report.skippedUnsupported.length > 0 && (
        <p className="result-warning">
          {report.skippedUnsupported.length} unsupported item
          {report.skippedUnsupported.length === 1 ? '' : 's'} skipped (left untouched).
        </p>
      )}
    </div>
  )
}
