import { describe, expect, it } from 'vitest'

import { evaluate } from '../api/evaluate.ts'
import { FhirPathRuntimeError, FhirPathTypeError } from '../errors.ts'
import type { CodeSystem, Patient, QuestionnaireResponse } from '../r4/generated/type-maps.ts'
import { r4 } from '../r4/index.ts'

// The generated types omit primitive-extension `_field` siblings, so the fixture casts.
const patient = {
  resourceType: 'Patient',
  gender: 'male',
  _gender: { extension: [{ url: 'http://example.org/source', valueString: 'intake' }] },
  name: [{ family: 'Chalmers', given: ['Peter', 'James'] }],
  birthDate: '1974-12-25',
} as Patient

const codeSystem = {
  resourceType: 'CodeSystem',
  url: 'http://example.org/cs',
  status: 'active',
  content: 'complete',
  concept: [
    { code: 'a', display: 'Alpha' },
    { code: 'b', display: 'Beta' },
  ],
} satisfies CodeSystem

const questionnaireResponse = {
  resourceType: 'QuestionnaireResponse',
  status: 'completed',
  item: [
    {
      linkId: 'coded-q',
      answer: [{ valueCoding: { system: 'http://x', code: '1' } }, { valueCoding: { system: 'http://x', code: '2' } }],
    },
  ],
} satisfies QuestionnaireResponse

