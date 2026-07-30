import type { CustomFunctionSignature } from '../analyzer/signatures.ts'
import { createContext, type HostFunction, type RegexEngine } from '../engine/context.ts'
import { evaluateNode } from '../engine/evaluator.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { AstNode } from '../parser/ast.ts'
import { parse } from '../parser/parser.ts'
import { printExpression } from '../parser/printer.ts'
import type { FhirpathInput, FhirpathResult } from '../typed/infer.ts'
import { toCollection, type TypedValue, unwrap } from '../values/typed-value.ts'
import { LruCache } from './cache.ts'

/**
 * A host-supplied FHIRPath function, HAPI-style triple: `minArity`/`maxArity`
 * resolve it, the optional `signature` lets the static analyzer check it
 * (pass the same record to AnalyzeOptions.functions), and `fn` executes it.
 * Plain JS values cross the boundary in both directions; arguments are eager.
 * Built-in names cannot be overridden.
 */
export interface CustomFunction extends HostFunction {
  /** Analyzer signature: without it, expressions using this function analyze as unknown regions. */
  signature?: CustomFunctionSignature
}

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
  /** Host-supplied functions by name. Declare them to the analyzer too via AnalyzeOptions.functions. */
  functions?: Record<string, CustomFunction>
  /**
   * Regex engine for matches()/matchesFull()/replaceMatches(). The default is
   * the built-in RegExp, which backtracks and cannot be timed out — supply a
   * linear-time engine (e.g. an RE2 binding) when evaluating untrusted
   * expressions (see README, Security).
   */
  regex?: RegexEngine
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
      functions: options?.functions,
      regex: options?.regex,
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any literal-typed CompiledExpression
export type AnyExpression = string | CompiledExpression<any>

/** Default for `EngineOptions.cacheSize`, matching Firely's FhirPathCompilerCache default. */
export const DEFAULT_PARSE_CACHE_SIZE = 500

/**
 * Parses an expression, reusing an earlier parse of the same text while it is
 * still cached. An already-compiled expression passes through untouched.
 */
export type Compiler = (expression: AnyExpression) => CompiledExpression<string>

/**
 * A compiler over its own LRU of `capacity` distinct expression texts (`0`
 * caches nothing). Each owner holds one — every `FhirPathEngine`, and the free
 * `evaluate()` — so parses are never reused across them.
 */
export function createCachedCompiler(capacity: number = DEFAULT_PARSE_CACHE_SIZE): Compiler {
  const cache = new LruCache<CompiledExpression>(capacity)
  return expression => {
    if (typeof expression !== 'string') {
      return expression
    }
    let compiled = cache.get(expression)
    if (!compiled) {
      compiled = new CompiledExpression(expression)
      cache.set(expression, compiled)
    }
    return compiled
  }
}
