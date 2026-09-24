import '../functions/install.ts'

import { bareEnvironmentName, mergeEnvKeys, normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import { functions as builtinFunctions } from '../functions/registry.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { R4Elements, R4TypeOf } from '../r4/generated/type-maps.ts'
import type {
  EmptyFhirpathTypeContext,
  FhirpathTypeContextOf,
  FhirpathTypeDeclarations,
  MergeFhirpathTypeContexts,
} from '../typed/infer.ts'
import { canonicalFocusType, typesOverlap } from '../values/type-compat.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { toSubjects } from './bundle.ts'
import { columnSignature, criteriaSignature } from './column-signature.ts'
import type { AnyExpression, Compiler, CustomFunction, EvaluateOptions, SingleCustomFunction } from './compile.ts'
import type { FhirPathEngine } from './engine.ts'
import type { ColumnOptions, ColumnResult, ProjectionColumn } from './project.ts'

/** The object forms of ProjectionColumn: what `this.column()` and `this.criteria()` record. */
export type ColumnSpec = Exclude<ProjectionColumn, string>

/**
 * Ties `pick` to the table's row keys: with a table `choices`, `pick` must name
 * a row field; without one, `pick` is rejected outright. Applied as a validation
 * intersection on the options parameter, so a `pick` typo is a compile error at
 * the column.
 */
type PickConstraint<Options> = Options extends { choices: readonly (infer Row extends { code: string })[] }
  ? { pick?: keyof Row & string }
  : { pick?: never }

/**
 * What a DTO class is for. A `'dto'` is registered on an engine, so its columns
 * become FHIRPath functions; a `'view'` is only projected.
 */
export type DtoKind = 'dto' | 'view'

/**
 * The column options of a registered DTO. A registered column is also a
 * function that returns its expression's own result, so options that convert
 * the projected value (`as`, `choices`) belong in a view.
 */
export interface DtoColumnOptions {
  collection?: boolean
  type?: keyof R4TypeOf
  default?: unknown
  enum?: readonly string[]
}

/** Data a DTO reads in addition to the projected resource. */
export interface DtoOptions {
  /**
   * Values owned by the DTO, with keys written with or without `%`. They apply
   * only to this DTO's column bodies, projected or called as functions.
   */
  env?: Readonly<Record<string, unknown>>
  /** Per-row bindings the columns read (EvaluateOptions.vars semantics; may reference per-call env). */
  vars?: Readonly<Record<string, AnyExpression | readonly TypedValue[]>>
  /**
   * Environment supplied by `project()`. Use names when only presence is known,
   * or declarations when columns and vars navigate through those values.
   */
  callerEnv?: readonly string[] | FhirpathTypeDeclarations
}

/**
 * One option as the columns see it. A record without literal keys, such as the
 * `DtoOptions` shape itself, declares nothing: its names are unknown either way.
 */
type OptionField<Options, Name extends keyof DtoOptions> = Options extends { readonly [K in Name]?: infer Value }
  ? string extends keyof Exclude<Value, undefined>
    ? EmptyFhirpathTypeContext
    : Exclude<Value, undefined>
  : EmptyFhirpathTypeContext

type CallerEnvTypes<Options> =
  OptionField<Options, 'callerEnv'> extends infer Declared
    ? Declared extends readonly string[]
      ? EmptyFhirpathTypeContext
      : Declared
    : never

/**
 * What a DTO's columns see: its own `env` and `vars`, the declared caller
 * environment, and the row variables `project()` binds. Runtime precedence is
 * the same: DTO values win over caller values, and row variables win over both.
 */
export type DtoContext<Options> = MergeFhirpathTypeContexts<
  FhirpathTypeContextOf<{
    env: OptionField<Options, 'env'>
    envTypes: CallerEnvTypes<Options>
    vars: OptionField<Options, 'vars'>
  }>,
  { env: { rowIndex: { type: 'System.Integer' }; rowTotal: { type: 'System.Integer' } } }
>

/**
 * The markers made so far for each class being collected. Keyed by class, so a
 * field initializer may collect another DTO meanwhile.
 */
const collecting = new Map<object, ColumnMarker[]>()

/** What `this.column()` returns while its class is collected; any other time it returns undefined. */
class ColumnMarker {
  readonly spec: ColumnSpec

  constructor(spec: ColumnSpec) {
    this.spec = spec
  }
}

/** The options a column of this kind accepts. */
type ColumnOptionsOf<Kind extends DtoKind> = Kind extends 'dto' ? DtoColumnOptions : ColumnOptions

/** The `pick` check applies to view columns, the only ones with `choices`. */
type KindConstraint<Kind extends DtoKind, Options> = Kind extends 'dto' ? unknown : PickConstraint<Options>

/**
 * The instance side of every DTO and view. `engine.defineDto()` and
 * `engine.defineView()` return a subclass bound to one engine, FHIR type, and
 * option set; declare columns as fields of a class extending it.
 */
export class DtoBase<
  Root extends string = string,
  Context extends object = EmptyFhirpathTypeContext,
  Kind extends DtoKind = DtoKind,
> {
  /** Type-only: keeps a view out of `register()`. Protected, so rows never show it. */
  declare protected readonly dtoKind: Kind

  /** The FHIR type the columns read. It lives on the prototype, so it is not one of a row's own keys. */
  get fhirType(): Root {
    return (this.constructor as unknown as { readonly fhirType: Root }).fhirType
  }

  /**
   * Declares one column: the expression it reads, relative to the class's
   * `fhirType`, plus the same options a `project()` column takes. Write it as a
   * field initializer; the field's type is inferred from the expression and the
   * DTO's `env`, `vars`, and `callerEnv`.
   */
  protected column<const Expr extends string>(path: Expr): ColumnResult<{ path: Expr }, Root, Context>
  protected column<const Expr extends string, const Options extends ColumnOptionsOf<Kind>>(
    path: Expr,
    options: Options & KindConstraint<Kind, Options>
  ): ColumnResult<{ path: Expr } & Options, Root, Context>
  protected column(path: string, options?: ColumnOptions): unknown {
    return mark(this, { path, ...options })
  }

  /**
   * Declares a Boolean criteria column. It uses `FhirPathEngine.test()` rules: one
   * Boolean returns itself, empty returns `false`, and several values are an
   * error. A registered criteria function keeps the same behavior.
   */
  protected criteria(expr: string): boolean {
    return mark(this, { test: expr }) as unknown as boolean
  }
}

/**
 * Records a column while its class is collected. A field initializer runs just
 * before the field is defined, so when the next column is declared the previous
 * marker must already sit in a field. Otherwise it went into a private field, a
 * nested value, or nowhere.
 */
function mark(instance: DtoBase, spec: ColumnSpec): ColumnMarker | undefined {
  const found = collecting.get(instance.constructor)
  if (found === undefined) {
    return undefined
  }
  assertLastMarkerStored(instance, found)
  const marker = new ColumnMarker(spec)
  found.push(marker)
  return marker
}

function assertLastMarkerStored(instance: object, found: readonly ColumnMarker[]): void {
  const last = found.at(-1)
  if (last !== undefined && !Object.values(instance).includes(last)) {
    const expression = 'test' in last.spec ? last.spec.test : last.spec.path
    throw new FhirPathTypeError(
      `DTO ${instance.constructor.name} declares the column '${expression}' outside a public field; ` +
        'write each column as `name = this.column(...)`'
    )
  }
}

/** A DTO or view class: an engine's `defineDto()`/`defineView()` base, or any class extending one. */
export type DtoClass = (new () => { readonly fhirType: string }) & { readonly fhirType: string }

/** The DTO instance type returned by projection, including getters and methods. */
export type DtoRow<C extends DtoClass> = InstanceType<C>

/**
 * The class `defineDto()`/`defineView()` returns: a base bound to one FHIR type
 * and its column context. `Fields` adds the columns of a class a function
 * builds on that base, for writing such a function's return type.
 */
export type DtoBaseClass<
  Root extends string,
  Context extends object,
  Fields extends object = object,
  Kind extends DtoKind = DtoKind,
> = (new () => DtoBase<Root, Context, Kind> & Fields) & {
  readonly fhirType: Root
}

/** The class a registered DTO is: every non-method instance field is a column. */
export type RegisteredDtoClass = (new () => { readonly fhirType: string } & DtoBase<string, object, 'dto'>) & {
  readonly fhirType: string
}

type NonColumnKey = 'fhirType'

/** A registered DTO's column names: its non-method instance fields. */
type ColumnNames<Instance> = {
  [Key in keyof Instance]: Key extends NonColumnKey
    ? never
    : Instance[Key] extends (...args: never[]) => unknown
      ? never
      : Key
}[keyof Instance] &
  string

/**
 * Type names by the TypeScript form of their values. Generic over the model maps
 * so they resolve only when a registered column needs them, and then once.
 */
type ElementlessTypeName<TypeOf, Elements> = Exclude<keyof TypeOf, keyof Elements>
type TypeNameHolding<TypeOf, Elements, Value> = {
  [Name in ElementlessTypeName<TypeOf, Elements>]: TypeOf[Name] extends Value ? Name : never
}[ElementlessTypeName<TypeOf, Elements>]
/** Model types an object value may be: every type with elements, and the System quantity. */
type ObjectTypeName<TypeOf, Elements> =
  | Extract<keyof Elements, keyof TypeOf>
  | Exclude<
      ElementlessTypeName<TypeOf, Elements>,
      TypeNameHolding<TypeOf, Elements, string | number | boolean | bigint>
    >

/** Marks a member no FHIR type represents, which makes the whole result undeclared. */
type Unmapped = '~unmapped'

/**
 * Every FHIR type whose TypeScript form is this value type. A TypeScript
 * `string` may be a FHIR `string`, `code`, `uri`, and more, so the answer is
 * their union: naming one of them would let `ofType()` drop a value the
 * runtime returns.
 */
type TypeNamesOf<Value, TypeOf = R4TypeOf, Elements = R4Elements> = Value extends string
  ? TypeNameHolding<TypeOf, Elements, string>
  : Value extends number
    ? TypeNameHolding<TypeOf, Elements, number>
    : Value extends boolean
      ? TypeNameHolding<TypeOf, Elements, boolean>
      : Value extends object
        ? {
            [Name in ObjectTypeName<TypeOf, Elements>]: [Value] extends [TypeOf[Name]]
              ? [TypeOf[Name]] extends [Value]
                ? Name
                : never
              : never
          }[ObjectTypeName<TypeOf, Elements>] extends infer Names extends string
          ? [Names] extends [never]
            ? Unmapped
            : Names
          : Unmapped
        : Unmapped

type ColumnElement<Value> = Value extends readonly (infer Item)[] ? Item : Value

/**
 * A column as the expression-defined function registration makes it. The body
 * text is not in the class type, so the declared result is all the call has; with
 * no result, the call stays opaque.
 */
type ColumnFunction<Root extends string, Value> = unknown extends Value
  ? OpaqueColumnFunction<Root>
  : TypeNamesOf<ColumnElement<Exclude<Value, null | undefined>>> extends infer Names extends string
    ? [Names] extends [never]
      ? OpaqueColumnFunction<Root>
      : Unmapped extends Names
        ? OpaqueColumnFunction<Root>
        : {
            readonly expression: string
            readonly signature: {
              readonly input: { readonly types: readonly [Root] }
              readonly result: { readonly types: readonly Names[] }
            }
          }
    : never

type OpaqueColumnFunction<Root extends string> = {
  readonly expression: string
  readonly signature: { readonly input: { readonly types: readonly [Root] } }
}

type DeclarationsNamed<Dtos extends readonly unknown[], Name extends string> = Dtos extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Head extends RegisteredDtoClass
    ? Name extends ColumnNames<InstanceType<Head>>
      ? [ColumnFunction<Head['fhirType'], InstanceType<Head>[Name]>, ...DeclarationsNamed<Tail, Name>]
      : DeclarationsNamed<Tail, Name>
    : DeclarationsNamed<Tail, Name>
  : []

/**
 * The FHIRPath functions a list of registered DTOs adds, in the shape
 * `EvaluateOptions.functions` declares: one per column name, with an overload
 * per DTO that declares it.
 */
type AllColumnNames<Dto> = Dto extends RegisteredDtoClass ? ColumnNames<InstanceType<Dto>> : never

type DeclarationList<Declaration> = Declaration extends { readonly overloads: infer List extends readonly unknown[] }
  ? List
  : readonly [Declaration]

/** Function declarations with more added: a name both declare becomes one overload list, as at runtime. */
type AddFunctionDeclarations<Existing, Added> = {
  readonly [Name in keyof Existing | keyof Added]: Name extends keyof Added
    ? Name extends keyof Existing
      ? { readonly overloads: readonly [...DeclarationList<Existing[Name]>, ...DeclarationList<Added[Name]>] }
      : Added[Name]
    : Name extends keyof Existing
      ? Existing[Name]
      : never
}

type FunctionsOption<Options> = Options extends { readonly functions?: infer Functions }
  ? Exclude<Functions, undefined>
  : EmptyFhirpathTypeContext

/**
 * The options type of the engine `register()` returns: the same options, with
 * each registered column added to `functions`. Keeping them there means a call
 * on an engine types exactly as a host function declared at construction.
 */
export type RegisteredOptions<Options, Added extends readonly unknown[]> = {
  readonly [Key in keyof Options | 'functions']: Key extends 'functions'
    ? AddFunctionDeclarations<FunctionsOption<Options>, DtoFunctions<Added>>
    : Key extends keyof Options
      ? Options[Key]
      : never
}

export type DtoFunctions<Dtos extends readonly unknown[]> = {
  readonly [Name in AllColumnNames<Dtos[number]>]: DeclarationsNamed<Dtos, Name> extends readonly [infer Only]
    ? Only
    : { readonly overloads: DeclarationsNamed<Dtos, Name> }
}

/** Everything a DTO class was declared with; `project()`, the engine, and `analyzeDto` all read it from here. */
export interface DtoDefinition {
  /** The engine whose `defineDto()`/`defineView()` created the base. */
  readonly engine: FhirPathEngine
  readonly kind: DtoKind
  readonly fhirType: string
  /** A column always records an object form, so a consumer never has to handle the plain-string column. */
  readonly columns: Readonly<Record<string, ColumnSpec>>
  /** The DTO's own environment values, with bare names. */
  readonly env: Record<string, unknown> | undefined
  readonly vars: Record<string, AnyExpression | readonly TypedValue[]> | undefined
  /** Env names the projecting call supplies (see DtoOptions.callerEnv). */
  readonly callerEnvNames: readonly string[]
  /** Static types for the caller environment, when declared. */
  readonly callerEnvTypes: FhirpathTypeDeclarations | undefined
}

type DtoBaseDefinition = Omit<DtoDefinition, 'columns'>

/** The normalized options a `defineDto()` base was created with. */
const bases = new WeakMap<object, DtoBaseDefinition>()

/** Definitions already collected, keyed by the DTO class. */
const definitions = new WeakMap<object, DtoDefinition>()

/**
 * Creates the base class behind `engine.defineDto()` and `engine.defineView()`.
 * The type becomes the context for relative column paths, and the options
 * become the variables the columns can read. The engine's own env names are
 * refused as `callerEnv`, because a per-call value may not replace them.
 */
export function createDtoBase(
  engine: FhirPathEngine,
  kind: DtoKind,
  fhirType: string,
  options: DtoOptions = {}
): DtoBaseClass<string, object> {
  const base = class extends DtoBase {}
  // A readable name for project()/registration errors; a subclass replaces it.
  Object.defineProperty(base, 'name', { value: `${fhirType}${kind === 'dto' ? 'Dto' : 'View'}` })
  Object.defineProperty(base, 'fhirType', { value: fhirType, enumerable: true })
  bases.set(base, baseDefinition(engine, kind, fhirType, options))
  return base as unknown as DtoBaseClass<string, object>
}

/** Checks and normalizes the options once, when the base is created. */
function baseDefinition(
  engine: FhirPathEngine,
  kind: DtoKind,
  fhirType: string,
  options: DtoOptions
): DtoBaseDefinition {
  const call = `${kind === 'dto' ? 'defineDto' : 'defineView'}('${fhirType}')`
  const { env, vars, callerEnv } = options
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
    throw new FhirPathTypeError(`${call}: 'env' must be a record of variables, the same shape as EvaluateOptions.env`)
  }
  const normalizedEnv = env === undefined ? undefined : normalizeEnvKeys(env)
  const callerEnvIsNames = isCallerEnvNames(callerEnv)
  const callerEnvNames = (callerEnvIsNames ? callerEnv : Object.keys(callerEnv ?? {})).map(bareEnvironmentName)
  // The DTO's own value always wins, so a caller value under the same name would never be read.
  const shadowed = callerEnvNames.find(name => normalizedEnv !== undefined && Object.hasOwn(normalizedEnv, name))
  if (shadowed !== undefined) {
    throw new FhirPathTypeError(`${call}: callerEnv names '${shadowed}', which the DTO's own env already binds`)
  }
  const engineEnv = normalizeEnvKeys(engine.defaults.env)
  const engineOwned = callerEnvNames.find(name => Object.hasOwn(engineEnv, name))
  if (engineOwned !== undefined) {
    throw new FhirPathTypeError(
      `${call}: callerEnv names '${engineOwned}', which the engine's env binds; a projection may not replace it`
    )
  }
  return {
    engine,
    kind,
    fhirType,
    env: normalizedEnv !== undefined && Object.keys(normalizedEnv).length > 0 ? normalizedEnv : undefined,
    vars,
    callerEnvNames,
    callerEnvTypes: callerEnvIsNames ? undefined : callerEnv,
  }
}

