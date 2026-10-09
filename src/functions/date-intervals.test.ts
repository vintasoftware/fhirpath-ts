import { describe, expect, it } from 'vitest'

import { evaluate } from '../api/evaluate.ts'
import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import { r4Model } from '../r4/index.ts'

describe('duration() and difference()', () => {
  it.each([
    // Spec examples.
    ["@2025-01-02.duration(@2025-01-07, 'week')", [0]],
    ["@2025-01-01.duration(@2025-09-01, 'year')", [0]],
    ["@2024-12-01.duration(@2025-09-01, 'year')", [0]],
    ["@2025-01-02.difference(@2025-01-07, 'week')", [1]],
    ["@2025-01-01.difference(@2025-09-01, 'year')", [0]],
    ["@2024-12-01.difference(@2025-09-01, 'year')", [1]],
    // hfs cases.
    ["@2025-01-02.duration(@2025-01-07, 'day')", [5]],
    ["@2025-01-10.duration(@2025-01-05, 'day')", [-5]],
  ])('%s -> %j', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('counts whole periods for duration()', () => {
    expect(evaluate("@2024-02-29.duration(@2025-02-28, 'year')")).toEqual([0])
    expect(evaluate("@2024-02-29.duration(@2025-03-01, 'year')")).toEqual([1])
    expect(evaluate("@2025-01-31.duration(@2025-02-28, 'month')")).toEqual([0])
    expect(evaluate("@2025-01-15.duration(@2025-03-15, 'month')")).toEqual([2])
    expect(evaluate("@2025-03-15.duration(@2025-01-16, 'month')")).toEqual([-1])
    expect(evaluate("@2025-01-01.duration(@2025-01-15, 'week')")).toEqual([2])
    expect(evaluate("@2025-01-01T23:00:00Z.duration(@2025-01-02T01:00:00Z, 'day')")).toEqual([0])
    expect(evaluate("@2025-01-01T10:00:00Z.duration(@2025-01-01T12:59:59Z, 'hour')")).toEqual([2])
    expect(evaluate("@T10:00:00.250.duration(@T10:00:01.100, 'millisecond')")).toEqual([850])
    expect(evaluate("@T10:00:00.250.duration(@T10:00:01.100, 'second')")).toEqual([0])
  })

  it('counts boundaries crossed for difference()', () => {
    expect(evaluate("@2025-01-31.difference(@2025-02-01, 'month')")).toEqual([1])
    expect(evaluate("@2025-01-01T23:00:00Z.difference(@2025-01-02T01:00:00Z, 'day')")).toEqual([1])
    expect(evaluate("@T10:59.difference(@T11:00, 'hour')")).toEqual([1])
    expect(evaluate("@T11:00.difference(@T10:59, 'minute')")).toEqual([-1])
    // Sunday starts a week: 2025-01-11 is a Saturday and 2025-01-12 a Sunday.
    expect(evaluate("@2025-01-11.difference(@2025-01-12, 'week')")).toEqual([1])
    expect(evaluate("@2025-01-12.difference(@2025-01-18, 'week')")).toEqual([0])
    expect(evaluate("@2025-01-12.difference(@2025-01-11, 'week')")).toEqual([-1])
    // 0001-01-01 is a Monday in the proleptic Gregorian calendar.
    expect(evaluate("@0001-01-01.difference(@0001-01-07, 'week')")).toEqual([1])
  })

  it('normalizes timezone offsets only for hour and smaller precisions', () => {
    expect(evaluate("@2025-01-01T10:00:00+02:00.duration(@2025-01-01T10:00:00Z, 'hour')")).toEqual([2])
    // 2025-01-02T01:00+05:00 is 2025-01-01T20:00Z, but days compare the written dates.
    expect(evaluate("@2025-01-01T12:00:00Z.difference(@2025-01-02T01:00:00+05:00, 'day')")).toEqual([1])
    expect(evaluate("@2025-01-01T12:00:00Z.difference(@2025-01-02T01:00:00+05:00, 'hour')")).toEqual([8])
    // One value with an offset and one without cannot be normalized.
    expect(evaluate("@2025-01-01T10:00:00+02:00.duration(@2025-01-01T10:00:00, 'hour')")).toEqual([])
    expect(evaluate("@2025-01-01T10:00:00+02:00.duration(@2025-01-02T10:00:00, 'day')")).toEqual([1])
  })

  it('is empty for an empty operand or one less precise than the precision', () => {
    expect(evaluate("{}.duration(@2026, 'year')")).toEqual([])
    expect(evaluate("@2025.duration({}, 'year')")).toEqual([])
    expect(evaluate('@2025.duration(@2026, {})')).toEqual([])
    expect(evaluate("@2025-01.duration(@2025-03-01, 'day')")).toEqual([])
    expect(evaluate("@2025-01-01T10:00.duration(@2025-01-01T10:30:00, 'second')")).toEqual([])
    expect(evaluate("@T10:00:00.duration(@T10:00:01.5, 'millisecond')")).toEqual([])
    // A Date measured against a DateTime counts as a DateTime at day precision.
    expect(evaluate("@2025-01-01.duration(@2025-01-02T10:00:00Z, 'day')")).toEqual([1])
    expect(evaluate("@2025-01-01.duration(@2025-01-02T10:00:00Z, 'hour')")).toEqual([])
  })

  it('reads FHIR date values through the model', () => {
    const patient = { resourceType: 'Patient', birthDate: '2000-06-15' }
    expect(evaluate("birthDate.duration(@2025-06-14, 'year')", patient, { model: r4Model })).toEqual([24])
    expect(evaluate("birthDate.difference(@2025-06-14, 'year')", patient, { model: r4Model })).toEqual([25])
  })

  it('rejects precisions the operand types do not allow', () => {
    expect(() => evaluate("@2025-01-02.duration(@2025-01-07, 'hour')")).toThrow(FhirPathRuntimeError)
    expect(() => evaluate("@2025-01-02.duration(@2025-01-07, 'hour')")).toThrow(
      "duration() does not support the precision 'hour' for Date values"
    )
    expect(() => evaluate("@T10:00.difference(@T11:00, 'day')")).toThrow('for Time values')
    expect(() => evaluate("@2025.duration(@2026, 'years')")).toThrow(FhirPathRuntimeError)
  })

  it('rejects inputs that are not one Date, DateTime, or Time', () => {
    expect(() => evaluate("@T10:00.duration(@2025-01-01, 'hour')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("'2025'.duration(@2025, 'year')")).toThrow(FhirPathTypeError)
    expect(() => evaluate("@2025.duration('2026', 'year')")).toThrow(FhirPathTypeError)
    expect(() => evaluate('@2025.duration(@2026, 1)')).toThrow(FhirPathTypeError)
    expect(() => evaluate("(@2025 | @2026).duration(@2027, 'year')")).toThrow(FhirPathRuntimeError)
  })
})
