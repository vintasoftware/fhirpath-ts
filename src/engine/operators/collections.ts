import { FhirPathRuntimeError } from '../../errors.ts'
import { SYSTEM_BOOLEAN, type TypedValue } from '../../values/typed-value.ts'
import { pairEquals } from './equality.ts'
import { binaryOperators } from './index.ts'

/** Merge with duplicate elimination using `=` semantics (spec §6.4.1 / `union()`). */
export function unionCollections(left: TypedValue[], right: TypedValue[]): TypedValue[] {
  const result: TypedValue[] = []
  for (const item of [...left, ...right]) {
    if (!result.some(existing => pairEquals(existing, item) === true)) {
      result.push(item)
    }
  }
  return result
}

/** `in`: left singleton membership; empty left → empty, empty right → false. */
function inOperator(_context: unknown, left: TypedValue[], right: TypedValue[]): TypedValue[] {
  if (left.length === 0) {
    return []
  }
  if (left.length > 1) {
    throw new FhirPathRuntimeError("The left operand of 'in' must have at most one item")
  }
  const item = left[0] as TypedValue
  const found = right.some(candidate => pairEquals(item, candidate) === true)
  return [{ type: SYSTEM_BOOLEAN, value: found }]
}

binaryOperators.set('|', (_context, left, right) => unionCollections(left, right))
binaryOperators.set('in', inOperator)
binaryOperators.set('contains', (context, left, right) => inOperator(context, right, left))
