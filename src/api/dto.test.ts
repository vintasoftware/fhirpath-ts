import { describe, expect, expectTypeOf, it } from 'vitest'

import { analyzeDto, analyzeExpression } from '../analyzer/index.ts'
import type { Condition, Observation, Patient, ServiceRequest } from '../r4/generated/type-maps.ts'
import { r4, r4Model } from '../r4/index.ts'
import { column, columnsOf, declareColumn } from './dto.ts'
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
  class WeightRow {
    static readonly fhirType = 'Observation'
    lbs = column("Observation.value.ofType(Quantity).toQuantity('[lb_av]').value", { type: 'decimal', default: 0 })
    kg = column("Observation.value.ofType(Quantity).toQuantity('kg').value", { type: 'decimal', default: 0 })
    at = column('(Observation.effective.ofType(dateTime) | Observation.issued).first()', { as: 'Date' })
    isFinal = column({ test: "Observation.status = 'final'" })

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

  it('methods and getters on the class see projected values', () => {
    const row = r4.project(weighed, WeightRow)
    expect(row.roundedLbs).toBe(176)
    expectTypeOf(row).toEqualTypeOf<WeightRow>()
  })

  it('a class needs no engine registration to be projectable', () => {
    class Minimal {
      id = column('Observation.status', { type: 'string', default: '' })
    }
    expect(r4.project(weighed, Minimal).id).toBe('final')
  })

  it('class vars express the join, overridable per call', () => {
    class OrderRow {
      static readonly fhirType = 'ServiceRequest'
      static readonly vars = { report: '%reports.where(orderId = %context.id).report' }
      id = column('ServiceRequest.id', { type: 'string', default: '' })
      reportStatus = column('%report.status', { type: 'string', default: 'waiting' })
    }
    const orders: ServiceRequest[] = [
      { resourceType: 'ServiceRequest', id: 'sr1', status: 'active', intent: 'order' },
      { resourceType: 'ServiceRequest', id: 'sr2', status: 'active', intent: 'order' },
    ]
    const reports = [{ orderId: 'sr1', report: { resourceType: 'DiagnosticReport', id: 'dr1', status: 'final' } }]
    expect(r4.project(orders, OrderRow, { env: { reports } })).toEqual([
      expect.objectContaining({ id: 'sr1', reportStatus: 'final' }),
      expect.objectContaining({ id: 'sr2', reportStatus: 'waiting' }),
    ])
    // A per-call var wins over the class var of the same name.
    const overridden = r4.project(orders, OrderRow, { env: { reports }, vars: { report: '{}' } })
    expect(overridden.map(row => row.reportStatus)).toEqual(['waiting', 'waiting'])
  })

  it('projecting checks each row against the fhirType, failing loudly on a mismatch', () => {
    const patient = { resourceType: 'Patient', id: 'p1' }
    expect(() => r4.project([weighed, patient], WeightRow)).toThrow(
      "project(): row 1 is a Patient, but WeightRow declares fhirType 'Observation'"
    )
    // A class without a fhirType projects anything; datatype subjects have no
    // resourceType to check.
    class AnyRow {
      id = column('id', { type: 'string', default: '' })
    }
    expect(r4.project([weighed, patient], AnyRow)).toHaveLength(2)
    class ConceptRow {
      static readonly fhirType = 'CodeableConcept'
      text = column('(text | coding.display.first()).first()', { type: 'string', default: '' })
    }
    expect(r4.project([{ text: 'Weight' }], ConceptRow)).toEqual([expect.objectContaining({ text: 'Weight' })])
  })

  it('class env applies when projecting, under per-call env', () => {
    class Toned {
      static readonly env = { tones: [{ code: 'final', tone: 'success' }] }
      tone = column('%tones.where(code = %context.status).tone', { type: 'string', default: 'neutral' })
    }
    expect(r4.project(weighed, Toned).tone).toBe('success')
    expect(r4.project(weighed, Toned, { env: { tones: [] } }).tone).toBe('neutral')
  })
})

