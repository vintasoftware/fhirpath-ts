import { FhirPathTypeError } from '../errors'
import type { AstNode } from '../parser/ast'
import { singleton } from '../values/collection'
import { Temporal } from '../values/datetime'
import { Decimal } from '../values/decimal'
import {
  type QuantityValue,
  SYSTEM_DATE,
  SYSTEM_DATETIME,
  SYSTEM_DECIMAL,
  SYSTEM_INTEGER,
  SYSTEM_LONG,
  SYSTEM_QUANTITY,
  SYSTEM_TIME,
} from '../values/typed-value'
import { registerFunction } from './registry'

type Edge = 'low' | 'high'

/** Decimal boundary: the range of values that would round to this one, widened to `targetScale`. */
function decimalBoundary(value: Decimal, edge: Edge, targetScale: number): Decimal {
  const halfStep = new Decimal(5n, value.scale + 1)
  const boundary = edge === 'low' ? value.subtract(halfStep) : value.add(halfStep)
  return boundary.withScale(Math.max(targetScale, boundary.scale))
}

/** Digit count of the value's text form, timezone excluded — the spec's precision measure. */
function temporalPrecisionDigits(value: Temporal): number {
  const text = value.toString().replace(/(Z|[+-]\d{2}:\d{2})$/, '')
  return (text.match(/\d/g) ?? []).length
}

/**
 * Widen a partial date/time to its earliest ('low') or latest ('high') possible
 * moment, down to the component that `targetDigits` reaches (17 = milliseconds).
 */
function temporalBoundary(value: Temporal, edge: Edge, targetDigits: number | undefined): Temporal | undefined {
  const isTime = value.kind === 'time'
  const digits = targetDigits ?? (isTime ? 9 : 17)
  const low = edge === 'low'
  const year = value.year
  let month = value.month
  let day = value.day
  let hour = value.hour
  let minute = value.minute
  let second = value.second
  let fraction = value.fraction
  // Digit counts as components fill in: date 4/6/8, then time 2 per component +3 ms.
  const dateDigits = isTime ? 0 : 8
  if (!isTime) {
    if (digits >= 6 && month === undefined) {
      month = low ? 1 : 12
    }
    if (digits >= 8 && day === undefined && month !== undefined) {
      day = low ? 1 : daysInMonth(year as number, month)
    }
  }
  if (digits >= dateDigits + 2 && hour === undefined && (isTime || value.kind === 'dateTime')) {
    hour = low ? 0 : 23
  }
  if (digits >= dateDigits + 4 && minute === undefined && hour !== undefined) {
    minute = low ? 0 : 59
  }
  if (digits >= dateDigits + 6 && second === undefined && minute !== undefined) {
    second = low ? 0 : 59
  }
  if (digits >= dateDigits + 9 && fraction === undefined && second !== undefined) {
    fraction = low ? '000' : '999'
  }
  return Temporal.fromFields(value.kind, {
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    timezoneOffsetMinutes: value.timezoneOffsetMinutes,
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
        if (argument === undefined || typeof argument.value !== 'number' || argument.value < 0) {
          throw new FhirPathTypeError(`${name}() expects a non-negative integer precision`)
        }
        precision = argument.value
      }
      switch (item.type) {
        case SYSTEM_INTEGER:
        case SYSTEM_LONG:
          return [item]
        case SYSTEM_DECIMAL:
          return [{ type: SYSTEM_DECIMAL, value: decimalBoundary(item.value as Decimal, edge, precision ?? 8) }]
        case SYSTEM_QUANTITY: {
          const quantity = item.value as QuantityValue
          return [
            {
              type: SYSTEM_QUANTITY,
              value: { ...quantity, value: decimalBoundary(quantity.value, edge, precision ?? 8) },
            },
          ]
        }
        case SYSTEM_DATE:
        case SYSTEM_DATETIME:
        case SYSTEM_TIME: {
          const boundary = temporalBoundary(item.value as Temporal, edge, precision)
          return boundary === undefined ? [] : [{ type: item.type, value: boundary }]
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
    switch (item.type) {
      case SYSTEM_DECIMAL:
        return [{ type: SYSTEM_INTEGER, value: (item.value as Decimal).scale }]
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
