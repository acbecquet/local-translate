import { expect, test, _electron as electron } from '@playwright/test'

test('app launches and shows the scaffold window', async () => {
  const app = await electron.launch({ args: ['out/main/index.js'] })
  const window = await app.firstWindow()
  await expect(window.locator('h1')).toHaveText('local_translate')
  expect(await window.title()).toBe('local_translate')
  await app.close()
})
