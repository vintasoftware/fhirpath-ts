import { EqualityIndex } from '../engine/operators/equality.ts'
import { readModelProperty, type ReadOrigin, withOrigin } from '../fhir/model-navigation.ts'
import type { ModelProvider } from '../model/provider.ts'
import { toTypedValue, type TypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'

/**
 * All immediate child nodes of an item. `resourceType` is a JSON discriminator, not
 * an element, and `_field` keys are primitive-extension metadata handled elsewhere.
 * With `paths`, each child records where it was read (`TypedValue.origin`).
 */
export function childrenOf(item: TypedValue, model?: ModelProvider, paths = false): TypedValue[] {
  const value = item.value
  if (typeof value !== 'object' || value === null) {
    // A primitive's children are its element id and extensions (FHIR spec).
    return primitiveMetadataChildren(item, paths)
  }
  // With a model, children keep their element types (so `code as Coding` works
  // downstream) and elements present only through a _field sibling still appear.
  if (model && item.type.startsWith(`${model.namespace}.`)) {
    const elements = model.listElements?.(item.type)
    if (elements !== undefined) {
      const typed: TypedValue[] = []
      for (const element of elements) {
        typed.push(...(readModelProperty(model, item, element, paths) ?? []))
      }
      return typed
    }
  }
  const result: TypedValue[] = []
  for (const [key, child] of Object.entries(value)) {
    if (key === 'resourceType' || key.startsWith('_') || child === null || child === undefined) {
      continue
    }
    const origin: ReadOrigin | undefined = paths ? { parent: item, name: key } : undefined
    if (Array.isArray(child)) {
      for (const [index, element] of child.entries()) {
        if (element !== null && element !== undefined) {
          result.push(withOrigin(toTypedValue(element), origin, index))
        }
      }
    } else {
      result.push(withOrigin(toTypedValue(child), origin, undefined))
    }
  }
  return result
}

function primitiveMetadataChildren(item: TypedValue, paths: boolean): TypedValue[] {
  const metadata = item.primitiveElement as { id?: unknown; extension?: unknown } | undefined
  if (metadata === undefined || metadata === null) {
    return []
  }
  const result: TypedValue[] = []
  if (metadata.id !== undefined && metadata.id !== null) {
    result.push(
      withOrigin(
        { type: 'System.String', value: metadata.id },
        paths ? { parent: item, name: 'id' } : undefined,
        undefined
      )
    )
  }
  if (Array.isArray(metadata.extension)) {
    const origin: ReadOrigin | undefined = paths ? { parent: item, name: 'extension' } : undefined
    result.push(
      ...metadata.extension.map((extension, index) =>
        withOrigin({ type: 'FHIR.Extension', value: extension }, origin, index)
      )
    )
  }
  return result
}

registerFunction('children', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => input.flatMap(item => childrenOf(item, context.model, context.paths)),
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
    // An item is a duplicate when its value is one seen in a prior round, or it
    // is `=` to a prior item. The index updates only between rounds, preserving
    // the batch semantics.
    const collected = new EqualityIndex()
    const seenValues = new Set<unknown>()
    const isDuplicate = (item: TypedValue): boolean => seenValues.has(item.value) || collected.has(item)
    let current = input.flatMap(item => childrenOf(item, context.model, context.paths))
    while (current.length > 0) {
      const fresh = current.filter(item => !isDuplicate(item))
      for (const item of fresh) {
        seenValues.add(item.value)
        collected.insert(item)
      }
      current = fresh.flatMap(item => childrenOf(item, context.model, context.paths))
    }
    return collected.items
  },
})
