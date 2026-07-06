/**
 * Shared policy for deciding which call/tag sites in source code hold FHIRPath
 * expressions. Both the `fhirpath-check` CLI (TypeScript AST) and the ESLint rule
 * (ESTree AST) apply the same rules; only the tree-walking differs, so the policy
 * constants and the foreign-binding decision live here to stay in lockstep.
 */

/** Function names whose first string argument is treated as a FHIRPath expression. */
export const CALL_NAMES: ReadonlySet<string> = new Set(['fhirpath', 'compile', 'evaluate', 'analyzeExpression'])

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

/** Whether an import specifier's module is foreign (not this package). */
export function isForeignModule(moduleSpecifier: string): boolean {
  return !moduleSpecifier.startsWith(PACKAGE_PREFIX)
}
