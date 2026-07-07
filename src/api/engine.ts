import { FhirPathError, FhirPathRuntimeError } from '../errors.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { AstNode } from '../parser/ast.ts'
import type { FhirpathInput, FhirpathResult } from '../typed/infer.ts'
import { booleanSingleton } from '../values/collection.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { CompiledExpression, type EvaluateOptions } from './compile.ts'
import { cachedCompile } from './evaluate.ts'

// biome-ignore lint/suspicious/noExplicitAny: accepts any literal-typed CompiledExpression; results here are untyped
type AnyExpression = string | CompiledExpression<any>

/** The subset of a FHIR Bundle the engine needs in order to unwrap it. */
export interface BundleLike {
  resourceType: 'Bundle'
  entry?: { resource?: unknown }[]
}

/**
 * What engine methods accept as input: one resource, an array of resources, or a
 * Bundle — a Bundle behaves as its entry resources unless the expression
 * references `Bundle` in root position (then it addresses the bundle itself).
 * An expression that starts at a bare Bundle element (`entry.count()`, `type`)
 * is ambiguous and throws. Wrap a Bundle in an array (`[bundle]`) to force
 * treating it as one resource.
 */
export type EngineInput<Expr extends string = string> = FhirpathInput<Expr> | readonly unknown[] | BundleLike

function isBundle(value: unknown): value is BundleLike {
  return typeof value === 'object' && value !== null && (value as { resourceType?: unknown }).resourceType === 'Bundle'
}

function entryResources(bundle: BundleLike): unknown[] {
  const entries = Array.isArray(bundle.entry) ? bundle.entry : []
  return entries.map(entry => entry.resource).filter(resource => resource !== undefined)
}

/** Identifiers in root (path-head) position — the names that resolve against the input. */
function collectRootIdentifiers(node: AstNode, heads: string[]): void {
  switch (node.kind) {
    case 'identifier':
      heads.push(node.name)
      return
    case 'dot':
      // Only the head of a dotted path is a root; the right side is an element name,
      // and arguments of dotted-in functions resolve against $this, not the input.
      collectRootIdentifiers(node.left, heads)
      return
    case 'indexer':
      collectRootIdentifiers(node.target, heads)
      collectRootIdentifiers(node.index, heads)
      return
    case 'call':
      for (const arg of node.args) {
        collectRootIdentifiers(arg, heads)
      }
      return
    case 'unary':
      collectRootIdentifiers(node.operand, heads)
      return
    case 'binary':
      collectRootIdentifiers(node.left, heads)
      collectRootIdentifiers(node.right, heads)
      return
    case 'typeOp':
      collectRootIdentifiers(node.operand, heads)
      return
    default:
      return
  }
}

/** Bundle element names (R4/R5 plus the Resource base), the fallback when no model is bound. */
const BUNDLE_ELEMENTS = new Set([
  'id',
  'meta',
  'implicitRules',
  'language',
  'identifier',
  'type',
  'timestamp',
  'total',
  'link',
  'entry',
  'signature',
  'issues',
])

function isBundleElement(name: string, model: ModelProvider | undefined): boolean {
  const bundleType = model?.resolveType('Bundle')
  if (model && bundleType !== undefined) {
    return model.getElement(bundleType, name) !== undefined
  }
  return BUNDLE_ELEMENTS.has(name)
}

/**
 * Bundle in, entry resources out — unless the expression addresses the Bundle
 * itself (a `Bundle` root). An expression whose root is a bare Bundle element
 * (`entry.count()`, `type`) could mean either and throws instead of guessing.
 */
function normalizeInput(
  input: unknown,
  compiled: CompiledExpression<string>,
  model: ModelProvider | undefined
): unknown {
  if (!isBundle(input)) {
    return input
  }
  const heads: string[] = []
  collectRootIdentifiers(compiled.ast, heads)
  if (heads.includes('Bundle')) {
    return input
  }
  const ambiguous = heads.find(head => isBundleElement(head, model))
  if (ambiguous !== undefined) {
    throw new FhirPathRuntimeError(
      `Ambiguous expression for a Bundle input: '${ambiguous}' is a Bundle element, but a bare Bundle evaluates against its entry resources. Start the expression at Bundle to address the bundle, or wrap the input in an array to treat it as one resource.`
    )
  }
  return entryResources(input)
}

function projectOne(input: unknown, columns: ProjectionColumns, options: EvaluateOptions): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const [name, column] of Object.entries(columns)) {
    const path = typeof column === 'string' ? column : column.path
    const collection = typeof column !== 'string' && column.collection === true
    const values = cachedCompile(path).evaluate(input, options)
    if (collection) {
      row[name] = values
    } else if (values.length > 1) {
      throw new FhirPathRuntimeError(
        `project(): column '${name}' yielded ${values.length} values; append first() or set collection: true`
      )
    } else {
      row[name] = values[0]
    }
  }
  return row
}

/** One column of a `project()` call: an expression, or `{ path, collection: true }` to keep all values. */
export type ProjectionColumn = string | { path: string; collection?: boolean }

export type ProjectionColumns = Record<string, ProjectionColumn>

type ColumnPath<Column extends ProjectionColumn> = Column extends string
  ? Column
  : Column extends { path: infer Path extends string }
    ? Path
    : never

type ColumnResult<Column extends ProjectionColumn> = Column extends { collection: true }
  ? FhirpathResult<ColumnPath<Column>>
  : FhirpathResult<ColumnPath<Column>>[number] | undefined

