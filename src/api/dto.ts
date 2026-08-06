import { mergeEnvKeys, normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { toSubjects } from './bundle.ts'
import type { AnyExpression, Compiler, CustomFunction, EvaluateOptions } from './compile.ts'
import type { ColumnOptions, ColumnResult, ProjectionColumn, ProjectionColumns } from './project.ts'

/** The object forms of ProjectionColumn — what a `@column` decorator records. */
type ColumnSpec = Exclude<ProjectionColumn, string>

/**
 * Ties `pick` to the table's row keys: with a table `choices`, `pick` must name
 * a row field; without one, `pick` is rejected outright. Applied as a validation
 * intersection on the options parameter, so a `pick` typo is a compile error at
 * the decorator.
 */
type PickConstraint<Options> = Options extends { choices: readonly (infer Row extends { code: string })[] }
  ? { pick?: keyof Row & string }
  : { pick?: never }

/**
 * Reported by the checker when a field's declared type cannot hold what its
 * column expression yields. Surfaces as
 * `Decorator function return type 'ColumnTypeMismatch<…>' is not assignable to …`
 * on the offending `@column`, naming both sides.
 */
export interface ColumnTypeMismatch<Declared, Inferred> {
  readonly __brand: 'fhirpath-ts: the declared field type cannot hold what this column yields'
  readonly declared: Declared
  readonly inferred: Inferred
}

/**
 * The declared field type must be able to hold the column's inferred value. An
 * expression outside the inference subset yields `unknown` — the escape valve —
 * and passes here; declare the column's `type` to have `analyzeDto` check it
 * against the analyzer's own inference instead.
 */
type Checked<Inferred, Declared> = unknown extends Inferred
  ? (initial: Declared) => Declared
  : [Inferred] extends [Declared]
    ? (initial: Declared) => Declared
    : ColumnTypeMismatch<Declared, Inferred>

/** A type name the bound model knows — what a DTO's `fhirType` must be. */
export type FhirTypeName = keyof R4TypeOf & string

/** Every DTO instance carries the type its columns read, which is also their inference root. */
export interface DtoInstance {
  readonly fhirType: string
}

/** The inference root for a DTO's columns: the `fhirType` of the class they are declared on. */
type RootOf<This> = This extends { readonly fhirType: infer Root extends string } ? Root : 'opaque'

/** A checked field decorator for a column whose value type is already fixed (a criteria). */
type ColumnDecorator<Value> = <This extends DtoInstance, Declared>(
  target: undefined,
  context: ClassFieldDecoratorContext<This, Declared>
) => Checked<Value, Declared>

/** A checked field decorator whose column value depends on the root it lands on. */
type PathDecorator<Column extends { path: string }> = <This extends DtoInstance, Declared>(
  target: undefined,
  context: ClassFieldDecoratorContext<This, Declared>
) => Checked<ColumnResult<Column, RootOf<This>>, Declared>

/**
 * The DTO class a `@column`-decorated class extends: it fixes the resource or
 * datatype the columns read — their inference root — and carries the `vars` and
 * `env` those columns need.
 */
export type DtoBase<Root extends string> = (new () => { readonly fhirType: Root }) & { readonly fhirType: Root }

/** A DTO class: a `defineDto()` base, or any class extending one. */
export type DtoClass = (new () => DtoInstance) & { readonly fhirType: string }

/** The rows a DTO projection produces: the instance type itself, so getters and methods come along. */
export type DtoRow<C extends DtoClass> = InstanceType<C>

/** The data a DTO's columns read besides the resource itself. */
export interface DtoOptions {
  /** Env data the DTO owns: lookup tables, system URLs. Registered engine-wide via EngineOptions.resourceDtos, and always applied when projecting the DTO. */
  env?: Record<string, unknown>
  /** Per-row bindings the columns read (EvaluateOptions.vars semantics; may reference per-call env). */
  vars?: Record<string, AnyExpression | readonly TypedValue[]>
  /**
   * Env names the *projecting call* supplies rather than the DTO —
   * `project(orders, LabResultRow, { env: { reports } })` declares
   * `callerEnv: ['reports']`. Data that varies per request cannot live on the
   * DTO or the engine, but which names it uses is part of the DTO's contract, so
   * declaring them here is what lets `analyzeDto` (and the `fhirpath-check` CLI)
   * check the expressions that read them instead of reporting them as undefined.
   */
  callerEnv?: readonly string[]
}

/** Everything a DTO class was declared with; `project()`, the engine, and `analyzeDto` all read it from here. */
export interface DtoDefinition {
  readonly fhirType: string
  readonly columns: ProjectionColumns
  readonly env: Record<string, unknown> | undefined
  readonly vars: Record<string, AnyExpression | readonly TypedValue[]> | undefined
  /** Env names the projecting call supplies (see DtoOptions.callerEnv). */
  readonly callerEnv: readonly string[] | undefined
}

/** The `fhirType`/`env`/`vars` a `defineDto()` base was created with, by that base class. */
const bases = new WeakMap<object, { fhirType: string } & DtoOptions>()

/**
 * Columns by the class that declared them. A field decorator runs before its
 * class exists, so it records through the initializer it returns, where `this`
 * is the instance being built and `this.constructor` the class — `definitionOf`
 * instantiates each DTO once to collect them.
 */
const declaredColumns = new WeakMap<object, Record<string, ColumnSpec>>()

/** Definitions already collected, keyed by the DTO class. */
const definitions = new WeakMap<object, DtoDefinition>()

/**
 * Declares the resource or datatype a DTO reads, plus the `vars`/`env` its
 * columns need. Extend the result and declare the columns as `@column` fields:
 * `fhirType` is the context their paths infer against, so the paths stay
 * relative and each field's declared type is checked against what its
 * expression yields.
 *
 * ```ts
 * class WeightRow extends defineDto('Observation') {
 *   @column("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 })
 *   lbs!: number
 *
 *   @column('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
 *   at!: Date | undefined
 *
 *   get rounded(): number {
 *     return Math.round(this.lbs)
 *   }
 * }
 * const rows = fp.project(observations, WeightRow) // WeightRow[]
 * ```
 *
 * Columns a DTO shares with others live on a shared base class — extend it
 * instead of repeating them, and `project()` sees the inherited columns too.
 */
export function defineDto<const Root extends FhirTypeName>(fhirType: Root, options: DtoOptions = {}): DtoBase<Root> {
  const base = class {
    /** On the prototype, so it stays out of a projected row's own keys. */
    get fhirType(): Root {
      return fhirType
    }
  }
  // A readable name for project()/registration errors; a subclass replaces it.
  Object.defineProperty(base, 'name', { value: `${fhirType}Dto` })
  Object.defineProperty(base, 'fhirType', { value: fhirType, enumerable: true })
  bases.set(base, { fhirType, ...options })
  return base as unknown as DtoBase<Root>
}

/**
 * Records one column against the class being constructed. Every projected row
 * runs the same initializers, so once the class's definition is collected there
 * is nothing left to record.
 */
function recordColumn(instance: object, name: string, spec: ColumnSpec): void {
  const cls = instance.constructor as object
  if (definitions.has(cls)) {
    return
  }
  const own = declaredColumns.get(cls) ?? {}
  own[name] = spec
  declaredColumns.set(cls, own)
}

/** The decorator both `column()` and `criteria()` return: record on construction, leave the field empty. */
function fieldDecorator(spec: ColumnSpec): (target: undefined, context: ClassFieldDecoratorContext) => unknown {
  return (_target, context) => {
    if (context.static || context.private) {
      throw new FhirPathTypeError(`Column '${String(context.name)}' must be a public instance field`)
    }
    const name = String(context.name)
    return function (this: object): undefined {
      recordColumn(this, name, spec)
      return undefined
    }
  }
}

/**
 * Declares one column of a DTO: the expression it reads, relative to the
 * class's `fhirType`, plus the same options a `project()` column takes —
 * `type`, `as`, `choices`/`pick`, `enum`, `default`, `collection`. The field's
 * declared type is checked against what the expression yields, and is the type
 * a projected row holds there.
 */
export function column<const Expr extends string>(path: Expr): PathDecorator<{ path: Expr }>
export function column<const Expr extends string, const Options extends ColumnOptions>(
  path: Expr,
  options: Options & PickConstraint<Options>
): PathDecorator<{ path: Expr } & Options>
export function column(path: string, options?: ColumnOptions): unknown {
  return fieldDecorator({ path, ...options })
}

/**
 * Declares a criteria column: the expression evaluates with the same spec §4.5
 * semantics as `FhirPathEngine.test()` (empty → false, a single boolean →
 * itself), so the field is always a `boolean`. Projection-only — a criteria
 * never registers as a function.
 */
export function criteria<const Expr extends string>(expr: Expr): ColumnDecorator<boolean>
export function criteria(expr: string): unknown {
  return fieldDecorator({ test: expr })
}

/** The `defineDto()` base a class descends from, with the fhirType/env/vars it fixed. */
function baseOf(cls: object): ({ fhirType: string } & DtoOptions) | undefined {
  for (let current: unknown = cls; typeof current === 'function'; current = Object.getPrototypeOf(current)) {
    const base = bases.get(current as object)
    if (base !== undefined) {
      return base
    }
  }
  return undefined
}

/**
 * Whether a value is a DTO class — one `defineDto()` produced, or a subclass of
 * one. Lets tooling pick the DTOs out of a module's exports (see the
 * `fhirpath-check` CLI) without instantiating anything that is not one.
 */
export function isDtoClass(value: unknown): value is DtoClass {
  return typeof value === 'function' && baseOf(value) !== undefined
}

/**
 * The definition a DTO class declared: its base's `fhirType`/`env`/`vars`, and
 * every `@column`/`@criteria` field it or its bases declare. Collected by
 * instantiating the class once — field initializers are where the decorators
 * record — and cached per class, since a declaration never changes.
 */
export function dtoDefinition(cls: DtoClass): DtoDefinition {
  const cached = definitions.get(cls)
  if (cached !== undefined) {
    return cached
  }
  const base = baseOf(cls)
  if (base === undefined) {
    throw new FhirPathTypeError(
      `${cls.name || 'The class'} is not a DTO class; extend defineDto('<fhirType>') to declare one`
    )
  }
  new cls()
  const columns = declaredColumns.get(cls) ?? {}
  if (Object.keys(columns).length === 0) {
    throw new FhirPathTypeError(`DTO ${cls.name} declares no columns; add a @column field`)
  }
  /* v8 ignore start -- TypeScript rejects a field that shadows the base's fhirType; this only fires for an untyped host (the demo playground runs transpile-only code) */
  if ('fhirType' in columns) {
    throw new FhirPathTypeError(`DTO ${cls.name} declares a column named 'fhirType', which every row already carries`)
  }
  /* v8 ignore stop */
  const definition: DtoDefinition = {
    fhirType: base.fhirType,
    columns,
    env: base.env,
    vars: base.vars,
    callerEnv: base.callerEnv,
  }
  definitions.set(cls, definition)
  return definition
}

/**
 * Fold registered DTO classes into the engine defaults: each column becomes an
 * expression-defined function (its analyzer signature derived from the column's
 * `type` when no `as`/`choices` reshapes the value), and each DTO's `env` merges
 * in. Redefining an existing function or env variable is an error — silent
 * shadowing between DTOs would be impossible to debug from an expression.
 */
export function withDtos(defaults: EvaluateOptions, dtos: readonly DtoClass[], compile: Compiler): EvaluateOptions {
  if (dtos.length === 0) {
    return defaults
  }
  const functions: Record<string, CustomFunction> = { ...defaults.functions }
  const env: Record<string, unknown> = normalizeEnvKeys(defaults.env)
  const classPerType = new Map<string, string>()
  for (const dto of dtos) {
    const definition = dtoDefinition(dto)
    // One registered DTO per fhirType: it is the engine-wide vocabulary for
    // that resource, so a second one is a conflict, not an addition.
    const registered = classPerType.get(definition.fhirType)
    if (registered !== undefined) {
      throw new FhirPathTypeError(
        `DTO ${dto.name} registers fhirType '${definition.fhirType}', already registered by ${registered}`
      )
    }
    classPerType.set(definition.fhirType, dto.name)
    for (const [name, spec] of Object.entries(definition.columns)) {
      if (typeof spec === 'string' || 'test' in spec) {
        continue
      }
      if (name in functions) {
        throw new FhirPathTypeError(`DTO ${dto.name} redefines the function '${name}'`)
      }
      functions[name] = columnFunction(spec, compile)
    }
    for (const [name, value] of Object.entries(normalizeEnvKeys(definition.env))) {
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
 * `as`/`choices` reshapes the value outside FHIRPath.
 */
function columnFunction(spec: Extract<ProjectionColumn, { path: string }>, compile: Compiler): CustomFunction {
  const resultType =
    spec.as !== undefined || spec.choices !== undefined
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
  const { fhirType } = dtoDefinition(dto)
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
 * A projected DTO's own env and vars, merged under the per-call options (per
 * name, call wins) — so precedence runs engine defaults, then DTO, then call.
 * A DTO registered via EngineOptions.resourceDtos re-applies its env here with
 * identical values, which is harmless.
 */
export function dtoCallOptions(dto: DtoClass, options: EvaluateOptions | undefined): EvaluateOptions | undefined {
  const { env, vars } = dtoDefinition(dto)
  if (env === undefined && vars === undefined) {
    return options
  }
  const merged: EvaluateOptions = { ...options }
  if (env !== undefined) {
    merged.env = mergeEnvKeys(env, options?.env)
  }
  if (vars !== undefined) {
    merged.vars = mergeEnvKeys(vars, options?.vars)
  }
  return merged
}
