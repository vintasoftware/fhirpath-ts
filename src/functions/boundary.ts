import { FhirPathTypeError } from '../errors.ts'
import type { AstNode } from '../parser/ast.ts'
import { singleton } from '../values/collection.ts'
import { Temporal } from '../values/datetime.ts'
import { Decimal } from '../values/decimal.ts'
import {
  type QuantityValue,
  SYSTEM_DATE,
  SYSTEM_DATETIME,
  SYSTEM_DECIMAL,
  SYSTEM_INTEGER,
  SYSTEM_QUANTITY,
  SYSTEM_TIME,
  systemTypeOf,
} from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'

type Edge = 'low' | 'high'

const MAX_DECIMAL_PRECISION = 28
// Spec default for decimal boundaries, and the digit count of a full date (YYYYMMDD).
const DEFAULT_DECIMAL_BOUNDARY_PRECISION = 8
const FULL_DATE_DIGITS = 8
const MAX_DATETIME_DIGITS = 17
const MAX_TIME_DIGITS = 9

/**
 * Decimal boundary: value ± half of the last-digit step, then floored (low) or
 * ceiled (high) to the target precision. Integers behave as scale-0 decimals
 * (`1.lowBoundary(0)` is 0, per the official suite).
 */
function decimalBoundary(value: Decimal, edge: Edge, targetScale: number): Decimal {
  const halfStep = new Decimal(5n, value.scale + 1)
  const boundary = edge === 'low' ? value.subtract(halfStep) : value.add(halfStep)
  if (targetScale >= boundary.scale) {
    return boundary.withScale(targetScale)
  }
  return edge === 'low' ? floorAt(boundary, targetScale) : ceilAt(boundary, targetScale)
}

function floorAt(value: Decimal, scale: number): Decimal {
  const factor = 10n ** BigInt(value.scale - scale)
  let digits = value.digits / factor
  if (value.digits < 0n && value.digits % factor !== 0n) {
    digits -= 1n
  }
  return new Decimal(digits, scale)
}

function ceilAt(value: Decimal, scale: number): Decimal {
  const factor = 10n ** BigInt(value.scale - scale)
  let digits = value.digits / factor
  if (value.digits > 0n && value.digits % factor !== 0n) {
    digits += 1n
  }
  return new Decimal(digits, scale)
}

/** Digit count of the value's text form, timezone excluded — the spec's precision measure. */
function temporalPrecisionDigits(value: Temporal): number {
  const text = value.toString().replace(/(Z|[+-]\d{2}:\d{2})$/, '')
  return (text.match(/\d/g) ?? []).length
}

/**
 * The earliest ('low') or latest ('high') moment a partial date/time may mean:
 * missing components fill with their extremes down to `targetDigits`, components
 * beyond the target truncate away, and a dateTime reaching time precision with no
 * timezone gets the earliest (+14:00) or latest (-12:00) offset.
 */
function temporalBoundary(value: Temporal, edge: Edge, targetDigits: number | undefined): Temporal | undefined {
  const isTime = value.kind === 'time'
  const digits = targetDigits ?? (isTime ? MAX_TIME_DIGITS : MAX_DATETIME_DIGITS)
  if (digits > (isTime ? MAX_TIME_DIGITS : MAX_DATETIME_DIGITS)) {
    return undefined
  }
  const low = edge === 'low'
  const dateDigits = isTime ? 0 : FULL_DATE_DIGITS
  const wantsMonth = !isTime && digits >= 6
  const wantsDay = !isTime && digits >= FULL_DATE_DIGITS
  const wantsHour = digits >= dateDigits + 2 && (isTime || value.kind === 'dateTime')
  const wantsMinute = digits >= dateDigits + 4
  const wantsSecond = digits >= dateDigits + 6
  const wantsFraction = digits >= dateDigits + 9
  const year = value.year
  const month = wantsMonth ? (value.month ?? (low ? 1 : 12)) : undefined
  const day =
    wantsDay && month !== undefined ? (value.day ?? (low ? 1 : daysInMonth(year as number, month))) : undefined
  const hour = wantsHour ? (value.hour ?? (low ? 0 : 23)) : undefined
  const minute = wantsMinute && hour !== undefined ? (value.minute ?? (low ? 0 : 59)) : undefined
  const second = wantsSecond && minute !== undefined ? (value.second ?? (low ? 0 : 59)) : undefined
  const fraction = wantsFraction && second !== undefined ? (value.fraction ?? (low ? '000' : '999')) : undefined
  let timezoneOffsetMinutes = value.timezoneOffsetMinutes
  if (value.kind === 'dateTime' && hour !== undefined && timezoneOffsetMinutes === undefined) {
    timezoneOffsetMinutes = low ? 14 * 60 : -12 * 60
  }
  if (value.kind === 'dateTime' && hour === undefined) {
    timezoneOffsetMinutes = undefined
  }
  const kind = value.kind === 'dateTime' && hour === undefined ? 'date' : value.kind
  return Temporal.fromFields(kind, {
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    timezoneOffsetMinutes,
  })
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year + 400, month, 0)).getUTCDate()
}

