import { describe, expect, it } from 'vitest'

import { evaluate } from './api/evaluate.ts'
import { r4Model } from './r4/index.ts'

/**
 * Additional cases from fhirpath-rs and Medplum. The rest of the Rust corpus
 * repeats the official R5 suite or requires the deferred `%factory` API. The
 * Medplum cases here cover empty values, zero, and operator precedence.
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
