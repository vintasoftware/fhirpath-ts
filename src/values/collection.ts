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

/**
 * Singleton coerced to a boolean, applying the implicit-true rule. Empty →
 * undefined, which the three-valued logic operators need as a distinct answer —
 * do not fold it into `false` here (see `criteriaBoolean`).
 */
export function booleanSingleton(collection: TypedValue[]): boolean | undefined {
  const item = singleton(collection, SYSTEM_BOOLEAN)
  return item === undefined ? undefined : (item.value as boolean)
}

/**
 * The criteria reading of a collection: `booleanSingleton` with empty as
 * `false`, so the answer is always one of two.
 *
 * Two rules stacked, and worth keeping apart. §4.5 supplies the single-item
 * cases and the >1-item error, but its empty case is *empty*, not false — the
 * `?? false` is the calling environment's. FHIR invariants require the
 * expression to evaluate to true, so a constraint that comes back empty has not
 * been satisfied; Subscription criteria and `enableWhen` read it the same way.
 * That convention is what `FhirPathEngine.test()`, `filter()`, a `{ test }`
 * column and a `@criteria` all mean by "the criteria holds" — one function, so
 * a criteria cannot mean two things depending on where it is read.
 *
 * `where()`, `exists()`, `all()` and `iif()` keep their own `=== true` tests.
 * They are arithmetically identical but express spec text about one item, not
 * this convention about a whole expression.
 */
export function criteriaBoolean(collection: TypedValue[]): boolean {
  return booleanSingleton(collection) ?? false
}

export function wrapBoolean(value: boolean | undefined): TypedValue[] {
  return value === undefined ? [] : [{ type: SYSTEM_BOOLEAN, value }]
}
