# Evidence - phase-1

Real translation artifacts, captured 2026-07-31T16:40:37.431Z at commit `bd60f32`.
Original document: [original-gate-5.fake.json](original-gate-5.fake.json)

- [translated-en-zh.fake.json](translated-en-zh.fake.json) - English -> Chinese (Simplified), translated locally
- [translated-zh-en.fake.json](translated-zh-en.fake.json) - Chinese (Simplified) -> English, translated locally

## Fit proof: translated-en-zh.fake.json

| id | box (pt) | font pt orig -> fitted | lines | box height used |
|---|---|---|---|---|
| en-01 | 320x40 | 28 -> 28 | 1 | 84% |
| en-02 | 260x80 | 14 -> 14 | 3 | 63% |
| en-03 | 180x24 | 12 -> 12 | 1 | 60% |
| zh-01 | 300x60 | 12 -> 12 | 2 | 48% |
| zh-02 | 220x24 | 12 -> 12 | 1 | 60% |

## Fit proof: translated-zh-en.fake.json

| id | box (pt) | font pt orig -> fitted | lines | box height used |
|---|---|---|---|---|
| en-01 | 320x40 | 28 -> 23 | 1 | 69% |
| en-02 | 260x80 | 14 -> 14 | 4 | 84% |
| en-03 | 180x24 | 12 -> 12 | 1 | 60% |
| zh-01 | 300x60 | 12 -> 12 | 3 | 72% |
| zh-02 | 220x24 | 12 -> 12 | 1 | 60% |

Regenerate: `node scripts/capture-evidence.mjs phase-1` (or `--report-only` to rebuild this README without re-translating).
