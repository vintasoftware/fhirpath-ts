export type TemporalKind = 'date' | 'dateTime' | 'time'

export type TemporalPrecision = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'millisecond'

const DATE_PATTERN = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/
const TIME_PATTERN = /^(\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/
const TIMEZONE_PATTERN = /(Z|[+-]\d{2}:\d{2})$/

/**
 * A Date, DateTime, or Time value with partial precision. Components beyond the
 * value's precision are undefined; comparison across precisions is decided by the
 * operators (spec §6.2/§6.4), not here.
 */
export class Temporal {
  readonly kind: TemporalKind
  readonly year: number | undefined
  readonly month: number | undefined
  readonly day: number | undefined
  readonly hour: number | undefined
  readonly minute: number | undefined
  readonly second: number | undefined
  /** Fraction-of-second digits as written, e.g. `559` or `5591`; undefined when absent. */
  readonly fraction: string | undefined
  /** Offset in minutes; 0 for `Z`; undefined when the literal has no timezone. */
  readonly timezoneOffsetMinutes: number | undefined

  private constructor(fields: {
    kind: TemporalKind
    year?: number | undefined
    month?: number | undefined
    day?: number | undefined
    hour?: number | undefined
    minute?: number | undefined
    second?: number | undefined
    fraction?: string | undefined
    timezoneOffsetMinutes?: number | undefined
  }) {
    this.kind = fields.kind
    this.year = fields.year
    this.month = fields.month
    this.day = fields.day
    this.hour = fields.hour
    this.minute = fields.minute
    this.second = fields.second
    this.fraction = fields.fraction
    this.timezoneOffsetMinutes = fields.timezoneOffsetMinutes
  }

  /** Parse the text of a date literal (`2014-01`) or FHIR date value. */
  static parseDate(text: string): Temporal | undefined {
    const match = DATE_PATTERN.exec(text)
    if (!match) {
      return undefined
    }
    const [, year, month, day] = match
    return Temporal.build('date', {
      year: Number(year),
      month: optionalNumber(month),
      day: optionalNumber(day),
    })
  }

  /** Parse the text of a dateTime literal (`2014-01-25T14:30:00Z`, `2014T`). */
  static parseDateTime(text: string): Temporal | undefined {
    const timeSeparator = text.indexOf('T')
    if (timeSeparator === -1) {
      const dateOnly = Temporal.parseDate(text)
      return dateOnly ? dateOnly.withKind('dateTime') : undefined
    }
    const datePart = text.slice(0, timeSeparator)
    let timePart = text.slice(timeSeparator + 1)
    const dateMatch = DATE_PATTERN.exec(datePart)
    if (!dateMatch) {
      return undefined
    }
    let timezoneOffsetMinutes: number | undefined
    const timezoneMatch = TIMEZONE_PATTERN.exec(timePart)
    if (timezoneMatch) {
      timezoneOffsetMinutes = parseTimezone(timezoneMatch[1] as string)
      timePart = timePart.slice(0, -(timezoneMatch[1] as string).length)
    }
    let time: RegExpExecArray | null = null
    if (timePart !== '') {
      time = TIME_PATTERN.exec(timePart)
      if (!time) {
        return undefined
      }
    }
    return Temporal.build('dateTime', {
      year: Number(dateMatch[1]),
      month: optionalNumber(dateMatch[2]),
      day: optionalNumber(dateMatch[3]),
      hour: optionalNumber(time?.[1]),
      minute: optionalNumber(time?.[2]),
      second: optionalNumber(time?.[3]),
      fraction: time?.[4],
      timezoneOffsetMinutes,
    })
  }

  /** Parse the text of a time literal (`14:30:14.559`). Times have no timezone. */
  static parseTime(text: string): Temporal | undefined {
    const match = TIME_PATTERN.exec(text)
    if (!match) {
      return undefined
    }
    const [, hour, minute, second, fraction] = match
    return Temporal.build('time', {
      hour: Number(hour),
      minute: optionalNumber(minute),
      second: optionalNumber(second),
      fraction,
    })
  }

  /** Build from components with the same range validation as parsing. */
  static fromFields(
    kind: TemporalKind,
    fields: {
      year?: number | undefined
      month?: number | undefined
      day?: number | undefined
      hour?: number | undefined
      minute?: number | undefined
      second?: number | undefined
      fraction?: string | undefined
      timezoneOffsetMinutes?: number | undefined
    }
  ): Temporal | undefined {
    return Temporal.build(kind, fields)
  }

  private static build(
    kind: TemporalKind,
    fields: {
      year?: number | undefined
      month?: number | undefined
      day?: number | undefined
      hour?: number | undefined
      minute?: number | undefined
      second?: number | undefined
      fraction?: string | undefined
      timezoneOffsetMinutes?: number | undefined
    }
  ): Temporal | undefined {
    if (
      !(
        inRange(fields.month, 1, 12) &&
        inRange(fields.day, 1, 31) &&
        inRange(fields.hour, 0, 23) &&
        inRange(fields.minute, 0, 59) &&
        inRange(fields.second, 0, 60)
      )
    ) {
      return undefined
    }
    // @2019-02-29 is not a date; timezone offsets only exist within -12:00..+14:00.
    if (
      fields.day !== undefined &&
      fields.month !== undefined &&
      fields.year !== undefined &&
      fields.day > daysInMonth(fields.year, fields.month)
    ) {
      return undefined
    }
    if (fields.timezoneOffsetMinutes !== undefined && Math.abs(fields.timezoneOffsetMinutes) > 14 * 60) {
      return undefined
    }
    return new Temporal({ kind, ...fields })
  }

  get precision(): TemporalPrecision {
    if (this.fraction !== undefined) {
      return 'millisecond'
    }
    if (this.second !== undefined) {
      return 'second'
    }
    if (this.minute !== undefined) {
      return 'minute'
    }
    if (this.hour !== undefined) {
      return 'hour'
    }
    if (this.day !== undefined) {
      return 'day'
    }
    if (this.month !== undefined) {
      return 'month'
    }
    return 'year'
  }

  private withKind(kind: TemporalKind): Temporal {
    return new Temporal({
      kind,
      year: this.year,
      month: this.month,
      day: this.day,
      hour: this.hour,
      minute: this.minute,
      second: this.second,
      fraction: this.fraction,
      timezoneOffsetMinutes: this.timezoneOffsetMinutes,
    })
  }

  toString(): string {
    const parts: string[] = []
    if (this.year !== undefined) {
      parts.push(pad4(this.year))
      if (this.month !== undefined) {
        parts.push(`-${pad2(this.month)}`)
        if (this.day !== undefined) {
          parts.push(`-${pad2(this.day)}`)
        }
      }
    }
    if (this.kind === 'dateTime' && this.hour !== undefined) {
      parts.push('T')
    }
    if (this.hour !== undefined) {
      parts.push(pad2(this.hour))
      if (this.minute !== undefined) {
        parts.push(`:${pad2(this.minute)}`)
        if (this.second !== undefined) {
          parts.push(`:${pad2(this.second)}`)
          if (this.fraction !== undefined) {
            parts.push(`.${this.fraction}`)
          }
        }
      }
      if (this.timezoneOffsetMinutes !== undefined) {
        parts.push(formatTimezone(this.timezoneOffsetMinutes))
      }
    }
    return parts.join('')
  }

  /** Literal form including the `@` (and `@T` for times); used when printing values. */
  toLiteralString(): string {
    return this.kind === 'time' ? `@T${this.toString()}` : `@${this.toString()}`
  }
}

function optionalNumber(text: string | undefined): number | undefined {
  return text === undefined ? undefined : Number(text)
}

/**
 * Offset added to a FHIRPath year before handing it to `Date.UTC`, which maps
 * years 0–99 to 1900–1999. Shifting by a whole multiple of 400 preserves the
 * proleptic Gregorian leap rule exactly while moving small years out of that
 * remapped range, so date math on years 1–99 stays correct.
 */
export const GREGORIAN_UTC_YEAR_OFFSET = 400

/** Days in a month (1-based), correct across the full FHIRPath year range. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year + GREGORIAN_UTC_YEAR_OFFSET, month, 0)).getUTCDate()
}

function inRange(value: number | undefined, min: number, max: number): boolean {
  return value === undefined || (value >= min && value <= max)
}

function parseTimezone(text: string): number {
  if (text === 'Z') {
    return 0
  }
  const sign = text.startsWith('-') ? -1 : 1
  const hours = Number(text.slice(1, 3))
  const minutes = Number(text.slice(4, 6))
  return sign * (hours * 60 + minutes)
}

function formatTimezone(offsetMinutes: number): string {
  if (offsetMinutes === 0) {
    return 'Z'
  }
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
}

const pad2 = (value: number): string => String(value).padStart(2, '0')
const pad4 = (value: number): string => String(value).padStart(4, '0')
