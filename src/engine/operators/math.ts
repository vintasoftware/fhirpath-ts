import { FhirPathTypeError } from '../../errors.ts'
import type { UnaryOperator } from '../../parser/ast.ts'
import { singleton } from '../../values/collection.ts'
import { Temporal } from '../../values/datetime.ts'
import type { Decimal } from '../../values/decimal.ts'
import { asNumeric, widerKind, wrapNumeric } from '../../values/numeric.ts'
import {
  alignQuantities,
  calendarToUcumLoose,
  coerceQuantity,
  composeUnits,
  promoteQuantity,
} from '../../values/quantity.ts'
import { addDuration } from '../../values/temporal-arithmetic.ts'
import {
  type QuantityValue,
  SYSTEM_QUANTITY,
  SYSTEM_STRING,
  systemTypeOf,
  type TypedValue,
} from '../../values/typed-value.ts'
import { canonicalizeUnit, sameDimensions } from '../../values/ucum.ts'
import type { BinaryOperatorTable, UnaryOperatorImpl } from './index.ts'

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

function quantityArithmetic(operator: ArithmeticOperator, left: QuantityValue, right: QuantityValue): TypedValue[] {
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
      return calendarMultiplicative(operator, left, right)
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

/**
 * Calendar durations have no general unit algebra, but two cases are exact:
 * scaling by a dimensionless number (2 year * 3 = 6 years, 1 year / 2 = 6 months)
 * and the ratio of two same-family durations (185 months / 185 months = 1 '1').
 * Everything else is undefined → empty.
 */
function calendarMultiplicative(operator: '*' | '/', left: QuantityValue, right: QuantityValue): TypedValue[] {
  if (operator === '/') {
    if (left.calendar) {
      const factor = right.calendar ? undefined : dimensionlessValue(right)
      if (factor !== undefined) {
        // Scaling a duration keeps its calendar unit: 1 year / 2 = 0.5 years.
        const scaled = left.value.divide(factor)
        return scaled === undefined ? [] : [{ type: SYSTEM_QUANTITY, value: { ...left, value: scaled } }]
      }
    }
    // Ratios of durations are well defined; both sides drop to their UCUM twins
    // (185 months / 185 'mo' = 1 '1'), computing through exact canonical factors.
    const leftUcum = calendarAsUcum(left)
    const rightUcum = calendarAsUcum(right)
    const leftCanonical = canonicalizeUnit(leftUcum.unit)
    const rightCanonical = canonicalizeUnit(rightUcum.unit)
    if (leftCanonical && rightCanonical && sameDimensions(leftCanonical, rightCanonical)) {
      const ratio = leftUcum.value
        .multiply(leftCanonical.factor)
        .divide(rightUcum.value.multiply(rightCanonical.factor))
      return ratio === undefined ? [] : [{ type: SYSTEM_QUANTITY, value: { value: ratio, unit: '1', calendar: false } }]
    }
    return quantityArithmetic('/', leftUcum, rightUcum)
  }
  const [calendar, scalar] = left.calendar ? [left, right] : [right, left]
  if (scalar.calendar) {
    // year * year has no meaning.
    return []
  }
  const factor = dimensionlessValue(scalar)
  if (factor === undefined) {
    return []
  }
  const value = calendar.value.multiply(factor)
  return [{ type: SYSTEM_QUANTITY, value: { ...calendar, value } }]
}

/** The scalar value of a dimensionless quantity (2000 'g/kg' → 2); else undefined. */
function dimensionlessValue(quantity: QuantityValue): Decimal | undefined {
  const canonical = canonicalizeUnit(quantity.unit)
  if (!canonical || Object.keys(canonical.dimensions).length > 0) {
    return undefined
  }
  return quantity.value.multiply(canonical.factor)
}

function calendarAsUcum(quantity: QuantityValue): QuantityValue {
  return quantity.calendar ? calendarToUcumLoose(quantity) : quantity
}

function isTemporalType(item: TypedValue): boolean {
  return item.value instanceof Temporal
}

function arithmeticOperator(operator: ArithmeticOperator) {
  return (_context: unknown, leftInput: TypedValue[], rightInput: TypedValue[]): TypedValue[] => {
    const a = singleton(leftInput)
    const b = singleton(rightInput)
    if (a === undefined || b === undefined) {
      return []
    }
    if (systemTypeOf(a) === SYSTEM_STRING || systemTypeOf(b) === SYSTEM_STRING) {
      if (operator === '+' && systemTypeOf(a) === SYSTEM_STRING && systemTypeOf(b) === SYSTEM_STRING) {
        if (a.value === undefined || b.value === undefined) {
          // A primitive present only through its _field sibling has no value; +
          // propagates that like an empty operand.
          return []
        }
        return [{ type: SYSTEM_STRING, value: (a.value as string) + (b.value as string) }]
      }
      throw new FhirPathTypeError(`Operator '${operator}' is not defined for strings`)
    }
    if (isTemporalType(a) && coerceQuantity(b)) {
      return temporalArithmetic(operator, a, { type: SYSTEM_QUANTITY, value: coerceQuantity(b) })
    }
    if (isTemporalType(b) && coerceQuantity(a) && operator === '+') {
      // Addition commutes: 1 year + @2016 works like @2016 + 1 year.
      return temporalArithmetic(operator, b, { type: SYSTEM_QUANTITY, value: coerceQuantity(a) })
    }
    if (asNumeric(a) && asNumeric(b)) {
      return numericArithmetic(operator, a, b)
    }
    if (coerceQuantity(a) || coerceQuantity(b)) {
      const left = promoteQuantity(a)
      const right = promoteQuantity(b)
      if (left && right && operator !== 'div' && operator !== 'mod') {
        return quantityArithmetic(operator, left, right)
      }
      throw new FhirPathTypeError(`Operator '${operator}' is not defined for these quantity operands`)
    }
    throw new FhirPathTypeError(`Operator '${operator}' is not defined for ${a.type} and ${b.type}`)
  }
}

export const arithmeticOperators = {
  '+': arithmeticOperator('+'),
  '-': arithmeticOperator('-'),
  '*': arithmeticOperator('*'),
  '/': arithmeticOperator('/'),
  div: arithmeticOperator('div'),
  mod: arithmeticOperator('mod'),
} satisfies BinaryOperatorTable

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

export const unaryArithmeticOperators: Readonly<Record<UnaryOperator, UnaryOperatorImpl>> = {
  '+': unaryOperator(1),
  '-': unaryOperator(-1),
}
