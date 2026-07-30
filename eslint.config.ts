import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import globals from 'globals'
import tseslint from 'typescript-eslint'

import fhirpath from './src/eslint/index.ts'

/**
 * Flat ESLint config. This repo dogfoods its own `fhirpath/no-invalid-expressions`
 * rule — the spec §11 analyzer runs as a real lint rule over the library source,
 * so `pnpm lint` (locally, on pre-commit, and in CI) statically checks every
 * literal FHIRPath expression alongside the ordinary JS/TS rules. Formatting is
 * owned by Prettier; `eslint-config-prettier` (last) disables any stylistic rule
 * that would fight it.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'src/r4/generated/**',
      'demo/src/monaco/**',
      'test-data/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Node is the default runtime (library, CLIs, scripts, benchmarks); the demo
  // is a browser app.
  { languageOptions: { globals: globals.node } },
  { files: ['demo/src/**/*.ts'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  {
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      // Sort imports and exports.
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'warn',
      // Project correctness and style rules.
      'no-debugger': 'error',
      'no-console': 'warn',
      curly: ['error', 'all'],
      'prefer-template': 'warn',
      'no-param-reassign': 'warn',
      'prefer-exponentiation-operator': 'warn',
      'one-var': ['warn', 'never'],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // TS-native repo (imports resolve `.ts`): inline type imports are not enforced.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  // Dogfood: run the analyzer over the library's own source. `localImports` treats
  // the repo's relative imports of its API as the real FHIRPath API (not foreign),
  // so those call sites are actually checked. Test files are excluded because they
  // deliberately hold malformed expressions as fixtures.
  {
    files: ['src/**/*.ts', 'demo/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    plugins: { fhirpath },
    rules: { 'fhirpath/no-invalid-expressions': ['error', { localImports: true }] },
  },
  // CLIs, codegen scripts and benchmarks report through the console.
  {
    files: ['src/cli/**/*.ts', 'scripts/**', 'demo/scripts/**', 'benchmarks/**'],
    rules: { 'no-console': 'off' },
  },
  prettier
)
