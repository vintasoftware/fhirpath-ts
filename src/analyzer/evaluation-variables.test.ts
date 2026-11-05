// All data in this file is synthetic.
import { describe, expect, it } from 'vitest'

import { compile } from '../api/compile.ts'
import { r4, r4Model } from '../r4/index.ts'
import type { TypedValue } from '../values/typed-value.ts'
import { analyzeExpressionDetailed, type AnalyzeOptions } from './analyze.ts'

const questionnaire = { resourceType: 'Questionnaire', status: 'active', item: [{ linkId: 'a', type: 'string' }] }
const response = {
  resourceType: 'QuestionnaireResponse',
  status: 'completed',
  item: [{ linkId: 'a', answer: [{ valueString: 'x' }] }],
}

/** The diagnostic codes of an expression analyzed with `options` on a QuestionnaireResponse item. */
function codes(expression: string, options: AnalyzeOptions): string[] {
  return analyzeExpressionDetailed(expression, {
    model: r4Model,
    inputType: 'QuestionnaireResponse.item',
    ...options,
  }).diagnostics.map(diagnostic => diagnostic.code)
}

function result(expression: string, options: AnalyzeOptions) {
  return analyzeExpressionDetailed(expression, { model: r4Model, inputType: 'QuestionnaireResponse.item', ...options })
    .result
}

describe('analyzer variables from env', () => {
  it('declares JSON with a resourceType as that resource', () => {
    const env = { questionnaire, resource: response }
    expect(codes('%questionnaire.item.linkId | %resource.item.linkId', { env })).toStrictEqual([])
    expect(codes('%questionnaire.itemm', { env })).toStrictEqual(['unknown-element'])
    expect(result('%questionnaire', { env })).toMatchObject({ types: ['FHIR.Questionnaire'], single: true })
  })

  it('declares a typed value from its type, without reading its value', () => {
    const env = { context: r4.toTyped({}, 'QuestionnaireResponse.item') }
    expect(codes('%context.answer.value', { env })).toStrictEqual([])
    expect(codes('%context.answerr', { env })).toStrictEqual(['unknown-element'])
    expect(result('%context', { env })).toMatchObject({ types: ['FHIR.QuestionnaireResponse.item'], single: true })
  })

  it('declares a FHIR type with no type without a model', () => {
    const env = { context: r4.toTyped({}, 'QuestionnaireResponse.item'), count: 2 }
    expect(analyzeExpressionDetailed('%context', { env }).result.types).toBeUndefined()
    expect(analyzeExpressionDetailed('%count', { env }).result.types).toStrictEqual(['System.Integer'])
  })

  it('declares JSON without a resourceType with no type', () => {
    const env = { settings: { anything: 1 } }
    expect(codes('%settings.whatever', { env })).toStrictEqual([])
    // One value, so one item in a defined order, of a type the analyzer cannot tell.
    expect(result('%settings', { env })).toStrictEqual({ types: undefined, single: true, ordered: true })
  })

  it('reads names with or without %', () => {
    expect(codes('%questionnaire.itemm', { env: { '%questionnaire': questionnaire } })).toStrictEqual([
      'unknown-element',
    ])
  })

  it('lets envTypes win over the value', () => {
    const options = { env: { questionnaire }, envTypes: { questionnaire: { type: 'Patient' } } } as const
    expect(codes('%questionnaire.item', options)).toStrictEqual(['unknown-element'])
    expect(codes('%questionnaire.name', options)).toStrictEqual([])
  })
})

describe('analyzer variables from vars', () => {
  const qitem = r4.evaluateTyped('item', questionnaire)

  it('declares a typed collection from its types and size', () => {
    expect(codes('%qitem.linkId', { vars: { qitem } })).toStrictEqual([])
    expect(codes('%qitem.answer', { vars: { qitem } })).toStrictEqual(['unknown-element'])
    expect(result('%qitem', { vars: { qitem } })).toMatchObject({ types: ['FHIR.Questionnaire.item'], single: true })
    const two: TypedValue[] = [...qitem, ...qitem]
    expect(result('%qitem', { vars: { qitem: two } }).single).toBe(false)
  })

  it('declares a collection of no FHIR type with no type', () => {
    expect(result('%v', { vars: { v: [{ type: 'Object', value: {} }] } }).types).toBeUndefined()
  })

  it('types an expression from its analysis, with the variables bound before it, and does not report its own errors', () => {
    const vars = { answers: 'answer', values: '%answers.value', wrong: 'answerr' }
    expect(result('%answers', { vars })).toMatchObject({ types: ['FHIR.QuestionnaireResponse.item.answer'] })
    expect(codes('%answers.valuee', { vars })).toStrictEqual(['unknown-element'])
    expect(result('%values', { vars }).types).toContain('FHIR.string')
    expect(codes('%wrong', { vars })).toStrictEqual([])
    expect(result('%wrong', { vars }).types).toBeUndefined()
  })

  it('reads a compiled expression', () => {
    expect(result('%answers', { vars: { answers: compile('answer') } }).types).toStrictEqual([
      'FHIR.QuestionnaireResponse.item.answer',
    ])
  })

  it('lets varTypes win over the value, and declares a name only varTypes gives', () => {
    const options = {
      vars: { qitem, answers: 'answer' },
      varTypes: { qitem: { type: 'Patient' }, answers: { type: 'Coding' }, extra: { type: 'HumanName' } },
    } as const
    expect(codes('%qitem.name | %answers.code | %extra.family', options)).toStrictEqual([])
    expect(codes('%qitem.linkId', options)).toStrictEqual(['unknown-element'])
  })
})

describe('explicit variables', () => {
  it('win over the declarations derived from env and vars', () => {
    const options: AnalyzeOptions = {
      env: { questionnaire },
      vars: { qitem: r4.evaluateTyped('item', questionnaire) },
      variables: { questionnaire: {}, '%qitem': { types: ['FHIR.Patient'] } },
    }
    expect(codes('%questionnaire.itemm', options)).toStrictEqual([])
    expect(codes('%qitem.name', options)).toStrictEqual([])
    expect(codes('%qitem.linkId', options)).toStrictEqual(['unknown-element'])
  })
})

describe('the options of an evaluation', () => {
  it('analyze as they evaluate', () => {
    const [item] = r4.evaluateTyped('item', response)
    const options = {
      env: { context: item, resource: response, questionnaire },
      vars: { qitem: r4.evaluateTyped('item', questionnaire), answers: 'answer' },
    }
    const expression = "%qitem.linkId = %context.linkId and %answers.value = 'x' and %resource.status = 'completed'"
    expect(codes(expression, options)).toStrictEqual([])
    expect(r4.evaluate(expression, [item as TypedValue], options)).toStrictEqual([true])
  })
})
