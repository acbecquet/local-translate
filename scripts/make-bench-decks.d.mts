// Type declarations for make-bench-decks.mjs (plain ESM, never itself
// typechecked - matches every other scripts/*.mjs in this repo) so
// tests/core/bench/corpus.test.ts can import it under moduleResolution
// "bundler" without an inline suppression comment.
export declare const DEFAULT_OUT_DIR: string
export declare function generate(outDir?: string): Promise<string>
