import { createContext } from '../engine/context'
import { evaluateNode } from '../engine/evaluator'
import type { ModelProvider } from '../model/provider'
import type { AstNode } from '../parser/ast'
import { parse } from '../parser/parser'
import { printExpression } from '../parser/printer'
import { type TypedValue, toCollection, unwrap } from '../values/typed-value'

export interface EvaluateOptions {
  /** Environment variables (`%name`), keyed with or without the leading `%`. */
  env?: Record<string, unknown>
  model?: ModelProvider
  /** Evaluation clock for now()/today()/timeOfDay(); defaults to the real time. */
  now?: Date
}

/** A parsed expression, reusable across inputs. Create via `compile()` or the `fhirpath` tag. */
export class CompiledExpression {
  readonly source: string
  readonly ast: AstNode

  constructor(source: string) {
    this.source = source
    this.ast = parse(source)
  }

  /** Evaluate and unwrap results to plain JS values. */
  evaluate(input?: unknown, options?: EvaluateOptions): unknown[] {
    return this.evaluateTyped(input, options).map(unwrap)
  }

  /** Evaluate keeping the internal typed representation (types, Decimal, Temporal). */
  evaluateTyped(input?: unknown, options?: EvaluateOptions): TypedValue[] {
    const root = toCollection(input)
    const context = createContext({
      root,
      env: options?.env,
      model: options?.model,
      now: options?.now,
    })
    return evaluateNode(this.ast, context, root)
  }

  /** The canonical form of the expression. */
  toString(): string {
    return printExpression(this.ast)
  }
}

/** Parse an expression once for reuse. Unlike `evaluate()`, does not touch the parse cache. */
export function compile(expression: string): CompiledExpression {
  return new CompiledExpression(expression)
}
