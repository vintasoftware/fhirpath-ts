import { readFileSync } from 'node:fs'

import type { Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes'
import fhirpathjs from 'fhirpath'
import fhirpathjsR4Model from 'fhirpath/fhir-context/r4'
import { describe, expect, it } from 'vitest'

import { compile, evaluate, type TypedValue } from '../../src/index.ts'
import { r4Model } from '../../src/r4/index.ts'

function fixture(name: string): Questionnaire {
  return JSON.parse(readFileSync(new URL(`../../test-data/sdc/lforms/${name}.json`, import.meta.url), 'utf8'))
}

const qr = {
  resourceType: 'QuestionnaireResponse',
  status: 'completed',
  item: [{ linkId: 'name', answer: [{ valueString: 'Ada' }] }],
}
const referenceModel = fhirpathjsR4Model as Parameters<typeof fhirpathjs.evaluate>[3]
const reference = (input: unknown, expression: string, env: Record<string, unknown> = {}) =>
  fhirpathjs.evaluate(structuredClone(input), expression, structuredClone(env), referenceModel, {
    async: false,
  }) as unknown[]

describe('minimal SDC integration differences', () => {
  it('JSON primitive sidecars require a JSON read, not R4 model navigation', () => {
    const input = { resourceType: 'Patient', _birthDate: { extension: [{ url: 'urn:test', valueString: 'body' }] } }
    const path = 'Patient._birthDate.extension'
    expect(reference(input, path)).toEqual(input._birthDate.extension)
    expect(evaluate(path, input, { model: r4Model })).toEqual([])
    expect(evaluate(path, input)).toEqual(input._birthDate.extension)
    expect(evaluate('Patient.birthDate.extension', input, { model: r4Model })).toEqual(input._birthDate.extension)
  })

  it('suffixed choice names silently differ; the model path reads the answer', () => {
    expect(reference(qr, 'item.answer.valueString')).toEqual(['Ada'])
    expect(evaluate('item.answer.valueString', qr, { model: r4Model })).toEqual([])
    expect(evaluate('item.answer.value.ofType(FHIR.string)', qr, { model: r4Model })).toEqual(['Ada'])
  })

  it('ofType(System.String) does not select FHIR.string here', () => {
    const path = 'item.answer.value.ofType(System.String)'
    expect(reference(qr, path)).toEqual(['Ada'])
    expect(evaluate(path, qr, { model: r4Model })).toEqual([])
    expect(evaluate('item.answer.value.ofType(FHIR.string)', qr, { model: r4Model })).toEqual(['Ada'])
  })

  it('a detached item loses choice typing; a typed focus preserves it', () => {
    const fragment = qr.item[0]!
    const referenceItem = fhirpathjs.evaluate(structuredClone(qr), 'item', {}, referenceModel, {
      async: false,
    }) as unknown[]
    const referenceFragment = referenceItem[0]
    expect(fhirpathjs.evaluate(referenceFragment, 'answer.value', {}, referenceModel)).toEqual(['Ada'])
    expect(reference(fragment, 'answer.value')).toEqual([])
    expect(evaluate('answer.value', fragment, { model: r4Model })).toEqual([])
    const item = compile('item').evaluateTyped(qr, { model: r4Model })
    const values = (expression: string) =>
      compile(expression)
        .evaluateTyped(item, { model: r4Model })
        .map(value => value.value)
    expect(values('answer.value')).toEqual(['Ada'])
    expect(values('%context.answer.value')).toEqual(['Ada'])
    expect(values("'%context'")).toEqual(['%context'])
  })

  it('compile(expression, rootType) does not give raw fragments a runtime type', () => {
    // The types refuse JSON for a backbone root; the cast shows the runtime refuses it too.
    const fragment = qr.item[0] as unknown as TypedValue[]
    expect(() => compile('answer.value', 'QuestionnaireResponse.item').evaluate(fragment, { model: r4Model })).toThrow(
      /takes typed input/
    )
  })
})

describe('LHC-Forms calculation tests (ported without a browser)', () => {
  it('PHQ-9: both engines score nine answers as 9', () => {
    const questionnaire = fixture('phq9-with-the-weight-function')
    const response: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'completed',
      item: questionnaire
        .item!.filter(item => (item.answerOption || item.answerValueSet) && item.linkId !== '/69722-7')
        .map(item => ({
          linkId: item.linkId,
          answer: [{ valueCoding: { code: 'LA6569-3', system: 'http://loinc.org' } }],
        })),
    }
    const expression = questionnaire
      .item!.flatMap(item => item.extension ?? [])
      .find(ext => ext.url.endsWith('calculatedExpression'))!.valueExpression!.expression!
    expect(reference(response, expression, { questionnaire, resource: response })).toEqual([9])
    expect(evaluate(expression, response, { model: r4Model, env: { questionnaire } })).toEqual([9])
  })

  it.each([5, 3])('Apgar with %d answers: original expressions and a model-path variant', count => {
    const questionnaire = fixture('apgar-with-itemWeight-variable')
    const items = questionnaire.item!.slice(0, count)
    const response: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse',
      status: 'completed',
      item: items.map(item => ({
        linkId: item.linkId,
        answer: [{ valueCoding: item.answerOption![2]!.valueCoding! }],
      })),
    }
    const expressions = questionnaire.item!.at(-1)!.extension!.map(ext => ext.valueExpression!)
    const vars = Object.fromEntries(expressions.filter(expr => expr.name).map(expr => [expr.name!, expr.expression!]))
    const expression = expressions.at(-1)!.expression!
    const env: Record<string, unknown> = { questionnaire, resource: response }
    for (const [name, body] of Object.entries(vars)) {
      env[name] = reference(response, body, env)
    }
    const expected = count === 5 ? [10] : []
    expect(reference(response, expression, env)).toEqual(expected)
    expect(evaluate(expression, response, { model: r4Model, env: { questionnaire }, vars })).toEqual([])
    // This substitution applies only to this fixed fixture's expressions.
    const modelPaths = Object.fromEntries(
      Object.entries(vars).map(([name, body]) => [
        name,
        body
          .replaceAll('valueCoding', 'value.ofType(FHIR.Coding)')
          .replaceAll('valueDecimal', 'value.ofType(FHIR.decimal)'),
      ])
    )
    expect(evaluate(expression, response, { model: r4Model, env: { questionnaire }, vars: modelPaths })).toEqual(
      expected
    )
    const adaptedEnv: Record<string, unknown> = { questionnaire, resource: response }
    for (const [name, body] of Object.entries(modelPaths)) {
      adaptedEnv[name] = reference(response, body, adaptedEnv)
    }
    expect(reference(response, expression, adaptedEnv)).toEqual(expected)
  })
})
