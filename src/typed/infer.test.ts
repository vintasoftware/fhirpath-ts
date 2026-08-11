import { describe, expect, expectTypeOf, it } from 'vitest'

import { compile } from '../api/compile.ts'
import { column, defineDto } from '../api/dto.ts'
import { fhirpath } from '../api/tagged.ts'
import type {
  HumanName,
  Identifier,
  MedicationRequest,
  Patient,
  PatientContact,
  Quantity,
  SystemQuantity,
} from '../r4/generated/type-maps.ts'
import { r4Model } from '../r4/index.ts'
import { type FhirpathInput, type FhirpathResult } from './infer.ts'

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
    expectTypeOf(quantity).toEqualTypeOf<SystemQuantity[]>()
    expect(quantity).toEqual([{ value: 80, unit: 'kg' }])

    const value = compile("Observation.value.ofType(Quantity).toQuantity('kg').value").evaluate(observation, options)
    expectTypeOf(value).toEqualTypeOf<number[]>()
    expect(value).toEqual([80])

    // A dot inside the UCUM argument reassembles via the one-level paren logic.
    expectTypeOf<FhirpathResult<"Observation.value.ofType(Quantity).toQuantity('kg.m/s2').value">>().toEqualTypeOf<
      number[]
    >()
    expectTypeOf<FhirpathResult<'Observation.value.ofType(Quantity).toQuantity()'>>().toEqualTypeOf<SystemQuantity[]>()
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

    // Same for the batch-2 entries: an argument-taking fixed-return call
    // after an unknown element evaluates to empty, which boolean[] covers.
    const matched = compile("Patient.nope.matches('x')").evaluate(patient, options)
    expectTypeOf(matched).toEqualTypeOf<boolean[]>()
    expect(matched).toEqual([])
  })
})

describe('fixed-return string, boolean, and numeric functions (batch 2)', () => {
  it('string functions agree with the runtime', () => {
    const trimmed = compile('Patient.name.family.first().trim()').evaluate(patient, options)
    expectTypeOf(trimmed).toEqualTypeOf<string[]>()
    expect(trimmed).toEqual(['Chalmers'])

    // Comma-separated arguments pass the CleanArg check.
    const initial = compile('Patient.name.given.first().substring(0, 1)').evaluate(patient, options)
    expectTypeOf(initial).toEqualTypeOf<string[]>()
    expect(initial).toEqual(['P'])

    const replaced = compile("Patient.name.family.first().replace('mers', 'm')").evaluate(patient, options)
    expectTypeOf(replaced).toEqualTypeOf<string[]>()
    expect(replaced).toEqual(['Chalm'])

    const upper = compile('Patient.name.given.first().upper()').evaluate(patient, options)
    expectTypeOf(upper).toEqualTypeOf<string[]>()
    expect(upper).toEqual(['PETER'])

    const split = compile("Patient.name.given.first().split('e')").evaluate(patient, options)
    expectTypeOf(split).toEqualTypeOf<string[]>()
    expect(split).toEqual(['P', 't', 'r'])

    const encoded = compile("Patient.name.family.first().encode('base64')").evaluate(patient, options)
    expectTypeOf(encoded).toEqualTypeOf<string[]>()
    expect(encoded).toEqual(['Q2hhbG1lcnM='])
  })

  it('boolean functions agree with the runtime', () => {
    const matched = compile("Patient.name.family.first().matches('^Ch')").evaluate(patient, options)
    expectTypeOf(matched).toEqualTypeOf<boolean[]>()
    expect(matched).toEqual([true])

    const starts = compile("Patient.name.given.first().startsWith('Pe')").evaluate(patient, options)
    expectTypeOf(starts).toEqualTypeOf<boolean[]>()
    expect(starts).toEqual([true])

    const distinct = compile('Patient.name.given.isDistinct()').evaluate(patient, options)
    expectTypeOf(distinct).toEqualTypeOf<boolean[]>()
    expect(distinct).toEqual([true])

    const all = compile('Patient.name.all(use.exists())').evaluate(patient, options)
    expectTypeOf(all).toEqualTypeOf<boolean[]>()
    expect(all).toEqual([true])

    const subset = compile('Patient.name.given.subsetOf(name.given)').evaluate(patient, options)
    expectTypeOf(subset).toEqualTypeOf<boolean[]>()
    expect(subset).toEqual([true])
  })

  it('integer and decimal functions agree with the runtime', () => {
    const index = compile("Patient.name.given.first().indexOf('e')").evaluate(patient, options)
    expectTypeOf(index).toEqualTypeOf<number[]>()
    expect(index).toEqual([1])

    const ceiling = compile('Patient.name.count().toDecimal().ceiling()').evaluate(patient, options)
    expectTypeOf(ceiling).toEqualTypeOf<number[]>()
    expect(ceiling).toEqual([2])

    const rounded = compile('Patient.name.count().toDecimal().round()').evaluate(patient, options)
    expectTypeOf(rounded).toEqualTypeOf<number[]>()
    expect(rounded).toEqual([2])

    const root = compile('Patient.name.count().sqrt()').evaluate(patient, options)
    expectTypeOf(root).toEqualTypeOf<number[]>()
    expect(root).toEqual([1.4142135623730951])
  })

  it('identity functions keep the input type', () => {
    const distinct = compile('Patient.name.given.distinct()').evaluate(patient, options)
    expectTypeOf(distinct).toEqualTypeOf<string[]>()
    expect(distinct).toEqual(['Peter', 'James', 'Jim'])

    const tail = compile('Patient.name.tail().given').evaluate(patient, options)
    expectTypeOf(tail).toEqualTypeOf<string[]>()
    expect(tail).toEqual(['Jim'])

    const skipped = compile('Patient.name.given.skip(1)').evaluate(patient, options)
    expectTypeOf(skipped).toEqualTypeOf<string[]>()
    expect(skipped).toEqual(['James', 'Jim'])

    const taken = compile('Patient.name.given.take(2)').evaluate(patient, options)
    expectTypeOf(taken).toEqualTypeOf<string[]>()
    expect(taken).toEqual(['Peter', 'James'])

    const excluded = compile("Patient.name.given.exclude('Jim')").evaluate(patient, options)
    expectTypeOf(excluded).toEqualTypeOf<string[]>()
    expect(excluded).toEqual(['Peter', 'James'])

    const intersected = compile('Patient.name.given.intersect(name.first().given)').evaluate(patient, options)
    expectTypeOf(intersected).toEqualTypeOf<string[]>()
    expect(intersected).toEqual(['Peter', 'James'])
  })
})

