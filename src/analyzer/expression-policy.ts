/**
 * Shared policy for deciding which call/tag sites in source code hold FHIRPath
 * expressions. Both the `fhirpath-check` CLI (TypeScript AST) and the ESLint rule
 * (ESTree AST) apply the same rules; only the tree-walking differs, so the policy
 * constants and the foreign-binding decision live here to stay in lockstep.
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
}

/** Call names that take FHIRPath expressions, and where/how they take them. */
export const CALL_SITES: ReadonlyMap<string, CallSitePolicy> = new Map([
  // Expression-first: the low-level API and the evaluate family of FhirPathEngine.
  ['fhirpath', { argIndex: 0, shape: 'expression' }],
  ['compile', { argIndex: 0, shape: 'expression' }],
  ['evaluate', { argIndex: 0, shape: 'expression' }],
  ['evaluateTyped', { argIndex: 0, shape: 'expression' }],
  ['first', { argIndex: 0, shape: 'expression' }],
  ['analyzeExpression', { argIndex: 0, shape: 'expression' }],
  // Subject-first FhirPathEngine helpers: the expression(s) come second.
  ['test', { argIndex: 1, shape: 'expression' }],
  ['filter', { argIndex: 1, shape: 'expression' }],
  ['project', { argIndex: 1, shape: 'columns' }],
  ['checkConstraints', { argIndex: 1, shape: 'constraints' }],
])

/** The tag name whose no-substitution template holds a FHIRPath expression. */
export const TAG_NAME = 'fhirpath'

/** Imports from this package (any subpath) are the real FHIRPath API, never foreign. */
export const PACKAGE_PREFIX = 'fhirpath-ts'

/**
 * Given the local names bound by non-package imports, decide whether a call whose
 * callee name is `calleeName` should be skipped. `receiverRoot` is the leftmost
 * identifier of a property-access callee (e.g. `Handlebars` in
 * `Handlebars.compile(...)`), or undefined for a bare-identifier callee.
 *
 * `compile('...')` from handlebars and `Handlebars.compile('...')` are both
 * skipped when their binding is foreign; `api.evaluate('...')` on a local object
 * is still checked.
 */
export function isForeignCall(
  foreign: ReadonlySet<string>,
  calleeName: string,
  receiverRoot: string | undefined
): boolean {
  const binding = receiverRoot ?? calleeName
  return foreign.has(binding)
}

/** Which import sources count as the real FHIRPath API rather than a foreign module. */
export interface LocalModuleOptions {
  /** Import-source prefixes that are the FHIRPath API. Defaults to `['fhirpath-ts']`. */
  packages?: readonly string[]
  /**
   * Also treat relative imports (`./`, `../`) as the FHIRPath API. Off by default
   * (a consumer's relative `compile` is not FHIRPath); turn it on so the package
   * can dogfood the rule on its own source, which imports its API relatively.
   */
  localImports?: boolean
}

/**
 * Whether an import specifier's module is foreign (not the FHIRPath API). By
 * default only `fhirpath-ts` (any subpath) is local; `options` widens that to
 * extra package prefixes and/or relative imports.
 */
export function isForeignModule(moduleSpecifier: string, options: LocalModuleOptions = {}): boolean {
  const packages = options.packages ?? [PACKAGE_PREFIX]
  if (packages.some(prefix => moduleSpecifier.startsWith(prefix))) {
    return false
  }
  if (options.localImports === true && moduleSpecifier.startsWith('.')) {
    return false
  }
  return true
}
