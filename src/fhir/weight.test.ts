import { describe, expect, it } from 'vitest'

import { analyzeExpressionDetailed } from '../analyzer/analyze.ts'
import { compile } from '../api/compile.ts'
import { evaluate, evaluateAsync } from '../api/evaluate.ts'
import { FhirPathAsyncRequiredError, FhirPathRuntimeError } from '../errors.ts'
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
    // ordinal() is the SDC name before weight(), still used by R4-era questionnaires.
    expect(evaluate('item.item.answer.ordinal()', response, options)).toEqual([0, 2.5, 2.5])
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
    // A bare code names its CodeSystem through its element's binding, so the lookup goes to the provider.
    expect(() => evaluate('gender.weight()', { resourceType: 'Patient', gender: 'male' }, options)).toThrow(
      'weight() needs evaluateAsync() with options.terminology'
    )
    expect(() => evaluate('intent.weight()', { resourceType: 'Task', intent: 'order' }, options)).toThrow(
      'weight() cannot resolve the CodeSystem binding of FHIR.Task.intent of a code'
    )
    // A string literal is a System.String, not a FHIR code: ineligible, so empty.
    expect(evaluate("'male'.weight()", {}, options)).toEqual([])
    expect(() => evaluate('gender.weight()', { resourceType: 'Patient', gender: 'male' }, options)).toThrow(
      FhirPathAsyncRequiredError
    )
  })

  it('reports a missing provider in an async evaluation as configuration, not as a need for evaluateAsync()', async () => {
    const patient = { resourceType: 'Patient', gender: 'male' }
    const failure = await evaluateAsync('gender.weight()', patient, options).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(FhirPathRuntimeError)
    expect(failure).not.toBeInstanceOf(FhirPathAsyncRequiredError)
    expect((failure as Error).message).toBe('weight() needs options.terminology')
    await expect(evaluateAsync('%terminologies', patient, options)).rejects.toThrow(
      '%terminologies needs options.terminology'
    )
    expect(() => evaluate('%terminologies', patient, options)).toThrow(FhirPathAsyncRequiredError)
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
    for (const name of ['weight', 'ordinal']) {
      const result = analyzeExpressionDetailed(`QuestionnaireResponse.item.answer.value.${name}()`, { model: r4Model })
      expect(result.diagnostics).toEqual([])
      expect(result.result.types).toEqual(['System.Decimal'])
      expect(result.result.single).toBe(false)
    }
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

    it('reads the compose concept when the expansion entry carries no weight', async () => {
      const withBoth = valueSet([scored('a', 3)], {
        expansion: { timestamp: '2026-10-19', contains: [{ system: csUrl, code: 'a' }] },
      })
      const q = { resourceType: 'Questionnaire', item: [item('#vs')], contained: [withBoth] }
      expect(run(q, reply(coding('a')))).toEqual([3])
      const expand = async () => withBoth
      await expect(
        evaluateAsync('item.answer.value.weight()', reply(coding('a')), {
          model: r4Model,
          terminology: { expand },
          env: { questionnaire: { resourceType: 'Questionnaire', item: [item(vsUrl)] } },
        })
      ).resolves.toEqual([3])
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
      const integer = codeSystem([{ code: 'a', property: [{ code: 'itemWeight', valueInteger: 2 }] }], {
        property: [{ code: 'itemWeight', type: 'integer' }],
      })
      for (const [cs, expected] of [
        [byUri, [2.5]],
        [byCode, [0]],
        [integer, [2]],
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
      // The message names the CodeSystem, never the answered code.
      expect(() => run(q('complete'), reply(coding('missing')))).toThrow(
        new FhirPathRuntimeError('weight() cannot find a code in CodeSystem urn:scores')
      )
      expect(() => run(q('fragment'), reply(coding('missing')))).toThrow(
        'weight() needs evaluateAsync() with options.terminology'
      )
      // An unversioned CodeSystem stands in for any version; one with another version goes to the provider.
      expect(run(q('complete'), reply({ ...coding('a'), version: '9' }))).toEqual([1])
      const versioned = {
        resourceType: 'Questionnaire',
        item: [item()],
        contained: [codeSystem([scored('a', 1)], { version: '1' })],
      }
      expect(() => run(versioned, reply({ ...coding('a'), version: '9' }))).toThrow(
        'weight() needs evaluateAsync() with options.terminology'
      )
    })

    it('applies the version rules across contained CodeSystems', () => {
      const q = (...versions: [string | undefined, number][]) => ({
        resourceType: 'Questionnaire',
        item: [item()],
        contained: versions.map(([version, weight], index) =>
          codeSystem([scored('a', weight)], { id: `cs${index}`, ...(version && { version }) })
        ),
      })
      expect(run(q(['1', 2], ['2', 5]), reply({ ...coding('a'), version: '2' }))).toEqual([5])
      expect(run(q(['1', 2], [undefined, 5]), reply({ ...coding('a'), version: '9' }))).toEqual([5])
      expect(() => run(q(['1', 2], ['2', 5]), reply(coding('a')))).toThrow(
        new FhirPathRuntimeError(
          'weight() finds different weights for a code in CodeSystem urn:scores across code system versions; the Coding names none'
        )
      )
      expect(run(q(['1', 3], ['2', 3]), reply(coding('a')))).toEqual([3])
      // Two listings of the Coding's own version that disagree; neither the code nor the version is named.
      expect(() => run(q(['2', 2], ['2', 5]), reply({ ...coding('a'), version: '2' }))).toThrow(
        new FhirPathRuntimeError(
          "weight() finds different weights for a code in CodeSystem urn:scores for the Coding's version"
        )
      )
    })

    it('fails on a malformed contained CodeSystem weight instead of dropping the score', () => {
      const q = {
        resourceType: 'Questionnaire',
        item: [item()],
        contained: [codeSystem([{ code: 'a', extension: [{ url: ordinalUrl, valueString: '3' }] }])],
      }
      expect(() => run(q, reply(coding('a')))).toThrow('weight() requires a numeric valueDecimal')
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

describe('weight() across code system versions', () => {
  const system = 'urn:versioned'
  const reply = (version?: string) => ({
    resourceType: 'QuestionnaireResponse',
    item: [{ linkId: 'q', answer: [{ valueCoding: { system, code: 'yes', ...(version && { version }) } }] }],
  })
  const concept = (weight: number) => ({ code: 'yes', extension: score(weight) })
  const include = (weight: number, version?: string) => ({
    system,
    ...(version && { version }),
    concept: [concept(weight)],
  })
  const entry = (weight: number, version?: string) => ({
    system,
    code: 'yes',
    ...(version && { version }),
    extension: score(weight),
  })
  const questionnaire = (valueSet: object) => ({
    resourceType: 'Questionnaire',
    item: [{ linkId: 'q', type: 'choice', answerValueSet: '#vs' }],
    contained: [{ resourceType: 'ValueSet', id: 'vs', status: 'active', ...valueSet }],
  })
  const run = (valueSet: object, version?: string) =>
    evaluate('item.answer.value.weight()', reply(version), {
      model: r4Model,
      env: { questionnaire: questionnaire(valueSet) },
    })
  const composed = { compose: { include: [include(2, 'v1'), include(5, 'v2')] } }
  const expanded = { expansion: { timestamp: '2026-10-22', contains: [entry(2, 'v1'), entry(5, 'v2')] } }

  it('selects the listing with the Coding version in compose.include and expansion.contains', () => {
    expect(run(composed, 'v2')).toEqual([5])
    expect(run(composed, 'v1')).toEqual([2])
    expect(run(expanded, 'v2')).toEqual([5])
    expect(run(expanded, 'v1')).toEqual([2])
  })

  it('lets a listing without a version, or with the * wildcard, stand in for any version', () => {
    expect(run({ compose: { include: [include(3)] } }, 'v9')).toEqual([3])
    expect(run({ compose: { include: [include(3, '*')] } }, 'v9')).toEqual([3])
    expect(run({ expansion: { timestamp: '2026-10-22', contains: [entry(3)] } }, 'v9')).toEqual([3])
    // A listing that names the version wins over the one for any version.
    expect(run({ compose: { include: [include(3), include(5, 'v2')] } }, 'v2')).toEqual([5])
    expect(run({ compose: { include: [include(3, '*'), include(5, 'v2')] } }, 'v2')).toEqual([5])
  })

  it('leaves a version the value set does not list to the CodeSystem', () => {
    expect(() => run(composed, 'v3')).toThrow('weight() needs evaluateAsync() with options.terminology')
    expect(() => run(expanded, 'v3')).toThrow('weight() needs evaluateAsync() with options.terminology')
  })

  it('refuses to choose between conflicting weights for a Coding without a version', () => {
    const conflict = /^weight\(\) finds different weights for a code in ValueSet #vs across code system versions/
    expect(() => run(composed)).toThrow(conflict)
    expect(() => run(expanded)).toThrow(conflict)
    expect(() => run({ compose: { include: [include(3), include(5, 'v2')] } })).toThrow(conflict)
    // Agreeing listings, or one weighted listing, are not a conflict.
    expect(run({ compose: { include: [include(4, 'v1'), include(4, 'v2')] } })).toEqual([4])
    expect(
      run({ compose: { include: [include(4, 'v1'), { system, version: 'v2', concept: [{ code: 'yes' }] }] } })
    ).toEqual([4])
  })

  it('keeps the expansion ahead of compose for the version it lists', () => {
    const both = {
      compose: { include: [include(1, 'v2')] },
      expansion: { timestamp: '2026-10-22', contains: [entry(5, 'v2'), { system, code: 'yes', version: 'v1' }] },
    }
    expect(run(both, 'v2')).toEqual([5])
    // The v1 expansion entry has no weight and compose lists no v1 concept.
    expect(() => run(both, 'v1')).toThrow('weight() needs evaluateAsync() with options.terminology')
  })
})

describe('weight() on a bare code', () => {
  const genderSystem = 'http://hl7.org/fhir/administrative-gender'
  const codeSystem = (concept: object[], extra: object = {}) => ({
    resourceType: 'CodeSystem',
    id: 'gender',
    url: genderSystem,
    status: 'active',
    content: 'complete',
    concept,
    ...extra,
  })
  const patient = (contained: object[], gender = 'female') => ({ resourceType: 'Patient', gender, contained })
  const options = { model: r4Model }

  it("reads the CodeSystem of the element's required binding from a contained CodeSystem", () => {
    const scored = codeSystem([
      { code: 'female', extension: score(4) },
      { code: 'male', extension: score(1) },
    ])
    expect(evaluate('gender.weight()', patient([scored]), options)).toEqual([4])
    expect(
      evaluate('contact.gender.weight()', { ...patient([scored]), contact: [{ gender: 'male' }] }, options)
    ).toEqual([1])
    // Typed results keep the element they were read from.
    const typed = compile('gender').evaluateTyped(patient([scored]), options)
    expect(evaluate('%gender.weight()', {}, { ...options, vars: { gender: typed } })).toEqual([4])
    expect(evaluate('gender.weight()', patient([codeSystem([{ code: 'female' }])]), options)).toEqual([])
    expect(() => evaluate('gender.weight()', patient([scored], 'other'), options)).toThrow(
      new FhirPathRuntimeError(`weight() cannot find a code in CodeSystem ${genderSystem}`)
    )
  })

  it('looks the code up through the provider with the bound system', async () => {
    const calls: unknown[] = []
    const terminology: TerminologyProvider = {
      lookup: async (coded, params) => {
        calls.push([coded, params])
        return {
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'property',
              part: [
                { name: 'code', valueCode: 'itemWeight' },
                { name: 'value', valueDecimal: 2.5 },
              ],
            },
          ],
        }
      },
    }
    await expect(evaluateAsync('gender.weight()', patient([]), { ...options, terminology })).resolves.toEqual([2.5])
    expect(calls).toEqual([[{ system: genderSystem, code: 'female' }, 'property=itemWeight']])
  })

  it('reports a code whose binding names no single CodeSystem, and a code outside any element', () => {
    expect(() => evaluate('intent.weight()', { resourceType: 'Task', intent: 'order' }, options)).toThrow(
      'cannot resolve the CodeSystem binding of FHIR.Task.intent'
    )
    expect(evaluate("'female'.weight()", patient([]), options)).toEqual([])
    expect(() =>
      evaluate('gender.weight()', patient([]), {
        model: {
          namespace: r4Model.namespace,
          resolveType: r4Model.resolveType,
          getElement: r4Model.getElement,
          isSubtypeOf: r4Model.isSubtypeOf,
        },
      })
    ).toThrow('cannot resolve the CodeSystem binding of FHIR.Patient.gender')
  })
})
