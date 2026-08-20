import { describe, expect, it } from 'vitest'

import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import type { Observation, Patient } from '../r4/generated/type-maps.ts'
import { r4Model } from '../r4/index.ts'
import { compile, type EvaluateOptions } from './compile.ts'
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

  it('rejects order-dependent operations on unordered collections', () => {
    expect(() => strict.evaluate('Patient.children().skip(1)', patient)).toThrow(
      /\[order-dependent\].*skip\(\).*no defined order/
    )
    expect(strict.evaluate('Patient.children().ofType(HumanName).sort(family).skip(1)', patient)).toEqual([])
    expect(() =>
      strict.evaluate('%children.skip(1)', patient, {
        vars: { children: 'Patient.children()' },
        varTypes: { children: { type: 'Element', collection: true } },
      })
    ).toThrow(/\[order-dependent\]/)
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

    const signedMessage = errorMessage(() =>
      strict.evaluate('opaque().signedBroken()', undefined, {
        functions: {
          opaque: { minArity: 0, maxArity: 0, fn: () => patient },
          signedBroken: { expression: 'status', signature: { input: { types: ['Patient'] } } },
        },
      })
    )
    expect(signedMessage).toContain("Custom function 'signedBroken': Element 'status' is not defined on FHIR.Patient")

    const canonicalMessage = errorMessage(() =>
      strict.evaluate('opaque().canonicalBroken()', undefined, {
        functions: {
          opaque: { minArity: 0, maxArity: 0, fn: () => patient },
          canonicalBroken: { expression: 'status', signature: { input: { types: ['FHIR.Patient'] } } },
        },
      })
    )
    expect(canonicalMessage).toContain(
      "Custom function 'canonicalBroken': Element 'status' is not defined on FHIR.Patient"
    )

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

  it('checks the overload body runtime can select without losing statically possible bodies', () => {
    const exactMessage = errorMessage(() =>
      strict.evaluate('broken()', [patient, observation], {
        functions: {
          broken: {
            overloads: [
              { expression: 'nope', signature: { input: { types: ['Patient'] } } },
              { expression: 'nope', signature: { input: { types: ['Observation'] } } },
            ],
          },
        },
      })
    )
    expect(exactMessage).toContain("Custom function 'broken': Element 'nope' is not defined on FHIR.Patient")
    expect(exactMessage).not.toContain('FHIR.Observation')

    const safeFunctions = {
      safe: {
        overloads: [
          { expression: "'ok'", signature: { input: { types: ['Patient'] } } },
          { expression: 'nope', signature: { input: { types: ['Observation'] } } },
        ],
      },
    } as const
    expect(strict.evaluate('safe()', undefined, { functions: safeFunctions })).toEqual(['ok'])
    expect(strict.evaluate('safe()', { resourceType: 'CustomResource' }, { functions: safeFunctions })).toEqual(['ok'])

    expect(
      strict.evaluate('%value.safe()', undefined, { env: { value: undefined }, functions: safeFunctions })
    ).toEqual(['ok'])
    expect(
      strict.evaluate('%value.safe()', undefined, { env: { value: { opaque: true } }, functions: safeFunctions })
    ).toEqual(['ok'])
    expect(strict.evaluate('%value.safe()', undefined, { vars: { value: [] }, functions: safeFunctions })).toEqual([
      'ok',
    ])
    expect(
      strict.evaluate('%value.safe()', undefined, {
        vars: { value: [{ type: 'FHIR.CustomResource', value: { resourceType: 'CustomResource' } }] },
        functions: safeFunctions,
      })
    ).toEqual(['ok'])

    expect(
      strict.evaluate('fromEnv()', undefined, {
        functions: {
          ...safeFunctions,
          fromEnv: { expression: '%value.safe()', env: { value: undefined } },
        },
      })
    ).toEqual(['ok'])

    const declaredOptions: EvaluateOptions = {
      env: { value: observation },
      envTypes: { value: { type: 'Patient' } },
      functions: safeFunctions,
    }
    const declaredMessage = errorMessage(() => strict.evaluate('%value.safe()', undefined, declaredOptions))
    expect(declaredMessage).toContain("Custom function 'safe': Element 'nope' is not defined on FHIR.Observation")

    const possibleMessage = errorMessage(() =>
      strict.evaluate('opaque().broken()', undefined, {
        functions: {
          opaque: { minArity: 0, maxArity: 0, fn: () => observation },
          broken: {
            overloads: [
              { expression: 'id', signature: { input: { types: ['Patient'] } } },
              { expression: 'nope', signature: { input: { types: ['Observation'] } } },
            ],
          },
        },
      })
    )
    expect(possibleMessage).toContain("Custom function 'broken': Element 'nope' is not defined on FHIR.Observation")
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
    expect(
      bareStrict.evaluate("'x'.safe()", undefined, {
        functions: {
          safe: {
            overloads: [
              { expression: "'ok'", signature: { input: { types: ['System.String'] } } },
              { expression: "1 + 'x'", signature: { input: { types: ['System.Integer'] } } },
            ],
          },
        },
      })
    ).toEqual(['ok'])
  })

  it('recognizes runtime type-name roots outside the FHIR model', () => {
    expect(strict.evaluate('String.length()', 'abc')).toEqual([3])
    expect(strict.evaluate('Integer.toString()', 12)).toEqual(['12'])
    expect(strict.evaluate('CustomResource.anything', { resourceType: 'CustomResource', anything: 'works' })).toEqual([
      'works',
    ])
    expect(
      strict.evaluate('opaque().Integer.toString()', undefined, {
        functions: { opaque: { minArity: 0, maxArity: 0, fn: () => 12 } },
      })
    ).toEqual(['12'])
  })
})
