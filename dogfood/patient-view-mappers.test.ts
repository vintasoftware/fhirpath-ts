import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import type { Condition, DiagnosticReport, MedicationRequest, Observation, ServiceRequest } from '@medplum/fhirtypes'
import { analyzeEngineDtos } from 'fhirpath-ts/analyzer'
import { describe, expect, it } from 'vitest'

import { fp } from './patient-view.dto.ts'
import {
  isTopLevelOrder,
  isVisibleMedicationRequest,
  mapLabResults,
  mapLabs,
  mapMedicationDetails,
  mapMedications,
  mapProblems,
  mapVitals,
  patientDisplayName,
} from './patient-view-mappers.ts'

// Synthetic FHIR data — invented for these tests, not from any real record.

const HG_INTERPRETATION = 'https://www.healthgorilla.com/fhir/StructureDefinition/diagnosticreport-interpretation'

describe('static analysis', () => {
  // The engine carries what the checks need — its model, the functions its
  // registered DTOs contribute, its env — so nothing is threaded in by hand, and
  // a DTO's per-call env is its own `callerEnv` declaration.
  it('the engine sweep covers every DTO it registered', () => {
    expect(analyzeEngineDtos(fp)).toEqual([])
  })

  // The expressions this module holds in `const`s declare their own root
  // (`fhirpath(expr, 'Observation')`), so they are checked as call sites like any
  // literal — by the ESLint rule on every commit, and by the run below.
  //
  // The other half, in the process it is meant to run in: `fhirpath-check`
  // discovers this directory's `*.dto.ts`, imports it, finds the engine it
  // constructs and analyzes every DTO it exports — including the base classes no
  // list would have mentioned. Runs the real command, so the convention itself
  // is under test: stop exporting a DTO, or move it out of a `*.dto.ts` file,
  // and the count drops.
  it('fhirpath-check discovers and analyzes the DTOs of this directory', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const cli = fileURLToPath(new URL('../src/cli/fhirpath-check.ts', import.meta.url))
    // `--conditions` resolves this directory's `fhirpath-ts` imports to `src`,
    // where the CLI itself runs from. Through the package's published `exports`
    // they would reach `dist`, and the engine these DTOs register in that second
    // copy of the library is invisible to the checker in this one — which reads
    // as a DTO module that exports no DTO at all.
    const result = spawnSync(
      process.execPath,
      ['--conditions=fhirpath-ts-source', cli, '--dtos', 'dogfood/**/*.dto.ts'],
      { cwd: root, encoding: 'utf8' }
    )
    const output = `${result.stdout}${result.stderr}`
    expect(output, output).toMatch(/analyzed 13 DTO\(s\) from 1 module\(s\) against 1 engine\(s\)/)
    expect(result.status, output).toBe(0)
  })
})

describe('mapVitals', () => {
  const observations: Observation[] = [
    {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '29463-7' }] },
      valueQuantity: { value: 176, unit: 'lb', code: '[lb_av]' },
      effectiveDateTime: '2026-01-01',
    },
    {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '29463-7' }] },
      valueQuantity: { value: 80, unit: 'kg', code: 'kg' },
      effectiveDateTime: '2026-02-01',
    },
    {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '8302-2' }] },
      valueQuantity: { value: 180, unit: 'cm', code: 'cm' },
      effectiveDateTime: '2026-01-01',
    },
  ]

  it('builds the weight trend and the height-derived BMI, sorted oldest first', () => {
    const vitals = mapVitals(observations)
    expect(vitals[0]).toMatchObject({ key: 'weight', value: 176, unit: 'lbs', status: null })
    expect(vitals[0]?.series).toHaveLength(2)
    expect(vitals[1]).toMatchObject({ key: 'bmi', value: 24.7, unit: 'kg/m²', status: 'normal' }) // 80 / 1.8²
  })

  it('returns only the vitals that have data', () => {
    expect(mapVitals([])).toEqual([])
    // Weight alone: no height, so no BMI.
    expect(mapVitals(observations.slice(0, 2)).map(v => v.key)).toEqual(['weight'])
  })
})

describe('patientDisplayName', () => {
  it('prefers the official name and falls back to "there"', () => {
    expect(patientDisplayName({ resourceType: 'Patient', name: [{ given: ['Mary', 'Ann'], family: 'Miller' }] })).toBe(
      'Mary Miller'
    )
    expect(patientDisplayName({ resourceType: 'Patient' })).toBe('there')
  })
})

const requests: MedicationRequest[] = [
  {
    resourceType: 'MedicationRequest',
    id: 'm1',
    status: 'active',
    intent: 'order',
    subject: { reference: 'Patient/p1' },
    medicationCodeableConcept: { coding: [{ display: 'Lisinopril 10mg' }] },
    dosageInstruction: [{ text: 'Take with food', route: { text: 'oral' } }],
    authoredOn: '2026-05-01',
    requester: { display: 'Dr. Reyes' },
  },
  {
    resourceType: 'MedicationRequest',
    id: 'm2',
    status: 'draft',
    intent: 'order',
    subject: { reference: 'Patient/p1' },
  },
  {
    resourceType: 'MedicationRequest',
    id: 'm3',
    status: 'on-hold',
    intent: 'order',
    subject: { reference: 'Patient/p1' },
    medicationReference: { display: 'Metformin' },
    dosageInstruction: [
      {
        asNeededBoolean: true,
        doseAndRate: [{ doseQuantity: { value: 500, unit: 'mg', code: 'mg' } }],
      },
    ],
    dispenseRequest: { validityPeriod: { end: '2026-06-01' } },
  },
]

