// Compile-time drift guard: src/shared/ipc-contract.ts's RunReport is a
// hand-kept structural COPY of src/core/pipeline.ts's RunReport (not an
// import - the renderer must never import src/core, see ipc-contract.ts's
// own doc comment). Nothing stops the two from drifting apart as either
// evolves independently. This file doesn't test any runtime BEHAVIOR; it
// exists so that if the two interfaces ever diverge (a field renamed,
// added, removed, or retyped on just one side), `npm run typecheck` fails
// immediately on the two `const` assignments below, rather than the
// mismatch surfacing later as a confusing runtime shape mismatch between
// what runPipeline() actually returns over IPC and what the renderer's
// type system believes it received.
//
// vitest's default transform (esbuild) strips types without checking them,
// so this guard's real enforcement is `tsc --noEmit` (part of `npm run
// typecheck`, which `npm run check` always runs before `test`) - the `it()`
// below is a genuine runtime double-check of VALUE compatibility on top of
// that, not the primary guard.

import { describe, expect, it } from 'vitest'
import type { RunReport as CoreRunReport } from '../../src/core/pipeline'
import type { RunReport as SharedRunReport } from '../../src/shared/ipc-contract'

describe('RunReport type sync (compile-time drift guard)', () => {
  it('src/shared/ipc-contract.ts RunReport stays mutually assignable with src/core/pipeline.ts RunReport', () => {
    const sample: CoreRunReport = {
      file: 'doc.fake.json',
      outPath: 'doc_translated.fake.json',
      total: 2,
      translated: 1,
      keptOriginal: [{ id: 's2', reason: 'skipped-untranslatable' }],
      overflowed: [{ id: 's1', fontSizePt: 10 }],
      skippedUnsupported: [{ id: 's3', reason: 'chart' }],
      durationMs: 5,
      stats: {
        model: 'test-model',
        phaseMs: { extract: 1, connect: 0, translate: 2, fit: 1, apply: 1 },
        groups: 1,
        modelCalls: 1,
        groupRetries: 0,
        perSegmentFallbacks: 0,
        promptTokens: 10,
        completionTokens: 4,
        tokensPerSec: 2.5,
        charsSource: 10,
        charsTranslated: 7,
        segmentsPerMin: 12
      }
    }

    // Assignable in BOTH directions. If either interface gains, loses,
    // renames, or retypes a field relative to the other, one of these two
    // lines stops compiling.
    const asShared: SharedRunReport = sample
    const asCoreAgain: CoreRunReport = asShared

    expect(asCoreAgain).toEqual(sample)
  })
})
