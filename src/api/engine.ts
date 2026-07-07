import type { FhirpathInput, FhirpathResult } from '../typed/infer.ts'
import { booleanSingleton } from '../values/collection.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { type BundleLike, isBundle, normalizeInput, toSubjects } from './bundle.ts'
import { type AnyExpression, CompiledExpression, cachedCompile, type EvaluateOptions } from './compile.ts'
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
 * A FHIRPath engine with the model (and any env/now/trace defaults) bound once,
 * so every call site stops repeating `{ model: r4Model }`. Per-call options
 * override the bound defaults field by field. `fhirpath-ts/r4` exports a
 * ready-made instance as `r4`.
 *
 * The evaluate-family methods take the expression first, mirroring the
 * low-level `evaluate()`; the per-resource helpers (`test`, `filter`,
 * `project`, `checkConstraints`) take their subject first.
 */
export class FhirPathEngine {
  readonly defaults: EvaluateOptions

  constructor(defaults: EvaluateOptions = {}) {
    this.defaults = defaults
  }

  /** Compile (LRU-cached by expression text) and evaluate in one call; typed like `compile().evaluate()`. */
  evaluate<const Expr extends string>(
    expression: Expr | CompiledExpression<Expr>,
    input?: EngineInput<Expr>,
    options?: EvaluateOptions
  ): FhirpathResult<Expr> {
    const compiled = cachedCompile(expression)
    const merged = this.merged(options)
    return compiled.evaluate(normalizeInput(input, compiled.ast, merged.model), merged) as FhirpathResult<Expr>
  }

  /** Like `evaluate()`, keeping the internal typed representation (types, Decimal, Temporal). */
  evaluateTyped(expression: AnyExpression, input?: unknown, options?: EvaluateOptions): TypedValue[] {
    const compiled = cachedCompile(expression)
    const merged = this.merged(options)
    return compiled.evaluateTyped(normalizeInput(input, compiled.ast, merged.model), merged)
  }

  /** Parse once for reuse, with this engine's defaults bound. Does not touch the parse cache. */
  compile<const Expr extends string>(expression: Expr): BoundExpression<Expr> {
    return new BoundExpression(this, new CompiledExpression(expression))
  }

  /** The first result, or undefined when the expression comes up empty. */
  first<const Expr extends string>(
    expression: Expr | CompiledExpression<Expr>,
    input?: EngineInput<Expr>,
    options?: EvaluateOptions
  ): FhirpathResult<Expr>[number] | undefined {
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
    const compiled = cachedCompile(expression)
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
   * An array or Bundle input produces one row per resource.
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
      return toSubjects(input).map(subject => projectOne(subject.value, columns, merged))
    }
    return projectOne(input, columns, merged)
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
    return evaluateConstraints(input, constraints, this.merged(options))
  }

  private merged(options?: EvaluateOptions): EvaluateOptions {
    return options ? { ...this.defaults, ...options } : this.defaults
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

  evaluate(input?: EngineInput<Expr>, options?: EvaluateOptions): FhirpathResult<Expr> {
    return this.engine.evaluate(this.expression, input, options)
  }

  evaluateTyped(input?: unknown, options?: EvaluateOptions): TypedValue[] {
    return this.engine.evaluateTyped(this.expression, input, options)
  }

  first(input?: EngineInput<Expr>, options?: EvaluateOptions): FhirpathResult<Expr>[number] | undefined {
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
