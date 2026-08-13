import '../functions/install.ts'

import { mergeEnvKeys, normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import { functions as builtinFunctions } from '../functions/registry.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { EmptyFhirpathTypeContext, FhirpathTypeContextOf, FhirTypeName } from '../typed/infer.ts'
import { canonicalFocusType, typesOverlap } from '../values/type-compat.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { toSubjects } from './bundle.ts'
import { columnSignature, criteriaSignature } from './column-signature.ts'
import type { AnyExpression, Compiler, CustomFunction, EvaluateOptions, SingleCustomFunction } from './compile.ts'
import type { ColumnOptions, ColumnResult, ProjectionColumn, ProjectionTypeContext } from './project.ts'

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

/** TypeScript error data for a DTO field that cannot hold its column result. */
export interface ColumnTypeMismatch<Declared, Inferred> {
  readonly __brand: 'fhirpath-ts: the declared field type cannot hold what this column yields'
  readonly declared: Declared
  readonly inferred: Inferred
}

/** Accepts unknown inference; `analyzeDto` checks an explicit column `type`. */
type Checked<Inferred, Declared> = unknown extends Inferred
  ? (initial: Declared) => Declared
  : [Inferred] extends [Declared]
    ? (initial: Declared) => Declared
    : ColumnTypeMismatch<Declared, Inferred>

/** Every DTO instance carries the type its columns read. */
export interface DtoInstance {
  readonly fhirType: string
}

/** The inference root for a DTO's columns: the `fhirType` of the class they are declared on. */
type RootOf<This> = This extends { readonly fhirType: infer Root extends string } ? Root : 'opaque'

/** The literal options retained by the base that a DTO extends. */
type DtoOptionsOf<This extends DtoInstance> = This extends {
  readonly __fhirpathDtoOptions?: infer Options extends object
}
  ? Options
  : EmptyFhirpathTypeContext

/** Build projection context only for columns that read an environment binding. */
type DtoColumnContext<
  Column extends { path: string },
  This extends DtoInstance,
> = Column['path'] extends `${string}%${string}`
  ? ProjectionTypeContext<FhirpathTypeContextOf<DtoOptionsOf<This>>>
  : EmptyFhirpathTypeContext

/** A checked field decorator for a column whose value type is already fixed (a criteria). */
type ColumnDecorator<Value> = <This extends DtoInstance, Declared>(
  target: undefined,
  context: ClassFieldDecoratorContext<This, Declared>
) => Checked<Value, Declared>

/** A checked field decorator whose column value depends on the root it lands on. */
type PathDecorator<Column extends { path: string }> = <This extends DtoInstance, Declared>(
  target: undefined,
  context: ClassFieldDecoratorContext<This, Declared>
) => Checked<ColumnResult<Column, RootOf<This>, DtoColumnContext<Column, This>>, Declared>

/**
 * Environment values owned by a DTO. Declare them as `static env`, with keys
 * written with or without `%`. They apply only to that DTO's column bodies.
 * Subclasses merge values by key; annotate a base field as `DtoEnv` when a
 * subclass should override only part of the record.
 */
export type DtoEnv = Record<string, unknown>

/** Base class returned by `defineDto()`, with the root and literal options used for column inference. */
export type DtoBase<Root extends string, Options extends object = EmptyFhirpathTypeContext> = (new () => DtoInstance & {
  readonly fhirType: Root
  /** @internal Type-only carrier for DTO decorator inference. */
  readonly __fhirpathDtoOptions?: Options
}) & {
  readonly fhirType: Root
}

/** A DTO class: a `defineDto()` base, or any class extending one. */
export type DtoClass = (new () => DtoInstance) & { readonly fhirType: string }

/** The DTO instance type returned by projection, including getters and methods. */
export type DtoRow<C extends DtoClass> = InstanceType<C>

/** Data a DTO reads in addition to the projected resource. DTO-owned values use `static env`. */
export interface DtoOptions {
  /** Per-row bindings the columns read (EvaluateOptions.vars semantics; may reference per-call env). */
  vars?: Record<string, AnyExpression | readonly TypedValue[]>
  /** Environment names supplied by `project()`, declared so DTO checks can resolve them. */
  callerEnv?: readonly string[]
}

type DtoVars = NonNullable<DtoOptions['vars']>
type DtoCallerEnv = NonNullable<DtoOptions['callerEnv']>
type LiteralDtoOptions<Vars extends DtoVars, CallerEnv extends DtoCallerEnv> = {
  readonly vars?: Vars
  readonly callerEnv?: CallerEnv
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

/** The DTO class whose field initializers may record columns during definition collection. */
let collecting: object | undefined

/**
 * Creates a DTO base for one FHIR resource or datatype. The type becomes the
 * context for relative column paths. Subclasses may add decorated fields,
 * getters, methods, and shared base columns.
 */
export function defineDto<
  const Root extends FhirTypeName,
  const Vars extends DtoVars = EmptyFhirpathTypeContext,
  const CallerEnv extends DtoCallerEnv = readonly [],
>(fhirType: Root, options?: LiteralDtoOptions<Vars, CallerEnv>): DtoBase<Root, LiteralDtoOptions<Vars, CallerEnv>> {
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
  return base as unknown as DtoBase<Root, LiteralDtoOptions<Vars, CallerEnv>>
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
 * Declares a Boolean criteria column. It uses `FhirPathEngine.test()` rules: one
 * Boolean returns itself, empty returns `false`, and several values are an
 * error. A registered criteria function keeps the same behavior.
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
 * Merges each class's own `static env`, from the base to the most derived class.
 * A getter is read once while the definition is collected. An empty result has
 * no environment overlay.
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

/** Collects and caches a DTO's type, columns, environment, variables, and caller environment names. */
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
  // A field initializer may collect another DTO. Restore the outer class so its
  // remaining fields are still recorded.
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
 * Adds DTO columns to the engine's function table. Each function keeps its DTO
 * input type and environment. Same-name functions become overloads when their
 * input types do not overlap.
 */
export function withDtos(defaults: EvaluateOptions, dtos: readonly DtoClass[], compile: Compiler): EvaluateOptions {
  if (dtos.length === 0) {
    return defaults
  }
  const { model } = defaults
  if (model === undefined) {
    // The model selects a column from the call focus and separates same-name columns.
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

/** Adds a column declaration when its focus type distinguishes it from every existing declaration. */
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
 * Explains why focus-only dispatch cannot separate two declarations. Each side
 * must declare input types, and those types must not overlap.
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
  // Equal types make the field name ambiguous, even though the type itself is clear.
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
 * Converts a DTO column into a typed expression function with the DTO's local
 * environment. Criteria functions also carry the criteria Boolean rule. DTO
 * variables remain projection-only because function calls have no row.
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
 * Checks each resource against the DTO type before projection. Without this
 * check, a wrong resource could produce a typed row filled with defaults.
 * Datatype inputs have no `resourceType` to check.
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
 * Merges DTO options with call options. DTO environment values and variables
 * win so a column's declared context cannot change when it is projected.
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
    merged.vars = mergeEnvKeys(options?.vars, vars)
  }
  return merged
}
