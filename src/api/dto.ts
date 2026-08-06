import { mergeEnvKeys, normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { EmptyRegistry, Registry, StateOf } from '../typed/infer.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { toSubjects } from './bundle.ts'
import type { AnyExpression, Compiler, CustomFunction, EvaluateOptions } from './compile.ts'
import type { ColumnOptions, ColumnResult, Projection, ProjectionColumn, ProjectionColumns } from './project.ts'

/**
 * Marks a `column()` value so a DTO class's fields can be told apart from its
 * ordinary properties. The brand is a symbol key, so projection code that
 * reads the spec as a plain ProjectionColumn never sees it — and it has no
 * type-level counterpart, so the fields' static types stay plain values.
 */
const COLUMN_BRAND = Symbol('fhirpath-ts.column')

/**
 * The FHIR type a `columnsOf()` factory stamps on every spec it creates.
 * Runtime-only, like COLUMN_BRAND: it lets a class's fhirType be derived
 * from its columns (see dtoFhirType) without any type-level residue on the
 * fields.
 */
const COLUMN_ROOT = Symbol('fhirpath-ts.columnRoot')

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
  return columnSpec(pathOrSpec, options)
}

function columnSpec(pathOrSpec: string | { test: string }, options?: ColumnOptions): ColumnSpec {
  const spec: ColumnSpec = typeof pathOrSpec === 'string' ? { path: pathOrSpec, ...options } : pathOrSpec
  return Object.assign(spec, { [COLUMN_BRAND]: true })
}

/**
 * The column factory `columnsOf()` returns: `column()` with the expressions'
 * relative chains typed against the scoped FHIR type.
 */
export interface ScopedColumn<Root extends keyof R4TypeOf & string> {
  <const Criteria extends string>(spec: { test: Criteria }): boolean
  <const Expr extends string>(path: Expr): ColumnResult<{ path: Expr }, EmptyRegistry, Root>
  <const Expr extends string, const Options extends ColumnOptions>(
    path: Expr,
    options: Options & PickConstraint<Options>
  ): ColumnResult<{ path: Expr } & Options, EmptyRegistry, Root>
}

/**
 * `column()` scoped to one resource or datatype, so a DTO class can declare
 * its columns as relative chains and still get their value types inferred:
 *
 * ```ts
 * const obs = columnsOf('Observation')
 * class WeightRow {
 *   lbs = obs("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 }) // number
 *   at = obs('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })       // Date | undefined
 * }
 * ```
 *
 * The scope is also stamped on each spec at runtime, so a class whose columns
 * all come from one factory needs no `fhirType` static — registration and the
 * `project()` input check derive it (see dtoFhirType). Fields hold plain
 * value types; nothing type-level rides along.
 */
export function columnsOf<const Root extends keyof R4TypeOf & string>(fhirType: Root): ScopedColumn<Root> {
  const scoped = (pathOrSpec: string | { test: string }, options?: ColumnOptions): unknown =>
    Object.assign(columnSpec(pathOrSpec, options), { [COLUMN_ROOT]: fhirType })
  return scoped as ScopedColumn<Root>
}

/**
 * A reusable column declaration (see `declareColumn`): call it in field
 * position — `at = ObservedAt()` — to use the same column in several DTO
 * classes, and list it in `EngineOptions.columns` to register its expression
 * as an engine-wide function named `functionName`. `Spec` and `Name` are the
 * type-level capture the engine's function registry reads.
 */
export interface DeclaredColumn<T = unknown, Spec = unknown, Name extends string = string> {
  (): T
  /** The engine-wide function name the declaration registers under. */
  readonly functionName: Name
  /** The underlying column spec — one shared object, never mutated. */
  readonly spec: Exclude<ProjectionColumn, string>
  /** Type-level only, never present at runtime: the literal column spec for the registry. */
  readonly declaredSpec?: Spec
}

/**
 * Declares a column once for reuse across DTO classes. The declaration is a
 * zero-argument factory whose calls all return the same spec (typed as the
 * column's value, like `column()`), plus the `functionName` under which
 * `EngineOptions.columns` registers the expression engine-wide — so the chain
 * is also callable from any expression, e.g. `observedAt()`. A `{ test }`
 * declaration is projection-only and cannot be registered.
 */
export function declareColumn<const Name extends string, const Criteria extends string>(
  functionName: Name,
  spec: { test: Criteria }
): DeclaredColumn<boolean, { test: Criteria }, Name>
export function declareColumn<const Name extends string, const Expr extends string>(
  functionName: Name,
  path: Expr
): DeclaredColumn<Projection<{ c: Expr }>['c'], { path: Expr }, Name>
export function declareColumn<
  const Name extends string,
  const Expr extends string,
  const Options extends ColumnOptions,
>(
  functionName: Name,
  path: Expr,
  options: Options & PickConstraint<Options>
): DeclaredColumn<ColumnResult<{ path: Expr } & Options>, { path: Expr } & Options, Name>
export function declareColumn(
  functionName: string,
  pathOrSpec: string | { test: string },
  options?: ColumnOptions
): DeclaredColumn {
  const spec = columnSpec(pathOrSpec, options)
  // The value is the spec until projection replaces it; `never` satisfies the
  // value type the declaration advertises (see `column()`).
  return Object.assign(() => spec as never, { functionName, spec })
}

