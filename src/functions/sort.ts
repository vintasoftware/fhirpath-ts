import type { EvaluationContext } from '../engine/context.ts'
import { withFrame } from '../engine/context.ts'
import { compareValues } from '../engine/operators/comparison.ts'
import type { AstNode, FunctionCallNode } from '../parser/ast.ts'
import { singleton } from '../values/collection.ts'
import type { TypedValue } from '../values/typed-value.ts'
import type { NodeEvaluator } from './iteration.ts'
import { registerFunction } from './registry.ts'

interface SortKey {
  expression: AstNode | undefined
  descending: boolean
}

/**
 * The keys of a `sort()` call. A key ends with `asc` or `desc`, or is
 * ascending. Without a qualifier, a key written as `-key` sorts `key`
 * descending, an engine extension that also orders Strings and dates.
 */
export function sortKeys(node: Pick<FunctionCallNode, 'args' | 'directions'>): SortKey[] {
  return node.args.map((argument, index) => {
    const direction = node.directions?.[index]
    if (direction !== undefined) {
      return { expression: argument, descending: direction === 'desc' }
    }
    return argument.kind === 'unary' && argument.operator === '-'
      ? { expression: argument.operand, descending: true }
      : { expression: argument, descending: false }
  })
}

/**
 * sort([key [asc | desc], ...]) (FHIRPath 3.0.0, trial use). No keys sorts by
 * value. An empty key sorts before every other value, and keys that compare
 * as empty count as equal, so the next key or the input order decides.
 */
registerFunction('sort', {
  minArity: 0,
  // The spec puts no limit on sort keys; 8 is a practical cap for arity checking.
  maxArity: 8,
  evaluate: (context, input, args, evaluateNode, call) => {
    const keys: SortKey[] = args.length ? sortKeys(call) : [{ expression: undefined, descending: false }]
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
  const value =
    expression === undefined
      ? item
      : withFrame(context, { thisValue: [item], hidesIndex: 'sort' }, frameContext =>
          singleton(evaluateNode(expression, frameContext, [item]))
        )
  // A primitive present only through its _field sibling has no value to order by.
  return value?.value === undefined ? undefined : value
}

function compareKey(a: TypedValue | undefined, b: TypedValue | undefined, descending: boolean): number {
  // Empty keys sort before present ones (ascending); descending reverses everything.
  const comparison =
    a === undefined || b === undefined
      ? (a === undefined ? 0 : 1) - (b === undefined ? 0 : 1)
      : (compareValues(a, b) ?? 0)
  return descending ? -comparison : comparison
}
