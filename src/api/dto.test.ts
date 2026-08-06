import { describe, expect, expectTypeOf, it } from 'vitest'

import { analyzeDto, analyzeExpression } from '../analyzer/index.ts'
import type { Condition, Observation, ServiceRequest } from '../r4/generated/type-maps.ts'
import { r4, r4Model } from '../r4/index.ts'
import { type ColumnBuilder, defineDto } from './dto.ts'
import { FhirPathEngine } from './engine.ts'

const weighed: Observation = {
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'Weight' },
  valueQuantity: { value: 80, unit: 'kg', code: 'kg' },
  effectiveDateTime: '2026-01-05T08:30:00Z',
}
const unitless: Observation = {
  resourceType: 'Observation',
  status: 'preliminary',
  code: { text: 'Weight' },
}

describe('DTO projection', () => {
  const WeightDto = defineDto({
    fhirType: 'Observation',
    columns: c => ({
      lbs: c("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 }),
      kg: c("value.ofType(Quantity).toQuantity('kg').value", { default: 0 }),
      at: c('(effective.ofType(dateTime) | issued).first()', { as: 'Date' }),
      isFinal: c.test("status = 'final'"),
    }),
  })

  class WeightRow extends WeightDto {
    get roundedLbs(): number {
      return Math.round(this.lbs)
    }
  }

  it('materializes rows as class instances, columns typed by their specs', () => {
    const rows = r4.project([weighed, unitless], WeightRow)
    expectTypeOf(rows[0]!.lbs).toEqualTypeOf<number>()
    expectTypeOf(rows[0]!.at).toEqualTypeOf<Date | undefined>()
    expectTypeOf(rows[0]!.isFinal).toEqualTypeOf<boolean>()
    expect(rows[0]).toBeInstanceOf(WeightRow)
    expect(rows[0]!.kg).toBe(80)
    expect(rows[0]!.lbs).toBeCloseTo(176.4, 1)
    expect(rows[0]!.at).toEqual(new Date('2026-01-05T08:30:00Z'))
    expect(rows[0]!.isFinal).toBe(true)
    expect(rows[1]).toMatchObject({ lbs: 0, kg: 0, isFinal: false })
  })

  it('relative paths infer against the fhirType', () => {
    const ConditionDto = defineDto({
      fhirType: 'Condition',
      columns: c => ({
        clinicalStatusCode: c('clinicalStatus.coding.first().code'),
        display: c('(code.text | code.coding.display.first()).first()'),
        recorded: c('recordedDate'),
        // Outside the inference subset (a `&` concatenation): the escape
        // valve, not an error — declare `type` to name the value's type.
        opaque: c("code.text & ' (dx)'"),
      }),
    })
    const row = new ConditionDto()
    expectTypeOf(row.clinicalStatusCode).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.display).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.recorded).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.opaque).toBeUnknown()
  })

  it('methods and getters on the class see projected values', () => {
    const row = r4.project(weighed, WeightRow)
    expect(row.roundedLbs).toBe(176)
    expectTypeOf(row).toEqualTypeOf<WeightRow>()
  })

  it('the schema class projects as-is, without a subclass', () => {
    const Minimal = defineDto({
      fhirType: 'Observation',
      columns: c => ({ id: c('status', { default: '' }) }),
    })
    expect(r4.project(weighed, Minimal).id).toBe('final')
  })

  it('a DTO needs no engine registration to be projectable', () => {
    const engine = new FhirPathEngine({ model: r4Model })
    expect(engine.project(weighed, WeightRow).kg).toBe(80)
  })

  it('vars express the join, overridable per call', () => {
    const OrderRow = defineDto({
      fhirType: 'ServiceRequest',
      vars: { report: '%reports.where(orderId = %context.id).report' },
      columns: c => ({
        id: c('id', { default: '' }),
        reportStatus: c('%report.status', { type: 'string', default: 'waiting' }),
      }),
    })
    const orders: ServiceRequest[] = [
      { resourceType: 'ServiceRequest', id: 'sr1', status: 'active', intent: 'order' },
      { resourceType: 'ServiceRequest', id: 'sr2', status: 'active', intent: 'order' },
    ]
    const reports = [{ orderId: 'sr1', report: { resourceType: 'DiagnosticReport', id: 'dr1', status: 'final' } }]
    expect(r4.project(orders, OrderRow, { env: { reports } })).toEqual([
      expect.objectContaining({ id: 'sr1', reportStatus: 'final' }),
      expect.objectContaining({ id: 'sr2', reportStatus: 'waiting' }),
    ])
    // A per-call var wins over the DTO var of the same name.
    const overridden = r4.project(orders, OrderRow, { env: { reports }, vars: { report: '{}' } })
    expect(overridden.map(row => row.reportStatus)).toEqual(['waiting', 'waiting'])
  })

  it('projecting checks each row against the fhirType, failing loudly on a mismatch', () => {
    const patient = { resourceType: 'Patient', id: 'p1' }
    expect(() => r4.project([weighed, patient], WeightRow)).toThrow(
      "project(): row 1 is a Patient, but WeightRow declares fhirType 'Observation'"
    )
    // A datatype fhirType has no resourceType to check against.
    const ConceptRow = defineDto({
      fhirType: 'CodeableConcept',
      columns: c => ({ text: c('(text | coding.display.first()).first()', { default: '' }) }),
    })
    expect(r4.project([{ text: 'Weight' }], ConceptRow)).toEqual([expect.objectContaining({ text: 'Weight' })])
  })

  it('DTO env applies when projecting, under per-call env', () => {
    const Toned = defineDto({
      fhirType: 'Observation',
      env: { tones: [{ code: 'final', tone: 'success' }] },
      columns: c => ({ tone: c('%tones.where(code = %context.status).tone', { type: 'string', default: 'neutral' }) }),
    })
    expect(r4.project(weighed, Toned).tone).toBe('success')
    expect(r4.project(weighed, Toned, { env: { tones: [] } }).tone).toBe('neutral')
  })

  it('a shared column is a plain function of the builder', () => {
    const observedAt = <Root extends string>(c: ColumnBuilder<Root>) =>
      c('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
    const A = defineDto({ fhirType: 'Observation', columns: c => ({ at: observedAt(c) }) })
    const B = defineDto({ fhirType: 'Observation', columns: c => ({ at: observedAt(c), kg: c('status') }) })
    expectTypeOf(new A().at).toEqualTypeOf<Date | undefined>()
    expect(r4.project(weighed, A).at).toEqual(new Date('2026-01-05T08:30:00Z'))
    expect(r4.project(unitless, B).at).toBeUndefined()
  })

  it('a class that never came from defineDto is not projectable', () => {
    class Plain {
      static readonly fhirType = 'Observation'
    }
    expect(() => r4.project(weighed, Plain)).toThrow('Plain is not a DTO class; define it with defineDto()')
  })

  it('a column that is not a builder call fails at definition', () => {
    expect(() =>
      defineDto({
        fhirType: 'Observation',
        columns: () => ({ oops: 42 }),
      })
    ).toThrow("defineDto(Observation): column 'oops' is not a column; build it with the c() argument")
  })

  it("pick must name a field the table's rows carry", () => {
    const meta = [{ code: 'final', label: 'Final' }]
    const Typo = defineDto({
      fhirType: 'Observation',
      // @ts-expect-error -- 'lable' is not a key of the table's rows
      columns: c => ({ label: c('status', { map: meta, pick: 'lable', default: '' }) }),
    })
    expect(() => r4.project(weighed, Typo)).toThrow("column 'label' picks 'lable', which no row of its table has")
    defineDto({
      fhirType: 'Observation',
      // @ts-expect-error -- pick without a table map is rejected
      columns: c => ({ label: c('status', { pick: 'label' }) }),
    })
  })

  it('a fhirType outside the model is a compile error', () => {
    defineDto({
      // @ts-expect-error -- not a model type name
      fhirType: 'Observationn',
      columns: c => ({ id: c('id') }),
    })
  })
})

