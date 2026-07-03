import { pairEquals } from '../engine/operators/equality'
import { isKnownTypeName, itemMatchesType } from '../engine/type-matching'
import { FhirPathRuntimeError } from '../errors'
import type { AstNode } from '../parser/ast'
import { booleanSingleton, singleton, wrapBoolean } from '../values/collection'
import type { TypedValue } from '../values/typed-value'
import { perItem } from './iteration'
import { registerFunction } from './registry'
import { typePartsFromArgument } from './type-specifier'

registerFunction('where', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const result: TypedValue[] = []
    perItem(context, input, args[0] as AstNode, evaluateNode, (item, criteria) => {
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
    perItem(context, input, args[0] as AstNode, evaluateNode, (_item, projected) => {
      result.push(...projected)
    })
    return result
  },
})

registerFunction('repeat', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const expression = args[0] as AstNode
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

registerFunction('ofType', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args) => {
    const parts = typePartsFromArgument('ofType', args[0] as AstNode)
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
    return wrapBoolean(itemMatchesType(context, item, typePartsFromArgument('is', args[0] as AstNode)))
  },
})

registerFunction('as', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args) => {
    const parts = typePartsFromArgument('as', args[0] as AstNode)
    requireKnownType(context, 'as', parts)
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    return itemMatchesType(context, item, parts, { exact: true }) ? [item] : []
  },
})
