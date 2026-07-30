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
  {
    // Node ESM utility scripts run directly via `node scripts/<file>.mjs`;
    // they need Node's globals declared since they sit outside the TS graph.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly'
      }
    }
  },
  {
    // Standalone CommonJS test fixtures spawned as their own `node <file>`
    // process (never imported/bundled), so they run outside the app's
    // ESM/TS module graph and need Node's CJS globals declared explicitly.
    files: ['tests/**/fixtures/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        setTimeout: 'readonly',
        console: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  prettier
)
