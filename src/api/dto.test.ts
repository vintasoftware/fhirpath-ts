import { describe, expect, expectTypeOf, it } from 'vitest'

import { analyzeDto, analyzeEngineDtos, analyzeExpression } from '../analyzer/index.ts'
import type {
  Bundle,
  Condition,
  Observation,
  Organization,
  Patient,
  ServiceRequest,
} from '../r4/generated/type-maps.ts'
import { r4, r4Model } from '../r4/index.ts'
import { compile } from './compile.ts'
import { column, criteria, defineDto, dtoDefinition, type DtoEnv } from './dto.ts'
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

  it('filters a searchset down to the DTO type, the way the README recipe does', () => {
    // A searchset carrying _include results holds more than one resource type,
    // so the fhirType check fires on the whole Bundle. Both filters in the
    // README's tip are here, so the recipe cannot rot.
    class PatientRow extends defineDto('Patient') {
      @column('id', { default: '' })
      id!: string
    }
    const matched: Patient = { resourceType: 'Patient', id: 'match1' }
    const includedOrg: Organization = { resourceType: 'Organization', id: 'o1' }
    const includedPatient: Patient = { resourceType: 'Patient', id: 'included' }
    const searchset: Bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [
        { resource: matched, search: { mode: 'match' } },
        { resource: includedOrg, search: { mode: 'include' } },
        { resource: includedPatient, search: { mode: 'include' } },
      ],
    }
    expect(() => r4.project(searchset, PatientRow)).toThrow(
      "project(): row 1 is a Organization, but PatientRow declares fhirType 'Patient'"
    )
    expect(r4.project(r4.filter(searchset, '$this is Patient'), PatientRow)).toEqual([
      { id: 'match1' },
      { id: 'included' },
    ])
    const matches = r4.evaluate("Bundle.entry.where(search.mode = 'match').resource", searchset)
    expect(r4.project(matches, PatientRow)).toEqual([{ id: 'match1' }])
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
    class Toned extends defineDto('Observation') {
      static env = { tones: [{ code: 'final', tone: 'success' }] }

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

  it('a column knows the type it was written against, and says so on the wrong focus', () => {
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns] })
    // displayText is written against CodeableConcept, which
    // Condition.subject.reference — a string — can never be.
    expect(() => engine.evaluate('Condition.subject.reference.displayText()', condition)).toThrow(
      "Function 'displayText' expects FHIR.CodeableConcept as input, but the focus is FHIR.string"
    )
    // The static half says the same thing about the same call.
    expect(
      analyzeExpression('subject.reference.displayText()', {
        model: r4Model,
        inputType: 'Condition',
        functions: engine.defaults.functions ?? {},
      }).map(d => [d.code, d.message])
    ).toEqual([['input-type', 'displayText() expects FHIR.CodeableConcept as input, found FHIR.string']])
  })

  it('leaves the call alone where the focus type proves nothing', () => {
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns] })
    // An empty focus is the spec's own propagation, not a mistake.
    expect(engine.evaluate('Condition.code.text.nothing.displayText()', condition)).toEqual([])
    // The rest run: a value bound as plain env data and a datatype root both
    // carry the Object placeholder, which no model describes.
    expect(engine.evaluate('%loose.displayText()', condition, { env: { loose: { text: 'Hypertension' } } })).toEqual([
      'Hypertension',
    ])
    expect(engine.evaluate('displayText()', condition.code)).toEqual(['Hypertension'])
    // Without a model there is nothing to resolve the declared name against.
    const modelless = new FhirPathEngine({ resourceDtos: [CodeableConceptFns] })
    expect(modelless.evaluate('Condition.subject.reference.displayText()', condition)).toEqual([])
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

  it('a registered column reads its DTO env, and no other expression can', () => {
    class Badges extends defineDto('Observation') {
      static env = { badgeTones: [{ code: 'final', tone: 'success' }] }

      @column('%badgeTones.where(code = %context.status).tone', { type: 'string' })
      badgeTone!: string | undefined
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Badges] })
    expect(engine.evaluate('badgeTone()', weighed)).toEqual(['success'])
    // Registering adds the function name and nothing else: the table stays the
    // DTO's, so an expression that did not go through a column cannot read it.
    expect(() => engine.evaluate('%badgeTones.count()', weighed)).toThrow('Undefined environment variable %badgeTones')
    // Which is also what the static side is told, since it reads the same
    // engine env — the name is not silently declared to every expression.
    expect(engine.defaults.env).toBeUndefined()
    expect(new FhirPathEngine({ model: r4Model, env: { site: 'a' }, resourceDtos: [Badges] }).defaults.env).toEqual({
      site: 'a',
    })
  })

  it('a criteria means the same thing as a column and as a call', () => {
    class Flags extends defineDto('Observation') {
      @criteria("status = 'final'")
      isFinal!: boolean
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Flags] })
    expect(engine.project(weighed, Flags).isFinal).toBe(true)
    expect(engine.evaluate('isFinal()', weighed)).toEqual([true])
    // The criteria rule travels with the function, so both readings agree on a
    // resource where the criteria finds nothing. The call also chains as a
    // boolean instead of returning empty.
    const statusless = { resourceType: 'Observation', code: { text: 'Weight' } }
    expect(engine.project(statusless, Flags).isFinal).toBe(false)
    expect(engine.evaluate('isFinal()', statusless)).toEqual([false])
    expect(engine.evaluate('isFinal().not()', statusless)).toEqual([true])
    // And it reads as a criteria wherever criteria are read.
    expect(engine.filter([weighed, statusless], 'isFinal()')).toEqual([weighed])
    expect(engine.test(statusless, 'isFinal()')).toBe(false)
  })

  it('a criteria carries its column signature and its host type', () => {
    class Flags extends defineDto('Observation') {
      @criteria("status = 'final'")
      isFinal!: boolean
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Flags] })
    const functions = engine.defaults.functions ?? {}
    // The declared Boolean result feeds later checks. The declared input
    // catches a call on a focus that can never be an Observation.
    const codes = (expression: string, inputType: string): string[] =>
      analyzeExpression(expression, { model: r4Model, inputType, functions }).map(d => d.code)
    expect(codes('isFinal().not()', 'Observation')).toEqual([])
    expect(codes("isFinal() + 'x'", 'Observation')).toEqual(['operand-type'])
    expect(codes('code.isFinal()', 'Observation')).toEqual(['input-type'])
  })

  it('a criteria yielding several items fails identically from both paths', () => {
    class Many extends defineDto('Patient') {
      @criteria('name.given')
      hasGiven!: boolean
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Many] })
    const patient = { resourceType: 'Patient', name: [{ given: ['Peter', 'James'] }] }
    const message = 'Expected a collection with at most one item, but found 2'
    expect(() => engine.project(patient, Many)).toThrow(message)
    expect(() => engine.evaluate('hasGiven()', patient)).toThrow(message)
  })

  it('rejects a column whose name is a built-in function, naming the field', () => {
    class Shadow extends defineDto('Observation') {
      @column('code.text', { type: 'string' })
      exists!: string | undefined
    }
    expect(() => new FhirPathEngine({ model: r4Model, resourceDtos: [Shadow] })).toThrow(
      "DTO Shadow declares a column named 'exists', which is a built-in function; rename the field"
    )
  })

  it('two DTOs may declare one column name, and the focus picks between them', () => {
    class CodingFns extends defineDto('Coding') {
      @column('code', { type: 'string' })
      displayText!: string | undefined
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptFns, CodingFns] })
    // Same call text, two bodies: the CodeableConcept column reads the coding's
    // display, the Coding one reads the code.
    expect(engine.evaluate('Condition.code.displayText()', condition)).toEqual(['Hypertension'])
    expect(engine.evaluate('Condition.code.coding.displayText()', condition)).toEqual(['I10'])
    // A focus neither was written for still names both in one message.
    expect(() => engine.evaluate('Condition.subject.reference.displayText()', condition)).toThrow(
      "Function 'displayText' expects FHIR.CodeableConcept | FHIR.Coding as input, but the focus is FHIR.string"
    )
    // The static half resolves the same way, and reports the same call.
    const functions = engine.defaults.functions ?? {}
    const codes = (expression: string): [string, string][] =>
      analyzeExpression(expression, { model: r4Model, inputType: 'Condition', functions }).map(d => [d.code, d.message])
    // Resolved to the Coding column, so its declared String result is what the
    // rest of the chain is checked against.
    expect(codes('code.coding.displayText().length()')).toEqual([])
    expect(codes('code.coding.displayText() + 1')).toEqual([
      ['operand-type', "Operator '+' is not defined for these operand types"],
    ])
    expect(codes('subject.reference.displayText()')).toEqual([
      ['input-type', 'displayText() expects FHIR.CodeableConcept | FHIR.Coding as input, found FHIR.string'],
    ])
  })

  it('rejects a shared column name whose declarations a call cannot tell apart', () => {
    class Concept extends defineDto('CodeableConcept') {
      @column('text', { type: 'string' })
      label!: string | undefined
    }
    // A SimpleQuantity is a Quantity, so a focus could satisfy both columns and
    // the engine would have to guess.
    class Quantities extends defineDto('Quantity') {
      @column('unit', { type: 'string' })
      label!: string | undefined
    }
    class Simple extends defineDto('SimpleQuantity') {
      @column('code', { type: 'string' })
      label!: string | undefined
    }
    expect(() => new FhirPathEngine({ model: r4Model, resourceDtos: [Quantities, Simple] })).toThrow(
      "DTO Simple redefines the function 'label': a focus can be both FHIR.Quantity and FHIR.SimpleQuantity"
    )
    // A host function accepts any focus, so nothing may share its name.
    expect(
      () =>
        new FhirPathEngine({
          model: r4Model,
          resourceDtos: [Concept],
          functions: { label: { fn: () => 'x' } },
        })
    ).toThrow(
      "DTO Concept redefines the function 'label': a declaration that names no input type answers every call, so nothing else may share its name"
    )
    // Without a model no two types can be told apart, so the pair is refused.
    expect(() => new FhirPathEngine({ resourceDtos: [Concept, Quantities] })).toThrow(
      "DTO Quantities redefines the function 'label': without a model bound, the engine cannot tell two declarations apart by their focus"
    )
  })

  it('two DTOs may declare one env name with different values; each column reads its own', () => {
    // The case a shared engine namespace could not express: the two disagree
    // about %system on purpose, and neither is asked to yield.
    class Labs extends defineDto('Patient') {
      static env = { system: 'http://loinc.org' }

      @column('%system', { type: 'string', default: '' })
      system!: string
    }
    class Problems extends defineDto('Practitioner') {
      static env = { system: 'http://snomed.info/sct' }

      @column('%system', { type: 'string', default: '' })
      problemSystem!: string
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Labs, Problems] })
    expect(engine.evaluate('system()', { resourceType: 'Patient' })).toEqual(['http://loinc.org'])
    expect(engine.evaluate('problemSystem()', { resourceType: 'Practitioner' })).toEqual(['http://snomed.info/sct'])
    // And projecting either one gives the same answer its column gives.
    expect(engine.project({ resourceType: 'Patient' }, Labs).system).toBe('http://loinc.org')
    expect(engine.project({ resourceType: 'Practitioner' }, Problems).problemSystem).toBe('http://snomed.info/sct')
  })

  it('several DTOs may register per fhirType; only a shared column name is a conflict', () => {
    // Distinct row shapes for one resource are ordinary — a weight row and a
    // blood-pressure row are both Observations.
    class Weights extends defineDto('Observation') {
      @column("value.ofType(Quantity).toQuantity('kg').value", { type: 'decimal' })
      kg!: number | undefined
    }
    class Panels extends defineDto('Observation') {
      @column('component.count()', { type: 'integer' })
      partCount!: number | undefined
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Weights, Panels] })
    expect(engine.evaluate('kg()', weighed)).toEqual([80])
    expect(engine.evaluate('partCount()', weighed)).toEqual([0])

    class AlsoWeights extends defineDto('Observation') {
      @column('valueQuantity.value', { type: 'decimal' })
      kg!: number | undefined
    }
    expect(() => new FhirPathEngine({ model: r4Model, resourceDtos: [Weights, AlsoWeights] })).toThrow(
      "DTO AlsoWeights redefines the function 'kg': both are written for FHIR.Observation"
    )
  })
})

