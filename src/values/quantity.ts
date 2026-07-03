import { Decimal } from './decimal'
import { type QuantityValue, SYSTEM_QUANTITY, type TypedValue, typeLocalName } from './typed-value'
import { canonicalizeUnit, sameDimensions } from './ucum'

/** FHIR Quantity and its specializations coerce to System.Quantity for comparison. */
const FHIR_QUANTITY_TYPES = new Set([
  'Quantity',
  'Age',
  'Distance',
  'Duration',
  'Count',
  'SimpleQuantity',
  'MoneyQuantity',
])

/** Read a TypedValue as a quantity: System.Quantity directly, FHIR Quantity objects by value+code/unit. */
export function coerceQuantity(item: TypedValue): QuantityValue | undefined {
  if (item.type === SYSTEM_QUANTITY) {
    return item.value as QuantityValue
  }
  if (!(item.type.startsWith('FHIR.') && FHIR_QUANTITY_TYPES.has(typeLocalName(item.type)))) {
    return undefined
  }
  const raw = item.value as { value?: unknown; code?: unknown; unit?: unknown }
  if (typeof raw !== 'object' || raw === null || typeof raw.value !== 'number') {
    return undefined
  }
  const value = Decimal.fromNumber(raw.value)
  if (!value) {
    return undefined
  }
  const unit = typeof raw.code === 'string' ? raw.code : typeof raw.unit === 'string' ? raw.unit : '1'
  return { value, unit, calendar: false }
}

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

/**
 * Calendar durations form two families that never mix: year/month (in months) and
 * week and below (in seconds, all exact). `1 year = 12 months` holds; `1 year` in
 * days does not exist.
 */
const MONTH_FAMILY: Readonly<Record<string, string>> = { year: '12', month: '1' }
const SECOND_FAMILY: Readonly<Record<string, string>> = {
  week: '604800',
  day: '86400',
  hour: '3600',
  minute: '60',
  second: '1',
  millisecond: '0.001',
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
  second: 's',
  millisecond: 'ms',
}

function calendarFamily(unit: string): { family: 'month' | 'second'; factor: Decimal } | undefined {
  const singular = normalizeCalendarUnit(unit)
  const monthFactor = MONTH_FAMILY[singular]
  if (monthFactor !== undefined) {
    return { family: 'month', factor: Decimal.fromString(monthFactor) as Decimal }
  }
  const secondFactor = SECOND_FAMILY[singular]
  if (secondFactor !== undefined) {
    return { family: 'second', factor: Decimal.fromString(secondFactor) as Decimal }
  }
  /* v8 ignore next 2 -- the lexer only produces the units above */
  return undefined
}

/**
 * Compare two quantities. Undefined when the units are not comparable: different
 * dimensions, opaque units with different spellings, or calendar words above
 * seconds against UCUM time units (those are only equivalent, spec §6.1).
 */
export function compareQuantities(a: QuantityValue, b: QuantityValue): -1 | 0 | 1 | undefined {
  if (a.calendar && b.calendar) {
    const familyA = calendarFamily(a.unit)
    const familyB = calendarFamily(b.unit)
    if (!(familyA && familyB) || familyA.family !== familyB.family) {
      return undefined
    }
    return a.value.multiply(familyA.factor).compare(b.value.multiply(familyB.factor))
  }
  if (a.calendar || b.calendar) {
    const [calendar, ucum] = a.calendar ? [a, b] : [b, a]
    const exactTwin = CALENDAR_TO_UCUM_EXACT[normalizeCalendarUnit(calendar.unit)]
    if (exactTwin === undefined) {
      return undefined
    }
    const comparison = compareUcum({ ...calendar, unit: exactTwin, calendar: false }, ucum)
    return comparison === undefined ? undefined : a.calendar ? comparison : (-comparison as -1 | 0 | 1)
  }
  return compareUcum(a, b)
}

function compareUcum(a: QuantityValue, b: QuantityValue): -1 | 0 | 1 | undefined {
  if (a.unit === b.unit) {
    return a.value.compare(b.value)
  }
  const canonicalA = canonicalizeUnit(a.unit)
  const canonicalB = canonicalizeUnit(b.unit)
  if (!(canonicalA && canonicalB && sameDimensions(canonicalA, canonicalB))) {
    return undefined
  }
  return a.value.multiply(canonicalA.factor).compare(b.value.multiply(canonicalB.factor))
}

