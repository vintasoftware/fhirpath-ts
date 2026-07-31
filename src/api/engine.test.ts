import { describe, expect, expectTypeOf, it } from 'vitest'

import { FhirPathRuntimeError } from '../errors.ts'
import type { Bundle, Observation, Patient } from '../r4/generated/type-maps.ts'
import { r4, r4Model } from '../r4/index.ts'
import { compile } from './compile.ts'
import { BoundExpression, FhirPathEngine } from './engine.ts'
import type { Projection } from './project.ts'

const patient: Patient = {
  resourceType: 'Patient',
  id: 'example',
  active: true,
  birthDate: '1974-12-25',
  name: [
    { use: 'official', family: 'Chalmers', given: ['Peter', 'James'] },
    { use: 'usual', given: ['Jim'] },
  ],
  contact: [{ name: { family: 'du Marché' }, telecom: [{ system: 'phone', value: '555-0101' }] }],
}

const observation: Observation = {
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'Weight' },
  valueQuantity: { value: 72.5, unit: 'kg' },
}

const otherPatient: Patient = { resourceType: 'Patient', id: 'other', birthDate: '1994-06-01', gender: 'female' }

// One entry deliberately has no resource (e.g. a transaction-response entry).
const searchset: Bundle = {
  resourceType: 'Bundle',
  type: 'searchset',
  entry: [{ resource: patient }, { fullUrl: 'urn:no-resource' }, { resource: otherPatient }],
}

describe('FhirPathEngine.evaluate', () => {
  it('compiles and evaluates in one call, typed, with the bound model', () => {
    const given = r4.evaluate('Patient.name.given', patient)
    expectTypeOf(given).toEqualTypeOf<string[]>()
    expect(given).toEqual(['Peter', 'James', 'Jim'])

    // Choice-stem navigation proves the model is actually applied.
    expect(r4.evaluate('Observation.value', observation)).toEqual([{ value: 72.5, unit: 'kg' }])
  })

  it('accepts a CompiledExpression', () => {
    expect(r4.evaluate(compile('Patient.name.family'), patient)).toEqual(['Chalmers'])
  })

  it('binds env defaults and lets per-call options override them', () => {
    const engine = new FhirPathEngine({ model: r4Model, env: { threshold: 5 } })
    expect(engine.evaluate('%threshold + 1')).toEqual([6])
    expect(engine.evaluate('%threshold + 1', undefined, { env: { threshold: 10 } })).toEqual([11])
  })

  it('keeps engine-only options out of the bound per-call defaults', () => {
    const engine = new FhirPathEngine({ model: r4Model, cacheSize: 10 })
    expect(engine.defaults).toEqual({ model: r4Model })
    expect(engine.evaluate('Patient.name.family', patient)).toEqual(['Chalmers'])
  })

  it('evaluateTyped keeps the internal representation', () => {
    const typed = r4.evaluateTyped('Patient.name.family', patient)
    expect(typed).toHaveLength(1)
    expect(typed[0]?.type).toBe('FHIR.string')
  })
})

