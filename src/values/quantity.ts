import { Decimal } from './decimal.ts'
import { asNumeric } from './numeric.ts'
import { type QuantityValue, SYSTEM_QUANTITY, type TypedValue, typeLocalName } from './typed-value.ts'
import { canonicalizeUnit, sameDimensions } from './ucum.ts'

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

/**
 * One row per calendar duration keyword — the single source the calendar-unit
 * lookups below are all derived from, so they cannot disagree.
 *
 * - `family`: year/month measure in months, week-and-below measure in seconds;
 *   the two families never convert into each other (`1 year` has no value in days).
 * - `factor`: exact multiplier to the family's base unit (months or seconds).
 * - `ucum`: the UCUM twin. Week-and-below (`exact`) twins are exact durations, so
 *   they compare *equal* to the calendar word (`7 days = 1 'wk'`); year/month are
 *   only *equivalent* (`~`) to `a`/`mo`, never equal (spec §6.1 / official suite).
 */
interface CalendarUnit {
  plural: string
  family: 'month' | 'second'
  factor: string
  ucum: string
  exact: boolean
}

const CALENDAR_UNITS: Readonly<Record<string, CalendarUnit>> = {
  year: { plural: 'years', family: 'month', factor: '12', ucum: 'a', exact: false },
  month: { plural: 'months', family: 'month', factor: '1', ucum: 'mo', exact: false },
  week: { plural: 'weeks', family: 'second', factor: '604800', ucum: 'wk', exact: true },
  day: { plural: 'days', family: 'second', factor: '86400', ucum: 'd', exact: true },
  hour: { plural: 'hours', family: 'second', factor: '3600', ucum: 'h', exact: true },
  minute: { plural: 'minutes', family: 'second', factor: '60', ucum: 'min', exact: true },
  second: { plural: 'seconds', family: 'second', factor: '1', ucum: 's', exact: true },
  millisecond: { plural: 'milliseconds', family: 'second', factor: '0.001', ucum: 'ms', exact: true },
}

const CALENDAR_UNIT_ENTRIES = Object.entries(CALENDAR_UNITS)

/** Plural keyword → singular (`years` → `year`). */
const SINGULAR_CALENDAR_UNITS: Readonly<Record<string, string>> = Object.fromEntries(
  CALENDAR_UNIT_ENTRIES.map(([singular, unit]) => [unit.plural, singular])
)

/** Year/month family, factor in months. */
const MONTH_FAMILY: Readonly<Record<string, string>> = Object.fromEntries(
  CALENDAR_UNIT_ENTRIES.filter(([, unit]) => unit.family === 'month').map(([singular, unit]) => [singular, unit.factor])
)

/** Week-and-below family, factor in seconds (all exact). */
const SECOND_FAMILY: Readonly<Record<string, string>> = Object.fromEntries(
  CALENDAR_UNIT_ENTRIES.filter(([, unit]) => unit.family === 'second').map(([singular, unit]) => [
    singular,
    unit.factor,
  ])
)

/** Calendar words that equal their UCUM twin (week and below). */
const CALENDAR_TO_UCUM_EXACT: Readonly<Record<string, string>> = Object.fromEntries(
  CALENDAR_UNIT_ENTRIES.filter(([, unit]) => unit.exact).map(([singular, unit]) => [singular, unit.ucum])
)

/** Every calendar word to its UCUM twin (equivalence-only for year/month). */
const CALENDAR_TO_UCUM_LOOSE: Readonly<Record<string, string>> = Object.fromEntries(
  CALENDAR_UNIT_ENTRIES.map(([singular, unit]) => [singular, unit.ucum])
)

/**
 * FHIR Quantities with UCUM time-valued codes convert to calendar duration
 * keywords (FHIR fhirpath page, "Use of FHIR Quantity"): a Duration of 1 'a'
 * behaves as `1 year`.
 */
