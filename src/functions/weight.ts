import { forEachCollecting } from '../engine/async.ts'
import { type EvaluationContext, lookupEnvironmentVariable } from '../engine/context.ts'
import { pairEquals, pairEquivalent } from '../engine/operators/equality.ts'
import { FhirPathRuntimeError } from '../errors.ts'
import { elementOrigin, owningResource, rootResourceOf } from '../fhir/element-origin.ts'
import { extensionArraysOf } from '../fhir/extensions.ts'
import { readModelProperty } from '../fhir/model-navigation.ts'
import { codeSystemWeight, type ConceptKey, numericWeight, versionedWeight, WEIGHT_URLS } from '../fhir/weights.ts'
import type { ModelProvider } from '../model/provider.ts'
import { Decimal } from '../values/decimal.ts'
import { SYSTEM_DECIMAL, toTypedValue, type TypedValue } from '../values/typed-value.ts'
import { registerFunction } from './registry.ts'
import { callProvider, isObject, type ParameterEntry, parameterList, parameterValueX } from './terminology.ts'

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
    const weights: TypedValue[] = []
    // Each item's lookup is independent, so they are requested together.
    forEachCollecting(input, item => {
      const score = weightOf(context, model, item)
      if (score !== undefined) weights.push({ type: SYSTEM_DECIMAL, value: score })
    })
    return weights
  },
})

function embeddedWeight(item: TypedValue | undefined): Decimal | undefined {
  if (item === undefined) return undefined
  for (const extension of extensionArraysOf(item).flat()) {
    const fields = extension as { url?: unknown; valueDecimal?: unknown } | null
    if (fields === null || !WEIGHT_URLS.has(fields.url)) continue
    return numericWeight(fields.valueDecimal, 'valueDecimal on the weight extension')
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
    const valueSet = children(model, question, 'answerValueSet')[0]?.value
    if (typeof valueSet === 'string') {
      const score = valueSetWeight(context, model, questionnaire[0], valueSet, value)
      if (score !== undefined) return score
    }
  }
  const concept = conceptOf(model, value)
  if (concept === undefined) return undefined
  const questionnaire = answer === undefined ? undefined : lookupEnvironmentVariable(context, 'questionnaire')?.[0]
  const contained = codeSystemWeight(containedCodeSystems(model, [ownerOf(value), questionnaire]), concept)
  if (contained.listed) return contained.weight
  if (contained.complete) {
    throw new FhirPathRuntimeError(`weight() cannot find code '${concept.code}' in CodeSystem ${concept.system}`)
  }
  const coding = value.type === 'FHIR.Coding' ? value.value : { system: concept.system, code: concept.code }
  const response = parameterList(callProvider(context, 'weight()', 'lookup', [coding, 'property=itemWeight']))
  if (response === undefined) throw new FhirPathRuntimeError('weight() cannot resolve the CodeSystem')
  const weight = lookupProperty(response, 'itemWeight')
  return weight === undefined ? undefined : numericWeight(weight, 'CodeSystem itemWeight')
}

/**
 * A Coding names its CodeSystem through `system`; a bare `code` through the
 * required binding of the element it was read from, which the model knows
 * for a binding over one code system. A Coding without a system names no
 * CodeSystem, so it has no weight; a code whose binding cannot be resolved
 * fails the call, so a required score is never silently dropped.
 */
function conceptOf(model: ModelProvider, value: TypedValue): ConceptKey | undefined {
  if (value.type === 'FHIR.code') {
    const origin = elementOrigin(value)
    const system = origin === undefined ? undefined : model.boundCodeSystem?.(origin.parent.type, origin.name)
    if (system === undefined) {
      const where = origin === undefined ? '' : ` of ${origin.parent.type}.${origin.name}`
      throw new FhirPathRuntimeError(`weight() cannot resolve the CodeSystem binding${where} of a code`)
    }
    return typeof value.value === 'string' ? { system, code: value.value, version: undefined } : undefined
  }
  if (value.type !== 'FHIR.Coding') return undefined
  const system = children(model, value, 'system')[0]?.value
  if (typeof system !== 'string') return undefined
  const code = children(model, value, 'code')[0]?.value
  if (typeof code !== 'string') {
    throw new FhirPathRuntimeError('weight() needs a Coding with a code for CodeSystem lookup')
  }
  return { system, code, version: children(model, value, 'version')[0]?.value }
}

/**
 * The weight a bound value set gives a Coding answer: from a ValueSet contained
 * in the Questionnaire (`#id`, or a matching url and version), or else from the
 * provider's expansion. The concept carries it as a weight extension on its
 * expansion entry or, when that has none, on its `compose.include.concept`. A
 * concept without one, or a code the value set does not list, leaves the lookup
 * to the CodeSystem; a value set that cannot be resolved fails the call.
 */
