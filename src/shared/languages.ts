// The 20 languages the runner UI offers in its source/target dropdowns.
// Lives in src/shared (not src/core) because the renderer needs it and must
// never import from src/core - see ipc-contract.ts's module doc comment.
// Node/Electron-free by design: just a constant and its derived type.

export const LANGUAGES = [
  'English',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Japanese',
  'Korean',
  'Spanish',
  'French',
  'German',
  'Portuguese (Brazilian)',
  'Italian',
  'Dutch',
  'Polish',
  'Swedish',
  'Indonesian',
  'Vietnamese',
  'Turkish',
  'Thai',
  'Arabic',
  'Hindi',
  'Russian'
] as const

export type Language = (typeof LANGUAGES)[number]