describe('Bundle and array inputs', () => {
  it('treats an array of resources as the root collection', () => {
    expect(r4.evaluate('Patient.name.family', [patient, otherPatient])).toEqual(['Chalmers'])
    expect(r4.evaluate('Patient.id', [patient, observation, otherPatient])).toEqual(['example', 'other'])
  })

  it('treats a Bundle as its entry resources, skipping entries without one', () => {
    expect(r4.evaluate('Patient.id', searchset)).toEqual(['example', 'other'])
    expect(r4.first('Patient.name.family', searchset)).toBe('Chalmers')
  })

  it('expressions rooted at Bundle see the bundle itself', () => {
    expect(r4.evaluate('Bundle.entry.count()', searchset)).toEqual([3])
    expect(r4.evaluate('Bundle.entry.resource.ofType(Patient).id', searchset)).toEqual(['example', 'other'])
    expect(r4.test(searchset, "Bundle.type = 'searchset'")).toBe(true)
  })

  it('an array wraps a Bundle back into a single resource', () => {
    expect(r4.evaluate('Bundle.type', [searchset])).toEqual(['searchset'])
    expect(r4.test([searchset], 'entry.count() = 3')).toBe(true)
  })

  it('detects Bundle roots across expression shapes', () => {
    expect(r4.evaluate('Bundle.entry[0].resource.count()', searchset)).toEqual([1]) // indexer
    expect(r4.evaluate('-Bundle.entry.count()', searchset)).toEqual([-3]) // unary
    expect(r4.evaluate('Bundle is Bundle', searchset)).toEqual([true]) // typeOp
    expect(r4.evaluate("iif(Bundle.type = 'searchset', 1, 0)", searchset)).toEqual([1]) // call args
    expect(r4.evaluate('today().exists()', searchset)).toEqual([true]) // call without Bundle → unwraps harmlessly
    expect(r4.evaluate('1 + 1', searchset)).toEqual([2]) // literals never reference Bundle
    expect(r4.evaluate('name.given[0]', searchset)).toEqual(['Peter']) // indexer over entries
  })

  it('handles a Bundle without entries', () => {
    const empty = { resourceType: 'Bundle', type: 'searchset' } as const
    expect(r4.evaluate('Patient.id', empty)).toEqual([])
    expect(r4.checkConstraints(empty, [{ key: 'k', expression: 'name.exists()' }]).valid).toBe(true)
  })

  it('throws on expressions that start at a bare Bundle element', () => {
    expect(() => r4.evaluate('entry.resource.count()', searchset)).toThrow(/Ambiguous expression for a Bundle/)
    expect(() => r4.evaluate('id', searchset)).toThrow(FhirPathRuntimeError) // inherited Resource element
    expect(() => r4.test(searchset, "type = 'searchset'")).toThrow(/Ambiguous/)
    expect(() => r4.first('total', searchset)).toThrow(/Ambiguous/)
    // Both documented escape hatches resolve the ambiguity:
    expect(r4.evaluate('Bundle.entry.resource.count()', searchset)).toEqual([2])
    expect(r4.test([searchset], "type = 'searchset'")).toBe(true)
  })

  it('detects Bundle elements via the static list when no model is bound', () => {
    const bare = new FhirPathEngine()
    expect(() => bare.evaluate('entry.count()', searchset)).toThrow(/Ambiguous/)
    expect(bare.evaluate('Bundle.entry.count()', searchset)).toEqual([3])
  })
})

describe('FhirPathEngine.first', () => {
  it('returns the first value, typed as a scalar', () => {
    const family = r4.first('Patient.name.family', patient)
    expectTypeOf(family).toEqualTypeOf<string | undefined>()
    expect(family).toBe('Chalmers')
  })

  it('returns undefined on empty', () => {
    expect(r4.first('Patient.deceased', patient)).toBeUndefined()
  })
})

describe('FhirPathEngine.compile', () => {
  it('returns a bound expression that needs no options', () => {
    const given = r4.compile('Patient.name.given')
    expect(given).toBeInstanceOf(BoundExpression)
    expect(given.source).toBe('Patient.name.given')
    expect(given.toString()).toBe('Patient.name.given')

    const values = given.evaluate(patient)
    expectTypeOf(values).toEqualTypeOf<string[]>()
    expect(values).toEqual(['Peter', 'James', 'Jim'])
    expect(given.first(patient)).toBe('Peter')
    expect(given.evaluateTyped(patient)).toHaveLength(3)
    expect(r4.compile("name.family = 'Chalmers'").test(patient)).toBe(true)
  })
})

describe('FhirPathEngine.test', () => {
  it('evaluates criteria with invariant semantics', () => {
    expect(r4.test(patient, "name.family = 'Chalmers'")).toBe(true)
    expect(r4.test(patient, "name.family = 'Nobody'")).toBe(false)
    // Empty → false; a single non-boolean item → true (spec §4.5).
    expect(r4.test(patient, 'Patient.deceased')).toBe(false)
    expect(r4.test(patient, 'Patient.birthDate')).toBe(true)
  })

  it('rejects multi-item results instead of guessing', () => {
    expect(() => r4.test(patient, 'Patient.name.given')).toThrow(FhirPathRuntimeError)
  })
})

