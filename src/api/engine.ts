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
  type EvaluateOptions,
} from './compile.ts'
import { type ConstraintCheckResult, evaluateConstraints, type FhirConstraint } from './constraints.ts'
import { type Projection, type ProjectionColumns, projectOne } from './project.ts'

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
 * values override the bound defaults field by field, except `env`, which merges
 * per variable (per-call variables add to the bound ones and win on the same name).
 */
export class FhirPathEngine {
  /** The per-call options bound at construction; engine-only settings are not part of them. */
  readonly defaults: EvaluateOptions
  private readonly compileCached: Compiler

  constructor({ cacheSize, ...defaults }: EngineOptions = {}) {
    this.defaults = defaults
    this.compileCached = createCachedCompiler(cacheSize)
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
   * evaluates with `%index`/`%total` set to the row's position (`0`/`1` for a
   * single resource) — e.g. `(id | %index.toString()).first()` for a key that
   * falls back to the row number.
   */
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
  project(input: unknown, columns: ProjectionColumns, options?: EvaluateOptions): unknown {
    const merged = this.merged(options)
    if (Array.isArray(input) || isBundle(input)) {
      const subjects = toSubjects(input)
      return subjects.map((subject, index) =>
        projectOne(subject.value, columns, merged, this.compileCached, { index, total: subjects.length })
      )
    }
    return projectOne(input, columns, merged, this.compileCached)
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
   * on the same name. Passing `env: { reports }` to an engine bound with lookup
   * tables must not silently unbind the tables for that call. (To blank a bound
   * variable for one call, pass it as `undefined` — it resolves to empty.)
   */
  private merged(options?: EvaluateOptions): EvaluateOptions {
    if (!options) {
      return this.defaults
    }
    const merged = { ...this.defaults, ...options }
    if (this.defaults.env && options.env) {
      merged.env = { ...this.defaults.env, ...options.env }
    }
    return merged
  }
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
