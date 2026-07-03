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
        // Raised to 100 in the final phase of the implementation plan.
        thresholds: {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
      },
    },
  })
)
