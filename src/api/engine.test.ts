import { describe, expect, expectTypeOf, it } from 'vitest'

import { FhirPathRuntimeError, FhirPathSyntaxError } from '../errors.ts'
import type { Bundle, Observation, Patient } from '../r4/generated/type-maps.ts'
import { r4, r4Model } from '../r4/index.ts'
import { compile } from './compile.ts'
import { BoundExpression, FhirPathEngine, recordEngines } from './engine.ts'
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

  it('merges a per-call env per variable instead of replacing the bound one', () => {
    const engine = new FhirPathEngine({ model: r4Model, env: { threshold: 5 } })
    // The bound variable stays visible next to the per-call addition…
    expect(engine.evaluate('%threshold + %bonus', undefined, { env: { bonus: 2 } })).toEqual([7])
    // …the per-call value wins on the same name…
    expect(engine.evaluate('%threshold', undefined, { env: { threshold: 9, bonus: 2 } })).toEqual([9])
    // …in either spelling — `%name` and `name` are one variable, so a bound
    // `'%threshold'` key cannot shadow the per-call override via insertion order…
    const spelled = new FhirPathEngine({ model: r4Model, env: { threshold: 5, '%threshold': 6 } })
    expect(spelled.evaluate('%threshold', undefined, { env: { threshold: 9 } })).toEqual([9])
    // …a call can blank a bound variable by passing undefined…
    expect(engine.evaluate('%threshold.empty()', undefined, { env: { threshold: undefined } })).toEqual([true])
    // …and the bound defaults are untouched afterwards.
    expect(engine.evaluate('%threshold')).toEqual([5])
  })

  it('merges per-call custom functions per name instead of replacing the bound set', () => {
    const double = { minArity: 0, maxArity: 0, fn: (input: unknown[]) => input.map(v => (v as number) * 2) }
    const triple = { minArity: 0, maxArity: 0, fn: (input: unknown[]) => input.map(v => (v as number) * 3) }
    const engine = new FhirPathEngine({ model: r4Model, functions: { double } })
    // The bound function stays callable next to the per-call addition…
    expect(engine.evaluate('2.double() + 2.triple()', undefined, { functions: { triple } })).toEqual([10])
    // …the per-call record wins on the same name…
    expect(engine.evaluate('2.double()', undefined, { functions: { double: triple } })).toEqual([6])
    // …and the bound defaults are untouched afterwards.
    expect(engine.evaluate('2.double()')).toEqual([4])
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
    // A single non-boolean item → true (spec §4.5); empty → false (the criteria convention).
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
    // One resource has no position worth reporting; a batch names the row that
    // broke the rule, so a long export points at the record to look at.
    expect(() => r4.project(patient, { given: 'Patient.name.given' })).toThrow(
      "project(): column 'given' yielded 3 values; append first() or set collection: true"
    )
    expect(() => r4.project([otherPatient, patient], { given: 'Patient.name.given' })).toThrow(
      "project(): column 'given' yielded 3 values in row 1; append first() or set collection: true"
    )
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

  it('sets %rowIndex and %rowTotal to the row position, overriding same-named caller env', () => {
    const anonymous: Patient = { resourceType: 'Patient' }
    const rows = r4.project(
      [patient, anonymous],
      {
        key: { path: '(Patient.id | %rowIndex.toString()).first()', type: 'string' },
        pos: '%rowIndex',
        of: '%rowTotal',
      },
      { env: { rowIndex: 99, rowTotal: 99 } }
    )
    expect(rows).toEqual([
      { key: 'example', pos: 0, of: 2 },
      { key: '1', pos: 1, of: 2 },
    ])

    // Both spellings at once cannot spoof either: '%rowIndex' normalizes onto the
    // same key as the row's `index` instead of outliving it in insertion order.
    expect(r4.project([patient, anonymous], { pos: '%rowIndex' }, { env: { rowIndex: 99, '%rowIndex': 98 } })).toEqual([
      { pos: 0 },
      { pos: 1 },
    ])

    // A single resource is row 0 of 1, so the same columns work unchanged.
    expect(r4.project(patient, { pos: '%rowIndex', of: '%rowTotal' })).toEqual({ pos: 0, of: 1 })
  })

  it('compiles every column before rows run, so a malformed column throws even with no rows', () => {
    expect(() => r4.project([], { bad: 'name..family' })).toThrow(FhirPathSyntaxError)
  })

  it("as: 'Date' coerces date-valued columns to JS Dates", () => {
    const dated: Observation = {
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'Weight' },
      effectiveDateTime: '2026-01-05T08:30:00Z',
    }
    const row = r4.project(dated, {
      at: { path: 'Observation.effective.ofType(dateTime)', as: 'Date' },
      month: { path: "'2026-01'", as: 'Date' }, // partial date → UTC start of its period
      missing: { path: 'Observation.issued', as: 'Date' },
      invalid: { path: "'not-a-date'", as: 'Date' },
      all: { path: "(Observation.effective.ofType(dateTime) | 'nope')", collection: true, as: 'Date' },
    })
    expectTypeOf(row.at).toEqualTypeOf<Date | undefined>()
    expectTypeOf(row.all).toEqualTypeOf<Date[]>()
    expect(row.at).toEqual(new Date('2026-01-05T08:30:00Z'))
    expect(row.month).toEqual(new Date(Date.UTC(2026, 0, 1)))
    expect(row.missing).toBeUndefined()
    expect(row.invalid).toBeUndefined()
    expect(row.all).toEqual([new Date('2026-01-05T08:30:00Z')])
  })

  it('applies the scalar-column rule before the Date coercion drops unparseable values', () => {
    expect(() => r4.project(patient, { d: { path: "('nope' | '2020')", as: 'Date' } })).toThrow(
      /column 'd' yielded 2 values/
    )
  })

  it('test columns evaluate as boolean criteria (empty → false), like engine.test()', () => {
    const row = r4.project(patient, {
      isActive: { test: 'Patient.active = true' },
      isDeceased: { test: 'Patient.deceased.ofType(boolean)' }, // empty → false
      hasName: { test: 'Patient.name.exists()' },
    })
    expectTypeOf(row.isActive).toEqualTypeOf<boolean>()
    expect(row).toEqual({ isActive: true, isDeceased: false, hasName: true })
  })

  it('default fills an empty result and substitutes for undefined in the type', () => {
    const row = r4.project(patient, {
      maiden: { path: "Patient.name.where(use = 'maiden').family", default: null },
      family: { path: 'Patient.name.family.first()', default: '' },
      gender: { path: 'Patient.gender', default: 'unknown' as const },
    })
    expectTypeOf(row.maiden).toEqualTypeOf<string | null>()
    expectTypeOf(row.family).toEqualTypeOf<string>()
    expect(row).toEqual({ maiden: null, family: 'Chalmers', gender: 'unknown' })
  })

  it('an as-function maps each value and sets the column type from its return', () => {
    const row = r4.project(patient, {
      shout: { path: 'Patient.name.family.first()', as: value => String(value).toUpperCase() },
      initials: { path: 'Patient.name.given', collection: true, as: value => String(value).charAt(0) },
      // Coercion order: as runs on values, then default fills an empty result.
      nickname: { path: "Patient.name.where(use = 'nickname').given", as: value => String(value), default: '—' },
    })
    expectTypeOf(row.shout).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.initials).toEqualTypeOf<string[]>()
    expectTypeOf(row.nickname).toEqualTypeOf<string>()
    expect(row).toEqual({ shout: 'CHALMERS', initials: ['P', 'J', 'J'], nickname: '—' })
  })

  it('map decodes a value by string key, with default as the fallback for misses', () => {
    type Tone = 'success' | 'neutral'
    const tones: Record<string, Tone> = { final: 'success', amended: 'neutral' }
    const row = r4.project(observation, {
      tone: { path: 'Observation.status', choices: tones, default: 'neutral' as Tone },
      // A miss becomes empty, so default fills it — the retry-with-fallback idiom.
      label: { path: 'Observation.status', choices: { registered: 'Ordered' }, default: 'Result' },
      // Literal maps infer the union of their value types.
      flagged: { path: 'Observation.status', choices: { final: false, preliminary: true } },
    })
    expectTypeOf(row.tone).toEqualTypeOf<Tone>()
    expectTypeOf(row.flagged).toEqualTypeOf<boolean | undefined>()
    expect(row).toEqual({ tone: 'success', label: 'Result', flagged: false })
  })

  it('map matches own keys only and non-primitive values never match', () => {
    const row = r4.project(observation, {
      // 'toString' exists on Object.prototype; hasOwn keeps it a miss.
      proto: { path: "'toString'", choices: { final: 'x' }, default: 'missed' },
      // Non-string primitives key via String(); complex values never match.
      numeric: { path: 'Observation.value.ofType(Quantity).value', choices: { '72.5': 'ok' } },
      complex: { path: 'Observation.code', choices: { '[object Object]': 'never' }, default: 'missed' },
      // In a collection column, misses drop instead of erroring.
      some: { path: "('final' | 'nope')", collection: true, choices: { final: 'kept' } },
    })
    expect(row).toEqual({ proto: 'missed', numeric: 'ok', complex: 'missed', some: ['kept'] })
  })

  it('a column declares at most one of as, map, enum — rejected at compile and plan time', () => {
    // @ts-expect-error -- as and map are mutually exclusive; planning also checks untyped callers
    expect(() => r4.project([], { bad: { path: 'Patient.gender', as: String, choices: { male: 'M' } } })).toThrow(
      "column 'bad' declares more than one of 'as', 'choices', 'enum'"
    )
    // @ts-expect-error -- enum and as are mutually exclusive; planning also checks untyped callers
    expect(() => r4.project([], { bad: { path: 'Patient.gender', enum: ['male'], as: String } })).toThrow(
      "column 'bad' declares more than one of 'as', 'choices', 'enum'"
    )
  })

  it('enum types the column as the union of its strings and checks it at runtime', () => {
    const row = r4.project(observation, {
      status: { path: 'Observation.status', enum: ['final', 'amended'], default: 'final' },
      // A value outside the list becomes empty, so default catches it.
      other: { path: 'Observation.status', enum: ['registered'], default: 'unexpected' },
    })
    expectTypeOf(row.status).toEqualTypeOf<'final' | 'amended'>()
    expectTypeOf(row.other).toEqualTypeOf<'registered' | 'unexpected'>()
    expect(row).toEqual({ status: 'final', other: 'unexpected' })
  })

  it('map accepts a display table: rows keyed by code, pick naming the field', () => {
    type Tone = 'success' | 'info' | 'neutral'
    const statusMeta: { code: string; label: string; tone: Tone }[] = [
      { code: 'final', label: 'Final', tone: 'success' },
      { code: 'registered', label: 'Ordered', tone: 'info' },
      // A duplicate code never shadows an earlier row — first wins, like where().first().
      { code: 'final', label: 'Shadowed', tone: 'neutral' },
    ]
    const row = r4.project(observation, {
      label: { path: 'Observation.status', choices: statusMeta, pick: 'label', default: 'Result' },
      tone: { path: 'Observation.status', choices: statusMeta, pick: 'tone', default: 'neutral' as Tone },
      // No pick: the whole matching row.
      meta: { path: 'Observation.status', choices: statusMeta },
      // A value no row's code matches falls back to default.
      missing: { path: "'cancelled'", choices: statusMeta, pick: 'label', default: 'Result' },
    })
    expectTypeOf(row.label).toEqualTypeOf<string>()
    expectTypeOf(row.tone).toEqualTypeOf<Tone>()
    expectTypeOf(row.meta).toEqualTypeOf<{ code: string; label: string; tone: Tone } | undefined>()
    expect(row).toEqual({
      label: 'Final',
      tone: 'success',
      meta: { code: 'final', label: 'Final', tone: 'success' },
      missing: 'Result',
    })
  })

  it('pick requires the table form of map and a field its rows carry — rejected at compile and plan time', () => {
    // @ts-expect-error -- pick needs the table form of map; planning also checks untyped callers
    expect(() => r4.project([], { bad: { path: 'Patient.gender', choices: { male: 'M' }, pick: 'label' } })).toThrow(
      "column 'bad' has 'pick' without a table 'choices'"
    )
    // @ts-expect-error -- pick without a map; planning also checks untyped callers
    expect(() => r4.project([], { bad: { path: 'Patient.gender', pick: 'label' } })).toThrow(
      "column 'bad' has 'pick' without a table 'choices'"
    )
    expect(() =>
      r4.project([], { bad: { path: 'Patient.gender', choices: [{ code: 'male', label: 'M' }], pick: 'lable' } })
    ).toThrow("column 'bad' picks 'lable', which no row of its table has")
  })
})

