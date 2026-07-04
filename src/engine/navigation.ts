import { FhirPathTypeError } from '../errors.ts'
import { readModelProperty } from '../fhir/model-navigation.ts'
import { OBJECT_TYPE, type TypedValue, toTypedValue } from '../values/typed-value.ts'
import type { EvaluationContext } from './context.ts'

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
        // Choice elements go by stem name; a suffixed key like Observation.valueQuantity
        // is the one unknown-element shape the official suites require to error at
        // runtime. Everything else is the static analyzer's job (spec §11) — plain
        // unknown elements navigate to empty, and types the model has never heard of
        // (custom resourceTypes) read like raw JSON.
        if (isChoiceKeyMisuse(context, item.type, name)) {
          throw new FhirPathTypeError(
            `Element '${name}' is not defined on ${item.type}; choice elements use their stem name`
          )
        }
        if (
          name === 'resourceType' ||
          (context.model.listElements !== undefined && context.model.listElements(item.type) === undefined)
        ) {
          results.push(...getProperty(item, name))
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

/** True for `valueQuantity`-style keys whose stem is a choice element of the type. */
function isChoiceKeyMisuse(context: EvaluationContext, type: string, name: string): boolean {
  const model = context.model as NonNullable<EvaluationContext['model']>
  for (let position = 1; position < name.length; position++) {
    if (!/[A-Z]/.test(name[position] as string)) {
      continue
    }
    const stem = name.slice(0, position)
    if (model.getElement(type, stem)?.isChoice === true) {
      return true
    }
  }
  return false
}

function matchesTypeName(context: EvaluationContext, item: TypedValue, name: string): boolean {
  // Only the namespace strips off: the backbone type FHIR.ValueSet.expansion.contains
  // must not answer to the element name 'contains'. Lowercase primitive type names
  // (FHIR.code) never self-match either — `children().code` means the element.
  if (!/^[A-Z]/.test(name)) {
    // Lowercase names are always elements: `children().code` never filters by the
    // primitive type FHIR.code.
    return false
  }
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
  // Own properties only: `Patient.constructor` or `x.toString` must be empty, not
  // an inherited member leaking off Object.prototype.
  if (!Object.hasOwn(value, name)) {
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
