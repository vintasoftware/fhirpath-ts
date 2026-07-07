import { AsyncSuspension } from '../engine/async.ts'
import { createContext } from '../engine/context.ts'
import { evaluateNode } from '../engine/evaluator.ts'
import type { ModelProvider } from '../model/provider.ts'
import type { AstNode } from '../parser/ast.ts'
import { parse } from '../parser/parser.ts'
import { printExpression } from '../parser/printer.ts'
import type { TerminologyProvider } from '../terminology/provider.ts'
import type { FhirpathInput, FhirpathResult } from '../typed/infer.ts'
import { type TypedValue, toCollection, unwrap } from '../values/typed-value.ts'

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
  /**
   * Terminology service behind memberOf(), subsumes()/subsumedBy(), weight(), and
   * the %terminologies API. Providers are async, so these functions require
   * evaluateAsync(); under the sync evaluate() they fail with a pointer to it.
   */
  terminology?: TerminologyProvider
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
      terminology: options?.terminology,
    })
    return evaluateNode(this.ast, context, root)
  }

  /**
   * Evaluate with async providers (options.terminology) available and unwrap
   * results to plain JS values. Expressions that never touch a provider behave
   * exactly like evaluate().
   */
  async evaluateAsync(input?: FhirpathInput<Expr>, options?: EvaluateOptions): Promise<FhirpathResult<Expr>> {
    return (await this.evaluateTypedAsync(input, options)).map(unwrap) as FhirpathResult<Expr>
  }

  /**
   * Async twin of evaluateTyped(), via suspend-and-replay: the sync evaluator
   * runs until a function needs an async provider result the cache lacks, the
   * missing value is awaited, and the evaluation replays. Replays are invisible:
   * the clock is fixed up front and trace output is buffered so only the
   * successful pass reaches the caller's sink. Each replay resolves one request
   * the cache did not have, so the loop terminates — a deterministic evaluation
   * can only suspend finitely often. Provider results are cached by request, so
   * repeated identical calls (and every replay) hit the provider once.
   */
  async evaluateTypedAsync(input?: unknown, options?: EvaluateOptions): Promise<TypedValue[]> {
    const root = toCollection(input)
    const now = options?.now ?? new Date()
    const asyncCache = new Map<string, unknown>()
    const sink = options?.trace
    for (;;) {
      const traces: [string, TypedValue[]][] = []
      const context = createContext({
        root,
        env: options?.env,
        model: options?.model,
        now,
        trace: sink && ((name, values) => traces.push([name, values])),
        terminology: options?.terminology,
        asyncCache,
      })
      try {
        const result = evaluateNode(this.ast, context, root)
        if (sink) {
          for (const [name, values] of traces) {
            sink(name, values)
          }
        }
        return result
      } catch (error) {
        if (!(error instanceof AsyncSuspension)) {
          throw error
        }
        asyncCache.set(error.key, await error.run())
      }
    }
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
