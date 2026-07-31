import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Machine rule: no GPU/model/Ollama invocations from this suite. Every test
// below launches the real built app (out/main/index.js) with
// LT_E2E_FAKE_BACKEND set, which swaps ensureOllama/the translation backend
// for deterministic, network-free fakes (see src/main/e2e-fakes.ts) -
// 'dead' always fails like a machine with no Ollama install (for the
// actionable-error-panel path), 'dead-silent' is the same but additionally
// drops every translate:state event (for the error-panel race-coherence
// path), 'ok' completes instantly with canned translations (for the
// progress/result-panel path). Live-model E2E (LT_E2E_LIVE=1) is a
// separate, explicitly out-of-scope gate this suite never sets.

const MINI_FIXTURE = {
  segments: [
    {
      id: 's1',
      text: 'Hello there',
      box: { wPt: 300, hPt: 60 },
      font: { family: 'Noto Sans', sizePt: 18 },
      context: 'slide title',
      kind: 'fake'
    }
  ]
}

function writeMiniFixture(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'lt-e2e-'))
  const file = path.join(dir, 'mini.fake.json')
  writeFileSync(file, JSON.stringify(MINI_FIXTURE))
  return { dir, file }
}

async function launchApp(
  fakeBackend: 'dead' | 'ok' | 'dead-silent',
  userDataDir?: string
): Promise<{ app: ElectronApplication; window: Page }> {
  const args = ['out/main/index.js']
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`)
  const app = await electron.launch({
    args,
    env: { ...process.env, LT_E2E_FAKE_BACKEND: fakeBackend }
  })
  const window = await app.firstWindow()
  return { app, window }
}

test.describe('runner UI', () => {
  let tmpDir: string | null = null

  test.afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
  })

  test('renders all 20 languages in both the source and target dropdowns', async () => {
    const { app, window } = await launchApp('dead')
    try {
      const selects = window.locator('select')
      await expect(selects).toHaveCount(2)

      for (let i = 0; i < 2; i++) {
        const options = await selects.nth(i).locator('option').allTextContents()
        expect(options).toHaveLength(20)
        expect(options).toContain('English')
        expect(options).toContain('Chinese (Simplified)')
        expect(options).toContain('Chinese (Traditional)')
        expect(options).toContain('Russian')
      }
    } finally {
      await app.close()
    }
  })

  test('a dead Ollama backend surfaces an actionable error panel with the download URL', async () => {
    const { file, dir } = writeMiniFixture()
    tmpDir = dir
    const { app, window } = await launchApp('dead')
    try {
      await window.locator('[data-testid="file-input"]').setInputFiles(file)
      await window.getByRole('button', { name: 'Translate' }).click()

      const errorPanel = window.locator('[data-testid="error-panel"]')
      await expect(errorPanel).toBeVisible()
      await expect(errorPanel).toContainText('Ollama was not found')
      await expect(errorPanel).toContainText('https://ollama.com/download')

      // The run must have failed before any result appeared.
      await expect(window.locator('[data-testid="result-panel"]')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('shows the error panel from the invoke-rejection alone, even when translate:state never arrives (race coherence)', async () => {
    // Reviewer-flagged bug: the error panel used to render only when
    // state==='error', but a rejected translate:run invoke() and the
    // separately-dispatched translate:state 'error' event have no
    // ordering guarantee - a rejection landing first used to leave the
    // error silently hidden. 'dead-silent' drops every state event on the
    // floor (see e2e-fakes.ts), so this test can ONLY pass if the panel
    // renders purely off the rejected invoke() promise.
    const { file, dir } = writeMiniFixture()
    tmpDir = dir
    const { app, window } = await launchApp('dead-silent')
    try {
      await window.locator('[data-testid="file-input"]').setInputFiles(file)
      await window.getByRole('button', { name: 'Translate' }).click()

      const errorPanel = window.locator('[data-testid="error-panel"]')
      await expect(errorPanel).toBeVisible()
      await expect(errorPanel).toContainText('Ollama was not found')

      // Never having received a 'translating'/'starting-ollama' state event
      // means the progress panel must never have appeared either.
      await expect(window.locator('[data-testid="progress-panel"]')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('a mocked backend run shows the progress panel, then a result panel with the output path', async () => {
    const { file, dir } = writeMiniFixture()
    tmpDir = dir
    const { app, window } = await launchApp('ok')
    try {
      await window.locator('[data-testid="file-input"]').setInputFiles(file)
      await window.getByRole('button', { name: 'Translate' }).click()

      await expect(window.locator('[data-testid="progress-panel"]')).toBeVisible()

      const resultPanel = window.locator('[data-testid="result-panel"]')
      await expect(resultPanel).toBeVisible({ timeout: 10_000 })
      await expect(resultPanel).toContainText('mini_translated.fake.json')

      // Progress panel is replaced by the result panel once the run is done.
      await expect(window.locator('[data-testid="progress-panel"]')).toHaveCount(0)

      // The compact stats line always shows segments/min; the 'ok' fake
      // backend's translateBatch (e2e-fakes.ts) never sets BatchResponse.usage,
      // so tok/s must be absent - ResultPanel's describeStats() gates it on
      // promptTokens > 0 || completionTokens > 0, matching cli.ts's printStats.
      const statsLine = window.locator('[data-testid="result-stats"]')
      await expect(statsLine).toBeVisible()
      await expect(statsLine).toContainText('segments/min')
      await expect(statsLine).not.toContainText('tok/s')
    } finally {
      await app.close()
    }
  })

  test('rejects an unsupported file with an inline message and never enables a run', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lt-e2e-'))
    tmpDir = dir
    const badFile = path.join(dir, 'notes.txt')
    writeFileSync(badFile, 'plain text, not a supported document')

    const { app, window } = await launchApp('dead')
    try {
      await window.locator('[data-testid="file-input"]').setInputFiles(badFile)

      await expect(
        window.getByRole('alert').filter({ hasText: 'not a supported file' })
      ).toBeVisible()
      await expect(window.getByRole('button', { name: 'Translate' })).toBeDisabled()
    } finally {
      await app.close()
    }
  })

  test('persists the selected languages across an app relaunch', async () => {
    // Isolated --user-data-dir so this test's localStorage writes never
    // touch the real app's user data directory on this machine.
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'lt-e2e-userdata-'))
    try {
      const first = await launchApp('dead', userDataDir)
      try {
        await first.window.locator('select').nth(0).selectOption('German')
        await first.window.locator('select').nth(1).selectOption('Japanese')
      } finally {
        await first.app.close()
      }

      const second = await launchApp('dead', userDataDir)
      try {
        await expect(second.window.locator('select').nth(0)).toHaveValue('German')
        await expect(second.window.locator('select').nth(1)).toHaveValue('Japanese')
      } finally {
        await second.app.close()
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
