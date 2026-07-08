/**
 * Shared policy for deciding which call/tag sites in source code hold FHIRPath
 * expressions. Both the `fhirpath-check` CLI (TypeScript AST) and the ESLint rule
 * (ESTree AST) apply the same rules; only the tree-walking differs, so everything
 * that is a *decision* lives here — the call-name table, the check/skip rules,
 * and the expression-shape extraction (via the `ExpressionAst` adapter) — and the
 * walkers supply only AST access. This module must stay free of `typescript` and
 * `eslint` imports so either walker can load it alone.
 */

/**
 * How a call site carries its FHIRPath expression(s):
 * - `expression`: the argument is the expression string itself.
 * - `columns`: the argument is a `project()` columns object — each property value
 *   is an expression string or a `{ path }` object.
 * - `constraints`: the argument is a `checkConstraints()` array of
 *   `{ expression }` constraint objects.
 */
export type CallSiteShape = 'expression' | 'columns' | 'constraints'

export interface CallSitePolicy {
  /** Which argument holds the expression(s): 0 for expression-first calls, 1 for subject-first helpers. */
  argIndex: number
  shape: CallSiteShape
  /**
   * What the callee's receiver must be for the call to be checked:
   * - `any`: checked unless the name is bound by a foreign import — right for
   *   distinctive names (`fhirpath`, `analyzeExpression`) that rarely collide.
   * - `engine`: checked only when the receiver root is a known engine binding
   *   (imported from this package, or a `new FhirPathEngine(...)` local).
   *   Required for `test`/`filter`/`first`/`project`: they exist only as engine
   *   methods, and the names are so common (knex `db.first('col')`, lodash
   *   `_.filter(...)`) that flag-by-default would report other libraries' code.
   *   The cost: an engine reached through an untracked alias (`this.engine`,
   *   a function parameter) is not checked.
   */
  receiver: 'any' | 'engine'
}

/** Call names that take FHIRPath expressions, and where/how/on-what they take them. */
export const CALL_SITES: ReadonlyMap<string, CallSitePolicy> = new Map([
  // Expression-first: the low-level API and the evaluate family of FhirPathEngine.
  ['fhirpath', { argIndex: 0, shape: 'expression', receiver: 'any' }],
  ['compile', { argIndex: 0, shape: 'expression', receiver: 'any' }],
  ['evaluate', { argIndex: 0, shape: 'expression', receiver: 'any' }],
  ['evaluateTyped', { argIndex: 0, shape: 'expression', receiver: 'any' }],
  ['first', { argIndex: 0, shape: 'expression', receiver: 'engine' }],
  ['analyzeExpression', { argIndex: 0, shape: 'expression', receiver: 'any' }],
  // Subject-first FhirPathEngine helpers: the expression(s) come second.
  ['test', { argIndex: 1, shape: 'expression', receiver: 'engine' }],
  ['filter', { argIndex: 1, shape: 'expression', receiver: 'engine' }],
  ['project', { argIndex: 1, shape: 'columns', receiver: 'engine' }],
  ['checkConstraints', { argIndex: 1, shape: 'constraints', receiver: 'any' }],
])

/** The tag name whose no-substitution template holds a FHIRPath expression. */
export const TAG_NAME = 'fhirpath'

/** Imports from this package (any subpath) are the real FHIRPath API, never foreign. */
export const PACKAGE_PREFIX = 'fhirpath-ts'

/** The engine class name: `new FhirPathEngine(...)` locals are engine bindings. */
export const ENGINE_CLASS_NAME = 'FhirPathEngine'

/**
 * Name bindings a walker collects from a source file before extracting sites:
 * - `foreign`: local names bound by imports from modules other than this package
 *   (`compile` from handlebars is not a FHIRPath entry point).
 * - `engines`: receiver roots known to be FHIRPath objects — names imported from
 *   this package (`r4`, a namespace import) plus locals initialized with
 *   `new FhirPathEngine(...)` (see `constructsEngine`).
 * Files without imports (scripts, snippets) have both sets empty: `receiver: 'any'`
 * names are then always checked, `receiver: 'engine'` names only via a
 * `new FhirPathEngine(...)` local.
 */
