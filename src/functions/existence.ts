import { DistinctItems, distinctItems } from '../engine/operators/equality.ts'
import { FhirPathTypeError } from '../errors.ts'
import { booleanSingleton, wrapBoolean } from '../values/collection.ts'
import { SYSTEM_BOOLEAN, SYSTEM_INTEGER, systemTypeOf } from '../values/typed-value.ts'
import { perItem } from './iteration.ts'
import { argAt, registerFunction } from './registry.ts'

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
    perItem(context, input, argAt(args, 0), evaluateNode, (_item, result) => {
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
    perItem(context, input, argAt(args, 0), evaluateNode, (_item, result) => {
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
        if (systemTypeOf(item) !== SYSTEM_BOOLEAN) {
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
    const other = evaluateNode(argAt(args, 0), context, input)
    const others = new DistinctItems(other)
    return wrapBoolean(input.every(item => others.has(item)))
  },
})

registerFunction('supersetOf', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const other = evaluateNode(argAt(args, 0), context, input)
    const inputs = new DistinctItems(input)
    return wrapBoolean(other.every(item => inputs.has(item)))
  },
})
