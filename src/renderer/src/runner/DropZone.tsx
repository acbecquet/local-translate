import { useCallback, useRef, useState } from 'react'

const ACCEPTED_SUFFIXES = ['.pptx', '.png', '.jpg', '.jpeg', '.fake.json']

function isAcceptedFile(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPTED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

export interface DropZoneProps {
  filePath: string | null
  disabled: boolean
  onFileSelected: (path: string) => void
}

/** Drop zone accepting .pptx/.fake.json, with a plain <input type="file"> fallback for picking (also used by the Playwright e2e suite via setInputFiles, since simulating a real OS drag-and-drop isn't practical there). */
export function DropZone({ filePath, disabled, onFileSelected }: DropZoneProps): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false)
  const [rejected, setRejected] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const acceptFile = useCallback(
    (file: File) => {
      if (!isAcceptedFile(file.name)) {
        setRejected(
          `"${file.name}" is not a supported file (expected .pptx, .png/.jpg/.jpeg, or .fake.json).`
        )
        return
      }
      setRejected(null)
      onFileSelected(window.localTranslate.getPathForFile(file))
    },
    [onFileSelected]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setIsDragging(false)
      if (disabled) return
      const file = event.dataTransfer.files[0]
      if (file) acceptFile(file)
    },
    [acceptFile, disabled]
  )

  const handlePick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (file) acceptFile(file)
      // Reset so picking the same path again still fires a change event.
      event.target.value = ''
    },
    [acceptFile]
  )

  return (
    <div
      className={`drop-zone${isDragging ? ' drop-zone-active' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setIsDragging(true)
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      data-testid="drop-zone"
    >
      <p className="drop-zone-hint">
        {filePath ?? 'Drop a .pptx, image (.png/.jpg/.jpeg), or .fake.json file here'}
      </p>
      <button type="button" disabled={disabled} onClick={() => inputRef.current?.click()}>
        Choose file...
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pptx,.png,.jpg,.jpeg,.json"
        hidden
        onChange={handlePick}
        data-testid="file-input"
      />
      {rejected && (
        <p className="drop-zone-rejected" role="alert">
          {rejected}
        </p>
      )}
    </div>
  )
}
