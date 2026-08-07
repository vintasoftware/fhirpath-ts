import '../functions/install.ts'

import { mergeEnvKeys, normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import { functions as builtinFunctions } from '../functions/registry.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { FhirTypeName } from '../typed/infer.ts'
import { canonicalFocusType, typesOverlap } from '../values/type-compat.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { toSubjects } from './bundle.ts'
import { columnSignature, criteriaSignature } from './column-signature.ts'
import type { AnyExpression, Compiler, CustomFunction, EvaluateOptions, SingleCustomFunction } from './compile.ts'
import type { ColumnOptions, ColumnResult, ProjectionColumn } from './project.ts'

/** The object forms of ProjectionColumn — what a `@column`/`@criteria` decorator records. */
export type ColumnSpec = Exclude<ProjectionColumn, string>

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
 * The environment variables a DTO owns, declared as a `static env` field on the
 * class — lookup tables, system URLs, anything its expressions read as `%name`,
 * keyed with or without the leading `%`.
 *
 * ```ts
 * class BadgeRow extends defineDto('Observation') {
 *   static env = { tones: [{ code: 'final', tone: 'success' }] }
 *
 *   @column('%tones.where(code = %context.status).tone', { type: 'string', default: 'neutral' })
 *   tone!: string
 * }
 * ```
 *
 * These reach this DTO's own columns and nowhere else: when the DTO is
 * projected, and inside the body of each of its columns called as a function
 * from another expression. Registering the DTO on an engine publishes nothing,
 * so two DTOs may declare one name with two different values and neither
 * shadows the other. Bind `env` on the engine to publish a variable to every
 * expression it evaluates.
 *
 * A subclass adds to what its bases declare, per name — the same way it adds
 * columns — so a shared base can own a table and each row shape override one
 * entry of it. Annotate the base's field `DtoEnv` to write that: without the
 * annotation TypeScript infers the base's exact record, and a subclass naming
 * one entry does not satisfy it.
 *
 * ```ts
 * class BadgedRow extends defineDto('DiagnosticReport') {
 *   static env: DtoEnv = { unit: 'kg', label: 'Reading' }
 * }
 * class PoundsRow extends BadgedRow {
 *   static override env = { unit: '[lb_av]' } // `label` still reads 'Reading'
 * }
 * ```
 *
 * A DTO that declares env once needs no annotation at all: `static env = { … }`.
 * Write `static env = { … } satisfies DtoEnv` to have the shape checked where it
 * is declared instead of when the DTO is first used.
 */
export type DtoEnv = Record<string, unknown>

/**
 * The DTO class a `@column`-decorated class extends: it fixes the resource or
 * datatype the columns read — their inference root — and carries the `vars`
 * those columns need. The env they read is a `static env` on the class itself
 * (see `DtoEnv`), which is deliberately not part of this type: declaring it
 * here would make every DTO's own `static env` an override.
 */
export type DtoBase<Root extends string> = (new () => { readonly fhirType: Root }) & { readonly fhirType: Root }

/** A DTO class: a `defineDto()` base, or any class extending one. */
export type DtoClass = (new () => DtoInstance) & { readonly fhirType: string }

/** The rows a DTO projection produces: the instance type itself, so getters and methods come along. */
export type DtoRow<C extends DtoClass> = InstanceType<C>

/**
 * The data a DTO's columns read besides the resource itself. The env the DTO
 * owns is not here — it is a `static env` field on the class (see `DtoEnv`).
 */
export interface DtoOptions {
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
  /** A decorator always records an object form, so a consumer never has to handle the plain-string column. */
  readonly columns: Readonly<Record<string, ColumnSpec>>
  /** The `static env` fields down the class chain, merged per name with the most derived winning. */
  readonly env: Record<string, unknown> | undefined
  readonly vars: Record<string, AnyExpression | readonly TypedValue[]> | undefined
  /** Env names the projecting call supplies (see DtoOptions.callerEnv). */
  readonly callerEnv: readonly string[] | undefined
}

/** The `fhirType`/`vars` a `defineDto()` base was created with, by that base class. */
const bases = new WeakMap<object, { fhirType: string } & DtoOptions>()

/**
 * Columns by the class that declared them. A field decorator runs before its
 * class exists, so it records through the initializer it returns, where `this`
 * is the instance being built and `this.constructor` the class — `dtoDefinition`
 * instantiates each DTO once to collect them.
 */
const declaredColumns = new WeakMap<object, Record<string, ColumnSpec>>()

/** Definitions already collected, keyed by the DTO class. */
const definitions = new WeakMap<object, DtoDefinition>()

/**
 * The class `dtoDefinition` is collecting, for as long as its single `new cls()`
 * runs — the only window in which a field initializer records anything.
 *
 * Every projected row is built the same way (`Object.assign(new Dto(), row)`), so
 * the initializers run again and again; making the window explicit is what stops
 * them, rather than a "already collected?" test that would have to stay true
 * forever to remain correct. It also keeps the per-row path to one identity
 * comparison.
 */
let collecting: object | undefined

/**
 * Declares the resource or datatype a DTO reads, plus the `vars` its
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

/** Records one column against the class being collected, and does nothing at any other time. */
function recordColumn(instance: object, name: string, spec: ColumnSpec): void {
  const cls = instance.constructor as object
  if (cls !== collecting) {
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
 * Declares a criteria column: the expression evaluates with the same criteria
 * semantics as `FhirPathEngine.test()` (a single boolean → itself per spec §4.5,
 * empty → false per the convention on top of it), so the field is always a
 * `boolean`.
 *
 * Other expressions can also call a registered DTO's criteria, as `isFinal()`,
 * and the criteria rule travels with it. The call returns one Boolean, so
 * `isFinal().not()` on a resource with no `status` is `true`, the same answer
 * the projected column gives. The body still runs against the call's focus, so
 * call it on the type the DTO was written for.
 */
export function criteria<const Expr extends string>(expr: Expr): ColumnDecorator<boolean>
export function criteria(expr: string): unknown {
  return fieldDecorator({ test: expr })
}

/** A class and the classes it extends, most derived first. */
function* classChain(cls: object): Generator<{ readonly name: string }> {
  for (let current: unknown = cls; typeof current === 'function'; current = Object.getPrototypeOf(current)) {
    yield current as { readonly name: string }
  }
}

/** The `defineDto()` base a class descends from, with the fhirType/vars it fixed. */
function baseOf(cls: object): ({ fhirType: string } & DtoOptions) | undefined {
  for (const current of classChain(cls)) {
    const base = bases.get(current)
    if (base !== undefined) {
      return base
    }
  }
  return undefined
}

/**
 * The `static env` a DTO class declares, merged with the ones its bases declare
 * — most derived last, so a row shape can override one entry of a table its
 * base owns. Own properties only at each level, since a plain `cls.env` read
 * would find an inherited field and count it twice. A `static get env()` is
 * read the same way, and read once: the definition is collected once per class.
 *
 * Nothing declared and nothing left after merging are the same answer, so a DTO
 * that declares an empty record carries no overlay rather than an empty one.
 */
function declaredEnv(cls: DtoClass): Record<string, unknown> | undefined {
  const declared: Record<string, unknown>[] = []
  for (const current of classChain(cls)) {
    const own = staticEnv(current)
    if (own !== undefined) {
      declared.unshift(own)
    }
  }
  const merged = Object.assign({}, ...declared.map(normalizeEnvKeys)) as Record<string, unknown>
  return Object.keys(merged).length === 0 ? undefined : merged
}

/**
 * One class's own `static env`, as a field or a getter, checked for the shape
 * the engine can bind. Names the class that declared it, which is the one to
 * edit even when the projected DTO is several subclasses below.
 */
function staticEnv(cls: { readonly name: string }): Record<string, unknown> | undefined {
  const declared = Object.getOwnPropertyDescriptor(cls, 'env')
  if (declared === undefined) {
    return undefined
  }
  const own: unknown = declared.get === undefined ? declared.value : declared.get.call(cls)
  if (own === undefined) {
    return undefined
  }
  if (typeof own !== 'object' || own === null || Array.isArray(own)) {
    throw new FhirPathTypeError(
      `DTO ${cls.name} declares a static 'env' that is not a record of variables; ` +
        'write it as { name: value }, the same shape as EvaluateOptions.env'
    )
  }
  return own as Record<string, unknown>
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
 * The definition a DTO class declared: its base's `fhirType`/`vars`, its own
 * `static env`, and every `@column`/`@criteria` field it or its bases declare.
 * Collected by instantiating the class once — field initializers are where the
 * decorators record — and cached per class, since a declaration never changes.
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
  // Saved and restored, not cleared: a field initializer may reach another DTO's
  // definition (`new FhirPathEngine({ resourceDtos })` is enough), and clearing
  // would end this class's collection at that field and silently drop every
  // column below it.
  const outer = collecting
  collecting = cls
  try {
    new cls()
  } finally {
    collecting = outer
  }
  // Copied, so the definition cannot be reached through the collection map.
  const columns = { ...declaredColumns.get(cls) }
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
    env: declaredEnv(cls),
    vars: base.vars,
    callerEnv: base.callerEnv,
  }
  definitions.set(cls, definition)
  return definition
}

/**
 * Fold registered DTO classes into the engine defaults: each column becomes an
 * expression-defined function (its analyzer signature derived from the column's
 * `type` when no `as`/`choices` reshapes the value), carrying its DTO's
 * `static env` as the overlay its body reads.
 *
 * Registering a DTO adds function names and nothing else. The env stays the
 * DTO's, readable inside its own columns and invisible to every other
 * expression the engine evaluates, so two DTOs may declare one name with two
 * different values and neither shadows the other. To publish a variable to
 * every expression, bind it on the engine (`new FhirPathEngine({ env })`),
 * where saying so is the point.
 *
 * A column name is scoped by the type its DTO was written for, not by the
 * engine: two DTOs may both declare a `displayText`, one for CodeableConcept and
 * one for Coding, and a call resolves to the one its focus fits. What the engine
 * refuses is a name whose declarations a call could *not* tell apart — see
 * `indistinguishable`. Silent shadowing is the thing to avoid, and it is only
 * shadowing when both could answer the same call.
 *
 * Names are the whole of it: how many DTOs a fhirType has is not the engine's
 * business. Several Observation DTOs — a weight row, a blood-pressure row, a lab
 * row — register side by side, and only a name two of them claim is a conflict.
 */
export function withDtos(defaults: EvaluateOptions, dtos: readonly DtoClass[], compile: Compiler): EvaluateOptions {
  if (dtos.length === 0) {
    return defaults
  }
  const { model } = defaults
  if (model === undefined) {
    // A model is what decides which focus a column answers on, and whether two
    // columns sharing a name can be told apart. Without one, every registered
    // column would answer every call.
    throw new FhirPathTypeError(
      `Registering DTOs (${dtos.map(dto => dto.name).join(', ')}) needs a model; ` +
        'a column is written for one type, and without a model the engine cannot check a call against it. ' +
        'Pass model to the engine, or project the DTO without registering it.'
    )
  }
  const functions: Record<string, CustomFunction> = { ...defaults.functions }
  for (const dto of dtos) {
    const definition = dtoDefinition(dto)
    for (const [name, spec] of Object.entries(definition.columns)) {
      // Without this, createContext fails later and names the function rather
      // than the field that caused it.
      if (builtinFunctions.has(name)) {
        throw new FhirPathTypeError(
          `DTO ${dto.name} declares a column named '${name}', which is a built-in function; rename the field`
        )
      }
      functions[name] = declaredWith(
        functions[name],
        columnFunction(spec, compile, definition),
        model,
        () => `DTO ${dto.name} redefines the function '${name}'`
      )
    }
  }
  return { ...defaults, functions }
}

/**
 * What a name stands for once one more column claims it: the column alone, or
 * the overload set that name already was, extended. Every declaration the name
 * already has must be one a call can tell the new column apart from, or the
 * engine refuses to build — `indistinguishable` says why, and `blamed` names the
 * DTO and field so the message points at the declaration to change.
 */
function declaredWith(
  existing: CustomFunction | undefined,
  column: SingleCustomFunction,
  model: ModelProvider,
  blamed: () => string
): CustomFunction {
  if (existing === undefined) {
    return column
  }
  const declared = 'overloads' in existing ? existing.overloads : [existing]
  for (const other of declared) {
    const reason = indistinguishable(model, other, column)
    if (reason !== undefined) {
      throw new FhirPathTypeError(`${blamed()}: ${reason}`)
    }
  }
  return { overloads: [...declared, column] }
}

/**
 * Why a call could not tell two same-named declarations apart, or undefined
 * when it always can. Dispatch is by the focus alone (`resolveHostCall`), so
 * both sides must say what focus they were written for, and no value may be
 * both. A `Quantity` column and a `SimpleQuantity` one fail that: one value
 * satisfies both. So does any column beside a host function that declares no
 * input at all, since that function answers every call.
 *
 * `typesOverlap` is the same permissive rule the input-type check uses, asked
 * the other way round: there it decides whether a call may be valid, here
 * whether two declarations may collide. Both err toward saying yes, which is
 * the safe direction in each case.
 */
function indistinguishable(model: ModelProvider, a: SingleCustomFunction, b: SingleCustomFunction): string | undefined {
  const wanted = canonicalTypes(model, a.signature?.input?.types)
  const claimed = canonicalTypes(model, b.signature?.input?.types)
  if (wanted === undefined || claimed === undefined) {
    return 'a declaration that names no input type answers every call, so nothing else may share its name'
  }
  const overlap = wanted.flatMap(one =>
    claimed.filter(other => typesOverlap(model, one, other)).map(other => [one, other])
  )
  const pair = overlap[0]
  if (pair === undefined) {
    return undefined
  }
  // Two DTOs on one fhirType is the ordinary way to reach this: nothing is
  // ambiguous about the types, only about which column the name means.
  return pair[0] === pair[1] ? `both are written for ${pair[0]}` : `a focus can be both ${pair[0]} and ${pair[1]}`
}

/** Declared input types as the model names them, or undefined when the name declares none the model knows. */
function canonicalTypes(model: ModelProvider, types: readonly string[] | undefined): string[] | undefined {
  if (types === undefined) {
    return undefined
  }
  const canonical = types
    .map(type => canonicalFocusType(model, type))
    .filter((type): type is string => type !== undefined)
  return canonical.length === 0 ? undefined : canonical
}

/**
 * Turns a column into an expression-defined function, with the signature it
 * claims, the DTO's own `fhirType` as the input it expects, and the DTO's
 * `static env` as the overlay its body reads. A column is written for one type,
 * and calling it on anything else navigates to nothing.
 *
 * The env travels on the function so the body reads the same variables whether
 * the column is projected or called. The DTO's `vars` cannot travel the same
 * way — a var is an expression evaluated against a row, and a call has a focus
 * rather than a row — which is why they apply only when the DTO is projected.
 *
 * A criteria registers with `criteria: true`, so the criteria rule travels on
 * the function itself. That is the same rule `planColumn` applies when the
 * criteria is projected, which is what lets one declaration mean one thing in
 * both places.
 */
function columnFunction(spec: ColumnSpec, compile: Compiler, dto: DtoDefinition): SingleCustomFunction {
  const { fhirType, env } = dto
  if ('test' in spec) {
    return {
      expression: compile(spec.test),
      criteria: true,
      signature: criteriaSignature(fhirType),
      ...(env !== undefined && { env }),
    }
  }
  const signature = columnSignature(spec, fhirType)
  return {
    expression: compile(spec.path),
    ...(signature !== undefined && { signature }),
    ...(env !== undefined && { env }),
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
 * A projected DTO's own env laid over the per-call options, and its `vars` laid
 * under them. The env goes over so its columns read the same data here as they
 * do when a column is called from another expression — that overlay is the
 * DTO's too (see `withEnvOverlay`).
 * A name the DTO declares means the DTO's value by whichever route a column
 * reaches it; every other name the call supplies comes through untouched, which
 * is what `callerEnv` declares and where per-request data belongs.
 *
 * `vars` stay under the call: a var is reached by one route only, so there are
 * no two answers to reconcile, and overriding one for a call is how a caller
 * substitutes a binding.
 */
export function dtoCallOptions(dto: DtoClass, options: EvaluateOptions | undefined): EvaluateOptions | undefined {
  const { env, vars } = dtoDefinition(dto)
  if (env === undefined && vars === undefined) {
    return options
  }
  const merged: EvaluateOptions = { ...options }
  if (env !== undefined) {
    merged.env = mergeEnvKeys(options?.env, env)
  }
  if (vars !== undefined) {
    merged.vars = mergeEnvKeys(vars, options?.vars)
  }
  return merged
}
