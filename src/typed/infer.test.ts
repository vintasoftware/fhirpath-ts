import { describe, expect, expectTypeOf, it } from 'vitest'

import { compile } from '../api/compile.ts'
import { column } from '../api/dto.ts'
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

const observation = {
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'weight' },
  valueQuantity: { value: 80, unit: 'kg', system: 'http://unitsofmeasure.org', code: 'kg' },
} as const

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

describe('fixed-return conversion functions', () => {
  it('toQuantity() chains agree with the runtime', () => {
    const quantity = compile("Observation.value.ofType(Quantity).toQuantity('kg')").evaluate(observation, options)
    expectTypeOf(quantity).toEqualTypeOf<Quantity[]>()
    expect(quantity).toEqual([{ value: 80, unit: 'kg' }])

    const value = compile("Observation.value.ofType(Quantity).toQuantity('kg').value").evaluate(observation, options)
    expectTypeOf(value).toEqualTypeOf<number[]>()
    expect(value).toEqual([80])

    // A dot inside the UCUM argument reassembles via the one-level paren logic.
    expectTypeOf<FhirpathResult<"Observation.value.ofType(Quantity).toQuantity('kg.m/s2').value">>().toEqualTypeOf<
      number[]
    >()
    expectTypeOf<FhirpathResult<'Observation.value.ofType(Quantity).toQuantity()'>>().toEqualTypeOf<Quantity[]>()
  })

  it('string and boolean conversions agree with the runtime', () => {
    const asString = compile('Patient.name.given.first().toString()').evaluate(patient, options)
    expectTypeOf(asString).toEqualTypeOf<string[]>()
    expect(asString).toEqual(['Peter'])

    const convertible = compile('Patient.birthDate.convertsToDate()').evaluate(patient, options)
    expectTypeOf(convertible).toEqualTypeOf<boolean[]>()
    expect(convertible).toEqual([true])

    const chars = compile('Patient.name.family.first().toChars()').evaluate(patient, options)
    expectTypeOf(chars).toEqualTypeOf<string[]>()
    expect(chars).toEqual(['C', 'h', 'a', 'l', 'm', 'e', 'r', 's'])

    const joined = compile("Patient.name.first().given.join(', ')").evaluate(patient, options)
    expectTypeOf(joined).toEqualTypeOf<string[]>()
    expect(joined).toEqual(['Peter, James'])
  })

  it('date, boolean, and numeric conversions agree with the runtime', () => {
    const date = compile('Patient.birthDate.toDate()').evaluate(patient, options)
    expectTypeOf(date).toEqualTypeOf<string[]>()
    expect(date).toEqual(['1974-12-25'])

    const dateTime = compile('Patient.birthDate.toDateTime()').evaluate(patient, options)
    expectTypeOf(dateTime).toEqualTypeOf<string[]>()
    expect(dateTime).toEqual(['1974-12-25'])

    const time = compile('Patient.birthDate.toTime()').evaluate(patient, options)
    expectTypeOf(time).toEqualTypeOf<string[]>()
    expect(time).toEqual([])

    const bool = compile('Patient.active.toBoolean()').evaluate(patient, options)
    expectTypeOf(bool).toEqualTypeOf<boolean[]>()
    expect(bool).toEqual([true])

    const decimal = compile('Patient.name.count().toDecimal()').evaluate(patient, options)
    expectTypeOf(decimal).toEqualTypeOf<number[]>()
    expect(decimal).toEqual([2])

    const integer = compile('Patient.name.given.first().toInteger()').evaluate(patient, options)
    expectTypeOf(integer).toEqualTypeOf<number[]>()
    expect(integer).toEqual([])
  })

  it('exists() with a criteria argument is a boolean', () => {
    const hasOfficial = compile("Patient.name.exists(use = 'official')").evaluate(patient, options)
    expectTypeOf(hasOfficial).toEqualTypeOf<boolean[]>()
    expect(hasOfficial).toEqual([true])
  })

  it('a fixed-return function never rescues an opaque prefix', () => {
    expectTypeOf<FhirpathResult<'Patient.name.unknownFn().toString()'>>().toEqualTypeOf<unknown[]>()
  })

  it('a fixed-return call after an unknown element matches the runtime', () => {
    // An unknown element is not 'opaque': it widens the state to plain
    // `string` (see Navigate), which ResultOf maps to unknown[] — but a
    // fixed-return call after it keeps its concrete type, agreeing with the
    // runtime's empty-input semantics.
    expectTypeOf<FhirpathResult<'Patient.nope'>>().toEqualTypeOf<unknown[]>()
    const exists = compile('Patient.nope.exists()').evaluate(patient, options)
    expectTypeOf(exists).toEqualTypeOf<boolean[]>()
    expect(exists).toEqual([false])
  })
})

