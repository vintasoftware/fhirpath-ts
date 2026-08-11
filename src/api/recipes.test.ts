import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { analyzeExpression } from '../analyzer/analyze.ts'
import { column, criteria, defineDto, FhirPathEngine } from '../index.ts'
import type {
  Bundle,
  Condition,
  DiagnosticReport,
  MedicationRequest,
  Observation,
  Patient,
  Questionnaire,
  ServiceRequest,
} from '../r4/generated/type-maps.ts'
import { r4, r4Model } from '../r4/index.ts'
import { createSiteFinder } from '../sites/index.ts'

/**
 * Every snippet in the README's "Usage recipes" section, exercised against the
 * engine. The enforcement suite at the bottom reads the section back: each
 * expression string it can extract must be one this file runs, and must pass
 * the static analyzer clean — so the README and these tests cannot drift apart.
 */

const LOINC = 'http://loinc.org'

const systolicReadings: Observation[] = [
  {
    resourceType: 'Observation',
    status: 'final',
    code: { coding: [{ system: LOINC, code: '8480-6' }] },
    valueQuantity: { value: 150, unit: 'mmHg', code: 'mm[Hg]' },
    effectiveDateTime: '2026-03-01',
  },
  {
    resourceType: 'Observation',
    status: 'final',
    code: { coding: [{ system: LOINC, code: '8480-6' }] },
    valueQuantity: { value: 120, unit: 'mmHg', code: 'mm[Hg]' },
    effectiveDateTime: '2026-01-01',
  },
  {
    resourceType: 'Observation',
    status: 'final',
    code: { coding: [{ system: LOINC, code: '8480-6' }] },
    valueQuantity: { value: 135, unit: 'mmHg', code: 'mm[Hg]' },
    issued: '2026-02-01T00:00:00Z',
  },
]

