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
 * Wrap a numeric result as the narrowest type that represents it exactly.
 * Integer is 32-bit and Long is 64-bit, so their arithmetic can produce a whole
 * number too large for the type. When that happens, widen to the next integer
 * type that holds the value (Integer → Long → Decimal), but never below the
 * operands' own kind. This keeps the value exact rather than dropping it (empty)
 * or wrapping it around the way some engines do. Decimal results pass through
 * unchanged.
 */
export function wrapNumeric(value: Decimal, kind: NumericKind): TypedValue {
  if (kind === 'Decimal') {
    return { type: SYSTEM_DECIMAL, value }
  }
  const whole = value.trimTrailingZeros()
  const big = BigInt(whole.toString())
  if (kind === 'Integer' && big >= INTEGER_MIN && big <= INTEGER_MAX) {
    return { type: SYSTEM_INTEGER, value: Number(big) }
  }
  if (big >= LONG_MIN && big <= LONG_MAX) {
    return { type: SYSTEM_LONG, value: big }
  }
  return { type: SYSTEM_DECIMAL, value: whole }
}
