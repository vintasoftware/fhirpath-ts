import { FhirPathTypeError } from '../errors.ts'
import { Temporal, type TemporalKind } from '../values/datetime.ts'

/**
 * Date/DateTime string format codes (FHIRPath 3.0.0, Date Conversion
 * Functions): the optional `format` argument of toDate(), toDateTime(),
 * convertsToDate(), and convertsToDateTime(). Codes are case-sensitive; any
 * other character must match itself. Month names and AM/PM markers are read in
 * English. The time zone name code `z` reads an IANA time zone id in
 * Area/Location form, such as America/Los_Angeles, or UTC or GMT, and takes the
 * zone's offset at the date and time read. Abbreviations such as PST and names
 * such as Pacific Standard Time do not match.
 */

type Field = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'fraction' | 'meridiem' | 'zone'

interface Code {
  field: Field
  pattern: string
  /** A number for the components and the `Z` offset; text for fractions, AM/PM, and `z` ids. */
  read: (text: string) => number | string | undefined
  /** True for the 12-hour codes, which need the AM/PM code. */
  twelveHour?: true
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

const number = (text: string): number => Number(text)

/** A 2-digit year: 00-49 is 2000-2049 and 50-99 is 1950-1999, the spec's common approach. */
const twoDigitYear = (text: string): number => {
  const value = Number(text)
  return value < 50 ? 2000 + value : 1900 + value
}

const CODES: Readonly<Record<string, Code>> = {
  yyyy: { field: 'year', pattern: '\\d{4}', read: number },
  yy: { field: 'year', pattern: '\\d{2}', read: twoDigitYear },
  MMMM: {
    field: 'month',
    pattern: MONTH_NAMES.map(caseless).join('|'),
    read: text => MONTH_NAMES.indexOf(text.toLowerCase()) + 1,
  },
  MMM: {
    field: 'month',
    pattern: MONTH_NAMES.map(name => caseless(name.slice(0, 3))).join('|'),
    read: text => MONTH_NAMES.findIndex(name => name.startsWith(text.toLowerCase())) + 1,
  },
  MM: { field: 'month', pattern: '\\d{2}', read: number },
  M: { field: 'month', pattern: '\\d{1,2}', read: number },
  dd: { field: 'day', pattern: '\\d{2}', read: number },
  d: { field: 'day', pattern: '\\d{1,2}', read: number },
  HH: { field: 'hour', pattern: '\\d{2}', read: number },
  H: { field: 'hour', pattern: '\\d{1,2}', read: number },
  hh: { field: 'hour', pattern: '\\d{2}', read: number, twelveHour: true },
  h: { field: 'hour', pattern: '\\d{1,2}', read: number, twelveHour: true },
  mm: { field: 'minute', pattern: '\\d{2}', read: number },
  m: { field: 'minute', pattern: '\\d{1,2}', read: number },
  ss: { field: 'second', pattern: '\\d{2}', read: number },
  s: { field: 'second', pattern: '\\d{1,2}', read: number },
  a: {
    field: 'meridiem',
    pattern: ['am', 'pm', 'a', 'p'].map(caseless).join('|'),
    read: text => text.toLowerCase().charAt(0),
  },
  z: { field: 'zone', pattern: '[A-Za-z][\\w+-]*(?:/[\\w+-]+)+|UTC|GMT', read: text => text },
  Z: { field: 'zone', pattern: 'Z|[+-]\\d{2}:?\\d{2}', read: offsetMinutes },
}

const CODE_LETTERS = new Set(['y', 'M', 'd', 'H', 'h', 'm', 's', 'S', 'a', 'z', 'Z'])

/** The order of the components a Temporal can hold, without gaps. */
const PRECISION_ORDER: readonly Field[] = ['year', 'month', 'day', 'hour', 'minute', 'second', 'fraction']

export interface DateFormat {
  /** The components the format supplies, or undefined when the text does not match. */
  read(text: string): Temporal | undefined
}

/**
 * Compile a format for a conversion to `kind`. A format the conversion cannot
 * use is an error: an unknown run of code letters, a component given twice, a
 * gap in the components (a day without a month), `h` without `a`, or a time zone
 * without an hour.
 */
export function compileDateFormat(name: string, format: string, kind: 'date' | 'dateTime'): DateFormat {
  const fail: (reason: string) => never = reason => {
    throw new FhirPathTypeError(`${name}() received an invalid format '${format}': ${reason}`)
  }
  const codes: Code[] = []
  let zoneCode: string | undefined
  let source = ''
  let index = 0
  while (index < format.length) {
    const letter = format[index] as string
    let end = index + 1
    while (CODE_LETTERS.has(letter) && format[end] === letter) {
      end++
    }
    const run = format.slice(index, end)
    index = end
    if (!CODE_LETTERS.has(letter)) {
      source += escapeRegExp(run)
      continue
    }
    const code = letter === 'S' ? fractionCode(run.length) : CODES[run]
    if (code === undefined) {
      fail(`'${run}' is not a format code`)
    }
    if (codes.some(existing => existing.field === code.field)) {
      fail(`it gives the ${code.field} more than once`)
    }
    codes.push(code)
    zoneCode = code.field === 'zone' ? run : zoneCode
    source += `(${code.pattern})`
  }
  const fields = new Set(codes.map(code => code.field))
  const precision = PRECISION_ORDER.findIndex(field => !fields.has(field))
  const supplied = precision === -1 ? PRECISION_ORDER.length : precision
  if (supplied === 0) {
    fail('it has no year')
  }
  if (PRECISION_ORDER.slice(supplied).some(field => fields.has(field))) {
    fail(
      `it gives the ${PRECISION_ORDER.find((field, position) => position >= supplied && fields.has(field))} but no ${PRECISION_ORDER[supplied]}`
    )
  }
  const twelveHour = codes.some(code => code.twelveHour === true)
  if (twelveHour !== fields.has('meridiem')) {
    fail(twelveHour ? "the 12-hour codes 'h' and 'hh' need the AM/PM code 'a'" : "the AM/PM code 'a' needs 'h' or 'hh'")
  }
  if (zoneCode !== undefined && !fields.has('hour')) {
    fail(`the time zone code '${zoneCode}' needs an hour`)
  }
  const pattern = new RegExp(`^${source}$`)
  return {
    read(text) {
      const match = pattern.exec(text)
      if (match === null) {
        return undefined
      }
      const values: Partial<Record<Field, number | string | undefined>> = {}
      codes.forEach((code, position) => {
        values[code.field] = code.read(match[position + 1] as string)
      })
      return temporalFrom(values, kind)
    },
  }
}

function fractionCode(digits: number): Code {
  return { field: 'fraction', pattern: `\\d{${digits}}`, read: text => text }
}

function temporalFrom(
  values: Partial<Record<Field, number | string | undefined>>,
  kind: TemporalKind
): Temporal | undefined {
  let hour = values.hour as number | undefined
  if (values.meridiem !== undefined && hour !== undefined) {
    if (hour < 1 || hour > 12) {
      return undefined
    }
    hour = (hour % 12) + (values.meridiem === 'p' ? 12 : 0)
  }
  let zone = values.zone as number | undefined
  if (typeof values.zone === 'string') {
    zone = zoneOffsetMinutes(values.zone, values, hour)
    if (zone === undefined) {
      return undefined
    }
  }
  return Temporal.fromFields(kind, {
    year: values.year as number,
    month: values.month as number | undefined,
    day: values.day as number | undefined,
    ...(kind === 'dateTime' && {
      hour,
      minute: values.minute as number | undefined,
      second: values.second as number | undefined,
      fraction: values.fraction as string | undefined,
      timezoneOffsetMinutes: zone,
    }),
  })
}

function offsetMinutes(zone: string): number {
  if (zone === 'Z') {
    return 0
  }
  const digits = zone.replace(':', '')
  const minutes = Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5))
  return digits.startsWith('-') ? -minutes : minutes
}

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

