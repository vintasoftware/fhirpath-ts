import { pairEquals } from '../engine/operators/equality.ts'
import { type TypedValue, toTypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'

/**
 * All immediate child nodes of an item. `resourceType` is a JSON discriminator, not
 * an element, and `_field` keys are primitive-extension metadata handled elsewhere.
 */
export function childrenOf(item: TypedValue): TypedValue[] {
  const value = item.value
  if (typeof value !== 'object' || value === null) {
    return []
  }
  const result: TypedValue[] = []
  for (const [key, child] of Object.entries(value)) {
    if (key === 'resourceType' || key.startsWith('_') || child === null || child === undefined) {
      continue
    }
    if (Array.isArray(child)) {
      for (const element of child) {
        if (element !== null && element !== undefined) {
          result.push(toTypedValue(element))
        }
      }
    } else {
      result.push(toTypedValue(child))
    }
  }
  return result
}

registerFunction('children', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => input.flatMap(item => childrenOf(item)),
})

registerFunction('descendants', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    // repeat(children()): collect transitively, excluding the input itself.
    const collected: TypedValue[] = []
    let current = input.flatMap(item => childrenOf(item))
    while (current.length > 0) {
      const fresh = current.filter(
        item => !collected.some(existing => existing.value === item.value || pairEquals(existing, item) === true)
      )
      collected.push(...fresh)
      current = fresh.flatMap(item => childrenOf(item))
    }
    return collected
  },
})