function isCallerEnvNames(
  callerEnv: readonly string[] | FhirpathTypeDeclarations | undefined
): callerEnv is readonly string[] {
  return Array.isArray(callerEnv)
}

/** The engine-created base a class descends from, with the options it fixed. */
function baseOf(cls: object): DtoBaseDefinition | undefined {
  for (let current: unknown = cls; typeof current === 'function'; current = Object.getPrototypeOf(current)) {
    const base = bases.get(current)
    if (base !== undefined) {
      return base
    }
  }
  return undefined
}

/**
 * Whether a value is a DTO or view class — a base an engine created, or a
 * subclass of one. Lets tooling pick the DTOs out of a module's exports (see the
 * `fhirpath-check` CLI) without instantiating anything that is not one.
 */
export function isDtoClass(value: unknown): value is DtoClass {
  return typeof value === 'function' && baseOf(value) !== undefined
}

/**
 * Collects and caches a DTO's type, columns, environment, variables, and caller
 * environment names. Columns are read by constructing the class once: each
 * `this.column()` initializer leaves a marker in its field.
 */
export function dtoDefinition(cls: DtoClass): DtoDefinition {
  const cached = definitions.get(cls)
  if (cached !== undefined) {
    return cached
  }
  const base = baseOf(cls)
  if (base === undefined) {
    throw new FhirPathTypeError(
      `${cls.name || 'The class'} is not a DTO class; extend engine.defineDto('<fhirType>') or engine.defineView('<fhirType>')`
    )
  }
  const found: ColumnMarker[] = []
  collecting.set(cls, found)
  let instance: object
  try {
    instance = new cls()
  } finally {
    collecting.delete(cls)
  }
  assertLastMarkerStored(instance, found)
  const columns: Record<string, ColumnSpec> = {}
  for (const [name, value] of Object.entries(instance)) {
    if (value instanceof ColumnMarker) {
      columns[name] = value.spec
    }
  }
  if (Object.keys(columns).length === 0) {
    throw new FhirPathTypeError(`DTO ${cls.name} declares no columns; add a field such as \`id = this.column('id')\``)
  }
  // TypeScript rejects a field that shadows the fhirType accessor; transpile-only code reaches this.
  if ('fhirType' in columns) {
    throw new FhirPathTypeError(`DTO ${cls.name} declares a column named 'fhirType', which every row already carries`)
  }
  if (base.kind === 'dto') {
    const converted = Object.entries(columns).find(([, spec]) => 'as' in spec || 'choices' in spec)
    if (converted !== undefined) {
      throw new FhirPathTypeError(
        `DTO ${cls.name} column '${converted[0]}' converts its value with 'as' or 'choices'; ` +
          'a registered column returns its expression result, so convert values in a view'
      )
    }
  }
  const definition: DtoDefinition = { ...base, columns }
  definitions.set(cls, definition)
  return definition
}

