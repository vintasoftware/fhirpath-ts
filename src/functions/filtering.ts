import { pairEquals } from '../engine/operators/equality.ts'
import { isKnownTypeName, itemMatchesType } from '../engine/type-matching.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import { booleanSingleton, singleton, wrapBoolean } from '../values/collection.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { perItem } from './iteration.ts'
import { argAt, registerFunction } from './registry.ts'
import { typePartsFromArgument } from './type-specifier.ts'

registerFunction('where', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const result: TypedValue[] = []
    perItem(context, input, argAt(args, 0), evaluateNode, (item, criteria) => {
      if (booleanSingleton(criteria) === true) {
        result.push(item)
      }
    })
    return result
  },
})

registerFunction('select', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const result: TypedValue[] = []
    perItem(context, input, argAt(args, 0), evaluateNode, (_item, projected) => {
      result.push(...projected)
    })
    return result
  },
})

registerFunction('repeat', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const expression = argAt(args, 0)
    const collected: TypedValue[] = []
    let current = input
    while (current.length > 0) {
      const produced: TypedValue[] = []
      perItem(context, current, expression, evaluateNode, (_item, projected) => {
        produced.push(...projected)
      })
      // Only never-seen items continue the loop (including duplicates produced in
      // the same round), so cyclic data terminates and results stay distinct.
      const fresh: typeof produced = []
      for (const item of produced) {
        if (!collected.some(existing => existing.value === item.value || pairEquals(existing, item) === true)) {
          collected.push(item)
          fresh.push(item)
        }
      }
      current = fresh
    }
    return collected
  },
})

/** coalesce(...) — ballot STU: the first argument that evaluates non-empty. */
registerFunction('coalesce', {
  minArity: 0,
  maxArity: 99,
  evaluate: (context, input, args, evaluateNode) => {
    for (const arg of args) {
      const value = evaluateNode(arg, context, input)
      if (value.length > 0) {
        return value
      }
    }
    return []
  },
})

registerFunction('ofType', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args) => {
    const parts = typePartsFromArgument('ofType', argAt(args, 0))
    requireKnownType(context, 'ofType', parts)
    return input.filter(item => itemMatchesType(context, item, parts, { exact: true }))
  },
})

function requireKnownType(context: Parameters<typeof isKnownTypeName>[0], name: string, parts: string[]): void {
  // Without a model there is no authority on type names; stay lenient.
  if (context.model && !isKnownTypeName(context, parts)) {
    throw new FhirPathRuntimeError(`${name}() received an unknown type name '${parts.join('.')}'`)
  }
}

// Deprecated function forms of the `is` and `as` operators (spec §6.3).
registerFunction('is', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args) => {
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    return wrapBoolean(itemMatchesType(context, item, typePartsFromArgument('is', argAt(args, 0))))
  },
})

registerFunction('as', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args) => {
    const parts = typePartsFromArgument('as', argAt(args, 0))
    requireKnownType(context, 'as', parts)
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    return itemMatchesType(context, item, parts, { exact: true }) ? [item] : []
  },
})
