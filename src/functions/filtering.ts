import type { EvaluationContext } from '../engine/context.ts'
import { EqualityIndex } from '../engine/operators/equality.ts'
import { isKnownTypeName, itemMatchesType } from '../engine/type-matching.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import type { AstNode } from '../parser/ast.ts'
import { booleanSingleton, singleton, wrapBoolean } from '../values/collection.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { type NodeEvaluator, perItem } from './iteration.ts'
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
 * The most items repeat() and repeatAll() collect before they fail. Cycles in
 * data stop repeat() by deduplication, but a projection can keep producing new
 * values (`1.repeat($this + 1)`), and only this limit ends that loop. repeatAll()
 * keeps duplicates, so for it the limit also ends a projection that returns the
 * same value forever (`'abc'.repeatAll(replace('a', 'A'))`).
 */
export const MAX_REPEAT_ITEMS = 10_000

/**
 * The loop repeat() and repeatAll() share: run the projection on each round's
 * items, keep the results `keep` accepts, and repeat on those until a round
 * keeps nothing.
 */
function repeatProjection(
  name: string,
  context: EvaluationContext,
  input: TypedValue[],
  expression: AstNode,
  evaluateNode: NodeEvaluator,
  keep: (item: TypedValue) => boolean
): TypedValue[] {
  const collected: TypedValue[] = []
  let current = input
  while (current.length > 0) {
    const produced: TypedValue[] = []
    perItem(context, current, expression, evaluateNode, (_item, projected) => {
      for (const item of projected) {
        produced.push(item)
      }
    })
    const kept = produced.filter(keep)
    if (collected.length + kept.length > MAX_REPEAT_ITEMS) {
      throw new FhirPathRuntimeError(
        `${name}() collected more than ${MAX_REPEAT_ITEMS} items; the projection may never stop producing values`
      )
    }
    collected.push(...kept)
    current = kept
  }
  return collected
}

registerFunction('repeat', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const distinct = new EqualityIndex()
    // The same value counts as seen even where `=` is not true, as for valueless items.
    const seenValues = new Set<unknown>()
    // Only never-seen items continue the loop, duplicates within one round
    // included, so cyclic data terminates and results stay distinct.
    return repeatProjection('repeat', context, input, argAt(args, 0), evaluateNode, item => {
      if (seenValues.has(item.value) || !distinct.add(item)) {
        return false
      }
      seenValues.add(item.value)
      return true
    })
  },
})

/**
 * repeatAll() (FHIRPath 3.0.0, trial use): repeat() without the equality check.
 * Every projected item goes to the output and to the next round's queue.
 */
registerFunction('repeatAll', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) =>
    repeatProjection('repeatAll', context, input, argAt(args, 0), evaluateNode, () => true),
})

/** coalesce(...) (FHIRPath 3.0.0, trial use): the first argument that evaluates non-empty. */
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
