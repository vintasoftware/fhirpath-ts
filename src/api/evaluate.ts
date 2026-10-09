import { type AnyExpression, createCachedCompiler, type EvaluateOptions } from './compile.ts'

const compileCached = createCachedCompiler()

/**
 * Evaluate a FHIRPath expression against an input and return plain JS values.
 * Parsed expressions are kept in a module-level LRU keyed by the expression text.
 */
export function evaluate(expression: AnyExpression, input?: unknown, options?: EvaluateOptions): unknown[] {
  return compileCached(expression).evaluate(input, options)
}

/** Evaluate with host-provided asynchronous terminology and reference services. */
export function evaluateAsync(
  expression: AnyExpression,
  input?: unknown,
  options?: EvaluateOptions
): Promise<unknown[]> {
  return compileCached(expression).evaluateAsync(input, options)
}
