import { LruCache } from './cache.ts'
import { CompiledExpression, type EvaluateOptions } from './compile.ts'

const PARSE_CACHE_CAPACITY = 500

const parseCache = new LruCache<CompiledExpression>(PARSE_CACHE_CAPACITY)

/**
 * Evaluate a FHIRPath expression against an input and return plain JS values.
 * Parsed expressions are kept in a module-level LRU keyed by the expression text.
 */
export function evaluate(
  // biome-ignore lint/suspicious/noExplicitAny: accepts any literal-typed CompiledExpression; results here are untyped
  expression: string | CompiledExpression<any>,
  input?: unknown,
  options?: EvaluateOptions
): unknown[] {
  return cachedCompile(expression).evaluate(input, options)
}

/** The shared expression → CompiledExpression LRU, used by `evaluate()` and `FhirPathEngine`. */
export function cachedCompile(
  // biome-ignore lint/suspicious/noExplicitAny: accepts any literal-typed CompiledExpression
  expression: string | CompiledExpression<any>
): CompiledExpression<string> {
  if (typeof expression !== 'string') {
    return expression
  }
  let cached = parseCache.get(expression)
  if (!cached) {
    cached = new CompiledExpression(expression)
    parseCache.set(expression, cached)
  }
  return cached
}
