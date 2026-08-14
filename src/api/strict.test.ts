import { describe, expect, it } from 'vitest'

import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import type { Observation, Patient } from '../r4/generated/type-maps.ts'
import { r4Model } from '../r4/index.ts'
import { compile } from './compile.ts'
import { FhirPathEngine } from './engine.ts'

const patient: Patient = {
  resourceType: 'Patient',
  id: 'p1',
  name: [{ family: 'Ng', given: ['Ada'] }],
}

const observation: Observation = {
  resourceType: 'Observation',
  status: 'final',
  valueQuantity: { value: 72, unit: 'kg' },
}

const lenient = new FhirPathEngine({ model: r4Model })
const strict = new FhirPathEngine({ model: r4Model, strict: true })

function errorMessage(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(FhirPathTypeError)
    return (error as Error).message
  }
  throw new Error('Expected evaluation to throw')
}

describe('strict evaluation', () => {
  it('is opt-in and can be overridden per call', () => {
    expect(lenient.evaluate('Patient.name.active', patient)).toEqual([])
    expect(lenient.evaluate('Observation.valueQuantity', observation)).toEqual([])

    expect(() => strict.evaluate('Patient.name.active', patient)).toThrow(/\[unknown-element\].*active/)
    expect(() => strict.evaluate('Observation.valueQuantity', observation)).toThrow(
      /\[unknown-element\].*choice elements use their stem name/
    )
    expect(() => lenient.evaluate('Patient.name.active', patient, { strict: true })).toThrow(FhirPathTypeError)
    expect(strict.evaluate('Patient.name.active', patient, { strict: false })).toEqual([])
  })

  it('reports every error diagnostic and does not fail on analyzer warnings', () => {
    const message = errorMessage(() => strict.evaluate('Patient.nope | frobnicate()', patient))
    expect(message).toContain('[unknown-element]')
    expect(message).toContain('[unknown-function]')
    expect(strict.evaluate("'aaaa'.matches('(a+)+$')")).toEqual([true])
  })

  it('uses the runtime input types and cardinality for analysis', () => {
    expect(() => strict.evaluate("Patient.name.given + '!'", patient)).toThrow(/\[singleton-required\]/)
    expect(() => strict.evaluate('Patient.name.active', [observation, patient])).toThrow(/\[unknown-element\]/)
    expect(() => strict.evaluate('Patient.nope')).toThrow(/\[unknown-element\]/)

    const custom = { resourceType: 'CustomResource', anything: 'works' }
    expect(strict.evaluate('anything', custom)).toEqual(['works'])
  })

  it('keeps specification runtime errors in lenient mode', () => {
    expect(() => lenient.evaluate('frobnicate()', patient)).toThrow(FhirPathTypeError)
    expect(() => lenient.evaluate('1.substring()', patient)).toThrow(FhirPathTypeError)
    expect(() => lenient.evaluate('%missing', patient)).toThrow(FhirPathTypeError)
    expect(() => lenient.evaluate('(1 | 2).single()', patient)).toThrow(FhirPathRuntimeError)
  })

  it('checks vars with their declaration order and accepts declared runtime values', () => {
    expect(strict.evaluate('%limit + 1', patient, { env: { limit: 2 } })).toEqual([3])

    const message = errorMessage(() =>
      compile('%broken').evaluate(patient, {
        model: r4Model,
        strict: true,
        vars: { broken: 'Patient.nope' },
      })
    )
    expect(message).toContain('vars.broken:')
    expect(message).toContain('[unknown-element]')

    expect(
      strict.evaluate('%next', patient, {
        vars: {
          value: [{ type: 'System.Integer', value: 2 }],
          next: '%value + 1',
        },
      })
    ).toEqual([3])

    expect(
      strict.evaluate('%label', patient, {
        vars: { label: 'Patient.id' },
        varTypes: { label: { type: 'string' } },
      })
    ).toEqual(['p1'])

    // A type declaration informs analysis but does not invent a runtime value.
    expect(() => strict.evaluate('%declared', patient, { varTypes: { declared: { type: 'string' } } })).toThrow(
      'Undefined environment variable %declared'
    )
  })

  it('checks expression-defined functions and honors function-local environment declarations', () => {
    const message = errorMessage(() =>
      strict.evaluate('broken()', patient, {
        functions: { broken: { expression: 'Patient.nope' } },
      })
    )
    expect(message).toContain('[unknown-element]')

    expect(
      strict.evaluate('label()', patient, {
        functions: {
          label: {
            expression: '%prefix & Patient.id',
            env: { prefix: '#' },
          },
        },
      })
    ).toEqual(['#p1'])

    expect(
      strict.evaluate('Patient.id.passthrough()', patient, {
        functions: {
          passthrough: { minArity: 0, maxArity: 0, fn: input => input },
        },
      })
    ).toEqual(['p1'])
  })

  it('applies through compiled expressions, filters, projections, and constraints', () => {
    expect(() => compile('Patient.nope').evaluate(patient, { model: r4Model, strict: true })).toThrow(
      /\[unknown-element\]/
    )
    expect(() => strict.compile('Patient.nope').evaluate(patient)).toThrow(/\[unknown-element\]/)
    expect(() => strict.filter([patient], 'Patient.nope')).toThrow(/\[unknown-element\]/)
    expect(() => strict.project(patient, { bad: 'Patient.nope' })).toThrow(/\[unknown-element\]/)
    expect(() => strict.project(patient, { bad: { test: 'Patient.nope' } })).toThrow(/\[unknown-element\]/)
    expect(strict.project(patient, { position: '%rowIndex + %rowTotal' })).toEqual({ position: 1 })

    const checked = strict.checkConstraints(patient, [{ key: 'pat-1', expression: 'Patient.nope' }])
    expect(checked.valid).toBe(false)
    expect(checked.issues[0]?.error).toMatch(/\[unknown-element\]/)
  })

  it('can reject model-independent type errors without a model', () => {
    const bareStrict = new FhirPathEngine({ strict: true })
    expect(() => bareStrict.evaluate("1 + 'x'")).toThrow(/\[operand-type\]/)
  })
})
