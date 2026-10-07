import { describe, expect, expectTypeOf, it } from 'vitest'

import { analyzeDto, analyzeEngineDtos, analyzeExpression } from '../analyzer/index.ts'
import type {
  Appointment,
  Bundle,
  Condition,
  DiagnosticReport,
  Observation,
  Organization,
  Patient,
  R4Resources,
  ServiceRequest,
} from '../r4/generated/type-maps.ts'
import { r4, r4Model } from '../r4/index.ts'
import { compile } from './compile.ts'
import { type DtoBase, dtoDefinition, type DtoFunctions, type DtoInput, type DtoOptions } from './dto.ts'
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
class ObservationRow extends r4.defineView('Observation') {
  at = this.column('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
}

class WeightRow extends ObservationRow {
  lbs = this.column("value.ofType(Quantity).toQuantity('[lb_av]').value", { default: 0 })

  kg = this.column("value.ofType(Quantity).toQuantity('kg').value", { default: 0 })

  isFinal = this.criteria("status = 'final'")

  get roundedLbs(): number {
    return Math.round(this.lbs)
  }
}

describe('DTO projection', () => {
  it('materializes rows as class instances, each field typed from its expression', () => {
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
    class ConditionRow extends r4.defineView('Condition', { callerEnv: ['summary'] }) {
      statusCode = this.column('clinicalStatus.coding.first().code')

      display = this.column('(code.text | code.coding.display.first()).first()')

      recorded = this.column('recordedDate')

      codes = this.column('code.coding.code', { collection: true })

      // A caller value with no declared type is outside inference, so `type`
      // supplies the result type. analyzeDto checks it where it can.
      annotated = this.column('%summary.text', { type: 'string' })

      // Without `type`, such a column is `unknown`, never a guessed type.
      opaque = this.column('%summary.text')
    }
    const row = new ConditionRow()
    expectTypeOf(row.statusCode).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.display).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.recorded).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.codes).toEqualTypeOf<string[]>()
    expectTypeOf(row.annotated).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.opaque).toEqualTypeOf<unknown>()
    expect(analyzeDto(ConditionRow, { model: r4Model })).toEqual([])
  })

  it('env, vars, callerEnv, and row variables all reach column inference', () => {
    class OrderRow extends r4.defineView('ServiceRequest', {
      env: { tones: [{ code: 'active', tone: 'info' }], label: 'Order' },
      callerEnv: { reports: { type: 'DiagnosticReport', collection: true } },
      vars: { report: "%reports.where(basedOn.reference = 'ServiceRequest/' + %context.id).first()" },
    }) {
      reportStatus = this.column('%report.status', { default: 'waiting' })

      reportIssued = this.column('%report.issued')

      tone = this.column('%tones.where(code = %context.status).tone.first()')

      label = this.column('%label')

      position = this.column('%rowIndex + 1', { default: 0 })

      last = this.criteria('%rowIndex = %rowTotal - 1')
    }
    const row = new OrderRow()
    expectTypeOf(row.reportStatus).toEqualTypeOf<DiagnosticReport['status'] | 'waiting'>()
    expectTypeOf(row.reportIssued).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.tone).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.label).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.position).toEqualTypeOf<number>()
    expectTypeOf(row.last).toEqualTypeOf<boolean>()
    const orders: ServiceRequest[] = [
      { resourceType: 'ServiceRequest', id: 'sr1', status: 'active', intent: 'order', subject: {} },
      { resourceType: 'ServiceRequest', id: 'sr2', status: 'draft', intent: 'order', subject: {} },
    ]
    const reports = [
      {
        resourceType: 'DiagnosticReport',
        status: 'final',
        issued: '2026-01-05T08:30:00Z',
        basedOn: [{ reference: 'ServiceRequest/sr1' }],
      },
    ]
    expect(r4.project(orders, OrderRow, { env: { reports } })).toEqual([
      expect.objectContaining({ reportStatus: 'final', tone: 'info', label: 'Order', position: 1, last: false }),
      expect.objectContaining({ reportStatus: 'waiting', tone: undefined, position: 2, last: true }),
    ])
    expect(analyzeDto(OrderRow, { model: r4Model })).toEqual([])
  })

  it('options known only by their shape declare nothing, and row variables stay typed', () => {
    const options: DtoOptions = { env: { unit: 'kg' } }
    class Loose extends r4.defineView('Observation', options) {
      unit = this.column('%unit')

      position = this.column('%rowIndex', { default: 0 })
    }
    expectTypeOf(new Loose().unit).toEqualTypeOf<unknown>()
    expectTypeOf(new Loose().position).toEqualTypeOf<number>()
    expect(r4.project(weighed, Loose)).toMatchObject({ unit: 'kg', position: 0 })
  })

  it('a declared type that cannot hold the column value is a compile error', () => {
    class Wrong extends r4.defineView('Condition', {
      vars: { code: 'code.coding.code.first()' },
      callerEnv: ['summary'],
    }) {
      // @ts-expect-error -- the expression yields string | undefined, not number
      wrongType: number = this.column('clinicalStatus.coding.first().code')

      // @ts-expect-error -- the expression may be empty, so the field must allow undefined
      tooNarrow: string = this.column('clinicalStatus.coding.first().code')

      // @ts-expect-error -- a var's type is inferred too
      viaVar: number = this.column('%code')

      // @ts-expect-error -- an expression TypeScript cannot infer is unknown, which holds no declared type
      opaque: string = this.column('%summary.text')

      // Wider than the column value: accepted.
      wider: string | number | undefined = this.column('clinicalStatus.coding.first().code')
    }
    expect(new Wrong().fhirType).toBe('Condition')
  })

  it('projects on its own engine and engines derived from it, and nowhere else', () => {
    // No registration is needed to project, only the engine the types came from.
    expect(r4.project(weighed, WeightRow).kg).toBe(80)
    class Flags extends r4.defineDto('Observation') {
      isFinal = this.criteria("status = 'final'")
    }
    expect(r4.register(Flags).project(weighed, WeightRow).kg).toBe(80)
    // Another engine may carry a different model, env, or functions.
    expect(() => new FhirPathEngine({ model: r4Model }).project(weighed, WeightRow)).toThrow(
      'project(): WeightRow was defined on another engine; project it with that engine or one derived from it'
    )
  })

  it('reads the engine env a column was typed from, whatever the caller passes', () => {
    const sited = new FhirPathEngine({ model: r4Model, env: { site: 'engine' } })
    class SiteDto extends sited.defineDto('Observation') {
      site = this.column('%site', { default: '' })
    }
    const fp = sited.register(SiteDto)
    class Sited extends fp.defineView('Observation') {
      site = this.column('%site', { default: '' })

      viaCall = this.column('site()', { default: '' })
    }
    expectTypeOf(new Sited().site).toEqualTypeOf<string>()
    // Projected or called, the column reads the engine's value, not the caller's.
    expect(fp.project(weighed, Sited, { env: { '%site': 42, requestId: 'r-1' } })).toMatchObject({
      site: 'engine',
      viaCall: 'engine',
    })
    const called = () => fp.evaluate('site()', weighed, { env: { site: 42 } })
    expectTypeOf(called).returns.toEqualTypeOf<string[]>()
    expect(called()).toEqual(['engine'])
    // Outside a column body, a per-call value still replaces the engine's.
    expect(fp.evaluate('%site', weighed, { env: { site: 42 } })).toEqual([42])
  })

  it('calls the engine functions a column was typed from, whatever the caller passes', () => {
    const hosted = new FhirPathEngine({
      model: r4Model,
      functions: { shout: { expression: 'upper()', signature: { result: { types: ['string'] } } } },
    })
    class LoudDto extends hosted.defineDto('Observation') {
      loud = this.column('status.shout()')
    }
    const fp = hosted.register(LoudDto)
    class Loud extends fp.defineView('Observation') {
      status = this.column('status.shout()')
    }
    expectTypeOf(new Loud().status).toEqualTypeOf<string | undefined>()
    const replaced = { functions: { shout: { expression: 'length()' } } }
    // Projected or called, the column keeps the engine's shout().
    expect(fp.project(weighed, Loud, replaced).status).toBe('FINAL')
    const called = () => fp.evaluate('loud()', weighed, replaced)
    expectTypeOf(called).returns.toEqualTypeOf<string[]>()
    expect(called()).toEqual(['FINAL'])
    // Outside a column body, a per-call function still replaces the engine's.
    expect(fp.evaluate('status.shout()', weighed, replaced)).toEqual([5])
  })

  it("keeps another DTO's same-name column callable inside a column body", () => {
    const base = new FhirPathEngine({ model: r4Model })
    class CodingDto extends base.defineDto('Coding') {
      displayText = this.column('display')
    }
    const withCoding = base.register(CodingDto)
    class ConceptDto extends withCoding.defineDto('CodeableConcept') {
      displayText = this.column('text')

      // The Coding overload, reached from a body whose own table also holds
      // the CodeableConcept one: the focus picks between them.
      firstCoding = this.column('coding.first().displayText()')
    }
    const fp = withCoding.register(ConceptDto)
    const condition: Condition = {
      resourceType: 'Condition',
      subject: { reference: 'Patient/p1' },
      code: { text: 'T', coding: [{ display: 'D' }] },
    }
    expect(fp.evaluate('Condition.code.firstCoding()', condition)).toEqual(['D'])
    expect(fp.project([condition.code], ConceptDto)).toEqual([expect.objectContaining({ firstCoding: 'D' })])
    expect(analyzeDto(ConceptDto)).toEqual([])
  })

  it('collects every column when a field initializer collects another DTO', () => {
    // A plain field can run arbitrary code, including code that asks for another
    // DTO's definition — registering one on an engine is enough. The inner
    // collection must not end the outer one, or the columns below it vanish.
    class Inner extends r4.defineDto('Condition') {
      at = this.column('recordedDate')
    }
    class Outer extends r4.defineView('Observation') {
      status = this.column('status')

      helper = r4.register(Inner)

      issued = this.column('issued')
    }
    expect(Object.keys(dtoDefinition(Outer).columns)).toEqual(['status', 'issued'])
    expect(Object.keys(dtoDefinition(Inner).columns)).toEqual(['at'])
    expect(r4.project([weighed], Outer)[0]).toMatchObject({ status: 'final' })
  })

  it('collects a definition once, however the class is instantiated around it', () => {
    class Reused extends r4.defineView('Observation') {
      status = this.column('status', { type: 'string', default: '' })
    }
    // Instances built outside collection record nothing and hold no column
    // value until projection fills it: one before, and one after — which is
    // what every projected row starts as.
    expect(new Reused().status).toBeUndefined()
    const first = dtoDefinition(Reused)
    expect(Object.values(new Reused())).toEqual([undefined])
    r4.project([{ resourceType: 'Observation', status: 'final' }], Reused)
    const second = dtoDefinition(Reused)
    expect(second).toBe(first)
    expect(Object.keys(second.columns)).toEqual(['status'])
  })

  it('vars express the join, and keep their meaning against per-call vars', () => {
    class OrderRow extends r4.defineView('ServiceRequest', {
      vars: { report: '%reports.where(orderId = %context.id).report' },
    }) {
      id = this.column('id', { default: '' })

      reportStatus = this.column('%report.status', { type: 'string', default: 'waiting' })
    }
    const orders: ServiceRequest[] = [
      { resourceType: 'ServiceRequest', id: 'sr1', status: 'active', intent: 'order', subject: {} },
      { resourceType: 'ServiceRequest', id: 'sr2', status: 'active', intent: 'order', subject: {} },
    ]
    const reports = [{ orderId: 'sr1', report: { resourceType: 'DiagnosticReport', id: 'dr1', status: 'final' } }]
    expect(r4.project(orders, OrderRow, { env: { reports } })).toEqual([
      expect.objectContaining({ id: 'sr1', reportStatus: 'final' }),
      expect.objectContaining({ id: 'sr2', reportStatus: 'waiting' }),
    ])
    // The DTO var wins over a per-call var of the same name, as its env does:
    // the column types were inferred from the DTO's own binding.
    const called = r4.project(orders, OrderRow, { env: { reports }, vars: { report: '{}' } })
    expect(called.map(row => row.reportStatus)).toEqual(['final', 'waiting'])
  })

  it('narrows a searchset down to the DTO type, the way the documented recipe does', () => {
    // A searchset carrying _include results holds more than one resource type,
    // so the fhirType check fires on the whole Bundle. Both recipes in the
    // documentation are here, so they cannot rot: `ofType()` on the entries
    // infers `Patient[]`, which is what `project()` accepts.
    class PatientRow extends r4.defineView('Patient') {
      id = this.column('id', { default: '' })
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
    const patients = r4.evaluate('Bundle.entry.resource.ofType(Patient)', searchset)
    expectTypeOf(patients).toEqualTypeOf<Patient[]>()
    expect(r4.project(patients, PatientRow)).toEqual([{ id: 'match1' }, { id: 'included' }])
    const matches = r4.evaluate("Bundle.entry.where(search.mode = 'match').resource.ofType(Patient)", searchset)
    expect(r4.project(matches, PatientRow)).toEqual([{ id: 'match1' }])
    // `filter()` keeps the type of an array it is given, but a Bundle's entries
    // are untyped, so that route needs a narrowing step before projection.
    const filtered = r4.filter(searchset, '$this is Patient')
    expectTypeOf(filtered).toEqualTypeOf<unknown[]>()
    // @ts-expect-error -- unknown[] is not a Patient input
    expect(r4.project(filtered, PatientRow)).toEqual([{ id: 'match1' }, { id: 'included' }])
  })

  it('projecting checks each row against the fhirType, failing loudly on a mismatch', () => {
    const patient: Patient = { resourceType: 'Patient', id: 'p1' }
    // @ts-expect-error -- a Patient is not an Observation input
    expect(() => r4.project([weighed, patient], WeightRow)).toThrow(
      "project(): row 1 is a Patient, but WeightRow declares fhirType 'Observation'"
    )
    // A datatype fhirType has no resourceType to check against.
    class ConceptRow extends r4.defineView('CodeableConcept') {
      text = this.column('(text | coding.display.first()).first()', { default: '' })
    }
    expect(r4.project([{ text: 'Weight' }], ConceptRow)).toEqual([expect.objectContaining({ text: 'Weight' })])
  })

  it('an abstract resource root is a resource root too, at compile time as at runtime', () => {
    class DomainDto extends r4.defineDto('DomainResource') {
      narrative = this.column('text.status')
    }
    expectTypeOf<DtoInput<typeof DomainDto>>().toEqualTypeOf<{
      readonly resourceType: Exclude<keyof R4Resources, 'Binary' | 'Bundle' | 'Parameters'>
    }>()
    // @ts-expect-error -- not a resource
    expect(() => DomainDto.from({ hello: 1 })).toThrow(
      "project(): row 0 has no resourceType, but DomainDto declares fhirType 'DomainResource'"
    )
  })

  it('a resource root rejects a value that is not a resource, at compile time and at runtime', () => {
    class ConditionDto extends r4.defineDto('Condition') {
      code = this.column('code.text')
    }
    const condition: Condition = { resourceType: 'Condition', subject: {}, code: { text: 'Hypertension' } }
    expectTypeOf(r4.project(condition, ConditionDto)).toEqualTypeOf<ConditionDto>()
    expectTypeOf(r4.project([condition], ConditionDto)).toEqualTypeOf<ConditionDto[]>()
    expectTypeOf(r4.project({ resourceType: 'Condition' }, ConditionDto)).toEqualTypeOf<ConditionDto>()
    // @ts-expect-error -- a number is not a Condition
    expect(() => r4.project(42, ConditionDto)).toThrow(
      "project(): row 0 is a number, not a resource, but ConditionDto declares fhirType 'Condition'"
    )
    // @ts-expect-error -- an object without resourceType is not a Condition
    expect(() => r4.project({ nonsense: true }, ConditionDto)).toThrow(
      "project(): row 0 has no resourceType, but ConditionDto declares fhirType 'Condition'"
    )
    // @ts-expect-error -- null is not a Condition
    expect(() => r4.project([null], ConditionDto)).toThrow(
      "project(): row 0 is null, not a resource, but ConditionDto declares fhirType 'Condition'"
    )
    // @ts-expect-error -- a nested array is not a Condition
    expect(() => r4.project([condition, [condition]], ConditionDto)).toThrow(
      "project(): row 1 is an array, not a resource, but ConditionDto declares fhirType 'Condition'"
    )
    // @ts-expect-error -- a Patient is not a Condition
    expect(() => r4.project({ resourceType: 'Patient' }, ConditionDto)).toThrow(
      "project(): row 0 is a Patient, but ConditionDto declares fhirType 'Condition'"
    )
    // A widened resourceType proves nothing, so it needs a type or `as const`.
    const widened = { resourceType: 'Condition' }
    // @ts-expect-error -- { resourceType: string } may be any resource
    expect(r4.project(widened, ConditionDto).code).toBeUndefined()
    const unknownInput: unknown = condition
    // @ts-expect-error -- unknown must be narrowed before projection
    expect(r4.project(unknownInput, ConditionDto).code).toBe('Hypertension')
    // A Bundle is accepted as a whole; its entries are checked at runtime only.
    const bundle: Bundle = { resourceType: 'Bundle', type: 'collection', entry: [{ resource: condition }] }
    expect(r4.project(bundle, ConditionDto)).toEqual([expect.objectContaining({ code: 'Hypertension' })])
    // Without a model, nothing says whether the root is a resource, so only a
    // present resourceType is compared, as before.
    const modelless = new FhirPathEngine()
    class Loose extends modelless.defineView('Condition') {
      code = this.column('code.text')
    }
    expect(modelless.project({ nonsense: true } as never, Loose)).toEqual(expect.objectContaining({ code: undefined }))
    expect(() => modelless.project({ resourceType: 'Patient' } as never, Loose)).toThrow(
      "project(): row 0 is a Patient, but Loose declares fhirType 'Condition'"
    )
  })

  it('a required column demands its path on the input and drops undefined from the field', () => {
    class ScheduledAppointment extends r4.defineDto('Appointment') {
      id = this.column('id', { required: true })

      start = this.column('start', { required: true })

      lastUpdated = this.column('meta.lastUpdated', { required: true })

      end = this.column('end')

      status = this.column('status', { required: true })
    }
    expectTypeOf<DtoInput<typeof ScheduledAppointment>>().toEqualTypeOf<
      { readonly resourceType: 'Appointment' } & { readonly id: string } & { readonly start: string } & {
        readonly meta: { readonly lastUpdated: string }
      } & { readonly status: string }
    >()
    const row = new ScheduledAppointment()
    expectTypeOf(row.id).toExtend<string>()
    expectTypeOf(row.start).toExtend<string>()
    expectTypeOf(row.lastUpdated).toExtend<string>()
    expectTypeOf(row.status).toExtend<string>()
    expectTypeOf(row.end).toEqualTypeOf<string | undefined>()
    // The marker is invisible to assignment in both directions.
    const plain: string = row.start
    expect(plain).toBeUndefined()
    // The generated interface leaves these elements optional, so the input type
    // narrows it: the shape a scheduling screen would type its data with.
    const appointment: Appointment & DtoInput<typeof ScheduledAppointment> = {
      resourceType: 'Appointment',
      id: 'a1',
      status: 'booked',
      start: '2026-03-01T09:00:00Z',
      meta: { lastUpdated: '2026-02-01T00:00:00Z' },
      participant: [{ status: 'accepted' }],
    }
    expect(r4.project(appointment, ScheduledAppointment)).toEqual(
      expect.objectContaining({ id: 'a1', start: '2026-03-01T09:00:00Z', lastUpdated: '2026-02-01T00:00:00Z' })
    )
    // The requirement is on the input: a resource that may lack `start` does not compile.
    const unscheduled: Appointment = { resourceType: 'Appointment', status: 'proposed', participant: [] }
    // @ts-expect-error -- Appointment has an optional start, the DTO requires it
    const rejected = r4.project(unscheduled, ScheduledAppointment)
    expect(rejected).toEqual(expect.objectContaining({ start: undefined }))
    const idless = { resourceType: 'Appointment', start: '', meta: { lastUpdated: '' }, status: '' } as const
    // @ts-expect-error -- id is missing
    const alsoRejected = r4.project(idless, ScheduledAppointment)
    expect(alsoRejected).toEqual(expect.objectContaining({ id: undefined }))
    // There is no runtime check: a Bundle entry that lacks the path reads undefined, as any column does.
    const bundle: Bundle = { resourceType: 'Bundle', type: 'collection', entry: [{ resource: unscheduled }] }
    expect(r4.project(bundle, ScheduledAppointment)[0]!.start).toBeUndefined()
    // The class is registrable: a required column is an ordinary column to the engine.
    expect(r4.register(ScheduledAppointment).evaluate('start()', appointment)).toEqual(['2026-03-01T09:00:00Z'])
  })

  it('required is refused where the input type cannot name the path', () => {
    class Bad extends r4.defineView('Appointment') {
      // @ts-expect-error -- an expression, not a path
      first = this.column('participant.first().status', { required: true })

      // @ts-expect-error -- a collection element
      participants = this.column('participant', { required: true })

      // @ts-expect-error -- not an element
      typo = this.column('strat', { required: true })

      // @ts-expect-error -- a root-prefixed path is not relative
      prefixed = this.column('Appointment.start', { required: true })

      // @ts-expect-error -- required takes no default
      defaulted = this.column('start', { required: true, default: '' })

      // @ts-expect-error -- required takes no collection
      collected = this.column('start', { required: true, collection: true })

      // @ts-expect-error -- required takes no conversion
      converted = this.column('start', { required: true, as: 'Date' })

      // @ts-expect-error -- the path's own type is exact, so a declared type could only contradict it
      typed = this.column('start', { required: true, type: 'integer' })
    }
    class Choice extends r4.defineView('Observation') {
      // @ts-expect-error -- a choice element has no single key
      value = this.column('value', { required: true })

      // @ts-expect-error -- nor does a choice element that is a date or a period
      effective = this.column('effective', { required: true })
    }
    // The runtime never sees `required`: the recorded columns are plain ones.
    expect(dtoDefinition(Bad).columns['defaulted']).toEqual({ path: 'start', default: '' })
    expect(dtoDefinition(Choice).columns['value']).toEqual({ path: 'value' })
    // Plain project() columns have no class to carry a requirement.
    // @ts-expect-error -- required is a DTO column option
    expect(r4.project({ resourceType: 'Appointment' }, { start: { path: 'start', required: true } })).toEqual({
      start: undefined,
    })
  })

  it('from() projects on the defining engine, typed like project()', () => {
    class ConceptDto extends r4.defineDto('CodeableConcept') {
      label = this.column('(text | coding.display.first()).first()')
    }
    const fp = r4.register(ConceptDto)
    class ConditionRow extends fp.defineView('Condition') {
      id = this.column('id', { required: true })

      name = this.column('code.label()', { default: 'Condition' })
    }
    class ConditionDtoOnFp extends fp.defineDto('Condition') {
      summary = this.column('code.label()')
    }
    const condition: Condition & { id: string } = {
      resourceType: 'Condition',
      id: 'c1',
      subject: {},
      code: { text: 'Hypertension' },
    }
    expectTypeOf(ConditionRow.from(condition)).toEqualTypeOf<ConditionRow>()
    expectTypeOf(ConditionRow.from([condition])).toEqualTypeOf<ConditionRow[]>()
    expect(ConditionRow.from(condition)).toEqual(expect.objectContaining({ id: 'c1', name: 'Hypertension' }))
    expect(ConditionRow.from([condition, condition]).map(row => row.name)).toEqual(['Hypertension', 'Hypertension'])
    expect(ConditionRow.from(condition)).toBeInstanceOf(ConditionRow)
    // The subclass is what projects, not the base the engine returned.
    expectTypeOf(ConceptDto.from({ text: 'x' })).toEqualTypeOf<ConceptDto>()
    expect(ConceptDto.from({ text: 'x' }).label).toBe('x')
    // @ts-expect-error -- id is required
    expect(ConditionRow.from({ resourceType: 'Condition' }).id).toBeUndefined()
    // @ts-expect-error -- not a Condition
    expect(() => ConditionRow.from({ resourceType: 'Patient', id: 'p1' })).toThrow(
      "project(): row 0 is a Patient, but ConditionRow declares fhirType 'Condition'"
    )
    // Per-call options reach the columns as they do through project().
    class Labelled extends r4.defineView('Condition', { callerEnv: ['label'] }) {
      label = this.column('%label', { type: 'string', default: '' })
    }
    expect(Labelled.from(condition, { env: { label: 'Problem' } }).label).toBe('Problem')
    // It is one more route to the defining engine's projection.
    expect(fp.project(condition, ConditionRow).name).toBe('Hypertension')
    expect(fp.register(ConditionDtoOnFp).project(condition, ConditionRow).name).toBe('Hypertension')
  })

  it('DTO env applies when projecting, over a per-call name of its own', () => {
    class Toned extends r4.defineDto('Observation', { env: { tones: [{ code: 'final', tone: 'success' }] } }) {
      tone = this.column('%tones.where(code = %context.status).tone', { type: 'string', default: 'neutral' })

      // The same table, reached the other way: a column called as a function.
      viaCall = this.column('tone()', { type: 'string', default: 'neutral' })

      supplied = this.column('%caller', { type: 'string', default: '' })
    }
    const engine = r4.register(Toned)
    expect(engine.project(weighed, Toned, { env: { caller: 'through' } }).tone).toBe('success')
    // A name the DTO declares means the DTO's value by either route. Answering
    // one way through a path and another through a call would be the same
    // declaration meaning two things in one projection.
    const overridden = engine.project(weighed, Toned, { env: { tones: [], caller: 'through' } })
    expect(overridden.tone).toBe('success')
    expect(overridden.viaCall).toBe('success')
    // Everything the DTO does not declare still arrives from the call, which is
    // what `callerEnv` names and where per-request data belongs.
    expect(overridden.supplied).toBe('through')
  })

  it('a class that never extended a DTO base is not projectable', () => {
    class Plain {
      static readonly fhirType = 'Observation'
      readonly fhirType = 'Observation'
    }
    expect(() => r4.project(weighed, Plain)).toThrow(
      "Plain is not a DTO class; extend engine.defineDto('<fhirType>') or engine.defineView('<fhirType>')"
    )
  })

  it('a DTO with no columns fails loudly', () => {
    class Empty extends r4.defineView('Observation') {
      note = 'not a column'
    }
    expect(() => r4.project(weighed, Empty)).toThrow(
      "DTO Empty declares no columns; add a field such as `id = this.column('id')`"
    )
  })

  it('a column must be the whole initializer of a public field', () => {
    class Hidden extends r4.defineView('Observation') {
      #status = this.column('status')

      code = this.column('code.text')

      get status(): string | undefined {
        return this.#status
      }
    }
    expect(() => dtoDefinition(Hidden)).toThrow(
      "DTO Hidden declares the column 'status' outside a public field; write each column as `name = this.column(...)`"
    )
    // The last column has no later one to catch it, so the end of construction does.
    class Wrapped extends r4.defineView('Observation') {
      code = this.column('code.text')

      pair = [this.criteria("status = 'final'")]
    }
    expect(() => dtoDefinition(Wrapped)).toThrow(
      "DTO Wrapped declares the column 'status = 'final'' outside a public field"
    )
  })

  it('keeps plain fields, and lets a subclass replace an inherited column', () => {
    class Base extends r4.defineView('Observation') {
      status = this.column('status')

      code = this.column('code.text')

      unit = 'kg'
    }
    class Derived extends Base {
      override code = this.column("code.text & ' (weight)'", { type: 'string' })

      // A plain value replaces the column: it is no longer projected. The
      // column's type is the status code union, so the value is one of them.
      override status = 'amended' as const
    }
    expect(Object.keys(dtoDefinition(Derived).columns)).toEqual(['code'])
    expect(r4.project(weighed, Derived)).toEqual(
      expect.objectContaining({ status: 'amended', code: 'Weight (weight)', unit: 'kg' })
    )
    // The base class keeps its own columns.
    expect(Object.keys(dtoDefinition(Base).columns)).toEqual(['status', 'code'])
  })

  it('a column cannot be named fhirType', () => {
    class Shadowing extends r4.defineView('Observation') {
      // @ts-expect-error -- every row already carries fhirType as an accessor
      fhirType = this.column('status')
    }
    expect(() => dtoDefinition(Shadowing as never)).toThrow(
      "DTO Shadowing declares a column named 'fhirType', which every row already carries"
    )
  })

  it("pick must name a field the table's rows carry", () => {
    const choices = [{ code: 'final', label: 'Final' }]
    class Typo extends r4.defineView('Observation') {
      // @ts-expect-error -- 'lable' is not a key of the table's rows
      label = this.column('status', { choices, pick: 'lable', default: '' })
    }
    expect(() => r4.project(weighed, Typo)).toThrow("column 'label' picks 'lable', which no row of its table has")
    class NoTable extends r4.defineView('Observation') {
      // @ts-expect-error -- pick without a table choices is rejected
      label = this.column('status', { pick: 'label' })
    }
    void NoTable
  })

  it('a fhirType outside the model is a compile error', () => {
    // @ts-expect-error -- not a model type name
    class Bad extends r4.defineView('Observationn') {
      id = this.column('id')
    }
    void Bad
  })
})

