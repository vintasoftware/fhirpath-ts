import { FhirPathRuntimeError } from '../errors.ts'
import { Temporal, type TemporalPrecision } from './datetime.ts'
import { normalizeCalendarUnit } from './quantity.ts'
import type { QuantityValue } from './typed-value.ts'

/** Position of each precision on the component ladder used for duration conversion. */
const COMPONENT_LEVELS: Readonly<Record<string, number>> = {
  year: 0,
  month: 1,
  day: 2,
  hour: 3,
  minute: 4,
  second: 5,
  millisecond: 6,
}

/** Truncated-division factors for converting a duration one level up (day→month uses 30). */
const UP_CONVERSION_FACTORS = [12, 30, 24, 60, 60, 1000]

const UCUM_TIME_UNITS: Readonly<Record<string, { level: number; multiplier: number }>> = {
  wk: { level: 2, multiplier: 7 },
  d: { level: 2, multiplier: 1 },
  h: { level: 3, multiplier: 1 },
  min: { level: 4, multiplier: 1 },
  s: { level: 5, multiplier: 1 },
  ms: { level: 6, multiplier: 1 },
}

const MS_PER_LEVEL: Readonly<Record<number, number>> = {
  2: 86400000,
  3: 3600000,
  4: 60000,
  5: 1000,
  6: 1,
}

interface Duration {
  /** Component level the duration applies to (0=year ... 6=millisecond). */
  level: number
  /** Amount in that component's unit; may be fractional only at the seconds level. */
  amount: number
}

function resolveDuration(quantity: QuantityValue): Duration {
  // The decimal portion of units above seconds is ignored (spec §6.6.7, official
  // testPlusDate2: 7.7 days adds 7) — truncate before any week/day expansion.
  const value = quantity.value.toNumber()
  const wholeAmount = Math.trunc(value)
  const unit = normalizeCalendarUnit(quantity.unit)
  if (COMPONENT_LEVELS[unit] !== undefined || unit === 'week') {
    if (unit === 'week') {
      return { level: 2, amount: wholeAmount * 7 }
    }
    const level = COMPONENT_LEVELS[unit] as number
    return { level, amount: level >= 5 ? value : wholeAmount }
  }
  if (quantity.calendar) {
    /* v8 ignore next 2 -- the lexer only produces the calendar words above */
    throw new FhirPathRuntimeError(`Unknown calendar duration unit '${quantity.unit}'`)
  }
  const ucum = UCUM_TIME_UNITS[quantity.unit]
  if (!ucum) {
    // The spec reserves UCUM 'a' and 'mo' (definite 365/30-day durations) as errors
    // for calendar arithmetic; calendar words must be used instead.
    throw new FhirPathRuntimeError(
      `Cannot use UCUM unit '${quantity.unit}' for date/time arithmetic; use a calendar duration keyword`
    )
  }
  const amount = ucum.level >= 5 ? value * ucum.multiplier : wholeAmount * ucum.multiplier
  return { level: ucum.level, amount }
}

/** Week is not a real component; it resolves to days before this table is consulted. */
function precisionLevel(precision: TemporalPrecision): number {
  return COMPONENT_LEVELS[precision] as number
}

/**
 * `temporal ± quantity` (spec §6.6.7): the duration converts down to the value's
 * precision with truncation (`@2014 + 23 months` adds 1 year), calendar components
 * roll over, and day-of-month clamps (`@2020-01-31 + 1 month` → `@2020-02-29`).
 * Undefined when the resulting year leaves 0001–9999.
 */
export function addDuration(temporal: Temporal, quantity: QuantityValue, sign: 1 | -1): Temporal | undefined {
  const duration = resolveDuration(quantity)
  // Times have no year/month/day components to add to.
  const dayLevel = 2
  if (temporal.kind === 'time' && duration.level <= dayLevel) {
    throw new FhirPathRuntimeError(`Cannot add a quantity of '${quantity.unit}' to a Time value`)
  }
  let level = duration.level
  let amount = duration.amount * sign
  let targetLevel = Math.min(precisionLevel(temporal.precision), temporal.kind === 'date' ? 2 : 6)
  // Fractional seconds add as milliseconds (R5); millisecond-level additions
  // extend a second-precision value to milliseconds instead of truncating.
  if (level === 5 && !Number.isInteger(amount)) {
    level = 6
    amount = Math.round(amount * 1000)
  }
  if (level === 6 && targetLevel === 5) {
    targetLevel = 6
  }
  while (level > targetLevel) {
    if (level === 2 && targetLevel === 0) {
      // Days convert straight to years; going through 30-day months undercounts.
      amount = Math.trunc(amount / 365)
      level = 0
      break
    }
    amount = Math.trunc(amount / (UP_CONVERSION_FACTORS[level - 1] as number))
    level -= 1
  }
  if (amount === 0) {
    return temporal
  }
  if (level <= 1) {
    return addCalendarComponent(temporal, level, amount)
  }
  return addMilliseconds(temporal, amount * (MS_PER_LEVEL[level] as number))
}

