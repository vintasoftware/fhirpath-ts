import { Decimal } from './decimal'
import { SYSTEM_DECIMAL, SYSTEM_INTEGER, SYSTEM_LONG, type TypedValue } from './typed-value'

export type NumericKind = 'Integer' | 'Long' | 'Decimal'

export interface NumericOperand {
  kind: NumericKind
  value: Decimal
}

const INTEGER_MIN = -2147483648
const INTEGER_MAX = 2147483647

/** Read an Integer/Long/Decimal operand as a Decimal, remembering its kind. */
export function asNumeric(item: TypedValue): NumericOperand | undefined {
  switch (item.type) {
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

/** Wrap a Decimal result as the given kind; Integer overflow yields empty (undefined). */
export function wrapNumeric(value: Decimal, kind: NumericKind): TypedValue | undefined {
  if (kind === 'Decimal') {
    return { type: SYSTEM_DECIMAL, value }
  }
  const whole = value.trimTrailingZeros()
  if (kind === 'Long') {
    return { type: SYSTEM_LONG, value: BigInt(whole.toString()) }
  }
  const asNumber = whole.toNumber()
  if (asNumber < INTEGER_MIN || asNumber > INTEGER_MAX) {
    return undefined
  }
  return { type: SYSTEM_INTEGER, value: asNumber }
}