describe('vars: per-call FHIRPath bindings', () => {
  const weighed: Observation = {
    resourceType: 'Observation',
    status: 'final',
    code: { text: 'Weight' },
    valueQuantity: { value: 72.5, unit: 'kg', code: 'kg' },
    effectiveDateTime: '2026-01-05T08:30:00Z',
  }

  it('binds expressions evaluated against the input, before the main expression', () => {
    expect(r4.evaluate('%w', weighed, { vars: { w: 'Observation.value.ofType(Quantity).value' } })).toEqual([72.5])
    // Both spellings name the same variable, like env keys.
    expect(r4.evaluate('%w', weighed, { vars: { '%w': 'Observation.status' } })).toEqual(['final'])
  })

  it('keeps bindings typed: a Quantity var compares by unit where env data cannot', () => {
    const asVar = r4.evaluate("%w > 70000 'g'", weighed, { vars: { w: 'Observation.value.ofType(Quantity)' } })
    expect(asVar).toEqual([true])
    // The same value through env arrives as an untyped object and cannot compare.
    expect(() => r4.evaluate("%w > 70000 'g'", weighed, { env: { w: { value: 72.5, unit: 'kg' } } })).toThrow()
  })

  it('binds in declaration order, so later vars reference earlier ones', () => {
    expect(r4.evaluate('%b', patient, { vars: { a: 'Patient.id', b: "%a & '!'" } })).toEqual(['example!'])
  })

  it('vars see env; a var may not override an environment variable', () => {
    expect(r4.evaluate('%tagged', patient, { env: { tag: 'v1' }, vars: { tagged: "id & '-' & %tag" } })).toEqual([
      'example-v1',
    ])
    expect(() => r4.evaluate('%tag', patient, { env: { tag: 'v1' }, vars: { tag: 'id' } })).toThrow(
      'Cannot override the environment variable %tag with a var'
    )
    expect(() => r4.evaluate('%loinc', patient, { vars: { loinc: "'nope'" } })).toThrow(
      'Cannot override the environment variable %loinc with a var'
    )
  })

  it('defineVariable() cannot rebind a var, matching its own scope rule', () => {
    expect(() => r4.evaluate("defineVariable('w', 1).select(%w)", weighed, { vars: { w: 'status' } })).toThrow(
      'Variable %w is already defined in this scope'
    )
  })

  it('merges engine-bound vars with per-call vars per name', () => {
    const engine = new FhirPathEngine({ model: r4Model, vars: { kind: 'code.text', status: 'status' } })
    expect(engine.evaluate('%kind & %status', weighed, { vars: { status: "'overridden'" } })).toEqual([
      'Weightoverridden',
    ])
  })

  it('a pre-computed TypedValue[] binds directly, without evaluation', () => {
    const typed = r4.evaluateTyped('Observation.effective.ofType(dateTime)', weighed)
    expect(r4.evaluate('%at < now()', weighed, { vars: { at: typed } })).toEqual([true])
  })

  it('test() and filter() accept vars too', () => {
    expect(r4.test(weighed, "%w > 70 'kg'", { vars: { w: 'value.ofType(Quantity)' } })).toBe(true)
    // Only `weighed` carries a UCUM code; the criteria's var comes up empty for the other.
    expect(
      r4.filter([weighed, observation], "%unit = 'kg'", { vars: { unit: 'value.ofType(Quantity).code' } })
    ).toEqual([weighed])
  })

  it('project() resolves vars once per row, with the row as focus and %rowIndex in scope', () => {
    const rows = r4.project(
      [patient, otherPatient],
      {
        who: { path: '%label', type: 'string' },
        birthYear: { path: '%born.toString().substring(0, 4)', type: 'string' },
      },
      { vars: { label: "id & '@' & %rowIndex.toString()", born: 'Patient.birthDate' } }
    )
    expect(rows).toEqual([
      { who: 'example@0', birthYear: '1974' },
      { who: 'other@1', birthYear: '1994' },
    ])
  })

  it('project() vars express a correlated left join: unmatched rows survive with defaults', () => {
    const orders = [
      { resourceType: 'ServiceRequest', id: 'sr1', status: 'active', intent: 'order' },
      { resourceType: 'ServiceRequest', id: 'sr2', status: 'active', intent: 'order' },
    ]
    const reports = [{ orderId: 'sr1', report: { resourceType: 'DiagnosticReport', id: 'dr1', status: 'final' } }]
    const rows = r4.project(
      orders,
      {
        id: { path: 'ServiceRequest.id', type: 'string' },
        reportStatus: { path: '%report.status', type: 'string', default: 'waiting' },
        reportId: { path: '%report.id', type: 'string', default: null },
      },
      { env: { reports }, vars: { report: '%reports.where(orderId = %context.id).report' } }
    )
    expect(rows).toEqual([
      { id: 'sr1', reportStatus: 'final', reportId: 'dr1' },
      { id: 'sr2', reportStatus: 'waiting', reportId: null },
    ])
  })
})

