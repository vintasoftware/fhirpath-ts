import { describe, expect, it } from 'vitest'

import { evaluate } from './api/evaluate.ts'
import { FhirPathRuntimeError, FhirPathTypeError } from './errors.ts'
import { r4Model } from './r4/index.ts'

/**
 * Additional cases from fhirpath-rs, Helios (hfs), fhirpath.zig, and Medplum. The
 * rest of the Rust corpus repeats the official R5 suite or requires the deferred
 * `%factory` API. The fhirpath.zig cases come from its hand-written tests for
 * FHIRPath 3.0.0 functions. The Medplum cases here cover empty values, zero, and
 * operator precedence.
 */

const patient = {
  resourceType: 'Patient',
  active: true,
  gender: 'male',
  name: [
    { given: ['Peter'], family: 'Chalmers', period: { start: '2001-01-01' } },
    { given: ['Jim'], family: 'Chalmers' },
  ],
}

const options = { model: r4Model }

describe('fhirpath-rs fhir_functions cross-checks', () => {
  it.each([
    ['(true | false).select(false).allFalse()', [true]],
    ['(true | false).select(true).allFalse()', [false]],
    ['Patient.name.where(false).allFalse()', [true]],
    ['Patient.name.select(period.exists()).allFalse()', [false]],
    ['Patient.name.select(given.exists()).anyFalse()', [false]],
    ['Patient.name.select(period.exists()).anyFalse()', [true]],
    ['Patient.name.where(false).anyFalse()', [false]],
    ['timeOfDay().exists()', [true]],
    ['Patient.active.getValue()', [true]],
    ['Patient.gender.getValue()', ['male']],
    ['Patient.name.where(false).getValue()', []],
    ['\'<div xmlns="http://www.w3.org/1999/xhtml"><p>Hello</p></div>\'.htmlChecks()', [true]],
    ["'<script>alert(1)</script>'.htmlChecks()", [false]],
    ['Patient.name.where(false).htmlChecks()', []],
  ] as [string, unknown[]][])('%s', (expression, expected) => {
    expect(evaluate(expression, patient, options)).toEqual(expected)
  })
})

describe('fhirpath-rs repeatAll() cross-checks', () => {
  it('agrees with repeat() on a finite projection', () => {
    expect(
      evaluate(
        '5.repeatAll(iif($this > 0, $this - 1, {})).where($this > 0).count() >= 5.repeat(iif($this > 0, $this - 1, {})).where($this > 0).count()'
      )
    ).toEqual([true])
  })

  it('rejects other arities and projections that fail or never end', () => {
    expect(() => evaluate('1.repeatAll()')).toThrow(FhirPathTypeError)
    expect(() => evaluate('1.repeatAll($this + 1, $this * 2)')).toThrow(FhirPathTypeError)
    expect(() => evaluate("'test'.repeatAll($this * 2)")).toThrow(FhirPathTypeError)
    expect(() => evaluate('1.repeatAll($this + 1)')).toThrow(FhirPathRuntimeError)
    expect(() => evaluate('1.repeatAll(1)')).toThrow(FhirPathRuntimeError)
  })

  it('follows the specification where fhirpath-rs differs', () => {
    // testRepeatAllFiniteSequence expects 6 because fhirpath-rs counts the input
    // 10; the output holds only projected items.
    expect(evaluate('10.repeatAll(iif($this > 1, $this - 2, {})).count()')).toEqual([5])
    // testRepeatAllBasic and testRepeatDeduplication expect a constant projection
    // to end; the spec lists `Questionnaire.repeatAll('item')` as one that never does.
    expect(() => evaluate("Patient.name.repeatAll('test').count() >= 1", patient, options)).toThrow(
      FhirPathRuntimeError
    )
    expect(() =>
      evaluate(
        "Patient.name.repeat('duplicate').count() <= Patient.name.repeatAll('duplicate').count()",
        patient,
        options
      )
    ).toThrow(FhirPathRuntimeError)
  })
})

describe('Helios regex flag cross-checks', () => {
  it.each([
    ["'HELLO'.matches('hello', 'i')", [true]],
    ["'line1\\nline2'.matches('^line2$', 'm')", [true]],
    ["'HELLO'.matchesFull('hello', 'i')", [true]],
  ] as [string, unknown[]][])('%s', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })
})

describe('fhirpath.zig 3.0.0 cross-checks', () => {
  it.each([
    ["@2024-01-01.duration(@2025-01-01, 'year')", [1]],
    ["@2025-01-15.duration(@2025-02-15, 'month')", [1]],
    ["@2025-06-01.duration(@2025-01-01, 'month')", [-5]],
    ["@2024-12-31.difference(@2025-01-01, 'day')", [1]],
    ["@2024-12-31.difference(@2025-01-01, 'year')", [1]],
    ["@2025-06-01.difference(@2025-01-01, 'month')", [-5]],
    ["{}.duration(@2025-01-01, 'day')", []],
    ["@2025-01.duration(@2025-02, 'day')", []],
    ["@2025-01-01.difference({}, 'day')", []],
    ["@2025-01-01T10:00:00.duration(@2025-01-01T15:30:00, 'hour')", [5]],
    ["@2025-01-01T10:30:00.difference(@2025-01-01T12:15:00, 'hour')", [2]],
    ["@T10:00:00.duration(@T10:45:30, 'minute')", [45]],
    ["@T10:00:00.difference(@T10:00:05, 'second')", [5]],
    ["'Hello HELLO hello'.replaceMatches('hello', 'hi', 'i')", ['hi hi hi']],
    ["'line1\\nline2'.matches('^line2', 'm')", [true]],
    ["'line1\\nline2'.matches('line1$', 'm')", [true]],
    ['{}.repeatAll(child).empty()', [true]],
  ] as [string, unknown[]][])('%s', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })

  it('repeatAll() follows each chain and keeps duplicate values', () => {
    const chain = { root: { id: 'root', child: { id: 'a', child: { id: 'b' } } } }
    expect(evaluate('root.repeatAll(child).count()', chain)).toEqual([2])
    const siblings = { root: { child: [{ id: 1 }, { id: 1 }, { id: 2 }] } }
    expect(evaluate('root.repeatAll(child.id).count()', siblings)).toEqual([3])
  })
})

describe('Medplum spot checks', () => {
  it.each([
    ['{} = {}', []],
    ['{} != {}', []],
    ['{} ~ {}', [true]],
    ['{} !~ {}', [false]],
    ['1 ~ {}', [false]],
    ['{} !~ 1', [true]],
    ['0.0 = 0', [true]],
    ['0.0 ~ 0', [true]],
    // Union binds tighter than equality, so the right side groups first.
    ['(0 | 1 | 2).skip(1) = 1 | 2', [true]],
    ['(0 | 1 | 2).tail() = 1 | 2', [true]],
    ['(0 | 1 | 2).take(2) = 0 | 1', [true]],
    ['(-0.0).exp() = 1', [true]],
    // Medplum also asserts (0).not() = true, but the official R5 suite pins
    // (0).not() = false (existence semantics) — a reference bug, not inherited.
    ['(0).not() = false', [true]],
  ] as [string, unknown[]][])('%s', (expression, expected) => {
    expect(evaluate(expression)).toEqual(expected)
  })
})