describe('FhirPathEngine.filter', () => {
  it('keeps the items matching the criteria', () => {
    const other: Patient = { resourceType: 'Patient', id: 'other', birthDate: '1994-06-01' }
    const filtered = r4.filter([patient, other], 'birthDate < @1990-01-01')
    expect(filtered).toEqual([patient])
    expectTypeOf(filtered).toEqualTypeOf<Patient[]>()
  })

  it('drops items whose criteria come up empty', () => {
    expect(r4.filter([patient], 'Patient.deceased')).toEqual([])
  })

  it('filters a Bundle by its entry resources', () => {
    expect(r4.filter(searchset, "gender = 'female'")).toEqual([otherPatient])
  })

  it('does not unwrap an item that is itself a Bundle', () => {
    // Unlike test(), per-item criteria see the item raw — no Bundle transparency,
    // no ambiguity throw — so bundles inside an array (or a bundle of bundles)
    // can be filtered by their own elements.
    expect(r4.filter([searchset], "type = 'searchset'")).toEqual([searchset])
  })
})

describe('FhirPathEngine.project', () => {
  it('shapes a typed row, scalar by default, collections on request', () => {
    const row = r4.project(patient, {
      id: 'Patient.id',
      family: 'Patient.name.family.first()',
      given: { path: 'Patient.name.given', collection: true },
      deceased: 'Patient.deceased.ofType(boolean)',
    })
    expectTypeOf(row.id).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.given).toEqualTypeOf<string[]>()
    expectTypeOf(row.deceased).toEqualTypeOf<boolean | undefined>()
    expect(row).toEqual({
      id: 'example',
      family: 'Chalmers',
      given: ['Peter', 'James', 'Jim'],
      deceased: undefined,
    })
  })

  it('column type annotations declare what inference cannot see', () => {
    const row = r4.project(patient, {
      // Outside the inference subset (operators, join/trim) → unknown without a declared type.
      inferred: "(Patient.name.family + ' ' + Patient.name.given.join(' ')).trim()",
      name: { path: "(Patient.name.family + ' ' + Patient.name.given.join(' ')).trim()", type: 'string' },
      initials: { path: 'Patient.name.given.select(substring(0, 1))', collection: true, type: 'string' },
    })
    expectTypeOf(row.inferred).toEqualTypeOf<unknown>()
    expectTypeOf(row.name).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.initials).toEqualTypeOf<string[]>()
    expect(row).toEqual({
      inferred: 'Chalmers Peter James Jim',
      name: 'Chalmers Peter James Jim',
      initials: ['P', 'J', 'J'],
    })
  })

  it('throws when a scalar column yields several values (SQL-on-FHIR column rule)', () => {
    expect(() => r4.project(patient, { given: 'Patient.name.given' })).toThrow(/column 'given' yielded 3 values/)
  })

  it('produces one row per resource for arrays and Bundles', () => {
    const fromArray = r4.project([patient, otherPatient], { id: 'Patient.id', born: 'Patient.birthDate' })
    expectTypeOf(fromArray).toEqualTypeOf<Projection<{ id: 'Patient.id'; born: 'Patient.birthDate' }>[]>()
    expect(fromArray).toEqual([
      { id: 'example', born: '1974-12-25' },
      { id: 'other', born: '1994-06-01' },
    ])

    // The Bundle overload resolves to concrete typed rows, not just the alias:
    const fromBundle = r4.project(searchset, {
      id: 'Patient.id',
      family: 'Patient.name.family.first()',
      given: { path: 'Patient.name.given', collection: true },
    })
    expectTypeOf(fromBundle).toEqualTypeOf<{ id: string | undefined; family: string | undefined; given: string[] }[]>()
    expect(fromBundle).toEqual([
      { id: 'example', family: 'Chalmers', given: ['Peter', 'James', 'Jim'] },
      { id: 'other', family: undefined, given: [] },
    ])
  })
})