describe('DTOs registered engine-wide', () => {
  const CodeableConceptFns = defineDto({
    fhirType: 'CodeableConcept',
    columns: c => ({ displayText: c('(text | coding.display.first() | coding.first().code).first()') }),
  })
  const condition: Condition = {
    resourceType: 'Condition',
    subject: { reference: 'Patient/p1' },
    code: { coding: [{ code: 'I10', display: 'Hypertension' }] },
  }

  it('every column becomes a callable function', () => {
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns] })
    expect(engine.evaluate('Condition.code.displayText()', condition)).toEqual(['Hypertension'])
  })

  it('derives the analyzer signature from the column type', () => {
    const typed = defineDto({
      fhirType: 'CodeableConcept',
      columns: c => ({ displayText: c('(text | coding.display.first()).first()', { type: 'string' }) }),
    })
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [typed] })
    const diagnostics = analyzeExpression('maritalStatus.displayText().length()', {
      model: r4Model,
      inputType: 'Patient',
      functions: engine.defaults.functions ?? {},
    })
    expect(diagnostics).toEqual([])
  })

  it('DTO env registers engine-wide, so other expressions see it', () => {
    const Badges = defineDto({
      fhirType: 'Observation',
      env: { badgeTones: [{ code: 'final', tone: 'success' }] },
      columns: c => ({ badgeTone: c('%badgeTones.where(code = %context.status).tone', { type: 'string' }) }),
    })
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Badges] })
    expect(engine.evaluate('badgeTone()', weighed)).toEqual(['success'])
    expect(engine.evaluate('%badgeTones.count()', weighed)).toEqual([1])
  })

  it('a test column stays projection-only', () => {
    const Flags = defineDto({
      fhirType: 'Observation',
      columns: c => ({ isFinal: c.test("status = 'final'") }),
    })
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Flags] })
    expect(engine.project(weighed, Flags).isFinal).toBe(true)
    expect(() => engine.evaluate('isFinal()', weighed)).toThrow("Unrecognized function 'isFinal'")
  })

  it('redefining a function or env variable across DTOs fails loudly', () => {
    const Also = defineDto({
      fhirType: 'Coding',
      columns: c => ({ displayText: c('code', { type: 'string' }) }),
    })
    expect(() => new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns, Also] })).toThrow(
      "DTO CodingDto redefines the function 'displayText'"
    )
    const EnvA = defineDto({
      fhirType: 'Patient',
      env: { tones: [] as never[] },
      columns: c => ({ a: c('gender', { type: 'string' }) }),
    })
    const EnvB = defineDto({
      fhirType: 'Practitioner',
      env: { tones: [] as never[] },
      columns: c => ({ b: c('gender', { type: 'string' }) }),
    })
    expect(() => new FhirPathEngine({ model: r4Model, resourceDtos: [EnvA, EnvB] })).toThrow(
      'DTO PractitionerDto redefines the environment variable %tones'
    )
  })

  it('only one DTO registers per fhirType', () => {
    class AlsoCodeableConcept extends defineDto({
      fhirType: 'CodeableConcept',
      columns: c => ({ conceptText: c('text', { type: 'string' }) }),
    }) {}
    expect(
      () => new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns, AlsoCodeableConcept] })
    ).toThrow("DTO AlsoCodeableConcept registers fhirType 'CodeableConcept', already registered by CodeableConceptDto")
  })
})

