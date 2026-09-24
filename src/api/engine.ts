import { mergeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type {
  EmptyFhirpathTypeContext,
  FhirpathInput,
  FhirpathResultForContext,
  FhirpathRootOf,
  FhirpathTypeContextOf,
  FhirTypeName,
  MergeFhirpathTypeContexts,
} from '../typed/infer.ts'
import { criteriaBoolean } from '../values/collection.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { type BundleLike, isBundle, normalizeInput, toSubjects } from './bundle.ts'
import {
  type AnyExpression,
  CompiledExpression,
  type Compiler,
  createCachedCompiler,
  type CustomFunction,
  type Declaring,
  type EvaluateOptions,
  type SingleCustomFunction,
} from './compile.ts'
import { type ConstraintCheckResult, evaluateConstraints, type FhirConstraint } from './constraints.ts'
import {
  assertInputMatchesDto,
  assertRegistrable,
  createDtoBase,
  type DtoBaseClass,
  dtoCallOptions,
  type DtoClass,
  type DtoContext,
  dtoDefinition,
  type DtoOptions,
  type RegisteredDtoClass,
  type RegisteredOptions,
  withDtos,
} from './dto.ts'
import { type Projection, type ProjectionColumns, projectRows } from './project.ts'

/**
 * What engine methods accept as input: one resource, an array of resources, or a
 * Bundle — a Bundle behaves as its entry resources unless the expression
 * references `Bundle` in root position (then it addresses the bundle itself).
 * An expression that starts at a bare Bundle element (`entry.count()`, `type`)
 * is ambiguous and throws. Wrap a Bundle in an array (`[bundle]`) to force
 * treating it as one resource.
 */
export type EngineInput<Expr extends string = string> = FhirpathInput<Expr> | readonly unknown[] | BundleLike

/** Per-call options that declare a result type when inference returns `unknown`. Runtime code ignores `type`. */
export type TypedEvaluateOptions<T extends keyof R4TypeOf> = EvaluateOptions & { type: T }

/** Literal text or a compatible compiled expression accepted by engine evaluation methods. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- engine methods infer their own input and result
export type EngineExpression<Expr extends string> = Expr | CompiledExpression<Expr, any, any, any>

/**
 * evaluate() reaches this shape through normalizeInput(), while project()
 * reaches it through toSubjects(). A bare Bundle is expression-dependent or
 * expands to heterogeneous entries, so it stays opaque; an array keeps each
 * item raw, including a Bundle deliberately wrapped as `[bundle]`.
 */
export type EngineInputRoot<Input> = Input extends readonly (infer Item)[]
  ? FhirpathRootOf<Item>
  : Input extends { readonly resourceType: 'Bundle' }
    ? 'opaque'
    : FhirpathRootOf<Input>

/** The inferred result returned by an engine or bound expression call. */
export type EngineResult<Expr extends string, Input, Defaults, Options> = FhirpathResultForContext<
  Expr,
  EngineInputRoot<Input>,
  MergeFhirpathTypeContexts<FhirpathTypeContextOf<Defaults>, FhirpathTypeContextOf<Options>>
>

/** The merged static declarations visible while project() evaluates a row. */
export type EngineProjectionContext<Defaults, Options> = MergeFhirpathTypeContexts<
  MergeFhirpathTypeContexts<FhirpathTypeContextOf<Defaults>, FhirpathTypeContextOf<Options>>,
  {
    env: {
      rowIndex: { type: 'System.Integer' }
      rowTotal: { type: 'System.Integer' }
    }
  }
>

/** The inferred row returned by project(), including its built-in row variables. */
export type EngineProjection<Columns extends ProjectionColumns, Input, Defaults, Options> = Projection<
  Columns,
  EngineInputRoot<Input>,
  EngineProjectionContext<Defaults, Options>
>

/** What columns of a DTO or view defined on an engine see: the engine's context, then the DTO's own. */
export type EngineDtoContext<Defaults, Options> = MergeFhirpathTypeContexts<
  EngineColumnContext<FhirpathTypeContextOf<Defaults>>,
  DtoContext<Options>
>

/**
 * The engine declarations a column body can rely on: env, which its definition
 * fixes, and functions. Engine `vars` are left out: they are evaluated against
 * the caller's root, which is another resource when a registered column is
 * called mid-expression.
 */
type EngineColumnContext<Context> = Context extends { env: infer Env; functions: infer Functions }
  ? { env: Env; vars: EmptyFhirpathTypeContext; functions: Functions }
  : never

/**
 * The base class `engine.defineView(root, options)` returns, with `Fields` for
 * the columns a function adds on top. Write it as the return type of a function
 * that builds a shared view base, when exported classes extend its result and
 * the project emits declarations.
 */
export type ViewBaseClass<
  Engine,
  Root extends string,
  Options = EmptyFhirpathTypeContext,
  Fields extends object = object,
> =
  Engine extends FhirPathEngine<infer Defaults>
    ? DtoBaseClass<Root, EngineDtoContext<Defaults, Options>, Fields, 'view'>
    : never

/** The function names an engine's options bind. */
type BoundFunctionNames<Defaults> = Defaults extends { readonly functions?: infer Functions }
  ? string extends keyof Exclude<Functions, undefined>
    ? never
    : keyof Exclude<Functions, undefined> & string
  : never

/**
 * Per-call options for projecting a DTO or view. A function the engine binds
 * cannot be replaced, because the columns' types were inferred from it.
 */
export type DtoProjectOptions<Defaults> = Omit<EvaluateOptions, 'functions'> & {
  functions?: EvaluateOptions['functions'] & { readonly [Name in BoundFunctionNames<Defaults>]?: never }
}

/** Engines created during the current recording session. */
let session: FhirPathEngine[] | undefined

/**
 * Records engines created while project modules are imported. Call the returned
 * function to close the session and read its engines. Only one session is active
 * at a time, and closing it releases the recorded engine references.
 */
export function recordEngines(): () => readonly FhirPathEngine[] {
  const open: FhirPathEngine[] = []
  session = open
  return () => {
    if (session === open) {
      session = undefined
    }
    return open
  }
}

function recordEngine(engine: FhirPathEngine): void {
  session?.push(engine)
}

/**
 * What a `FhirPathEngine` takes at construction: the `EvaluateOptions` it binds
 * as per-call defaults, plus settings that belong to the engine itself.
 */
export interface EngineOptions extends EvaluateOptions {
  /**
   * Max number of distinct expression texts this engine keeps parsed, in its own
   * LRU (not shared with other engines or the free `evaluate()`). Defaults to 500;
   * 0 disables reuse. Expressions passed via `compile()` bypass it.
   *
   * Read once, at construction: unlike the `EvaluateOptions` fields, this is not
   * part of `defaults` and a per-call `options` argument cannot change it.
   */
  cacheSize?: number
}

/** Passed by `register()` to the engine it derives. */
interface Derivation {
  parent: FhirPathEngine
  dtos: readonly DtoClass[]
  compile: Compiler
}

/** Set only while `register()` constructs a derived engine. */
let deriving: Derivation | undefined

/**
 * A FHIRPath engine with shared model and evaluation defaults. Per-call values
 * replace defaults, while `env`, `vars`, and `functions` merge by name. Keep an
 * engine for reuse because its parse cache is private to that instance.
 */
export class FhirPathEngine<const Defaults extends object = EmptyFhirpathTypeContext> {
  /** The per-call options bound at construction, with registered DTO columns in `functions`. */
  readonly defaults: EvaluateOptions
  /**
   * The DTO classes registered on this engine and the engines it derives from,
   * in order. Kept so tooling can check them against this engine's own model,
   * functions and env — see `analyzeEngineDtos` in `fhirpath-ts/analyzer`.
   */
  readonly dtos: readonly DtoClass[]
  /** The engine `register()` derived this one from. */
  private readonly parent: FhirPathEngine | undefined
  /** The options this engine was built from, which a derived engine reuses. */
  private readonly options: EngineOptions
  private readonly compileCached: Compiler

  constructor(options: Declaring<Defaults, EngineOptions> = {} as Declaring<Defaults, EngineOptions>) {
    const derivation = deriving
    deriving = undefined
    const { cacheSize, ...defaults } = options
    this.options = options
    this.parent = derivation?.parent
    // A derived engine shares its parent's parse cache, since its options are the same.
    this.compileCached = derivation?.compile ?? createCachedCompiler(cacheSize)
    this.dtos = derivation?.dtos ?? []
    this.defaults = this.precompiled(withDtos(defaults as EvaluateOptions, this.dtos, this.compileCached))
    recordEngine(this.untyped())
  }

  /**
   * Returns a new engine with each DTO's columns added as FHIRPath functions.
   * This engine does not change. Each DTO must come from `defineDto()` on this
   * engine or one it derives from, and hold only columns and methods.
   */
  register<const Added extends readonly RegisteredDtoClass[]>(
    ...dtos: Added
  ): FhirPathEngine<RegisteredOptions<Defaults, Added>> {
    for (const dto of dtos) {
      if (!this.derivesFrom(assertRegistrable(dto).engine)) {
        throw new FhirPathTypeError(
          `${dto.name} was defined on another engine; register it on the engine whose defineDto() created it, or on one derived from that engine`
        )
      }
    }
    deriving = { parent: this.untyped(), dtos: [...this.dtos, ...dtos], compile: this.compileCached }
    return new FhirPathEngine(this.options) as unknown as FhirPathEngine<RegisteredOptions<Defaults, Added>>
  }

  /**
   * Defines a DTO base for one FHIR type. Columns infer against this engine's
   * env, typed functions, and registered DTOs, then the DTO's own options.
   * Pass the class to `register()` to call its columns from any expression.
   */
  defineDto<const Root extends FhirTypeName, const Options extends DtoOptions = EmptyFhirpathTypeContext>(
    fhirType: Root,
    options?: Options
  ): DtoBaseClass<Root, EngineDtoContext<Defaults, Options>, object, 'dto'> {
    return createDtoBase(this.untyped(), 'dto', fhirType, options) as unknown as DtoBaseClass<
      Root,
      EngineDtoContext<Defaults, Options>,
      object,
      'dto'
    >
  }

  /**
   * Defines a view base for one FHIR type: a projected row that may also hold
   * getters, methods, and plain fields. Columns infer like `defineDto()` columns
   * and may convert values with `as` or `choices`.
   */
  defineView<const Root extends FhirTypeName, const Options extends DtoOptions = EmptyFhirpathTypeContext>(
    fhirType: Root,
    options?: Options
  ): DtoBaseClass<Root, EngineDtoContext<Defaults, Options>, object, 'view'> {
    return createDtoBase(this.untyped(), 'view', fhirType, options) as unknown as DtoBaseClass<
      Root,
      EngineDtoContext<Defaults, Options>,
      object,
      'view'
    >
  }

  /**
   * This engine without its declaration types. Relating two engine types makes
   * TypeScript compare every member, so internal bookkeeping stores this form.
   */
  private untyped(): FhirPathEngine {
    return this as unknown as FhirPathEngine
  }

  /** Whether this engine is `engine` or was derived from it through `register()`. */
  private derivesFrom(engine: FhirPathEngine): boolean {
    for (let current: FhirPathEngine | undefined = this.untyped(); current !== undefined; current = current.parent) {
      if (current === engine) {
        return true
      }
    }
    return false
  }

  /** Compile (LRU-cached by expression text) and evaluate in one call; typed like `compile().evaluate()`. */
  evaluate<const Expr extends string, T extends keyof R4TypeOf>(
    expression: EngineExpression<Expr>,
    input: EngineInput<Expr> | undefined,
    options: TypedEvaluateOptions<T>
  ): R4TypeOf[T][]
  evaluate<
    const Expr extends string,
    const Input extends EngineInput<Expr> | undefined = undefined,
    const Options extends object = EmptyFhirpathTypeContext,
  >(
    expression: EngineExpression<Expr>,
    input?: Input,
    options?: Declaring<Options>
  ): EngineResult<Expr, Input, Defaults, Options>
  evaluate(expression: AnyExpression, input?: unknown, options?: EvaluateOptions): unknown[] {
    const compiled = this.compileCached(expression)
    const merged = this.merged(options)
    return compiled.evaluate(normalizeInput(input, compiled.ast, merged.model), merged)
  }

  /** Like `evaluate()`, keeping the internal typed representation (types, Decimal, Temporal). */
  evaluateTyped(expression: AnyExpression, input?: unknown, options?: EvaluateOptions): TypedValue[] {
    const compiled = this.compileCached(expression)
    const merged = this.merged(options)
    return compiled.evaluateTyped(normalizeInput(input, compiled.ast, merged.model), merged)
  }

  /** Parse once for reuse, with this engine's defaults bound. Does not touch the parse cache. */
  compile<const Expr extends string>(expression: Expr): BoundExpression<Expr, Defaults> {
    return new BoundExpression(this, new CompiledExpression(expression))
  }

  /** The first result, or undefined when the expression comes up empty. */
  first<const Expr extends string, T extends keyof R4TypeOf>(
    expression: EngineExpression<Expr>,
    input: EngineInput<Expr> | undefined,
    options: TypedEvaluateOptions<T>
  ): R4TypeOf[T] | undefined
  first<
    const Expr extends string,
    const Input extends EngineInput<Expr> | undefined = undefined,
    const Options extends object = EmptyFhirpathTypeContext,
  >(
    expression: EngineExpression<Expr>,
    input?: Input,
    options?: Declaring<Options>
  ): EngineResult<Expr, Input, Defaults, Options>[number] | undefined
  first(expression: AnyExpression, input?: unknown, options?: EvaluateOptions): unknown {
    return this.evaluate(expression, input, options)[0]
  }

  /**
   * Boolean criteria evaluation, the semantics FHIR invariants, Subscription
   * criteria, and `enableWhen` share. A single boolean returns itself, a single
   * non-boolean item returns true, and more than one item is an error, which is
   * spec §4.5 singleton evaluation. Empty returns false, which is the criteria
   * convention layered on top of it; see `criteriaBoolean`.
   */
  test(input: unknown, expression: AnyExpression, options?: EvaluateOptions): boolean {
    return criteriaBoolean(this.evaluateTyped(expression, input, options))
  }

  /**
   * The items (or Bundle entry resources) whose criteria hold, by `test()`
   * semantics. Criteria run against each item directly — not via `test()` — so
   * an item that is itself a Bundle is not unwrapped again.
   */
  filter<T>(input: readonly T[], expression: AnyExpression, options?: EvaluateOptions): T[]
  filter(input: BundleLike, expression: AnyExpression, options?: EvaluateOptions): unknown[]
  filter(input: readonly unknown[] | BundleLike, expression: AnyExpression, options?: EvaluateOptions): unknown[] {
    const compiled = this.compileCached(expression)
    const merged = this.merged(options)
    return toSubjects(input)
      .map(subject => subject.value)
      .filter(value => criteriaBoolean(compiled.evaluateTyped(value, merged)))
  }

  /**
   * Projects each resource into a flat row. Columns return one optional value
   * unless `collection: true` is set. `%rowIndex` and `%rowTotal` are available
   * in every column. All columns compile before any row is read.
   */
  project<C extends DtoClass>(
    input: readonly unknown[] | BundleLike,
    dto: C,
    options?: DtoProjectOptions<Defaults>
  ): InstanceType<C>[]
  project<C extends DtoClass>(input: unknown, dto: C, options?: DtoProjectOptions<Defaults>): InstanceType<C>
  project<
    const Input extends readonly unknown[] | BundleLike,
    const Columns extends ProjectionColumns,
    const Options extends object = EmptyFhirpathTypeContext,
  >(input: Input, columns: Columns, options?: Declaring<Options>): EngineProjection<Columns, Input, Defaults, Options>[]
  project<
    const Input,
    const Columns extends ProjectionColumns,
    const Options extends object = EmptyFhirpathTypeContext,
  >(input: Input, columns: Columns, options?: Declaring<Options>): EngineProjection<Columns, Input, Defaults, Options>
  project(input: unknown, columns: ProjectionColumns | DtoClass, options?: EvaluateOptions): unknown {
    if (typeof columns === 'function') {
      this.assertProjectable(columns, options)
      assertInputMatchesDto(input, columns)
    }
    const rows =
      typeof columns === 'function'
        ? projectRows(
            input,
            dtoDefinition(columns).columns,
            this.merged(dtoCallOptions(columns, options)),
            this.compileCached
          )
            // Materialize each row as a class instance, so the DTO's own methods
            // and getters see the projected values.
            .map(row => Object.assign(new columns(), row))
        : projectRows(input, columns, this.merged(options), this.compileCached)
    return Array.isArray(input) || isBundle(input) ? rows : rows[0]
  }

  /**
   * Evaluates FHIR constraint expressions. Arrays and Bundles add the resource
   * index to each issue. Expression errors become failed issues. This is not full
   * profile validation.
   */
  checkConstraints(
    input: unknown,
    constraints: readonly FhirConstraint[],
    options?: EvaluateOptions
  ): ConstraintCheckResult {
    return evaluateConstraints(input, constraints, this.merged(options), this.compileCached)
  }

  /**
   * A DTO projects on the engine that defined it or one derived from it, and a
   * per-call option may not replace a function the engine binds: the columns'
   * types came from the engine's own declarations.
   */
  private assertProjectable(dto: DtoClass, options: EvaluateOptions | undefined): void {
    const { engine } = dtoDefinition(dto)
    if (!this.derivesFrom(engine)) {
      throw new FhirPathTypeError(
        `project(): ${dto.name} was defined on another engine; project it with that engine or one derived from it`
      )
    }
    const bound = this.defaults.functions ?? {}
    const replaced = Object.keys(options?.functions ?? {})
      .filter(name => Object.hasOwn(bound, name))
      .map(name => `functions.${name}`)
    if (replaced.length > 0) {
      throw new FhirPathTypeError(
        `project(): ${replaced.join(', ')} would replace a name the engine binds, which ${dto.name}'s column types rely on`
      )
    }
  }

  /**
   * Replaces scalar defaults and merges `env`, `vars`, and `functions` by name.
   * Per-call entries win. Environment keys are normalized with or without `%`.
   */
  private merged(options?: EvaluateOptions): EvaluateOptions {
    if (!options) {
      return this.defaults
    }
    const precompiled = this.precompiled(options)
    const merged = { ...this.defaults, ...precompiled }
    if (this.defaults.env && precompiled.env) {
      merged.env = mergeEnvKeys(this.defaults.env, precompiled.env)
    }
    if (this.defaults.vars && precompiled.vars) {
      merged.vars = mergeEnvKeys(this.defaults.vars, precompiled.vars)
    }
    if (this.defaults.functions && precompiled.functions) {
      merged.functions = { ...this.defaults.functions, ...precompiled.functions }
    }
    return merged
  }

  /**
   * `vars` expressions and expression-function bodies given as strings parse
   * through this engine's LRU here, once per call at most — so per-row
   * evaluation inside project() never re-parses them.
   */
  private precompiled(options: EvaluateOptions): EvaluateOptions {
    const out = { ...options }
    if (options.vars) {
      out.vars = Object.fromEntries(
        Object.entries(options.vars).map(([name, value]) => [
          name,
          typeof value === 'string' ? this.compileCached(value) : value,
        ])
      )
    }
    if (options.functions) {
      out.functions = Object.fromEntries(
        Object.entries(options.functions).map(([name, fn]) => [name, this.precompiledFunction(fn)])
      )
    }
    return out
  }

  /** One entry of `functions`, with any string body parsed — reaching into an overload set for each member. */
  private precompiledFunction(fn: CustomFunction): CustomFunction {
    return 'overloads' in fn
      ? { overloads: fn.overloads.map(overload => this.precompiledBody(overload)) }
      : this.precompiledBody(fn)
  }

  private precompiledBody(fn: SingleCustomFunction): SingleCustomFunction {
    return 'expression' in fn && typeof fn.expression === 'string'
      ? { ...fn, expression: this.compileCached(fn.expression) }
      : fn
  }
}

/** A compiled expression carrying an engine's defaults, so `evaluate(input)` needs nothing else. */
export class BoundExpression<Expr extends string = string, Defaults extends object = EmptyFhirpathTypeContext> {
  readonly expression: CompiledExpression<Expr>
  private readonly engine: FhirPathEngine<Defaults>

  constructor(engine: FhirPathEngine<Defaults>, expression: CompiledExpression<Expr>) {
    this.engine = engine
    this.expression = expression
  }

  get source(): Expr {
    return this.expression.source
  }

  evaluate<T extends keyof R4TypeOf>(
    input: EngineInput<Expr> | undefined,
    options: TypedEvaluateOptions<T>
  ): R4TypeOf[T][]
  evaluate<
    const Input extends EngineInput<Expr> | undefined = undefined,
    const Options extends object = EmptyFhirpathTypeContext,
  >(input?: Input, options?: Declaring<Options>): EngineResult<Expr, Input, Defaults, Options>
  evaluate(input?: EngineInput<Expr>, options?: EvaluateOptions): unknown {
    return this.engine.evaluate(this.expression, input, options)
  }

  evaluateTyped(input?: unknown, options?: EvaluateOptions): TypedValue[] {
    return this.engine.evaluateTyped(this.expression, input, options)
  }

  first<T extends keyof R4TypeOf>(
    input: EngineInput<Expr> | undefined,
    options: TypedEvaluateOptions<T>
  ): R4TypeOf[T] | undefined
  first<
    const Input extends EngineInput<Expr> | undefined = undefined,
    const Options extends object = EmptyFhirpathTypeContext,
  >(input?: Input, options?: Declaring<Options>): EngineResult<Expr, Input, Defaults, Options>[number] | undefined
  first(input?: EngineInput<Expr>, options?: EvaluateOptions): unknown {
    return this.engine.first(this.expression, input, options)
  }

  test(input: unknown, options?: EvaluateOptions): boolean {
    return this.engine.test(input, this.expression, options)
  }

  /** The canonical form of the expression. */
  toString(): string {
    return this.expression.toString()
  }
}
