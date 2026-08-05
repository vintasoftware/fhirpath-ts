import { normalizeEnvKeys } from '../engine/context.ts'
import { FhirPathTypeError } from '../errors.ts'
import type { R4TypeOf } from '../r4/generated/type-maps.ts'
import type { FhirpathInput, FhirpathResult } from '../typed/infer.ts'
import { booleanSingleton } from '../values/collection.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { type BundleLike, isBundle, normalizeInput, toSubjects } from './bundle.ts'
import {
  type AnyExpression,
  CompiledExpression,
  type Compiler,
  createCachedCompiler,
  type CustomFunction,
  type EvaluateOptions,
} from './compile.ts'
import { type ConstraintCheckResult, evaluateConstraints, type FhirConstraint } from './constraints.ts'
import { type DeclaredColumn, type DtoClass, dtoColumns } from './dto.ts'
import { type Projection, type ProjectionColumn, type ProjectionColumns, projectRows } from './project.ts'

/**
 * What engine methods accept as input: one resource, an array of resources, or a
 * Bundle — a Bundle behaves as its entry resources unless the expression
 * references `Bundle` in root position (then it addresses the bundle itself).
 * An expression that starts at a bare Bundle element (`entry.count()`, `type`)
 * is ambiguous and throws. Wrap a Bundle in an array (`[bundle]`) to force
 * treating it as one resource.
 */
export type EngineInput<Expr extends string = string> = FhirpathInput<Expr> | readonly unknown[] | BundleLike

/**
 * Per-call options for `evaluate()`/`first()` that also declare the result type,
 * for expressions outside the inference subset — the scalar-helper counterpart
 * of a project column's `type`. Like that column field, `type` is a compile-time
 * assertion only, never checked at runtime; the implementation passes the
 * options through untouched and the evaluator ignores the extra key. It is
 * deliberately not part of `EvaluateOptions`, so a result type can never be
 * bound as an engine-wide default at construction.
 */
export type TypedEvaluateOptions<T extends keyof R4TypeOf> = EvaluateOptions & { type: T }

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
   * DTO classes registered engine-wide (see `column()`): every `column()`
   * field becomes an expression-defined function callable from any expression
   * this engine evaluates (its name must be unique across the engine's
   * functions; `{ test }` fields stay projection-only), and each class's
   * static `env` merges into the engine env. A registered class must declare
   * its `fhirType`, and only one class may register per fhirType — the class
   * is *the* engine-wide vocabulary for that resource. Class `vars` are not
   * registered — they may reference per-call env, so they apply only when
   * projecting the class. A class you only ever project (never call into from
   * other expressions) does not need to be listed here.
   */
  resourceDtos?: readonly DtoClass[]
  /**
   * Declared columns registered engine-wide (see `declareColumn()`): each one's
   * expression becomes a function named by its `functionName`, under the same
   * uniqueness rule as `functions` and DTO members. `{ test }` declarations are
   * projection-only and cannot be listed here.
   */
  columns?: readonly DeclaredColumn[]
}

/**
 * A FHIRPath engine with the model (and any env/now/trace defaults) bound once,
 * so every call site stops repeating `{ model: r4Model }`. Per-call options
 * override the bound defaults field by field. `fhirpath-ts/r4` exports a
 * ready-made instance as `r4`.
 *
 * The evaluate-family methods take the expression first, mirroring the
 * low-level `evaluate()`; the per-resource helpers (`test`, `filter`,
 * `project`, `checkConstraints`) take their subject first.
 *
 * An engine is meant to outlive the work it serves: its parse cache is its own,
 * so a fresh engine starts cold. To vary `env`, `now`, or any other option per
 * request, keep one engine and pass them in that call's `options` — per-call
 * values override the bound defaults field by field, except `env` and
 * `functions`, which merge per name (per-call entries add to the bound ones
 * and win on the same name).
 */
export class FhirPathEngine {
  /** The per-call options bound at construction; engine-only settings are not part of them. */
  readonly defaults: EvaluateOptions
  private readonly compileCached: Compiler

