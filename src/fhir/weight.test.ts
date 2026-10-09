import { describe, expect, it } from 'vitest'

import { analyzeExpressionDetailed } from '../analyzer/analyze.ts'
import { compile } from '../api/compile.ts'
import { evaluate } from '../api/evaluate.ts'
import { r4Model } from '../r4/index.ts'

const ordinalUrl = 'http://hl7.org/fhir/StructureDefinition/ordinalValue'
const weightUrl = 'http://hl7.org/fhir/StructureDefinition/itemWeight'
const score = (valueDecimal: number, url = ordinalUrl) => [{ url, valueDecimal }]
const coding = (code: string, system = 'urn:scores') => ({ system, code })
const questionnaire = {
  resourceType: 'Questionnaire',
  item: [
    {
      linkId: 'group',
      type: 'group',
      item: [
        { linkId: 'first', type: 'choice', answerOption: [{ valueCoding: coding('yes'), extension: score(0) }] },
        {
          linkId: 'second',
          type: 'choice',
          answerOption: [{ valueCoding: coding('yes'), extension: score(2.5, weightUrl) }],
        },
      ],
    },
  ],
}
const answer = { valueCoding: { ...coding('yes'), display: 'Different display' } }
const response = {
  resourceType: 'QuestionnaireResponse',
  item: [
    {
      linkId: 'group',
      item: [
        { linkId: 'first', answer: [answer] },
        { linkId: 'second', answer: [answer, answer] },
      ],
    },
  ],
}
const options = { model: r4Model, env: { questionnaire } }

