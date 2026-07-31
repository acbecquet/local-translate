export interface LanguageSelectProps {
  label: string
  languages: readonly string[]
  value: string
  disabled: boolean
  onChange: (value: string) => void
}

export function LanguageSelect({
  label,
  languages,
  value,
  disabled,
  onChange
}: LanguageSelectProps): React.JSX.Element {
  return (
    <label className="language-select">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {languages.map((lang) => (
          <option key={lang} value={lang}>
            {lang}
          </option>
        ))}
      </select>
    </label>
  )
}
