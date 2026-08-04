/**
 * The playground's example tabs. Each holds a self-contained TypeScript buffer the
 * Monaco editor loads as-is, so what the reader sees is exactly what runs.
 *
 * Synthetic FHIR data throughout — invented for the demo, not from any real record.
 */

import type { TabItem } from '../dom.ts'

export interface Sample extends TabItem {
  /** Runnable samples get a Run button; the analyze tab is a static error showcase. */
  runnable: boolean
  code: string
}

export const SAMPLES: Sample[] = [
  {
    id: 'analyze',
    label: 'analyze',
    runnable: false,
    code: `import { r4 } from 'fhirpath-ts/r4'
import { analyzeExpression } from 'fhirpath-ts/analyzer'

const patient = {
  resourceType: 'Patient' as const,
  name: [{ family: 'Okoro', given: ['Adaeze', 'Ngozi'] }],
  birthDate: '1984-11-02',
}

// Result types are inferred from the expression literal — hover to see them:
const given = r4.evaluate('Patient.name.given', patient)   // string[]
const family = r4.first('Patient.name.family', patient)    // string | undefined

// Type error: Patient.name is HumanName[], not string[] — the misassignment is caught.
const names: string[] = r4.evaluate('Patient.name', patient)

// Type error: this path expects a Patient, but here it's handed an Observation.
const weight = { resourceType: 'Observation' as const, status: 'final' }
r4.evaluate('Patient.name.given', weight)

// Analyzer (the fhirpath-check CLI / ESLint rule): 'namee' is not on Patient.
r4.evaluate('Patient.namee.given', patient)

// The analyzer is callable directly, too:
analyzeExpression('Observation.valueQuantity', { inputType: 'Observation' })
`,
  },
  {
    id: 'evaluate',
    label: 'evaluate',
    runnable: true,
    code: `import { r4 } from 'fhirpath-ts/r4'

const patient = {
  resourceType: 'Patient' as const,
  name: [{ family: 'Okoro', given: ['Adaeze', 'Ngozi'] }],
  telecom: [{ system: 'phone', value: '+1-555-0142' }],
  birthDate: '1984-11-02',
}

// Result types are inferred from the expression literal — and these actually run.
// Hover a call to see its type, then press Run to see the value.
console.log(r4.evaluate('Patient.name.given', patient))                    // string[]
console.log(r4.first('Patient.name.family', patient))                      // string | undefined
console.log(r4.evaluate("Patient.telecom.where(system = 'phone').value", patient))  // string[]
console.log(r4.first('Patient.name.given.count()', patient))               // number | undefined
`,
  },
  {
    id: 'filter',
    label: 'filter',
    runnable: true,
    code: `import { r4 } from 'fhirpath-ts/r4'

// A searchset of resources. filter() keeps the ones whose criteria hold, and
// preserves the element type — 'adults' is Patient[], not unknown[].
const patients = [
  { resourceType: 'Patient' as const, id: 'p1', birthDate: '1984-11-02', active: true },
  { resourceType: 'Patient' as const, id: 'p2', birthDate: '1991-06-15', active: false },
]

const adults = r4.filter(patients, 'birthDate < @1990-01-01')
console.log('matched:', adults.map(p => p.id))

// test() reduces a boolean criteria (the enableWhen / invariant semantics):
console.log('p1 active:', r4.test(patients[0], 'active = true'))
`,
  },
  {
    id: 'project',
    label: 'project',
    runnable: true,
    code: `import { r4 } from 'fhirpath-ts/r4'

// The second patient has no id and only a partial birthDate — on purpose.
const patients = [
  { resourceType: 'Patient' as const, id: 'p1', name: [{ family: 'Okoro', given: ['Adaeze'] }], birthDate: '1984-11-02' },
  { resourceType: 'Patient' as const, name: [{ family: 'Chen', given: ['Wei', 'Lin'] }], birthDate: '1991-06' },
]

// project() builds a typed row per resource, one column per FHIRPath expression.
// Column expressions are analyzed too: drop the first() calls and the analyzer
// flags '+' on a collection, because name repeats.
const rows = r4.project(patients, {
  // %index/%total hold the row position, so a key can fall back to the row number:
  key: { path: '(Patient.id | %index.toString()).first()', type: 'string' },
  name: "(Patient.name.first().family + ' ' + Patient.name.first().given.join(' ')).trim()",
  // as: 'Date' coerces to JS Dates; the partial birthDate becomes June 1 UTC:
  born: { path: 'Patient.birthDate', as: 'Date' },
})

console.log(rows)
`,
  },
  {
    id: 'checkConstraints',
    label: 'checkConstraints',
    runnable: true,
    code: `import { r4 } from 'fhirpath-ts/r4'

// A patient with a birthDate in the future — pat-2 should fail.
const patient = { resourceType: 'Patient' as const, gender: 'female', birthDate: '2100-01-01' }

// FHIR invariants as FHIRPath — checkConstraints() runs them and reports failures.
const result = r4.checkConstraints(patient, [
  { key: 'pat-1', human: 'gender must be present', expression: 'gender.exists()' },
  { key: 'pat-2', human: 'born in the past', expression: 'birthDate < today()' },
])

console.log('valid:', result.valid)   // boolean
console.log(result.issues)            // the failing constraints, in order
`,
  },
]