/**
 * Checks that a class can be registered: a DTO rather than a view, holding only
 * columns and methods. The engine's types read every non-method field of a
 * registered DTO as a column, so a getter or a plain field would claim a
 * function that does not exist.
 */
export function assertRegistrable(cls: DtoClass): DtoDefinition {
  const definition = dtoDefinition(cls)
  if (definition.kind === 'view') {
    throw new FhirPathTypeError(`${cls.name} is a view; only classes from engine.defineDto() can be registered`)
  }
  const plain = Object.keys(new cls()).find(name => !Object.hasOwn(definition.columns, name))
  if (plain !== undefined) {
    throw new FhirPathTypeError(
      `DTO ${cls.name} has a field '${plain}' that is not a column; a registered DTO holds only columns and methods`
    )
  }
  for (
    let current: unknown = cls.prototype;
    current !== DtoBase.prototype && current !== null;
    current = Object.getPrototypeOf(current)
  ) {
    const getter = Object.entries(Object.getOwnPropertyDescriptors(current)).find(
      ([name, descriptor]) => name !== 'fhirType' && (descriptor.get !== undefined || descriptor.set !== undefined)
    )
    if (getter !== undefined) {
      throw new FhirPathTypeError(
        `DTO ${cls.name} has an accessor '${getter[0]}'; a registered DTO holds only columns and methods, so move it to a view`
      )
    }
  }
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
 * Merges DTO options with call options. DTO values win, so projected and
 * registered columns read the same environment, and a column's inferred type
 * cannot be changed by a caller's variable of the same name.
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
    // DTO vars keep their declaration order; a caller var adds only names the DTO leaves free.
    const own = normalizeEnvKeys(vars)
    merged.vars = {
      ...own,
      ...Object.fromEntries(
        Object.entries(normalizeEnvKeys(options?.vars)).filter(([name]) => !Object.hasOwn(own, name))
      ),
    }
  }
  return merged
}
