import { normalizeEnvKeys } from '../engine/context.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { FhirpathTypeDeclaration, FhirpathTypeDeclarations } from '../typed/infer.ts'
import { OBJECT_TYPE, toCollection, typeLocalName } from '../values/typed-value.ts'

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

function analyzerVariableFromValue(value: unknown, model: ModelProvider | undefined): AnalyzerVariable {
  const collection = toCollection(value)
  const inferred = collection.map(item => inferAnalyzerType(item.type, model))
  const types = inferred.every(type => type !== undefined) ? [...new Set(inferred)] : undefined
  return {
    ...(types !== undefined && types.length > 0 && { types }),
    single: collection.length <= 1,
  }
}

function inferAnalyzerType(type: string, model: ModelProvider | undefined): string | undefined {
  if (type === OBJECT_TYPE) {
    return undefined
  }
  return type.startsWith('System.') ? type : model?.resolveType(typeLocalName(type))
}

/** Declare every runtime value name and add explicit type information. */
export function analyzerVariables(
  values: object | undefined,
  declarations: FhirpathTypeDeclarations | undefined
): Record<string, AnalyzerVariable> {
  return collectAnalyzerVariables(values, declarations, () => ({}))
}

/** Infer safe types from environment values, with explicit declarations taking precedence. */
export function analyzerEnvironmentVariables(
  values: object | undefined,
  declarations: FhirpathTypeDeclarations | undefined,
  model: ModelProvider | undefined
): Record<string, AnalyzerVariable> {
  return collectAnalyzerVariables(values, declarations, value => analyzerVariableFromValue(value, model))
}

function collectAnalyzerVariables(
  values: object | undefined,
  declarations: FhirpathTypeDeclarations | undefined,
  inferValue: (value: unknown) => AnalyzerVariable
): Record<string, AnalyzerVariable> {
  const normalizedValues = normalizeEnvKeys(values as Readonly<Record<string, unknown>> | undefined)
  const normalizedDeclarations = normalizeEnvKeys(declarations)
  const variables: Record<string, AnalyzerVariable> = {}
  for (const name of new Set([...Object.keys(normalizedValues), ...Object.keys(normalizedDeclarations)])) {
    const declaration = normalizedDeclarations[name]
    variables[name] = declaration === undefined ? inferValue(normalizedValues[name]) : analyzerVariable(declaration)
  }
  return variables
}