describe('FhirPathEngine.checkConstraints', () => {
  const contactRule = {
    key: 'pat-1',
    severity: 'error',
    human: 'Contact needs a name or telecom',
    expression: 'contact.all(name.exists() or telecom.exists())',
  } as const

  it('passes when every constraint holds', () => {
    const result = r4.checkConstraints(patient, [contactRule])
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.toOperationOutcome()).toEqual({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'information', code: 'informational', details: { text: 'All constraints passed' } }],
    })
  })

  it('reports failed constraints; warnings do not invalidate', () => {
    const result = r4.checkConstraints(patient, [
      contactRule,
      { key: 'no-jim', human: 'No Jims allowed', expression: "(name.given contains 'Jim').not()" },
      { key: 'w-1', severity: 'warning', human: 'Prefer a gender', expression: 'gender.exists()' },
    ])
    expect(result.valid).toBe(false)
    expect(result.issues.map(issue => [issue.key, issue.severity])).toEqual([
      ['no-jim', 'error'], // severity defaults to error
      ['w-1', 'warning'],
    ])

    const outcome = result.toOperationOutcome()
    expect(outcome.issue).toEqual([
      {
        severity: 'error',
        code: 'invariant',
        details: { text: 'No Jims allowed' },
        diagnostics: "(name.given contains 'Jim').not()",
      },
      {
        severity: 'warning',
        code: 'invariant',
        details: { text: 'Prefer a gender' },
        diagnostics: 'gender.exists()',
      },
    ])

    const warningsOnly = r4.checkConstraints(patient, [
      { key: 'w-1', severity: 'warning', expression: 'gender.exists()' },
    ])
    expect(warningsOnly.valid).toBe(true)
    expect(warningsOnly.issues).toHaveLength(1)
  })

  it('reports a broken expression as a failed issue instead of throwing', () => {
    const result = r4.checkConstraints(patient, [{ key: 'bad', expression: '1 +' }])
    expect(result.valid).toBe(false)
    expect(result.issues[0]?.error).toContain('Unexpected end of expression')
    expect(result.toOperationOutcome().issue[0]?.diagnostics).toContain('1 +')
    expect(result.toOperationOutcome().issue[0]?.details.text).toBe('Constraint bad failed')
  })

  it('checks each resource of a Bundle, reporting entry positions', () => {
    const result = r4.checkConstraints(searchset, [
      { key: 'needs-name', human: 'Patient needs a name', expression: 'name.exists()' },
    ])
    expect(result.valid).toBe(false)
    // otherPatient sits at entry[2]; entry[1] has no resource and is skipped.
    expect(result.issues).toEqual([
      { key: 'needs-name', severity: 'error', human: 'Patient needs a name', expression: 'name.exists()', index: 2 },
    ])
    expect(result.toOperationOutcome().issue[0]?.expression).toEqual(['Bundle.entry[2].resource'])
  })

  it('checks each item of an array, reporting indexes without Bundle paths', () => {
    const result = r4.checkConstraints([patient, otherPatient], [{ key: 'needs-name', expression: 'name.exists()' }])
    expect(result.issues).toEqual([{ key: 'needs-name', severity: 'error', expression: 'name.exists()', index: 1 }])
    expect(result.toOperationOutcome().issue[0]?.expression).toBeUndefined()
  })

  it('validates a Bundle itself when wrapped in an array', () => {
    const result = r4.checkConstraints(
      [searchset],
      [{ key: 'bdl-like', human: 'searchset only', expression: "type = 'searchset'" }]
    )
    expect(result.valid).toBe(true)
  })

  it('captures non-engine errors (e.g. a throwing trace sink) the same way', () => {
    const boom = () => {
      throw new Error('sink exploded')
    }
    const result = r4.checkConstraints(patient, [{ key: 't-1', expression: "name.trace('t').exists()" }], {
      trace: boom,
    })
    expect(result.valid).toBe(false)
    expect(result.issues[0]?.error).toBe('Error: sink exploded')
  })
})