function valueSetWeight(
  context: EvaluationContext,
  model: ModelProvider,
  questionnaire: TypedValue,
  canonical: string,
  value: TypedValue
): Decimal | undefined {
  const system = children(model, value, 'system')[0]?.value
  const code = children(model, value, 'code')[0]?.value
  if (value.type !== 'FHIR.Coding' || typeof system !== 'string' || typeof code !== 'string') return undefined
  const version = children(model, value, 'version')[0]?.value
  const valueSet = containedValueSet(model, questionnaire, canonical) ?? expandedValueSet(context, canonical)
  const entries = nested(model, children(model, valueSet, 'expansion'), 'contains')
    .filter(item => matches(model, item, system, code))
    .map(item => ({ version: children(model, item, 'version')[0]?.value, weight: embeddedWeight(item) }))
  const concepts = children(model, valueSet, 'compose')
    .flatMap(compose => children(model, compose, 'include'))
    .filter(include => children(model, include, 'system')[0]?.value === system)
    .flatMap(include =>
      children(model, include, 'concept')
        .filter(item => children(model, item, 'code')[0]?.value === code)
        .map(item => ({ version: children(model, include, 'version')[0]?.value, weight: embeddedWeight(item) }))
    )
  const where = `code '${code}' in ValueSet ${canonical}`
  return versionedWeight(entries, version, where) ?? versionedWeight(concepts, version, where)
}

function containedValueSet(model: ModelProvider, questionnaire: TypedValue, canonical: string): TypedValue | undefined {
  const contained = children(model, questionnaire, 'contained').filter(resource => resource.type === 'FHIR.ValueSet')
  if (canonical.startsWith('#')) {
    const found = contained.find(resource => children(model, resource, 'id')[0]?.value === canonical.slice(1))
    if (found === undefined) throw new FhirPathRuntimeError(`weight() cannot find the contained ValueSet ${canonical}`)
    return found
  }
  const [url, version] = canonical.split('|')
  return contained.find(
    resource =>
      children(model, resource, 'url')[0]?.value === url &&
      (version === undefined || children(model, resource, 'version')[0]?.value === version)
  )
}

function expandedValueSet(context: EvaluationContext, canonical: string): TypedValue {
  const expansion = callProvider(context, 'weight()', 'expand', [canonical])
  const valueSet = toTypedValue(expansion)
  if (valueSet.type !== 'FHIR.ValueSet')
    throw new FhirPathRuntimeError(`weight() cannot resolve the ValueSet ${canonical}`)
  return valueSet
}

/**
 * The CodeSystems contained in `scopes`, as JSON: the resource holding the
 * value, and the Questionnaire for an answer.
 */
function containedCodeSystems(model: ModelProvider, scopes: (TypedValue | undefined)[]): unknown[] {
  return scopes
    .flatMap(scope => (scope === undefined ? [] : children(model, scope, 'contained')))
    .filter(resource => resource.type === 'FHIR.CodeSystem')
    .map(resource => resource.value)
}

/** Every `name` child at any depth below `roots`: nested concepts or expansion entries. */
function nested(model: ModelProvider, roots: TypedValue[], name: string): TypedValue[] {
  const found: TypedValue[] = []
  const pending = roots.flatMap(root => children(model, root, name))
  while (pending.length > 0) {
    const item = pending.shift() as TypedValue
    found.push(item)
    pending.push(...children(model, item, name))
  }
  return found
}

function matches(model: ModelProvider, item: TypedValue, system: string, code: string): boolean {
  return children(model, item, 'system')[0]?.value === system && children(model, item, 'code')[0]?.value === code
}

/** The resource whose contained resources a value can use: its own, or its container's when it is contained. */
function ownerOf(value: TypedValue): TypedValue | undefined {
  const resource = owningResource(value)
  return resource === undefined ? undefined : rootResourceOf(resource)
}

/** A $lookup property part value, e.g. the itemWeight ordinal. */
function lookupProperty(parameters: ParameterEntry[], code: string): unknown {
  for (const parameter of parameters) {
    if (parameter.name !== 'property' || !Array.isArray(parameter.part)) {
      continue
    }
    const parts = parameter.part.filter(isObject) as ParameterEntry[]
    const codePart = parts.find(part => part.name === 'code')
    const valuePart = parts.find(part => part.name === 'value')
    if (codePart !== undefined && parameterValueX(codePart) === code && valuePart !== undefined) {
      return parameterValueX(valuePart)
    }
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
