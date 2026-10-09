import { normalizeEnvKeys } from '../engine/context.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { FhirpathTypeDeclaration, FhirpathTypeDeclarations } from '../typed/infer.ts'
import { OBJECT_TYPE, toCollection, type TypedValue, typeLocalName } from '../values/typed-value.ts'

/** A host variable in the analyzer's canonical collection form. */
export interface AnalyzerVariable {
  types?: string[]
  single?: boolean
  /** True: ordered. False: unordered. Omit when ordering is unknown. */
  ordered?: boolean
  targets?: string[]
}

/** Projection variables supplied by the runtime for every row. */
export const PROJECT_ROW_VARIABLES: Readonly<Record<'rowIndex' | 'rowTotal', AnalyzerVariable>> = {
  rowIndex: { types: ['System.Integer'], single: true },
  rowTotal: { types: ['System.Integer'], single: true },
}

/** Internal variable state with the exact focus types used by runtime host-function dispatch. */
export interface RuntimeAnalyzerVariable extends AnalyzerVariable {
  /** A runtime collection is a real array, so its order is always defined. */
  ordered: true
  exactTypes: string[]
}

export type AnalyzerVariableState = AnalyzerVariable | RuntimeAnalyzerVariable

export function isRuntimeAnalyzerVariable(variable: AnalyzerVariableState): variable is RuntimeAnalyzerVariable {
  return 'exactTypes' in variable
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

/** Convert one runtime collection while retaining the exact types used for host-function dispatch. */
export function runtimeAnalyzerVariable(
  collection: readonly TypedValue[],
  model: ModelProvider | undefined,
  declaration?: FhirpathTypeDeclaration
): RuntimeAnalyzerVariable {
  const inferred = analyzerVariableFromCollection(collection, model)
  return {
    ...(declaration === undefined ? inferred : analyzerVariable(declaration)),
    ordered: true,
    exactTypes: collection.map(item => item.type),
  }
}

function analyzerVariableFromCollection(
  collection: readonly TypedValue[],
  model: ModelProvider | undefined
): AnalyzerVariable {
  const inferred = collection.map(item => inferAnalyzerType(item.type, model))
  const types = inferred.every(type => type !== undefined) ? [...new Set(inferred)] : undefined
  return {
    ...(types !== undefined && types.length > 0 && { types }),
    single: collection.length <= 1,
    ordered: true,
  }
}

function analyzerVariableFromValue(value: unknown, model: ModelProvider | undefined): AnalyzerVariable {
  return analyzerVariableFromCollection(toCollection(value), model)
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
    declaration === undefined ? analyzerVariableFromValue(value, model) : analyzerVariable(declaration)
  )
}

/** Runtime environment state, retaining actual dispatch types independently of declarations. */
export function runtimeAnalyzerEnvironmentVariables(
  values: object | undefined,
  declarations: FhirpathTypeDeclarations | undefined,
  model: ModelProvider | undefined
): Record<string, AnalyzerVariableState> {
  return collectAnalyzerVariables(values, declarations, (value, declaration) =>
    runtimeAnalyzerVariable(toCollection(value), model, declaration)
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
