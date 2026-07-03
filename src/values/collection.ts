import { FhirPathRuntimeError } from '../errors.ts'
import { SYSTEM_BOOLEAN, type TypedValue, typeLocalName } from './typed-value.ts'

/**
 * Singleton evaluation of collections, spec §4.5:
 * 1. one item of the expected type → the item;
 * 2. one item, expected type Boolean → `true`;
 * 3. empty → empty (undefined here);
 * 4. more than one item → error.
 */
export function singleton(collection: TypedValue[], expectedType?: string): TypedValue | undefined {
  if (collection.length === 0) {
    return undefined
  }
  if (collection.length > 1) {
    throw new FhirPathRuntimeError(`Expected a collection with at most one item, but found ${collection.length}`)
  }
  const item = collection[0] as TypedValue
  if (expectedType === undefined || matchesExpectedType(item, expectedType)) {
    return item
  }
  if (expectedType === SYSTEM_BOOLEAN) {
    return { type: SYSTEM_BOOLEAN, value: true }
  }
  throw new FhirPathRuntimeError(`Expected a value of type ${expectedType}, but found ${item.type}`)
}

function matchesExpectedType(item: TypedValue, expectedType: string): boolean {
  // Case-insensitive on the local name so FHIR primitives (`boolean`) satisfy System types (`Boolean`).
  return (
    item.type === expectedType || typeLocalName(item.type).toLowerCase() === typeLocalName(expectedType).toLowerCase()
  )
}

/** Singleton coerced to a boolean, applying the implicit-true rule. Empty → undefined. */
export function booleanSingleton(collection: TypedValue[]): boolean | undefined {
  const item = singleton(collection, SYSTEM_BOOLEAN)
  return item === undefined ? undefined : (item.value as boolean)
}

export function wrapBoolean(value: boolean | undefined): TypedValue[] {
  return value === undefined ? [] : [{ type: SYSTEM_BOOLEAN, value }]
}
