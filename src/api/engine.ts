import { mergeEnvKeys } from '../engine/context.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type {
  EmptyFhirpathTypeContext,
  FhirpathInput,
  FhirpathResultForContext,
  FhirpathRootOf,
  FhirpathTypeContextOf,
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
import { assertInputMatchesDto, dtoCallOptions, type DtoClass, dtoDefinition, withDtos } from './dto.ts'
import { type Projection, type ProjectionColumns, type ProjectionTypeContext, projectRows } from './project.ts'

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
export type EngineProjectionContext<Defaults, Options> = ProjectionTypeContext<
  MergeFhirpathTypeContexts<FhirpathTypeContextOf<Defaults>, FhirpathTypeContextOf<Options>>
>

/** The inferred row returned by project(), including its built-in row variables. */
export type EngineProjection<Columns extends ProjectionColumns, Input, Defaults, Options> = Projection<
  Columns,
  EngineInputRoot<Input>,
  EngineProjectionContext<Defaults, Options>
>

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
  /**
   * DTOs whose columns become typed FHIRPath functions. Registration requires a
   * model and publishes every column name, but it does not publish DTO `env` or
   * `vars`. Same-name columns are allowed only when their input types do not
   * overlap. See `docs/api.md#registering-dto-columns-as-functions`.
   */
  resourceDtos?: readonly DtoClass[]
}

/**
 * A FHIRPath engine with shared model and evaluation defaults. Per-call values
 * replace defaults, while `env`, `vars`, and `functions` merge by name. Keep an
 * engine for reuse because its parse cache is private to that instance.
 */
export class FhirPathEngine<const Defaults extends EngineOptions = EmptyFhirpathTypeContext> {
  /** The per-call options bound at construction; engine-only settings are not part of them. */
  readonly defaults: EvaluateOptions
  /**
   * The DTO classes registered at construction (EngineOptions.resourceDtos), in
   * order. Kept so tooling can check them against this engine's own model,
   * functions and env — see `analyzeEngineDtos` in `fhirpath-ts/analyzer`.
   */
  readonly dtos: readonly DtoClass[]
  private readonly compileCached: Compiler

  constructor(options: Declaring<Defaults, EngineOptions> = {} as Declaring<Defaults, EngineOptions>) {
    const { cacheSize, resourceDtos, ...defaults } = options
    this.compileCached = createCachedCompiler(cacheSize)
    this.dtos = resourceDtos ?? []
    this.defaults = this.precompiled(withDtos(defaults as EvaluateOptions, this.dtos, this.compileCached))
    recordEngine(this)
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
    options?: EvaluateOptions
  ): InstanceType<C>[]
  project<C extends DtoClass>(input: unknown, dto: C, options?: EvaluateOptions): InstanceType<C>
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
export class BoundExpression<Expr extends string = string, Defaults extends EngineOptions = EmptyFhirpathTypeContext> {
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
