import { normalizeEnvKeys } from '../engine/context.ts'
import type { FhirpathTypeDeclaration, FhirpathTypeDeclarations } from '../typed/infer.ts'

/** A host variable in the analyzer's canonical collection form. */
export interface AnalyzerVariable {
  types?: string[]
  single?: boolean
  targets?: string[]
}

/** Convert one public type declaration into analyzer state. */
export function analyzerVariable(declaration: FhirpathTypeDeclaration): AnalyzerVariable {
  return {
    types: typeof declaration.type === 'string' ? [declaration.type] : [...declaration.type],
    single: declaration.collection === true ? false : true,
    ...(declaration.targets !== undefined && {
      targets: typeof declaration.targets === 'string' ? [declaration.targets] : [...declaration.targets],
    }),
  }
}

/** Convert a declaration table, normalizing the optional leading `%` on every key. */
export function analyzerVariablesFromDeclarations(
  declarations: FhirpathTypeDeclarations | undefined
): Record<string, AnalyzerVariable> {
  return Object.fromEntries(
    Object.entries(normalizeEnvKeys(declarations)).map(([name, declaration]) => [name, analyzerVariable(declaration)])
  )
}

/** Declare every runtime value name and add static type information where supplied. */
export function analyzerVariables(
  values: object | undefined,
  declarations: FhirpathTypeDeclarations | undefined
): Record<string, AnalyzerVariable> {
  const normalizedValues = normalizeEnvKeys(values as Readonly<Record<string, unknown>> | undefined)
  const normalizedDeclarations = normalizeEnvKeys(declarations)
  const variables: Record<string, AnalyzerVariable> = {}
  for (const name of new Set([...Object.keys(normalizedValues), ...Object.keys(normalizedDeclarations)])) {
    const declaration = normalizedDeclarations[name]
    variables[name] = declaration === undefined ? {} : analyzerVariable(declaration)
  }
  return variables
}
