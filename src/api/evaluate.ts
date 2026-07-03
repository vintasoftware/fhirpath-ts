import { LruCache } from './cache'
import { CompiledExpression, type EvaluateOptions } from './compile'

const PARSE_CACHE_CAPACITY = 500

const parseCache = new LruCache<CompiledExpression>(PARSE_CACHE_CAPACITY)

/**
 * Evaluate a FHIRPath expression against an input and return plain JS values.
 * Parsed expressions are kept in a module-level LRU keyed by the expression text.
 */
export function evaluate(
  expression: string | CompiledExpression,
  input?: unknown,
  options?: EvaluateOptions
): unknown[] {
  return compiled(expression).evaluate(input, options)
}

function compiled(expression: string | CompiledExpression): CompiledExpression {
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
