import { readModelProperty, type ReadOrigin, withOrigin } from '../fhir/model-navigation.ts'
import { rootTypeMatches } from '../values/type-compat.ts'
import { toTypedValue, type TypedValue } from '../values/typed-value.ts'
import type { EvaluationContext } from './context.ts'

/**
 * Evaluate a bare identifier against the input. The spec's root rule (§10.1) applies
 * first: an identifier naming the item's own type yields the item itself, which is
 * how `Patient.name` works when the context is a Patient.
 */
export function navigateIdentifier(context: EvaluationContext, name: string, input: TypedValue[]): TypedValue[] {
  const results: TypedValue[] = []
  const paths = context.paths
  for (const item of input) {
    if (rootTypeMatches(context.model, item.type, name)) {
      results.push(item)
    } else if (context.model && item.type.startsWith(`${context.model.namespace}.`)) {
      const modelRead = readModelProperty(context.model, item, name, paths)
      if (modelRead === undefined) {
        // Unknown model elements navigate to empty. Strict evaluation runs the
        // analyzer before reaching this point, including for choice-key misuse.
        // Types the model has never heard of (custom resourceTypes) still read
        // like raw JSON.
        if (
          name === 'resourceType' ||
          (context.model.listElements !== undefined && context.model.listElements(item.type) === undefined)
        ) {
          results.push(...getProperty(item, name, paths))
        }
      } else {
        results.push(...modelRead)
      }
    } else if (context.model) {
      const modelRead = readModelProperty(context.model, item, name, paths)
      results.push(...(modelRead ?? getProperty(item, name, paths)))
    } else {
      results.push(...getProperty(item, name, paths))
    }
  }
  return results
}

/**
 * Read one child element from a complex value, flattening arrays. Missing → empty.
 * With `paths`, each item records where it was read (`TypedValue.origin`).
 */
export function getProperty(item: TypedValue, name: string, paths = false): TypedValue[] {
  const value = item.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return []
  }
  // Own properties only: `Patient.constructor` or `x.toString` must be empty, not
  // an inherited member leaking off Object.prototype.
  if (!Object.hasOwn(value, name)) {
    return []
  }
  const child = (value as Record<string, unknown>)[name]
  if (child === undefined || child === null) {
    return []
  }
  const origin: ReadOrigin | undefined = paths ? { parent: item, name } : undefined
  if (Array.isArray(child)) {
    const results: TypedValue[] = []
    for (const [index, element] of child.entries()) {
      if (element !== null && element !== undefined) {
        results.push(withOrigin(toTypedValue(element), origin, index))
      }
    }
    return results
  }
  return [withOrigin(toTypedValue(child), origin, undefined)]
}
