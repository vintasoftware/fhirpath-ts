import { FhirPathTypeError } from '../../errors.ts'
import { singleton } from '../../values/collection.ts'
import { Temporal } from '../../values/datetime.ts'
import { asNumeric } from '../../values/numeric.ts'
import { coerceQuantity, compareQuantities } from '../../values/quantity.ts'
import { compareTemporal } from '../../values/temporal-compare.ts'
import { SYSTEM_BOOLEAN, SYSTEM_STRING, systemTypeOf, type TypedValue } from '../../values/typed-value.ts'
import { binaryOperators } from './index.ts'

type ComparisonOperator = '<' | '>' | '<=' | '>='

/**
 * Order two singleton values (spec §6.2). Undefined means empty: an empty operand,
 * a date/time precision mismatch, or units that cannot be compared.
 */
export function compareValues(a: TypedValue, b: TypedValue): number | undefined {
  const numericA = asNumeric(a)
  const numericB = asNumeric(b)
  if (numericA && numericB) {
    return numericA.value.compare(numericB.value)
  }
  if (systemTypeOf(a) === SYSTEM_STRING && systemTypeOf(b) === SYSTEM_STRING) {
    const left = a.value as string
    const right = b.value as string
    if (left < right) {
      return -1
    }
    return left > right ? 1 : 0
  }
  if (a.value instanceof Temporal && b.value instanceof Temporal) {
    const comparison = compareTemporal(a.value, b.value)
    if (comparison === 'differentPrecision') {
      return undefined
    }
    if (comparison === 'incompatible') {
      throw new FhirPathTypeError('Cannot compare a time with a date or dateTime')
    }
    return comparison
  }
  const quantityA = coerceQuantity(a)
  const quantityB = coerceQuantity(b)
  if (quantityA && quantityB) {
    return compareQuantities(quantityA, quantityB)
  }
  throw new FhirPathTypeError(`Cannot compare ${a.type} with ${b.type}`)
}

function comparisonOperator(operator: ComparisonOperator) {
  return (_context: unknown, left: TypedValue[], right: TypedValue[]): TypedValue[] => {
    const a = singleton(left)
    const b = singleton(right)
    if (a === undefined || b === undefined) {
      return []
    }
    const comparison = compareValues(a, b)
    if (comparison === undefined) {
      return []
    }
    let value: boolean
    switch (operator) {
      case '<':
        value = comparison < 0
        break
      case '>':
        value = comparison > 0
        break
      case '<=':
        value = comparison <= 0
        break
      default:
        value = comparison >= 0
        break
    }
    return [{ type: SYSTEM_BOOLEAN, value }]
  }
}

binaryOperators.set('<', comparisonOperator('<'))
binaryOperators.set('>', comparisonOperator('>'))
binaryOperators.set('<=', comparisonOperator('<='))
binaryOperators.set('>=', comparisonOperator('>='))
