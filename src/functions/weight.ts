import { type EvaluationContext, lookupEnvironmentVariable } from '../engine/context.ts'
import { pairEquals, pairEquivalent } from '../engine/operators/equality.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import { elementOrigin } from '../fhir/element-origin.ts'
import { extensionsOf } from '../fhir/extensions.ts'
import { readModelProperty } from '../fhir/model-navigation.ts'
import type { ModelProvider } from '../model/provider.ts'
import { Decimal } from '../values/decimal.ts'
import { SYSTEM_DECIMAL, type TypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'

const WEIGHT_URLS = new Set([
  'http://hl7.org/fhir/StructureDefinition/itemWeight',
  'http://hl7.org/fhir/StructureDefinition/ordinalValue',
])

const ANSWER_TYPE = 'FHIR.QuestionnaireResponse.item.answer'

/** SDC local scores; unresolved terminology must not silently lower a total. */
registerFunction('weight', {
  minArity: 0,
  maxArity: 0,
  evaluate: (context, input) => {
    const model = context.model
    // Without a model, answers and Codings are untyped, so their option and
    // terminology lookups would be skipped instead of reported.
    if (model === undefined) {
      throw new FhirPathRuntimeError('weight() needs a model to find answers, answer options, and Codings')
    }
    return input.flatMap(item => {
      const score = weightOf(context, model, item)
      return score === undefined ? [] : [{ type: SYSTEM_DECIMAL, value: score }]
    })
  },
})

function embeddedWeight(item: TypedValue | undefined): Decimal | undefined {
  if (item === undefined) return undefined
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

function weightOf(context: EvaluationContext, model: ModelProvider, item: TypedValue): Decimal | undefined {
  const origin = elementOrigin(item)
  const answer =
    item.type === ANSWER_TYPE
      ? item
      : origin?.parent.type === ANSWER_TYPE && origin.name === 'value'
        ? origin.parent
        : undefined
  const value = answer === item ? children(model, item, 'value')[0] : item
  // An answer-level weight overrides its value's, whether the call starts at the answer or its value.
  const embedded = embeddedWeight(answer) ?? embeddedWeight(value)
  if (embedded !== undefined) return embedded
  if (value === undefined) return undefined
  if (answer !== undefined) {
    const questionnaire = lookupEnvironmentVariable(context, 'questionnaire')
    if (questionnaire?.length !== 1 || questionnaire[0]?.type !== 'FHIR.Questionnaire') {
      throw new FhirPathRuntimeError('weight() needs %questionnaire to resolve answer options')
    }
    const question = questionFor(model, questionnaire[0], answer)
    for (const option of children(model, question, 'answerOption')) {
      const candidate = children(model, option, 'value')[0]
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
    if (children(model, question, 'answerValueSet').length > 0) {
      throw new FhirPathRuntimeError('weight() cannot resolve answerValueSet weights; ValueSet lookup is not supported')
    }
  }
  // A code's CodeSystem comes from its binding and a Coding's from its system.
  // A Coding without a system names no CodeSystem, so it has no weight.
  if (
    value.type === 'FHIR.code' ||
    (value.type === 'FHIR.Coding' && children(model, value, 'system')[0]?.value !== undefined)
  ) {
    throw new FhirPathRuntimeError('weight() cannot resolve CodeSystem weights; terminology lookup is not supported')
  }
  return undefined
}

function questionFor(model: ModelProvider, questionnaire: TypedValue, answer: TypedValue): TypedValue {
  const responseItem = elementOrigin(answer)?.parent
  const linkId = responseItem === undefined ? undefined : children(model, responseItem, 'linkId')[0]?.value
  const pending = children(model, questionnaire, 'item')
  while (pending.length > 0) {
    const question = pending.pop() as TypedValue
    if (linkId !== undefined && children(model, question, 'linkId')[0]?.value === linkId) return question
    pending.push(...children(model, question, 'item'))
  }
  throw new FhirPathRuntimeError(`weight() cannot find Questionnaire item for linkId '${String(linkId)}'`)
}

function children(model: ModelProvider, item: TypedValue, name: string): TypedValue[] {
  return readModelProperty(model, item, name) ?? []
}