describe('DTOs registered engine-wide', () => {
  class CodeableConceptFns {
    static readonly fhirType = 'CodeableConcept'
    displayText = column('(text | coding.display.first() | coding.first().code).first()', { type: 'string' })
  }
  const condition: Condition = {
    resourceType: 'Condition',
    subject: { reference: 'Patient/p1' },
    code: { coding: [{ code: 'I10', display: 'Hypertension' }] },
  }

  it('every column field becomes a callable function', () => {
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns] })
    expect(engine.evaluate('Condition.code.displayText()', condition)).toEqual(['Hypertension'])
  })

  it('derives the analyzer signature from the column type', () => {
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns] })
    const diagnostics = analyzeExpression('maritalStatus.displayText().length()', {
      model: r4Model,
      inputType: 'Patient',
      functions: engine.defaults.functions ?? {},
    })
    expect(diagnostics).toEqual([])
  })

  it('class env registers engine-wide, so other expressions see it', () => {
    class Badges {
      static readonly fhirType = 'Observation'
      static readonly env = { badgeTones: [{ code: 'final', tone: 'success' }] }
      badgeTone = column('%badgeTones.where(code = %context.status).tone', { type: 'string' })
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Badges] })
    expect(engine.evaluate('badgeTone()', weighed)).toEqual(['success'])
    expect(engine.evaluate('%badgeTones.count()', weighed)).toEqual([1])
  })

  it('a test field stays projection-only', () => {
    class Flags {
      static readonly fhirType = 'Observation'
      isFinal = column({ test: "status = 'final'" })
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Flags] })
    expect(engine.project(weighed, Flags).isFinal).toBe(true)
    expect(() => engine.evaluate('isFinal()', weighed)).toThrow("Unrecognized function 'isFinal'")
  })

  it('a declared column is shared across classes, callable in field position', () => {
    const ObservedAt = declareColumn('observedAt', '(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
    class A {
      at = ObservedAt()
    }
    class B {
      at = ObservedAt()
    }
    expectTypeOf(new A().at).toEqualTypeOf<Date | undefined>()
    expect(r4.project(weighed, A).at).toEqual(new Date('2026-01-05T08:30:00Z'))
    expect(r4.project(unitless, B).at).toBeUndefined()
  })

  it('a registered declared column is callable engine-wide under its functionName', () => {
    const StatusCode = declareColumn('statusCode', 'status', { type: 'code' })
    const engine = new FhirPathEngine({ model: r4Model, columns: [StatusCode] })
    expect(engine.evaluate("statusCode() & '!'", weighed)).toEqual(['final!'])
    // Redefining it fails loudly, like DTO members.
    expect(() => new FhirPathEngine({ model: r4Model, columns: [StatusCode, StatusCode] })).toThrow(
      "Declared column 'statusCode' redefines the function 'statusCode'"
    )
  })

  it('a test declared column cannot register as a function', () => {
    const IsFinal = declareColumn('isFinal', { test: "status = 'final'" })
    class Flags {
      isFinal = IsFinal()
    }
    expect(r4.project(weighed, Flags).isFinal).toBe(true)
    expect(() => new FhirPathEngine({ model: r4Model, columns: [IsFinal] })).toThrow(
      "Declared column 'isFinal' is a test column"
    )
  })

  it("pick must name a field the table's rows carry", () => {
    const meta = [{ code: 'final', label: 'Final' }]
    class Typo {
      // @ts-expect-error -- 'lable' is not a key of the table's rows
      label = column('status', { map: meta, pick: 'lable', default: '' })
    }
    expect(() => r4.project(weighed, Typo)).toThrow("column 'label' picks 'lable', which no row of its table has")
    class NoTable {
      // @ts-expect-error -- pick without a table map is rejected
      label = column('status', { pick: 'label' })
    }
    void NoTable
  })

  it('redefining a function or env variable across DTOs fails loudly', () => {
    class Also {
      static readonly fhirType = 'Coding'
      displayText = column('code', { type: 'string' })
    }
    expect(() => new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns, Also] })).toThrow(
      "DTO Also redefines the function 'displayText'"
    )
    class EnvA {
      static readonly fhirType = 'Patient'
      static readonly env = { tones: [] as never[] }
      a = column('gender', { type: 'string' })
    }
    class EnvB {
      static readonly fhirType = 'Practitioner'
      static readonly env = { tones: [] as never[] }
      b = column('gender', { type: 'string' })
    }
    expect(() => new FhirPathEngine({ model: r4Model, resourceDtos: [EnvA, EnvB] })).toThrow(
      'DTO EnvB redefines the environment variable %tones'
    )
  })

  it('a registered class must declare a fhirType, and only one class registers per fhirType', () => {
    class Anonymous {
      id = column('id', { type: 'string' })
    }
    expect(() => new FhirPathEngine({ model: r4Model, resourceDtos: [Anonymous] })).toThrow(
      'DTO Anonymous must declare a fhirType (or use columnsOf) to register'
    )
    class AlsoCodeableConcept {
      static readonly fhirType = 'CodeableConcept'
      conceptText = column('text', { type: 'string' })
    }
    expect(
      () => new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns, AlsoCodeableConcept] })
    ).toThrow("DTO AlsoCodeableConcept registers fhirType 'CodeableConcept', already registered by CodeableConceptFns")
  })
})