function boundaryFunction(name: string, edge: Edge): void {
  registerFunction(name, {
    minArity: 0,
    maxArity: 1,
    evaluate: (context, input, args, evaluateNode) => {
      const item = singleton(input)
      if (item === undefined) {
        return []
      }
      let precision: number | undefined
      if (args.length === 1) {
        const argument = singleton(evaluateNode(args[0] as AstNode, context, input), SYSTEM_INTEGER)
        if (argument === undefined || typeof argument.value !== 'number') {
          throw new FhirPathTypeError(`${name}() expects an integer precision`)
        }
        // Out-of-range precision means the boundary cannot be represented: empty.
        if (argument.value < 0) {
          return []
        }
        precision = argument.value
      }
      switch (systemTypeOf(item) ?? item.type) {
        case SYSTEM_INTEGER:
        case 'System.Long':
        case SYSTEM_DECIMAL: {
          if (precision !== undefined && precision > MAX_DECIMAL_PRECISION) {
            return []
          }
          const value = item.value instanceof Decimal ? item.value : (Decimal.fromString(String(item.value)) as Decimal)
          return [
            {
              type: SYSTEM_DECIMAL,
              value: decimalBoundary(value, edge, precision ?? DEFAULT_DECIMAL_BOUNDARY_PRECISION),
            },
          ]
        }
        case SYSTEM_QUANTITY: {
          if (precision !== undefined && precision > MAX_DECIMAL_PRECISION) {
            return []
          }
          const quantity = item.value as QuantityValue
          return [
            {
              type: SYSTEM_QUANTITY,
              value: {
                ...quantity,
                value: decimalBoundary(quantity.value, edge, precision ?? DEFAULT_DECIMAL_BOUNDARY_PRECISION),
              },
            },
          ]
        }
        case SYSTEM_DATE:
        case SYSTEM_DATETIME:
        case SYSTEM_TIME: {
          const boundary = temporalBoundary(item.value as Temporal, edge, precision)
          if (boundary === undefined) {
            return []
          }
          const type = boundary.kind === 'date' ? SYSTEM_DATE : boundary.kind === 'time' ? SYSTEM_TIME : SYSTEM_DATETIME
          return [{ type, value: boundary }]
        }
        default:
          throw new FhirPathTypeError(`${name}() is not defined for ${item.type}`)
      }
    },
  })
}

boundaryFunction('lowBoundary', 'low')
boundaryFunction('highBoundary', 'high')

registerFunction('precision', {
  minArity: 0,
  maxArity: 0,
  evaluate: (_context, input) => {
    const item = singleton(input)
    if (item === undefined) {
      return []
    }
    switch (systemTypeOf(item) ?? item.type) {
      case SYSTEM_DECIMAL:
        return [
          {
            type: SYSTEM_INTEGER,
            value: item.value instanceof Decimal ? item.value.scale : 0,
          },
        ]
      case SYSTEM_INTEGER:
        return [{ type: SYSTEM_INTEGER, value: 0 }]
      case SYSTEM_DATE:
      case SYSTEM_DATETIME:
      case SYSTEM_TIME:
        return [{ type: SYSTEM_INTEGER, value: temporalPrecisionDigits(item.value as Temporal) }]
      default:
        throw new FhirPathTypeError(`precision() is not defined for ${item.type}`)
    }
  },
})
