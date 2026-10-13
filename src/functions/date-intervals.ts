import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import { singleton } from '../values/collection.ts'
import { GREGORIAN_UTC_YEAR_OFFSET, Temporal, type TemporalKind } from '../values/datetime.ts'
import { SYSTEM_INTEGER, SYSTEM_STRING, systemTypeOf, type TypedValue } from '../values/typed-value.ts'
import { argAt, registerFunction } from './registry.ts'

/**
 * Date and Time Interval Functions (FHIRPath 3.0.0, trial use):
 * `duration(value, precision)` counts whole calendar periods from the input to
 * `value`, and `difference(value, precision)` counts the period boundaries
 * crossed. Both are negative when the input is after `value`.
 */

type IntervalPrecision = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second' | 'millisecond'

const DATE_PRECISIONS: readonly IntervalPrecision[] = ['year', 'month', 'week', 'day']
const TIME_PRECISIONS: readonly IntervalPrecision[] = ['hour', 'minute', 'second', 'millisecond']
const DATETIME_PRECISIONS: readonly IntervalPrecision[] = [...DATE_PRECISIONS, ...TIME_PRECISIONS]

/** The component a precision needs: 0 = year ... 6 = millisecond. A week is counted in days. */
const PRECISION_LEVELS: Readonly<Record<IntervalPrecision, number>> = {
  year: 0,
  month: 1,
  week: 2,
  day: 2,
  hour: 3,
  minute: 4,
  second: 5,
  millisecond: 6,
}

const MS_PER_DAY = 86_400_000
const MS_PER_UNIT: Readonly<Partial<Record<IntervalPrecision, number>>> = {
  day: MS_PER_DAY,
  hour: 3_600_000,
  minute: 60_000,
  second: 1000,
  millisecond: 1,
}

/** One operand reduced to the components both operands have. */
interface IntervalPoint {
  year: number
  month: number
  /** Milliseconds from the start of the month to this point. */
  withinMonth: number
  /** Milliseconds on a common axis; days start at multiples of MS_PER_DAY. */
  instant: number
}

function intervalFunction(
  name: string,
  count: (start: IntervalPoint, end: IntervalPoint, precision: IntervalPrecision) => number
): void {
  registerFunction(name, {
    minArity: 2,
    maxArity: 2,
    evaluate: (context, input, args, evaluateNode) => {
      const start = temporalOperand(name, 'input', singleton(input))
      const end = temporalOperand(name, 'value argument', singleton(evaluateNode(argAt(args, 0), context, input)))
      const precisionItem = singleton(evaluateNode(argAt(args, 1), context, input))
      if (start === undefined || end === undefined || precisionItem === undefined) {
        return []
      }
      if (systemTypeOf(precisionItem) !== SYSTEM_STRING) {
        throw new FhirPathTypeError(`${name}() expects a String precision, found ${precisionItem.type}`)
      }
      const precision = checkedPrecision(name, start, end, precisionItem.value as string)
      const points = intervalPoints(start, end, PRECISION_LEVELS[precision])
      return points === undefined ? [] : [{ type: SYSTEM_INTEGER, value: count(points[0], points[1], precision) }]
    },
  })
}

function temporalOperand(name: string, role: string, item: TypedValue | undefined): Temporal | undefined {
  if (item === undefined) {
    return undefined
  }
  if (!(item.value instanceof Temporal)) {
    throw new FhirPathTypeError(`${name}() expects a Date, DateTime, or Time ${role}, found ${item.type}`)
  }
  return item.value
}

/**
 * The precisions two operand kinds allow; a Date and a DateTime count as
 * DateTimes. Undefined when the kinds cannot be measured together (a Time and a
 * date). The analyzer checks literal precisions with the same table.
 */
export function intervalPrecisions(
  start: TemporalKind,
  end: TemporalKind
): { kind: string; precisions: readonly string[] } | undefined {
  if ((start === 'time') !== (end === 'time')) {
    return undefined
  }
  if (start === 'time') {
    return { kind: 'Time', precisions: TIME_PRECISIONS }
  }
  return start === 'date' && end === 'date'
    ? { kind: 'Date', precisions: DATE_PRECISIONS }
    : { kind: 'DateTime', precisions: DATETIME_PRECISIONS }
}

function checkedPrecision(name: string, start: Temporal, end: Temporal, precision: string): IntervalPrecision {
  const allowed = intervalPrecisions(start.kind, end.kind)
  if (allowed === undefined) {
    throw new FhirPathTypeError(intervalKindsMessage(name))
  }
  if (!allowed.precisions.includes(precision)) {
    throw new FhirPathRuntimeError(intervalPrecisionMessage(name, precision, allowed))
  }
  return precision as IntervalPrecision
}

