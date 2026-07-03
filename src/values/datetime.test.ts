import { describe, expect, it } from 'vitest'
import { Temporal } from './datetime'

describe('date parsing', () => {
  it.each([
    ['2014', 'year'],
    ['2014-01', 'month'],
    ['2014-01-25', 'day'],
  ])('parses %s at %s precision', (text, precision) => {
    const value = Temporal.parseDate(text)
    expect(value?.kind).toBe('date')
    expect(value?.precision).toBe(precision)
    expect(value?.toString()).toBe(text)
  })

  it('rejects malformed dates and out-of-range components', () => {
    expect(Temporal.parseDate('201')).toBeUndefined()
    expect(Temporal.parseDate('2014-13')).toBeUndefined()
    expect(Temporal.parseDate('2014-00')).toBeUndefined()
    expect(Temporal.parseDate('2014-01-32')).toBeUndefined()
    expect(Temporal.parseDate('abcd')).toBeUndefined()
  })
})

describe('dateTime parsing', () => {
  it.each([
    ['2014', 'year'],
    ['2014T', 'year'],
    ['2014-01-25T14', 'hour'],
    ['2014-01-25T14:30', 'minute'],
    ['2014-01-25T14:30:14', 'second'],
    ['2014-01-25T14:30:14.559', 'millisecond'],
  ])('parses %s at %s precision', (text, precision) => {
    const value = Temporal.parseDateTime(text)
    expect(value?.kind).toBe('dateTime')
    expect(value?.precision).toBe(precision)
  })

  it('parses timezones', () => {
    expect(Temporal.parseDateTime('2014-01-25T14:30Z')?.timezoneOffsetMinutes).toBe(0)
    expect(Temporal.parseDateTime('2014-01-25T14:30+11:00')?.timezoneOffsetMinutes).toBe(660)
    expect(Temporal.parseDateTime('2014-01-25T14:30-05:30')?.timezoneOffsetMinutes).toBe(-330)
    expect(Temporal.parseDateTime('2014-01-25T14:30')?.timezoneOffsetMinutes).toBeUndefined()
  })

  it('prints back the literal text', () => {
    for (const text of ['2014T', '2014-01-25T14:30:14.559Z', '2014-01-25T14:30+11:00', '2014-01-25T14:30-05:30']) {
      expect(Temporal.parseDateTime(text)?.toString()).toBe(text)
    }
  })

  it('rejects a dateTime with no T and a bad date', () => {
    expect(Temporal.parseDateTime('abcd')).toBeUndefined()
  })

  it('rejects malformed dateTimes', () => {
    expect(Temporal.parseDateTime('2014-01-25T25')).toBeUndefined()
    expect(Temporal.parseDateTime('2014-01-25T14:70')).toBeUndefined()
    expect(Temporal.parseDateTime('20T14')).toBeUndefined()
    expect(Temporal.parseDateTime('2014-01-25Tabc')).toBeUndefined()
  })
})

describe('time parsing', () => {
  it.each([
    ['14', 'hour'],
    ['14:30', 'minute'],
    ['14:30:14', 'second'],
    ['14:30:14.559', 'millisecond'],
    ['14:30:14.5591', 'millisecond'],
  ])('parses %s at %s precision', (text, precision) => {
    const value = Temporal.parseTime(text)
    expect(value?.kind).toBe('time')
    expect(value?.precision).toBe(precision)
    expect(value?.toString()).toBe(text)
  })

  it('rejects malformed times', () => {
    expect(Temporal.parseTime('24')).toBeUndefined()
    expect(Temporal.parseTime('1')).toBeUndefined()
    expect(Temporal.parseTime('14:60')).toBeUndefined()
  })
})

describe('literal form', () => {
  it('prefixes @ and @T', () => {
    expect(Temporal.parseDate('2014-01')?.toLiteralString()).toBe('@2014-01')
    expect(Temporal.parseDateTime('2014T')?.toLiteralString()).toBe('@2014T')
    expect(Temporal.parseTime('14:30')?.toLiteralString()).toBe('@T14:30')
  })

  it('prints a zero offset as Z', () => {
    expect(Temporal.parseDateTime('2014-01-25T14:30+00:00')?.toString()).toBe('2014-01-25T14:30Z')
  })
})
