import ts from 'typescript'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * Lowers TC39 standard decorators with tsc before Vite's own transform sees
 * them: `@column`/`@criteria` DTO fields (api/dto.ts) are decorator syntax,
 * which oxc does not support yet — it leaves the `@` in place and Node throws a
 * SyntaxError. Only files that actually carry a decorator pay for this; the rest
 * take Vite's normal path.
 *
 * Consumers need the same thing from their own build (tsc, swc, or Babel — not
 * esbuild, oxc, or `node --experimental-strip-types`), which is the cost of
 * declaring a column's type on the field it belongs to.
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
  // `dogfood` imports the library by package name, which resolves through this
  // package.json's own `exports` — and those name `dist`. Without this condition
  // the tests would load a *second* copy of the library from the built output,
  // one whose engine registry the code under test cannot see. See the same
  // condition in tsconfig.json and in the `check:fhirpath` script.
  resolve: { conditions: ['fhirpath-ts-source'] },
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