describe('mapMedications', () => {
  it('maps the Home-card fields, with the dose • route fallback for the sig', () => {
    const cards = mapMedications(requests)
    expect(cards[0]).toMatchObject({
      id: 'm1',
      name: 'Lisinopril 10mg',
      instructions: 'Take with food',
      group: 'continuous',
    })
    expect(cards[2]).toMatchObject({ name: 'Metformin', instructions: '500 mg', group: 'asNeeded' })
  })
})

describe('isVisibleMedicationRequest', () => {
  it('hides draft and entered-in-error records', () => {
    expect(isVisibleMedicationRequest(requests[0]!)).toBe(true)
    expect(isVisibleMedicationRequest(requests[1]!)).toBe(false)
  })
})

describe('mapMedicationDetails', () => {
  it('drops hidden records and decodes status into label and tone', () => {
    const details = mapMedicationDetails(requests)
    expect(details).toHaveLength(2)
    expect(details.map(d => [d.status, d.statusLabel, d.tone, d.isActive])).toEqual([
      ['active', 'Active', 'success', true],
      ['on-hold', 'On Hold', 'warning', false],
    ])
    expect(details[0]).toMatchObject({ endedOn: null, prescriber: 'Dr. Reyes' })
    // A non-active request ends at its dispense validity end.
    expect(details[1]?.endedOn).toBe('2026-06-01')
  })
})

describe('mapProblems', () => {
  it('drops entered-in-error, decodes the status, and title-cases unknown codes', () => {
    const conditions: Condition[] = [
      {
        resourceType: 'Condition',
        id: 'c1',
        subject: { reference: 'Patient/p1' },
        code: { coding: [{ code: 'I10', display: 'Hypertension' }] },
        clinicalStatus: { coding: [{ code: 'active' }] },
        meta: { lastUpdated: '2026-03-01T00:00:00Z' },
      },
      {
        resourceType: 'Condition',
        subject: { reference: 'Patient/p1' },
        code: { text: 'Sprained ankle' },
        clinicalStatus: { coding: [{ code: 'some-future-code' }] },
      },
      {
        resourceType: 'Condition',
        subject: { reference: 'Patient/p1' },
        verificationStatus: { coding: [{ code: 'entered-in-error' }] },
      },
    ]
    expect(mapProblems(conditions).map(p => [p.id, p.name, p.statusLabel, p.tone])).toEqual([
      ['c1', 'Hypertension', 'Active', 'info'],
      ['1', 'Sprained ankle', 'Some-future-code', 'neutral'],
    ])
  })
})

const flaggedReport: DiagnosticReport = {
  resourceType: 'DiagnosticReport',
  id: 'dr1',
  status: 'final',
  code: { text: 'CBC' },
  effectiveDateTime: '2026-01-06',
  extension: [{ url: HG_INTERPRETATION, valueCodeableConcept: { coding: [{ code: 'HH' }] } }],
  presentedForm: [{ contentType: 'application/pdf' }],
}
const plainReport: DiagnosticReport = {
  resourceType: 'DiagnosticReport',
  id: 'dr2',
  status: 'preliminary',
  code: { coding: [{ display: 'Lipid Panel' }] },
  issued: '2026-01-07T00:00:00Z',
}

describe('mapLabs', () => {
  it('badges each report from its interpretation, else its workflow status', () => {
    expect(mapLabs([flaggedReport, plainReport]).map(l => [l.name, l.statusLabel, l.tone, l.flagged, l.date])).toEqual([
      ['CBC', 'Critically High', 'danger', true, '2026-01-06'],
      ['Lipid Panel', 'Preliminary', 'info', false, '2026-01-07T00:00:00Z'],
    ])
  })
})

describe('mapLabResults', () => {
  const orders: ServiceRequest[] = [
    {
      resourceType: 'ServiceRequest',
      id: 'sr1',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
      code: { coding: [{ display: 'CBC' }, { display: 'CMP' }] },
      requester: { display: 'Dr. Reyes' },
    },
    {
      resourceType: 'ServiceRequest',
      id: 'sr2',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
      code: { text: 'Lipid Panel' },
      authoredOn: '2026-01-02',
    },
    {
      resourceType: 'ServiceRequest',
      id: 'sr3',
      status: 'revoked',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
      authoredOn: '2026-01-03',
    },
    {
      resourceType: 'ServiceRequest',
      id: 'sr-child',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
      basedOn: [{ reference: 'ServiceRequest/sr1' }],
    },
  ]

  it('keeps top-level orders only, joining each to its report', () => {
    expect(isTopLevelOrder(orders[0]!)).toBe(true)
    expect(isTopLevelOrder(orders[3]!)).toBe(false)
    const rows = mapLabResults(orders, new Map([['sr1', flaggedReport]]))
    expect(rows.map(r => [r.id, r.name, r.statusLabel, r.tone, r.flagged, r.date, r.reportId])).toEqual([
      ['sr1', 'CBC, CMP', 'Critically High', 'danger', true, '2026-01-06', 'dr1'],
      ['sr2', 'Lipid Panel', 'Waiting', 'warning', false, '2026-01-02', null],
      ['sr3', 'Lab order', 'Cancelled', 'neutral', false, '2026-01-03', null],
    ])
    expect(rows[0]?.orderedBy).toBe('Dr. Reyes')
  })
})
