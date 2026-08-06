import { describe, expect, expectTypeOf, it } from 'vitest'

import { analyzeDto, analyzeEngineDtos, analyzeExpression } from '../analyzer/index.ts'
import type { Condition, Observation, ServiceRequest } from '../r4/generated/type-maps.ts'
import { r4, r4Model } from '../r4/index.ts'
import { compile } from './compile.ts'
import { column, criteria, defineDto, dtoDefinition } from './dto.ts'
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

/** Shared by the weight rows below: a base class carries columns to every DTO extending it. */
class ObservationRow extends defineDto('Observation') {
  @column('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
  at!: Date | undefined
}

class WeightRow extends ObservationRow {
  @column("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 })
  lbs!: number

  @column("value.ofType(Quantity).toQuantity('kg').value", { default: 0 })
  kg!: number

  @criteria("status = 'final'")
  isFinal!: boolean

  get roundedLbs(): number {
    return Math.round(this.lbs)
  }
}

describe('DTO projection', () => {
  it('materializes rows as class instances, columns typed by their declarations', () => {
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

  it('methods and getters see projected values; fhirType stays off the row', () => {
    const row = r4.project(weighed, WeightRow)
    expect(row.roundedLbs).toBe(176)
    expect(row.fhirType).toBe('Observation')
    expect(Object.keys(row).sort()).toEqual(['at', 'isFinal', 'kg', 'lbs'])
    expectTypeOf(row).toEqualTypeOf<WeightRow>()
  })

  it('a column path infers against the class fhirType', () => {
    class ConditionRow extends defineDto('Condition') {
      @column('clinicalStatus.coding.first().code')
      statusCode!: string | undefined

      @column('(code.text | code.coding.display.first()).first()')
      display!: string | undefined

      @column('recordedDate')
      recorded!: string | undefined

      // Outside the inference subset (a `&` concatenation): tsc has nothing to
      // check the declaration against, so `type` hands the check to analyzeDto.
      @column("code.text & ' (dx)'", { type: 'string' })
      annotated!: string | undefined
    }
    const row = new ConditionRow()
    expectTypeOf(row.statusCode).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.display).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.recorded).toEqualTypeOf<string | undefined>()
    expect(analyzeDto(ConditionRow, { model: r4Model })).toEqual([])
  })

  it('a declared type that cannot hold the column value is a compile error', () => {
    class Wrong extends defineDto('Condition') {
      // @ts-expect-error -- the expression yields string | undefined, not number
      @column('clinicalStatus.coding.first().code')
      wrongType!: number

      // @ts-expect-error -- the expression may be empty, so the field must allow undefined
      @column('clinicalStatus.coding.first().code')
      tooNarrow!: string

      // Wider than the column value: accepted.
      @column('clinicalStatus.coding.first().code')
      wider!: string | number | undefined
    }
    expect(new Wrong().fhirType).toBe('Condition')
  })

  it('a DTO needs no engine registration to be projectable', () => {
    const engine = new FhirPathEngine({ model: r4Model })
    expect(engine.project(weighed, WeightRow).kg).toBe(80)
  })

  it('collects every column when a field initializer reaches another DTO', () => {
    // A plain field can run arbitrary code, including code that asks for another
    // DTO's definition — registering one on an engine is enough. The inner
    // collection must not end the outer one, or the columns below it vanish.
    class Inner extends defineDto('Condition') {
      @column('recordedDate')
      at!: string | undefined
    }
    class Outer extends defineDto('Observation') {
      @column('status')
      status!: string | undefined

      helper = new FhirPathEngine({ model: r4Model, resourceDtos: [Inner] })

      @column('issued')
      issued!: string | undefined
    }
    expect(Object.keys(dtoDefinition(Outer).columns)).toEqual(['status', 'issued'])
    expect(Object.keys(dtoDefinition(Inner).columns)).toEqual(['at'])
    expect(r4.project([weighed], Outer)[0]).toMatchObject({ status: 'final' })
  })

  it('collects a definition once, however the class is instantiated around it', () => {
    class Reused extends defineDto('Observation') {
      @column('status', { type: 'string', default: '' })
      status!: string
    }
    // Instances built outside the collection window record nothing: one before it
    // opens, and one after — which is what every projected row is.
    new Reused()
    const first = dtoDefinition(Reused)
    new Reused()
    const engine = new FhirPathEngine({ model: r4Model })
    engine.project([{ resourceType: 'Observation', status: 'final' }], Reused)
    const second = dtoDefinition(Reused)
    expect(second).toBe(first)
    expect(Object.keys(second.columns)).toEqual(['status'])
  })

  it('vars express the join, overridable per call', () => {
    class OrderRow extends defineDto('ServiceRequest', {
      vars: { report: '%reports.where(orderId = %context.id).report' },
    }) {
      @column('id', { default: '' })
      id!: string

      @column('%report.status', { type: 'string', default: 'waiting' })
      reportStatus!: string
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
    class ConceptRow extends defineDto('CodeableConcept') {
      @column('(text | coding.display.first()).first()', { default: '' })
      text!: string
    }
    expect(r4.project([{ text: 'Weight' }], ConceptRow)).toEqual([expect.objectContaining({ text: 'Weight' })])
  })

  it('DTO env applies when projecting, under per-call env', () => {
    class Toned extends defineDto('Observation', { env: { tones: [{ code: 'final', tone: 'success' }] } }) {
      @column('%tones.where(code = %context.status).tone', { type: 'string', default: 'neutral' })
      tone!: string
    }
    expect(r4.project(weighed, Toned).tone).toBe('success')
    expect(r4.project(weighed, Toned, { env: { tones: [] } }).tone).toBe('neutral')
  })

  it('a class that never extended a DTO base is not projectable', () => {
    class Plain {
      static readonly fhirType = 'Observation'
      readonly fhirType = 'Observation'
    }
    expect(() => r4.project(weighed, Plain)).toThrow(
      "Plain is not a DTO class; extend defineDto('<fhirType>') to declare one"
    )
  })

  it('a DTO with no columns fails loudly', () => {
    class Empty extends defineDto('Observation') {}
    expect(() => r4.project(weighed, Empty)).toThrow('DTO Empty declares no columns; add a @column field')
  })

  it('a column must be a public instance field', () => {
    expect(() => {
      class Static extends defineDto('Observation') {
        @column('status')
        static status: string | undefined
      }
      return Static
    }).toThrow("Column 'status' must be a public instance field")
  })

  it("pick must name a field the table's rows carry", () => {
    const choices = [{ code: 'final', label: 'Final' }]
    class Typo extends defineDto('Observation') {
      // @ts-expect-error -- 'lable' is not a key of the table's rows
      @column('status', { choices, pick: 'lable', default: '' })
      label!: string
    }
    expect(() => r4.project(weighed, Typo)).toThrow("column 'label' picks 'lable', which no row of its table has")
    class NoTable extends defineDto('Observation') {
      // @ts-expect-error -- pick without a table choices is rejected
      @column('status', { pick: 'label' })
      label!: string | undefined
    }
    void NoTable
  })

  it('a fhirType outside the model is a compile error', () => {
    // @ts-expect-error -- not a model type name
    class Bad extends defineDto('Observationn') {
      @column('id')
      id!: unknown
    }
    void Bad
  })
})

describe('DTOs registered engine-wide', () => {
  class CodeableConceptFns extends defineDto('CodeableConcept') {
    @column('(text | coding.display.first() | coding.first().code).first()')
    displayText!: string | undefined
  }
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
    class Typed extends defineDto('CodeableConcept') {
      @column('(text | coding.display.first()).first()', { type: 'string' })
      displayText!: string | undefined
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Typed] })
    const diagnostics = analyzeExpression('maritalStatus.displayText().length()', {
      model: r4Model,
      inputType: 'Patient',
      functions: engine.defaults.functions ?? {},
    })
    expect(diagnostics).toEqual([])
  })

