import ts from 'typescript'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * Uses TypeScript to lower standard decorators before Vite runs oxc. Only files
 * containing decorators use this transform. Consumer builds need TypeScript,
 * SWC, or Babel for the same syntax.
 */
function lowerDecorators(): Plugin {
  const decorated = /^\s*@[A-Za-z_$]/m
  return {
    name: 'fhirpath-ts:lower-decorators',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0] ?? id
      if (!file.endsWith('.ts') || file.includes('/node_modules/') || !decorated.test(code)) {
        return null
      }
      const { outputText, sourceMapText } = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          // ES2022, not ESNext: tsc leaves decorators in place for an esnext
          // target ("the runtime has them"), which is exactly what oxc cannot read.
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          useDefineForClassFields: true,
          experimentalDecorators: false,
          sourceMap: true,
        },
      })
      return { code: outputText, map: sourceMapText === undefined ? null : JSON.parse(sourceMapText) }
    },
  }
}

export default defineConfig({
  plugins: [lowerDecorators()],
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
