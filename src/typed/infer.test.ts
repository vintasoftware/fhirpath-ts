import { describe, expect, expectTypeOf, it } from 'vitest'
import { compile } from '../api/compile.ts'
import { fhirpath } from '../api/tagged.ts'
import type { HumanName, Identifier, Patient, PatientContact, Quantity } from '../r4/generated/type-maps.ts'
import { r4Model } from '../r4/index.ts'
import type { FhirpathInput, FhirpathResult } from './infer.ts'

const patient: Patient = {
  resourceType: 'Patient',
  id: 'example',
  active: true,
  birthDate: '1974-12-25',
  name: [
    { use: 'official', family: 'Chalmers', given: ['Peter', 'James'] },
    { use: 'usual', given: ['Jim'] },
  ],
  deceasedBoolean: false,
  contact: [{ name: { family: 'du Marché' } }],
}

const options = { model: r4Model }

/** Dual assertions: the inferred type and the runtime result must agree. */
describe('type-level inference agrees with the runtime', () => {
  it('simple dotted paths', () => {
    const given = compile('Patient.name.given').evaluate(patient, options)
    expectTypeOf(given).toEqualTypeOf<string[]>()
    expect(given).toEqual(['Peter', 'James', 'Jim'])

    const active = compile('Patient.active').evaluate(patient, options)
    expectTypeOf(active).toEqualTypeOf<boolean[]>()
    expect(active).toEqual([true])

    const names = compile('Patient.name').evaluate(patient, options)
    expectTypeOf(names).toEqualTypeOf<HumanName[]>()
    expect(names).toHaveLength(2)
  })

  it('inherited and backbone elements', () => {
    const id = compile('Patient.id').evaluate(patient, options)
    expectTypeOf(id).toEqualTypeOf<string[]>()
    expect(id).toEqual(['example'])

    const contact = compile('Patient.contact').evaluate(patient, options)
    expectTypeOf(contact).toEqualTypeOf<PatientContact[]>()
    const contactFamily = compile('Patient.contact.name.family').evaluate(patient, options)
    expectTypeOf(contactFamily).toEqualTypeOf<string[]>()
    expect(contactFamily).toEqual(['du Marché'])
  })

  it('choice elements resolve by stem to the union of choices', () => {
    const deceased = compile('Patient.deceased').evaluate(patient, options)
    expectTypeOf(deceased).toEqualTypeOf<(boolean | string)[]>()
    expect(deceased).toEqual([false])
  })

  it('first/last/single keep the element type', () => {
    const first = compile('Patient.name.first().given').evaluate(patient, options)
    expectTypeOf(first).toEqualTypeOf<string[]>()
    expect(first).toEqual(['Peter', 'James'])
  })

  it('indexers keep the element type', () => {
    const indexed = compile('Patient.name[0].given').evaluate(patient, options)
    expectTypeOf(indexed).toEqualTypeOf<string[]>()
    expect(indexed).toEqual(['Peter', 'James'])
  })

  it('where() is type-preserving', () => {
    const official = compile("Patient.name.where(use = 'official').family").evaluate(patient, options)
    expectTypeOf(official).toEqualTypeOf<string[]>()
    expect(official).toEqual(['Chalmers'])
  })

  it('select() projects sub-paths', () => {
    const selected = compile('Patient.name.select(family)').evaluate(patient, options)
    expectTypeOf(selected).toEqualTypeOf<string[]>()
    expect(selected).toEqual(['Chalmers'])
  })

  it('boolean and count functions', () => {
    const exists = compile('Patient.name.exists()').evaluate(patient, options)
    expectTypeOf(exists).toEqualTypeOf<boolean[]>()
    expect(exists).toEqual([true])

    const count = compile('Patient.name.count()').evaluate(patient, options)
    expectTypeOf(count).toEqualTypeOf<number[]>()
    expect(count).toEqual([2])
  })

  it('ofType() switches the type', () => {
    const quantities = compile('Observation.value.ofType(Quantity)')
    expectTypeOf(quantities.evaluate).returns.toEqualTypeOf<Quantity[]>()

    const identifiers = compile('Patient.identifier').evaluate(patient, options)
    expectTypeOf(identifiers).toEqualTypeOf<Identifier[]>()
  })

  it('the input type follows the root resource', () => {
    expectTypeOf<FhirpathInput<'Patient.name'>>().toEqualTypeOf<Patient>()
    expectTypeOf<FhirpathInput<'name.given'>>().toEqualTypeOf<unknown>()
  })
})

describe('degradation to unknown[]', () => {
  it('constructs outside the subset degrade instead of erroring', () => {
    expectTypeOf<FhirpathResult<'Patient.name.given | Patient.name.family'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name.given.substring(1)'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.descendants()'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'name.given'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.nope'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name.where(a.exists()).given'>>().toEqualTypeOf<unknown[]>()
  })

  it('non-literal expressions stay unknown[]', () => {
    const dynamic: string = ['Patient', 'name'].join('.')
    const result = compile(dynamic).evaluate(patient, options)
    expectTypeOf(result).toEqualTypeOf<unknown[]>()
    expect(result).toHaveLength(2)
  })

  it('the tagged form works at runtime (literal types cannot cross tags yet)', () => {
    expect(fhirpath`Patient.name.given`.evaluate(patient, options)).toEqual(['Peter', 'James', 'Jim'])
    expect(fhirpath('Patient.name.given').evaluate(patient, options)).toEqual(['Peter', 'James', 'Jim'])
    const typed = fhirpath('Patient.name.given').evaluate(patient, options)
    expectTypeOf(typed).toEqualTypeOf<string[]>()
  })
})

describe('input typing rejects the wrong resource shape', () => {
  it('flags mismatched inputs at compile time (and the engine rejects them at runtime)', () => {
    const expression = compile('Patient.name.given')
    expect(() =>
      // @ts-expect-error an Observation-shaped object is not a Patient
      expression.evaluate({ resourceType: 'Observation', status: 'final' }, options)
    ).toThrow("Element 'Patient' is not defined")
  })
})