  it('DTO env registers engine-wide, so other expressions see it', () => {
    class Badges extends defineDto('Observation', { env: { badgeTones: [{ code: 'final', tone: 'success' }] } }) {
      @column('%badgeTones.where(code = %context.status).tone', { type: 'string' })
      badgeTone!: string | undefined
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Badges] })
    expect(engine.evaluate('badgeTone()', weighed)).toEqual(['success'])
    expect(engine.evaluate('%badgeTones.count()', weighed)).toEqual([1])
  })

  it('a criteria column stays projection-only', () => {
    class Flags extends defineDto('Observation') {
      @criteria("status = 'final'")
      isFinal!: boolean
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Flags] })
    expect(engine.project(weighed, Flags).isFinal).toBe(true)
    expect(() => engine.evaluate('isFinal()', weighed)).toThrow("Unrecognized function 'isFinal'")
  })

  it('redefining a function or env variable across DTOs fails loudly', () => {
    class Also extends defineDto('Coding') {
      @column('code', { type: 'string' })
      displayText!: string | undefined
    }
    expect(() => new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns, Also] })).toThrow(
      "DTO Also redefines the function 'displayText'"
    )
    class EnvA extends defineDto('Patient', { env: { tones: [] as never[] } }) {
      @column('gender', { type: 'string' })
      a!: string | undefined
    }
    class EnvB extends defineDto('Practitioner', { env: { tones: [] as never[] } }) {
      @column('gender', { type: 'string' })
      b!: string | undefined
    }
    expect(() => new FhirPathEngine({ model: r4Model, resourceDtos: [EnvA, EnvB] })).toThrow(
      'DTO EnvB redefines the environment variable %tones'
    )
  })

  it('only one DTO registers per fhirType', () => {
    class AlsoCodeableConcept extends defineDto('CodeableConcept') {
      @column('text', { type: 'string' })
      conceptText!: string | undefined
    }
    expect(
      () => new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns, AlsoCodeableConcept] })
    ).toThrow("DTO AlsoCodeableConcept registers fhirType 'CodeableConcept', already registered by CodeableConceptFns")
  })
})