describe('column() integration', () => {
  it('infers the value type without a declared type option', () => {
    const kg = column("Observation.value.ofType(Quantity).toQuantity('kg').value", { default: 0 })
    expectTypeOf(kg).toEqualTypeOf<number>()
  })
})

describe('operator-glued segments degrade instead of inferring the swallowed match', () => {
  // Each of these runtime-evaluates to a boolean or a union, but the last
  // segment ends in ')' or ']', so a naive pattern match would swallow the
  // operator and claim the function's type. They must all be unknown[].
  it('a parenthesized right operand cannot hide inside a function argument', () => {
    expectTypeOf<FhirpathResult<"Patient.name.given.join(', ') = ('x')">>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<"Patient.name.where(use = 'a') = (Patient.name)">>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<"Observation.value.ofType(Quantity).toQuantity('kg') > (5)">>().toEqualTypeOf<
      unknown[]
    >()
    expectTypeOf<
      FhirpathResult<"Observation.value.ofType(Quantity).convertsToQuantity('kg') or (true)">
    >().toEqualTypeOf<unknown[]>()
  })

  it('an operator between two indexers cannot hide inside one indexer', () => {
    expectTypeOf<FhirpathResult<'Patient.name.family[0] | active[0]'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name.family[0] = given[0]'>>().toEqualTypeOf<unknown[]>()
  })

  it('a paren inside a string literal cannot make a glued operator look balanced', () => {
    // Runtime: join → 11-char string → length() → [11]; the type layer cannot
    // split this segment safely (the literal paren fools the paren counting),
    // so it must degrade rather than claim string[].
    expectTypeOf<FhirpathResult<"Patient.name.given.join('(').length()">>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<"Patient.name.where(family = 'A(').family.first()">>().toEqualTypeOf<unknown[]>()
    // A literal paren with no trailing segments is still precise.
    expectTypeOf<FhirpathResult<"Patient.name.given.join('(')">>().toEqualTypeOf<string[]>()
  })

  it('escaped quotes and delimited identifiers in arguments degrade, never lie', () => {
    // Backslash escapes can confound quote pairing, so such arguments are
    // declined outright — including the glued-operator shape they could hide.
    expectTypeOf<FhirpathResult<"Patient.name.where(family = 'it\\'s') = ('y')">>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<"Patient.name.where(given.first() = 'it\\'s')">>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name.where(`div`.exists())'>>().toEqualTypeOf<unknown[]>()
  })

  it('where() conditions with sane parentheses keep their precision', () => {
    const withCall = compile("Patient.name.where(given.first() = 'Peter')").evaluate(patient, options)
    expectTypeOf(withCall).toEqualTypeOf<HumanName[]>()
    expect(withCall).toHaveLength(1)

    const twoClauses = compile('Patient.name.where(use.exists() and given.exists())').evaluate(patient, options)
    expectTypeOf(twoClauses).toEqualTypeOf<HumanName[]>()
    expect(twoClauses).toHaveLength(2)
  })

  it('select() stays sound without an argument guard, and keeps nested precision', () => {
    // select's argument is re-parsed rather than CleanArg-guarded: glued
    // operators die in Navigate on the way through…
    expectTypeOf<FhirpathResult<"Patient.name.select(family) = ('x')">>().toEqualTypeOf<unknown[]>()
    // …while guard-free dispatch keeps nesting the argument guard would reject.
    const nested = compile('Patient.name.select(given.where(use.exists()))').evaluate(patient, options)
    expectTypeOf(nested).toEqualTypeOf<string[]>()
    expect(nested).toEqual([])
  })

  it('segments after a paren segment resolve instead of merging into it', () => {
    // Regression: the tail after `where(...)` used to be swallowed into the
    // where() segment, inferring HumanName[] — a wrong type, not just imprecise.
    const family = compile("Patient.name.where(use = 'official').family.first()").evaluate(patient, options)
    expectTypeOf(family).toEqualTypeOf<string[]>()
    expect(family).toEqual(['Chalmers'])

    // One-level nesting inside a trailing paren segment still resolves.
    const nested = compile('Patient.name.select(given.first())').evaluate(patient, options)
    expectTypeOf(nested).toEqualTypeOf<string[]>()
    expect(nested).toEqual(['Peter', 'Jim'])
  })
})

describe('degradation to unknown[]', () => {
  it('constructs outside the subset degrade instead of erroring', () => {
    expectTypeOf<FhirpathResult<'Patient.name.given | Patient.name.family'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name.given.substring(1)'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.descendants()'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name.unknownFn()'>>().toEqualTypeOf<unknown[]>()
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
  it('flags mismatched inputs at compile time (and the engine yields empty at runtime)', () => {
    const expression = compile('Patient.name.given')
    expect(
      // @ts-expect-error an Observation-shaped object is not a Patient
      expression.evaluate({ resourceType: 'Observation', status: 'final' }, options)
    ).toEqual([])
  })
})
