// Synthetic FHIR data — invented for the demo, not derived from any real record.

export interface Example {
  expr: string
  note: string
}

export interface Tab {
  id: string
  label: string
  /** The resource the expressions on this tab run against. */
  resourceType: string
  resource: unknown
  /** What this tab is here to show. */
  blurb: string
  examples: Example[]
}

const patient = {
  resourceType: 'Patient',
  id: 'demo-patient',
  active: true,
  name: [
    { use: 'official', family: 'Okoro', given: ['Adaeze', 'Ngozi'] },
    { use: 'nickname', given: ['Ada'] },
  ],
  gender: 'female',
  birthDate: '1984-11-02',
  telecom: [
    { system: 'phone', value: '+1-555-0142', use: 'mobile' },
    { system: 'email', value: 'ada.okoro@example.org' },
  ],
  address: [{ city: 'Portland', state: 'OR', postalCode: '97205', country: 'US' }],
}

const observation = {
  resourceType: 'Observation',
  id: 'demo-weight',
  status: 'final',
  code: {
    coding: [{ system: 'http://loinc.org', code: '29463-7', display: 'Body weight' }],
    text: 'Body weight',
  },
  subject: { reference: 'Patient/demo-patient' },
  effectiveDateTime: '2026-06-30T09:15:00-07:00',
  valueQuantity: { value: 71.4, unit: 'kg', system: 'http://unitsofmeasure.org', code: 'kg' },
}

export const TABS: Tab[] = [
  {
    id: 'patient',
    label: 'Patient',
    resourceType: 'Patient',
    resource: patient,
    blurb: 'Walk a resource by path. Results carry a type, inferred at compile time.',
    examples: [
      { expr: 'Patient.name.given', note: 'A path returns a collection — here, string[].' },
      { expr: "Patient.name.where(use = 'official').family", note: 'Filter, then keep going.' },
      { expr: "Patient.telecom.where(system = 'phone').value", note: 'One value out of many.' },
      { expr: 'Patient.name.given.count()', note: 'Aggregate down to a single Integer.' },
      { expr: 'Patient.birthDate', note: 'A partial-precision date, kept exact.' },
    ],
  },
  {
    id: 'observation',
    label: 'Observation',
    resourceType: 'Observation',
    resource: observation,
    blurb: 'Choice elements resolve by stem. Decimals stay exact — no float drift.',
    examples: [
      { expr: 'Observation.value', note: 'The choice stem resolves to valueQuantity.' },
      { expr: 'Observation.value.ofType(Quantity).value', note: 'Narrow the choice, read the number.' },
      { expr: 'Observation.code.coding.display', note: 'Reach into a nested coding.' },
      { expr: '0.1 + 0.2 = 0.3', note: 'Exact decimal arithmetic — this is true here.' },
      { expr: "Observation.value.ofType(Quantity) > 70 'kg'", note: 'Unit-aware comparison.' },
    ],
  },
  {
    id: 'catch',
    label: 'Catch a bug',
    resourceType: 'Observation',
    resource: observation,
    blurb: 'Each of these is wrong. The analyzer says why before you ever run it.',
    examples: [
      { expr: 'Observation.valueQuantity', note: 'Choice-key misuse — use Observation.value instead.' },
      { expr: 'Observation.bodySite.given', note: 'given is not an element of CodeableConcept.' },
      {
        expr: 'Observation.identifier.value.substring(0, 4)',
        note: 'substring needs a single string, not a collection.',
      },
      { expr: 'Observation.status.lengthx()', note: 'No such function.' },
      { expr: 'Observation.status = 5', note: 'A string and an integer can never be equal.' },
    ],
  },
]
