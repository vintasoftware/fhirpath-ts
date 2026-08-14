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

// Analyzer error: 'namee' is not defined on FHIR.Patient.
// Without analysis, evaluate() would return [].
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
  telecom: [{ system: 'phone' as const, value: '+1-555-0142' }],
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
  // %rowIndex is typed, so this fallback needs no explicit result declaration:
  key: '(Patient.id | %rowIndex.toString()).first()',
  name: "(Patient.name.first().family + ' ' + Patient.name.first().given.join(' ')).trim()",
  // as: 'Date' coerces to JS Dates; the partial birthDate becomes June 1 UTC:
  born: { path: 'Patient.birthDate', as: 'Date' },
  // default fills an empty result — and types the column string, not string | undefined:
  gender: { path: 'Patient.gender', default: 'unknown' },
  // test columns are boolean criteria (empty → false), like r4.test():
  named: { test: 'Patient.name.exists()' },
})

console.log(rows)
`,
  },
  {
    id: 'dto',
    label: 'dto',
    runnable: true,
    code: `import { column, criteria, defineDto, FhirPathEngine } from 'fhirpath-ts'
import { r4Model } from 'fhirpath-ts/r4'

// A DTO is a class: defineDto fixes the resource its columns read, and each
// @column field declares one — the expression above, its type below. fhirType is
// the context the paths infer against, so they stay relative. Registered on the
// engine, each column doubles as a function any expression can call.
class CodeableConceptDto extends defineDto('CodeableConcept') {
  @column('(text | coding.display.first() | coding.first().code).first()')
  displayText!: string | undefined
}

const fp = new FhirPathEngine({ model: r4Model, resourceDtos: [CodeableConceptDto] })

// The field's declared type is checked against what its expression yields — try
// changing kg to a string and watch the @column line light up. Projected rows are
// real instances, so getters see the values. Hover the fields to see the types.
class WeightRow extends defineDto('Observation') {
  @column('code.displayText()', { type: 'string', default: 'Reading' })
  name!: string

  @column("value.ofType(Quantity).toQuantity('kg').value", { default: 0 })
  kg!: number

  @column('(effective.ofType(dateTime) | issued).first()', { as: 'Date' })
  at!: Date | undefined

  @criteria("status = 'final'")
  isFinal!: boolean

  get label(): string {
    return this.name + ': ' + Math.round(this.kg * 10) / 10 + ' kg'
  }
}

const observations = [
  {
    resourceType: 'Observation' as const,
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code: '29463-7', display: 'Body weight' }] },
    valueQuantity: { value: 71.4, unit: 'kg', code: 'kg' },
    effectiveDateTime: '2026-06-30T09:15:00Z',
  },
  {
    resourceType: 'Observation' as const,
    status: 'final',
    code: { text: 'Body weight' },
    // Recorded in pounds; the kg column converts it.
    valueQuantity: { value: 160, unit: 'lb', code: '[lb_av]' },
    issued: '2026-05-01T08:00:00Z',
  },
]

const rows = fp.project(observations, WeightRow) // WeightRow[]
console.log(rows.map(row => row.label))
console.log('row 1 observed at:', rows[1]?.at?.toISOString())
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
