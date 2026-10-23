import { readFileSync } from 'node:fs'

import type { Bundle, Questionnaire, QuestionnaireResponse, QuestionnaireResponseItem } from '@medplum/fhirtypes'
import { describe, expect, it } from 'vitest'

import { extractTemplates } from './extract.ts'

function questionnaire(name: string): Questionnaire {
  return JSON.parse(readFileSync(new URL(`../../test-data/sdc/lforms/${name}.json`, import.meta.url), 'utf8'))
}

function answer(linkId: string, value: string | number): QuestionnaireResponseItem {
  return { linkId, answer: [typeof value === 'number' ? { valueDecimal: value } : { valueString: value }] }
}

function response(): QuestionnaireResponse {
  return {
    resourceType: 'QuestionnaireResponse',
    status: 'completed',
    id: 'test-response',
    authored: '2026-10-08T10:00:00Z',
    item: [
      {
        linkId: 'patient',
        item: [
          { linkId: 'name', item: [answer('given', 'Adam'), answer('family', 'Xie')] },
          { linkId: 'gender', answer: [{ valueCoding: { code: 'male' } }] },
          answer('ihi', '111'),
          answer('mobile-phone', '123'),
        ],
      },
      { linkId: 'obs', item: [answer('height', 44), answer('weight', 55)] },
    ],
  }
}

function extract(name: string, qr = response()): Bundle {
  let allocated = 0
  return extractTemplates(questionnaire(name), qr, () => `urn:uuid:test-${++allocated}`) as unknown as Bundle
}

