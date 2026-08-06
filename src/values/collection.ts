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
 * Singleton evaluation coerced to a boolean, applying the implicit-true rule.
 * Empty returns undefined, which the three-valued logic operators need as an
 * answer distinct from false. Do not turn it into `false` here; see
 * `criteriaBoolean`.
 */
export function booleanSingleton(collection: TypedValue[]): boolean | undefined {
  const item = singleton(collection, SYSTEM_BOOLEAN)
  return item === undefined ? undefined : (item.value as boolean)
}

/**
 * Reads a collection as a criteria: `booleanSingleton` with empty as `false`,
 * so the answer is always true or false.
 *
 * Two rules stack here, and they are worth keeping apart. §4.5 gives the
 * single-item cases and the error for more than one item, but its empty case is
 * empty, not false. The `?? false` comes from the calling environment instead.
 * FHIR invariants require the expression to evaluate to true, so a constraint
 * that returns empty has not been satisfied. Subscription criteria and
 * `enableWhen` read it the same way.
 *
 * That convention is what `FhirPathEngine.test()`, `filter()`, a `{ test }`
 * column, and a `@criteria` all mean by "the criteria holds". Keeping it in one
 * function is what stops a criteria from meaning two things depending on where
 * it is read.
 *
 * `where()`, `exists()`, `all()`, and `iif()` keep their own `=== true` tests.
 * Those produce the same answers, but they state spec text about one item
 * rather than this convention about a whole expression.
 */
export function criteriaBoolean(collection: TypedValue[]): boolean {
  return booleanSingleton(collection) ?? false
}

export function wrapBoolean(value: boolean | undefined): TypedValue[] {
  return value === undefined ? [] : [{ type: SYSTEM_BOOLEAN, value }]
}
