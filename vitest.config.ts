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
    },
  })
)
