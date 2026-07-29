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