const UCUM_TIME_TO_CALENDAR: Readonly<Record<string, string>> = Object.fromEntries(
  CALENDAR_UNIT_ENTRIES.map(([singular, unit]) => [unit.ucum, singular])
)

const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/** Read a TypedValue as a quantity: System.Quantity directly, FHIR Quantity objects by value+code/unit. */
export function coerceQuantity(item: TypedValue): QuantityValue | undefined {
  if (item.type === SYSTEM_QUANTITY) {
    return item.value as QuantityValue
  }
  if (!(item.type.startsWith('FHIR.') && FHIR_QUANTITY_TYPES.has(typeLocalName(item.type)))) {
    return undefined
  }
  const raw = item.value as { value?: unknown; code?: unknown; unit?: unknown; system?: unknown }
  if (typeof raw !== 'object' || raw === null || typeof raw.value !== 'number') {
    return undefined
  }
  const value = Decimal.fromNumber(raw.value)
  if (!value) {
    return undefined
  }
  if (raw.system === UCUM_SYSTEM && typeof raw.code === 'string' && UCUM_TIME_TO_CALENDAR[raw.code] !== undefined) {
    return { value, unit: UCUM_TIME_TO_CALENDAR[raw.code] as string, calendar: true }
  }
  const unit = typeof raw.code === 'string' ? raw.code : typeof raw.unit === 'string' ? raw.unit : '1'
  return { value, unit, calendar: false }
}

/** A quantity as-is, or a number implicitly converted to a unity quantity (spec §5.5). */
export function promoteQuantity(item: TypedValue): QuantityValue | undefined {
  const coerced = coerceQuantity(item)
  if (coerced) {
    return coerced
  }
  const numeric = asNumeric(item)
  return numeric === undefined ? undefined : { value: numeric.value, unit: '1', calendar: false }
}

/**
 * Coerce a pair of operands for quantity operations. Integers, Longs, and
 * Decimals implicitly convert to unity quantities (spec §5.5) when the other
 * side is a quantity: `9 = 9 '1'` and `2 * 4 'kg'` both work.
 */
export function coerceQuantityPair(a: TypedValue, b: TypedValue): [QuantityValue, QuantityValue] | undefined {
  const quantityA = coerceQuantity(a)
  const quantityB = coerceQuantity(b)
  if (quantityA && quantityB) {
    return [quantityA, quantityB]
  }
  if (quantityA) {
    const numeric = asNumeric(b)
    return numeric ? [quantityA, { value: numeric.value, unit: '1', calendar: false }] : undefined
  }
  if (quantityB) {
    const numeric = asNumeric(a)
    return numeric ? [{ value: numeric.value, unit: '1', calendar: false }, quantityB] : undefined
  }
  return undefined
}

