import { columnResultType } from '../api/column-signature.ts'
import { type ColumnSpec, type DtoClass, dtoDefinition } from '../api/dto.ts'
import { bareEnvironmentName } from '../engine/context.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { FhirpathTypeDeclarations } from '../typed/infer.ts'
import { valueKindOfTypeName } from '../values/type-compat.ts'
import {
  analyzeExpressionDetailed,
  type AnalyzeOptions,
  type AnalyzerDiagnostic,
  type DeclaredFunction,
  type DeclaredVariable,
} from './analyze.ts'
import { analyzerEnvironmentVariables, analyzerVariables, PROJECT_ROW_VARIABLES } from './declarations.ts'

/** One `analyzeDto` finding: an analyzer diagnostic plus the class member it came from. */
export interface DtoDiagnostic extends AnalyzerDiagnostic {
  /** The column field name, or `vars.<name>` for a DTO var. */
  member: string
  /** The expression that produced the finding, so a reporter can locate it in source. */
  expression: string
}

/** Engine context read by the analyzer without importing the engine implementation. */
export interface AnalyzedContext {
  readonly defaults: {
    model?: ModelProvider
    functions?: Record<string, DeclaredFunction>
    env?: object
    envTypes?: FhirpathTypeDeclarations
    vars?: object
    varTypes?: FhirpathTypeDeclarations
  }
}

/** A context that also knows which DTOs it registered, which is what a sweep needs. */
export interface AnalyzedEngine extends AnalyzedContext {
  readonly dtos: readonly DtoClass[]
}

/** `analyzeDto` options, with the engine the DTO belongs to as a shortcut for its context. */
export interface AnalyzeDtoOptions extends AnalyzeOptions {
  /** Engine model, functions, and environment names used while checking the DTO. */
  engine?: AnalyzedContext
}

/**
 * The analyzer context for a DTO: what its engine supplies, with the caller's
 * own options layered on top *per name* — one function or variable a host
 * declares must not displace the engine's whole table, or a valid column call
 * would be reported as unresolved. `model` and `inputType` are single values, so
 * there the caller simply wins.
 */
function contextOf(options: AnalyzeDtoOptions | undefined): AnalyzeOptions {
  const { engine, ...caller } = options ?? {}
  if (engine === undefined) {
    return caller
  }
  const { model, functions, env, envTypes, vars, varTypes } = engine.defaults
  const activeModel = caller.model ?? model
  return {
    ...(model !== undefined && { model }),
    ...caller,
    functions: { ...functions, ...caller.functions },
    variables: {
      ...analyzerEnvironmentVariables(env, envTypes, activeModel),
      ...analyzerVariables(vars, varTypes),
      ...caller.variables,
    },
  }
}

/**
 * Every DTO an engine registered, checked against that engine's own context —
 * the sweep a project's checker runs, with no list to maintain: the engine
 * already knows its `resourceDtos`. Each finding names the class it came from.
 * DTOs the engine does not register (row shapes you only ever project) are not
 * reachable from here; pass those to `analyzeDto` yourself, or list them.
 */
export function analyzeEngineDtos(
  engine: AnalyzedEngine,
  options?: AnalyzeOptions
): (DtoDiagnostic & { dto: string })[] {
  return engine.dtos.flatMap(dto =>
    analyzeDto(dto, { ...options, engine }).map(finding => ({ ...finding, dto: dto.name }))
  )
}

/**
 * Checks a DTO's columns, criteria, and variables. The DTO type is the input
 * context. DTO environment names, caller environment names, and row variables
 * are declared automatically. Variables are checked in order. Declared column
 * types and enums are compared with the analyzer result.
 */
