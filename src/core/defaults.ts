/**
 * Single source of truth for the CLI/app's default translation model, used
 * whenever `--model` (CLI) or a settings override (app) is omitted.
 * src/core/cli.ts and src/main/translate-service.ts previously each defined
 * their own copy of this literal (translate-service.ts deliberately avoided
 * importing cli.ts itself, a process-entry module with its own argv parsing
 * and process.exit() branch) - two independently maintained copies of the
 * same string is exactly how they'd silently drift, so both now import this
 * one instead (Phase 2 review rider).
 *
 * This is the ultimate fallback, not what's actually used at runtime:
 * champion.ts's resolveDefaultModel() sits in front of it, preferring the
 * model crowned by the phase-4 benchmark harness in config/champion.json
 * when that file is present and well-formed, and falling back to this
 * constant only when it's missing or malformed. cli.ts and
 * translate-service.ts both call resolveDefaultModel(), never this constant
 * directly, to pick their own default.
 */
export const DEFAULT_MODEL = 'gemma4:e4b'
