import '../functions/install.ts'

import { bareEnvironmentName, mergeEnvKeys, normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import { functions as builtinFunctions } from '../functions/registry.ts'
import type { ModelProvider } from '../model/provider.ts'
import type {
  EmptyFhirpathTypeContext,
  FhirpathTypeContextOf,
  FhirpathTypeDeclarations,
  FhirTypeName,
  MergeFhirpathTypeContexts,
} from '../typed/infer.ts'
import { canonicalFocusType, typesOverlap } from '../values/type-compat.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { toSubjects } from './bundle.ts'
import { columnSignature, criteriaSignature } from './column-signature.ts'
import type { AnyExpression, Compiler, CustomFunction, EvaluateOptions, SingleCustomFunction } from './compile.ts'
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

/**
 * The instance side of every DTO. `defineDto()` returns a subclass bound to one
 * FHIR type and option set; declare columns as fields of a class extending it.
 */
export class DtoBase<Root extends string = string, Context extends object = EmptyFhirpathTypeContext> {
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
  protected column<const Expr extends string, const Options extends ColumnOptions>(
    path: Expr,
    options: Options & PickConstraint<Options>
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

/** A DTO class: a `defineDto()` base, or any class extending one. */
export type DtoClass = (new () => { readonly fhirType: string }) & { readonly fhirType: string }

/** The DTO instance type returned by projection, including getters and methods. */
export type DtoRow<C extends DtoClass> = InstanceType<C>

/**
 * The class `defineDto()` returns: a DTO base bound to one FHIR type and its
 * column context. `Fields` adds the columns of a class a function builds on
 * that base, for writing such a function's return type.
 */
export type DtoBaseClass<
  Root extends string,
  Context extends object,
  Fields extends object = object,
> = (new () => DtoBase<Root, Context> & Fields) & {
  readonly fhirType: Root
}

/** Everything a DTO class was declared with; `project()`, the engine, and `analyzeDto` all read it from here. */
export interface DtoDefinition {
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
 * Creates a DTO base for one FHIR resource or datatype. The type becomes the
 * context for relative column paths, and the options become the variables the
 * columns can read. Subclasses add column fields, getters, and methods.
 */
export function defineDto<const Root extends FhirTypeName, const Options extends DtoOptions = EmptyFhirpathTypeContext>(
  fhirType: Root,
  options?: Options
): DtoBaseClass<Root, DtoContext<Options>> {
  const base = class extends DtoBase<Root> {}
  // A readable name for project()/registration errors; a subclass replaces it.
  Object.defineProperty(base, 'name', { value: `${fhirType}Dto` })
  Object.defineProperty(base, 'fhirType', { value: fhirType, enumerable: true })
  bases.set(base, baseDefinition(fhirType, options ?? {}))
  return base as unknown as DtoBaseClass<Root, DtoContext<Options>>
}

/** Checks and normalizes `defineDto()` options once, when the base is created. */
function baseDefinition(fhirType: string, options: DtoOptions): DtoBaseDefinition {
  const { env, vars, callerEnv } = options
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
    throw new FhirPathTypeError(
      `defineDto('${fhirType}'): 'env' must be a record of variables, the same shape as EvaluateOptions.env`
    )
  }
  const normalizedEnv = env === undefined ? undefined : normalizeEnvKeys(env)
  const callerEnvIsNames = isCallerEnvNames(callerEnv)
  const callerEnvNames = (callerEnvIsNames ? callerEnv : Object.keys(callerEnv ?? {})).map(bareEnvironmentName)
  // The DTO's own value always wins, so a caller value under the same name would never be read.
  const shadowed = callerEnvNames.find(name => normalizedEnv !== undefined && Object.hasOwn(normalizedEnv, name))
  if (shadowed !== undefined) {
    throw new FhirPathTypeError(
      `defineDto('${fhirType}'): callerEnv names '${shadowed}', which the DTO's own env already binds`
    )
  }
  return {
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

/** The `defineDto()` base a class descends from, with the options it fixed. */
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
 * Whether a value is a DTO class — one `defineDto()` produced, or a subclass of
 * one. Lets tooling pick the DTOs out of a module's exports (see the
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
      `${cls.name || 'The class'} is not a DTO class; extend defineDto('<fhirType>') to declare one`
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
  const definition: DtoDefinition = { ...base, columns }
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
