import { normalizeEnvKeys } from '../engine/context.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { FhirpathTypeDeclaration, FhirpathTypeDeclarations } from '../typed/infer.ts'
import { OBJECT_TYPE, toCollection, type TypedValue, typeLocalName } from '../values/typed-value.ts'

/** A host variable in the analyzer's canonical collection form. */
export interface AnalyzerVariable {
  types?: string[]
  single?: boolean
  targets?: string[]
}

const runtimeTypes = new WeakMap<AnalyzerVariable, string[]>()

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

/** Convert one runtime collection while retaining the exact types used for host-function dispatch. */
export function runtimeAnalyzerVariable(
  collection: readonly TypedValue[],
  model: ModelProvider | undefined,
  declaration?: FhirpathTypeDeclaration
): AnalyzerVariable {
  const inferred = collection.map(item => inferAnalyzerType(item.type, model))
  const types = inferred.every(type => type !== undefined) ? [...new Set(inferred)] : undefined
  const variable =
    declaration === undefined
      ? {
          ...(types !== undefined && types.length > 0 && { types }),
          single: collection.length <= 1,
        }
      : analyzerVariable(declaration)
  runtimeTypes.set(
    variable,
    collection.map(item => item.type)
  )
  return variable
}

/** Exact runtime types attached by runtimeAnalyzerVariable, including an exactly empty collection. */
export function analyzerVariableRuntimeTypes(variable: AnalyzerVariable): string[] | undefined {
  return runtimeTypes.get(variable)
}

function analyzerVariableFromValue(
  value: unknown,
  model: ModelProvider | undefined,
  declaration: FhirpathTypeDeclaration | undefined
): AnalyzerVariable {
  return runtimeAnalyzerVariable(toCollection(value), model, declaration)
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
  return collectAnalyzerVariables(values, declarations, (_value, declaration) =>
    declaration === undefined ? {} : analyzerVariable(declaration)
  )
}

/** Infer safe types from environment values, with explicit declarations taking precedence. */
export function analyzerEnvironmentVariables(
  values: object | undefined,
  declarations: FhirpathTypeDeclarations | undefined,
  model: ModelProvider | undefined
): Record<string, AnalyzerVariable> {
  return collectAnalyzerVariables(values, declarations, (value, declaration) =>
    analyzerVariableFromValue(value, model, declaration)
  )
}

function collectAnalyzerVariables(
  values: object | undefined,
  declarations: FhirpathTypeDeclarations | undefined,
  inferValue: (value: unknown, declaration: FhirpathTypeDeclaration | undefined) => AnalyzerVariable
): Record<string, AnalyzerVariable> {
  const normalizedValues = normalizeEnvKeys(values as Readonly<Record<string, unknown>> | undefined)
  const normalizedDeclarations = normalizeEnvKeys(declarations)
  const variables: Record<string, AnalyzerVariable> = {}
  for (const name of new Set([...Object.keys(normalizedValues), ...Object.keys(normalizedDeclarations)])) {
    const declaration = normalizedDeclarations[name]
    if (Object.hasOwn(normalizedValues, name)) {
      variables[name] = inferValue(normalizedValues[name], declaration)
    } else if (declaration !== undefined) {
      variables[name] = analyzerVariable(declaration)
    }
  }
  return variables
}