/** Formatters by time zone id, since Intl.DateTimeFormat is slow to construct. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>()
const MAX_ZONE_FORMATTERS = 64

/**
 * The offset, in minutes, that time zone `id` uses at the wall time in
 * `values`, or undefined when Intl does not know the zone, the wall time never
 * happens there (a forward transition skips it), or the offset is not a whole
 * number of minutes (local mean time before standard zones). A wall time that
 * happens twice takes the earlier instant, as Temporal's `compatible`
 * disambiguation does.
 */
function zoneOffsetMinutes(
  id: string,
  values: Partial<Record<Field, number | string | undefined>>,
  hour: number | undefined
): number | undefined {
  const formatter = zoneFormatter(id)
  if (formatter === undefined) {
    return undefined
  }
  const date = new Date(0)
  date.setUTCFullYear(values.year as number, (values.month as number) - 1, values.day as number)
  date.setUTCHours(hour ?? 0, (values.minute as number | undefined) ?? 0, (values.second as number | undefined) ?? 0)
  const wall = date.getTime()
  // A day either side of the wall time, the zone uses the offsets that can apply
  // at it: real zones change offset at most once in two days.
  const offsets = [offsetAt(formatter, wall - DAY_MS), offsetAt(formatter, wall + DAY_MS)].filter(
    offset => offsetAt(formatter, wall - offset) === offset
  )
  if (offsets.length === 0) {
    return undefined
  }
  const offset = Math.max(...offsets)
  return offset % MINUTE_MS === 0 ? offset / MINUTE_MS : undefined
}

function zoneFormatter(id: string): Intl.DateTimeFormat | undefined {
  let formatter = zoneFormatters.get(id)
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'longOffset' })
    } catch {
      // A RangeError: Intl does not know the zone.
      return undefined
    }
    if (zoneFormatters.size >= MAX_ZONE_FORMATTERS) {
      zoneFormatters.clear()
    }
    zoneFormatters.set(id, formatter)
  }
  return formatter
}

/** The offset from UTC, in milliseconds, of the zone `formatter` formats in at `instant`. */
function offsetAt(formatter: Intl.DateTimeFormat, instant: number): number {
  const name = formatter.formatToParts(instant).find(part => part.type === 'timeZoneName')?.value ?? ''
  const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name)
  if (match === null) {
    return 0
  }
  const [, sign, hours, minutes, seconds] = match
  const offset = ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds ?? 0)) * 1000
  return sign === '-' ? -offset : offset
}

/** A pattern for `word` in any letter case; literals in the format stay case-sensitive. */
function caseless(word: string): string {
  return [...word].map(letter => `[${letter.toLowerCase()}${letter.toUpperCase()}]`).join('')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
