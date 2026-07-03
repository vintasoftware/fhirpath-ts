import type { EvaluationContext } from '../engine/context.ts'
import { pairEquals } from '../engine/operators/equality.ts'
import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import type { AstNode } from '../parser/ast.ts'
import { singleton } from '../values/collection.ts'
import { SYSTEM_INTEGER, type TypedValue } from '../values/typed-value.ts'
import { distinctItems } from './existence.ts'
import type { NodeEvaluator } from './iteration.ts'
import { registerFunction } from './registry.ts'

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

function integerArgument(
  name: string,
  context: EvaluationContext,
  input: TypedValue[],
  node: AstNode,
  evaluateNode: NodeEvaluator
): number {
  const value = singleton(evaluateNode(node, context, input), SYSTEM_INTEGER)
  if (value === undefined || typeof value.value !== 'number') {
    throw new FhirPathTypeError(`${name}() expects an integer argument`)
  }
  return value.value
}

registerFunction('skip', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const count = integerArgument('skip', context, input, args[0] as AstNode, evaluateNode)
    return count <= 0 ? input : input.slice(count)
  },
})

registerFunction('take', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const count = integerArgument('take', context, input, args[0] as AstNode, evaluateNode)
    return count <= 0 ? [] : input.slice(0, count)
  },
})

registerFunction('intersect', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const other = evaluateNode(args[0] as AstNode, context, input)
    return distinctItems(input).filter(item => other.some(candidate => pairEquals(item, candidate) === true))
  },
})

registerFunction('exclude', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const other = evaluateNode(args[0] as AstNode, context, input)
    // Keeps duplicates and order, unlike intersect().
    return input.filter(item => !other.some(candidate => pairEquals(item, candidate) === true))
  },
})
