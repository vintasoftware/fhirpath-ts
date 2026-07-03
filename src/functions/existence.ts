import { pairEquals } from '../engine/operators/equality'
import { FhirPathTypeError } from '../errors'
import type { AstNode } from '../parser/ast'
import { booleanSingleton, wrapBoolean } from '../values/collection'
import { SYSTEM_BOOLEAN, SYSTEM_INTEGER, type TypedValue } from '../values/typed-value'
import { perItem } from './iteration'
import { registerFunction } from './registry'

registerFunction('empty', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => wrapBoolean(input.length === 0),
})

registerFunction('exists', {
  minArity: 0,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    if (args.length === 0) {
      return wrapBoolean(input.length > 0)
    }
    let found = false
    perItem(context, input, args[0] as AstNode, evaluateNode, (_item, result) => {
      found = found || booleanSingleton(result) === true
    })
    return wrapBoolean(found)
  },
})

registerFunction('all', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    let all = true
    perItem(context, input, args[0] as AstNode, evaluateNode, (_item, result) => {
      all = all && booleanSingleton(result) === true
    })
    return wrapBoolean(all)
  },
})

function booleanAggregate(name: string, fold: (values: boolean[]) => boolean) {
  registerFunction(name, {
    minArity: 0,
    maxArity: 0,
    evaluate: (_context, input) => {
      const values = input.map(item => {
        if (item.type !== SYSTEM_BOOLEAN) {
          throw new FhirPathTypeError(`${name}() expects a collection of booleans, found ${item.type}`)
        }
        return item.value as boolean
      })
      return wrapBoolean(fold(values))
    },
  })
}

booleanAggregate('allTrue', values => values.every(value => value))
booleanAggregate('anyTrue', values => values.some(value => value))
booleanAggregate('allFalse', values => values.every(value => !value))
booleanAggregate('anyFalse', values => values.some(value => !value))

registerFunction('count', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => [{ type: SYSTEM_INTEGER, value: input.length }],
})

/** Duplicate elimination with `=` semantics; shared with the `|` operator and isDistinct(). */
export function distinctItems(input: TypedValue[]): TypedValue[] {
  const result: TypedValue[] = []
  for (const item of input) {
    if (!result.some(existing => pairEquals(existing, item) === true)) {
      result.push(item)
    }
  }
  return result
}

registerFunction('distinct', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => distinctItems(input),
})

registerFunction('isDistinct', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => wrapBoolean(distinctItems(input).length === input.length),
})

registerFunction('subsetOf', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const other = evaluateNode(args[0] as AstNode, context, input)
    return wrapBoolean(input.every(item => other.some(candidate => pairEquals(item, candidate) === true)))
  },
})

registerFunction('supersetOf', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const other = evaluateNode(args[0] as AstNode, context, input)
    return wrapBoolean(other.every(item => input.some(candidate => pairEquals(item, candidate) === true)))
  },
})
