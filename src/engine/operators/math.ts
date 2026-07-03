import { FhirPathTypeError } from '../../errors'
import { singleton } from '../../values/collection'
import { Temporal } from '../../values/datetime'
import type { Decimal } from '../../values/decimal'
import { asNumeric, widerKind, wrapNumeric } from '../../values/numeric'
import { alignQuantities, composeUnits } from '../../values/quantity'
import { addDuration } from '../../values/temporal-arithmetic'
import {
  type QuantityValue,
  SYSTEM_DATE,
  SYSTEM_DATETIME,
  SYSTEM_QUANTITY,
  SYSTEM_STRING,
  SYSTEM_TIME,
  type TypedValue,
} from '../../values/typed-value'
import { binaryOperators, unaryOperators } from './index'

type ArithmeticOperator = '+' | '-' | '*' | '/' | 'div' | 'mod'

function numericArithmetic(operator: ArithmeticOperator, a: TypedValue, b: TypedValue): TypedValue[] {
  const left = asNumeric(a) as NonNullable<ReturnType<typeof asNumeric>>
  const right = asNumeric(b) as NonNullable<ReturnType<typeof asNumeric>>
  let result: Decimal | undefined
  let kind = widerKind(left.kind, right.kind)
  switch (operator) {
    case '+':
      result = left.value.add(right.value)
      break
    case '-':
      result = left.value.subtract(right.value)
      break
    case '*':
      result = left.value.multiply(right.value)
      break
    case '/':
      result = left.value.divide(right.value)
      kind = 'Decimal'
      break
    case 'div':
      result = left.value.integerDivide(right.value)
      kind = kind === 'Decimal' ? 'Integer' : kind
      break
    default:
      result = left.value.modulo(right.value)
      break
  }
  if (result === undefined) {
    return []
  }
  const wrapped = wrapNumeric(result, kind)
  return wrapped === undefined ? [] : [wrapped]
}

function temporalArithmetic(operator: ArithmeticOperator, a: TypedValue, b: TypedValue): TypedValue[] {
  if (operator !== '+' && operator !== '-') {
    throw new FhirPathTypeError(`Operator '${operator}' is not defined for date/time values`)
  }
  const result = addDuration(a.value as Temporal, b.value as QuantityValue, operator === '+' ? 1 : -1)
  return result === undefined ? [] : [{ type: a.type, value: result }]
}

function quantityArithmetic(operator: ArithmeticOperator, a: TypedValue, b: TypedValue): TypedValue[] {
  const left = a.value as QuantityValue
  if (b.type === SYSTEM_QUANTITY) {
    const right = b.value as QuantityValue
    if (operator === '+' || operator === '-') {
      // Convertible units align on the more granular one (spec §6.6); else empty.
      const aligned = alignQuantities(left, right)
      if (!aligned) {
        return []
      }
      const value = operator === '+' ? aligned.left.add(aligned.right) : aligned.left.subtract(aligned.right)
      return [{ type: SYSTEM_QUANTITY, value: { value, unit: aligned.unit, calendar: aligned.calendar } }]
    }
    if (operator === '*' || operator === '/') {
      if (left.calendar || right.calendar) {
        throw new FhirPathTypeError(`Operator '${operator}' is not defined for calendar durations`)
      }
      const value = operator === '*' ? left.value.multiply(right.value) : left.value.divide(right.value)
      if (value === undefined) {
        return []
      }
      const unit = composeUnits(operator, left.unit, right.unit)
      return [{ type: SYSTEM_QUANTITY, value: { value, unit, calendar: false } }]
    }
    throw new FhirPathTypeError(`Operator '${operator}' is not defined for quantities`)
  }
  const scalar = asNumeric(b)
  if (!scalar || (operator !== '*' && operator !== '/')) {
    throw new FhirPathTypeError(`Operator '${operator}' is not defined for these quantity operands`)
  }
  const value = operator === '*' ? left.value.multiply(scalar.value) : left.value.divide(scalar.value)
  return value === undefined ? [] : [{ type: SYSTEM_QUANTITY, value: { ...left, value } }]
}

function isTemporalType(item: TypedValue): boolean {
  return item.type === SYSTEM_DATE || item.type === SYSTEM_DATETIME || item.type === SYSTEM_TIME
}

function arithmeticOperator(operator: ArithmeticOperator) {
  return (_context: unknown, leftInput: TypedValue[], rightInput: TypedValue[]): TypedValue[] => {
    const a = singleton(leftInput)
    const b = singleton(rightInput)
    if (a === undefined || b === undefined) {
      return []
    }
    if (a.type === SYSTEM_STRING || b.type === SYSTEM_STRING) {
      if (operator === '+' && a.type === SYSTEM_STRING && b.type === SYSTEM_STRING) {
        return [{ type: SYSTEM_STRING, value: (a.value as string) + (b.value as string) }]
      }
      throw new FhirPathTypeError(`Operator '${operator}' is not defined for strings`)
    }
    if (isTemporalType(a) && b.type === SYSTEM_QUANTITY) {
      return temporalArithmetic(operator, a, b)
    }
    if (a.type === SYSTEM_QUANTITY) {
      return quantityArithmetic(operator, a, b)
    }
    if (asNumeric(a) && asNumeric(b)) {
      return numericArithmetic(operator, a, b)
    }
    throw new FhirPathTypeError(`Operator '${operator}' is not defined for ${a.type} and ${b.type}`)
  }
}

binaryOperators.set('+', arithmeticOperator('+'))
binaryOperators.set('-', arithmeticOperator('-'))
binaryOperators.set('*', arithmeticOperator('*'))
binaryOperators.set('/', arithmeticOperator('/'))
binaryOperators.set('div', arithmeticOperator('div'))
binaryOperators.set('mod', arithmeticOperator('mod'))

function unaryOperator(sign: 1 | -1) {
  return (_context: unknown, input: TypedValue[]): TypedValue[] => {
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    const numeric = asNumeric(item)
    if (numeric) {
      if (sign === 1) {
        return [item]
      }
      const wrapped = wrapNumeric(numeric.value.negate(), numeric.kind)
      return wrapped === undefined ? [] : [wrapped]
    }
    if (item.type === SYSTEM_QUANTITY) {
      const quantity = item.value as QuantityValue
      return sign === 1 ? [item] : [{ type: SYSTEM_QUANTITY, value: { ...quantity, value: quantity.value.negate() } }]
    }
    throw new FhirPathTypeError(`Unary '${sign === 1 ? '+' : '-'}' is not defined for ${item.type}`)
  }
}

unaryOperators.set('+', unaryOperator(1))
unaryOperators.set('-', unaryOperator(-1))
