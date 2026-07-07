import { type AnyExpression, cachedCompile, type EvaluateOptions } from './compile.ts'

/**
 * Evaluate a FHIRPath expression against an input and return plain JS values.
 * Parsed expressions are kept in a module-level LRU keyed by the expression text.
 */
export function evaluate(expression: AnyExpression, input?: unknown, options?: EvaluateOptions): unknown[] {
  return cachedCompile(expression).evaluate(input, options)
}
