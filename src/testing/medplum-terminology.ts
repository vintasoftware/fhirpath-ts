/**
 * End-to-end terminology cases run against a live Medplum server by
 * scripts/record-medplum-terminology.ts and replayed offline by
 * src/terminology/medplum.test.ts. The recorder and the test read this one
 * list, so the recorded requests are exactly the ones the test replays.
 *
 * The base FHIR code systems and value sets ship with Medplum. The scored
 * CodeSystem and the ConceptMap below are synthetic: the recorder creates them
 * for the recording and deletes them afterwards.
 */

export const MEDPLUM_CASSETTE = 'terminology/medplum.json'

const GENDER_SYSTEM = 'http://hl7.org/fhir/administrative-gender'
const ACT_CODE = 'http://terminology.hl7.org/CodeSystem/v3-ActCode'
export const SCORES_SYSTEM = 'http://example.org/fhirpath-ts/CodeSystem/e2e-scores'
export const FREQUENCY_SYSTEM = 'http://example.org/fhirpath-ts/CodeSystem/e2e-frequency'
export const FREQUENCY_MAP = 'http://example.org/fhirpath-ts/ConceptMap/e2e-scores-to-frequency'

/** The scored concepts, loaded with CodeSystem/$import; `unscored` has no itemWeight. */
export const SCORED_CONCEPTS: { code: string; display: string; itemWeight?: number }[] = [
  { code: 'never', display: 'Never', itemWeight: 0 },
  { code: 'sometimes', display: 'Sometimes', itemWeight: 1.5 },
  { code: 'often', display: 'Often', itemWeight: 3 },
  { code: 'unscored', display: 'Unscored' },
]

export const FREQUENCY_CONCEPT_MAP = {
  resourceType: 'ConceptMap',
  url: FREQUENCY_MAP,
  status: 'draft',
  group: [
    {
      source: SCORES_SYSTEM,
      target: FREQUENCY_SYSTEM,
      element: [{ code: 'often', target: [{ code: 'frequent', equivalence: 'equivalent' }] }],
    },
  ],
}

const scored = (...codes: string[]) => ({
  resourceType: 'Observation',
  status: 'final',
  code: { coding: codes.map(code => ({ system: SCORES_SYSTEM, code })) },
})

export const MEDPLUM_ENV = {
  genderSet: 'http://hl7.org/fhir/ValueSet/administrative-gender',
  gender: GENDER_SYSTEM,
  female: { system: GENDER_SYSTEM, code: 'female' },
  male: { system: GENDER_SYSTEM, code: 'male' },
  bogus: { system: GENDER_SYSTEM, code: 'not-a-gender' },
  encounter: { system: ACT_CODE, code: '_ActEncounterCode' },
  ambulatory: { system: ACT_CODE, code: 'AMB' },
  frequencyMap: FREQUENCY_MAP,
  often: { system: SCORES_SYSTEM, code: 'often' },
}

export interface MedplumCase {
  name: string
  expression: string
  input?: unknown
  /** The result, or the message of the error the evaluation raises. */
  expected: unknown[] | { error: string }
}

export const MEDPLUM_CASES: MedplumCase[] = [
  { name: 'memberOf: in the value set', expression: '%female.memberOf(%genderSet)', expected: [true] },
  { name: 'memberOf: not in the value set', expression: '%bogus.memberOf(%genderSet)', expected: [false] },
  {
    name: 'memberOf: independent items in where()',
    expression: '(%female | %male | %bogus).where(memberOf(%genderSet)).code',
    expected: ['female', 'male'],
  },
  {
    name: 'memberOf: an unknown value set is indeterminate',
    expression: "%female.memberOf('http://example.org/fhirpath-ts/ValueSet/missing')",
    expected: [],
  },
  {
    name: '%terminologies.expand',
    expression: '%terminologies.expand(%genderSet).expansion.contains.code.sort()',
    expected: ['female', 'male', 'other', 'unknown'],
  },
  {
    name: '%terminologies.lookup',
    expression: "%terminologies.lookup(%female).parameter.where(name = 'display').value",
    expected: ['Female'],
  },
  {
    name: '%terminologies.validateCS',
    expression: "%terminologies.validateCS(%gender, %bogus).parameter.where(name = 'result').value",
    expected: [false],
  },
  { name: 'subsumes: parent of child', expression: '%encounter.subsumes(%ambulatory)', expected: [true] },
  { name: 'subsumedBy: child of parent', expression: '%ambulatory.subsumedBy(%encounter)', expected: [true] },
  { name: 'subsumes: child of parent', expression: '%ambulatory.subsumes(%encounter)', expected: [false] },
  {
    name: 'subsumes: a code system without a hierarchy is indeterminate',
    expression: '%female.subsumes(%male)',
    expected: [],
  },
  {
    name: '%terminologies.translate',
    expression:
      "%terminologies.translate(%frequencyMap, %often).parameter.where(name = 'match').part.where(name = 'concept').value.code",
    expected: ['frequent'],
  },
  {
    name: 'weight: CodeSystem itemWeight lookups',
    expression: 'code.coding.weight().sum()',
    input: scored('never', 'sometimes', 'often'),
    expected: [4.5],
  },
  {
    name: 'weight: a concept without itemWeight has none',
    expression: 'code.coding.weight()',
    input: scored('unscored'),
    expected: [],
  },
  {
    name: 'weight: an unknown concept is an error, not a lower total',
    expression: 'code.coding.weight()',
    input: scored('missing'),
    expected: { error: 'weight() cannot resolve the CodeSystem' },
  },
]