/** Equivalence: calendar durations match their UCUM twins (`1 year ~ 1 'a'`), rounded to the least precise value. */
export function quantitiesEquivalent(a: QuantityValue, b: QuantityValue): boolean {
  const ucumA = asUcum(a)
  const ucumB = asUcum(b)
  const scale = Math.min(a.value.scale, b.value.scale)
  const comparison = compareUcum(
    { ...ucumA, value: ucumA.value.round(Math.max(scale, 0)) },
    { ...ucumB, value: ucumB.value.round(Math.max(scale, 0)) }
  )
  return comparison === 0
}

function asUcum(quantity: QuantityValue): QuantityValue {
  if (!quantity.calendar) {
    return quantity
  }
  const twin = CALENDAR_TO_UCUM_LOOSE[normalizeCalendarUnit(quantity.unit)]
  /* v8 ignore next 3 -- every calendar word has a loose twin */
  if (twin === undefined) {
    return quantity
  }
  return { ...quantity, unit: twin, calendar: false }
}

/** Convert to another UCUM unit; undefined when dimensions differ or units are opaque. */
export function convertQuantity(quantity: QuantityValue, targetUnit: string): QuantityValue | undefined {
  if (quantity.unit === targetUnit && !quantity.calendar) {
    return quantity
  }
  const source = canonicalizeUnit(quantity.calendar ? asUcum(quantity).unit : quantity.unit)
  const target = canonicalizeUnit(targetUnit)
  if (!(source && target && sameDimensions(source, target))) {
    return undefined
  }
  const converted = quantity.value.multiply(source.factor).divide(target.factor)
  return converted === undefined ? undefined : { value: converted, unit: targetUnit, calendar: false }
}

/**
 * Bring two quantities to a shared unit for + and -; the spec picks the more
 * granular (smaller) unit of the two. Undefined when they cannot be converted.
 */
export function alignQuantities(
  a: QuantityValue,
  b: QuantityValue
): { left: Decimal; right: Decimal; unit: string; calendar: boolean } | undefined {
  if (a.unit === b.unit && a.calendar === b.calendar) {
    return { left: a.value, right: b.value, unit: a.unit, calendar: a.calendar }
  }
  if (a.calendar && b.calendar) {
    const familyA = calendarFamily(a.unit)
    const familyB = calendarFamily(b.unit)
    if (!(familyA && familyB) || familyA.family !== familyB.family) {
      return undefined
    }
    const smaller = familyA.factor.compare(familyB.factor) <= 0 ? a : b
    const factor = calendarFamily(smaller.unit)?.factor as Decimal
    return {
      left: a.value.multiply(familyA.factor).divide(factor) as Decimal,
      right: b.value.multiply(familyB.factor).divide(factor) as Decimal,
      unit: normalizeCalendarUnit(smaller.unit),
      calendar: true,
    }
  }
  if (a.calendar || b.calendar) {
    return undefined
  }
  const canonicalA = canonicalizeUnit(a.unit)
  const canonicalB = canonicalizeUnit(b.unit)
  if (!(canonicalA && canonicalB && sameDimensions(canonicalA, canonicalB))) {
    return undefined
  }
  const targetUnit = canonicalA.factor.compare(canonicalB.factor) <= 0 ? a.unit : b.unit
  const left = convertQuantity(a, targetUnit)
  const right = convertQuantity(b, targetUnit)
  /* v8 ignore next 3 -- both conversions share the dimensions checked above */
  if (!(left && right)) {
    return undefined
  }
  return { left: left.value, right: right.value, unit: targetUnit, calendar: false }
}

/** Compose the result unit of quantity multiplication or division. */
export function composeUnits(operator: '*' | '/', a: string, b: string): string {
  if (operator === '*') {
    if (a === '1') {
      return b
    }
    return b === '1' ? a : `${a}.${b}`
  }
  if (a === b) {
    return '1'
  }
  return b === '1' ? a : `${a}/${b}`
}
