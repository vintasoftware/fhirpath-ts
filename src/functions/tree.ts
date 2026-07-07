import { pairEquals } from '../engine/operators/equality.ts'
import { readModelProperty } from '../fhir/model-navigation.ts'
import type { ModelProvider } from '../model/provider.ts'
import { SYSTEM_BOOLEAN, SYSTEM_STRING, systemTypeOf, type TypedValue, toTypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'

/**
 * All immediate child nodes of an item. `resourceType` is a JSON discriminator, not
 * an element, and `_field` keys are primitive-extension metadata handled elsewhere.
 */
export function childrenOf(item: TypedValue, model?: ModelProvider): TypedValue[] {
  const value = item.value
  if (typeof value !== 'object' || value === null) {
    // A primitive's children are its element id and extensions (FHIR spec).
    return primitiveMetadataChildren(item)
  }
  // With a model, children keep their element types (so `code as Coding` works
  // downstream) and elements present only through a _field sibling still appear.
  if (model && item.type.startsWith(`${model.namespace}.`)) {
    const elements = model.listElements?.(item.type)
    if (elements !== undefined) {
      const typed: TypedValue[] = []
      for (const element of elements) {
        typed.push(...(readModelProperty(model, item, element) ?? []))
      }
      return typed
    }
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

function primitiveMetadataChildren(item: TypedValue): TypedValue[] {
  const metadata = item.primitiveElement as { id?: unknown; extension?: unknown } | undefined
  if (metadata === undefined || metadata === null) {
    return []
  }
  const result: TypedValue[] = []
  if (metadata.id !== undefined && metadata.id !== null) {
    result.push({ type: 'System.String', value: metadata.id })
  }
  if (Array.isArray(metadata.extension)) {
    result.push(...metadata.extension.map(extension => ({ type: 'FHIR.Extension', value: extension })))
  }
  return result
}

registerFunction('children', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => input.flatMap(item => childrenOf(item, context.model)),
})

registerFunction('descendants', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => {
    // repeat(children()): collect transitively, excluding the input itself. The
    // dedup granularity differs from repeat() on purpose and is pinned by the
    // official suites: descendants() keeps `=`-equal siblings produced in the same
    // round (a batch filter against prior rounds only), where repeat() collapses
    // them (incremental within-round dedup). They cannot share one closure.
    //
    // Dedup is `existing.value === item.value || pairEquals(existing, item)` against
    // prior rounds, indexed for O(1) on the common case: `seenValues` (a Set of raw
    // values) resolves the `===` branch, and it also covers `pairEquals` for
    // String/Boolean, whose equality *is* `===`. The remaining classes (numeric,
    // temporal, quantity, complex) can be pairEquals-equal without being `===`-equal,
    // so those fall back to a scan of same-class prior items. The index updates only
    // between rounds, preserving the batch semantics.
    const collected: TypedValue[] = []
    const seenValues = new Set<unknown>()
    const fallback: TypedValue[] = []
    const needsFallback = (item: TypedValue): boolean => {
      const type = systemTypeOf(item)
      return type !== SYSTEM_STRING && type !== SYSTEM_BOOLEAN
    }
    const isDuplicate = (item: TypedValue): boolean => {
      if (seenValues.has(item.value)) {
        return true
      }
      return needsFallback(item) && fallback.some(existing => pairEquals(existing, item) === true)
    }
    let current = input.flatMap(item => childrenOf(item, context.model))
    while (current.length > 0) {
      const fresh = current.filter(item => !isDuplicate(item))
      for (const item of fresh) {
        seenValues.add(item.value)
        if (needsFallback(item)) {
          fallback.push(item)
        }
      }
      collected.push(...fresh)
      current = fresh.flatMap(item => childrenOf(item, context.model))
    }
    return collected
  },
})