export interface SourceBindings {
  foreign: ReadonlySet<string>
  engines: ReadonlySet<string>
}

/**
 * Whether a call site should be checked, given its policy and the file's
 * bindings. `receiverRoot` is the leftmost identifier of a member-expression
 * callee (`Handlebars` in `Handlebars.compile(...)`, `db` in
 * `db.clients.first(...)`), or undefined for a bare-identifier callee or a
 * non-identifier root (`this`, a call result).
 */
export function isCheckedCall(
  policy: CallSitePolicy,
  calleeName: string,
  receiverRoot: string | undefined,
  bindings: SourceBindings
): boolean {
  if (policy.receiver === 'engine') {
    return receiverRoot !== undefined && bindings.engines.has(receiverRoot)
  }
  return !bindings.foreign.has(receiverRoot ?? calleeName)
}

/**
 * Whether `new className(...)` yields an engine binding: any class imported from
 * this package counts, and the bare `FhirPathEngine` name also counts in files
 * whose imports don't claim it — so import-less snippets stay checkable.
 */
export function constructsEngine(className: string, bindings: SourceBindings): boolean {
  return bindings.engines.has(className) || (className === ENGINE_CLASS_NAME && !bindings.foreign.has(className))
}

/** Whether an import specifier's module is foreign (not this package). */
export function isForeignModule(moduleSpecifier: string): boolean {
  return !moduleSpecifier.startsWith(PACKAGE_PREFIX)
}

/** An extracted expression literal: the AST node (for reporting) and its text. */
export interface ExpressionEntry<N> {
  node: N
  expression: string
}

/**
 * The AST accessors a walker provides so shape extraction can be written once.
 * Each returns undefined when the node is not of the asked-for kind, which the
 * extractor treats as "dynamic, skip" — so spreads, shorthands, computed values,
 * and variables all fall out of the same rule in both walkers.
 */
export interface ExpressionAst<N> {
  /** The node as a string literal entry, or undefined when it is not one. */
  string(node: N): ExpressionEntry<N> | undefined
  /**
   * The plain (non-spread, non-shorthand) properties of an object literal, or
   * undefined when the node is not an object literal. `name` is the property's
   * statically-known key — undefined for computed keys.
   */
  properties(node: N): { name: string | undefined; value: N }[] | undefined
  /** The elements of an array literal, or undefined when the node is not one. */
  elements(node: N): N[] | undefined
}

/**
 * Extract the expression literal(s) an argument holds, per the call site's shape.
 * Column keys are output names, not expressions, so a computed key does not stop
 * its value from being checked; `{ path }` / `{ expression }` lookups match
 * identifier and string-literal keys only.
 */
export function expressionEntries<N>(argument: N, shape: CallSiteShape, ast: ExpressionAst<N>): ExpressionEntry<N>[] {
  if (shape === 'expression') {
    const entry = ast.string(argument)
    return entry ? [entry] : []
  }
  if (shape === 'columns') {
    // project() columns: { name: 'expr' } or { name: { path: 'expr', collection: true } }.
    return (ast.properties(argument) ?? []).flatMap(({ value }) => {
      const entry = ast.string(value)
      return entry ? [entry] : namedStringEntries(value, 'path', ast)
    })
  }
  // checkConstraints() constraints: [{ key, expression: 'expr', ... }].
  return (ast.elements(argument) ?? []).flatMap(element => namedStringEntries(element, 'expression', ast))
}

/** The string-literal values of an object literal's `name` properties. */
function namedStringEntries<N>(object: N, name: string, ast: ExpressionAst<N>): ExpressionEntry<N>[] {
  return (ast.properties(object) ?? []).flatMap(({ name: key, value }) => {
    if (key !== name) {
      return []
    }
    const entry = ast.string(value)
    return entry ? [entry] : []
  })
}