describe('README usage recipes', () => {
  it('display text with fallbacks', () => {
    const condition: Condition = {
      resourceType: 'Condition',
      subject: { reference: 'Patient/p1' },
      code: { coding: [{ code: 'I10', display: 'Hypertension' }] },
    }
    expect(
      r4.first('Condition.code.select(text | coding.display.first() | coding.first().code).first()', condition)
    ).toBe('Hypertension')

    const patient: Patient = {
      resourceType: 'Patient',
      active: true,
      name: [
        { use: 'nickname', given: ['Molly'] },
        { use: 'official', given: ['Mary', 'Ann'], family: 'Miller' },
      ],
    }
    expect(
      r4.first(
        "(Patient.name.where(use = 'official') | Patient.name).first().select(iif(given.exists(), given.first().combine(family).join(' '), (text | family).first()))",
        patient
      )
    ).toBe('Mary Miller')
    expect(r4.evaluate('Patient.name.given', patient)).toEqual(['Molly', 'Mary', 'Ann'])
    expect(r4.first('Patient.name.family', patient)).toBe('Miller')
    expect(r4.test(patient, 'Patient.active = true')).toBe(true)
    expect(r4.evaluate('%threshold + 1', patient, { env: { threshold: 5 } })).toEqual([6])

    // The fallback chain named once, as an expression-defined function.
    const fp = new FhirPathEngine({
      model: r4Model,
      functions: { displayText: { expression: '(text | coding.display.first() | coding.first().code).first()' } },
    })
    const display = fp.first('Condition.code.displayText()', condition)
    expectTypeOf(display).toEqualTypeOf<string | undefined>()
    expect(display).toBe('Hypertension')
  })

  it('filter and sort a worklist', () => {
    const systolic = r4.filter(
      systolicReadings,
      "Observation.code.coding.exists(system = %loinc and code = '8480-6')",
      {
        env: { loinc: LOINC },
      }
    )
    expect(systolic).toHaveLength(3)
    const newestFirst = r4.evaluate(
      'Observation.sort(-(effective.ofType(dateTime) | issued).first())',
      systolic
    ) as Observation[]
    expect(newestFirst.map(o => o.effectiveDateTime ?? o.issued)).toEqual([
      '2026-03-01',
      '2026-02-01T00:00:00Z',
      '2026-01-01',
    ])
  })

  it('unit-safe quantities', () => {
    expect(r4.filter(systolicReadings, "value.ofType(Quantity) > 140 'mm[Hg]'")).toHaveLength(1)

    const weight: Observation = {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: LOINC, code: '29463-7' }] },
      valueQuantity: { value: 176, unit: 'lb', code: '[lb_av]' },
    }
    const codeless = { ...weight, valueQuantity: { value: 176, unit: 'lbs' } }
    expect(r4.filter([weight, codeless], "value.ofType(Quantity).convertsToQuantity('kg')")).toEqual([weight])
    expect(r4.first("Observation.value.ofType(Quantity).toQuantity('kg').value", weight)).toBeCloseTo(79.83, 2)
  })

  it('view rows straight from project()', () => {
    const requests: MedicationRequest[] = [
      {
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        subject: { reference: 'Patient/p1' },
        id: 'm1',
        medicationCodeableConcept: { coding: [{ code: '123', display: 'Lisinopril' }] },
        dosageInstruction: [{ text: 'Take with food' }],
        authoredOn: '2026-05-01',
      },
      { resourceType: 'MedicationRequest', status: 'stopped', intent: 'order', subject: { reference: 'Patient/p1' } },
    ]
    const cards = r4.project(requests, {
      id: { path: '(MedicationRequest.id | %rowIndex.toString()).first()', default: '' },
      name: {
        path: '(MedicationRequest.medication.ofType(CodeableConcept).select(text | coding.display.first()) | MedicationRequest.medication.ofType(Reference).display).first()',
        default: 'Medication',
      },
      sig: { path: 'MedicationRequest.dosageInstruction.first().text', default: '' },
      isActive: { test: "MedicationRequest.status = 'active'" },
      prescribedOn: { path: 'MedicationRequest.authoredOn', default: null },
    })
    expect(cards).toEqual([
      { id: 'm1', name: 'Lisinopril', sig: 'Take with food', isActive: true, prescribedOn: '2026-05-01' },
      { id: '1', name: 'Medication', sig: '', isActive: false, prescribedOn: null },
    ])

    class MedicationRow extends defineDto('MedicationRequest') {
      @column('id', { default: '' })
      id!: string

      @column(
        '(medication.ofType(CodeableConcept).select(text | coding.display.first()) | medication.ofType(Reference).display).first()',
        { default: 'Medication' }
      )
      name!: string

      @criteria("status = 'active'")
      active!: boolean
    }

    expect(r4.project(requests, MedicationRow).map(row => row.name)).toEqual(['Lisinopril', 'Medication'])
  })

  it('checks constraints', () => {
    const patient: Patient = {
      resourceType: 'Patient',
      contact: [{}],
    }
    const result = r4.checkConstraints(patient, [
      {
        key: 'pat-1',
        severity: 'error',
        human: 'Contact needs a name or telecom',
        expression: 'contact.all(name.exists() or telecom.exists())',
      },
    ])
    expect(result.valid).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.toOperationOutcome().issue).toHaveLength(1)
  })

  it('status labels from a code map', () => {
    const statusMeta = [
      { code: 'active', label: 'Active', tone: 'info' },
      { code: 'recurrence', label: 'Recurrence', tone: 'danger' },
      { code: 'resolved', label: 'Resolved', tone: 'neutral' },
    ] as const
    const subject = { reference: 'Patient/p1' }
    const conditions: Condition[] = [
      { resourceType: 'Condition', subject, clinicalStatus: { coding: [{ code: 'active' }] } },
      { resourceType: 'Condition', subject, clinicalStatus: { coding: [{ code: 'recurrence' }] } },
      { resourceType: 'Condition', subject },
    ]
    const rows = r4.project(conditions, {
      label: {
        path: 'Condition.clinicalStatus.coding.first().code',
        choices: statusMeta,
        pick: 'label',
        default: 'Unknown',
      },
      tone: {
        path: 'Condition.clinicalStatus.coding.first().code',
        choices: statusMeta,
        pick: 'tone',
        default: 'neutral' as const,
      },
    })
    expect(rows).toEqual([
      { label: 'Active', tone: 'info' },
      { label: 'Recurrence', tone: 'danger' },
      { label: 'Unknown', tone: 'neutral' },
    ])
  })

  it('join related resources', () => {
    const reportsByOrderId = new Map<string, DiagnosticReport>([
      [
        'sr1',
        { resourceType: 'DiagnosticReport', status: 'final', code: { text: 'CBC' }, effectiveDateTime: '2026-01-06' },
      ],
    ])
    const orders: ServiceRequest[] = [
      {
        resourceType: 'ServiceRequest',
        status: 'active',
        intent: 'order',
        subject: { reference: 'Patient/p1' },
        id: 'sr1',
      },
      {
        resourceType: 'ServiceRequest',
        status: 'active',
        intent: 'order',
        subject: { reference: 'Patient/p1' },
        id: 'sr2',
      },
    ]
    const reports = [...reportsByOrderId].map(([orderId, report]) => ({ orderId, report }))
    const rows = r4.project(
      orders,
      {
        resultDate: {
          path: '(%report.effective.ofType(dateTime) | %report.issued).first()',
          default: null,
        },
        hasResult: { test: '%report.exists()' },
      },
      {
        env: { reports },
        vars: { report: '%reports.where(orderId = %context.id).report' },
        varTypes: { report: { type: 'DiagnosticReport' } },
      }
    )
    expectTypeOf(rows).toEqualTypeOf<{ resultDate: string | null; hasResult: boolean }[]>()
    expect(rows).toEqual([
      { resultDate: '2026-01-06', hasResult: true },
      { resultDate: null, hasResult: false },
    ])
  })

  it('extensions, including primitive extensions', () => {
    // The generated types omit primitive-extension `_field` siblings, so the fixture casts.
    const patient = {
      resourceType: 'Patient',
      birthDate: '1984-11-02',
      _birthDate: {
        extension: [
          {
            url: 'http://hl7.org/fhir/StructureDefinition/patient-birthTime',
            valueDateTime: '1984-11-02T04:30:00Z',
          },
        ],
      },
      extension: [
        { url: 'http://example.org/fhir/StructureDefinition/preferred-pharmacy', valueString: 'Corner Pharmacy' },
      ],
    } as Patient
    expect(
      r4.first('Patient.extension(%pharmacyUrl).value.ofType(string)', patient, {
        env: { pharmacyUrl: 'http://example.org/fhir/StructureDefinition/preferred-pharmacy' },
      })
    ).toBe('Corner Pharmacy')
    expect(r4.first('Patient.birthDate.extension(%`ext-patient-birthTime`).value.ofType(dateTime)', patient)).toBe(
      '1984-11-02T04:30:00Z'
    )
  })

  it('follow references inside a Bundle', () => {
    const reading: Observation = {
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'BP' },
      subject: { reference: 'Patient/p1' },
    }
    const subject: Patient = { resourceType: 'Patient', id: 'p1', name: [{ family: 'Okoro', given: ['Adaeze'] }] }
    const searchset: Bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [{ resource: reading }, { resource: subject }],
    }
    expect(r4.evaluate('Bundle.entry.resource.ofType(Observation).subject.resolve().name.family', searchset)).toEqual([
      'Okoro',
    ])
  })

  it('walk nested structures', () => {
    const questionnaire: Questionnaire = {
      resourceType: 'Questionnaire',
      status: 'active',
      item: [
        {
          linkId: 'g1',
          type: 'group',
          item: [
            { linkId: 'q1', type: 'string' },
            { linkId: 'g2', type: 'group', item: [{ linkId: 'q2', type: 'boolean' }] },
          ],
        },
      ],
    }
    expect(r4.evaluate('Questionnaire.repeat(item).linkId', questionnaire)).toEqual(['g1', 'q1', 'g2', 'q2'])
  })

  it('deterministic tests and debugging', () => {
    const patient: Patient = { resourceType: 'Patient', birthDate: '1984-11-02' }
    expect(r4.test(patient, 'birthDate <= today()', { now: new Date('2026-08-04T12:00:00Z') })).toBe(true)

    const traced: string[] = []
    r4.evaluate(
      "Patient.name.trace('names').given",
      { resourceType: 'Patient', name: [{ given: ['A'] }] },
      { trace: name => traced.push(name) }
    )
    expect(traced).toEqual(['names'])
  })

  it('covers expressions used by the longer reference docs', () => {
    const patient: Patient = {
      resourceType: 'Patient',
      active: true,
      name: [{ use: 'official', family: 'Okoro', given: ['Adaeze'] }],
    }
    expect(r4.first("name.where(use = 'official').first().family", patient)).toBe('Okoro')
    expect(r4.evaluate('name.given', patient)).toEqual(['Adaeze'])
    expect(r4.test(patient, 'active = true')).toBe(true)
    expect(r4.evaluate("name.trace('names').given", patient, { trace: () => undefined })).toEqual(['Adaeze'])

    const request: MedicationRequest = {
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
    }
    expect(r4.test(request, "(status in ('entered-in-error' | 'draft')).not()")).toBe(true)

    const report: DiagnosticReport = {
      resourceType: 'DiagnosticReport',
      status: 'final',
      code: { coding: [{ system: LOINC, code: '58410-2' }] },
    }
    expect(
      r4.first('code.coding.where(system = %system).first().code', report, {
        env: { system: LOINC },
      })
    ).toBe('58410-2')

    expect(
      r4.test(systolicReadings[0]!, '%limit < value.count()', {
        env: { limit: 0 },
      })
    ).toBe(true)
  })

  it('covers API reference expressions in their runtime contexts', () => {
    const patient: Patient = {
      resourceType: 'Patient',
      id: 'p1',
      birthDate: '1980-01-01',
      gender: 'female',
      name: [{ family: 'Okoro' }],
    }
    expect(r4.test(patient, 'birthDate < @1990-01-01')).toBe(true)
    expect(r4.evaluate('Patient.id', patient)).toEqual(['p1'])
    expect(r4.first('Patient.name.family.first()', patient)).toBe('Okoro')
    expect(r4.evaluate('Patient.birthDate', patient)).toEqual(['1980-01-01'])
    expect(r4.evaluate('Patient.gender', patient)).toEqual(['female'])
    expect(r4.evaluate('Patient.name', patient)).toEqual([{ family: 'Okoro' }])

    const weight: Observation = {
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'Body weight' },
      valueQuantity: { value: 80, unit: 'kg', code: 'kg' },
      effectiveDateTime: '2026-08-01T12:00:00Z',
      note: [{ text: 'Scale calibrated' }],
    }
    expect(r4.first("value.ofType(Quantity).toQuantity('[lb_av]').value", weight)).toBeCloseTo(176.3698)
    expect(r4.first('(effective.ofType(dateTime) | issued).first()', weight)).toBe('2026-08-01T12:00:00Z')
    expect(r4.evaluate('note.text', weight)).toEqual(['Scale calibrated'])
    expect(r4.test(weight, "status = 'final'")).toBe(true)
    expect(
      r4.first('(text | coding.display.first() | coding.first().code).first()', weight.code, { type: 'string' })
    ).toBe('Body weight')

    const order: ServiceRequest = {
      resourceType: 'ServiceRequest',
      id: 'order-1',
      status: 'active',
      intent: 'order',
      code: {},
      subject: { reference: 'Patient/p1' },
    }
    const report: DiagnosticReport = {
      resourceType: 'DiagnosticReport',
      status: 'final',
      code: {},
    }
    expect(
      r4.evaluate('%reports.where(orderId = %context.id).report', order, {
        env: { reports: [{ orderId: 'order-1', report }] },
      })
    ).toEqual([report])
    expect(r4.evaluate('%report.status', order, { env: { report } })).toEqual(['final'])
    expect(r4.test(patient, '$this is Patient')).toBe(true)

    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [{ resource: patient }],
    }
    expect(r4.first('Bundle.entry.count()', bundle)).toBe(1)
    expect(r4.first('Bundle.type', bundle)).toBe('searchset')
  })
})

