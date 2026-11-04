import {
  type AnyExpression,
  type AsyncEvaluateOptions,
  createCachedCompiler,
  type EvaluateOptions,
  type PromisedAsyncOptions,
} from './compile.ts'

const compileCached = createCachedCompiler()

/**
 * Evaluate a FHIRPath expression against an input and return plain JS values.
 * Parsed expressions are kept in a module-level LRU keyed by the expression text.
 */
export function evaluate(expression: AnyExpression, input?: unknown, options?: EvaluateOptions): unknown[] {
  return compileCached(expression).evaluate(input, options)
}

/**
 * Evaluate with host-provided asynchronous terminology and reference services.
 * With `syncWhenPossible`, an evaluation that needs no service returns its
 * result directly.
 */
export function evaluateAsync(
  expression: AnyExpression,
  input?: unknown,
  options?: PromisedAsyncOptions
): Promise<unknown[]>
export function evaluateAsync(
  expression: AnyExpression,
  input?: unknown,
  options?: AsyncEvaluateOptions
): unknown[] | Promise<unknown[]>
export function evaluateAsync(
  expression: AnyExpression,
  input?: unknown,
  options?: AsyncEvaluateOptions
): unknown[] | Promise<unknown[]> {
  return compileCached(expression).evaluateAsync(input, options)
}