describe('a declared root types a relative expression', () => {
  it('infers against the root instead of degrading', () => {
    // fhirpath(expr, root) / compile(expr, root): the same inference a DTO column
    // gets, for an expression that lives in a const and runs somewhere else.
    const kg = fhirpath("value.ofType(Quantity).toQuantity('kg').value", 'Observation')
    expectTypeOf(kg.evaluate).returns.toEqualTypeOf<number[]>()
    const status = compile('status', 'MedicationRequest')
    expectTypeOf(status.evaluate).returns.toEqualTypeOf<string[]>()
    // The declared root is also the input type, rather than one guessed from the path.
    expectTypeOf(status.evaluate).parameter(0).toEqualTypeOf<MedicationRequest | undefined>()
    // Without a root, a relative expression degrades as before.
    expectTypeOf(fhirpath('status').evaluate).returns.toEqualTypeOf<unknown[]>()
  })
})

describe('DTO column integration', () => {
  it('infers the value type without a declared type option', () => {
    // Rooted at the resource name, and relative to the DTO's fhirType: both
    // resolve, so a column never needs its type spelled out — and the field's
    // declared type is checked against what the expression yields.
    class WeightRow extends defineDto('Observation') {
      @column("Observation.value.ofType(Quantity).toQuantity('kg').value", { default: 0 })
      rooted!: number

      @column("value.ofType(Quantity).toQuantity('kg').value", { default: 0 })
      relative!: number
    }
    const row = new WeightRow()
    expectTypeOf(row.rooted).toEqualTypeOf<number>()
    expectTypeOf(row.relative).toEqualTypeOf<number>()
  })
})

