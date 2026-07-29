# Phase 0: Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution chosen for this phase: scaffold tasks share evolving state in package.json, so per-task subagents would add overhead without isolation benefit). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A committed, building, testable Electron+TS skeleton wired to the GitHub repo, producing an unsigned NSIS installer locally and green CI on push.

**Architecture:** electron-vite project layout (src/main, src/preload, src/renderer) extended with src/core for the headless engine; React in the renderer; vitest for unit tests, Playwright for Electron E2E; electron-builder for NSIS packaging.

**Tech Stack:** electron, electron-vite, React 18+, TypeScript, vitest, @playwright/test, eslint (flat config) + prettier, electron-builder.

**Master plan:** [2026-07-29-local-translate-master-plan.md](2026-07-29-local-translate-master-plan.md)

## Global Constraints (inherited)

- License AGPL-3.0-only; LICENSE file is the full GNU AGPL v3 text.
- Product name everywhere: `local_translate`. npm package name: `local-translate` (npm forbids underscores in new names).
- Conventional commits, no co-author lines, commit at every green checkpoint.
- Versions: install latest at execution time; package-lock.json is the pin record.
- `src/core` must never import Electron (enforced by eslint rule in Task 5).

---

### Task 1: Repo hygiene (LICENSE, .gitignore, README)

**Files:**

- Create: `LICENSE` (full AGPL-3.0 text from https://www.gnu.org/licenses/agpl-3.0.txt)
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Fetch LICENSE**

Run: `curl -s https://www.gnu.org/licenses/agpl-3.0.txt -o LICENSE`
Expected: file starts with "GNU AFFERO GENERAL PUBLIC LICENSE" and "Version 3".

- [ ] **Step 2: Write .gitignore**

```gitignore
node_modules/
out/
dist_installer/
*.log
.DS_Store
test-results/
playwright-report/
*.local
```

- [ ] **Step 3: Write README.md**

```markdown
# local_translate

Fully local file translation.
No cloud, no accounts, no data leaving the machine.

Right-click any supported file (pptx, xlsx, pdf, png, jpg), choose "Translate with local translate", and get a translated copy where every string fits its original text box with zero cutoffs.
Translation runs on local models via managed Ollama; the built-in benchmark harness battle-tests new models against the current champion so the app improves as open models do.

Status: pre-release scaffolding.
See docs/superpowers/specs/ for the design and docs/superpowers/plans/ for the roadmap.

License: AGPL-3.0-only.
```

- [ ] **Step 4: Commit**

```bash
git add LICENSE .gitignore README.md
git commit -m "chore: add license, gitignore, readme"
```

---

### Task 2: Electron + Vite + TypeScript app skeleton

**Files:**

- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`
- Create: `src/main/index.ts`, `src/preload/index.ts`
- Create: `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`

**Interfaces:**

- Produces: `out/main/index.js` as the Electron entry (Tasks 4 and 6 depend on this path); window title `local_translate` (Task 4 asserts it).

- [ ] **Step 1: Write package.json**

```json
{
  "name": "local-translate",
  "productName": "local_translate",
  "version": "0.1.0",
  "description": "Fully local file translator: every string fits its original box, zero cloud.",
  "license": "AGPL-3.0-only",
  "author": "Charlie Becquet",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "lint": "eslint .",
    "format": "prettier --check .",
    "format:fix": "prettier --write .",
    "check": "npm run typecheck && npm run lint && npm run format && npm run test",
    "dist": "electron-vite build && electron-builder --win nsis"
  }
}
```

- [ ] **Step 2: Install dependencies (latest, recorded in lockfile)**

```bash
npm install --save-dev electron electron-vite vite typescript @vitejs/plugin-react vitest @playwright/test eslint @eslint/js typescript-eslint eslint-config-prettier prettier electron-builder @types/node @types/react @types/react-dom
npm install react react-dom
```

- [ ] **Step 3: Write electron.vite.config.ts**

```ts
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
```

- [ ] **Step 4: Write tsconfigs**

`tsconfig.json`:

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

`tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "composite": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": [
    "src/main/**/*",
    "src/preload/**/*",
    "src/core/**/*",
    "tests/**/*",
    "electron.vite.config.ts",
    "playwright.config.ts"
  ]
}
```

`tsconfig.web.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "composite": true,
    "skipLibCheck": true,
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"]
  },
  "include": ["src/renderer/**/*"]
}
```

- [ ] **Step 5: Write src/main/index.ts**

```ts
import { app, BrowserWindow } from 'electron'
import path from 'node:path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    title: 'local_translate',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(createWindow)
  app.on('window-all-closed', () => {
    app.quit()
  })
}
```

- [ ] **Step 6: Write src/preload/index.ts**

```ts
import { contextBridge } from 'electron'