describe('README usage recipes: enforcement', () => {
  const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
  const sectionStart = readme.indexOf('\n## Usage recipes')
  const section = readme.slice(sectionStart + 1, readme.indexOf('\n## ', sectionStart + 1))
  // The fences omit the import boilerplate the section's intro relies on; the
  // walker needs it to trust `r4`, so scan each fence with it prepended.
  const IMPORT_HEADER = "import { r4 } from 'fhirpath-ts/r4'\n"
  const findExpressionSites = createSiteFinder(ts)
  const readmeExpressions = [...section.matchAll(/```ts\n([\s\S]*?)```/g)].flatMap(fence =>
    findExpressionSites(IMPORT_HEADER + fence[1]!, 'recipe.ts').map(site => site.expression)
  )

  it('extracts the section and its expression strings', () => {
    expect(sectionStart).toBeGreaterThan(-1)
    expect(readmeExpressions.length).toBeGreaterThanOrEqual(15)
  })

  it('runs every static README expression in this file', () => {
    const tested = new Set(
      findExpressionSites(readFileSync(fileURLToPath(import.meta.url), 'utf8'), 'recipes.test.ts', {
        localImports: true,
      }).map(site => site.expression)
    )
    for (const expression of readmeExpressions) {
      expect(tested.has(expression), `README expression not exercised by these tests: ${expression}`).toBe(true)
    }
  })

  it('every static README expression passes the analyzer', () => {
    // What the snippets' surrounding code passes via `env`, `vars`, and
    // `functions` (plus project()'s row variables), declared the way a
    // consumer's CI would.
    const variables = {
      loinc: { types: ['System.String'], single: true },
      pharmacyUrl: { types: ['System.String'], single: true },
      reports: {},
      report: {},
      rowIndex: { types: ['System.Integer'], single: true },
      rowTotal: { types: ['System.Integer'], single: true },
    }
    const functions = {
      displayText: { expression: '(text | coding.display.first() | coding.first().code).first()' },
    }
    for (const expression of readmeExpressions) {
      expect(analyzeExpression(expression, { model: r4Model, variables, functions }), expression).toEqual([])
    }
  })
})
