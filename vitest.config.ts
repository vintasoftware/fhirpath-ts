import { mergeConfig } from 'vite'
import { defineProject } from 'vitest/config'
import { sharedViteConfig } from '../../vite.config.ts'

export default mergeConfig(
  sharedViteConfig,
  defineProject({
    test: {
      name: 'fhirpath',
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      setupFiles: ['../../vitest.setup.ts'],
      coverage: {
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
)