// IPC surface lands in Phase 1/2; keep the bridge in place so renderer code
// can rely on window.localTranslate existing from day one.
contextBridge.exposeInMainWorld('localTranslate', {
  version: process.env.npm_package_version ?? 'dev'
})
```

- [ ] **Step 7: Write renderer entry**

`src/renderer/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>local_translate</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`:

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

`src/renderer/src/App.tsx`:

```tsx
export function App(): React.JSX.Element {
  return (
    <main>
      <h1>local_translate</h1>
      <p>Fully local file translation. Scaffold build.</p>
    </main>
  )
}
```

- [ ] **Step 8: Verify build**

Run: `npm run build`
Expected: exits 0; `out/main/index.js`, `out/preload/index.js`, `out/renderer/index.html` all exist.

- [ ] **Step 9: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json electron.vite.config.ts tsconfig*.json src/
git commit -m "feat: electron-vite react-ts app skeleton"
```

---

### Task 3: Unit testing (vitest) with first real core module

**Files:**

- Create: `src/core/app-info.ts`
- Test: `tests/core/app-info.test.ts`
- Create: `vitest.config.ts`

**Interfaces:**

- Produces: `APP_NAME = 'local_translate'`, `CONTEXT_MENU_LABEL = 'Translate with local translate'` (Phase 6 context-menu module consumes these exact constants).

- [ ] **Step 1: Write the failing test**

`tests/core/app-info.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { APP_NAME, CONTEXT_MENU_LABEL } from '../../src/core/app-info'

describe('app-info', () => {
  it('locks the product name', () => {
    expect(APP_NAME).toBe('local_translate')
  })

  it('locks the Explorer verb label with a space, not an underscore', () => {
    expect(CONTEXT_MENU_LABEL).toBe('Translate with local translate')
  })
})
```

- [ ] **Step 2: Write vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**']
  }
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, cannot resolve `../../src/core/app-info`.

- [ ] **Step 4: Write minimal implementation**

`src/core/app-info.ts`:

```ts
export const APP_NAME = 'local_translate'
export const CONTEXT_MENU_LABEL = 'Translate with local translate'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/core/ tests/core/ vitest.config.ts
git commit -m "test: vitest wiring with app-info constants"
```

---

### Task 4: E2E smoke test (Playwright drives the built app)

**Files:**

- Create: `playwright.config.ts`
- Test: `tests/e2e/app.spec.ts`

- [ ] **Step 1: Write playwright.config.ts**

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  use: { trace: 'retain-on-failure' }
})
```

- [ ] **Step 2: Write the smoke test**

`tests/e2e/app.spec.ts`:

```ts
import { expect, test, _electron as electron } from '@playwright/test'

