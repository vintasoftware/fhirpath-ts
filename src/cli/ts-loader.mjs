/**
 * Minimal Node loader for DTO checks. It compiles standard decorators to ES2022
 * before importing TypeScript modules. It does not read tsconfig paths or run
 * type checks; projects that need custom module resolution should compile first.
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