describe('SDC weight()', () => {
  it('scores each answer against its own item, including repeated equal answers and zero weights', () => {
    expect(evaluate('item.item.answer.weight()', response, options)).toEqual([0, 2.5, 2.5])
    expect(evaluate('item.item.answer.value.weight().sum()', response, options)).toEqual([5])
    expect(evaluate('repeat(item).answer.value.weight().sum()', response, options)).toEqual([5])
    expect(evaluate('descendants().ofType(Coding).weight().sum()', response, options)).toEqual([5])
  })

  it('keeps answer context in saved typed variables', () => {
    const values = compile('item.item.answer.value').evaluateTyped(response, options)
    expect(evaluate('%answers.weight()', {}, { ...options, vars: { answers: values } })).toEqual([0, 2.5, 2.5])
    const q = compile('$this').evaluateTyped(questionnaire, options)
    expect(evaluate('%answers.weight()', {}, { model: r4Model, vars: { answers: values, questionnaire: q } })).toEqual([
      0, 2.5, 2.5,
    ])
  })

  it('prefers an embedded value weight to the questionnaire option', () => {
    const resource = {
      resourceType: 'QuestionnaireResponse',
      item: [{ linkId: 'second', answer: [{ valueCoding: { ...coding('yes'), extension: score(-1) } }] }],
    }
    expect(evaluate('item.answer.value.weight()', resource, options)).toEqual([-1])
    expect(evaluate('item.answer.weight()', resource, options)).toEqual([-1])
  })

  it('reads answer-level weights without a questionnaire', () => {
    const resource = {
      resourceType: 'QuestionnaireResponse',
      item: [{ linkId: 'q', answer: [{ valueString: 'yes', extension: score(3) }] }],
    }
    expect(evaluate('item.answer.weight()', resource, { model: r4Model })).toEqual([3])
    expect(evaluate('item.answer.value.weight()', resource, { model: r4Model })).toEqual([3])
  })

  it('gives answer-level overrides precedence over value and option weights', () => {
    const resource = {
      resourceType: 'QuestionnaireResponse',
      item: [
        { linkId: 'first', answer: [{ extension: score(3), valueCoding: { ...coding('yes'), extension: score(1) } }] },
      ],
    }
    expect(evaluate('item.answer.value.weight()', resource, options)).toEqual([3])
    expect(evaluate('item.answer.weight()', resource, options)).toEqual([3])
  })

  it('reads primitive sibling extensions, including a value absent from JSON', () => {
    const resource = {
      resourceType: 'QuestionnaireResponse',
      item: [
        {
          linkId: 'q',
          answer: [
            { valueString: 'yes', _valueString: { extension: score(1) } },
            { _valueInteger: { extension: score(2) } },
          ],
        },
      ],
    }
    expect(evaluate('item.answer.value.weight()', resource, { model: r4Model })).toEqual([1, 2])
    expect(evaluate('item.answer.weight()', resource, { model: r4Model })).toEqual([1, 2])
  })

  it('reads scores directly from answer options and Codings outside a response', () => {
    expect(evaluate('item.item.answerOption.weight()', questionnaire, options)).toEqual([0, 2.5])
    expect(
      evaluate(
        'code.coding.weight()',
        { resourceType: 'Observation', code: { coding: [{ ...coding('a'), extension: score(4) }] } },
        options
      )
    ).toEqual([4])
  })

  it.each([
    ['valueInteger', 7],
    ['valueString', 'Yes'],
    ['valueDate', '2026-01-01'],
    ['valueTime', '12:30:00'],
  ])('matches %s answer options using typed values', (property, value) => {
    const q = {
      resourceType: 'Questionnaire',
      item: [{ linkId: 'q', answerOption: [{ [property]: value, extension: score(1.5) }] }],
    }
    const qr = { resourceType: 'QuestionnaireResponse', item: [{ linkId: 'q', answer: [{ [property]: value }] }] }
    expect(evaluate('item.answer.value.weight()', qr, { model: r4Model, env: { questionnaire: q } })).toEqual([1.5])
  })

  it('requires exact primitive matches and both Coding system and code', () => {
    const q = {
      resourceType: 'Questionnaire',
      item: [
        {
          linkId: 'q',
          answerOption: [{ valueString: 'Yes', extension: score(4) }, { valueInteger: 7, extension: score(5) }, {}],
        },
      ],
    }
    const qr = { resourceType: 'QuestionnaireResponse', item: [{ linkId: 'q', answer: [{ valueString: 'yes' }] }] }
    expect(evaluate('item.answer.value.weight()', qr, { model: r4Model, env: { questionnaire: q } })).toEqual([])
    const otherSystem = {
      resourceType: 'QuestionnaireResponse',
      item: [{ linkId: 'first', answer: [{ valueCoding: coding('yes', 'urn:other') }] }],
    }
    expect(() => evaluate('item.answer.value.weight()', otherSystem, options)).toThrow(
      /terminology provider|CodeSystem/
    )
  })

  it('handles nested items under answers', () => {
    const qr = {
      resourceType: 'QuestionnaireResponse',
      item: [{ linkId: 'group', answer: [{ valueBoolean: true, item: [{ linkId: 'second', answer: [answer] }] }] }],
    }
    expect(evaluate('item.answer.item.answer.value.weight()', qr, options)).toEqual([2.5])
  })

  it('returns empty for empty, ineligible, unanswered and unweighted non-coded values', () => {
    expect(evaluate('{}.weight()', response, options)).toEqual([])
    expect(evaluate('1.weight()', response, options)).toEqual([])
    expect(evaluate('weight()', {}, options)).toEqual([])
    const q = { resourceType: 'Questionnaire', item: [{ linkId: 'q', answerOption: [{ valueString: 'a' }] }] }
    const qr = { resourceType: 'QuestionnaireResponse', item: [{ linkId: 'q', answer: [{}, { valueString: 'a' }] }] }
    expect(evaluate('item.answer.weight()', qr, { model: r4Model, env: { questionnaire: q } })).toEqual([])
  })

  it('reports unavailable questionnaires, items, ValueSets and CodeSystems', () => {
    expect(() => evaluate('item.item.answer.weight()', response, { model: r4Model })).toThrow('%questionnaire')
    expect(() =>
      evaluate('item.item.answer.weight()', response, { model: r4Model, env: { questionnaire: response } })
    ).toThrow('%questionnaire')
    const qr = { resourceType: 'QuestionnaireResponse', item: [{ linkId: 'absent', answer: [answer] }] }
    expect(() => evaluate('item.answer.weight()', qr, options)).toThrow("linkId 'absent'")
    const q = {
      resourceType: 'Questionnaire',
      item: [{ linkId: 'first', answerValueSet: '#vs' }],
      contained: [{ resourceType: 'ValueSet', id: 'vs' }],
    }
    expect(() =>
      evaluate('item.item.answer.weight()', response, { model: r4Model, env: { questionnaire: q } })
    ).toThrow('answerValueSet')
    expect(() =>
      evaluate('code.coding.weight()', { resourceType: 'Observation', code: { coding: [coding('a')] } }, options)
    ).toThrow(/terminology provider|CodeSystem/)
    expect(() => evaluate('gender.weight()', { resourceType: 'Patient', gender: 'male' }, options)).toThrow(
      'CodeSystem'
    )
  })

  it('rejects an invalid weight instead of turning it into a zero score', () => {
    for (const valueDecimal of ['3', Number.NaN, undefined]) {
      expect(() => evaluate('weight()', { extension: [{ url: weightUrl, valueDecimal }] }, options)).toThrow(
        'valueDecimal'
      )
    }
    expect(
      evaluate('weight()', { extension: [{ url: 'other', valueDecimal: 9 }, { valueDecimal: 8 }] }, options)
    ).toEqual([])
  })

  it('declares a Decimal collection to the analyzer', () => {
    const result = analyzeExpressionDetailed('QuestionnaireResponse.item.answer.value.weight()', { model: r4Model })
    expect(result.diagnostics).toEqual([])
    expect(result.result.types).toEqual(['System.Decimal'])
    expect(result.result.single).toBe(false)
  })
})
