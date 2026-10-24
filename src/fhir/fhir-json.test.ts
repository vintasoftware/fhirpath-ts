// All data in this file is synthetic.
import { describe, expect, it } from 'vitest'

import { FhirPathEngine } from '../api/engine.ts'
import { FhirPathTypeError } from '../errors.ts'
import { r4 } from '../r4/index.ts'
import type { FhirTypeName } from '../typed/infer.ts'
import type { TypedValue } from '../values/typed-value.ts'

/** The typed result of a FHIRPath literal expression. */
function literal(expression: string): TypedValue {
  const [result] = r4.evaluateTyped(expression)
  if (result === undefined) {
    throw new Error(`No result for ${expression}`)
  }
  return result
}

const fhir = (type: string, value: unknown): TypedValue => ({ type: `FHIR.${type}`, value })

function accepted(value: TypedValue, target: string): unknown {
  return r4.toFhirJson(value, target as FhirTypeName)
}

function refusal(value: TypedValue, target: string): string {
  try {
    r4.toFhirJson(value, target as FhirTypeName)
  } catch (error) {
    expect(error).toBeInstanceOf(FhirPathTypeError)
    return (error as Error).message
  }
  throw new Error(`Accepted as ${target}`)
}

describe('toFhirJson()', () => {
  describe('strings', () => {
    it.each([
      ['string', 'Any text, with spaces'],
      ['markdown', '**bold**'],
      ['code', 'in-progress'],
      ['code', 'two words'],
      ['id', 'a-B.9'],
      ['uri', 'http://example.org/x'],
      ['url', 'https://example.org/x?y=1'],
      ['canonical', 'http://example.org/Questionnaire/q|1.0'],
      ['oid', 'urn:oid:1.2.840.10008'],
      ['uuid', 'urn:uuid:0d6b7f0e-1c3a-4b8e-9a52-6f1d2c3b4a59'],
      ['base64Binary', 'aGVsbG8='],
    ])('writes a string as %s when it has its format', (target, text) => {
      expect(accepted(literal(`'${text}'`), target)).toBe(text)
    })

    it.each([
      ['code', ' leading-space'],
      ['code', 'two  spaces'],
      ['id', 'has space'],
      ['id', 'x'.repeat(65)],
      ['uri', 'has space'],
      ['oid', '1.2.3'],
      ['uuid', 'urn:uuid:NOT-A-UUID'],
      ['string', ''],
    ])('refuses a string without the format of %s', (target, text) => {
      expect(refusal(literal(`'${text}'`), target)).toBe(`The value does not have the format of a FHIR ${target}`)
    })

    it.each(['boolean', 'integer', 'decimal', 'Coding', 'Reference'])('does not write a string as %s', target => {
      expect(refusal(literal("'x'"), target)).toBe(
        `A System.String value cannot be written to an element of type ${target}`
      )
    })

    it('writes a string as xhtml, which has no format pattern', () => {
      expect(accepted(literal("'<div>x</div>'"), 'xhtml')).toBe('<div>x</div>')
    })

    it('writes a FHIR string-like value as a string', () => {
      expect(accepted(fhir('code', 'final'), 'code')).toBe('final')
      expect(accepted(fhir('uri', 'http://example.org'), 'string')).toBe('http://example.org')
    })
  })

  describe('dates and times', () => {
    it.each([
      ['@2024', 'date', '2024'],
      ['@2024-03', 'date', '2024-03'],
      ['@2024-03-01', 'date', '2024-03-01'],
      ['@2024-03-01', 'dateTime', '2024-03-01'],
      ['@2024-03-01T10:00:00Z', 'dateTime', '2024-03-01T10:00:00Z'],
      ['@2024-03-01T10:00:00.250-03:00', 'dateTime', '2024-03-01T10:00:00.250-03:00'],
      ['@2024-03-01T10:00:00+14:00', 'instant', '2024-03-01T10:00:00+14:00'],
      ['@T10:30:00', 'time', '10:30:00'],
      ['@2024-03-01', 'string', '2024-03-01'],
    ])('writes %s as %s', (expression, target, expected) => {
      expect(accepted(literal(expression), target)).toBe(expected)
    })

    it.each([
      ['@2024-03-01T10:00:00Z', 'date'],
      ['@2024-03-01T10', 'dateTime'],
      ['@2024-03-01T10:00:00', 'dateTime'],
      ['@2024-03-01', 'instant'],
      ['@2024-03-01T10:00:00', 'instant'],
      ['@T10:30', 'time'],
    ])('refuses %s as %s, which needs another precision or a timezone', (expression, target) => {
      expect(refusal(literal(expression), target)).toBe(`The value does not have the format of a FHIR ${target}`)
    })

    it('keeps the text of a date-time from the data, milliseconds and timezone included', () => {
      const [authored] = r4.evaluateTyped('authored', {
        resourceType: 'QuestionnaireResponse',
        status: 'completed',
        authored: '2025-09-16T12:34:56.000-07:00',
      })
      expect(accepted(authored!, 'dateTime')).toBe('2025-09-16T12:34:56.000-07:00')
      expect(accepted(authored!, 'instant')).toBe('2025-09-16T12:34:56.000-07:00')
    })

    it('writes a string with a date format as a date', () => {
      expect(accepted(literal("'2024-03-01'"), 'date')).toBe('2024-03-01')
    })

    it.each(['2024-02-30', '2023-02-29', '2024-04-31'])('refuses %s, a day that does not exist, as a date', text => {
      expect(refusal(literal(`'${text}'`), 'date')).toBe('The value does not have the format of a FHIR date')
    })

    it('does not write a date as a code', () => {
      expect(refusal(literal('@2024-03-01'), 'code')).toBe(
        'A System.Date value cannot be written to an element of type code'
      )
    })
  })

  describe('numbers and booleans', () => {
    it('writes booleans only as boolean', () => {
      expect(accepted(literal('true'), 'boolean')).toBe(true)
      expect(accepted(literal('false'), 'boolean')).toBe(false)
      expect(refusal(literal('true'), 'string')).toBe(
        'A System.Boolean value cannot be written to an element of type string'
      )
    })

    it.each([
      ['5', 'integer', 5],
      ['0', 'integer', 0],
      ['-3', 'integer', -3],
      ['0', 'unsignedInt', 0],
      ['1', 'positiveInt', 1],
      ['5', 'decimal', 5],
      ['3.0', 'integer', 3],
      ['2.5', 'decimal', 2.5],
      ['1L', 'integer', 1],
      ['(66 * 2.54).round()', 'decimal', 168],
      ['(134 * 0.454).round(1)', 'decimal', 60.8],
    ])('writes %s as %s', (expression, target, expected) => {
      expect(accepted(literal(expression), target)).toBe(expected)
    })

    it.each([
      ['0', 'positiveInt', 'A System.Integer value out of the range of positiveInt cannot be written'],
      ['-1', 'unsignedInt', 'A System.Integer value out of the range of unsignedInt cannot be written'],
      ['2147483648L', 'integer', 'A System.Long value that is not a 32-bit integer cannot be written as integer'],
      ['2.5', 'integer', 'A System.Decimal value that is not a 32-bit integer cannot be written as integer'],
      ['5', 'string', 'A System.Integer value cannot be written as string'],
      ['5', 'code', 'A System.Integer value cannot be written as code'],
    ])('refuses %s as %s', (expression, target, reason) => {
      expect(refusal(literal(expression), target)).toBe(reason)
    })

    it('writes a decimal without the zeros of its scale, as a JSON number does', () => {
      expect(accepted(literal('2.50 * 2'), 'decimal')).toBe(5)
    })

    it('refuses a number that is not finite', () => {
      expect(refusal({ type: 'System.Decimal', value: Number.NaN }, 'decimal')).toBe(
        'A System.Decimal value that is not a finite number cannot be written as decimal'
      )
    })
  })

  describe('quantities', () => {
    it('writes a UCUM quantity as a UCUM Quantity', () => {
      expect(accepted(literal("5.5 'mg'"), 'Quantity')).toStrictEqual({
        value: 5.5,
        unit: 'mg',
        system: 'http://unitsofmeasure.org',
        code: 'mg',
      })
    })

    it.each([
      ['1 year', 'a'],
      ['2 months', 'mo'],
      ['3 weeks', 'wk'],
      ['4 days', 'd'],
      ['5 hours', 'h'],
      ['6 minutes', 'min'],
      ['7 seconds', 's'],
      ['8 milliseconds', 'ms'],
    ])('gives the calendar duration %s the UCUM code %s', (expression, code) => {
      expect((accepted(literal(expression), 'Duration') as { code: string }).code).toBe(code)
    })

    it.each(['Age', 'Count', 'Distance', 'Duration', 'SimpleQuantity', 'MoneyQuantity'])(
      'writes a quantity as %s',
      target => {
        expect(accepted(literal("1 'a'"), target)).toMatchObject({ value: 1, code: 'a' })
      }
    )

    it('does not write a quantity as a primitive or another complex type', () => {
      expect(refusal(literal("1 'mg'"), 'decimal')).toBe(
        'A System.Quantity value cannot be written to an element of type decimal'
      )
      expect(refusal(literal("1 'mg'"), 'Coding')).toBe(
        'A System.Quantity value cannot be written to an element of type Coding'
      )
    })
  })

  describe('complex values', () => {
    it('copies a value of the same type', () => {
      const coding = { system: 'http://example.org/codes', code: 'a', extension: [{ url: 'urn:x' }] }
      const written = accepted(fhir('Coding', coding), 'Coding')
      expect(written).toStrictEqual(coding)
      expect(written).not.toBe(coding)
      expect((written as typeof coding).extension).not.toBe(coding.extension)
    })

    it('writes a subtype to its parent type, and not the other way', () => {
      expect(accepted(fhir('Age', { value: 3, unit: 'a' }), 'Quantity')).toStrictEqual({ value: 3, unit: 'a' })
      expect(refusal(fhir('Quantity', { value: 3 }), 'Age')).toBe(
        'A FHIR.Quantity value cannot be written to an element of type Age'
      )
    })

    it('writes a resource to a Resource element, and any value to Element', () => {
      const medication = { resourceType: 'Medication', id: 'm1' }
      expect(accepted(fhir('Medication', medication), 'Resource')).toStrictEqual(medication)
      expect(accepted(fhir('Medication', medication), 'DomainResource')).toStrictEqual(medication)
      expect(accepted(fhir('HumanName', { family: 'x' }), 'Element')).toStrictEqual({ family: 'x' })
    })

    it('writes a backbone element to the same backbone element', () => {
      const item = { linkId: 'a' }
      expect(accepted(fhir('QuestionnaireResponse.item', item), 'QuestionnaireResponse.item')).toStrictEqual(item)
      expect(refusal(fhir('QuestionnaireResponse.item', item), 'Questionnaire.item')).toBe(
        'A FHIR.QuestionnaireResponse.item value cannot be written to an element of type Questionnaire.item'
      )
    })

    it.each([
      ['Coding', 'CodeableConcept'],
      ['Reference', 'Identifier'],
      ['Medication', 'Reference'],
      ['HumanName', 'string'],
    ])('does not write a %s as %s', (source, target) => {
      expect(refusal(fhir(source, {}), target)).toBe(
        `A FHIR.${source} value cannot be written to an element of type ${target}`
      )
    })

    it('does not write a string into a Reference', () => {
      expect(refusal(literal("'urn:uuid:0d6b7f0e-1c3a-4b8e-9a52-6f1d2c3b4a59'"), 'Reference')).toBe(
        'A System.String value cannot be written to an element of type Reference'
      )
    })

    it('refuses an untyped object', () => {
      expect(refusal({ type: 'Object', value: {} }, 'Coding')).toBe(
        'A Object value cannot be written to an element of type Coding'
      )
    })
  })

  it('takes a target named with its namespace, or as the System type the model uses', () => {
    expect(accepted(literal("'x'"), 'FHIR.string')).toBe('x')
    expect(accepted(literal("'x'"), 'System.String')).toBe('x')
    expect(accepted(literal('@2024-03-01'), 'System.Date')).toBe('2024-03-01')
  })

  it.each([
    ["'Jane Doe'", 'Reference'],
    ["'Jane Doe'", 'date'],
    ["'Jane Doe'", 'id'],
    ["'Jane Doe'", 'integer'],
  ])('names types only when it refuses %s as %s', (expression, target) => {
    expect(refusal(literal(expression), target)).not.toContain('Jane')
  })

  it('needs an engine with a model', () => {
    expect(() => new FhirPathEngine().toFhirJson(literal('1'), 'integer')).toThrow(
      'toFhirJson() needs an engine with a model'
    )
  })
})

