import type { EvaluationContext } from '../engine/context.ts'
import { distinctItems, EqualityIndex } from '../engine/operators/equality.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import type { AstNode } from '../parser/ast.ts'
import { singleton } from '../values/collection.ts'
import { SYSTEM_INTEGER, type TypedValue } from '../values/typed-value.ts'
import type { NodeEvaluator } from './iteration.ts'
import { argAt, registerFunction } from './registry.ts'

registerFunction('single', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    if (input.length > 1) {
      throw new FhirPathRuntimeError(`single() expects at most one item, found ${input.length}`)
    }
    return input
  },
})

registerFunction('first', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => input.slice(0, 1),
})

registerFunction('last', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => input.slice(-1),
})

registerFunction('tail', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => input.slice(1),
})

/** The count argument of skip() and take(); undefined when it is empty or has no value. */
function countArgument(
  context: EvaluationContext,
  input: TypedValue[],
  node: AstNode,
  evaluateNode: NodeEvaluator
): number | undefined {
  const count = singleton(evaluateNode(node, context, input), SYSTEM_INTEGER)?.value
  return typeof count === 'number' ? count : undefined
}

registerFunction('skip', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const count = countArgument(context, input, argAt(args, 0), evaluateNode)
    if (count === undefined) {
      return []
    }
    return count <= 0 ? input : input.slice(count)
  },
})

registerFunction('take', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const count = countArgument(context, input, argAt(args, 0), evaluateNode)
    return count === undefined || count <= 0 ? [] : input.slice(0, count)
  },
})

registerFunction('intersect', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const other = evaluateNode(argAt(args, 0), context, input)
    const others = new EqualityIndex(other)
    return distinctItems(input).filter(item => others.has(item))
  },
})

registerFunction('exclude', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const other = evaluateNode(argAt(args, 0), context, input)
    // Keeps duplicates and order, unlike intersect().
    const others = new EqualityIndex(other)
    return input.filter(item => !others.has(item))
  },
})