describe('a DTO env reaches its own columns and stops there', () => {
  /** The engine variable every case below checks a DTO env against. */
  const withEngineEnv = { model: r4Model, env: { site: 'engine' } }

  it('is collected from the class, with either key spelling', () => {
    class Spelled extends defineDto('Observation') {
      static env = { '%prefixed': 'yes', bare: 'also' }

      @column('%prefixed', { type: 'string', default: '' })
      prefixed!: string

      @column('%bare', { type: 'string', default: '' })
      bare!: string
    }
    // Both spellings name one variable, as everywhere else env is accepted.
    expect(dtoDefinition(Spelled).env).toEqual({ prefixed: 'yes', bare: 'also' })
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Spelled] })
    expect(engine.evaluate('prefixed() | bare()', weighed)).toEqual(['yes', 'also'])
  })

  it('reads a static getter, once, for a table built rather than written out', () => {
    let built = 0
    class Computed extends defineDto('Observation') {
      static get env(): DtoEnv {
        built += 1
        return { codes: ['final', 'amended'] }
      }

      @column('%codes.where($this = %context.status).exists()', { type: 'boolean', default: false })
      known!: boolean
    }
    // The definition is collected once per class, so the getter runs once
    // however many rows or calls follow.
    expect(r4.project([weighed, weighed], Computed).map(row => row.known)).toEqual([true, true])
    expect(built).toBe(1)
  })

  it('merges down the class chain, most derived winning per name', () => {
    // Annotating the base `DtoEnv` is what lets a subclass name one entry: an
    // inferred literal type would make TypeScript demand the whole record back.
    class Base extends defineDto('Observation') {
      static env: DtoEnv = { unit: 'kg', label: 'Reading' }

      @column('%label', { type: 'string', default: '' })
      label!: string
    }
    class Derived extends Base {
      static override env = { unit: 'lb' }

      @column('%unit', { type: 'string', default: '' })
      unit!: string
    }
    // The base keeps its own view: a subclass overriding one entry changes
    // nothing for the class it extends.
    expect(dtoDefinition(Derived).env).toEqual({ unit: 'lb', label: 'Reading' })
    expect(dtoDefinition(Base).env).toEqual({ unit: 'kg', label: 'Reading' })
    expect(r4.project(weighed, Derived)).toMatchObject({ unit: 'lb', label: 'Reading' })
  })

  it('refuses a static env that is not a record of variables', () => {
    class NotARecord extends defineDto('Observation') {
      static env = ['kg']

      @column('status', { type: 'string', default: '' })
      status!: string
    }
    expect(() => r4.project(weighed, NotARecord)).toThrow(
      "DTO NotARecord declares a static 'env' that is not a record of variables"
    )

    // Nothing to declare is not a mistake: a DTO that computes its table and
    // comes up with none reads like one that never declared env at all.
    class NoneAfterAll extends defineDto('Observation') {
      static env: DtoEnv | undefined = undefined

      @column('status', { type: 'string', default: '' })
      status!: string
    }
    expect(dtoDefinition(NoneAfterAll).env).toBeUndefined()
    expect(r4.project(weighed, NoneAfterAll).status).toBe('final')
  })

  it('lays over the caller env for the call and leaves it as it was', () => {
    class Sited extends defineDto('Observation') {
      static env = { site: 'dto' }

      @column('%site', { type: 'string', default: '' })
      site!: string
    }
    const engine = new FhirPathEngine({ ...withEngineEnv, resourceDtos: [Sited] })
    // Inside the body the DTO's value wins; outside it, before and after the
    // same call, the engine's is untouched.
    expect(engine.evaluate('%site.combine(site()).combine(%site)', weighed)).toEqual(['engine', 'dto', 'engine'])
  })

  it('leaves every name the DTO does not declare to the caller', () => {
    class Partial extends defineDto('Observation') {
      static env = { own: 'mine' }

      @column("%site.combine(%own).combine(%loinc).combine(%context.status).join('/')", {
        type: 'string',
        default: '',
      })
      seen!: string
    }
    const engine = new FhirPathEngine({ ...withEngineEnv, resourceDtos: [Partial] })
    // The engine env, the built-in constants, and %context all stay the
    // caller's; only `own` is added.
    expect(engine.evaluate('seen()', weighed)).toEqual(['engine/mine/http://loinc.org/final'])
  })

  it('reaches a per-call name the caller supplies, and a per-call name wins where they collide', () => {
    class Requested extends defineDto('Observation') {
      static env = { site: 'dto' }

      @column("%requestId.combine(%site).join('/')", { type: 'string', default: '' })
      tagged!: string
    }
    const engine = new FhirPathEngine({ ...withEngineEnv, resourceDtos: [Requested] })
    // A per-call name the DTO never declared is readable in the body...
    expect(engine.evaluate('tagged()', weighed, { env: { requestId: 'r-1' } })).toEqual(['r-1/dto'])
    // ...but where both name it, the DTO's own value is what its column meant.
    expect(engine.evaluate('tagged()', weighed, { env: { requestId: 'r-2', site: 'call' } })).toEqual(['r-2/dto'])
  })

  it('gives each DTO its own overlay when one column calls another DTO', () => {
    class Inner extends defineDto('CodeableConcept') {
      static env = { source: 'inner', innerOnly: 'yes' }

      @column("%source.combine(%outerOnly).join('/')", { type: 'string', default: '' })
      sourced!: string
    }
    class Outer extends defineDto('Observation') {
      static env = { source: 'outer', outerOnly: 'reachable' }

      @column("code.sourced().combine(%source).join('/')", { type: 'string', default: '' })
      chained!: string

      @column('%innerOnly', { type: 'string', default: '' })
      borrowed!: string
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Inner, Outer] })
    // Inner's body sees its own %source, and Outer's %outerOnly through the
    // caller env it inherits; back in Outer, %source is Outer's again.
    expect(engine.evaluate('chained()', weighed)).toEqual(['inner/reachable/outer'])
    // The overlay lasts exactly as long as the body it belongs to, so Inner's
    // private name is undefined in Outer — the spec's answer for a name nothing
    // declares, not an empty one.
    expect(() => engine.evaluate('borrowed()', weighed)).toThrow('Undefined environment variable %innerOnly')
  })

  it('travels with a criteria, and with each member of an overloaded name', () => {
    class Concepts extends defineDto('CodeableConcept') {
      static env = { wanted: 'Weight' }

      @column('%wanted', { type: 'string', default: '' })
      wantedLabel!: string
    }
    class Codings extends defineDto('Coding') {
      static env = { wanted: 'Body weight' }

      @column('%wanted', { type: 'string', default: '' })
      wantedLabel!: string
    }
    class Flags extends defineDto('Observation') {
      static env = { finalStatus: 'final' }

      @criteria('status = %finalStatus')
      isFinal!: boolean
    }
    const coded: Observation = {
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'Weight', coding: [{ system: 'http://loinc.org', code: '29463-7' }] },
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Concepts, Codings, Flags] })
    // One name, two bodies, two envs — the focus picks both together.
    expect(engine.evaluate('code.wantedLabel()', coded)).toEqual(['Weight'])
    expect(engine.evaluate('code.coding.wantedLabel()', coded)).toEqual(['Body weight'])
    // And the criteria rule and the overlay apply to the same call.
    expect(engine.evaluate('isFinal()', weighed)).toEqual([true])
    expect(engine.evaluate('isFinal()', { resourceType: 'Observation' })).toEqual([false])
  })

  it('is in scope for a body reached through a var, and beside %rowIndex when projecting', () => {
    class Reported extends defineDto('DiagnosticReport') {
      static env = { fallback: 'unread' }

      @column('(conclusion | %fallback).first()', { type: 'string', default: '' })
      summary!: string
    }
    class Row extends defineDto('DiagnosticReport', { vars: { text: 'summary()' } }) {
      @column("%rowIndex.toString().combine(%text).join(':')", { type: 'string', default: '' })
      line!: string
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Reported] })
    // The var body calls the column, whose own env resolves there too, and the
    // row numbering the projection adds is still the caller env the body reads.
    expect(engine.project([{ resourceType: 'DiagnosticReport' }, { resourceType: 'DiagnosticReport' }], Row)).toEqual([
      expect.objectContaining({ line: '0:unread' }),
      expect.objectContaining({ line: '1:unread' }),
    ])
  })

  it('does not weaken the recursion guard', () => {
    class Looping extends defineDto('Observation') {
      static env = { marker: 'x' }

      @column("%marker.combine(loops()).join('')", { type: 'string', default: '' })
      loops!: string
    }
    const engine = new FhirPathEngine({ model: r4Model, resourceDtos: [Looping] })
    expect(() => engine.evaluate('loops()', weighed)).toThrow(
      "Expression-defined function 'loops' calls itself, directly or through another function"
    )
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
      vars: {
        report: '%reports.where(orderId = %context.id).report',
        badge: 'iif(%report.exists(), %report, %waitingBadge)',
      },
    }) {
      static env = { waitingBadge: { label: 'Waiting' } }

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
      // The join table arrives per call, so the DTO declares only the name.
      callerEnv: ['reports'],
      vars: { report: '%reports.where(id = %context.id).first()' },
    }) {
      static env = { fallback: 'Condition' }

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
    class Named extends defineDto('Condition') {
      static env = { fallback: 'Condition' }

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