describe('analyzeDto', () => {
  it('checks every column and var against the fhirType, tagged by member', () => {
    const Weight = defineDto({
      fhirType: 'Observation',
      columns: c => ({
        kg: c("valu.ofType(Quantity).toQuantity('kg').value", { type: 'decimal', default: 0 }),
        isFinal: c.test("staus = 'final'"),
      }),
    })
    const findings = analyzeDto(Weight, { model: r4Model })
    expect(findings.map(f => [f.member, f.code])).toEqual([
      ['kg', 'unknown-element'],
      ['isFinal', 'unknown-element'],
    ])
  })

  it('declares DTO env, %rowIndex/%rowTotal, and vars in order; per-call names come via options', () => {
    const OrderRow = defineDto({
      fhirType: 'ServiceRequest',
      env: { waitingBadge: { label: 'Waiting' } },
      vars: {
        report: '%reports.where(orderId = %context.id).report',
        badge: 'iif(%report.exists(), %report, %waitingBadge)',
      },
      columns: c => ({
        id: c('(id | %rowIndex.toString()).first()', { type: 'string', default: '' }),
        label: c('%badge.label', { type: 'string', default: '' }),
      }),
    })
    // %reports is per-call env the DTO cannot know — undeclared, it is the only finding.
    expect(analyzeDto(OrderRow, { model: r4Model }).map(f => [f.member, f.code])).toEqual([
      ['vars.report', 'unknown-variable'],
    ])
    expect(analyzeDto(OrderRow, { model: r4Model, variables: { reports: {} } })).toEqual([])
  })

  it('resolves engine functions passed through options', () => {
    const Named = defineDto({
      fhirType: 'Condition',
      columns: c => ({ name: c('code.displayText()', { type: 'string', default: '' }) }),
    })
    const CodeableConceptFns = defineDto({
      fhirType: 'CodeableConcept',
      columns: c => ({ displayText: c('(text | coding.display.first() | coding.first().code).first()') }),
    })
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns] })
    expect(analyzeDto(Named, { model: r4Model }).map(f => f.code)).toEqual(['unknown-function'])
    expect(analyzeDto(Named, { model: r4Model, functions: engine.defaults.functions ?? {} })).toEqual([])
  })

  it('flags a type-name root on a datatype fhirType, where the runtime navigates to empty', () => {
    // Prefixing paths with the type name still works on a resource DTO; on a
    // datatype DTO the runtime has no resourceType to match, so the column
    // would be empty.
    const Prefixed = defineDto({
      fhirType: 'CodeableConcept',
      columns: c => ({ displayText: c('CodeableConcept.text', { type: 'string' }) }),
    })
    const Relative = defineDto({
      fhirType: 'CodeableConcept',
      columns: c => ({ displayText: c('(text | coding.display.first() | coding.first().code).first()') }),
    })
    expect(analyzeDto(Prefixed, { model: r4Model }).map(f => [f.member, f.code])).toEqual([
      ['displayText', 'datatype-root'],
    ])
    expect(analyzeDto(Relative, { model: r4Model })).toEqual([])
  })
})
