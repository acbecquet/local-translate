import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['out/', 'dist_installer/', 'node_modules/', 'playwright-report/', 'test-results/']
  },
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
