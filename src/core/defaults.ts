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
 * Hardcoded for now during the benchmark/evaluation phase of picking a
 * default; a later release is expected to move this into user-configurable
 * settings instead.
 */
export const DEFAULT_MODEL = 'gemma4:e4b'