  constructor({ cacheSize, resourceDtos, columns, ...defaults }: EngineOptions = {}) {
    this.compileCached = createCachedCompiler(cacheSize)
    this.defaults = this.precompiled(withDtos(defaults, resourceDtos ?? [], columns ?? [], this.compileCached))
  }

  /** Compile (LRU-cached by expression text) and evaluate in one call; typed like `compile().evaluate()`. */
  evaluate<const Expr extends string, T extends keyof R4TypeOf>(
    expression: Expr | CompiledExpression<Expr>,
    input: EngineInput<Expr> | undefined,
    options: TypedEvaluateOptions<T>
  ): R4TypeOf[T][]
  evaluate<const Expr extends string>(
    expression: Expr | CompiledExpression<Expr>,
    input?: EngineInput<Expr>,
    options?: EvaluateOptions
  ): FhirpathResult<Expr>
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
  compile<const Expr extends string>(expression: Expr): BoundExpression<Expr> {
    return new BoundExpression(this, new CompiledExpression(expression))
  }

  /** The first result, or undefined when the expression comes up empty. */
  first<const Expr extends string, T extends keyof R4TypeOf>(
    expression: Expr | CompiledExpression<Expr>,
    input: EngineInput<Expr> | undefined,
    options: TypedEvaluateOptions<T>
  ): R4TypeOf[T] | undefined
  first<const Expr extends string>(
    expression: Expr | CompiledExpression<Expr>,
    input?: EngineInput<Expr>,
    options?: EvaluateOptions
  ): FhirpathResult<Expr>[number] | undefined
  first(expression: AnyExpression, input?: unknown, options?: EvaluateOptions): unknown {
    return this.evaluate(expression, input, options)[0]
  }

  /**
   * Boolean criteria evaluation, the semantics FHIR invariants, Subscription
   * criteria, and `enableWhen` share (spec §4.5 singleton evaluation): empty →
   * false, a single boolean → itself, a single non-boolean item → true, and more
   * than one item is an error.
   */
  test(input: unknown, expression: AnyExpression, options?: EvaluateOptions): boolean {
    return booleanSingleton(this.evaluateTyped(expression, input, options)) ?? false
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
      .filter(value => booleanSingleton(compiled.evaluateTyped(value, merged)) ?? false)
  }

  /**
   * Shape a resource into a flat row, one expression per column, following
   * SQL-on-FHIR ViewDefinition column semantics: a column is a scalar (first
   * value or undefined) and yielding several values is an error — append
   * `.first()` or opt into `{ path, collection: true }` to keep them all.
   * An array or Bundle input produces one row per resource, and every column
   * evaluates with `%rowIndex`/`%rowTotal` set to the row's position (`0`/`1` for a
   * single resource) — e.g. `(id | %rowIndex.toString()).first()` for a key that
   * falls back to the row number. Columns compile up front, so a malformed
   * column expression throws even when the input yields no rows.
   */
  project<C extends DtoClass>(
    input: readonly unknown[] | BundleLike,
    dto: C,
    options?: EvaluateOptions
  ): InstanceType<C>[]
  project<C extends DtoClass>(input: unknown, dto: C, options?: EvaluateOptions): InstanceType<C>
  project<const Columns extends ProjectionColumns>(
    input: readonly unknown[] | BundleLike,
    columns: Columns,
    options?: EvaluateOptions
  ): Projection<Columns>[]
  project<const Columns extends ProjectionColumns>(
    input: unknown,
    columns: Columns,
    options?: EvaluateOptions
  ): Projection<Columns>
  project(input: unknown, columns: ProjectionColumns | DtoClass, options?: EvaluateOptions): unknown {
    if (typeof columns === 'function') {
      assertInputMatchesDto(input, columns)
    }
    const rows =
      typeof columns === 'function'
        ? projectRows(input, dtoColumns(columns), this.merged(dtoCallOptions(columns, options)), this.compileCached)
            // Materialize each row as a class instance: values replace the column
            // specs the field initializers hold, and methods/getters see the values.
            .map(row => Object.assign(new columns(), row))
        : projectRows(input, columns, this.merged(options), this.compileCached)
    return Array.isArray(input) || isBundle(input) ? rows : rows[0]
  }

