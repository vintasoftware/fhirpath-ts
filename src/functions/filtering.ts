import { EqualityIndex } from '../engine/operators/equality.ts'
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

/**
 * The most items repeat() collects before it fails. Cycles in data stop by
 * deduplication, but a projection can keep producing new values
 * (`1.repeat($this + 1)`), and only this limit ends that loop.
 */
export const MAX_REPEAT_ITEMS = 10_000

registerFunction('repeat', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const expression = argAt(args, 0)
    const collected = new EqualityIndex()
    // The same value counts as seen even where `=` is not true, as for valueless items.
    const seenValues = new Set<unknown>()
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
        if (!seenValues.has(item.value) && collected.add(item)) {
          seenValues.add(item.value)
          fresh.push(item)
        }
      }
      if (collected.items.length > MAX_REPEAT_ITEMS) {
        throw new FhirPathRuntimeError(
          `repeat() collected more than ${MAX_REPEAT_ITEMS} items; the projection may never stop producing new values`
        )
      }
      current = fresh
    }
    return collected.items
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
    return input.filter(item => itemMatchesType(context, item, parts, 'ofType'))
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
    return wrapBoolean(itemMatchesType(context, item, typePartsFromArgument('is', argAt(args, 0)), 'is'))
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
    return itemMatchesType(context, item, parts, 'as') ? [item] : []
  },
})
