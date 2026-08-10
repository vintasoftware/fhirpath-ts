export type CapabilityFamily =
  | 'path'
  | 'indexer'
  | 'choice'
  | 'group'
  | 'union'
  | 'function-fixed'
  | 'function-input'
  | 'function-lambda'
  | 'syntax'
  | 'variable'

export interface CapabilityEntry {
  family: CapabilityFamily
  source: { corpusId: string } | { expression: string; corpusGap: string }
  input?: string
  context?: {
    variables?: Readonly<Record<string, { types?: readonly string[]; single?: boolean }>>
  }
  expectedType: string
  runtime: boolean
  analyzer: { types: readonly string[] | undefined; single: boolean | undefined }
  degradation: string
  composition: string
}

/** Baseline registry for the precise subset present before the full parser lands. */
export const INFERENCE_CAPABILITIES = {
  'path.resource-root': {
    family: 'path',
    source: { corpusId: 'official:r4:testBasics:testSimpleWithContext' },
    expectedType: 'string[]',
    runtime: true,
    analyzer: { types: ['FHIR.string'], single: false },
    degradation: 'Patient.nope',
    composition: 'Patient.name.given.first()',
  },
  'path.indexer': {
    family: 'indexer',
    source: { expression: 'Patient.name[0]', corpusGap: 'focused positive without a following equality' },
    expectedType: 'HumanName[]',
    runtime: true,
    analyzer: { types: ['FHIR.HumanName'], single: true },
    degradation: 'Patient.name[0][bad]',
    composition: 'Patient.name[0].given',
  },
  'path.choice-stem': {
    family: 'choice',
    source: { expression: 'Observation.value', corpusGap: 'focused positive independent of an R5-only corpus case' },
    expectedType: 'R4 Observation.value choice union[]',
    runtime: true,
    analyzer: {
      types: [
        'FHIR.Quantity',
        'FHIR.CodeableConcept',
        'FHIR.string',
        'FHIR.boolean',
        'FHIR.integer',
        'FHIR.Range',
        'FHIR.Ratio',
        'FHIR.SampledData',
        'FHIR.time',
        'FHIR.dateTime',
        'FHIR.Period',
      ],
      single: true,
    },
    degradation: 'Observation.value.nope',
    composition: 'Observation.value.ofType(Quantity).value',
  },
  'group.navigation': {
    family: 'group',
    source: { expression: '(Patient.name).given', corpusGap: 'focused grouped-navigation composition' },
    expectedType: 'string[]',
    runtime: true,
    analyzer: { types: ['FHIR.string'], single: false },
    degradation: '(Patient.name).given +',
    composition: '(Patient.name).given.first()',
  },
  'union.navigation': {
    family: 'union',
    source: { expression: '(Patient.name.given | Patient.name.family)', corpusGap: 'focused union result assertion' },
    expectedType: 'string[]',
    runtime: true,
    analyzer: { types: ['FHIR.string'], single: false },
    degradation: '(Patient.name.given | Patient.nope)',
    composition: '(Patient.name.given | Patient.name.family).first()',
  },
  'function.fixed': {
    family: 'function-fixed',
    source: { corpusId: 'official:r4:testCount:testCount1' },
    expectedType: 'number[]',
    runtime: true,
    analyzer: { types: ['System.Integer'], single: true },
    degradation: 'Patient.name.unknownFn()',
    composition: 'Patient.name.count().toString()',
  },
  'function.input': {
    family: 'function-input',
    source: { expression: 'Patient.name.first()', corpusGap: 'focused input-preserving function result' },
    expectedType: 'HumanName[]',
    runtime: true,
    analyzer: { types: ['FHIR.HumanName'], single: true },
    degradation: 'Patient.name.first().nope',
    composition: 'Patient.name.first().given',
  },
  'function.select': {
    family: 'function-lambda',
    source: { corpusId: 'fhirpathjs:simple.yaml:22:0' },
    expectedType: 'string[]',
    runtime: true,
    analyzer: { types: ['FHIR.string'], single: false },
    degradation: 'Patient.name.select(nope)',
    composition: 'Patient.name.select(given).first()',
  },
  'variable.opaque-fixed': {
    family: 'variable',
    source: {
      expression: '%rowIndex.toString()',
      corpusGap: 'host variable declaration is absent from reference formats',
    },
    expectedType: 'string[]',
    runtime: true,
    context: { variables: { rowIndex: { types: ['System.Integer'], single: true } } },
    analyzer: { types: ['System.String'], single: true },
    degradation: '%rowIndex.nope',
    composition: '%rowIndex.toString().upper()',
  },
  'syntax.trivia': {
    family: 'syntax',
    source: {
      expression: 'Patient /* ignored . | ( ) */ . name',
      corpusGap: 'focused comment and whitespace tokenization case',
    },
    expectedType: 'HumanName[]',
    runtime: true,
    analyzer: { types: ['FHIR.HumanName'], single: false },
    degradation: 'Patient /* unterminated . name',
    composition: 'Patient /* ignored */ . name.first()',
  },
} as const satisfies Record<string, CapabilityEntry>

export type InferenceCapabilityId = keyof typeof INFERENCE_CAPABILITIES