describe('LHC-Forms R4 extraction fixtures (ported data-level assertions)', () => {
  it.each(['questionnaire-extract-complex-template', 'questionnaire-extract-complex-template-bundle'])(
    '%s: extracts demographics, quantities, dates, and response references',
    name => {
      const bundle = extract(name)
      expect(bundle.entry).toHaveLength(3)
      const [patient, height, weight] = bundle.entry!.map(entry => entry.resource!)
      expect(patient).toMatchObject({
        resourceType: 'Patient',
        identifier: [{ type: { text: 'National Identifier (IHI)' }, system: 'http://example.org/nhio', value: '111' }],
        name: [{ text: 'Adam Xie', family: 'Xie', given: ['Adam'] }],
        telecom: [{ system: 'phone', use: 'mobile', value: '123' }],
        gender: 'male',
      })
      expect(height).toMatchObject({
        valueQuantity: { unit: 'cm', system: 'http://unitsofmeasure.org', code: 'cm', value: 4400 },
        issued: response().authored,
        effectiveDateTime: response().authored,
        derivedFrom: [{ reference: 'QuestionnaireResponse/test-response' }],
      })
      expect(weight).toMatchObject({ valueQuantity: { unit: 'kg', value: 55 } })
      expect(patient).not.toHaveProperty('_gender')
      expect(height).not.toHaveProperty('_effectiveDateTime')
      if (name === 'questionnaire-extract-complex-template') {
        expect(height).toHaveProperty('subject', bundle.entry![0]!.fullUrl)
        expect(weight).toHaveProperty('extension', [{ url: 'test extension url', valueString: 'test extension value' }])
      } else {
        expect(height).toHaveProperty('subject.reference', bundle.entry![0]!.fullUrl)
      }
      expect(bundle.entry![1]!.request).toEqual({ method: 'POST', url: 'Observation' })
    }
  )

  it('removes a resource whose context returns empty', () => {
    const qr = response()
    qr.item![1]!.item![1]!.answer = []
    expect(extract('questionnaire-extract-complex-template', qr).entry).toHaveLength(2)
  })

  it('extracts from a root template', () => {
    const qr = response()
    qr.item = [answer('height', 44)]
    const bundle = extract('questionnaire-extract-template-root-level', qr)
    expect(bundle.entry).toHaveLength(1)
    expect(bundle.entry![0]!.resource).toMatchObject({ valueQuantity: { value: 4400 } })
  })

  it('preserves repeated names and answer order', () => {
    const qr = response()
    qr.item![0]!.item = ['a', 'b'].map(prefix => ({
      linkId: 'name',
      item: [
        { linkId: 'given', answer: [{ valueString: `${prefix}1` }, { valueString: `${prefix}2` }] },
        answer('family', prefix.repeat(2)),
      ],
    }))
    expect(extract('questionnaire-extract-complex-template', qr).entry![0]!.resource).toHaveProperty('name', [
      { text: 'a1 a2 aa', family: 'aa', given: ['a1', 'a2'] },
      { text: 'b1 b2 bb', family: 'bb', given: ['b1', 'b2'] },
    ])
  })

  it('allocates distinct IDs for repeated response items', () => {
    const qr = response()
    qr.item = [{ linkId: 'obs', item: [answer('height', 44), answer('height', 55)] }]
    const entries = extract('questionnaire-extract-template-with-allocateId-on-repeating-item', qr).entry!
    expect(entries).toHaveLength(2)
    expect(entries[0]!.resource).toHaveProperty('subject', 'urn:uuid:test-1')
    expect(entries[1]!.resource).toHaveProperty('subject', 'urn:uuid:test-3')
  })

  it('populates update and conditional request fields', () => {
    const entry = extract('questionnaire-extract-template-with-subextensions').entry![0]!
    expect(entry.resource!.id).toBe('urn:uuid:test-1')
    expect(entry.fullUrl).toBe(entry.resource!.id)
    expect(entry.request).toMatchObject({
      method: 'PUT',
      url: 'Observation/urn:uuid:test-1',
      ifNoneMatch: 'urn:uuid:test-1',
      ifMatch: 'urn:uuid:test-1',
      ifNoneExist: 'urn:uuid:test-1',
    })
    expect(entry.request!.ifModifiedSince).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('prototype template semantics', () => {
  const prefix = 'http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-'
  function form(resource: unknown): Questionnaire {
    return {
      resourceType: 'Questionnaire',
      status: 'draft',
      contained: [resource],
      extension: [
        {
          url: `${prefix}templateExtract`,
          extension: [{ url: 'template', valueReference: { reference: '#template' } }],
        },
      ],
    } as Questionnaire
  }
  const value = (body: string) => ({ url: `${prefix}templateExtractValue`, valueString: body })

  it('keeps false, zero, static array members, and unrelated primitive metadata without mutating inputs', () => {
    const q = form({
      resourceType: 'Patient',
      id: 'template',
      active: true,
      _active: { extension: [value('false'), { url: 'urn:kept', valueString: 'metadata' }] },
      multipleBirthInteger: 99,
      _multipleBirthInteger: { extension: [value('0')] },
      name: [{ given: ['static', 'tail'], _given: [{ extension: [value("'replaced'")] }] }],
      telecom: [
        { system: 'phone', value: '123' },
        { extension: [{ url: `${prefix}templateExtractContext`, valueString: '{}' }], value: 'remove' },
      ],
    })
    const qr = response()
    const before = structuredClone({ q, qr })
    const bundle = extractTemplates(q, qr) as unknown as Bundle
    expect(bundle.entry![0]!.resource).toEqual({
      resourceType: 'Patient',
      active: false,
      _active: { extension: [{ url: 'urn:kept', valueString: 'metadata' }] },
      multipleBirthInteger: 0,
      name: [{ given: ['replaced', 'tail'] }],
      telecom: [{ system: 'phone', value: '123' }],
    })
    expect({ q, qr }).toEqual(before)
  })

  it('makes a named context available to child expressions with its FHIR type', () => {
    const q = form({
      resourceType: 'Patient',
      id: 'template',
      name: [
        {
          extension: [
            {
              url: `${prefix}templateExtractContext`,
              valueExpression: {
                language: 'text/fhirpath',
                name: 'nameItem',
                expression: "item.where(linkId='patient').item.where(linkId='name')",
              },
            },
          ],
          _family: { extension: [value("%nameItem.item.where(linkId='family').answer.value")] },
        },
      ],
    })
    const bundle = extractTemplates(q, response()) as unknown as Bundle
    expect(bundle.entry![0]!.resource).toHaveProperty('name', [{ family: 'Xie' }])
  })

  it('rejects multiple values for a singleton instead of keeping the first', () => {
    const q = form({ resourceType: 'Patient', id: 'template', _active: { extension: [value('true | false')] } })
    expect(() => extractTemplates(q, response())).toThrow(/multiple values for a singleton/)
  })

  it('surfaces expression errors', () => {
    const q = form({ resourceType: 'Patient', id: 'template', _active: { extension: [value('noSuchFunction()')] } })
    expect(() => extractTemplates(q, response())).toThrow(/noSuchFunction/)
  })

  it('rejects unsupported extraction per repeated answer', () => {
    const q = questionnaire('questionnaire-extract-template-with-allocateId-on-repeating-item')
    const qr = response()
    qr.item = [{ linkId: 'obs', item: [{ linkId: 'height', answer: [{ valueDecimal: 44 }, { valueDecimal: 55 }] }] }]
    expect(() => extractTemplates(q, qr)).toThrow(/per repeated answer/)
  })
})
