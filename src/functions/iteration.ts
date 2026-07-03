import { type EvaluationContext, withFrame } from '../engine/context.ts'
import type { AstNode } from '../parser/ast.ts'
import type { TypedValue } from '../values/typed-value.ts'

export type NodeEvaluator = (node: AstNode, context: EvaluationContext, input: TypedValue[]) => TypedValue[]

/** Evaluate `expression` once per item with `$this` and `$index` bound. */
export function perItem(
  context: EvaluationContext,
  input: TypedValue[],
  expression: AstNode,
  evaluateNode: NodeEvaluator,
  each: (item: TypedValue, result: TypedValue[], index: number) => void
): void {
  input.forEach((item, index) => {
    const result = withFrame(context, { thisValue: [item], index }, frameContext =>
      evaluateNode(expression, frameContext, [item])
    )
    each(item, result, index)
  })
}