test('app launches and shows the scaffold window', async () => {
  const app = await electron.launch({ args: ['out/main/index.js'] })
  const window = await app.firstWindow()
  await expect(window.locator('h1')).toHaveText('local_translate')
  expect(await window.title()).toBe('local_translate')
  await app.close()
})
```

- [ ] **Step 3: Run it against a fresh build**

Run: `npm run build && npm run test:e2e`
Expected: 1 passed.
Note: Electron E2E uses the local electron binary; no `npx playwright install` browser downloads are needed or wanted.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts tests/e2e/
git commit -m "test: playwright electron smoke test"
```

---

### Task 5: Lint + format + check script

**Files:**

- Create: `eslint.config.js`, `.prettierrc.json`, `.prettierignore`

- [ ] **Step 1: Write eslint.config.js (flat config)**

```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['out/', 'dist_installer/', 'node_modules/', 'playwright-report/', 'test-results/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'src/core must stay Electron-free (headless engine).' }
          ]
        }
      ]
    }
  },
  prettier
)
```

- [ ] **Step 2: Write .prettierrc.json and .prettierignore**

`.prettierrc.json`:

```json
{
  "semi": false,
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "none"
}
```

`.prettierignore`:

```
out/
dist_installer/
package-lock.json
playwright-report/
test-results/
```

- [ ] **Step 3: Format the tree once**

Run: `npm run format:fix`

- [ ] **Step 4: Verify the full gate**

Run: `npm run check`
Expected: typecheck, lint, format, and unit tests all pass (exit 0).

- [ ] **Step 5: Commit**

```bash
git add eslint.config.js .prettierrc.json .prettierignore .
git commit -m "chore: eslint flat config, prettier, check gate"
```

---

### Task 6: NSIS installer via electron-builder

**Files:**

- Create: `electron-builder.yml`

- [ ] **Step 1: Write electron-builder.yml**

```yaml
appId: com.becquet.localtranslate
productName: local_translate
directories:
  output: dist_installer
files:
  - out/**
  - package.json
win:
  target: nsis
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  artifactName: local_translate-setup-${version}.exe
```

- [ ] **Step 2: Build the installer**

Run: `npm run dist`
Expected: exits 0; `dist_installer/local_translate-setup-0.1.0.exe` exists.

- [ ] **Step 3: Smoke the packed app**

Run the installer manually OR verify `dist_installer/win-unpacked/local_translate.exe` launches and shows the scaffold window (headless check: launch, screenshot via Playwright against the unpacked exe is acceptable).
Expected: window appears with "local_translate" heading.

- [ ] **Step 4: Commit**

```bash
git add electron-builder.yml
git commit -m "build: nsis installer via electron-builder"
```

---

### Task 7: CI (GitHub Actions)

**Files:**

- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

jobs:
  check-build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run check
      - run: npm run build

  installer:
    if: github.event_name == 'workflow_dispatch'
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run dist
      - uses: actions/upload-artifact@v4
        with:
          name: installer
          path: dist_installer/*.exe
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/
git commit -m "ci: check and build on push, installer on dispatch"
git push
```

- [ ] **Step 3: Verify CI green**

Run: `gh run watch --exit-status` (or `gh run list --limit 1` until completed).
Expected: check-build job succeeds.

---

## Phase verification gate (from master plan)

- `npm run check` green locally.
- `npm run dist` produces `dist_installer/local_translate-setup-0.1.0.exe`.
- CI green on GitHub.
- Packed app launches and shows the scaffold window.

## Self-review

- Spec/master coverage: Task 1 -> hygiene, Task 2 -> skeleton + framework decision (React, per master default), Tasks 3-5 -> test/lint gates, Task 6 -> installer, Task 7 -> CI. Playwright smoke covers the "empty app launches" gate.
- No placeholders: every file's full content is inline.
- Type consistency: entry path `out/main/index.js` used identically in package.json, Playwright spec, and electron-builder files list; `local_translate` title asserted in Task 4 matches Task 2's window and HTML title.
- E2E is excluded from vitest via `exclude: ['tests/e2e/**']` and Playwright's testDir, so `npm test` and `npm run test:e2e` never overlap.