/** Time values measure only against Time values. */
export function intervalKindsMessage(name: string): string {
  return `${name}() cannot measure between a Time and a Date or DateTime`
}

export function intervalPrecisionMessage(
  name: string,
  precision: string,
  allowed: { kind: string; precisions: readonly string[] }
): string {
  return `${name}() does not support the precision '${precision}' for ${allowed.kind} values; use one of ${allowed.precisions.map(item => `'${item}'`).join(', ')}`
}

const COMPONENT_LEVELS = ['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond'] as const

/**
 * Both operands at the components they share. Undefined (an empty result) when
 * either is less precise than `required`, or when hour and smaller precisions
 * would compare a value that has a timezone offset with one that has none.
 * Offsets are normalized only for hour and smaller precisions.
 */
function intervalPoints(start: Temporal, end: Temporal, required: number): [IntervalPoint, IntervalPoint] | undefined {
  const shared = Math.min(COMPONENT_LEVELS.indexOf(start.precision), COMPONENT_LEVELS.indexOf(end.precision))
  if (shared < required) {
    return undefined
  }
  const normalize = required >= 3 && start.kind === 'dateTime' && end.kind === 'dateTime'
  if (normalize && (start.timezoneOffsetMinutes === undefined) !== (end.timezoneOffsetMinutes === undefined)) {
    return undefined
  }
  return [point(start, shared, normalize), point(end, shared, normalize)]
}

function point(value: Temporal, level: number, normalize: boolean): IntervalPoint {
  const date = new Date(
    Date.UTC(
      (value.year ?? 1970) + GREGORIAN_UTC_YEAR_OFFSET,
      (level >= 1 ? (value.month ?? 1) : 1) - 1,
      level >= 2 ? (value.day ?? 1) : 1,
      level >= 3 ? (value.hour ?? 0) : 0,
      (level >= 4 ? (value.minute ?? 0) : 0) - (normalize ? (value.timezoneOffsetMinutes ?? 0) : 0),
      level >= 5 ? (value.second ?? 0) : 0,
      level >= 6 ? milliseconds(value.fraction) : 0
    )
  )
  const instant = date.getTime()
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), withinMonth: instant - monthStart, instant }
}

/** The millisecond component, as millisecondOf() reads it. */
function milliseconds(fraction: string | undefined): number {
  return fraction === undefined ? 0 : Number.parseInt(fraction.padEnd(3, '0').slice(0, 3), 10)
}

function monthIndex(value: IntervalPoint): number {
  return value.year * 12 + value.month
}

/** Days since 1970-01-01 (Thursday) on the shifted axis; whole for every point. */
function dayNumber(value: IntervalPoint): number {
  return Math.floor(value.instant / MS_PER_DAY)
}

intervalFunction('duration', (start, end, precision) => {
  if (end.instant < start.instant) {
    // `0 -` rather than unary minus, which turns no whole period into -0.
    return 0 - wholePeriods(end, start, precision)
  }
  return wholePeriods(start, end, precision)
})

/** Whole periods from `start` to a later `end`. */
function wholePeriods(start: IntervalPoint, end: IntervalPoint, precision: IntervalPrecision): number {
  if (precision === 'year' || precision === 'month') {
    // A month counts once the end reaches the same point within its month.
    const months = monthIndex(end) - monthIndex(start) - (end.withinMonth < start.withinMonth ? 1 : 0)
    return precision === 'year' ? Math.trunc(months / 12) : months
  }
  const elapsed = end.instant - start.instant
  return precision === 'week'
    ? Math.trunc(elapsed / (7 * MS_PER_DAY))
    : Math.trunc(elapsed / (MS_PER_UNIT[precision] as number))
}

intervalFunction('difference', (start, end, precision) => {
  switch (precision) {
    case 'year':
      return end.year - start.year
    case 'month':
      return monthIndex(end) - monthIndex(start)
    case 'week':
      // Sunday starts a week. Day 0 is a Thursday, so day + 4 counts from a Sunday.
      return Math.floor((dayNumber(end) + 4) / 7) - Math.floor((dayNumber(start) + 4) / 7)
    default: {
      const unit = MS_PER_UNIT[precision] as number
      return Math.floor(end.instant / unit) - Math.floor(start.instant / unit)
    }
  }
})