describe('operators after calls and indexers keep their runtime result', () => {
  it('a parenthesized right operand cannot hide inside a function argument', () => {
    expectTypeOf<FhirpathResult<"Patient.name.given.join(', ') = ('x')">>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<"Patient.name.where(use = 'a') = (Patient.name)">>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<"Observation.value.ofType(Quantity).toQuantity('kg') > (5)">>().toEqualTypeOf<
      boolean[]
    >()
    expectTypeOf<
      FhirpathResult<"Observation.value.ofType(Quantity).convertsToQuantity('kg') or (true)">
    >().toEqualTypeOf<boolean[]>()
  })

  it('comma-separated arguments cannot hide a glued operator either', () => {
    // Runtime: [false] / [true] — comparisons, not strings; both must degrade.
    expectTypeOf<FhirpathResult<"Patient.name.given.first().replace('a', 'b') = ('x')">>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<"Patient.name.given.first().substring(0, 1) = ('P')">>().toEqualTypeOf<boolean[]>()
  })

  it('an operator between two indexers cannot hide inside one indexer', () => {
    expectTypeOf<FhirpathResult<'Patient.name.family[0] | active[0]'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name.family[0] = given[0]'>>().toEqualTypeOf<boolean[]>()
  })

  it('a paren inside a string literal does not confuse the segment close', () => {
    // The `).`-scan strips string literals before checking balance, so a
    // literal paren neither ends the segment early nor degrades it.
    const length = compile("Patient.name.given.join('(').length()").evaluate(patient, options)
    expectTypeOf(length).toEqualTypeOf<number[]>()
    expect(length).toEqual([15])

    const filtered = compile("Patient.name.where(family = 'A(').family.first()").evaluate(patient, options)
    expectTypeOf(filtered).toEqualTypeOf<string[]>()
    expect(filtered).toEqual([])

    // A literal paren with no trailing segments is still precise.
    expectTypeOf<FhirpathResult<"Patient.name.given.join('(')">>().toEqualTypeOf<string[]>()
  })

  it('escaped quotes and delimited identifiers preserve token boundaries', () => {
    expectTypeOf<FhirpathResult<"Patient.name.where(family = 'it\\'s') = ('y')">>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<"Patient.name.where(given.first() = 'it\\'s')">>().toEqualTypeOf<HumanName[]>()
    expectTypeOf<FhirpathResult<'Patient.name.where(`div`.exists())'>>().toEqualTypeOf<HumanName[]>()
  })

  it('where() conditions with sane parentheses keep their precision', () => {
    const withCall = compile("Patient.name.where(given.first() = 'Peter')").evaluate(patient, options)
    expectTypeOf(withCall).toEqualTypeOf<HumanName[]>()
    expect(withCall).toHaveLength(1)

    const twoClauses = compile('Patient.name.where(use.exists() and given.exists())').evaluate(patient, options)
    expectTypeOf(twoClauses).toEqualTypeOf<HumanName[]>()
    expect(twoClauses).toHaveLength(2)

    // A call inside the condition plus trailing segments: the `).`-scan finds
    // the close that completes the argument, not the first `).` it sees.
    const nestedCondition = compile('Patient.name.where(a.exists()).given').evaluate(patient, options)
    expectTypeOf(nestedCondition).toEqualTypeOf<string[]>()
    expect(nestedCondition).toEqual([])

    const afterSelect = compile('Patient.name.select(given.first()).count()').evaluate(patient, options)
    expectTypeOf(afterSelect).toEqualTypeOf<number[]>()
    expect(afterSelect).toEqual([2])
  })

  it('select() stays sound without an argument guard, and keeps nested precision', () => {
    // select's argument is re-parsed rather than CleanArg-guarded: glued
    // operators die in Navigate on the way through…
    expectTypeOf<FhirpathResult<"Patient.name.select(family) = ('x')">>().toEqualTypeOf<boolean[]>()
    // Direct dispatch keeps nested calls that the argument check would reject.
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

describe('union groups and top-level unions', () => {
  it('a top-level union infers the union of its term types', () => {
    const strings = compile('Patient.name.given | Patient.name.family').evaluate(patient, options)
    expectTypeOf(strings).toEqualTypeOf<string[]>()
    expect(strings).toEqual(['Peter', 'James', 'Jim', 'Chalmers'])

    const mixed = compile('Patient.active | Patient.name.given').evaluate(patient, options)
    expectTypeOf(mixed).toEqualTypeOf<(boolean | string)[]>()
    expect(mixed).toEqual([true, 'Peter', 'James', 'Jim'])
  })

  it('a group as the root continues through its trailing segments', () => {
    const first = compile('(Patient.name.given | Patient.name.family).first()').evaluate(patient, options)
    expectTypeOf(first).toEqualTypeOf<string[]>()
    expect(first).toEqual(['Peter'])

    // The dogfood Lab-history date column's shape.
    expectTypeOf<
      FhirpathResult<'(DiagnosticReport.effective.ofType(dateTime) | DiagnosticReport.issued).first().toString()'>
    >().toEqualTypeOf<string[]>()
  })

  it('a nested group still resolves', () => {
    const first = compile('((Patient.name.given | Patient.name.family) | Patient.id).first()').evaluate(
      patient,
      options
    )
    expectTypeOf(first).toEqualTypeOf<string[]>()
    expect(first).toEqual(['Peter'])
  })

  it('unions work inside select()', () => {
    const selected = compile('Patient.name.select((given | family).first())').evaluate(patient, options)
    expectTypeOf(selected).toEqualTypeOf<string[]>()
    expect(selected).toEqual(['Peter', 'Jim'])

    // The dogfood routeText column's shape: a union inside select() with a
    // call in one term, plus trailing segments after the select.
    expectTypeOf<
      FhirpathResult<'MedicationRequest.dosageInstruction.first().route.select(text | coding.display.first()).first()'>
    >().toEqualTypeOf<string[]>()
  })

  it('a literal containing | or parens does not split or close the union', () => {
    const filtered = compile("Patient.name.where(family = 'a|b').given").evaluate(patient, options)
    expectTypeOf(filtered).toEqualTypeOf<string[]>()
    expect(filtered).toEqual([])

    const grouped = compile("(Patient.name.given.join('(') | Patient.name.family).first()").evaluate(patient, options)
    expectTypeOf(grouped).toEqualTypeOf<string[]>()
    expect(grouped).toEqual(['Peter(James(Jim'])
  })
})

describe('unions compose through operators', () => {
  it('an operator after a group reports the operator result', () => {
    expectTypeOf<FhirpathResult<"(Patient.name.given | Patient.name.family) = ('x')">>().toEqualTypeOf<boolean[]>()
    expectTypeOf<FhirpathResult<'(Patient.name.given | Patient.name.family).count() > (0)'>>().toEqualTypeOf<
      boolean[]
    >()
    expectTypeOf<FhirpathResult<"(Patient.name.given | Patient.name.family) | (Patient.id) = ('x')">>().toEqualTypeOf<
      boolean[]
    >()
  })

  it('mixed inferable terms produce their public union', () => {
    expectTypeOf<FhirpathResult<'Patient.name.select((given | 5 + 3).first())'>>().toEqualTypeOf<(string | number)[]>()
    // A relative term has no root at the top level (the id | %rowIndex idiom
    // needs a projection context), so the union degrades rather than guessing.
    expectTypeOf<FhirpathResult<'(id | %rowIndex.toString()).first()'>>().toEqualTypeOf<unknown[]>()
  })

  it('word and symbol operators in the middle produce Boolean results', () => {
    expectTypeOf<FhirpathResult<'Patient.name and x.count()'>>().toEqualTypeOf<boolean[]>()
    const compared = compile('Patient.gender = gender.count()').evaluate(patient, options)
    expectTypeOf(compared).toEqualTypeOf<boolean[]>()
    expect(compared).toEqual([])
    expectTypeOf<FhirpathResult<'%a = b.count()'>>().toEqualTypeOf<boolean[]>()
  })
})

describe('%var roots enter the broad state', () => {
  it('plain %var navigation stays unknown[], fixed returns keep their types', () => {
    expectTypeOf<FhirpathResult<'%report.effective'>>().toEqualTypeOf<unknown[]>()

    const key = compile('%rowIndex.toString()').evaluate(patient, { ...options, env: { rowIndex: 3 } })
    expectTypeOf(key).toEqualTypeOf<string[]>()
    expect(key).toEqual(['3'])
  })

  it('%var terms union with typed terms as the broad state', () => {
    // Broad absorbs the union: the join is unknowable, but the trailing
    // fixed-return call is input-independent and stays concrete.
    expectTypeOf<FhirpathResult<'(%missing | Patient.name.given).first()'>>().toEqualTypeOf<unknown[]>()
    const count = compile('(%missing | Patient.name.given).count()').evaluate(patient, {
      ...options,
      env: { missing: undefined },
    })
    expectTypeOf(count).toEqualTypeOf<number[]>()
    expect(count).toEqual([3])

    // The dogfood Lab-results date column's shape.
    expectTypeOf<
      FhirpathResult<'(%report.effective.ofType(dateTime) | %report.issued | ServiceRequest.authoredOn | ServiceRequest.occurrence.ofType(dateTime)).first().toString()'>
    >().toEqualTypeOf<string[]>()
  })

  it('broad stays broad: deeper navigation neither errors nor regains a type', () => {
    expectTypeOf<FhirpathResult<'%report.effective.nested.toString()'>>().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<'Patient.nope.given'>>().toEqualTypeOf<unknown[]>()

    const count = compile('Patient.nope.given.count()').evaluate(patient, options)
    expectTypeOf(count).toEqualTypeOf<number[]>()
    expect(count).toEqual([0])
  })
})

describe('degradation to unknown[]', () => {
  it('keeps one local binding precise and bounds additional definitions', () => {
    expectTypeOf<
      FhirpathResult<"Patient.name.first().defineVariable('n').select(given.select(%n.family))">
    >().toEqualTypeOf<string[]>()
    expectTypeOf<FhirpathResult<"defineVariable('a').defineVariable('b')">>().toEqualTypeOf<unknown[]>()
  })

  it('constructs outside the subset degrade instead of erroring', () => {
    // power's result depends on its input (integer^integer vs decimal), and abs
    // is input-dependent too. Both have explicit unknown analyzer rules.
    expectTypeOf<FhirpathResult<'Patient.name.count().power(2)'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name.count().abs()'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.descendants()'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.name.unknownFn()'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'name.given'>>().toEqualTypeOf<unknown[]>()
    expectTypeOf<FhirpathResult<'Patient.nope'>>().toEqualTypeOf<unknown[]>()
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