describe('the engine type-level function registry (dual type + runtime assertions)', () => {
  const FirstGiven = declareColumn('firstGiven', 'Patient.name.given.first()')
  const FirstGivenLength = declareColumn('firstGivenLength', '%context.firstGiven().length()')
  const engine = new FhirPathEngine({ model: r4Model, columns: [FirstGiven, FirstGivenLength] })
  const patient: Patient = { resourceType: 'Patient', name: [{ given: ['Peter'] }] }

  it('a declared column infers on evaluate()/first() at its call sites', () => {
    const given = engine.evaluate('Patient.firstGiven()', patient)
    expectTypeOf(given).toEqualTypeOf<string[]>()
    expect(given).toEqual(['Peter'])

    const first = engine.first('Patient.firstGiven()', patient)
    expectTypeOf(first).toEqualTypeOf<string | undefined>()
    expect(first).toBe('Peter')
  })

  it('a declaration calling another declared function resolves (two passes)', () => {
    const length = engine.evaluate('Patient.firstGivenLength()', patient)
    expectTypeOf(length).toEqualTypeOf<number[]>()
    expect(length).toEqual([5])
  })

  it('BoundExpression carries the registry', () => {
    const bound = engine.compile('Patient.firstGiven()')
    const given = bound.evaluate(patient)
    expectTypeOf(given).toEqualTypeOf<string[]>()
    expect(given).toEqual(['Peter'])
  })

  it('DTO-class functions register at runtime only — calls evaluate but stay unknown[]', () => {
    const concept = columnsOf('CodeableConcept')
    class Concepts {
      displayText = concept('(text | coding.display.first() | coding.first().code).first()')
    }
    const withDto = new FhirPathEngine({ model: r4Model, resourceDtos: [Concepts] })
    const condition: Condition = {
      resourceType: 'Condition',
      subject: { reference: 'Patient/p1' },
      code: { coding: [{ code: 'I10', display: 'Hypertension' }] },
    }
    const name = withDto.evaluate('Condition.code.displayText()', condition)
    expectTypeOf(name).toEqualTypeOf<unknown[]>()
    expect(name).toEqual(['Hypertension'])
  })

  it('an engine without registrations keeps the empty registry (and the call throws)', () => {
    const bare = new FhirPathEngine({ model: r4Model })
    expect(() => bare.evaluate('Patient.firstGiven()', patient)).toThrow("Unrecognized function 'firstGiven'")
    // Type-only: never executed, just inferred.
    const typeOnly = () => {
      const result = bare.evaluate('Patient.firstGiven()', patient)
      expectTypeOf(result).toEqualTypeOf<unknown[]>()
    }
    void typeOnly
  })
})

