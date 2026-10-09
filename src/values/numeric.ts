import { Decimal } from './decimal.ts'
import { SYSTEM_DECIMAL, SYSTEM_INTEGER, SYSTEM_LONG, systemTypeOf, type TypedValue } from './typed-value.ts'

export type NumericKind = 'Integer' | 'Long' | 'Decimal'

export interface NumericOperand {
  kind: NumericKind
  value: Decimal
}

const INTEGER_MIN = -2147483648n
const INTEGER_MAX = 2147483647n
export const LONG_MIN = -9223372036854775808n
export const LONG_MAX = 9223372036854775807n

/** Read an Integer/Long/Decimal operand as a Decimal, remembering its kind. */
export function asNumeric(item: TypedValue): NumericOperand | undefined {
  switch (systemTypeOf(item)) {
    case SYSTEM_INTEGER:
      return { kind: 'Integer', value: Decimal.fromString(String(item.value as number)) as Decimal }
    case SYSTEM_LONG:
      return { kind: 'Long', value: Decimal.fromString((item.value as bigint).toString()) as Decimal }
    case SYSTEM_DECIMAL:
      return { kind: 'Decimal', value: item.value as Decimal }
    default:
      return undefined
  }
}

/** The wider of two numeric kinds: Decimal > Long > Integer (spec implicit conversion). */
export function widerKind(a: NumericKind, b: NumericKind): NumericKind {
  if (a === 'Decimal' || b === 'Decimal') {
    return 'Decimal'
  }
  if (a === 'Long' || b === 'Long') {
    return 'Long'
  }
  return 'Integer'
}

/**
 * Wrap a numeric result as a value of `kind`. Integer is 32-bit and Long is
 * 64-bit; a whole result outside its kind's range overflows, and an overflow is
 * empty (spec "Math" operators), so this returns undefined. Decimal results
 * pass through unchanged.
 */
export function wrapNumeric(value: Decimal, kind: NumericKind): TypedValue | undefined {
  if (kind === 'Decimal') {
    return { type: SYSTEM_DECIMAL, value }
  }
  const big = BigInt(value.trimTrailingZeros().toString())
  if (kind === 'Integer') {
    return big >= INTEGER_MIN && big <= INTEGER_MAX ? { type: SYSTEM_INTEGER, value: Number(big) } : undefined
  }
  return big >= LONG_MIN && big <= LONG_MAX ? { type: SYSTEM_LONG, value: big } : undefined
}

/** A numeric result as a collection: empty when the computation failed or overflows its kind. */
export function numericResult(value: Decimal | undefined, kind: NumericKind): TypedValue[] {
  const wrapped = value === undefined ? undefined : wrapNumeric(value, kind)
  return wrapped === undefined ? [] : [wrapped]
}

/**
 * An integer literal's value. The grammar's NUMBER rule has no digit limit, so a
 * literal takes the narrowest type that holds it: Integer within 32 bits, then
 * Long, then Decimal. Evaluation and the analyzer both type literals here.
 */
export function integerLiteral(text: string): TypedValue {
  const whole = Decimal.fromString(text) as Decimal
  return wrapNumeric(whole, 'Integer') ?? wrapNumeric(whole, 'Long') ?? { type: SYSTEM_DECIMAL, value: whole }
}

/**
 * The value of unary minus applied directly to an integer literal, read as one
 * negative literal, so `-2147483648` is the Integer minimum rather than the
 * negated Long `2147483648`. Undefined for any other operand.
 */
export function negativeIntegerLiteral(
  operator: string,
  operand: { kind: string; text?: string; isDecimal?: boolean; isLong?: boolean }
): TypedValue | undefined {
  if (operator !== '-' || operand.kind !== 'number' || operand.isDecimal === true || operand.isLong === true) {
    return undefined
  }
  return integerLiteral(`-${operand.text as string}`)
}
