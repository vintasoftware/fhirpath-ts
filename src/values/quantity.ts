import type { QuantityValue } from './typed-value'

const SINGULAR_CALENDAR_UNITS: Readonly<Record<string, string>> = {
  years: 'year',
  months: 'month',
  weeks: 'week',
  days: 'day',
  hours: 'hour',
  minutes: 'minute',
  seconds: 'second',
  milliseconds: 'millisecond',
}

/** `4 days` and `1 day` use the same unit; plurals normalize to the singular word. */
export function normalizeCalendarUnit(unit: string): string {
  return SINGULAR_CALENDAR_UNITS[unit] ?? unit
}

/** Calendar words at or below `second` are exact, so they equal their UCUM twins (spec §6.1). */
const CALENDAR_TO_UCUM_EXACT: Readonly<Record<string, string>> = {
  second: 's',
  millisecond: 'ms',
}

/** Calendar words above `second` are only *equivalent* (`~`) to these UCUM units, never equal. */
const CALENDAR_TO_UCUM_LOOSE: Readonly<Record<string, string>> = {
  year: 'a',
  month: 'mo',
  week: 'wk',
  day: 'd',
  hour: 'h',
  minute: 'min',
}

function comparableUnit(quantity: QuantityValue, loose: boolean): string {
  if (!quantity.calendar) {
    return quantity.unit
  }
  const singular = normalizeCalendarUnit(quantity.unit)
  const exact = CALENDAR_TO_UCUM_EXACT[singular]
  if (exact !== undefined) {
    return exact
  }
  if (loose) {
    return CALENDAR_TO_UCUM_LOOSE[singular] ?? singular
  }
  return `calendar:${singular}`
}

/**
 * Compare two quantities. Undefined when the units are not comparable — full UCUM
 * canonicalization (e.g. `1 'm' = 100 'cm'`) lands with the quantity phase.
 */
export function compareQuantities(a: QuantityValue, b: QuantityValue): -1 | 0 | 1 | undefined {
  if (comparableUnit(a, false) !== comparableUnit(b, false)) {
    return undefined
  }
  return a.value.compare(b.value)
}

/** Equivalence: calendar durations match their UCUM equivalents (`1 year ~ 1 'a'`). */
export function quantitiesEquivalent(a: QuantityValue, b: QuantityValue): boolean {
  if (comparableUnit(a, true) !== comparableUnit(b, true)) {
    return false
  }
  const scale = Math.min(a.value.scale, b.value.scale)
  return a.value.round(scale).equals(b.value.round(scale))
}
