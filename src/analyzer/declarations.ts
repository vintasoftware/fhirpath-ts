import { normalizeEnvKeys } from '../engine/context.ts'
import type { FhirpathTypeDeclaration, FhirpathTypeDeclarations } from '../typed/infer.ts'
import { OBJECT_TYPE, toCollection } from '../values/typed-value.ts'

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

function analyzerVariableFromValue(value: unknown): AnalyzerVariable {
  const collection = toCollection(value)
  const types = [...new Set(collection.map(item => item.type))]
  return {
    ...(types.length > 0 && !types.includes(OBJECT_TYPE) && { types }),
    single: collection.length <= 1,
  }
}

/** Declare every runtime value name and add explicit type information. */
export function analyzerVariables(
  values: object | undefined,
  declarations: FhirpathTypeDeclarations | undefined
): Record<string, AnalyzerVariable> {
  return collectAnalyzerVariables(values, declarations, false)
}

/** Infer safe types from environment values, with explicit declarations taking precedence. */
export function analyzerEnvironmentVariables(
  values: object | undefined,
  declarations: FhirpathTypeDeclarations | undefined
): Record<string, AnalyzerVariable> {
  return collectAnalyzerVariables(values, declarations, true)
}

function collectAnalyzerVariables(
  values: object | undefined,
  declarations: FhirpathTypeDeclarations | undefined,
  inferValues: boolean
): Record<string, AnalyzerVariable> {
  const normalizedValues = normalizeEnvKeys(values as Readonly<Record<string, unknown>> | undefined)
  const normalizedDeclarations = normalizeEnvKeys(declarations)
  const variables: Record<string, AnalyzerVariable> = {}
  for (const name of new Set([...Object.keys(normalizedValues), ...Object.keys(normalizedDeclarations)])) {
    const declaration = normalizedDeclarations[name]
    variables[name] =
      declaration === undefined
        ? inferValues
          ? analyzerVariableFromValue(normalizedValues[name])
          : {}
        : analyzerVariable(declaration)
  }
  return variables
}
