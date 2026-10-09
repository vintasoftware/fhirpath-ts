import type { EvaluationContext } from '../engine/context.ts'
import { pairEquals, pairEquivalent } from '../engine/operators/equality.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import { elementOrigin } from '../fhir/element-origin.ts'
import { extensionsOf } from '../fhir/extensions.ts'
import { readModelProperty } from '../fhir/model-navigation.ts'
import { Decimal } from '../values/decimal.ts'
import { SYSTEM_DECIMAL, type TypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'

const WEIGHT_URLS = new Set([
  'http://hl7.org/fhir/StructureDefinition/itemWeight',
  'http://hl7.org/fhir/StructureDefinition/ordinalValue',
])

/** SDC local scores; unresolved terminology must not silently lower a total. */
registerFunction('weight', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) =>
    input.flatMap(item => {
      const score = weightOf(context, item)
      return score === undefined ? [] : [{ type: SYSTEM_DECIMAL, value: score }]
    }),
})

function embeddedWeight(item: TypedValue): Decimal | undefined {
  for (const extension of extensionsOf(item)) {
    const fields = extension as { url?: string; valueDecimal?: unknown }
    if (!WEIGHT_URLS.has(fields.url ?? '')) continue
    const score = typeof fields.valueDecimal === 'number' ? Decimal.fromNumber(fields.valueDecimal) : undefined
    if (score === undefined)
      throw new FhirPathRuntimeError('weight() requires a numeric valueDecimal on the weight extension')
    return score
  }
  return undefined
}

function weightOf(context: EvaluationContext, item: TypedValue): Decimal | undefined {
  const origin = elementOrigin(item)
  const answer =
    item.type === 'FHIR.QuestionnaireResponse.item.answer'
      ? item
      : origin?.parent.type === 'FHIR.QuestionnaireResponse.item.answer' && origin.name === 'value'
        ? origin.parent
        : undefined
  // Calling on answer or answer.value must honor the same answer-level override.
  if (answer !== undefined && answer !== item) {
    const answerWeight = embeddedWeight(answer)
    if (answerWeight !== undefined) return answerWeight
  }
  const embedded = embeddedWeight(item)
  if (embedded !== undefined) return embedded
  const value = answer === item ? children(context, item, 'value')[0] : item
  if (value === undefined) return undefined
  if (value !== item) {
    const valueWeight = embeddedWeight(value)
    if (valueWeight !== undefined) return valueWeight
  }
  if (answer !== undefined) {
    const questionnaire = context.variables.get('questionnaire') ?? context.env.get('questionnaire')
    if (questionnaire?.length !== 1 || questionnaire[0]?.type !== 'FHIR.Questionnaire') {
      throw new FhirPathRuntimeError('weight() needs %questionnaire to resolve answer options')
    }
    const question = questionFor(context, questionnaire[0], answer)
    for (const option of children(context, question, 'answerOption')) {
      const candidate = children(context, option, 'value')[0]
      if (candidate === undefined) continue
      const matches =
        value.type === 'FHIR.Coding' && candidate.type === 'FHIR.Coding'
          ? pairEquivalent(value, candidate)
          : pairEquals(value, candidate) === true
      if (matches) {
        const score = embeddedWeight(option) ?? embeddedWeight(candidate)
        if (score !== undefined) return score
      }
    }
    if (children(context, question, 'answerValueSet').length > 0) {
      throw new FhirPathRuntimeError('weight() cannot resolve answerValueSet weights; ValueSet lookup is not supported')
    }
  }
  if (value.type === 'FHIR.Coding' || value.type === 'FHIR.code') {
    throw new FhirPathRuntimeError('weight() cannot resolve CodeSystem weights; terminology lookup is not supported')
  }
  return undefined
}

function questionFor(context: EvaluationContext, questionnaire: TypedValue, answer: TypedValue): TypedValue {
  const responseItem = elementOrigin(answer)?.parent
  const linkId = responseItem === undefined ? undefined : children(context, responseItem, 'linkId')[0]?.value
  const pending = children(context, questionnaire, 'item')
  while (pending.length > 0) {
    const question = pending.pop() as TypedValue
    if (linkId !== undefined && children(context, question, 'linkId')[0]?.value === linkId) return question
    pending.push(...children(context, question, 'item'))
  }
  throw new FhirPathRuntimeError(`weight() cannot find Questionnaire item for linkId '${String(linkId)}'`)
}

function children(context: EvaluationContext, item: TypedValue, name: string): TypedValue[] {
  return context.model === undefined ? [] : (readModelProperty(context.model, item, name) ?? [])
}