  /**
   * Evaluate FHIR invariants (`ElementDefinition.constraint`-shaped) against a
   * resource — or each resource of an array or Bundle, where issues carry the
   * failing position as `index`. This checks constraint expressions only — it is
   * not full profile validation (no cardinality, bindings, or slicing). A
   * constraint whose expression itself errors is reported as a failed issue, not
   * thrown.
   */
  checkConstraints(
    input: unknown,
    constraints: readonly FhirConstraint[],
    options?: EvaluateOptions
  ): ConstraintCheckResult {
    return evaluateConstraints(input, constraints, this.merged(options), this.compileCached)
  }

  /**
   * Per-call options override the bound defaults field by field, except `env`,
   * which merges per variable: per-call variables add to the bound ones and win
   * on the same name — in either spelling, since env keys are normalized
   * (`threshold` and `%threshold` are the same variable). Passing
   * `env: { reports }` to an engine bound with lookup tables must not silently
   * unbind the tables for that call. (To blank a bound variable for one call,
   * pass it as `undefined` — it resolves to empty.) `vars` and `functions`
   * merge the same way, per name, for the same reason.
   */
  private merged(options?: EvaluateOptions): EvaluateOptions {
    if (!options) {
      return this.defaults
    }
    const precompiled = this.precompiled(options)
    const merged = { ...this.defaults, ...precompiled }
    if (this.defaults.env && precompiled.env) {
      merged.env = { ...normalizeEnvKeys(this.defaults.env), ...normalizeEnvKeys(precompiled.env) }
    }
    if (this.defaults.vars && precompiled.vars) {
      merged.vars = {
        ...normalizeEnvKeys(this.defaults.vars),
        ...normalizeEnvKeys(precompiled.vars),
      } as NonNullable<EvaluateOptions['vars']>
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
        Object.entries(options.functions).map(([name, fn]) => [
          name,
          'expression' in fn && typeof fn.expression === 'string'
            ? { ...fn, expression: this.compileCached(fn.expression) }
            : fn,
        ])
      )
    }
    return out
  }
}

/**
 * Fold registered DTO classes into the engine defaults: each `column()` field
 * becomes an expression-defined function (its analyzer signature derived from
 * the column's `type` when no `as`/`map` reshapes the value), and each class's
 * static `env` merges in. Redefining an existing function or env variable is
 * an error — silent shadowing between classes would be impossible to debug
 * from an expression.
 */
function withDtos(
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
      : ((spec.type as string | undefined) ?? (spec.enum !== undefined ? 'System.String' : undefined))
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
function assertInputMatchesDto(input: unknown, dto: DtoClass): void {
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
 * call. A class registered via EngineOptions.resourceDtos re-applies its env here with
 * identical values, which is harmless.
 */
function dtoCallOptions(dto: DtoClass, options: EvaluateOptions | undefined): EvaluateOptions | undefined {
  if (dto.env === undefined && dto.vars === undefined) {
    return options
  }
  const merged: EvaluateOptions = { ...options }
  if (dto.env !== undefined) {
    merged.env = { ...normalizeEnvKeys(dto.env), ...normalizeEnvKeys(options?.env) }
  }
  if (dto.vars !== undefined) {
    merged.vars = {
      ...normalizeEnvKeys(dto.vars),
      ...normalizeEnvKeys(options?.vars),
    } as NonNullable<EvaluateOptions['vars']>
  }
  return merged
}

/** A compiled expression carrying an engine's defaults, so `evaluate(input)` needs nothing else. */
export class BoundExpression<Expr extends string = string> {
  readonly expression: CompiledExpression<Expr>
  private readonly engine: FhirPathEngine

  constructor(engine: FhirPathEngine, expression: CompiledExpression<Expr>) {
    this.engine = engine
    this.expression = expression
  }

  get source(): string {
    return this.expression.source
  }

  evaluate<T extends keyof R4TypeOf>(
    input: EngineInput<Expr> | undefined,
    options: TypedEvaluateOptions<T>
  ): R4TypeOf[T][]
  evaluate(input?: EngineInput<Expr>, options?: EvaluateOptions): FhirpathResult<Expr>
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
  first(input?: EngineInput<Expr>, options?: EvaluateOptions): FhirpathResult<Expr>[number] | undefined
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