describe('base DTOs', () => {
  class ResourceDto extends r4.defineDto('Resource') {
    id = this.column('id', { required: true })

    lastUpdated = this.column('meta.lastUpdated')
  }
  const condition: Condition & { id: string } = {
    resourceType: 'Condition',
    id: 'c1',
    subject: {},
    code: { text: 'Hypertension' },
    meta: { lastUpdated: '2026-01-01T00:00:00Z' },
  }

  it('a subclass inherits the base columns and its input demands what the base requires', () => {
    class ConditionDto extends r4.defineDto('Condition', { base: ResourceDto }) {
      code = this.column('code.text')
    }
    const row = new ConditionDto()
    expectTypeOf(row.id).toExtend<string>()
    expectTypeOf(row.lastUpdated).toEqualTypeOf<string | undefined>()
    expectTypeOf(row.code).toEqualTypeOf<string | undefined>()
    expectTypeOf<DtoInput<typeof ConditionDto>>().toEqualTypeOf<
      { readonly resourceType: 'Condition' } & { readonly id: string }
    >()
    expect(Object.keys(dtoDefinition(ConditionDto).columns)).toEqual(['id', 'lastUpdated', 'code'])
    const projected = ConditionDto.from(condition)
    expect(projected).toEqual(
      expect.objectContaining({ id: 'c1', lastUpdated: '2026-01-01T00:00:00Z', code: 'Hypertension' })
    )
    // Inheritance is real: the subclass extends the base class.
    expect(projected).toBeInstanceOf(ResourceDto)
    expect(projected).toBeInstanceOf(ConditionDto)
    // @ts-expect-error -- id comes from the base and is required
    const rejected = ConditionDto.from({ resourceType: 'Condition' })
    expect(rejected).toEqual(expect.objectContaining({ id: undefined }))
    expect(analyzeDto(ConditionDto)).toEqual([])
  })

  it('a base on an ancestor root projects any resource of that root', () => {
    expectTypeOf<DtoInput<typeof ResourceDto>>().toEqualTypeOf<
      { readonly resourceType: keyof R4Resources } & { readonly id: string }
    >()
    const rows = ResourceDto.from([
      { resourceType: 'Patient', id: 'p1' },
      { resourceType: 'Observation', id: 'o1', status: 'final', code: {} },
    ])
    expect(rows.map(row => row.id)).toEqual(['p1', 'o1'])
    class DomainDto extends r4.defineDto('DomainResource') {
      narrative = this.column('text.status')
    }
    expectTypeOf<DtoInput<typeof DomainDto>>().toEqualTypeOf<{
      readonly resourceType: Exclude<keyof R4Resources, 'Binary' | 'Bundle' | 'Parameters'>
    }>()
    expect(DomainDto.from({ resourceType: 'Patient', text: { status: 'generated', div: '<div/>' } }).narrative).toBe(
      'generated'
    )
    // @ts-expect-error -- a Bundle is not a DomainResource
    expect(() => DomainDto.from([{ resourceType: 'Bundle', type: 'collection' }])).toThrow(
      "project(): row 0 is a Bundle, but DomainDto declares fhirType 'DomainResource'"
    )
  })

  it("the subclass inherits the base's env, vars, and callerEnv, and adds its own", () => {
    class Labelled extends r4.defineView('Resource', {
      env: { tag: 'base-tag' },
      callerEnv: { site: { type: 'string' } },
      vars: { key: 'id' },
    }) {
      tag = this.column('%tag')

      site = this.column('%site')

      key = this.column('%key', { type: 'string' })
    }
    class PatientRow extends r4.defineView('Patient', {
      base: Labelled,
      env: { label: 'patient' },
      callerEnv: ['unit'],
      vars: { suffix: "'!'" },
    }) {
      own = this.column('%label & %tag & %suffix')

      unit = this.column('%unit', { type: 'string' })
    }
    expect(dtoDefinition(PatientRow).env).toEqual({ tag: 'base-tag', label: 'patient' })
    expect(dtoDefinition(PatientRow).callerEnvNames).toEqual(['site', 'unit'])
    expect(dtoDefinition(PatientRow).callerEnvTypes).toEqual({ site: { type: 'string' } })
    expect(Object.keys(dtoDefinition(PatientRow).vars ?? {})).toEqual(['key', 'suffix'])
    // The subclass's columns are inferred in the merged context; the inherited
    // ones keep the types they were inferred with.
    expectTypeOf(new PatientRow().own).toEqualTypeOf<string | undefined>()
    expectTypeOf(new PatientRow().tag).toEqualTypeOf<string | undefined>()
    expectTypeOf(new PatientRow().site).toEqualTypeOf<string | undefined>()
    expect(PatientRow.from({ resourceType: 'Patient', id: 'p1' }, { env: { site: 'here', unit: 'kg' } })).toEqual(
      expect.objectContaining({ tag: 'base-tag', site: 'here', key: 'p1', own: 'patientbase-tag!', unit: 'kg' })
    )
    expect(analyzeDto(PatientRow)).toEqual([])
  })

  it('a subclass cannot rebind a name its base binds, since inherited columns were typed against it', () => {
    class Labelled extends r4.defineView('Resource', {
      env: { count: 1 },
      callerEnv: { site: { type: 'string' } },
      vars: { key: 'id' },
    }) {
      count = this.column('%count')

      site = this.column('%site')

      key = this.column('%key', { type: 'string' })
    }
    expectTypeOf(new Labelled().count).toEqualTypeOf<number | undefined>()
    // @ts-expect-error -- `count` is the base's env, typed number in its columns
    expect(() => r4.defineView('Patient', { base: Labelled, env: { count: 'text' } })).toThrow(
      "defineView('Patient'): 'count' is bound by the base's env, vars, or callerEnv; the inherited columns were typed against it, so a subclass cannot rebind it"
    )
    // @ts-expect-error -- `key` is the base's var
    expect(() => r4.defineView('Patient', { base: Labelled, vars: { key: 'name.family.first()' } })).toThrow(
      "defineView('Patient'): 'key' is bound by the base's env, vars, or callerEnv; the inherited columns were typed against it, so a subclass cannot rebind it"
    )
    // @ts-expect-error -- `site` is the base's caller environment
    expect(() => r4.defineView('Patient', { base: Labelled, callerEnv: { site: { type: 'integer' } } })).toThrow(
      "defineView('Patient'): 'site' is bound by the base's env, vars, or callerEnv; the inherited columns were typed against it, so a subclass cannot rebind it"
    )
    // A caller environment name is a binding too, whichever side declares it as one.
    // @ts-expect-error -- `count` is the base's env
    expect(() => r4.defineView('Patient', { base: Labelled, callerEnv: ['count'] })).toThrow(
      "defineView('Patient'): 'count' is bound by the base's env, vars, or callerEnv; the inherited columns were typed against it, so a subclass cannot rebind it"
    )
    // Either spelling names the same binding.
    // @ts-expect-error -- `%count` is `count`
    expect(() => r4.defineView('Patient', { base: Labelled, env: { '%count': 2 } })).toThrow(/'count' is bound/)
  })

  it('an inherited column is checked on the root it was written for', () => {
    class Dispatching extends r4.defineDto('Resource') {
      family = this.column('ofType(Patient).name.family.first()')

      id = this.column('id')
    }
    class ConditionDto extends r4.defineDto('Condition', { base: Dispatching }) {
      code = this.column('code.text')

      // A redeclared column is this class's own and is checked on its root.
      override id = this.column('id.first()')
    }
    expect(dtoDefinition(ConditionDto).columnRoots).toEqual({ family: 'Resource', id: 'Condition', code: 'Condition' })
    expect(analyzeDto(Dispatching)).toEqual([])
    expect(analyzeDto(ConditionDto)).toEqual([])
    // Written on the subclass itself, the same dispatch is always empty there.
    class Narrowed extends r4.defineDto('Condition', { base: Dispatching }) {
      override family = this.column('ofType(Patient).name.family.first()', { type: 'string' })
    }
    expect(analyzeDto(Narrowed).map(finding => [finding.member, finding.code])).toEqual([['family', 'always-empty']])
    // Two levels keep the root of the class that wrote the column.
    class Deeper extends r4.defineDto('Condition', { base: ConditionDto }) {
      severity = this.column('severity.text')
    }
    expect(dtoDefinition(Deeper).columnRoots).toEqual({
      family: 'Resource',
      id: 'Condition',
      code: 'Condition',
      severity: 'Condition',
    })
  })

  it('a redeclared column overrides the inherited one in place', () => {
    class Versioned extends r4.defineDto('Patient', { base: ResourceDto }) {
      override lastUpdated = this.column('meta.versionId')
    }
    const { columns } = dtoDefinition(Versioned)
    expect(Object.keys(columns)).toEqual(['id', 'lastUpdated'])
    expect(columns['lastUpdated']).toEqual({ path: 'meta.versionId' })
    expect(Versioned.from({ resourceType: 'Patient', id: 'p1', meta: { versionId: '7' } }).lastUpdated).toBe('7')
  })

  it('a DTO takes a DTO as base; a view takes a DTO or a view', () => {
    class ViewBase extends r4.defineView('Resource') {
      id = this.column('id', { default: '' })
    }
    // @ts-expect-error -- a view cannot be the base of a DTO
    expect(() => r4.defineDto('Patient', { base: ViewBase })).toThrow(
      "defineDto('Patient'): base ViewBase is a view; a DTO takes a DTO as base, a view takes a DTO or a view"
    )
    class FromDto extends r4.defineView('Patient', { base: ResourceDto }) {
      family = this.column('name.family.first()')
    }
    class FromView extends r4.defineView('Patient', { base: ViewBase }) {
      family = this.column('name.family.first()')
    }
    expect(Object.keys(dtoDefinition(FromDto).columns)).toEqual(['id', 'lastUpdated', 'family'])
    expect(Object.keys(dtoDefinition(FromView).columns)).toEqual(['id', 'family'])
    expectTypeOf(new FromView().id).toEqualTypeOf<string>()
  })

  it('the base root is the root itself or one of its model base types', () => {
    class ConditionBase extends r4.defineDto('Condition') {
      code = this.column('code.text')
    }
    // @ts-expect-error -- Condition is not a base type of Observation
    expect(() => r4.defineDto('Observation', { base: ConditionBase })).toThrow(
      "defineDto('Observation'): base ConditionBase is written for Condition, which is not a base type of Observation"
    )
    // The same type is plain composition.
    class Composed extends r4.defineDto('Condition', { base: ConditionBase }) {
      status = this.column('clinicalStatus.coding.first().code')
    }
    expect(Object.keys(dtoDefinition(Composed).columns)).toEqual(['code', 'status'])
    // Without a model nothing says what derives from what, so only the same root is allowed.
    const modelless = new FhirPathEngine()
    class Loose extends modelless.defineView('Resource') {
      id = this.column('id')
    }
    expect(() => modelless.defineView('Patient', { base: Loose })).toThrow(
      "defineView('Patient'): base Loose is written for Resource; without a model only a base of the same type is allowed"
    )
    expect(() => modelless.defineView('Resource', { base: Loose })).not.toThrow()
    class Plain {
      readonly fhirType = 'Patient'
    }
    // @ts-expect-error -- not a class from defineDto() or defineView()
    expect(() => r4.defineDto('Patient', { base: Plain })).toThrow(
      "defineDto('Patient'): base Plain is not a class from defineDto() or defineView()"
    )
  })

  it('the base was defined on this engine or one it derives from', () => {
    const other = new FhirPathEngine({ model: r4Model })
    expect(() => other.defineDto('Patient', { base: ResourceDto })).toThrow(
      "defineDto('Patient'): base ResourceDto was defined on another engine; define the class on that engine or one derived from it"
    )
    class ConceptDto extends r4.defineDto('CodeableConcept') {
      label = this.column('(text | coding.display.first()).first()')
    }
    const derived = r4.register(ConceptDto)
    class OnDerived extends derived.defineDto('Patient', { base: ResourceDto }) {
      family = this.column('name.family.first()')
    }
    expect(derived.project({ resourceType: 'Patient', id: 'p1' }, OnDerived).id).toBe('p1')
    expect(OnDerived.from({ resourceType: 'Patient', id: 'p1' }).id).toBe('p1')
    // On an engine that registers the base, a DTO subclass's inherited column
    // would be declared for both roots, so the base stays unregistered and the
    // subclasses are what an engine registers.
    const withBase = r4.register(ResourceDto)
    class Clashing extends withBase.defineDto('Patient', { base: ResourceDto }) {
      family = this.column('name.family.first()')
    }
    expect(() => Clashing.from({ resourceType: 'Patient', id: 'p1' })).toThrow(
      "DTO Clashing redefines the function 'id': a focus can be both FHIR.Resource and FHIR.Patient"
    )
  })

  it('an inherited column registers for the subclass root, so base and subclass cannot share an engine', () => {
    class ConditionDto extends r4.defineDto('Condition', { base: ResourceDto }) {
      code = this.column('code.text')
    }
    expect(() => r4.register(ResourceDto, ConditionDto)).toThrow(/DTO ConditionDto redefines the function 'id'/)
    const fp = r4.register(ConditionDto)
    expectTypeOf(fp.evaluate('Condition.id()', condition)).toEqualTypeOf<string[]>()
    expect(fp.evaluate('id() | lastUpdated()', condition)).toEqual(['c1', '2026-01-01T00:00:00Z'])
    expect(() => fp.evaluate('id()', { resourceType: 'Patient', id: 'p1' })).toThrow(/expects FHIR.Condition/)
  })
})