function addCalendarComponent(temporal: Temporal, level: number, amount: number): Temporal | undefined {
  let year = temporal.year as number
  let month = temporal.month
  if (level === 0) {
    year += amount
  } else {
    const zeroBased = (month ?? 1) - 1 + amount
    year += Math.floor(zeroBased / 12)
    month = (((zeroBased % 12) + 12) % 12) + 1
  }
  if (year < 1 || year > 9999) {
    return undefined
  }
  let day = temporal.day
  if (day !== undefined && month !== undefined) {
    day = Math.min(day, daysInMonth(year, month))
  }
  return rebuild(temporal, { year, month, day })
}

function addMilliseconds(temporal: Temporal, deltaMs: number): Temporal | undefined {
  if (temporal.kind === 'time') {
    const baseMs =
      (temporal.hour ?? 0) * 3600000 +
      (temporal.minute ?? 0) * 60000 +
      Math.round(((temporal.second ?? 0) + fractionOf(temporal)) * 1000)
    // Time arithmetic wraps around the day.
    const dayMs = 86400000
    const total = (((baseMs + deltaMs) % dayMs) + dayMs) % dayMs
    return rebuild(temporal, componentsFromDayMs(total, temporal))
  }
  const shifted = new Date(
    Date.UTC(
      (temporal.year as number) + 400,
      (temporal.month ?? 1) - 1,
      temporal.day ?? 1,
      temporal.hour ?? 0,
      temporal.minute ?? 0,
      0,
      Math.round(((temporal.second ?? 0) + fractionOf(temporal)) * 1000) + deltaMs
    )
  )
  const year = shifted.getUTCFullYear() - 400
  if (year < 1 || year > 9999) {
    return undefined
  }
  return rebuild(temporal, {
    year,
    month: temporal.month === undefined ? undefined : shifted.getUTCMonth() + 1,
    day: temporal.day === undefined ? undefined : shifted.getUTCDate(),
    hour: temporal.hour === undefined ? undefined : shifted.getUTCHours(),
    minute: temporal.minute === undefined ? undefined : shifted.getUTCMinutes(),
    second: temporal.second === undefined ? undefined : shifted.getUTCSeconds(),
    fraction:
      temporal.fraction === undefined && shifted.getUTCMilliseconds() === 0
        ? undefined
        : String(shifted.getUTCMilliseconds()).padStart(3, '0'),
  })
}

function componentsFromDayMs(
  totalMs: number,
  temporal: Temporal
): { hour: number; minute?: number | undefined; second?: number | undefined; fraction?: string | undefined } {
  const hour = Math.floor(totalMs / 3600000)
  const minute = Math.floor((totalMs % 3600000) / 60000)
  const second = Math.floor((totalMs % 60000) / 1000)
  const ms = totalMs % 1000
  return {
    hour,
    minute: temporal.minute === undefined ? undefined : minute,
    second: temporal.second === undefined ? undefined : second,
    fraction: temporal.fraction === undefined && ms === 0 ? undefined : String(ms).padStart(3, '0'),
  }
}

function fractionOf(temporal: Temporal): number {
  return temporal.fraction === undefined ? 0 : Number.parseFloat(`0.${temporal.fraction}`)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year + 400, month, 0)).getUTCDate()
}

function rebuild(
  temporal: Temporal,
  overrides: {
    year?: number | undefined
    month?: number | undefined
    day?: number | undefined
    hour?: number | undefined
    minute?: number | undefined
    second?: number | undefined
    fraction?: string | undefined
  }
): Temporal {
  const rebuilt = Temporal.fromFields(temporal.kind, {
    year: 'year' in overrides ? overrides.year : temporal.year,
    month: 'month' in overrides ? overrides.month : temporal.month,
    day: 'day' in overrides ? overrides.day : temporal.day,
    hour: 'hour' in overrides ? overrides.hour : temporal.hour,
    minute: 'minute' in overrides ? overrides.minute : temporal.minute,
    second: 'second' in overrides ? overrides.second : temporal.second,
    fraction: 'fraction' in overrides ? overrides.fraction : temporal.fraction,
    timezoneOffsetMinutes: temporal.timezoneOffsetMinutes,
  })
  /* v8 ignore next 3 -- arithmetic always produces in-range components */
  if (!rebuilt) {
    throw new FhirPathRuntimeError('Date/time arithmetic produced an invalid value')
  }
  return rebuilt
}

export type { Duration }
