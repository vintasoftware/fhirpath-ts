import { describe, expect, it } from 'vitest'

import { analyzeExpressionDetailed } from '../analyzer/analyze.ts'
import { compile } from '../api/compile.ts'
import { evaluate, evaluateAsync } from '../api/evaluate.ts'
import { r4Model } from '../r4/index.ts'
import type { TerminologyProvider } from '../terminology/provider.ts'

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
      'weight() needs evaluateAsync() with options.terminology'
    )
  })

  it('handles nested items under answers', () => {
    const qr = {
      resourceType: 'QuestionnaireResponse',
      item: [{ linkId: 'group', answer: [{ valueBoolean: true, item: [{ linkId: 'second', answer: [answer] }] }] }],
    }
    expect(evaluate('item.answer.item.answer.value.weight()', qr, options)).toEqual([2.5])
  })

  it('returns empty for empty, ineligible, unanswered and unweighted values without a CodeSystem', () => {
    expect(evaluate('{}.weight()', response, options)).toEqual([])
    expect(evaluate('1.weight()', response, options)).toEqual([])
    expect(evaluate('weight()', {}, options)).toEqual([])
    const q = {
      resourceType: 'Questionnaire',
      item: [{ linkId: 'q', answerOption: [{ valueString: 'a' }, { valueCoding: { code: 'b' } }] }],
    }
    const qr = {
      resourceType: 'QuestionnaireResponse',
      item: [{ linkId: 'q', answer: [{}, { valueString: 'a' }, { valueCoding: { code: 'b' } }] }],
    }
    expect(evaluate('item.answer.weight()', qr, { model: r4Model, env: { questionnaire: q } })).toEqual([])
    expect(
      evaluate('code.coding.weight()', { resourceType: 'Observation', code: { coding: [{ code: 'a' }] } }, options)
    ).toEqual([])
  })

  it('reports a missing model, questionnaires, items, ValueSets and CodeSystems', () => {
    expect(() => evaluate('item.item.answer.valueCoding.weight()', response, { env: { questionnaire } })).toThrow(
      'needs a model'
    )
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
    // A value set without the code leaves the lookup to the CodeSystem.
    expect(() =>
      evaluate('item.item.answer.weight()', response, { model: r4Model, env: { questionnaire: q } })
    ).toThrow('weight() needs evaluateAsync() with options.terminology')
    expect(() =>
      evaluate('item.item.answer.weight()', response, {
        model: r4Model,
        env: { questionnaire: { ...q, item: [{ linkId: 'first', answerValueSet: '#missing' }] } },
      })
    ).toThrow('weight() cannot find the contained ValueSet #missing')
    expect(() =>
      evaluate('code.coding.weight()', { resourceType: 'Observation', code: { coding: [coding('a')] } }, options)
    ).toThrow('weight() needs evaluateAsync() with options.terminology')
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

  describe('ValueSet and CodeSystem lookup', () => {
    const vsUrl = 'http://example.org/ValueSet/scores'
    const csUrl = 'urn:scores'
    const item = (answerValueSet?: string) => ({
      linkId: 'q',
      type: 'choice',
      ...(answerValueSet && { answerValueSet }),
    })
    const reply = (...codings: object[]) => ({
      resourceType: 'QuestionnaireResponse',
      item: [{ linkId: 'q', answer: codings.map(valueCoding => ({ valueCoding })) }],
    })
    const scored = (code: string, weight?: number, url = weightUrl) => ({
      code,
      ...(weight !== undefined && { extension: score(weight, url) }),
    })
    const codeSystem = (concept: object[], extra: object = {}) => ({
      resourceType: 'CodeSystem',
      url: csUrl,
      status: 'active',
      content: 'complete',
      concept,
      ...extra,
    })
    const valueSet = (concept: object[], extra: object = {}) => ({
      resourceType: 'ValueSet',
      id: 'vs',
      url: vsUrl,
      status: 'active',
      compose: { include: [{ system: csUrl, concept }] },
      ...extra,
    })
    const run = (q: object, qr: object) =>
      evaluate('item.answer.value.weight()', qr, { model: r4Model, env: { questionnaire: q } })

    it('reads a contained answerValueSet by id, or by url and version', () => {
      const q = (answerValueSet: string) => ({
        resourceType: 'Questionnaire',
        item: [item(answerValueSet)],
        contained: [valueSet([scored('a', 2), scored('b', 0), scored('c', -1.5, ordinalUrl)], { version: '2' })],
      })
      const answers = reply(coding('a'), coding('b'), coding('c'), coding('a'))
      for (const canonical of ['#vs', vsUrl, `${vsUrl}|2`]) {
        expect(run(q(canonical), answers)).toEqual([2, 0, -1.5, 2])
      }
    })

    it('reads nested expansion entries, matching system and code exactly', () => {
      const q = {
        resourceType: 'Questionnaire',
        item: [item('#vs')],
        contained: [
          {
            resourceType: 'ValueSet',
            id: 'vs',
            status: 'active',
            expansion: {
              timestamp: '2026-10-19',
              contains: [
                { system: 'urn:other', code: 'a', extension: score(9) },
                { abstract: true, contains: [{ system: csUrl, code: 'a', extension: score(4) }] },
              ],
            },
          },
        ],
      }
      expect(run(q, reply(coding('a'), coding('a', 'urn:other')))).toEqual([4, 9])
    })

    it('prefers answers, values, and answer options over the value set, and the value set over the CodeSystem', () => {
      const q = {
        resourceType: 'Questionnaire',
        item: [{ ...item('#vs'), answerOption: [{ valueCoding: coding('a'), extension: score(1) }] }],
        contained: [
          valueSet([scored('a', 2), scored('b', 3), scored('c')]),
          codeSystem([scored('c', 5), scored('b', 7)]),
        ],
      }
      const qr = {
        resourceType: 'QuestionnaireResponse',
        item: [
          {
            linkId: 'q',
            answer: [
              { valueCoding: coding('b'), extension: score(10) },
              { valueCoding: { ...coding('b'), extension: score(11) } },
              { valueCoding: coding('a') },
              { valueCoding: coding('b') },
              { valueCoding: coding('c') },
            ],
          },
        ],
      }
      expect(run(q, qr)).toEqual([10, 11, 1, 3, 5])
    })

    it('reads contained CodeSystems from the answer resource, its container, or the Questionnaire', () => {
      const q = { resourceType: 'Questionnaire', item: [item()], contained: [codeSystem([scored('q', 1)])] }
      const nestedConcepts = codeSystem([{ code: 'parent', concept: [scored('child', 6)] }])
      expect(run(q, { ...reply(coding('q')) })).toEqual([1])
      expect(run({ ...q, contained: [] }, { ...reply(coding('child')), contained: [nestedConcepts] })).toEqual([6])
      const observation = {
        resourceType: 'Observation',
        status: 'final',
        code: { text: 'outer' },
        contained: [
          nestedConcepts,
          { resourceType: 'Observation', status: 'final', code: { coding: [coding('child')] } },
        ],
      }
      expect(evaluate('contained.ofType(Observation).code.coding.weight()', observation, { model: r4Model })).toEqual([
        6,
      ])
    })

    it('reads a CodeSystem weight property declared by uri or by the itemWeight code', () => {
      const byUri = codeSystem([{ code: 'a', property: [{ code: 'w', valueDecimal: 2.5 }] }], {
        property: [{ code: 'w', uri: 'http://hl7.org/fhir/concept-properties#itemWeight', type: 'decimal' }],
      })
      const byCode = codeSystem([{ code: 'a', property: [{ code: 'itemWeight', valueDecimal: 0 }] }], {
        property: [{ code: 'itemWeight', type: 'decimal' }],
      })
      for (const [cs, expected] of [
        [byUri, [2.5]],
        [byCode, [0]],
      ] as const) {
        expect(run({ resourceType: 'Questionnaire', item: [item()], contained: [cs] }, reply(coding('a')))).toEqual(
          expected
        )
      }
    })

    it('gives empty for a contained concept without a weight, and rejects a non-numeric weight property', () => {
      const declared = { property: [{ code: 'itemWeight', type: 'decimal' }] }
      const q = (concept: object) => ({
        resourceType: 'Questionnaire',
        item: [item()],
        contained: [codeSystem([concept], declared)],
      })
      expect(run(q({ code: 'a', property: [{ code: 'other', valueString: 'x' }] }), reply(coding('a')))).toEqual([])
      expect(() =>
        run(q({ code: 'a', property: [{ code: 'itemWeight', valueString: '3' }] }), reply(coding('a')))
      ).toThrow('weight() requires a numeric CodeSystem itemWeight')
    })

    it('looks up a Coding outside any resource through the provider', async () => {
      const lookup = async () => ({
        resourceType: 'Parameters',
        parameter: [
          {
            name: 'property',
            part: [
              { name: 'code', valueCode: 'itemWeight' },
              { name: 'value', valueDecimal: 4 },
            ],
          },
        ],
      })
      await expect(
        evaluateAsync(
          "Coding { system: 'urn:scores', code: 'a' }.weight()",
          {},
          { model: r4Model, terminology: { lookup } }
        )
      ).resolves.toEqual([4])
    })

    it('fails when a complete CodeSystem lacks the code, and leaves partial ones to the provider', () => {
      const q = (content: string) => ({
        resourceType: 'Questionnaire',
        item: [item()],
        contained: [codeSystem([scored('a', 1)], { content })],
      })
      expect(() => run(q('complete'), reply(coding('missing')))).toThrow(
        "weight() cannot find code 'missing' in CodeSystem urn:scores"
      )
      expect(() => run(q('fragment'), reply(coding('missing')))).toThrow(
        'weight() needs evaluateAsync() with options.terminology'
      )
      // A Coding version the contained CodeSystem does not have also goes to the provider.
      expect(() => run(q('complete'), reply({ ...coding('a'), version: '9' }))).toThrow(
        'weight() needs evaluateAsync() with options.terminology'
      )
    })

    it('fails the whole collection when one answer needs an unavailable lookup', () => {
      const q = { resourceType: 'Questionnaire', item: [item()], contained: [codeSystem([scored('a', 1)])] }
      expect(() => run(q, reply(coding('a'), coding('x', 'urn:elsewhere')))).toThrow(
        'weight() needs evaluateAsync() with options.terminology'
      )
    })

    it('expands an external answerValueSet through the provider before looking up the CodeSystem', async () => {
      const calls: string[] = []
      const terminology: TerminologyProvider = {
        expand: async canonical => {
          calls.push(`expand ${String(canonical)}`)
          if (canonical !== vsUrl) return undefined
          return {
            resourceType: 'ValueSet',
            status: 'active',
            expansion: {
              timestamp: '2026-10-19',
              contains: [
                { system: csUrl, code: 'a', extension: score(2) },
                { system: csUrl, code: 'b' },
              ],
            },
          }
        },
        lookup: async coded => {
          calls.push(`lookup ${(coded as { code: string }).code}`)
          return {
            resourceType: 'Parameters',
            parameter: [
              {
                name: 'property',
                part: [
                  { name: 'code', valueCode: 'itemWeight' },
                  { name: 'value', valueDecimal: 8 },
                ],
              },
            ],
          }
        },
      }
      const q = (answerValueSet: string) => ({ resourceType: 'Questionnaire', item: [item(answerValueSet)] })
      const options = (answerValueSet: string) => ({
        model: r4Model,
        terminology,
        env: { questionnaire: q(answerValueSet) },
      })
      await expect(
        evaluateAsync('item.answer.value.weight()', reply(coding('a'), coding('b'), coding('a')), options(vsUrl))
      ).resolves.toEqual([2, 8, 2])
      expect(calls).toEqual([`expand ${vsUrl}`, 'lookup b'])
      await expect(
        evaluateAsync('item.answer.value.weight()', reply(coding('a')), options('http://example.org/ValueSet/unknown'))
      ).rejects.toThrow('weight() cannot resolve the ValueSet http://example.org/ValueSet/unknown')
    })
  })
})