/** The row shape `project()` produces: each column's type inferred from its expression. */
export type Projection<Columns extends ProjectionColumns> = {
  -readonly [K in keyof Columns]: ColumnResult<Columns[K]>
}

/** An invariant to check, shaped like FHIR's `ElementDefinition.constraint`. */
export interface FhirConstraint {
  /** Constraint id, e.g. `pat-1`. */
  key: string
  /** `error` (default) fails validation; `warning` is reported but does not. */
  severity?: 'error' | 'warning'
  /** Human-readable description of the rule. */
  human?: string
  /** FHIRPath expression that must evaluate to true. */
  expression: string
}

/** A constraint that did not hold, echoing its definition. */
export interface ConstraintIssue {
  key: string
  severity: 'error' | 'warning'
  human?: string
  expression: string
  /** Set when the expression itself failed to parse or evaluate, with the engine error. */
  error?: string
  /** For array or Bundle inputs: position of the failing resource (in the array, or in `Bundle.entry`). */
  index?: number
}

/** Minimal OperationOutcome shape; structurally assignable to the full R4 type. */
export interface OperationOutcome {
  resourceType: 'OperationOutcome'
  issue: {
    severity: 'error' | 'warning' | 'information'
    code: 'invariant' | 'informational'
    details: { text: string }
    diagnostics?: string
    /** For Bundle inputs: FHIRPath to the failing entry resource, e.g. `Bundle.entry[3].resource`. */
    expression?: string[]
  }[]
}

export interface ConstraintCheckResult {
  /** True when no error-severity constraint failed; warnings do not invalidate. */
  valid: boolean
  /** The constraints that failed (both severities), in input order. */
  issues: ConstraintIssue[]
  /** The same issues as a FHIR OperationOutcome (`issue.code = 'invariant'`, validator-style). */
  toOperationOutcome(): OperationOutcome
}

/**
 * A FHIRPath engine with the model (and any env/now/trace defaults) bound once,
 * so every call site stops repeating `{ model: r4Model }`. Per-call options
 * override the bound defaults field by field. `fhirpath-ts/r4` exports a
 * ready-made instance as `r4`.
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
    return compiled.evaluate(normalizeInput(input, compiled, merged.model), merged) as FhirpathResult<Expr>
  }

  /** Like `evaluate()`, keeping the internal typed representation (types, Decimal, Temporal). */
  evaluateTyped(expression: AnyExpression, input?: unknown, options?: EvaluateOptions): TypedValue[] {
    const compiled = cachedCompile(expression)
    const merged = this.merged(options)
    return compiled.evaluateTyped(normalizeInput(input, compiled, merged.model), merged)
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

  /** The items (or Bundle entry resources) for which `test()` holds. */
  filter<T>(input: readonly T[], expression: AnyExpression, options?: EvaluateOptions): T[]
  filter(input: BundleLike, expression: AnyExpression, options?: EvaluateOptions): unknown[]
  filter(input: readonly unknown[] | BundleLike, expression: AnyExpression, options?: EvaluateOptions): unknown[] {
    const items = Array.isArray(input) ? input : entryResources(input as BundleLike)
    const compiled = cachedCompile(expression)
    const merged = this.merged(options)
    return items.filter(item => booleanSingleton(compiled.evaluateTyped(item, merged)) ?? false)
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
      const items = Array.isArray(input) ? input : entryResources(input)
      return items.map(item => projectOne(item, columns, merged))
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
    const merged = this.merged(options)
    const bundle = isBundle(input)
    const subjects: { value: unknown; index?: number }[] = bundle
      ? (Array.isArray(input.entry) ? input.entry : [])
          .map((entry, index) => ({ value: entry.resource, index }))
          .filter(subject => subject.value !== undefined)
      : Array.isArray(input)
        ? input.map((value, index) => ({ value, index }))
        : [{ value: input }]
    const issues: ConstraintIssue[] = []
    for (const subject of subjects) {
      for (const constraint of constraints) {
        const issue: ConstraintIssue = {
          key: constraint.key,
          severity: constraint.severity ?? 'error',
          expression: constraint.expression,
          ...(constraint.human === undefined ? {} : { human: constraint.human }),
          ...(subject.index === undefined ? {} : { index: subject.index }),
        }
        try {
          if (booleanSingleton(cachedCompile(constraint.expression).evaluateTyped(subject.value, merged)) !== true) {
            issues.push(issue)
          }
        } catch (error) {
          issue.error = error instanceof FhirPathError ? error.message : String(error)
          issues.push(issue)
        }
      }
    }
    return {
      valid: issues.every(issue => issue.severity !== 'error'),
      issues,
      toOperationOutcome: () => toOperationOutcome(issues, bundle),
    }
  }

  private merged(options?: EvaluateOptions): EvaluateOptions {
    return options ? { ...this.defaults, ...options } : this.defaults
  }
}

function toOperationOutcome(issues: ConstraintIssue[], bundle: boolean): OperationOutcome {
  if (issues.length === 0) {
    return {
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'information', code: 'informational', details: { text: 'All constraints passed' } }],
    }
  }
  return {
    resourceType: 'OperationOutcome',
    issue: issues.map(issue => ({
      severity: issue.severity,
      code: 'invariant',
      details: { text: issue.human ?? `Constraint ${issue.key} failed` },
      diagnostics: issue.error === undefined ? issue.expression : `${issue.expression} (${issue.error})`,
      ...(bundle && issue.index !== undefined ? { expression: [`Bundle.entry[${issue.index}].resource`] } : {}),
    })),
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