/** `4 days` and `1 day` use the same unit; plurals normalize to the singular word. */
export function normalizeCalendarUnit(unit: string): string {
  return SINGULAR_CALENDAR_UNITS[unit] ?? unit
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

/**
 * Equivalence: calendar durations match their UCUM twins (`1 year ~ 1 'a'`), and
 * values compare after conversion, rounded to the least precise operand
 * (`4 'g' ~ 4040 'mg'` is true: 4.04 g rounds to 4 at scale 0).
 */
export function quantitiesEquivalent(a: QuantityValue, b: QuantityValue): boolean {
  const ucumA = asUcum(a)
  const ucumB = asUcum(b)
  const scale = Math.max(Math.min(a.value.scale, b.value.scale), 0)
  const converted = convertQuantity(ucumB, ucumA.unit)
  if (converted !== undefined) {
    return ucumA.value.round(scale).equals(converted.value.round(scale))
  }
  return compareUcum({ ...ucumA, value: ucumA.value.round(scale) }, { ...ucumB, value: ucumB.value.round(scale) }) === 0
}

/** A calendar duration as its loose UCUM twin (`1 year` → `1 'a'`); UCUM passes through. */
export function calendarToUcumLoose(quantity: QuantityValue): QuantityValue {
  return asUcum(quantity)
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

/** True for `year`/`days`/... — never for UCUM codes like `wk` or `mo`. */
function isCalendarWord(unit: string): boolean {
  const singular = normalizeCalendarUnit(unit)
  return MONTH_FAMILY[singular] !== undefined || SECOND_FAMILY[singular] !== undefined
}

/**
 * Convert to another unit. UCUM↔UCUM converts through base dimensions; calendar
 * words convert within their family (`12 months` → `1 year`, `1 week` → `7 days`),
 * and week-and-below calendar words cross into UCUM through their exact twins
 * (`1 'wk'` → `7 days`). Year and month never convert to definite UCUM durations.
 * Undefined when no exact conversion exists.
 */
export function convertQuantity(quantity: QuantityValue, targetUnit: string): QuantityValue | undefined {
  if (quantity.unit === targetUnit && !quantity.calendar === !isCalendarWord(targetUnit)) {
    return quantity
  }
  const targetIsCalendar = isCalendarWord(targetUnit)
  if (quantity.calendar || targetIsCalendar) {
    return convertCalendar(quantity, targetUnit, targetIsCalendar)
  }
  const source = canonicalizeUnit(quantity.unit)
  const target = canonicalizeUnit(targetUnit)
  if (!(source && target && sameDimensions(source, target))) {
    return undefined
  }
  const converted = quantity.value.multiply(source.factor).divide(target.factor)
  return converted === undefined ? undefined : { value: converted, unit: targetUnit, calendar: false }
}

function convertCalendar(
  quantity: QuantityValue,
  targetUnit: string,
  targetIsCalendar: boolean
): QuantityValue | undefined {
  const sourceFamily = quantity.calendar ? calendarFamily(quantity.unit) : undefined
  const targetFamily = targetIsCalendar ? calendarFamily(normalizeCalendarUnit(targetUnit)) : undefined
  if (quantity.calendar && targetIsCalendar) {
    if (!(sourceFamily && targetFamily) || sourceFamily.family !== targetFamily.family) {
      return undefined
    }
    const converted = quantity.value.multiply(sourceFamily.factor).divide(targetFamily.factor)
    return converted === undefined ? undefined : { value: converted, unit: targetUnit, calendar: true }
  }
  if (quantity.calendar) {
    // Calendar → UCUM: only week-and-below are definite; year/month stay calendar-only.
    if (sourceFamily?.family !== 'second') {
      return undefined
    }
    const twin = CALENDAR_TO_UCUM_EXACT[normalizeCalendarUnit(quantity.unit)] as string
    return convertQuantity({ value: quantity.value, unit: twin, calendar: false }, targetUnit)
  }
  // UCUM → calendar word: cross through seconds; year/month targets are indefinite.
  if (targetFamily?.family !== 'second') {
    return undefined
  }
  const source = canonicalizeUnit(quantity.unit)
  const secondsPerTarget = canonicalizeUnit(
    CALENDAR_TO_UCUM_EXACT[normalizeCalendarUnit(targetUnit)] as string
  ) as NonNullable<ReturnType<typeof canonicalizeUnit>>
  if (!(source && sameDimensions(source, secondsPerTarget))) {
    return undefined
  }
  const converted = quantity.value.multiply(source.factor).divide(secondsPerTarget.factor)
  return converted === undefined ? undefined : { value: converted, unit: targetUnit, calendar: true }
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
    const exactA = a.calendar ? CALENDAR_TO_UCUM_EXACT[normalizeCalendarUnit(a.unit)] : a.unit
    const exactB = b.calendar ? CALENDAR_TO_UCUM_EXACT[normalizeCalendarUnit(b.unit)] : b.unit
    if (exactA === undefined || exactB === undefined) {
      return undefined
    }
    return alignQuantities(
      { value: a.value, unit: exactA, calendar: false },
      { value: b.value, unit: exactB, calendar: false }
    )
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
