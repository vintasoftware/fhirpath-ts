/**
 * A Node module loader that compiles TypeScript on the fly, so `fhirpath-check`
 * can *import* a project's DTO modules and check them against the engine they
 * are projected by (see fhirpath-check.ts).
 *
 * It exists because the DTO files are exactly the ones Node cannot load itself:
 * `@column`/`@criteria` are decorators, which type stripping cannot erase.
 * TypeScript is already this package's own dependency, and the emit target is
 * pinned to ES2022 — at `esnext` tsc leaves decorators in place and the import
 * fails with a SyntaxError.
 *
 * Deliberately minimal: no tsconfig lookup, no path mapping, no type checking
 * (`pnpm typecheck` owns that). A project whose imports need more than
 * Node's own resolution should compile first and point the CLI at the output.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  useDefineForClassFields: true,
  experimentalDecorators: false,
  inlineSourceMap: true,
  inlineSources: true,
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    // A relative import written without an extension: try the TypeScript file
    // the project meant, then its directory index.
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return await nextResolve(candidate, context)
        } catch {
          continue
        }
      }
    }
    throw error
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !/\.[cm]?ts$/.test(url)) {
    return nextLoad(url, context)
  }
  const fileName = fileURLToPath(url)
  const { outputText } = ts.transpileModule(await readFile(fileName, 'utf8'), {
    fileName,
    compilerOptions: COMPILER_OPTIONS,
  })
  return { format: 'module', shortCircuit: true, source: outputText }
}