/**
 * The statics a DTO class may declare. A DTO groups everything one row shape
 * needs: `column()` fields, the per-row `vars` its columns read, and the `env`
 * data (lookup tables, system URLs) its expressions join against.
 */
export interface DtoStatics {
  /**
   * The resource or datatype the columns read, e.g. 'Observation' —
   * typo-checked against the model's type names. A class whose columns come
   * from a `columnsOf()` factory needs no declaration: the factory's scope is
   * the fhirType (a declaration that contradicts it throws). Registering the
   * class via `EngineOptions.resourceDtos` requires a fhirType from one of
   * the two sources (one registered class per fhirType). `project()` checks
   * each row's `resourceType` against it and throws on a mismatch; a subject
   * with no `resourceType` (a datatype value) has nothing to check.
   */
  readonly fhirType?: keyof R4TypeOf & string
  /** Env data the class owns. Registered engine-wide via EngineOptions.resourceDtos, and always applied when projecting the class. */
  readonly env?: Record<string, unknown>
  /** Per-row bindings applied when projecting the class (EvaluateOptions.vars semantics; may reference per-call env). */
  readonly vars?: Record<string, AnyExpression | readonly TypedValue[]>
}

/** A DTO class: zero-argument constructable, optionally carrying DtoStatics. */
export type DtoClass = (new () => object) & DtoStatics

/**
 * The state name a column spec contributes to the registry. A shaper
 * (`as`/`map`/`enum`) makes the column's value a TS value outside the
 * type-name space, so it registers 'opaque'; a declared `type` is not
 * consulted — registry entries come from inference alone.
 */
type ColumnStateOf<Spec, Root extends string, Fns extends Registry> = Spec extends
  { as: unknown } | { map: unknown } | { enum: unknown }
  ? 'opaque'
  : Spec extends { path: infer P extends string }
    ? StateOf<P, Root, Fns>
    : 'opaque'

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never

/**
 * Declared columns' registry entries. A declaration parses with no relative
 * context ('opaque' root), so its state is input-independent and `in` is the
 * broad `string` — every call-site state matches. `& EmptyRegistry` grounds
 * the no-columns case (`unknown`).
 */
type ColumnsRegistry<Col, Fns extends Registry> = UnionToIntersection<
  Col extends { functionName: infer N extends string; declaredSpec?: infer Sp }
    ? NonNullable<Sp> extends { path: string }
      ? { [K in N]: { in: string; out: ColumnStateOf<NonNullable<Sp>, 'opaque', Fns> } }
      : never
    : never
> &
  EmptyRegistry

/**
 * The engine's type-level function registry, from its declared columns
 * (EngineOptions.columns). Two fixed passes (never a fixpoint): pass 1
 * computes every state with the empty registry, so self-contained
 * definitions resolve; pass 2 recomputes with pass 1 in scope, so a
 * definition calling another declared function resolves too. Deeper chains
 * register as 'opaque' — honest, not wrong.
 *
 * DTO-class columns register at runtime only: their fields hold plain value
 * types, so nothing carries the expressions into the type system and calls
 * to them infer `unknown[]`.
 */
export type EngineRegistry<Col> =
  ColumnsRegistry<Col, EmptyRegistry> extends infer Pass1 extends Registry
    ? ColumnsRegistry<Col, Pass1> extends infer Pass2 extends Registry
      ? Pass2
      : EmptyRegistry
    : EmptyRegistry

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
 * The fhirType a DTO class reads: its `fhirType` static, or the scope its
 * `columnsOf()` columns are stamped with. The two sources must agree — and so
 * must the columns among themselves — because every consumer (registration,
 * the `project()` input check, analyzeDto's input type) assumes one type per
 * class; a conflict is a bug at the declaration site, surfaced here.
 * `undefined` when the class declares nothing and no column is scoped.
 */
export function dtoFhirType(dto: DtoClass): string | undefined {
  let scoped: string | undefined
  for (const spec of Object.values(dtoColumns(dto))) {
    const root = (spec as { [COLUMN_ROOT]?: string })[COLUMN_ROOT]
    if (root === undefined) {
      continue
    }
    if (scoped !== undefined && scoped !== root) {
      throw new FhirPathTypeError(`DTO ${dto.name} mixes columnsOf('${scoped}') and columnsOf('${root}') columns`)
    }
    scoped = root
  }
  if (dto.fhirType !== undefined && scoped !== undefined && dto.fhirType !== scoped) {
    throw new FhirPathTypeError(
      `DTO ${dto.name} declares fhirType '${dto.fhirType}', but its columns come from columnsOf('${scoped}')`
    )
  }
  return dto.fhirType ?? scoped
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
    const fhirType = dtoFhirType(dto)
    if (fhirType === undefined) {
      throw new FhirPathTypeError(`DTO ${dto.name} must declare a fhirType (or use columnsOf) to register`)
    }
    const registered = classPerType.get(fhirType)
    if (registered !== undefined) {
      throw new FhirPathTypeError(
        `DTO ${dto.name} registers fhirType '${fhirType}', already registered by ${registered}`
      )
    }
    classPerType.set(fhirType, dto.name)
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
  const fhirType = dtoFhirType(dto)
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
