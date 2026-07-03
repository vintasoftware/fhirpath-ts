import type { EvaluationContext } from '../engine/context'
import { withFrame } from '../engine/context'
import { compareValues } from '../engine/operators/comparison'
import type { AstNode } from '../parser/ast'
import { singleton } from '../values/collection'
import type { TypedValue } from '../values/typed-value'
import type { NodeEvaluator } from './iteration'
import { registerFunction } from './registry'

interface SortKey {
  expression: AstNode | undefined
  descending: boolean
}

/** sort([keys...]) — ballot STU. `-key` sorts that key descending; no keys sorts by value. */
registerFunction('sort', {
  minArity: 0,
  maxArity: 8,
  evaluate: (context, input, args, evaluateNode) => {
    const keys: SortKey[] = args.length
      ? args.map(node =>
          node.kind === 'unary' && node.operator === '-'
            ? { expression: node.operand, descending: true }
            : { expression: node, descending: false }
        )
      : [{ expression: undefined, descending: false }]
    const decorated = input.map((item, index) => ({
      item,
      index,
      values: keys.map(key => keyValue(context, item, key.expression, evaluateNode)),
    }))
    decorated.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const comparison = compareKey(a.values[i], b.values[i], (keys[i] as SortKey).descending)
        if (comparison !== 0) {
          return comparison
        }
      }
      return a.index - b.index
    })
    return decorated.map(entry => entry.item)
  },
})

function keyValue(
  context: EvaluationContext,
  item: TypedValue,
  expression: AstNode | undefined,
  evaluateNode: NodeEvaluator
): TypedValue | undefined {
  if (expression === undefined) {
    return item
  }
  return withFrame(context, { thisValue: [item] }, frameContext =>
    singleton(evaluateNode(expression, frameContext, [item]))
  )
}

function compareKey(a: TypedValue | undefined, b: TypedValue | undefined, descending: boolean): number {
  // Empty keys sort after present ones (ascending); descending reverses everything.
  if (a === undefined || b === undefined) {
    const emptiness = (a === undefined ? 1 : 0) - (b === undefined ? 1 : 0)
    return descending ? -emptiness : emptiness
  }
  const comparison = compareValues(a, b) ?? 0
  return descending ? -comparison : comparison
}
