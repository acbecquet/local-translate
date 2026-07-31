import type { RunReport } from '../../../shared/ipc-contract'

export interface ResultPanelProps {
  report: RunReport
}

export function ResultPanel({ report }: ResultPanelProps): React.JSX.Element {
  return (
    <div className="result-panel" data-testid="result-panel">
      <p>
        Translated {report.translated} of {report.total} segments in {report.durationMs} ms.
      </p>
      <p className="result-path">{report.outPath}</p>
      <div className="result-actions">
        <button type="button" onClick={() => void window.localTranslate.openPath(report.outPath)}>
          Open result
        </button>
        <button
          type="button"
          onClick={() => void window.localTranslate.showInFolder(report.outPath)}
        >
          Show in folder
        </button>
      </div>
      {report.overflowed.length > 0 && (
        <p className="result-warning">
          {report.overflowed.length} segment{report.overflowed.length === 1 ? '' : 's'} overflowed
          and were shrunk to the smallest fitting size.
        </p>
      )}
    </div>
  )
}
