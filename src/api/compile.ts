import { createContext } from '../engine/context.ts'
import { evaluateNode } from '../engine/evaluator.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { AstNode } from '../parser/ast.ts'
import { parse } from '../parser/parser.ts'
import { printExpression } from '../parser/printer.ts'
import type { FhirpathInput, FhirpathResult } from '../typed/infer.ts'
import { type TypedValue, toCollection, unwrap } from '../values/typed-value.ts'
import { LruCache } from './cache.ts'

export interface EvaluateOptions {
  /** Environment variables (`%name`), keyed with or without the leading `%`. */
  env?: Record<string, unknown>
  model?: ModelProvider
  /** Evaluation clock for now()/today()/timeOfDay(); defaults to the real time. */
  now?: Date
  /**
   * Sink for trace(name, ...) calls. No default logging: traced values may contain
   * patient data, so sending them anywhere is an explicit choice.
   */
  trace?: (name: string, values: TypedValue[]) => void
}

/**
 * A parsed expression, reusable across inputs. Create via `compile()` or the
 * `fhirpath` tag: literal expressions carry inferred result and input types for
 * the supported subset (see src/typed/infer.ts), everything else is unknown[].
 */
export class CompiledExpression<Expr extends string = string> {
  readonly source: string
  readonly ast: AstNode

  constructor(source: Expr) {
    this.source = source
    this.ast = parse(source)
  }

  /** Evaluate and unwrap results to plain JS values. */
  evaluate(input?: FhirpathInput<Expr>, options?: EvaluateOptions): FhirpathResult<Expr> {
    return this.evaluateTyped(input, options).map(unwrap) as FhirpathResult<Expr>
  }

  /** Evaluate keeping the internal typed representation (types, Decimal, Temporal). */
  evaluateTyped(input?: unknown, options?: EvaluateOptions): TypedValue[] {
    const root = toCollection(input)
    const context = createContext({
      root,
      env: options?.env,
      model: options?.model,
      now: options?.now,
      trace: options?.trace,
    })
    return evaluateNode(this.ast, context, root)
  }

  /** The canonical form of the expression. */
  toString(): string {
    return printExpression(this.ast)
  }
}

/** Parse an expression once for reuse. Unlike `evaluate()`, does not touch the parse cache. */
export function compile<const Expr extends string>(expression: Expr): CompiledExpression<Expr> {
  return new CompiledExpression(expression)
}

/** An expression as text or already compiled, with any literal type. */
// biome-ignore lint/suspicious/noExplicitAny: accepts any literal-typed CompiledExpression
export type AnyExpression = string | CompiledExpression<any>

/** Default parse-cache capacity, matching Firely's FhirPathCompilerCache default. */
export const DEFAULT_PARSE_CACHE_SIZE = 500

/** A parse cache: expression text → its CompiledExpression. */
export type ParseCache = LruCache<CompiledExpression>

/** Build a parse cache. `size` 0 keeps only the newest entry; use it to effectively disable reuse. */
export function createParseCache(size: number = DEFAULT_PARSE_CACHE_SIZE): ParseCache {
  return new LruCache<CompiledExpression>(size)
}

const defaultParseCache = createParseCache()

/**
 * Parse an expression, reusing the result from `cache` when present. Pass an
 * engine's private cache to isolate it; omit for the shared module-level cache
 * used by the free `evaluate()`. An already-compiled expression is returned as-is.
 */
export function cachedCompile(
  expression: AnyExpression,
  cache: ParseCache = defaultParseCache
): CompiledExpression<string> {
  if (typeof expression !== 'string') {
    return expression
  }
  let cached = cache.get(expression)
  if (!cached) {
    cached = new CompiledExpression(expression)
    cache.set(expression, cached)
  }
  return cached
}
