import type { Temporal } from './datetime'

/**
 * Precision levels for comparison. Seconds and milliseconds are one level: the spec
 * treats the second field as a decimal, so `@T10:00:00` and `@T10:00:00.0` compare
 * as equal values rather than as a precision mismatch.
 */
const LEVELS = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const
type Level = (typeof LEVELS)[number]

export type TemporalComparison = -1 | 0 | 1 | 'differentPrecision' | 'incompatible'

/**
 * Compare two temporal values per spec §6.1/§6.4: equal at the shared precision but
 * with different precisions → 'differentPrecision' (empty for `=` and `<`); a time
 * never compares with a date/dateTime. Values without a timezone are treated as UTC.
 */
export function compareTemporal(a: Temporal, b: Temporal): TemporalComparison {
  if ((a.kind === 'time') !== (b.kind === 'time')) {
    return 'incompatible'
  }
  const levelA = comparisonLevel(a)
  const levelB = comparisonLevel(b)
  const shared = Math.min(levelA, levelB)
  // At time precision, a value with a timezone and one without cannot be ordered (spec §6.1).
  if (shared >= 3 && (a.timezoneOffsetMinutes === undefined) !== (b.timezoneOffsetMinutes === undefined)) {
    return 'differentPrecision'
  }
  const rankA = rank(a, shared)
  const rankB = rank(b, shared)
  if (rankA < rankB) {
    return -1
  }
  if (rankA > rankB) {
    return 1
  }
  return levelA === levelB ? 0 : 'differentPrecision'
}

function comparisonLevel(value: Temporal): number {
  const precision = value.precision === 'millisecond' ? 'second' : value.precision
  return LEVELS.indexOf(precision as Level)
}

/**
 * Milliseconds on a common axis, truncated to `level`. Years are shifted by +400 to
 * dodge Date.UTC's 0-99 → 19xx mapping; the Gregorian calendar repeats exactly every
 * 400 years, so ordering and equality are unaffected.
 */
function rank(value: Temporal, level: number): number {
  const year = (value.year ?? 1970) + 400
  const month = level >= 1 ? (value.month ?? 1) : 1
  const day = level >= 2 ? (value.day ?? 1) : 1
  const hour = level >= 3 ? (value.hour ?? 0) : 0
  let minute = level >= 4 ? (value.minute ?? 0) : 0
  let milliseconds = 0
  if (level >= 5) {
    const fraction = value.fraction === undefined ? 0 : Number.parseFloat(`0.${value.fraction}`)
    milliseconds = Math.round(((value.second ?? 0) + fraction) * 1000)
  }
  if (level >= 3 && value.timezoneOffsetMinutes !== undefined) {
    minute -= value.timezoneOffsetMinutes
  }
  return Date.UTC(year, month - 1, day, hour, minute, 0, milliseconds)
}