export function analyzeDto(dto: DtoClass, options?: AnalyzeDtoOptions): DtoDiagnostic[] {
  const definition = dtoDefinition(dto)
  const context = contextOf(options)
  const inputType = context.inputType ?? definition.fhirType
  const declared: Record<string, DeclaredVariable> = { ...PROJECT_ROW_VARIABLES }
  for (const name of [...Object.keys(definition.env ?? {}), ...definition.callerEnvNames]) {
    declared[bareEnvironmentName(name)] = {}
  }
  Object.assign(declared, analyzerVariables(undefined, definition.callerEnvTypes))
  const diagnostics: DtoDiagnostic[] = []
  const analyze = (
    member: string,
    expression: string,
    column?: ColumnSpec
  ): { types: string[] | undefined; single: boolean | undefined; ordered: boolean | undefined } => {
    const perExpression: AnalyzeOptions = {
      ...context,
      ...(inputType !== undefined && { inputType }),
      variables: { ...declared, ...context.variables },
    }
    const { diagnostics: found, result } = analyzeExpressionDetailed(expression, perExpression)
    for (const diagnostic of found) {
      diagnostics.push({ member, expression, ...diagnostic })
    }
    const mismatch = column === undefined ? undefined : declaredTypeMismatch(column, result.types, context)
    if (mismatch !== undefined) {
      // The conflicting field declaration is outside the expression, so mark the whole expression.
      diagnostics.push({
        member,
        expression,
        severity: 'error',
        code: 'column-type',
        message: mismatch,
        span: { start: 0, end: expression.length, line: 1, column: 1 },
      })
    }
    return result
  }
  for (const [name, value] of Object.entries(definition.vars ?? {})) {
    const source = typeof value === 'string' ? value : sourceOf(value)
    if (source !== undefined) {
      // A var has no declared result to cross-check, but its inferred result is
      // the input state for later vars and columns.
      const result = analyze(`vars.${bareEnvironmentName(name)}`, source)
      declared[bareEnvironmentName(name)] = {
        ...(result.types !== undefined && { types: result.types }),
        ...(result.single !== undefined && { single: result.single }),
        ...(result.ordered !== undefined && { ordered: result.ordered }),
      }
      continue
    }
    declared[bareEnvironmentName(name)] = {}
  }
  for (const [name, spec] of Object.entries(definition.columns)) {
    analyze(name, expressionOf(spec), spec)
  }
  return diagnostics
}

/** The expression a column reads: a criteria's `test`, else its path. */
function expressionOf(column: ColumnSpec): string {
  return 'test' in column ? column.test : column.path
}

/**
 * The type a column claims its expression yields — `columnSignature`'s rule, the
 * one the engine registers and the walkers declare, so a cross-check can never
 * contradict a claim that was never made.
 *
 * A criteria claims nothing here, even though its function declares a Boolean
 * result. The Boolean comes from the criteria rule applied to the result, not
 * from the expression itself. `@criteria('name.given')` validly returns
 * HumanName.given, which then reads as true.
 */
function claimedType(column: ColumnSpec): string | undefined {
  return 'test' in column ? undefined : columnResultType(column)
}

/**
 * Compares a declared column type with analyzer results. Primitive types compare
 * by value kind; complex types use the model hierarchy. Unknown results pass.
 */
function declaredTypeMismatch(
  column: ColumnSpec,
  yielded: string[] | undefined,
  options: AnalyzeOptions | undefined
): string | undefined {
  const claimed = claimedType(column)
  if (claimed === undefined || yielded === undefined || yielded.length === 0) {
    return undefined
  }
  const canonical = options?.model?.resolveType(claimed) ?? claimed
  const claimedKind = valueKindOfTypeName(canonical)
  const fits = yielded.some(type => {
    if (valueKindOfTypeName(type) !== claimedKind) {
      return false
    }
    if (claimedKind !== 'Complex') {
      return true
    }
    const model = options?.model
    /* v8 ignore next -- without a model the analyzer never reaches a complex FHIR type, so the model-less half cannot be exercised */
    return model === undefined || model.isSubtypeOf(type, canonical) || model.isSubtypeOf(canonical, type)
  })
  return fits ? undefined : `Column declares type '${claimed}', but the expression yields ${yielded.join(' | ')}`
}

/** A pre-compiled var's source text; a pre-bound TypedValue[] has nothing to analyze. */
function sourceOf(value: object): string | undefined {
  if (Array.isArray(value)) {
    return undefined
  }
  const source = (value as { source?: unknown }).source
  return typeof source === 'string' ? source : undefined
}