describe('jsonElement()', () => {
  it.each([
    ['Observation', 'status', { key: 'status', type: 'code', isCollection: false, isPrimitive: true }],
    [
      'Observation',
      'effectiveDateTime',
      { key: 'effectiveDateTime', type: 'dateTime', isCollection: false, isPrimitive: true },
    ],
    [
      'Observation',
      'valueQuantity',
      { key: 'valueQuantity', type: 'Quantity', isCollection: false, isPrimitive: false },
    ],
    ['Observation', 'valueString', { key: 'valueString', type: 'string', isCollection: false, isPrimitive: true }],
    [
      'Observation',
      'valueCodeableConcept',
      { key: 'valueCodeableConcept', type: 'CodeableConcept', isCollection: false, isPrimitive: false },
    ],
    ['Patient', 'name', { key: 'name', type: 'HumanName', isCollection: true, isPrimitive: false }],
    ['Patient', 'contact', { key: 'contact', type: 'Patient.contact', isCollection: true, isPrimitive: false }],
    ['Patient.contact', 'name', { key: 'name', type: 'HumanName', isCollection: false, isPrimitive: false }],
    [
      'Patient',
      'multipleBirthInteger',
      { key: 'multipleBirthInteger', type: 'integer', isCollection: false, isPrimitive: true },
    ],
    ['HumanName', 'given', { key: 'given', type: 'string', isCollection: true, isPrimitive: true }],
    ['Questionnaire.item', 'item', { key: 'item', type: 'Questionnaire.item', isCollection: true, isPrimitive: false }],
    ['Bundle.entry', 'resource', { key: 'resource', type: 'Resource', isCollection: false, isPrimitive: false }],
    ['Patient', 'contained', { key: 'contained', type: 'Resource', isCollection: true, isPrimitive: false }],
    [
      'Extension',
      'valueCodeableConcept',
      { key: 'valueCodeableConcept', type: 'CodeableConcept', isCollection: false, isPrimitive: false },
    ],
    ['Coding', 'extension', { key: 'extension', type: 'Extension', isCollection: true, isPrimitive: false }],
    ['Patient', 'id', { key: 'id', type: 'string', isCollection: false, isPrimitive: true }],
    ['FHIR.Patient', 'active', { key: 'active', type: 'boolean', isCollection: false, isPrimitive: true }],
  ])('%s.%s', (type, key, expected) => {
    expect(r4.jsonElement(type, key)).toStrictEqual(expected)
  })

  it.each([
    ['Patient', 'id'],
    ['Coding', 'id'],
    ['Extension', 'url'],
  ])('%s.%s is a primitive', (type, key) => {
    expect(r4.jsonElement(type, key)?.isPrimitive).toBe(true)
  })

  it.each(['string', 'dateTime', 'code', 'System.String'])(
    'gives a %s primitive extensions and an id, for its `_name` element',
    type => {
      expect(r4.jsonElement(type, 'extension')).toMatchObject({ type: 'Extension', isCollection: true })
      expect(r4.jsonElement(type, 'id')?.isPrimitive).toBe(true)
    }
  )

  it.each([
    ['Patient', 'nmae'],
    ['Observation', 'value'],
    ['Observation', 'valueFoo'],
    ['Observation', 'valueCoding'],
    ['Observation', 'effectivedatetime'],
    ['Observation', 'valueDATETIME'],
    ['Unknown', 'id'],
  ])('%s.%s is not an element', (type, key) => {
    expect(r4.jsonElement(type, key)).toBeUndefined()
  })

  it('needs an engine with a model', () => {
    expect(() => new FhirPathEngine().jsonElement('Patient', 'id')).toThrow(
      'jsonElement() needs an engine with a model'
    )
  })
})
