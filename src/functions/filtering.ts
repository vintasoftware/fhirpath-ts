import { pairEquals } from '../engine/operators/equality.ts'
import { isKnownTypeName, itemMatchesType } from '../engine/type-matching.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import { booleanSingleton, singleton, wrapBoolean } from '../values/collection.ts'
import type { Decimal } from '../values/decimal.ts'
import { asNumeric } from '../values/numeric.ts'
import { SYSTEM_BOOLEAN, SYSTEM_STRING, systemTypeOf, type TypedValue } from '../values/typed-value.ts'
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
 * The most items repeat() and repeatAll() collect before they fail. Cycles in
 * data stop repeat() by deduplication, but a projection can keep producing new
 * values (`1.repeat($this + 1)`), and only this limit ends that loop. repeatAll()
 * keeps duplicates, so for it the limit also ends a projection that returns the
 * same value forever (`'abc'.repeatAll(replace('a', 'A'))`).
 */
export const MAX_REPEAT_ITEMS = 10_000

registerFunction('repeat', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const expression = argAt(args, 0)
    const collected = new DistinctItems()
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
        if (collected.add(item)) {
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

/**
 * repeatAll() (FHIRPath 3.0.0, trial use): repeat() without the equality check.
 * Every projected item goes to the output and to the next round's queue.
 */
registerFunction('repeatAll', {
  minArity: 1,
  maxArity: 1,
  evaluate: (context, input, args, evaluateNode) => {
    const expression = argAt(args, 0)
    const collected: TypedValue[] = []
    let current = input
    while (current.length > 0) {
      const produced: TypedValue[] = []
      perItem(context, current, expression, evaluateNode, (_item, projected) => {
        if (collected.length + produced.length + projected.length > MAX_REPEAT_ITEMS) {
          throw new FhirPathRuntimeError(
            `repeatAll() collected more than ${MAX_REPEAT_ITEMS} items; the projection may never stop producing values`
          )
        }
        for (const item of projected) {
          produced.push(item)
        }
      })
      for (const item of produced) {
        collected.push(item)
      }
      current = produced
    }
    return collected
  },
})

/**
 * Items kept distinct by `existing.value === item.value || existing = item`.
 * Indexes keep the common checks constant-time: a set of raw values answers `===`
 * and String/Boolean equality, and a set of canonical decimals answers equality
 * between numbers. The rest (temporal, quantity, complex) is compared one by one,
 * against numbers too, because a number can equal a Quantity with unit '1'.
 */
class DistinctItems {
  readonly items: TypedValue[] = []
  private readonly values = new Set<unknown>()
  private readonly numbers = new Set<string>()
  private readonly numberItems: TypedValue[] = []
  private readonly others: TypedValue[] = []

  /** Adds the item unless an equal one is present; true when added. */
  add(item: TypedValue): boolean {
    if (this.values.has(item.value)) {
      return false
    }
    const type = systemTypeOf(item)
    const numeric = item.value === undefined ? undefined : asNumeric(item)
    if (item.value === undefined || type === SYSTEM_STRING || type === SYSTEM_BOOLEAN) {
      // Equality here is `===`, which the value set already answered. A valueless
      // primitive equals nothing else.
    } else if (numeric !== undefined) {
      const key = canonicalDecimal(numeric.value)
      if (this.numbers.has(key) || this.matchesAny(this.others, item)) {
        return false
      }
      this.numbers.add(key)
      this.numberItems.push(item)
    } else {
      if (this.matchesAny(this.others, item) || this.matchesAny(this.numberItems, item)) {
        return false
      }
      this.others.push(item)
    }
    this.values.add(item.value)
    this.items.push(item)
    return true
  }

  private matchesAny(candidates: TypedValue[], item: TypedValue): boolean {
    return candidates.some(existing => pairEquals(existing, item) === true)
  }
}

function canonicalDecimal(value: Decimal): string {
  const trimmed = value.trimTrailingZeros()
  return `${trimmed.digits}e${trimmed.scale}`
}

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
    return itemMatchesType(context, item, parts, { exact: true, cast: true }) ? [item] : []
  },
})