describe('evaluate/first result type declaration', () => {
  // Outside the inference subset (union of navigations), like a template-built expression.
  const displayName =
    "(Patient.name.where(use = 'official') | Patient.name).first().select(given.first() & ' ' & family)"

  it('declares what inference cannot see, matching a project column type', () => {
    const untyped = r4.first(displayName, patient)
    expectTypeOf(untyped).toEqualTypeOf<unknown>()

    const name = r4.first(displayName, patient, { type: 'string' })
    expectTypeOf(name).toEqualTypeOf<string | undefined>()
    expect(name).toBe('Peter Chalmers')

    const list = r4.evaluate(displayName, patient, { type: 'string' })
    expectTypeOf(list).toEqualTypeOf<string[]>()
    expect(list).toEqual(['Peter Chalmers'])
  })

  it('keeps literal inference when type is absent, with or without other options', () => {
    const given = r4.first('Patient.name.given', patient, { env: { unused: 1 } })
    expectTypeOf(given).toEqualTypeOf<string | undefined>()
    expect(given).toBe('Peter')
  })

  it('works on bound expressions and composes with other per-call options', () => {
    const bound = r4.compile(displayName)
    const name = bound.first(patient, { env: { unused: 1 }, type: 'string' })
    expectTypeOf(name).toEqualTypeOf<string | undefined>()
    expect(name).toBe('Peter Chalmers')
    expectTypeOf(bound.evaluate(patient, { type: 'string' })).toEqualTypeOf<string[]>()
  })

  it('cannot be bound as an engine default', () => {
    // @ts-expect-error `type` is per-call only; EngineOptions does not carry it
    void new FhirPathEngine({ model: r4Model, type: 'string' })
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

describe('recordEngines', () => {
  it('collects the engines built while a session is open, and nothing outside it', () => {
    const before = new FhirPathEngine({})
    const engines = recordEngines()
    const during = new FhirPathEngine({})
    const recorded = engines()
    const after = new FhirPathEngine({})
    expect(recorded).toEqual([during])
    // Closing stops the collecting: `after` is not retained by anyone.
    expect(engines()).toEqual([during])
    expect(recorded).not.toContain(before)
    expect(recorded).not.toContain(after)
  })

  it('lets a second session take over, and gives each only its own', () => {
    const first = recordEngines()
    const a = new FhirPathEngine({})
    const second = recordEngines()
    const b = new FhirPathEngine({})
    expect(second()).toEqual([b])
    // The first session saw only what was built before the takeover, and closing
    // it now cannot reopen recording.
    expect(first()).toEqual([a])
    const c = new FhirPathEngine({})
    expect(first()).toEqual([a])
    expect(second()).toEqual([b])
    expect(second()).not.toContain(c)
  })
})
