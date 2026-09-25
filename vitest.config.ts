import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'fhirpath',
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'dogfood/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['node_modules', 'dist', '**/index.ts', '**/types.ts', '**/*.types.ts', '**/src/types/**'],
      reporter: process.env.CI ? ['text', 'json-summary'] : ['text', 'json-summary', 'html'],
      // Locked at the achieved floor; the uncovered remainder is annotated
      // defensive guards and fallback halves (see README, Coverage).
      thresholds: {
        lines: 99,
        functions: 99.5,
        branches: 96,
        statements: 99,
      },
    },
  },
})
