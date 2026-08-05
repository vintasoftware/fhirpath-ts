import { mergeEnvKeys, normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { toSubjects } from './bundle.ts'
import type { AnyExpression, Compiler, CustomFunction, EvaluateOptions } from './compile.ts'
import type { ColumnOptions, ColumnResult, Projection, ProjectionColumn, ProjectionColumns } from './project.ts'

/**
 * Marks a `column()` value so a DTO class's fields can be told apart from its
 * ordinary properties. The brand is a symbol key, so projection code that
 * reads the spec as a plain ProjectionColumn never sees it.
 */
const COLUMN_BRAND = Symbol('fhirpath-ts.column')

/** The object forms of ProjectionColumn — everything `column()` accepts. */
type ColumnSpec = Exclude<ProjectionColumn, string>

/**
 * Ties `pick` to the table's row keys: with a table `map`, `pick` must name a
 * row field; without one, `pick` is rejected outright. Applied as a validation
 * intersection on the options parameter, so a `pick` typo is a compile error
 * at the call site.
 */
type PickConstraint<Options> = Options extends { map: readonly (infer Row extends { code: string })[] }
  ? { pick?: keyof Row & string }
  : { pick?: never }

/**
 * Declares one column of a DTO class (see EngineOptions.resourceDtos). Takes the same
 * options as a `project()` column — `type`, `as`, `map`/`pick`, `default`,
 * `collection` — or a `{ test }` criteria spec.
 *
 * The static type is the column's *value* (what a projected row holds there),
 * while the runtime value is the column spec itself; `project()` replaces it
 * when it materializes rows. That makes `InstanceType<Dto>` the row type, so
 * ordinary methods and getters on the class see real values:
 *
 * ```ts
 * class WeightRow {
 *   lbs = column("value.ofType(Quantity).toQuantity('[lb_av]').value", { type: 'decimal', default: 0 })
 *   at = column('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
 * }
 * const rows = fp.project(observations, WeightRow) // WeightRow[], lbs: number, at: Date | undefined
 * ```
 *
 * Never read a `column()` value before projection — until then the field
 * holds the spec, not a value.
 */
export function column<const Criteria extends string>(spec: { test: Criteria }): boolean
export function column<const Expr extends string>(path: Expr): Projection<{ c: Expr }>['c']
export function column<const Expr extends string, const Options extends ColumnOptions>(
  path: Expr,
  options: Options & PickConstraint<Options>
): ColumnResult<{ path: Expr } & Options>
export function column(pathOrSpec: string | { test: string }, options?: ColumnOptions): unknown {
  return brandedSpec(pathOrSpec, options)
}

function brandedSpec(pathOrSpec: string | { test: string }, options?: ColumnOptions): ColumnSpec {
  const spec: ColumnSpec = typeof pathOrSpec === 'string' ? { path: pathOrSpec, ...options } : pathOrSpec
  return Object.assign(spec, { [COLUMN_BRAND]: true })
}

/**
 * A reusable column declaration (see `declareColumn`): call it in field
 * position — `at = ObservedAt()` — to use the same column in several DTO
 * classes, and list it in `EngineOptions.columns` to register its expression
 * as an engine-wide function named `functionName`.
 */
export interface DeclaredColumn<T = unknown> {
  (): T
  /** The engine-wide function name the declaration registers under. */
  readonly functionName: string
  /** The underlying column spec — one shared object, never mutated. */
  readonly spec: Exclude<ProjectionColumn, string>
}

/**
 * Declares a column once for reuse across DTO classes. The declaration is a
 * zero-argument factory whose calls all return the same spec (typed as the
 * column's value, like `column()`), plus the `functionName` under which
 * `EngineOptions.columns` registers the expression engine-wide — so the chain
 * is also callable from any expression, e.g. `observedAt()`. A `{ test }`
 * declaration is projection-only and cannot be registered.
 */
export function declareColumn<const Criteria extends string>(
  functionName: string,
  spec: { test: Criteria }
): DeclaredColumn<boolean>
export function declareColumn<const Expr extends string>(
  functionName: string,
  path: Expr
): DeclaredColumn<Projection<{ c: Expr }>['c']>
export function declareColumn<const Expr extends string, const Options extends ColumnOptions>(
  functionName: string,
  path: Expr,
  options: Options & PickConstraint<Options>
): DeclaredColumn<ColumnResult<{ path: Expr } & Options>>
export function declareColumn(
  functionName: string,
  pathOrSpec: string | { test: string },
  options?: ColumnOptions
): DeclaredColumn {
  const spec = brandedSpec(pathOrSpec, options)
  return Object.assign(() => spec as unknown, { functionName, spec })
}

/**
 * The statics a DTO class may declare. A DTO groups everything one row shape
 * needs: `column()` fields, the per-row `vars` its columns read, and the `env`
 * data (lookup tables, system URLs) its expressions join against.
 */
export interface DtoStatics {
  /**
   * The resource or datatype the columns read, e.g. 'Observation' —
   * typo-checked against the model's type names. Required to register the
   * class via `EngineOptions.resourceDtos` (one registered class per
   * fhirType). `project()` checks each row's `resourceType` against it and
   * throws on a mismatch; a subject with no `resourceType` (a datatype value)
   * has nothing to check.
   */
  readonly fhirType?: keyof R4TypeOf & string
  /** Env data the class owns. Registered engine-wide via EngineOptions.resourceDtos, and always applied when projecting the class. */
  readonly env?: Record<string, unknown>
  /** Per-row bindings applied when projecting the class (EvaluateOptions.vars semantics; may reference per-call env). */
  readonly vars?: Record<string, AnyExpression | readonly TypedValue[]>
}

/** A DTO class: zero-argument constructable, optionally carrying DtoStatics. */
export type DtoClass = (new () => object) & DtoStatics

/** The rows a DTO projection produces: the instance type itself (see `column()`). */
export type DtoRow<C extends DtoClass> = InstanceType<C>

function isColumnValue(value: unknown): value is ColumnSpec {
  return typeof value === 'object' && value !== null && COLUMN_BRAND in value
}

const columnsCache = new WeakMap<DtoClass, ProjectionColumns>()

/**
 * The `column()` fields of a DTO class, as a `project()` columns record.
 * Instantiates the class once (field initializers hold the specs) and caches
 * per class — specs are static declarations, never per-row state.
 */
export function dtoColumns(cls: DtoClass): ProjectionColumns {
  const cached = columnsCache.get(cls)
  if (cached) {
    return cached
  }
  const instance = new cls() as Record<string, unknown>
  const columns: ProjectionColumns = {}
  for (const [name, value] of Object.entries(instance)) {
    if (isColumnValue(value)) {
      columns[name] = value
    }
  }
  columnsCache.set(cls, columns)
  return columns
}

/**
 * Fold registered DTO classes and declared columns into the engine defaults:
 * each `column()` field becomes an expression-defined function (its analyzer
 * signature derived from the column's `type` when no `as`/`map` reshapes the
 * value), and each class's static `env` merges in. Redefining an existing
 * function or env variable is an error — silent shadowing between classes
 * would be impossible to debug from an expression.
 */
export function withDtos(
  defaults: EvaluateOptions,
  dtos: readonly DtoClass[],
  declaredColumns: readonly DeclaredColumn[],
  compile: Compiler
): EvaluateOptions {
  if (dtos.length === 0 && declaredColumns.length === 0) {
    return defaults
  }
  const functions: Record<string, CustomFunction> = { ...defaults.functions }
  const env: Record<string, unknown> = normalizeEnvKeys(defaults.env)
  for (const declared of declaredColumns) {
    if ('test' in declared.spec) {
      throw new FhirPathTypeError(
        `Declared column '${declared.functionName}' is a test column, which cannot register as a function`
      )
    }
    if (declared.functionName in functions) {
      throw new FhirPathTypeError(
        `Declared column '${declared.functionName}' redefines the function '${declared.functionName}'`
      )
    }
    functions[declared.functionName] = columnFunction(declared.spec, compile)
  }
  const classPerType = new Map<string, string>()
  for (const dto of dtos) {
    // One registered class per fhirType: the class is the engine-wide
    // vocabulary for that resource, so a second one is a conflict, not an
    // addition — and requiring the type keeps that rule enforceable.
    if (dto.fhirType === undefined) {
      throw new FhirPathTypeError(`DTO ${dto.name} must declare a fhirType to register`)
    }
    const registered = classPerType.get(dto.fhirType)
    if (registered !== undefined) {
      throw new FhirPathTypeError(
        `DTO ${dto.name} registers fhirType '${dto.fhirType}', already registered by ${registered}`
      )
    }
    classPerType.set(dto.fhirType, dto.name)
    for (const [name, spec] of Object.entries(dtoColumns(dto))) {
      if (typeof spec === 'string' || 'test' in spec) {
        continue
      }
      if (name in functions) {
        throw new FhirPathTypeError(`DTO ${dto.name} redefines the function '${name}'`)
      }
      functions[name] = columnFunction(spec, compile)
    }
    for (const [name, value] of Object.entries(normalizeEnvKeys(dto.env))) {
      if (name in env) {
        throw new FhirPathTypeError(`DTO ${dto.name} redefines the environment variable %${name}`)
      }
      env[name] = value
    }
  }
  return { ...defaults, functions, env }
}

/**
 * A column's path as an expression-defined function; the analyzer signature
 * derives from `type` — or, for an `enum` column, plain String — as long as no
 * `as`/`map` reshapes the value outside FHIRPath.
 */
function columnFunction(spec: Extract<ProjectionColumn, { path: string }>, compile: Compiler): CustomFunction {
  const resultType =
    spec.as !== undefined || spec.map !== undefined
      ? undefined
      : (spec.type ?? (spec.enum !== undefined ? 'System.String' : undefined))
  return {
    expression: compile(spec.path),
    ...(resultType !== undefined && {
      signature: { result: { types: [resultType], single: spec.collection !== true } },
    }),
  }
}

/**
 * A projected DTO's `fhirType` checked against each row's actual resource:
 * a mismatch would not throw downstream — root-prefixed columns type-filter
 * to empty and the row comes back as well-typed defaults — so this is the
 * one place the mistake is visible. Fails loudly like the engine's other
 * runtime checks (the scalar-column rule, Bundle ambiguity, env overrides);
 * filter the input first to project a subset. A subject with no
 * `resourceType` (a datatype, e.g. a CodeableConcept) has nothing to check.
 */
export function assertInputMatchesDto(input: unknown, dto: DtoClass): void {
  const fhirType = dto.fhirType
  if (fhirType === undefined) {
    return
  }
  toSubjects(input).forEach((subject, index) => {
    const resourceType = (subject.value as { resourceType?: unknown } | null | undefined)?.resourceType
    if (typeof resourceType === 'string' && resourceType !== fhirType) {
      throw new FhirPathTypeError(
        `project(): row ${index} is a ${resourceType}, but ${dto.name} declares fhirType '${fhirType}'`
      )
    }
  })
}

/**
 * A projected DTO class's own env and vars, merged under the per-call options
 * (per name, call wins) — so precedence runs engine defaults, then class, then
 * call. A class registered via EngineOptions.resourceDtos re-applies its env
 * here with identical values, which is harmless.
 */
export function dtoCallOptions(dto: DtoClass, options: EvaluateOptions | undefined): EvaluateOptions | undefined {
  if (dto.env === undefined && dto.vars === undefined) {
    return options
  }
  const merged: EvaluateOptions = { ...options }
  if (dto.env !== undefined) {
    merged.env = mergeEnvKeys(dto.env, options?.env)
  }
  if (dto.vars !== undefined) {
    merged.vars = mergeEnvKeys(dto.vars, options?.vars)
  }
  return merged
}