describe('engines, registration, and typed column calls', () => {
  const condition: Condition = {
    resourceType: 'Condition',
    subject: { reference: 'Patient/p1' },
    code: { coding: [{ code: 'I10', display: 'Hypertension' }] },
    clinicalStatus: { coding: [{ code: 'active' }] },
  }
  class ConceptDto extends r4.defineDto('CodeableConcept') {
    displayText = this.column('(text | coding.display.first() | coding.first().code).first()')
  }
  class CodingDto extends r4.defineDto('Coding') {
    displayText = this.column('code', { collection: true })
  }

  it('register() returns a new engine and leaves the one it was called on alone', () => {
    const fp = r4.register(ConceptDto)
    expect(fp).not.toBe(r4)
    expect(fp.dtos).toEqual([ConceptDto])
    expect(r4.dtos).toEqual([])
    expect(fp.evaluate('Condition.code.displayText()', condition)).toEqual(['Hypertension'])
    expect(() => r4.evaluate('Condition.code.displayText()', condition)).toThrow(/displayText/)
    // Registering again derives again, keeping what the parent registered.
    expect(fp.register(CodingDto).dtos).toEqual([ConceptDto, CodingDto])
  })

  it('types a call to a registered column, from any expression and from later DTOs', () => {
    const fp = r4.register(ConceptDto, CodingDto)
    expectTypeOf(fp.first('Condition.code.displayText()', condition)).toEqualTypeOf<string | undefined>()
    expectTypeOf(fp.evaluate('Condition.code.displayText().length()', condition)).toEqualTypeOf<number[]>()
    // The focus picks the declaration, as at runtime.
    expectTypeOf(fp.evaluate('Condition.code.coding.displayText()', condition)).toEqualTypeOf<string[]>()
    expect(fp.evaluate('Condition.code.coding.displayText()', condition)).toEqual(['I10'])
    // A focus neither declaration accepts proves nothing, so it stays opaque; the runtime refuses it.
    const wrongFocus = () => fp.evaluate('Condition.subject.displayText()', condition)
    expectTypeOf(wrongFocus).returns.toEqualTypeOf<unknown[]>()
    expect(wrongFocus).toThrow("Function 'displayText' expects FHIR.CodeableConcept | FHIR.Coding as input")
    class ProblemRow extends fp.defineView('Condition') {
      name = this.column('code.displayText()', { default: 'Condition' })
    }
    expectTypeOf(new ProblemRow().name).toEqualTypeOf<string>()
    expect(fp.project(condition, ProblemRow).name).toBe('Hypertension')
  })

  it('reads a registered string result as every FHIR type a string can be', () => {
    class StatusDto extends r4.defineDto('Condition') {
      statusCode = this.column('clinicalStatus.coding.first().code')
    }
    const fp = r4.register(StatusDto)
    // The runtime value is a FHIR code. Naming one string type would make this
    // ofType() infer empty while the runtime returns the code.
    expectTypeOf(fp.evaluate('Condition.statusCode().ofType(code)', condition)).toEqualTypeOf<string[]>()
    expect(fp.evaluate('Condition.statusCode().ofType(code)', condition)).toEqual(['active'])
  })

  it('leaves a registered column opaque when no FHIR type holds its value', () => {
    class TableDto extends r4.defineDto('Observation', { env: { tones: [{ code: 'final', tone: 'success' }] } }) {
      tone = this.column('%tones.first()')
    }
    const fp = r4.register(TableDto)
    expectTypeOf(new TableDto().tone).toEqualTypeOf<unknown>()
    expectTypeOf(fp.evaluate('Observation.tone()', weighed)).toEqualTypeOf<unknown[]>()
    // A field whose value, or one member of it, no FHIR type represents
    // declares no result: dropping that member would narrow the call. The
    // shape must be one no FHIR type has: `{ label: string }` alone is
    // ElementDefinition.example.
    type Synthetic = (new () => DtoBase<'Observation', object, 'dto'> & {
      badge: { badgeLabel: string } | undefined
      mixed: string | { badgeLabel: string }
      codes: string[]
    }) & { readonly fhirType: 'Observation' }
    type Opaque = {
      readonly expression: string
      readonly signature: { readonly input: { readonly types: readonly ['Observation'] } }
    }
    expectTypeOf<DtoFunctions<[Synthetic]>['badge']>().toEqualTypeOf<Opaque>()
    expectTypeOf<DtoFunctions<[Synthetic]>['mixed']>().toEqualTypeOf<Opaque>()
    expectTypeOf<DtoFunctions<[Synthetic]>['codes']>().not.toEqualTypeOf<Opaque>()
  })

  it('columns see the engine env and typed host functions', () => {
    const configured = new FhirPathEngine({
      model: r4Model,
      env: { loinc: 'http://loinc.org' },
      functions: {
        shout: { expression: 'upper()', signature: { result: { types: ['string'], single: true } } },
      },
    })
    class CodedRow extends configured.defineView('Observation') {
      system = this.column('code.coding.where(system = %loinc).system.first()')
      loud = this.column('status.shout()')
    }
    expectTypeOf(new CodedRow().system).toEqualTypeOf<string | undefined>()
    expectTypeOf(new CodedRow().loud).toEqualTypeOf<string | undefined>()
    expect(configured.project(weighed, CodedRow)).toMatchObject({ system: undefined, loud: 'FINAL' })
    // A projection cannot supply a name the engine already binds.
    expect(() => configured.defineView('Observation', { callerEnv: ['loinc'] })).toThrow(
      "defineView('Observation'): callerEnv names 'loinc', which the engine's env binds; a column always reads the engine's value"
    )
  })

  it('registers only DTOs of this engine or one it derives from', () => {
    const other = new FhirPathEngine({ model: r4Model })
    class Foreign extends other.defineDto('Patient') {
      family = this.column('name.family.first()')
    }
    expect(() => r4.register(Foreign)).toThrow(
      'Foreign was defined on another engine; register it on the engine whose defineDto() created it, or on one derived from that engine'
    )
    // A DTO defined on an ancestor registers on any engine derived from it.
    const derived = other.register(Foreign)
    class Later extends other.defineDto('Condition') {
      recorded = this.column('recordedDate')
    }
    expect(derived.register(Later).dtos).toEqual([Foreign, Later])
  })

  it('registers only classes that are columns and methods', () => {
    class Shown extends r4.defineView('Patient') {
      family = this.column('name.family.first()')
    }
    // @ts-expect-error -- a view is projected, never registered
    expect(() => r4.register(Shown)).toThrow('Shown is a view; only classes from engine.defineDto() can be registered')
    class WithGetter extends r4.defineDto('Patient') {
      family = this.column('name.family.first()')

      get label(): string {
        return this.family ?? ''
      }
    }
    expect(() => r4.register(WithGetter)).toThrow(
      "DTO WithGetter has an accessor 'label'; a registered DTO holds only columns and methods, so move it to a view"
    )
    class WithField extends r4.defineDto('Patient') {
      family = this.column('name.family.first()')

      cache = new Map<string, string>()
    }
    expect(() => r4.register(WithField)).toThrow(
      "DTO WithField has a field 'cache' that is not a column; a registered DTO holds only columns and methods"
    )
    class WithMethod extends r4.defineDto('Patient') {
      family = this.column('name.family.first()')

      label(): string {
        return this.family ?? ''
      }
    }
    // Methods are not fields, so the types never read them as columns.
    const fp = r4.register(WithMethod)
    expectTypeOf(fp.evaluate('Patient.family()', { resourceType: 'Patient' as const })).toEqualTypeOf<string[]>()
    const method = () => fp.evaluate('Patient.label()', { resourceType: 'Patient' as const })
    expectTypeOf(method).returns.toEqualTypeOf<unknown[]>()
    expect(method).toThrow("Unrecognized function 'label'")
  })

  it('keeps value conversions in views, since a registered column returns its expression result', () => {
    class Converted extends r4.defineDto('Observation') {
      // @ts-expect-error -- a registered column takes no `as`
      at = this.column('issued', { as: 'Date' })
    }
    expect(() => dtoDefinition(Converted)).toThrow(
      "DTO Converted column 'at' converts its value with 'as' or 'choices'; a registered column returns its expression result, so convert values in a view"
    )
    class Shown extends r4.defineView('Observation') {
      at = this.column('issued', { as: 'Date' })
    }
    expectTypeOf(new Shown().at).toEqualTypeOf<Date | undefined>()
  })

  it('analyzes a DTO against its own engine, with its own columns callable', () => {
    class ReportDto extends r4.defineDto('DiagnosticReport') {
      conclusionText = this.column('conclusion')

      // A column of the same class: TypeScript cannot type the call, so it declares one.
      loud = this.column('conclusionText().upper()', { type: 'string' })
    }
    expectTypeOf(new ReportDto().loud).toEqualTypeOf<string | undefined>()
    expect(analyzeDto(ReportDto)).toEqual([])
    class Misspelled extends r4.defineDto('DiagnosticReport') {
      loud = this.column('conclusionTxt().upper()', { type: 'string' })
    }
    expect(analyzeDto(Misspelled).map(finding => finding.code)).toEqual(['unknown-function'])
    // A column name the engine already uses cannot join its functions: the
    // analysis reports the same error register() would.
    const hosted = new FhirPathEngine({ model: r4Model, functions: { conclusionText: { fn: () => 'x' } } })
    class Clashing extends hosted.defineDto('DiagnosticReport') {
      conclusionText = this.column('conclusionn')
    }
    expect(() => hosted.register(Clashing)).toThrow("DTO Clashing redefines the function 'conclusionText'")
    expect(() => analyzeDto(Clashing)).toThrow("DTO Clashing redefines the function 'conclusionText'")
    // A column calling a DTO registered in the same call: its defining engine
    // does not have that function, and neither entry point pretends it does.
    class Concepts extends r4.defineDto('CodeableConcept') {
      displayText = this.column('text')
    }
    class Conditions extends r4.defineDto('Condition') {
      name = this.column('code.displayText()', { type: 'string' })
    }
    const both = r4.register(Concepts, Conditions)
    expect(analyzeDto(Conditions).map(finding => finding.code)).toEqual(['unknown-function'])
    expect(analyzeEngineDtos(both).map(finding => [finding.dto, finding.code])).toEqual([
      ['Conditions', 'unknown-function'],
    ])
  })
})

