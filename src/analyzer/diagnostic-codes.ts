/** Every code an analyzer diagnostic carries. */
export const ANALYZER_DIAGNOSTIC_CODES = [
  'always-empty',
  'argument-singleton',
  'column-type',
  'datatype-root',
  'equality-incompatible',
  'input-type',
  'invalid-argument',
  'invalid-value',
  'missing-element',
  'operand-type',
  'order-dependent',
  'regex-backtracking',
  'singleton-required',
  'subtype-element',
  'syntax',
  'unchecked-navigation',
  'unchecked-variable',
  'unknown-element',
  'unknown-function',
  'unknown-type',
  'unknown-variable',
  'variable-override',
  'variable-redefined',
  'wrong-arity',
] as const

export type AnalyzerDiagnosticCode = (typeof ANALYZER_DIAGNOSTIC_CODES)[number]

/**
 * Codes of errors that are wrong whatever the data: the part of the expression
 * they mark throws whenever it runs, or is always empty. The expression is not
 * valid FHIRPath, names an element, function, variable, or type that does not
 * exist, calls a function with the wrong number of arguments, defines a
 * variable whose name is taken, builds an instance selector from a literal its
 * type refuses, or starts at a type name that never matches. Every other error
 * depends on the data, such as a collection that may hold one item or an
 * operand that may be empty.
 */
export const DEFINITE_DIAGNOSTIC_CODES: ReadonlySet<AnalyzerDiagnosticCode> = new Set([
  'syntax',
  'unknown-element',
  'unknown-function',
  'unknown-variable',
  'unknown-type',
  'wrong-arity',
  'variable-override',
  'variable-redefined',
  'invalid-value',
  'datatype-root',
])
