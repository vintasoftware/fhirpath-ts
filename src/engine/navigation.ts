import { FhirPathTypeError } from '../errors'
import { readModelProperty } from '../fhir/model-navigation'
import { OBJECT_TYPE, type TypedValue, toTypedValue } from '../values/typed-value'
import type { EvaluationContext } from './context'

/**
 * Evaluate a bare identifier against the input. The spec's root rule (§10.1) applies
 * first: an identifier naming the item's own type yields the item itself, which is
 * how `Patient.name` works when the context is a Patient.
 */
export function navigateIdentifier(context: EvaluationContext, name: string, input: TypedValue[]): TypedValue[] {
  const results: TypedValue[] = []
  for (const item of input) {
    if (matchesTypeName(context, item, name)) {
      results.push(item)
    } else if (context.model && item.type.startsWith(`${context.model.namespace}.`)) {
      const modelRead = readModelProperty(context.model, item, name)
      if (modelRead === undefined) {
        // Unknown elements on model-typed values are semantic errors — this is what
        // rejects `Observation.valueQuantity` (choice elements go by stem name).
        if (name === 'resourceType') {
          results.push(...getProperty(item, name))
        } else {
          throw new FhirPathTypeError(`Element '${name}' is not defined on ${item.type}`)
        }
      } else {
        results.push(...modelRead)
      }
    } else if (context.model) {
      const modelRead = readModelProperty(context.model, item, name)
      results.push(...(modelRead ?? getProperty(item, name)))
    } else {
      results.push(...getProperty(item, name))
    }
  }
  return results
}

function matchesTypeName(context: EvaluationContext, item: TypedValue, name: string): boolean {
  // Only the namespace strips off: the backbone type FHIR.ValueSet.expansion.contains
  // must not answer to the element name 'contains'.
  const separator = item.type.indexOf('.')
  const local = separator === -1 ? item.type : item.type.slice(separator + 1)
  if (local === name && item.type !== OBJECT_TYPE) {
    return true
  }
  if (context.model) {
    const canonical = context.model.resolveType(name)
    if (canonical !== undefined) {
      return context.model.isSubtypeOf(item.type, canonical)
    }
  }
  return false
}

/** Read one child element from a complex value, flattening arrays. Missing → empty. */
export function getProperty(item: TypedValue, name: string): TypedValue[] {
  const value = item.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return []
  }
  const child = (value as Record<string, unknown>)[name]
  if (child === undefined || child === null) {
    return []
  }
  if (Array.isArray(child)) {
    return child.filter(element => element !== null && element !== undefined).map(element => toTypedValue(element))
  }
  return [toTypedValue(child)]
}