describe('DTOs registered engine-wide', () => {
  class CodeableConceptFns extends r4.defineDto('CodeableConcept') {
    displayText = this.column('(text | coding.display.first() | coding.first().code).first()')
  }
  const condition: Condition = {
    resourceType: 'Condition',
    subject: { reference: 'Patient/p1' },
    code: { coding: [{ code: 'I10', display: 'Hypertension' }] },
  }

  it('every column becomes a callable function', () => {
    const engine = r4.register(CodeableConceptFns)
    expect(engine.evaluate('Condition.code.displayText()', condition)).toEqual(['Hypertension'])
  })

  it('a column knows the type it was written against, and says so on the wrong focus', () => {
    const engine = r4.register(CodeableConceptFns)
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
    const engine = r4.register(CodeableConceptFns)
    // An empty focus is the spec's own propagation, not a mistake.
    expect(engine.evaluate('Condition.code.text.nothing.displayText()', condition)).toEqual([])
    // The rest run: a value bound as plain env data and a datatype root both
    // carry the Object placeholder, which no model describes.
    expect(engine.evaluate('%loose.displayText()', condition, { env: { loose: { text: 'Hypertension' } } })).toEqual([
      'Hypertension',
    ])
    expect(engine.evaluate('displayText()', condition.code)).toEqual(['Hypertension'])
    // The remaining case, no model at all, cannot happen here. Registering a
    // DTO without a model is refused at construction (see the test above).
  })

  it('derives the analyzer signature from the column type', () => {
    class Typed extends r4.defineDto('CodeableConcept') {
      displayText = this.column('(text | coding.display.first()).first()', { type: 'string' })
    }
    const engine = r4.register(Typed)
    const diagnostics = analyzeExpression('maritalStatus.displayText().length()', {
      model: r4Model,
      inputType: 'Patient',
      functions: engine.defaults.functions ?? {},
    })
    expect(diagnostics).toEqual([])
  })

  it('a registered column reads its DTO env, and no other expression can', () => {
    class Badges extends r4.defineDto('Observation', { env: { badgeTones: [{ code: 'final', tone: 'success' }] } }) {
      badgeTone = this.column('%badgeTones.where(code = %context.status).tone', { type: 'string' })
    }
    const engine = r4.register(Badges)
    expect(engine.evaluate('badgeTone()', weighed)).toEqual(['success'])
    // Registering adds the function name and nothing else: the table stays the
    // DTO's, so an expression that did not go through a column cannot read it.
    expect(() => engine.evaluate('%badgeTones.count()', weighed)).toThrow('Undefined environment variable %badgeTones')
    // Which is also what the static side is told, since it reads the same
    // engine env — the name is not silently declared to every expression.
    expect(engine.defaults.env).toBeUndefined()
    const sited = new FhirPathEngine({ model: r4Model, env: { site: 'a' } })
    class SitedBadges extends sited.defineDto('Observation', { env: { badgeTones: [] } }) {
      badgeTone = this.column('%badgeTones.first()', { type: 'string' })
    }
    expect(sited.register(SitedBadges).defaults.env).toEqual({ site: 'a' })
  })

  it('a criteria means the same thing as a column and as a call', () => {
    class Flags extends r4.defineDto('Observation') {
      isFinal = this.criteria("status = 'final'")
    }
    const engine = r4.register(Flags)
    expect(engine.project(weighed, Flags).isFinal).toBe(true)
    expect(engine.evaluate('isFinal()', weighed)).toEqual([true])
    // The criteria rule travels with the function, so both readings agree on a
    // resource where the criteria finds nothing. The call also chains as a
    // boolean instead of returning empty.
    const statusless: Observation = { resourceType: 'Observation', code: { text: 'Weight' } } as Observation
    expect(engine.project(statusless, Flags).isFinal).toBe(false)
    expect(engine.evaluate('isFinal()', statusless)).toEqual([false])
    expect(engine.evaluate('isFinal().not()', statusless)).toEqual([true])
    // And it reads as a criteria wherever criteria are read.
    expect(engine.filter([weighed, statusless], 'isFinal()')).toEqual([weighed])
    expect(engine.test(statusless, 'isFinal()')).toBe(false)
  })

  it('a criteria carries its column signature and its host type', () => {
    class Flags extends r4.defineDto('Observation') {
      isFinal = this.criteria("status = 'final'")
    }
    const engine = r4.register(Flags)
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
    class Many extends r4.defineDto('Patient') {
      hasGiven = this.criteria('name.given')
    }
    const engine = r4.register(Many)
    const patient: Patient = { resourceType: 'Patient', name: [{ given: ['Peter', 'James'] }] }
    const message = 'Expected a collection with at most one item, but found 2'
    expect(() => engine.project(patient, Many)).toThrow(message)
    expect(() => engine.evaluate('hasGiven()', patient)).toThrow(message)
  })

  it('rejects a column whose name is a built-in function, naming the field', () => {
    class Shadow extends r4.defineDto('Observation') {
      exists = this.column('code.text', { type: 'string' })
    }
    expect(() => r4.register(Shadow)).toThrow(
      "DTO Shadow declares a column named 'exists', which is a built-in function; rename the field"
    )
  })

  it('two DTOs may declare one column name, and the focus picks between them', () => {
    class CodingFns extends r4.defineDto('Coding') {
      displayText = this.column('code', { type: 'string' })
    }
    const engine = r4.register(CodeableConceptFns, CodingFns)
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
    class Concept extends r4.defineDto('CodeableConcept') {
      label = this.column('text', { type: 'string' })
    }
    // A SimpleQuantity is a Quantity, so a focus could satisfy both columns and
    // the engine would have to guess.
    class Quantities extends r4.defineDto('Quantity') {
      label = this.column('unit', { type: 'string' })
    }
    class Simple extends r4.defineDto('SimpleQuantity') {
      label = this.column('code', { type: 'string' })
    }
    expect(() => r4.register(Quantities, Simple)).toThrow(
      "DTO Simple redefines the function 'label': a focus can be both FHIR.Quantity and FHIR.SimpleQuantity"
    )
    // A host function accepts any focus, so nothing may share its name.
    const hosted = new FhirPathEngine({ model: r4Model, functions: { label: { fn: () => 'x' } } })
    class HostedConcept extends hosted.defineDto('CodeableConcept') {
      label = this.column('text', { type: 'string' })
    }
    expect(() => hosted.register(HostedConcept)).toThrow(
      "DTO HostedConcept redefines the function 'label': a declaration that names no input type answers every call, so nothing else may share its name"
    )
    void Concept
  })

  it('two DTOs may declare one env name with different values; each column reads its own', () => {
    // The case a shared engine namespace could not express: the two disagree
    // about %system on purpose, and neither is asked to yield.
    class Labs extends r4.defineDto('Patient', { env: { system: 'http://loinc.org' } }) {
      system = this.column('%system', { type: 'string', default: '' })
    }
    class Problems extends r4.defineDto('Practitioner', { env: { system: 'http://snomed.info/sct' } }) {
      problemSystem = this.column('%system', { type: 'string', default: '' })
    }
    const engine = r4.register(Labs, Problems)
    expect(engine.evaluate('system()', { resourceType: 'Patient' })).toEqual(['http://loinc.org'])
    expect(engine.evaluate('problemSystem()', { resourceType: 'Practitioner' })).toEqual(['http://snomed.info/sct'])
    // And projecting either one gives the same answer its column gives.
    expect(engine.project({ resourceType: 'Patient' }, Labs).system).toBe('http://loinc.org')
    expect(engine.project({ resourceType: 'Practitioner' }, Problems).problemSystem).toBe('http://snomed.info/sct')
  })

  it('registering needs a model, since a model is what makes a column answer one type', () => {
    class Concept extends r4.defineDto('CodeableConcept') {
      displayText = this.column('(text | coding.display.first()).first()', { type: 'string', default: '' })
    }
    const modelless = new FhirPathEngine({})
    class LooseConcept extends modelless.defineDto('CodeableConcept') {
      displayText = this.column('(text | coding.display.first()).first()', { type: 'string', default: '' })
    }
    expect(() => modelless.register(LooseConcept)).toThrow(
      'Registering DTOs (LooseConcept) needs a model; a column is written for one type, and without a model the ' +
        'engine cannot check a call against it. Pass model to the engine, or project the DTO without registering it.'
    )
    // This is what the refusal protects. With a model, a call on a focus that
    // can never hold the column's type is an error instead of an answer.
    const engine = r4.register(Concept)
    expect(() => engine.evaluate('displayText()', { resourceType: 'Patient' })).toThrow(
      "Function 'displayText' expects FHIR.CodeableConcept as input, but the focus is FHIR.Patient"
    )
    // Projecting still works without either. A DTO nobody calls into needs no
    // registration and no model.
    expect(modelless.project({ text: 'Weight' }, LooseConcept).displayText).toBe('Weight')
    // A column sharing a name with an engine function is an overload only the
    // model can tell apart, so without one even projecting refuses it.
    const hosted = new FhirPathEngine({ functions: { displayText: { fn: () => 'x' } } })
    class Shadowing extends hosted.defineDto('CodeableConcept') {
      displayText = this.column('text')
    }
    expect(() => hosted.project({ text: 'Weight' }, Shadowing)).toThrow(
      "DTO Shadowing redefines the function 'displayText': telling same-name functions apart by focus type needs a model"
    )
  })

  it('several DTOs may register per fhirType; only a shared column name is a conflict', () => {
    // Distinct row shapes for one resource are ordinary — a weight row and a
    // blood-pressure row are both Observations.
    class Weights extends r4.defineDto('Observation') {
      kg = this.column("value.ofType(Quantity).toQuantity('kg').value", { type: 'decimal' })
    }
    class Panels extends r4.defineDto('Observation') {
      partCount = this.column('component.count()', { type: 'integer' })
    }
    const engine = r4.register(Weights, Panels)
    expect(engine.evaluate('kg()', weighed)).toEqual([80])
    expect(engine.evaluate('partCount()', weighed)).toEqual([0])

    class AlsoWeights extends r4.defineDto('Observation') {
      kg = this.column('valueQuantity.value', { type: 'decimal' })
    }
    expect(() => r4.register(Weights, AlsoWeights)).toThrow(
      "DTO AlsoWeights redefines the function 'kg': both are written for FHIR.Observation"
    )
  })
})

