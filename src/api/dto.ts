import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { TypedValue } from '../values/typed-value.ts'
import type { AnyExpression } from './compile.ts'
import type { Projection, ProjectionColumn, ProjectionColumns } from './project.ts'

/**
 * Marks a `column()` value so a DTO class's fields can be told apart from its
 * ordinary properties. The brand is a symbol key, so projection code that
 * reads the spec as a plain ProjectionColumn never sees it.
 */
const COLUMN_BRAND = Symbol('fhirpath-ts.column')

/** The object forms of ProjectionColumn — everything `column()` accepts. */
type ColumnSpec = Exclude<ProjectionColumn, string>

type PathOptions = Omit<Extract<ColumnSpec, { path: string }>, 'path'>

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
export function column<const Expr extends string, const Options extends PathOptions>(
  path: Expr,
  options: Options & PickConstraint<Options>
): Projection<{ c: { path: Expr } & Options }>['c']
export function column(pathOrSpec: string | { test: string }, options?: PathOptions): unknown {
  return brandedSpec(pathOrSpec, options)
}

function brandedSpec(pathOrSpec: string | { test: string }, options?: PathOptions): ColumnSpec {
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
export function declareColumn<const Expr extends string, const Options extends PathOptions>(
  functionName: string,
  path: Expr,
  options: Options & PickConstraint<Options>
): DeclaredColumn<Projection<{ c: { path: Expr } & Options }>['c']>
export function declareColumn(
  functionName: string,
  pathOrSpec: string | { test: string },
  options?: PathOptions
): DeclaredColumn {
  const spec = brandedSpec(pathOrSpec, options)
  return Object.assign(() => spec as unknown, { [COLUMN_BRAND]: true, functionName, spec })
}

/** Whether a value is a declared column rather than a DTO class or plain function. */
export function isDeclaredColumn(value: unknown): value is DeclaredColumn {
  return typeof value === 'function' && COLUMN_BRAND in value
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
