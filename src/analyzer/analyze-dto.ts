import { columnResultType } from '../api/column-signature.ts'
import { type ColumnSpec, type DtoClass, dtoDefinition } from '../api/dto.ts'
import type { ModelProvider } from '../model/provider.ts'
import {
  analyzeExpressionDetailed,
  type AnalyzeOptions,
  type AnalyzerDiagnostic,
  type DeclaredFunction,
  type DeclaredVariable,
} from './analyze.ts'
import { valueKindOfTypeName } from './signatures.ts'

/** One `analyzeDto` finding: an analyzer diagnostic plus the class member it came from. */
export interface DtoDiagnostic extends AnalyzerDiagnostic {
  /** The column field name, or `vars.<name>` for a DTO var. */
  member: string
  /** The expression that produced the finding, so a reporter can locate it in source. */
  expression: string
}

/**
 * The engine shape `analyzeDto` reads a DTO's context from — structural, so the
 * analyzer never imports the engine (and `fhirpath-ts/analyzer` stays independent
 * of the runtime). Only the per-call defaults, because that is all context is: a
 * checker can hand over a composite of several engines without inventing a
 * registration list for it (see the `fhirpath-check` CLI).
 */
export interface AnalyzedContext {
  readonly defaults: { model?: ModelProvider; functions?: Record<string, DeclaredFunction>; env?: object }
}

/** A context that also knows which DTOs it registered, which is what a sweep needs. */
export interface AnalyzedEngine extends AnalyzedContext {
  readonly dtos: readonly DtoClass[]
}

/** `analyzeDto` options, with the engine the DTO belongs to as a shortcut for its context. */
export interface AnalyzeDtoOptions extends AnalyzeOptions {
  /**
   * The engine the DTO is projected by: its `model`, its registered functions
   * (so calls into other DTOs' columns resolve) and the names in its `env` all
   * come from here. The caller's own options layer on top of that context per
   * name, never instead of it (see `contextOf`). Per-call env the DTO reads
   * (`%reports` handed to `project()`) is not the engine's, so declare those in
   * `variables`.
   */
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
  const { model, functions, env } = engine.defaults
  return {
    ...(model !== undefined && { model }),
    ...caller,
    functions: { ...functions, ...caller.functions },
    variables: { ...envVariables(env), ...caller.variables },
  }
}

/** An engine's env names, declared as variables the expressions may read. */
function envVariables(env: object | undefined): Record<string, DeclaredVariable> {
  const variables: Record<string, DeclaredVariable> = {}
  for (const name of Object.keys(env ?? {})) {
    variables[bare(name)] = {}
  }
  return variables
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
 * Statically checks every expression a DTO declares — `@column` paths,
 * `@criteria` expressions, and its `vars` — the check TypeScript cannot do,
 * since it never looks inside the expression strings. Meant for CI: assert
 * `analyzeDto(Dto, options)` is empty next to the class.
 *
 * A column that declares its `type` (or `enum`) is cross-checked against what
 * the analyzer infers the expression yields, which covers the whole language —
 * so an out-of-subset expression, where the field's declared type is all
 * TypeScript has to go on, is still checked here.
 *
 * The DTO's `fhirType` becomes the analyzer's input type (overridable via
 * `options.inputType`). Its `env` names, the `callerEnv` names the projecting
 * call supplies, and `%rowIndex`/`%rowTotal` come pre-declared; its `vars`
 * analyze in declaration order, each seeing the
 * earlier ones, and every column sees them all. Anything the DTO does not
 * itself declare travels through `options`: the engine's functions
 * (`functions: engine.defaults.functions`), engine env and per-call env names
 * (`variables`). A pre-bound `TypedValue[]` var has no expression to analyze
 * and is only declared.
 */
export function analyzeDto(dto: DtoClass, options?: AnalyzeDtoOptions): DtoDiagnostic[] {
  const definition = dtoDefinition(dto)
  const context = contextOf(options)
  const inputType = context.inputType ?? definition.fhirType
  const declared: Record<string, DeclaredVariable> = {
    rowIndex: { types: ['System.Integer'], single: true },
    rowTotal: { types: ['System.Integer'], single: true },
  }
  for (const name of [...Object.keys(definition.env ?? {}), ...(definition.callerEnv ?? [])]) {
    declared[bare(name)] = {}
  }
  const diagnostics: DtoDiagnostic[] = []
  const analyze = (member: string, expression: string, column?: ColumnSpec): void => {
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
      // The whole expression is the finding's span: the declaration it
      // contradicts lives outside the expression text.
      diagnostics.push({
        member,
        expression,
        severity: 'error',
        code: 'column-type',
        message: mismatch,
        span: { start: 0, end: expression.length, line: 1, column: 1 },
      })
    }
  }
  for (const [name, value] of Object.entries(definition.vars ?? {})) {
    const source = typeof value === 'string' ? value : sourceOf(value)
    if (source !== undefined) {
      // A var declares no type, so there is nothing to cross-check against.
      analyze(`vars.${bare(name)}`, source)
    }
    declared[bare(name)] = {}
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
 * A criteria claims nothing here, and that stays right even though its
 * *function* declares a Boolean result: the Boolean is a property of the
 * criteria coercion applied to the result, not of the expression.
 * `@criteria('name.given')` legally yields HumanName.given and reads as true.
 */
function claimedType(column: ColumnSpec): string | undefined {
  return 'test' in column ? undefined : columnResultType(column)
}

/**
 * A declared column `type` that cannot describe what the expression yields.
 * Compared by value kind (Boolean/String/Numeric/Temporal/Quantity/Complex),
 * the same families the analyzer's own operand checks use, so an equivalent
 * spelling — `code` for a String, `System.Decimal` for a `decimal` — is never a
 * finding. Complex types compare by name through the model's hierarchy instead,
 * since every complex type shares one kind. An unknown region (`types:
 * undefined`) claims nothing and is left alone.
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

const bare = (name: string): string => (name.startsWith('%') ? name.slice(1) : name)

/** A pre-compiled var's source text; a pre-bound TypedValue[] has nothing to analyze. */
function sourceOf(value: object): string | undefined {
  if (Array.isArray(value)) {
    return undefined
  }
  const source = (value as { source?: unknown }).source
  return typeof source === 'string' ? source : undefined
}
