export interface ErrorPanelProps {
  message: string
}

/** Renders the actionable error message as-is (including e.g. an OllamaNotFoundError's embedded download URL) - preserves newlines so a multi-line message (message + "Download: <url>") stays readable instead of collapsing onto one line. */
export function ErrorPanel({ message }: ErrorPanelProps): React.JSX.Element {
  return (
    <div className="error-panel" role="alert" data-testid="error-panel">
      <p className="error-message">{message}</p>
    </div>
  )
}