describe('analyzeDto', () => {
  it('checks every column and var against the fhirType, tagged by member', () => {
    class Weight extends defineDto('Observation') {
      @column("valu.ofType(Quantity).toQuantity('kg').value", { type: 'decimal', default: 0 })
      kg!: number

      @criteria("staus = 'final'")
      isFinal!: boolean
    }
    const findings = analyzeDto(Weight, { model: r4Model })
    expect(findings.map(f => [f.member, f.code])).toEqual([
      ['kg', 'unknown-element'],
      ['isFinal', 'unknown-element'],
    ])
  })

  it('cross-checks a declared column type against what the expression yields', () => {
    class Mistyped extends defineDto('Observation') {
      // The expression is a String; the column claims a number.
      @column('code.text', { type: 'decimal', default: 0 })
      value!: number

      // An equivalent spelling is not a finding: code and System.String agree.
      @column('status', { type: 'code' })
      status!: string | undefined

      // enum implies String, and status is one.
      @column('status', { enum: ['final', 'amended'] })
      known!: 'final' | 'amended' | undefined

      // A complex type from the wrong branch of the hierarchy.
      @column('value.ofType(Quantity)', { type: 'CodeableConcept' })
      quantity!: unknown
    }
    expect(analyzeDto(Mistyped, { model: r4Model }).map(f => [f.member, f.code, f.message])).toEqual([
      ['value', 'column-type', "Column declares type 'decimal', but the expression yields FHIR.string"],
      ['quantity', 'column-type', "Column declares type 'CodeableConcept', but the expression yields FHIR.Quantity"],
    ])
  })

  it('leaves a column alone when the analyzer cannot see the result type', () => {
    class Opaque extends defineDto('Observation') {
      // resolve() lands in an unknown region: nothing to contradict.
      @column('subject.resolve().id', { type: 'string' })
      subjectId!: string | undefined

      // as/choices reshape the value outside FHIRPath, so `type` claims nothing.
      @column('status', { as: () => 42, type: 'string', default: 0 })
      shaped!: number
    }
    expect(analyzeDto(Opaque, { model: r4Model })).toEqual([])
  })

  it('declares DTO env, %rowIndex/%rowTotal, and vars in order; per-call names come via options', () => {
    class OrderRow extends defineDto('ServiceRequest', {
      env: { waitingBadge: { label: 'Waiting' } },
      vars: {
        report: '%reports.where(orderId = %context.id).report',
        badge: 'iif(%report.exists(), %report, %waitingBadge)',
      },
    }) {
      @column('(id | %rowIndex.toString()).first()', { type: 'string', default: '' })
      id!: string

      @column('%badge.label', { type: 'string', default: '' })
      label!: string
    }
    // %reports is per-call env the DTO cannot know — undeclared, it is the only finding.
    expect(analyzeDto(OrderRow, { model: r4Model }).map(f => [f.member, f.code])).toEqual([
      ['vars.report', 'unknown-variable'],
    ])
    expect(analyzeDto(OrderRow, { model: r4Model, variables: { reports: {} } })).toEqual([])
  })

  it('analyzes a compiled var by its source, and only declares a pre-bound one', () => {
    class Bound extends defineDto('Observation', {
      vars: {
        // A compiled expression carries its source, so it analyzes like a string one.
        compiled: compile('code.txt'),
        // A pre-bound value has no expression to analyze; it is only declared.
        fixed: [{ type: 'System.String', value: 'ok' }],
      },
    }) {
      @column('%compiled', { type: 'string', default: '' })
      text!: string

      @column('%fixed', { type: 'string', default: '' })
      bound!: string
    }
    expect(analyzeDto(Bound, { model: r4Model }).map(f => [f.member, f.code])).toEqual([
      ['vars.compiled', 'unknown-element'],
    ])
  })

  it('takes model, functions and env names from the engine it is given', () => {
    class ConceptFns extends defineDto('CodeableConcept') {
      @column('(text | coding.display.first()).first()', { type: 'string' })
      displayText!: string | undefined
    }
    class Named extends defineDto('Condition', {
      env: { fallback: 'Condition' },
      // The join table arrives per call, so the DTO declares only the name.
      callerEnv: ['reports'],
      vars: { report: '%reports.where(id = %context.id).first()' },
    }) {
      @column('(code.displayText() | %fallback).first()', { type: 'string', default: '' })
      name!: string

      @column('%report.status', { type: 'string', default: '' })
      reportStatus!: string
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [ConceptFns] })
    // Without the engine: the function is unknown and %reports undeclared.
    expect(
      analyzeDto(Named, { model: r4Model })
        .map(f => f.code)
        .sort()
    ).toEqual(['unknown-function'])
    expect(analyzeDto(Named, { engine })).toEqual([])
    // The sweep covers what the engine registered, with the class on each finding.
    expect(analyzeEngineDtos(engine)).toEqual([])
    expect(engine.dtos).toEqual([ConceptFns])
  })

  it('sweeps an engine and names the DTO each finding came from', () => {
    class Broken extends defineDto('Observation') {
      @column('statuss', { type: 'string', default: '' })
      status!: string
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Broken] })
    expect(analyzeEngineDtos(engine).map(f => [f.dto, f.member, f.expression, f.code])).toEqual([
      ['Broken', 'status', 'statuss', 'unknown-element'],
    ])
  })

  it('keeps the engine context when the caller adds functions or variables of its own', () => {
    // A host declaring one function of its own must not displace the engine's
    // table: `functions` merges per name, like `variables` does, or a perfectly
    // valid column call would come back as unresolved.
    class ConceptFns extends defineDto('CodeableConcept') {
      @column('(text | coding.display.first()).first()', { type: 'string' })
      displayText!: string | undefined
    }
    class Named extends defineDto('Condition', { env: { fallback: 'Condition' } }) {
      @column('(code.displayText() | %fallback | %hostVar).first()', { type: 'string', default: '' })
      name!: string

      @column('hostFn()', { type: 'string', default: '' })
      fromHost!: string
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [ConceptFns] })
    // The host's own function and variable resolve, and so do the engine's.
    expect(
      analyzeDto(Named, {
        engine,
        functions: { hostFn: { minArity: 0, maxArity: 0 } },
        variables: { hostVar: {} },
      })
    ).toEqual([])
    // Without them declared, both are reported — so the case above is not vacuous.
    expect(
      analyzeDto(Named, { engine })
        .map(f => f.code)
        .sort()
    ).toEqual(['unknown-function', 'unknown-variable'])
  })

  it('resolves engine functions passed through options', () => {
    class Named extends defineDto('Condition') {
      @column('code.displayText()', { type: 'string', default: '' })
      name!: string
    }
    class ConceptFns extends defineDto('CodeableConcept') {
      @column('(text | coding.display.first() | coding.first().code).first()')
      displayText!: string | undefined
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [ConceptFns] })
    expect(analyzeDto(Named, { model: r4Model }).map(f => f.code)).toEqual(['unknown-function'])
    expect(analyzeDto(Named, { model: r4Model, functions: engine.defaults.functions ?? {} })).toEqual([])
  })

  it('flags a type-name root on a datatype fhirType, where the runtime navigates to empty', () => {
    // Prefixing paths with the type name still works on a resource DTO; on a
    // datatype DTO the runtime has no resourceType to match, so the column
    // would be empty.
    class Prefixed extends defineDto('CodeableConcept') {
      @column('CodeableConcept.text', { type: 'string' })
      displayText!: string | undefined
    }
    class Relative extends defineDto('CodeableConcept') {
      @column('(text | coding.display.first() | coding.first().code).first()')
      displayText!: string | undefined
    }
    expect(analyzeDto(Prefixed, { model: r4Model }).map(f => [f.member, f.code])).toEqual([
      ['displayText', 'datatype-root'],
    ])
    expect(analyzeDto(Relative, { model: r4Model })).toEqual([])
  })
})