describe('columnsOf', () => {
  const obsCol = columnsOf('Observation')
  class ScopedWeight {
    lbs = obsCol("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 })
    at = obsCol('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
    note = obsCol('code.text')
    isFinal = obsCol({ test: "status = 'final'" })
  }

  it('relative chains infer against the scoped type, as plain values', () => {
    expectTypeOf(new ScopedWeight().lbs).toEqualTypeOf<number>()
    expectTypeOf(new ScopedWeight().at).toEqualTypeOf<Date | undefined>()
    expectTypeOf(new ScopedWeight().note).toEqualTypeOf<string | undefined>()
    expectTypeOf(new ScopedWeight().isFinal).toEqualTypeOf<boolean>()
    const rows = r4.project([weighed], ScopedWeight)
    expectTypeOf(rows).toEqualTypeOf<ScopedWeight[]>()
    expect(rows[0]).toMatchObject({ note: 'Weight', isFinal: true })
    expect(rows[0]!.lbs).toBeCloseTo(176.4, 1)
  })

  it("the factory's scope substitutes for the fhirType static", () => {
    // project() checks the input against the derived type…
    expect(() => r4.project({ resourceType: 'Patient' }, ScopedWeight)).toThrow(
      "row 0 is a Patient, but ScopedWeight declares fhirType 'Observation'"
    )
    // …and registration derives it too.
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [ScopedWeight] })
    expect(engine.evaluate('Observation.note()', weighed)).toEqual(['Weight'])
  })

  it('a fhirType static contradicting the scope throws', () => {
    class Contradiction {
      static readonly fhirType = 'Patient'
      note = obsCol('code.text')
    }
    expect(() => r4.project(weighed, Contradiction)).toThrow(
      "DTO Contradiction declares fhirType 'Patient', but its columns come from columnsOf('Observation')"
    )
  })

  it('mixing factories of two types in one class throws', () => {
    const patCol = columnsOf('Patient')
    class Mixed {
      note = obsCol('code.text')
      gender = patCol('gender')
    }
    expect(() => r4.project(weighed, Mixed)).toThrow(
      "DTO Mixed mixes columnsOf('Observation') and columnsOf('Patient') columns"
    )
  })
})

describe('analyzeDto', () => {
  it('derives the input type from columnsOf columns', () => {
    const obsCol = columnsOf('Observation')
    class Scoped {
      kg = obsCol("valu.ofType(Quantity).toQuantity('kg').value", { default: 0 })
    }
    expect(analyzeDto(Scoped, { model: r4Model }).map(f => [f.member, f.code])).toEqual([['kg', 'unknown-element']])
  })

  it('checks every column and var against the fhirType, tagged by member', () => {
    class Weight {
      static readonly fhirType = 'Observation'
      kg = column("Observation.valu.ofType(Quantity).toQuantity('kg').value", { type: 'decimal', default: 0 })
      isFinal = column({ test: "Observation.staus = 'final'" })
    }
    const findings = analyzeDto(Weight, { model: r4Model })
    expect(findings.map(f => [f.member, f.code])).toEqual([
      ['kg', 'unknown-element'],
      ['isFinal', 'unknown-element'],
    ])
  })

  it('declares class env, %rowIndex/%rowTotal, and vars in order; per-call names come via options', () => {
    class OrderRow {
      static readonly fhirType = 'ServiceRequest'
      static readonly env = { waitingBadge: { label: 'Waiting' } }
      static readonly vars = {
        report: '%reports.where(orderId = %context.id).report',
        badge: 'iif(%report.exists(), %report, %waitingBadge)',
      }
      id = column('(id | %rowIndex.toString()).first()', { type: 'string', default: '' })
      label = column('%badge.label', { type: 'string', default: '' })
    }
    // %reports is per-call env the class cannot know — undeclared, it is the only finding.
    expect(analyzeDto(OrderRow, { model: r4Model }).map(f => [f.member, f.code])).toEqual([
      ['vars.report', 'unknown-variable'],
    ])
    expect(analyzeDto(OrderRow, { model: r4Model, variables: { reports: {} } })).toEqual([])
  })

  it('resolves engine functions passed through options', () => {
    class Named {
      static readonly fhirType = 'Condition'
      name = column('Condition.code.displayText()', { type: 'string', default: '' })
    }
    class CodeableConceptFns {
      static readonly fhirType = 'CodeableConcept'
      displayText = column('(text | coding.display.first() | coding.first().code).first()', { type: 'string' })
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns] })
    expect(analyzeDto(Named, { model: r4Model }).map(f => f.code)).toEqual(['unknown-function'])
    expect(analyzeDto(Named, { model: r4Model, functions: engine.defaults.functions ?? {} })).toEqual([])
  })
})