describe('analyzeDto', () => {
  it('checks every column and var against the fhirType, tagged by member', () => {
    class Weight extends r4.defineView('Observation') {
      kg = this.column("valu.ofType(Quantity).toQuantity('kg').value", { type: 'decimal', default: 0 })

      isFinal = this.criteria("staus = 'final'")
    }
    const findings = analyzeDto(Weight, { model: r4Model })
    expect(findings.map(f => [f.member, f.code])).toEqual([
      ['kg', 'unknown-element'],
      ['isFinal', 'unknown-element'],
    ])
  })

  it('cross-checks a declared column type against what the expression yields', () => {
    class Mistyped extends r4.defineView('Observation') {
      // The expression is a String; the column claims a number.
      value = this.column('code.text', { type: 'decimal', default: 0 })

      // An equivalent spelling is not a finding: code and System.String agree.
      status = this.column('status', { type: 'code' })

      // enum implies String, and status is one.
      known = this.column('status', { enum: ['final', 'amended'] })

      // A complex type from the wrong branch of the hierarchy.
      quantity = this.column('value.ofType(Quantity)', { type: 'CodeableConcept' })
    }
    expect(analyzeDto(Mistyped, { model: r4Model }).map(f => [f.member, f.code, f.message])).toEqual([
      ['value', 'column-type', "Column declares type 'decimal', but the expression yields FHIR.string"],
      ['quantity', 'column-type', "Column declares type 'CodeableConcept', but the expression yields FHIR.Quantity"],
    ])
  })

  it('leaves a column alone when the analyzer cannot see the result type', () => {
    class Opaque extends r4.defineView('Observation') {
      // resolve() lands in an unknown region: nothing to contradict.
      subjectId = this.column('subject.resolve().id', { type: 'string' })

      // as/choices reshape the value outside FHIRPath, so `type` claims nothing.
      shaped = this.column('status', { as: () => 42, type: 'string', default: 0 })
    }
    expect(analyzeDto(Opaque, { model: r4Model })).toEqual([])
  })

  it('declares DTO env, %rowIndex/%rowTotal, and vars in order; per-call names come via options', () => {
    class OrderRow extends r4.defineView('ServiceRequest', {
      env: { waitingBadge: { label: 'Waiting' } },
      vars: {
        report: '%reports.where(orderId = %context.id).report',
        badge: 'iif(%report.exists(), %report, %waitingBadge)',
      },
    }) {
      id = this.column('(id | %rowIndex.toString()).first()', { type: 'string', default: '' })

      label = this.column('%badge.label', { type: 'string', default: '' })
    }
    // %reports is per-call env the DTO cannot know — undeclared, it is the only finding.
    expect(analyzeDto(OrderRow, { model: r4Model }).map(f => [f.member, f.code])).toEqual([
      ['vars.report', 'unknown-variable'],
    ])
    expect(analyzeDto(OrderRow, { model: r4Model, variables: { reports: {} } })).toEqual([])
  })

  it('checks DTO env and vars over same-name engine and caller variables, as projection binds them', () => {
    const engine = new FhirPathEngine({
      model: r4Model,
      env: { label: 5 },
      vars: { report: "'engine'" },
      varTypes: { report: { type: 'string' } },
    })
    class OrderRow extends engine.defineView('ServiceRequest', {
      env: { label: 'Order' },
      callerEnv: { reports: { type: 'DiagnosticReport', collection: true } },
      vars: { report: '%reports.first()' },
    }) {
      status = this.column('%report.status', { type: 'code' })

      label = this.column('%label.upper()', { type: 'string' })
    }
    const reports = [{ resourceType: 'DiagnosticReport', status: 'final' }]
    expect(engine.project([{ resourceType: 'ServiceRequest', id: 'sr1' }], OrderRow, { env: { reports } })).toEqual([
      expect.objectContaining({ status: 'final', label: 'ORDER' }),
    ])
    expect(analyzeDto(OrderRow)).toEqual([])
    expect(analyzeDto(OrderRow, { variables: { report: { types: ['System.Integer'], single: true } } })).toEqual([])
  })

  it('propagates typed caller environment through DTO vars into columns', () => {
    class VisitNoteRow extends r4.defineView('ClinicalImpression', {
      callerEnv: { carePlans: { type: 'CarePlan', collection: true } },
      vars: { visitPlans: '%carePlans.where(encounter.reference = %context.encounter.reference)' },
    }) {
      focusItems = this.column('%visitPlans.activityz.detail.description', { collection: true, type: 'string' })
    }

    expect(analyzeDto(VisitNoteRow, { model: r4Model }).map(finding => [finding.member, finding.code])).toEqual([
      ['focusItems', 'unknown-element'],
    ])
  })

  it('normalizes caller environment declarations in DTO definitions', () => {
    class Named extends r4.defineView('Observation', { callerEnv: ['reports'] }) {
      status = this.column('status')
    }
    class Typed extends r4.defineDto('Observation', {
      callerEnv: { reports: { type: 'DiagnosticReport', collection: true } },
    }) {
      status = this.column('status')
    }

    expect(dtoDefinition(Named)).toMatchObject({
      callerEnvNames: ['reports'],
      callerEnvTypes: undefined,
    })
    expect(dtoDefinition(Typed)).toMatchObject({
      callerEnvNames: ['reports'],
      callerEnvTypes: { reports: { type: 'DiagnosticReport', collection: true } },
    })
  })

  it('analyzes a compiled var by its source, and only declares a pre-bound one', () => {
    class Bound extends r4.defineView('Observation', {
      vars: {
        // A compiled expression carries its source, so it analyzes like a string one.
        compiled: compile('code.txt'),
        // A pre-bound value has no expression to analyze; it is only declared.
        fixed: [{ type: 'System.String', value: 'ok' }],
      },
    }) {
      text = this.column('%compiled', { type: 'string', default: '' })

      bound = this.column('%fixed', { type: 'string', default: '' })
    }
    expect(analyzeDto(Bound, { model: r4Model }).map(f => [f.member, f.code])).toEqual([
      ['vars.compiled', 'unknown-element'],
    ])
  })

  it('takes model, functions and env names from the engine it is given', () => {
    class ConceptFns extends r4.defineDto('CodeableConcept') {
      displayText = this.column('(text | coding.display.first()).first()', { type: 'string' })
    }
    class Named extends r4.defineView('Condition', {
      env: { fallback: 'Condition' },
      // The join table arrives per call, so the DTO declares only the name.
      callerEnv: ['reports'],
      vars: { report: '%reports.where(id = %context.id).first()' },
    }) {
      name = this.column('(code.displayText() | %fallback).first()', { type: 'string', default: '' })

      reportStatus = this.column('%report.status', { type: 'string', default: '' })
    }
    const engine = r4.register(ConceptFns)
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
    class Broken extends r4.defineDto('Observation') {
      status = this.column('statuss', { type: 'string', default: '' })
    }
    const engine = r4.register(Broken)
    expect(analyzeEngineDtos(engine).map(f => [f.dto, f.member, f.expression, f.code])).toEqual([
      ['Broken', 'status', 'statuss', 'unknown-element'],
    ])
  })

  it('keeps the engine context when the caller adds functions or variables of its own', () => {
    // A host declaring one function of its own must not displace the engine's
    // table: `functions` merges per name, like `variables` does, or a perfectly
    // valid column call would come back as unresolved.
    class ConceptFns extends r4.defineDto('CodeableConcept') {
      displayText = this.column('(text | coding.display.first()).first()', { type: 'string' })
    }
    class Named extends r4.defineView('Condition', { env: { fallback: 'Condition' } }) {
      name = this.column('(code.displayText() | %fallback | %hostVar).first()', { type: 'string', default: '' })

      fromHost = this.column('hostFn()', { type: 'string', default: '' })
    }
    const engine = r4.register(ConceptFns)
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

  it('infers engine environment types across leading-percent spellings', () => {
    class Named extends r4.defineView('Condition') {
      invalid = this.criteria('%report.status + 1')
    }
    const engine = new FhirPathEngine({
      model: r4Model,
      env: { '%report': { resourceType: 'DiagnosticReport' as const, status: 'final' as const } },
    })

    expect(analyzeDto(Named, { engine }).map(finding => finding.code)).toEqual(['operand-type'])
  })

  it('keeps custom engine resources opaque so analysis matches raw JSON navigation', () => {
    class Named extends r4.defineView('Condition') {
      foo = this.column('%custom.foo', { type: 'string', default: '' })
    }
    const custom = { resourceType: 'CustomThing', foo: 'ok' }
    const engine = new FhirPathEngine({ model: r4Model, env: { custom } })

    expect(engine.evaluate('%custom.foo')).toEqual(['ok'])
    expect(analyzeDto(Named, { engine })).toEqual([])
  })

  it('resolves engine functions passed through options', () => {
    class Named extends r4.defineView('Condition') {
      name = this.column('code.displayText()', { type: 'string', default: '' })
    }
    class ConceptFns extends r4.defineDto('CodeableConcept') {
      displayText = this.column('(text | coding.display.first() | coding.first().code).first()')
    }
    const engine = r4.register(ConceptFns)
    expect(analyzeDto(Named, { model: r4Model }).map(f => f.code)).toEqual(['unknown-function'])
    expect(analyzeDto(Named, { model: r4Model, functions: engine.defaults.functions ?? {} })).toEqual([])
  })

  it('flags a type-name root on a datatype fhirType, where the runtime navigates to empty', () => {
    // Prefixing paths with the type name still works on a resource DTO; on a
    // datatype DTO the runtime has no resourceType to match, so the column
    // would be empty.
    class Prefixed extends r4.defineView('CodeableConcept') {
      displayText = this.column('CodeableConcept.text', { type: 'string' })
    }
    class Relative extends r4.defineView('CodeableConcept') {
      displayText = this.column('(text | coding.display.first() | coding.first().code).first()')
    }
    expect(analyzeDto(Prefixed, { model: r4Model }).map(f => [f.member, f.code])).toEqual([
      ['displayText', 'datatype-root'],
    ])
    expect(analyzeDto(Relative, { model: r4Model })).toEqual([])
  })
})
