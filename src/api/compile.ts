import { createContext } from '../engine/context'
import { evaluateNode } from '../engine/evaluator'
import type { ModelProvider } from '../model/provider'
import type { AstNode } from '../parser/ast'
import { parse } from '../parser/parser'
import { printExpression } from '../parser/printer'
import type { FhirpathInput, FhirpathResult } from '../typed/infer'
import { type TypedValue, toCollection, unwrap } from '../values/typed-value'

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