describe('instance selectors: specification examples', () => {
  it('creates a static Coding', () => {
    expect(r4.evaluate("Coding { system : 'http://example.org/demo', code : 'c1' }", patient)).toEqual([
      { system: 'http://example.org/demo', code: 'c1' },
    ])
  })

  it('accepts the FHIR namespace', () => {
    expect(r4.evaluate("FHIR.Identifier { system : 'http://example.org/demo', value : 'N0001231' }", patient)).toEqual([
      { system: 'http://example.org/demo', value: 'N0001231' },
    ])
  })

  it('nests selectors and converts System values to FHIR JSON', () => {
    const expression = `Identifier {
      type : CodeableConcept { coding: Coding { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' } },
      system : 'urn:oid:1.2.36.146.595.217.0.1',
      value : '12345',
      period : Period { start: @2001-05-06 }
    }`
    expect(r4.evaluate(expression, patient)).toEqual([
      {
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
        system: 'urn:oid:1.2.36.146.595.217.0.1',
        value: '12345',
        period: { start: '2001-05-06' },
      },
    ])
  })

  it('creates an empty object with {:}, while {} stays the empty collection', () => {
    expect(r4.evaluate('Period {:}', patient)).toEqual([{}])
    expect(r4.evaluate('Period {:}.exists()', patient)).toEqual([true])
    expect(r4.evaluate('{}.exists()', patient)).toEqual([false])
  })

  it('converts the gender code into a Coding, keeping its extensions', () => {
    expect(
      r4.evaluate(
        "Patient.select(Coding { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: gender })",
        patient
      )
    ).toEqual([
      {
        system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
        code: 'male',
        _code: { extension: [{ url: 'http://example.org/source', valueString: 'intake' }] },
      },
    ])
  })

  it('converts concepts into Codings', () => {
    expect(
      r4.evaluate(
        'CodeSystem.concept.select(Coding { system: %resource.url, code: code, display: display })',
        codeSystem
      )
    ).toEqual([
      { system: 'http://example.org/cs', code: 'a', display: 'Alpha' },
      { system: 'http://example.org/cs', code: 'b', display: 'Beta' },
    ])
  })

  it('creates a primitive through its value element', () => {
    expect(r4.evaluate("code { value: 'final' }", patient)).toEqual(['final'])
    expect(r4.evaluate("code { value: 'final' } is code", patient)).toEqual([true])
    expect(r4.evaluate("code { value: 'final' } = 'final'", patient)).toEqual([true])
    expect(r4.evaluate('date { value: @2020-01-02 } < @2021-01-01', patient)).toEqual([true])
    // The R4 model declares these two values as System.String; they read as integers.
    expect(r4.evaluate('unsignedInt { value: 0 }', patient)).toEqual([0])
    expect(r4.evaluate('positiveInt { value: 5 } is positiveInt', patient)).toEqual([true])
  })

  it('fills a repeating element from several items', () => {
    const expression = `CodeableConcept {
      coding: Coding { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }
            | Coding { system: 'http://example.org/id-types', code: 'mr' }
    }`
    expect(r4.evaluate(expression, patient)).toEqual([
      {
        coding: [
          { system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' },
          { system: 'http://example.org/id-types', code: 'mr' },
        ],
      },
    ])
    expect(
      r4.evaluate(
        "QuestionnaireResponse.item.where(linkId='coded-q').select( CodeableConcept { coding: answer.value.ofType(Coding) } )",
        questionnaireResponse
      )
    ).toEqual([
      {
        coding: [
          { system: 'http://x', code: '1' },
          { system: 'http://x', code: '2' },
        ],
      },
    ])
  })
})

describe('instance selectors: values', () => {
  it('leaves out elements whose value is empty', () => {
    expect(r4.evaluate("HumanName { family: {}, given: 'a' | 'b', text: name.text }", patient)).toEqual([
      { given: ['a', 'b'] },
    ])
  })

  it('writes a repeating element as an array even for one item', () => {
    expect(r4.evaluate("HumanName { given: 'a' }", patient)).toEqual([{ given: ['a'] }])
  })

  it('sets resourceType on resources', () => {
    expect(r4.evaluate("Observation { status: 'final' }", patient)).toEqual([
      { resourceType: 'Observation', status: 'final' },
    ])
    expect(r4.evaluate("Patient { name: HumanName { family: 'x' } }.name.family", patient)).toEqual(['x'])
  })

  it('picks the choice key from the value type', () => {
    expect(r4.evaluate("Observation { value: 5 'mg' }", patient)).toEqual([
      {
        resourceType: 'Observation',
        valueQuantity: { value: 5, unit: 'mg', system: 'http://unitsofmeasure.org', code: 'mg' },
      },
    ])
    expect(r4.evaluate("Observation { value: 'high' }", patient)).toEqual([
      { resourceType: 'Observation', valueString: 'high' },
    ])
    expect(r4.evaluate("Extension { url: 'u', value: 3 }", patient)).toEqual([{ url: 'u', valueInteger: 3 }])
    expect(r4.evaluate("Extension { url: 'u', value: Patient.gender }", patient)).toEqual([
      {
        url: 'u',
        valueCode: 'male',
        _valueCode: { extension: [{ url: 'http://example.org/source', valueString: 'intake' }] },
      },
    ])
    expect(r4.evaluate('Observation { value: Patient.birthDate }.value is dateTime', patient)).toEqual([true])
  })

  it('accepts subtypes, other FHIR quantity types, and untyped objects', () => {
    expect(r4.evaluate("Patient { contained: Observation { status: 'final' } }.contained.status", patient)).toEqual([
      'final',
    ])
    // Condition.onset[x] has Age but no Quantity.
    expect(r4.evaluate('Condition { onset: 5 years }', patient)).toEqual([
      {
        resourceType: 'Condition',
        onsetAge: { value: 5, unit: 'years', system: 'http://unitsofmeasure.org', code: 'a' },
      },
    ])
    expect(r4.evaluate('Patient { name: %name }.name.family', patient, { env: { name: { family: 'Doe' } } })).toEqual([
      'Doe',
    ])
  })

  it('keeps the siblings of primitives in a repeating element', () => {
    expect(r4.evaluate("HumanName { given: 'Ann' | Patient.gender }", patient)).toEqual([
      {
        given: ['Ann', 'male'],
        _given: [null, { extension: [{ url: 'http://example.org/source', valueString: 'intake' }] }],
      },
    ])
  })

  it('writes calendar durations with their UCUM code, so they read back as durations', () => {
    expect(r4.evaluate('Observation { value: 5 days }.value', patient)).toEqual([
      { value: 5, unit: 'days', system: 'http://unitsofmeasure.org', code: 'd' },
    ])
    expect(r4.evaluate('Observation { value: 5 days }.value = 5 days', patient)).toEqual([true])
  })

  it('applies implicit conversions: Integer into decimal', () => {
    expect(r4.evaluate("Quantity { value: 2, unit: 'mg' }.value", patient)).toEqual([2])
  })

  it('compares with navigated values', () => {
    expect(r4.evaluate("Coding { code: 'a' } ~ Coding { code: 'a' }", patient)).toEqual([true])
    expect(r4.evaluate("Coding { code: 'a' } is Coding", patient)).toEqual([true])
    expect(
      r4.evaluate(
        "QuestionnaireResponse.item.answer.value.where($this = Coding { system: 'http://x', code: '2' }).code",
        questionnaireResponse
      )
    ).toEqual(['2'])
  })

  it('evaluates each value in its own variable scope', () => {
    expect(r4.evaluate("Coding { code: defineVariable('c', 'x').select(%c), display: 'y' }", patient)).toEqual([
      { code: 'x', display: 'y' },
    ])
    expect(() => r4.evaluate("Coding { code: defineVariable('c', 'x').select(%c), display: %c }", patient)).toThrow(
      'Undefined environment variable %c'
    )
  })
})

describe('instance selectors: focus', () => {
  it('gives empty for an empty focus', () => {
    expect(r4.evaluate("Coding { code: 'a' }", undefined)).toEqual([])
    expect(r4.evaluate("{}.select(Coding { code: 'a' })", patient)).toEqual([])
  })

  it('builds one value per focus item inside select()', () => {
    expect(r4.evaluate('Patient.name.given.select(HumanName { given: $this })', patient)).toEqual([
      { given: ['Peter'] },
      { given: ['James'] },
    ])
  })

  it('rejects a focus with more than one item', () => {
    expect(() => r4.evaluate("Coding { code: 'a' }", [patient, patient])).toThrow(
      new FhirPathRuntimeError('An instance selector expects at most one input item, but found 2')
    )
  })
})

describe('instance selectors: errors', () => {
  it.each([
    ['Foo { a: 1 }', "Unknown type 'Foo'", FhirPathTypeError],
    ["Other.Coding { code: 'a' }", "Unknown type 'Other.Coding'", FhirPathTypeError],
    [
      "System.String { value: 'x' }",
      "An instance selector builds a model type, but 'System.String' is a System type",
      FhirPathTypeError,
    ],
    ["Coding { cod: 'a' }", "Element 'cod' is not defined on Coding", FhirPathTypeError],
    // Names on Object.prototype are not elements either.
    ["Coding { constructor: 'a' }", "Element 'constructor' is not defined on Coding", FhirPathTypeError],
    ["Coding { __proto__: 'a' }", "Element '__proto__' is not defined on Coding", FhirPathTypeError],
    [
      "positiveInt { value: 'a' }",
      "Element 'value' of positiveInt expects System.Integer, found System.String",
      FhirPathTypeError,
    ],
    // Values must match the FHIR primitive's pattern; the message leaves the value out.
    [
      'unsignedInt { value: -1 }',
      "Element 'value' of unsignedInt does not match the unsignedInt pattern [0]|([1-9][0-9]*)",
      FhirPathRuntimeError,
    ],
    [
      'positiveInt { value: 0 }',
      "Element 'value' of positiveInt does not match the positiveInt pattern [1-9][0-9]*",
      FhirPathRuntimeError,
    ],
    [
      "Coding { code: ' final' }",
      "Element 'code' of Coding does not match the code pattern [^ \\t\\n\\x0B\\f\\r]+([ \\t\\n\\x0B\\f\\r][^ \\t\\n\\x0B\\f\\r]+)*",
      FhirPathRuntimeError,
    ],
    ['Coding { code: 1 }', "Element 'code' of Coding expects code, found System.Integer", FhirPathTypeError],
    [
      'Coding { code: Patient.name.given }',
      "Element 'code' of Coding takes one item, but its value has 2 items",
      FhirPathRuntimeError,
    ],
    [
      "Observation { value: Coding { code: 'a' } }",
      "Element 'value' of Observation expects Quantity | CodeableConcept | string | boolean | integer | Range | Ratio | SampledData | time | dateTime | Period, found FHIR.Coding",
      FhirPathTypeError,
    ],
  ])('%s throws', (expression, message, type) => {
    expect(() => r4.evaluate(expression, patient)).toThrow(new type(message))
  })

  it('checks every written primitive against its FHIR pattern', () => {
    // A dateTime with a time needs seconds and a time zone in FHIR.
    expect(() => r4.evaluate('Observation { effective: @2020-01-01T10:00 }', patient)).toThrow(
      "Element 'effective' of Observation does not match the dateTime pattern"
    )
    expect(r4.evaluate('Observation { effective: @2020-01-01T10:00:00Z }.effective', patient).map(String)).toEqual([
      '2020-01-01T10:00:00Z',
    ])
    expect(r4.evaluate("Attachment { data: 'QUJD' }", patient)).toEqual([{ data: 'QUJD' }])
    // Unicode spaces are ordinary characters, as in FHIR's (Java) patterns.
    const spaced: Patient = { resourceType: 'Patient', name: [{ family: 'Yamada　Taro', given: ['A B'] }] }
    expect(r4.evaluate('Patient.name.select(HumanName { family: family, given: given })', spaced)).toEqual([
      { family: 'Yamada　Taro', given: ['A B'] },
    ])
    // Values read from data are checked as well, and the message leaves them out.
    const invalid = { resourceType: 'Patient', gender: 'two  spaces' }
    expect(() => r4.evaluate('Coding { code: gender }', invalid)).toThrow(
      new FhirPathRuntimeError(
        "Element 'code' of Coding does not match the code pattern [^ \\t\\n\\x0B\\f\\r]+([ \\t\\n\\x0B\\f\\r][^ \\t\\n\\x0B\\f\\r]+)*"
      )
    )
  })

  it('checks names before it reads the focus', () => {
    expect(() => r4.evaluate("Coding { cod: 'a' }", undefined)).toThrow("Element 'cod' is not defined on Coding")
  })
})

describe('instance selectors: backbone elements', () => {
  it('builds the backbone element a BackboneElement selector is the value of', () => {
    expect(
      r4.evaluate(
        "Observation { component: BackboneElement { code: CodeableConcept { text: 'Systolic' }, value: 120 'mm[Hg]' } }",
        patient
      )
    ).toEqual([
      {
        resourceType: 'Observation',
        component: [
          {
            code: { text: 'Systolic' },
            valueQuantity: { value: 120, unit: 'mm[Hg]', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
          },
        ],
      },
    ])
    expect(
      r4.evaluate("Patient { contact: FHIR.BackboneElement { name: HumanName { family: 'Doe' } } }", patient)
    ).toEqual([{ resourceType: 'Patient', contact: [{ name: { family: 'Doe' } }] }])
    // Questionnaire.item.item is typed by a content reference to Questionnaire.item.
    expect(
      r4.evaluate(
        "Questionnaire { item: BackboneElement { linkId: 'a', item: BackboneElement { linkId: 'b' } } }",
        patient
      )
    ).toEqual([{ resourceType: 'Questionnaire', item: [{ linkId: 'a', item: [{ linkId: 'b' }] }] }])
    // Element works too, as every backbone element derives from it.
    expect(r4.evaluate('Timing { repeat: Element { count: 2 } }', patient)).toEqual([{ repeat: { count: 2 } }])
  })

  it('types the built value as the backbone element', () => {
    const [component] = r4.evaluateTyped(
      "Observation { component: BackboneElement { code: CodeableConcept { text: 'x' } } }.component",
      patient
    )
    expect(component?.type).toBe('FHIR.Observation.component')
    expect(
      r4.evaluate(
        "Observation { component: BackboneElement { code: CodeableConcept { text: 'x' } } }.component.code.text",
        patient
      )
    ).toEqual(['x'])
  })

  it.each([
    [
      "Observation { component: BackboneElement { notAField: 'x' } }",
      "Element 'notAField' is not defined on Observation.component",
    ],
    [
      "Observation { component: BackboneElement { code: 'x' } }",
      "Element 'code' of Observation.component expects CodeableConcept, found System.String",
    ],
    // Elsewhere BackboneElement is the abstract type.
    ["BackboneElement { linkId: 'a' }", "Element 'linkId' is not defined on BackboneElement"],
    // A backbone element that does not derive from the named type.
    ['Timing { repeat: BackboneElement { count: 2 } }', "Element 'count' is not defined on BackboneElement"],
    [
      'Observation { component: (BackboneElement { code: CodeableConcept {:} }).first() }',
      "Element 'code' is not defined on BackboneElement",
    ],
  ])('%s throws', (expression, message) => {
    expect(() => r4.evaluate(expression, patient)).toThrow(new FhirPathTypeError(message))
  })
})

describe('instance selectors: required elements', () => {
  it('builds a value without its required elements, as the spec allows', () => {
    expect(r4.evaluate('Observation {:}', patient)).toEqual([{ resourceType: 'Observation' }])
    expect(r4.evaluate("Extension { value: 'x' }", patient)).toEqual([{ valueString: 'x' }])
  })
})

describe('instance selectors without a model', () => {
  it('builds a plain object typed in the FHIR namespace', () => {
    expect(evaluate("Coding { system: 'x', code: 'y', extra: 1 }", patient)).toEqual([
      { system: 'x', code: 'y', extra: 1 },
    ])
    expect(evaluate("Coding { code: 'y' } is FHIR.Coding", patient)).toEqual([true])
    expect(evaluate("Coding { code: 'y' }.code", patient)).toEqual(['y'])
  })

  it('writes one item as a value and several as an array', () => {
    expect(evaluate("HumanName { given: 'a', family: name.given }", patient)).toEqual([
      { given: 'a', family: ['Peter', 'James'] },
    ])
  })

  it('still builds FHIR primitives and rejects System types', () => {
    expect(evaluate("code { value: 'final' } = 'final'", patient)).toEqual([true])
    expect(() => evaluate('System.Integer { value: 1 }', patient)).toThrow(FhirPathTypeError)
  })
})
